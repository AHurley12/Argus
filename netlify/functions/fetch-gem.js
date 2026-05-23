// netlify/functions/fetch-gem.js
// Global Energy Monitor (GEM) infrastructure intelligence proxy.
//
// GEM provides static strategic infrastructure data: LNG terminals, gas pipelines,
// power plants, coal mines, and energy chokepoints. This data changes rarely
// (new projects, retirements) and is treated as strategic reference data.
//
// Refresh cadence: 24h default (configurable via GEM_REFRESH_INTERVAL_HOURS).
// Weekly is acceptable for stable datasets.
//
// GEM_DATASET_URL should point to a JSON or CSV dataset from globalenergymonitor.org
// or a derivative hosted endpoint. The function handles both formats.
//
// Response shape:
//   { infrastructure: [...normalizedInfra], source: 'gem', ts: epoch, count: N }
//
// Infrastructure schema:
//   { id, lat, lon, type, name, country, capacity, status, unit, fuel }
//
// Env: GEM_DATASET_URL, GEM_REFRESH_INTERVAL_HOURS, ENABLE_GEM,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// GEM is opt-in — requires explicit dataset URL configuration
const ENABLE_GEM                 = (process.env.ENABLE_GEM || 'false').toLowerCase() !== 'false';
const GEM_DATASET_URL            = process.env.GEM_DATASET_URL || '';
const GEM_REFRESH_INTERVAL_HOURS = parseInt(process.env.GEM_REFRESH_INTERVAL_HOURS || '24');

// Optional fuel-type filter — comma-separated keywords, case-insensitive.
// E.g. GEM_FUEL_FILTER=lng,liquefied keeps only LNG-related records.
// Leave unset to ingest all records from the dataset.
const GEM_FUEL_FILTER = (process.env.GEM_FUEL_FILTER || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const CACHE_KEY    = 'gem_infrastructure_v1';
const CACHE_TTL_MS = GEM_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;

const MAX_INFRA = 2000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Infrastructure normalization ───────────────────────────────────────────────
// Accepts flexible schema — GEM datasets vary by tracker type (LNG, Gas, Power, etc.)
// Tries multiple common field name conventions.
function normalizeInfra(raw, index) {
  const lat = parseFloat(
    raw.lat || raw.latitude || raw.Lat || raw.Latitude || raw.LATITUDE || ''
  );
  // GEM gas-plant CSV uses field name "lng" for longitude — handle alongside all other conventions
  const lon = parseFloat(
    raw.lon || raw.lng || raw.longitude || raw.Long || raw.Longitude || raw.LONGITUDE || ''
  );

  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const name = (
    raw.name || raw.Name || raw.project || raw.Project || raw.project_name ||
    raw.ProjectName || raw.PLANT_NAME || ''
  ).slice(0, 100);

  // Stable ID: prefer GEM location ID, then unit ID, then constructed fallback
  const rawId = raw.id || raw['GEM location ID'] || raw['GEM unit/phase ID'] ||
                raw.Wiki || raw.ProjectID || raw.PLANT_ID || raw.GEM_ID || null;
  const id = rawId ? String(rawId) : (name + '_' + index);

  const fuel = (raw.fuel || raw.Fuel || raw.FuelType || raw['Fuel type'] ||
                raw.fuel_type || null);

  return {
    id:       id,
    lat:      lat,
    lon:      lon,
    // Prefer technology type (e.g. "CC", "FSRU") then tracker/type fields
    type:     (raw.technology || raw.Technology || raw.type || raw.Type ||
               raw.tracker || raw.Tracker || 'infrastructure').slice(0, 60),
    name:     name,
    country:  (raw.country || raw.Country || raw.COUNTRY || raw.nation || null),
    region:   (raw.region   || raw.Region   || raw.Subregion || null),
    capacity: raw.capacity || raw.Capacity || raw.CapacityMW || raw['Capacity (MW)'] ||
              raw['Capacity (MTPA)'] || null,
    status:   raw.status || raw.Status || raw.STATUS || null,
    unit:     raw.unit || raw.Unit || null,
    fuel:     fuel,
    owner:    (raw.owner || raw.Owner || raw.parent || raw.Parent || null),
    startYear: raw.start_year || raw['Start year'] || raw.StartYear || null,
  };
}

// Returns true if the record passes the GEM_FUEL_FILTER (or if no filter is set).
function passesFuelFilter(norm) {
  if (!GEM_FUEL_FILTER.length) return true;
  const fuelLower = (norm.fuel || '').toLowerCase();
  return GEM_FUEL_FILTER.some(kw => fuelLower.includes(kw));
}

// ── Minimal CSV parser ─────────────────────────────────────────────────────────
// Handles quoted fields and standard RFC 4180. Sufficient for GEM spreadsheet exports.
function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];

  const headers = splitCSVLine(lines[0]);
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = splitCSVLine(lines[i]);
    if (values.length < 2) continue;

    const record = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j] !== undefined ? values[j] : '';
    }
    records.push(record);
  }

  return records;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Feature gate — GEM is opt-in, requires explicit dataset URL
  if (!ENABLE_GEM) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ infrastructure: [], source: 'gem', ts: Date.now(), disabled: true }),
    };
  }

  if (!GEM_DATASET_URL) {
    console.warn('[fetch-gem] GEM_DATASET_URL not configured');
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'GEM_DATASET_URL not configured', infrastructure: [] }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Supabase cache read ────────────────────────────────────────────────────
  // Long TTL (24h default) — GEM data changes rarely
  try {
    const { data: row } = await supabase
      .from('argus_cache')
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();

    if (row && row.payload) {
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=43200' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed */ }

  // ── GEM Dataset fetch ──────────────────────────────────────────────────────
  let rawData;
  try {
    const resp = await fetch(GEM_DATASET_URL, {
      headers: {
        'Accept':     'application/json, text/csv, */*',
        'User-Agent': 'ArgusIntelligence/1.0',
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
    });
    if (!resp.ok) throw new Error('GEM dataset HTTP ' + resp.status);

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      rawData = await resp.json();
    } else {
      // Assume CSV (GEM's standard export format)
      const text = await resp.text();
      rawData = parseCSV(text);
    }
  } catch (err) {
    console.error('[fetch-gem] dataset fetch failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'GEM dataset unavailable', infrastructure: [] }),
    };
  }

  // Unwrap array from potential wrapper objects
  const records = Array.isArray(rawData) ? rawData
    : (rawData && Array.isArray(rawData.data) ? rawData.data : []);

  const infrastructure = [];
  const seen           = new Set();

  for (let i = 0; i < records.length && infrastructure.length < MAX_INFRA; i++) {
    const norm = normalizeInfra(records[i], i);
    if (!norm) continue;
    if (!passesFuelFilter(norm)) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    infrastructure.push(norm);
  }

  const fuelFilterApplied = GEM_FUEL_FILTER.length ? GEM_FUEL_FILTER.join(',') : null;

  const payload = {
    infrastructure,
    source:      'gem',
    fuelFilter:  fuelFilterApplied,
    ts:          Date.now(),
    count:  infrastructure.length,
  };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert(
        { key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
  } catch (err) {
    console.warn('[fetch-gem] cache write failed:', err.message);
  }

  console.log('[fetch-gem] returned', infrastructure.length, 'infrastructure records');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=43200' },
    body: JSON.stringify(payload),
  };
};
