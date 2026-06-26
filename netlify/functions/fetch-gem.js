// netlify/functions/fetch-gem.js
// Energy infrastructure intelligence proxy.
//
// Ingests multiple CSV/JSON datasets into one unified EnergyAsset collection.
// Supports GEM trackers (gas-plant, coal-plant, lng-terminals) and the
// WRI Global Power Plant Database.
//
// Response shape:
//   { infrastructure: [...EnergyAsset], source: 'gem', ts: epoch, count: N }
//
// EnergyAsset schema:
//   { id, lat, lon, type, name, country, capacity, unit, status, fuel }
//   type is a semantic fuel category: gas, coal, nuclear, hydro, wind, solar, lng, oil
//   NOT a turbine technology code (CC, GT, OCGT).
//
// Env:
//   ENABLE_GEM                    — "true" to activate (default: false)
//   GEM_DATASET_URL               — comma-separated list of CSV/JSON URLs
//   GEM_REFRESH_INTERVAL_HOURS    — cache TTL in hours (default: 24)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ENABLE_GEM              = (process.env.ENABLE_GEM || 'false').toLowerCase() !== 'false';
const GEM_REFRESH_HOURS       = parseInt(process.env.GEM_REFRESH_INTERVAL_HOURS || '24');

// Comma-separated list of dataset URLs — all fetched and merged into one cache.
const GEM_DATASET_URLS = (process.env.GEM_DATASET_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const CACHE_KEY    = 'gem_infrastructure_v3';   // bumped — type-balanced sampling
const CACHE_TTL_MS = GEM_REFRESH_HOURS * 60 * 60 * 1000;

// Cap per-source to avoid hitting Supabase payload limits.
// Total max = MAX_PER_SOURCE * number of sources.
const MAX_PER_SOURCE = 3000;

// Minimum nameplate capacity (MW). Filters out micro-generators and data noise.
// Applied only when a numeric capacity is present — plants with no capacity pass through.
const MIN_CAPACITY_MW = 50;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Fuel → semantic type mapping ───────────────────────────────────────────────
// Converts raw fuel/primary_fuel field values to canonical energy type strings.
// These strings are what argusGem.js _canonicalType() matches against.
// Order matters: lng must precede gas (lng contains "gas" in some datasets).
function fuelToType(fuel) {
  if (!fuel) return null;
  const f = fuel.toLowerCase().trim();
  if (f.includes('lng') || f.includes('liquefied'))           return 'lng';
  if (f.includes('gas') || f.includes('natural gas'))         return 'gas';
  if (f.includes('coal') || f.includes('lignite'))            return 'coal';
  if (f.includes('nuclear') || f.includes('uranium'))         return 'nuclear';
  if (f.includes('hydro') || f.includes('water'))             return 'hydro';
  if (f.includes('wind'))                                      return 'wind';
  if (f.includes('solar') || f.includes('photovoltaic') || f.includes(' pv')) return 'solar';
  if (f.includes('oil') || f.includes('petroleum') || f.includes('diesel')) return 'oil';
  if (f.includes('biomass') || f.includes('waste'))           return 'biomass';
  return null;
}

// ── Infrastructure normalization ───────────────────────────────────────────────
// Accepts both GEM tracker CSVs and WRI Global Power Plant Database.
// Type is derived from fuel first — NOT from technology codes (CC, GT, OCGT, ST).
function normalizeInfra(raw, index, sourceTag) {
  // Coordinates — handle GEM and WRI field name variants.
  // GEM gas-plant CSVs use "lng" as the longitude column name.
  const lat = parseFloat(
    raw.lat || raw.latitude || raw.Lat || raw.Latitude || raw.LATITUDE || ''
  );
  const lon = parseFloat(
    raw.lon || raw.lng || raw.longitude || raw.Long || raw.Longitude || raw.LONGITUDE || ''
  );

  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const name = (
    raw.name || raw.Name || raw.project || raw.Project || raw.project_name ||
    raw.ProjectName || raw.PLANT_NAME || ''
  ).slice(0, 100);

  // ID: prefer GEM/WRI stable IDs, fallback to constructed key
  const rawId = raw.id || raw.gppd_idnr || raw['GEM location ID'] || raw['GEM unit/phase ID'] ||
                raw.Wiki || raw.ProjectID || raw.PLANT_ID || raw.GEM_ID || null;
  const id = (rawId ? String(rawId) : (name + '_' + index)) + (sourceTag ? '_' + sourceTag : '');

  // Fuel: WRI uses "primary_fuel", GEM uses "fuel"/"Fuel"/"FuelType" etc.
  const fuel = raw.primary_fuel || raw.fuel || raw.Fuel || raw.FuelType ||
               raw['Fuel type'] || raw.fuel_type || null;

  // ── Type: fuel is the primary source, technology code is fallback only ────────
  // This is the critical fix: GEM gas-plant "technology" column contains turbine
  // codes (CC, GT, OCGT) that don't map to canonical energy types. WRI "primary_fuel"
  // contains semantic values (Gas, Coal, Nuclear) that map correctly.
  const fuelDerived = fuelToType(fuel);
  const techFallback = raw.technology || raw.Technology || raw.type || raw.Type ||
                       raw.tracker || raw.Tracker || null;
  const type = (fuelDerived || (techFallback ? techFallback.slice(0, 60) : 'infrastructure'));

  // Capacity: WRI uses "capacity_mw" (always MW). GEM uses "capacity"/"Capacity" etc.
  const hasWriCap   = raw.capacity_mw != null && raw.capacity_mw !== '';
  const capacityRaw = hasWriCap
    ? raw.capacity_mw
    : (raw.capacity || raw.Capacity || raw.CapacityMW || raw['Capacity (MW)'] ||
       raw['Capacity (MTPA)'] || null);
  const unit = hasWriCap ? 'MW' : (raw.unit || raw.Unit || null);

  // Minimum capacity filter — skip micro-generators when capacity is known.
  // Plants with no capacity data are kept (we don't want to lose LNG terminals etc.)
  if (capacityRaw != null && capacityRaw !== '') {
    const capMW = parseFloat(capacityRaw);
    if (isFinite(capMW) && capMW < MIN_CAPACITY_MW) return null;
  }

  // Country: WRI uses "country_long" (full name), GEM uses "country"/"Country"
  const country = raw.country_long || raw.country || raw.Country || raw.COUNTRY || raw.nation || null;

  return {
    id,
    lat,
    lon,
    type,
    name,
    country,
    region:    raw.region || raw.Region || raw.Subregion || null,
    capacity:  capacityRaw,
    unit,
    status:    raw.status || raw.Status || raw.STATUS || null,
    fuel,
    owner:     raw.owner || raw.Owner || raw.parent || raw.Parent || null,
    startYear: raw.start_year || raw.commissioning_year || raw['Start year'] || raw.StartYear || null,
  };
}

// ── Minimal CSV parser ─────────────────────────────────────────────────────────
function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
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
  const lines   = text.split(/\r?\n/);
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

// ── Fetch one dataset URL and return normalized records ────────────────────────
async function fetchAndNormalize(url, sourceTag) {
  let rawData;
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept':     'application/json, text/csv, */*',
        'User-Agent': 'ArgusIntelligence/1.0',
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    rawData = ct.includes('json') ? await resp.json() : parseCSV(await resp.text());
  } catch (err) {
    console.error('[fetch-gem] dataset fetch failed (' + sourceTag + '):', err.message);
    return [];
  }

  const records = Array.isArray(rawData) ? rawData
    : (rawData && Array.isArray(rawData.data) ? rawData.data : []);

  // Type-balanced sampling: cap each fuel category independently so no single type
  // (e.g. gas, which dominates WRI's alphabetical ordering) crowds out others.
  // MAX_PER_TYPE controls how many records of each type are kept per source.
  // The total per source is bounded by MAX_PER_TYPE * number-of-types.
  const MAX_PER_TYPE = 500;
  const typeBuckets  = {};
  const normalized   = [];

  for (let i = 0; i < records.length; i++) {
    const norm = normalizeInfra(records[i], i, sourceTag);
    if (!norm) continue;
    const bucket = norm.type || 'infrastructure';
    typeBuckets[bucket] = (typeBuckets[bucket] || 0) + 1;
    if (typeBuckets[bucket] > MAX_PER_TYPE) continue;
    normalized.push(norm);
  }

  console.log('[fetch-gem] source', sourceTag, '→', normalized.length, 'records (from', records.length, 'raw), buckets:', JSON.stringify(typeBuckets));
  return normalized;
}

// ── Ingest audit ───────────────────────────────────────────────────────────────
function auditIngest(infrastructure) {
  const counts = {};
  for (const rec of infrastructure) {
    const t = rec.type || 'unknown';
    counts[t] = (counts[t] || 0) + 1;
  }
  console.log('[fetch-gem] type distribution:', JSON.stringify(counts));

  const unknownCount = (counts['infrastructure'] || 0) + (counts['unknown'] || 0);
  const pct = infrastructure.length > 0 ? (unknownCount / infrastructure.length * 100).toFixed(1) : 0;
  if (unknownCount > 0 && parseFloat(pct) > 10) {
    console.warn('[fetch-gem] WARNING: ' + pct + '% assets unclassified — check fuel field coverage');
  }
  return counts;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_GEM) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ infrastructure: [], source: 'gem', ts: Date.now(), disabled: true }),
    };
  }

  if (!GEM_DATASET_URLS.length) {
    console.warn('[fetch-gem] GEM_DATASET_URL not configured');
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'GEM_DATASET_URL not configured', infrastructure: [] }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Supabase cache read ────────────────────────────────────────────────────
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

  // ── Fetch all sources in parallel ──────────────────────────────────────────
  const sourceResults = await Promise.all(
    GEM_DATASET_URLS.map(function(url, i) {
      return fetchAndNormalize(url, 's' + i);
    })
  );

  // Merge, deduplicate by id
  const seen          = new Set();
  const infrastructure = [];
  for (const batch of sourceResults) {
    for (const rec of batch) {
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        infrastructure.push(rec);
      }
    }
  }

  const typeCounts = auditIngest(infrastructure);

  const payload = {
    infrastructure,
    source:      'gem',
    typeCounts,
    ts:          Date.now(),
    count:       infrastructure.length,
    sources:     GEM_DATASET_URLS.length,
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

  console.log('[fetch-gem] complete —', infrastructure.length, 'total records from', GEM_DATASET_URLS.length, 'source(s)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=43200' },
    body: JSON.stringify(payload),
  };
};
