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

const CACHE_KEY    = 'gem_infrastructure_v6';   // bumped — fuel priority reorder
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
//
// Priority order (first match wins):
//   Rarest / highest interest first — so hybrid plants (e.g. "NG/FO") show the
//   more informative type. Gas and LNG are the most common and lowest priority.
//
//   nuclear > geothermal > bioenergy > hydro > wind > solar > coal > oil > lng > gas
//
// Notes:
//   - LNG is placed AFTER oil but BEFORE gas, to prevent "liquefied natural gas"
//     matching the gas check while still letting "NG/FO" resolve to oil.
//   - Coal sub-types (bituminous, anthracite) don't contain the word "coal" in GIPT.
//   - Oil handles WRI shortcodes: /fo (fuel oil), hfo, lfo, biodiesel.
//   - Gas handles WRI "NG" abbreviation explicitly.
function fuelToType(fuel) {
  if (!fuel) return null;
  const f = fuel.toLowerCase().trim();
  // Rarest / most specific types first
  if (f.includes('nuclear') || f.includes('uranium'))                            return 'nuclear';
  if (f.includes('geothermal'))                                                   return 'geothermal';
  if (f.includes('bioenergy') || f.includes('biomass') || f.includes('biogas') ||
      f.includes('landfill') || f.includes('waste'))                             return 'bioenergy';
  if (f.includes('hydro') || f.includes('water'))                                return 'hydro';
  if (f.includes('wind'))                                                         return 'wind';
  if (f.includes('solar') || f.includes('photovoltaic') || f.includes(' pv'))   return 'solar';
  // Coal beats oil/gas — GIPT subtypes first (bituminous/anthracite lack "coal" substring)
  if (f.includes('bituminous') || f.includes('anthracite') || f.includes('sub-bitu') ||
      f.includes('coal') || f.includes('lignite'))                               return 'coal';
  // Oil beats lng/gas — handles compound codes like NG/FO (fuel oil), NG/HFO, etc.
  if (f.includes('oil') || f.includes('petroleum') || f.includes('diesel') ||
      f.includes('/fo') || f === 'fo' || f.includes('hfo') || f.includes('lfo') ||
      f.includes('biodiesel'))                                                   return 'oil';
  // LNG before gas — prevents "liquefied natural gas" from matching gas check
  if (f.includes('lng') || f.includes('liquefied'))                              return 'lng';
  // Gas — lowest priority. Handles "natural gas", "NG" abbreviation, compound NG/X codes.
  if (f.includes('gas') || f === 'ng' || f.startsWith('ng/') || f.startsWith('ng ')) return 'gas';
  return null;
}

// ── Technology → semantic type mapping ────────────────────────────────────────
// GIPT often has an empty Fuel column — the Technology column carries semantic info.
// Maps GIPT Technology column values to canonical energy type strings.
// Only covers unambiguous technology codes; ambiguous codes (ST) remain null.
//
// GIPT Technology values observed:
//   Hydro:      conventional storage, run-of-river, pumped storage, conventional and …
//   Wind:       onshore, offshore hard mount, offshore mount unknown, offshore floating
//   Solar:      PV, Solar Thermal, Assumed PV
//   Gas:        CC (combined cycle), GT (gas turbine), ICCC, ISCC, AFC
//   Coal:       subcritical, supercritical, ultra-super, cfb, igcc, igcc/ccs, …/ccs
//   Nuclear:    pressurized water reactor, boiling water reactor, gas-cooled reactor, …
//   Geothermal: flash steam - *, dry steam, binary cycle
function techToType(tech) {
  if (!tech) return null;
  const t = tech.toLowerCase().trim();
  if (t.includes('run-of-river') || t.includes('pumped storage') ||
      t.includes('conventional storage') || t.includes('conventional and'))    return 'hydro';
  if (t.includes('onshore') || t.includes('offshore'))                         return 'wind';
  if (t === 'pv' || t === 'solar thermal' || t.includes('photovoltaic') ||
      t.includes('assumed pv'))                                                 return 'solar';
  if (t === 'cc' || t === 'gt' || t === 'iccc' || t === 'iscc' || t === 'afc') return 'gas';
  if (t === 'subcritical' || t === 'supercritical' || t.includes('ultra-super') ||
      t === 'cfb' || t.includes('igcc') || t.includes('/ccs'))                 return 'coal';
  if (t.includes('reactor') || t.includes('graphite') || t.includes('breeder') ||
      t.includes('modular'))                                                    return 'nuclear';
  if (t.includes('flash steam') || t.includes('dry steam') ||
      t.includes('binary cycle'))                                               return 'geothermal';
  return null;
}

// ── Infrastructure normalization ───────────────────────────────────────────────
// Accepts GIPT (Global Integrated Power Tracker) and WRI Global Power Plant Database.
//
// Type derivation priority (first non-null wins):
//   1. fuelToType(Fuel column)         — explicit fuel value (bituminous → coal, etc.)
//   2. fuelToType(Tracker column)      — GEM tracker name encodes fuel semantically
//   3. techToType(Technology column)   — GIPT tech code mapping (CC→gas, onshore→wind)
//   4. Raw Technology string (capped)  — last resort; non-filterable in the UI
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

  // Tracker: GIPT Tracker column names encode the fuel type semantically
  // e.g. "Gas Tracker" → gas, "Hydropower Tracker" → hydro, "Wind Power Tracker" → wind
  const tracker = raw.Tracker || raw.tracker || null;

  // Technology: used as tertiary fallback via techToType() mapping
  const techStr = raw.technology || raw.Technology || raw.type || raw.Type || null;

  // ── Type derivation ─────────────────────────────────────────────────────────
  const type = fuelToType(fuel) || fuelToType(tracker) || techToType(techStr) ||
               (techStr ? techStr.slice(0, 60) : 'infrastructure');

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
