// netlify/functions/fetch-comtrade.js
// UN Comtrade bilateral trade data proxy.
//
// Two-tier endpoint strategy:
//   DATA (authenticated, preferred):
//     URL:    https://comtradeapi.un.org/data/v1/get/C/A/HS
//     Header: Ocp-Apim-Subscription-Key
//     Limits: up to 100,000 records, 500 calls/day
//
//   PREVIEW (unauthenticated, fallback when no key):
//     URL:    https://comtradeapi.un.org/public/v1/preview/C/A/HS
//     Key ignored. Max 500 records. Aggressive rate limits.
//
// Call strategy: ONE request per user click.
//   flowCode=M,X, no cmdCode → all commodities + TOTAL row for both flows.
//   Client-side: separate TOTAL row from HS chapters, sort by primaryValue desc,
//   top 10 each for the commodity breakdown.
//
// Caching strategy:
//   - Fresh (< TTL_MS = 7 days)   → serve immediately, no upstream contact
//   - Stale (< STALE_MS = 30 days) on 429/error → serve degraded with stale flag
//   - Cross-instance coalescing via COALESCE_WINDOW_MS check
//   - In-memory coalescing per country pair within same Lambda instance
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, COMTRADE_SUBSCRIPTION_KEY (optional)

const { createClient } = require('@supabase/supabase-js');
const Cache = require('../lib/argus-cache');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const SUBSCRIPTION_KEY = (process.env.COMTRADE_SUBSCRIPTION_KEY || '').trim();

const TTL_MS   = Cache.TTL.COMTRADE;    // 7 days
const STALE_MS = Cache.STALE.COMTRADE;  // 30 days

// Data endpoint requires subscription key and returns full dataset.
// Preview endpoint is unauthenticated but heavily rate-limited.
const COMTRADE_DATA_BASE    = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const COMTRADE_PREVIEW_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── ISO3 → UN M49 numeric code map ────────────────────────────────────────────
// Must stay in sync with data/country-codes.json (frontend dropdown source).
const ISO3_TO_M49 = {
  AFG:'004', ALB:'008', DZA:'012', AND:'020', AGO:'024', ATG:'028',
  ARG:'032', ARM:'051', AUS:'036', AUT:'040', AZE:'031',
  BHS:'044', BHR:'048', BGD:'050', BRB:'052', BLR:'112', BEL:'056',
  BLZ:'084', BEN:'204', BTN:'064', BOL:'068', BIH:'070', BWA:'072',
  BRA:'076', BRN:'096', BGR:'100', BFA:'854', BDI:'108',
  CPV:'132', KHM:'116', CMR:'120', CAN:'124', CAF:'140', TCD:'148',
  CHL:'152', CHN:'156', COL:'170', COM:'174', COG:'178', COD:'180',
  CRI:'188', HRV:'191', CUB:'192', CYP:'196', CZE:'203',
  DNK:'208', DJI:'262', DOM:'214',
  ECU:'218', EGY:'818', SLV:'222', GNQ:'226', ERI:'232', EST:'233',
  SWZ:'748', ETH:'231',
  FJI:'242', FIN:'246', FRA:'250',
  GAB:'266', GMB:'270', GEO:'268', DEU:'276', GHA:'288', GRC:'300',
  GTM:'320', GIN:'324', GNB:'624', GUY:'328',
  HTI:'332', HND:'340', HKG:'344', HUN:'348',
  ISL:'352', IND:'356', IDN:'360', IRN:'364', IRQ:'368', IRL:'372',
  ISR:'376', ITA:'380',
  JAM:'388', JPN:'392', JOR:'400',
  KAZ:'398', KEN:'404', XKX:'983', KWT:'414', KGZ:'417',
  LAO:'418', LVA:'428', LBN:'422', LSO:'426', LBR:'430', LBY:'434',
  LIE:'438', LTU:'440', LUX:'442',
  MAC:'446', MDG:'450', MWI:'454', MYS:'458', MDV:'462', MLI:'466',
  MLT:'470', MRT:'478', MUS:'480', MEX:'484', MDA:'498', MCO:'492',
  MNG:'496', MNE:'499', MAR:'504', MOZ:'508', MMR:'104',
  NAM:'516', NPL:'524', NLD:'528', NZL:'554', NIC:'558', NER:'562',
  NGA:'566', PRK:'408', MKD:'807', NOR:'578',
  OMN:'512',
  PAK:'586', PSE:'275', PAN:'591', PNG:'598', PRY:'600', PER:'604',
  PHL:'608', POL:'616', PRT:'620',
  QAT:'634',
  ROU:'642', RUS:'643', RWA:'646',
  SAU:'682', SEN:'686', SRB:'688', SLE:'694', SGP:'702', SVK:'703',
  SVN:'705', SOM:'706', ZAF:'710', KOR:'410', SSD:'728', ESP:'724',
  LKA:'144', SDN:'736', SUR:'740', SWE:'752', CHE:'756', SYR:'760',
  TWN:'158', TJK:'762', TZA:'834', THA:'764', TLS:'626', TGO:'768',
  TTO:'780', TUN:'788', TUR:'792', TKM:'795',
  UGA:'800', UKR:'804', ARE:'784', GBR:'826', USA:'840', URY:'858',
  UZB:'860',
  VEN:'862', VNM:'704',
  ESH:'732',
  YEM:'887',
  ZMB:'894', ZWE:'716',
};

// ── URL builder ───────────────────────────────────────────────────────────────
// Plain string (not URLSearchParams) keeps the comma in flowCode=M,X unencoded.
// No cmdCode — omitting it returns all commodities + TOTAL row in one response.
// Endpoint selection: data (authenticated) vs preview (fallback, no key).
function buildComtradeUrl(reporterM49, partnerM49, year) {
  var base = SUBSCRIPTION_KEY ? COMTRADE_DATA_BASE : COMTRADE_PREVIEW_BASE;
  return base +
    '?reporterCode=' + reporterM49 +
    '&partnerCode='  + partnerM49 +
    '&period='       + year +
    '&flowCode=M,X';
}

// ── Request headers ───────────────────────────────────────────────────────────
// Key is only sent when using the data endpoint — preview ignores it anyway.
function buildHeaders() {
  var h = { 'Accept': 'application/json' };
  if (SUBSCRIPTION_KEY) h['Ocp-Apim-Subscription-Key'] = SUBSCRIPTION_KEY;
  return h;
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Single Comtrade fetch with full response validation ────────────────────────
// Handles: 401/403 (bad key), 429 (rate limit), non-2xx, 200+error-in-body.
async function comtradeFetch(url) {
  var signal = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  var res = await fetch(url, { headers: buildHeaders(), signal: signal });

  // 401 or 403 — invalid or missing subscription key
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error('Invalid or expired Comtrade subscription key. Check COMTRADE_SUBSCRIPTION_KEY in Netlify env vars.'),
      { status: res.status }
    );
  }

  // 429 — rate limit
  if (res.status === 429) {
    throw Object.assign(
      new Error('Comtrade rate limit reached. The free tier allows 500 requests per day.'),
      { status: 429 }
    );
  }

  if (!res.ok) {
    throw new Error('Comtrade HTTP ' + res.status);
  }

  var json = await res.json();

  // 200 with error body (Comtrade-specific pattern)
  if (json && (json.statusCode >= 400 || json.error === true)) {
    throw new Error('Comtrade error: ' + (json.message || json.statusCode || 'unknown'));
  }

  return Array.isArray(json.data) ? json.data : [];
}

// ── Record normalizer ─────────────────────────────────────────────────────────
function parsePrimaryValue(r) {
  return parseFloat(r.primaryValue || 0) || 0;
}

function normalizeRecord(r) {
  return {
    code:      String(r.cmdCode || ''),
    desc:      String(r.cmdDesc || '').slice(0, 100),
    flow:      String(r.flowCode || ''),
    value_usd: parsePrimaryValue(r),
    quantity:  parseFloat(r.qty || 0) || null,
    unit:      String(r.qtyUnitAbbr || ''),
  };
}

// ── Main data fetch: single Comtrade call ──────────────────────────────────────
// ONE request: flowCode=M,X, no cmdCode → all commodities + TOTAL for both flows.
// The data endpoint returns ~100-200 records for a bilateral pair; preview up to 500.
// Client-side: find TOTAL row for headline values, filter remaining as HS chapters.
async function fetchComtradeData(reporterM49, partnerM49, year) {
  // Preview fallback is aggressively rate-limited — add a courtesy delay.
  if (!SUBSCRIPTION_KEY) await sleep(2000);

  var url = buildComtradeUrl(reporterM49, partnerM49, year);
  console.log('[fetch-comtrade] requesting:', url);

  var allRecords = await comtradeFetch(url);

  if (allRecords.length === 0) {
    return {
      exports:     { total_usd: 0, records: [] },
      imports:     { total_usd: 0, records: [] },
      balance_usd: 0,
      top_exports: [],
      top_imports: [],
      no_data:     true,
    };
  }

  // Split by flow direction
  var expRecords = allRecords.filter(function(r) { return r.flowCode === 'X'; });
  var impRecords = allRecords.filter(function(r) { return r.flowCode === 'M'; });

  // Find TOTAL row for each flow (cmdCode === 'TOTAL')
  var expTotalRow = expRecords.find(function(r) {
    return String(r.cmdCode).toUpperCase() === 'TOTAL';
  });
  var impTotalRow = impRecords.find(function(r) {
    return String(r.cmdCode).toUpperCase() === 'TOTAL';
  });

  // Use TOTAL row value; fall back to sum of chapters if TOTAL row absent
  var exportTotalUSD = expTotalRow
    ? parsePrimaryValue(expTotalRow)
    : expRecords.reduce(function(s, r) { return s + parsePrimaryValue(r); }, 0);
  var importTotalUSD = impTotalRow
    ? parsePrimaryValue(impTotalRow)
    : impRecords.reduce(function(s, r) { return s + parsePrimaryValue(r); }, 0);

  // Commodity chapters: exclude TOTAL row, sort by value desc, top 10
  var expChapters = expRecords
    .filter(function(r) { return String(r.cmdCode).toUpperCase() !== 'TOTAL'; })
    .map(normalizeRecord)
    .sort(function(a, b) { return b.value_usd - a.value_usd; })
    .slice(0, 10)
    .map(function(r) { return { code: r.code, desc: r.desc, value_usd: r.value_usd }; });

  var impChapters = impRecords
    .filter(function(r) { return String(r.cmdCode).toUpperCase() !== 'TOTAL'; })
    .map(normalizeRecord)
    .sort(function(a, b) { return b.value_usd - a.value_usd; })
    .slice(0, 10)
    .map(function(r) { return { code: r.code, desc: r.desc, value_usd: r.value_usd }; });

  var allExpNorm = expRecords.map(normalizeRecord);
  var allImpNorm = impRecords.map(normalizeRecord);

  console.log('[fetch-comtrade] exports:', exportTotalUSD,
    'imports:', importTotalUSD,
    '| exp chapters:', expChapters.length,
    'imp chapters:', impChapters.length,
    '| total rows:', allRecords.length);

  return {
    exports:     { total_usd: exportTotalUSD, records: allExpNorm },
    imports:     { total_usd: importTotalUSD, records: allImpNorm },
    balance_usd: exportTotalUSD - importTotalUSD,
    top_exports: expChapters,
    top_imports: impChapters,
    no_data:     false,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const params   = event.queryStringParameters || {};
  const reporter = (params.reporter || '').toUpperCase().trim();
  const partner  = (params.partner  || '').toUpperCase().trim();
  const year     = parseInt(params.year || '2023') || 2023;

  if (!reporter || !partner) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'reporter and partner query params required' }),
    };
  }

  const reporterM49 = ISO3_TO_M49[reporter];
  const partnerM49  = ISO3_TO_M49[partner];

  if (!reporterM49) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unsupported country code: ' + reporter }),
    };
  }
  if (!partnerM49) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unsupported country code: ' + partner }),
    };
  }

  const cacheKey = 'trade_' + reporter + '_' + partner + '_' + year;
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Cache read (SWR: fresh → serve; stale → serve on error; recently written → coalesce) ──
  const cached = await Cache.readCache(supabase, cacheKey, TTL_MS, STALE_MS);

  if (cached.isFresh) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // Cross-instance coalescing: another Lambda wrote this key within COALESCE_WINDOW_MS
  if (cached.wasRecentlyWritten && cached.hasData) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // ── Fetch from Comtrade (in-memory coalescing per country pair) ────────────
  let tradeData;
  try {
    tradeData = await Cache.withCoalescing(cacheKey, function() {
      return fetchComtradeData(reporterM49, partnerM49, year);
    });
  } catch (err) {
    const isQuota = err.status === 429;
    const isAuth  = err.status === 401 || err.status === 403;

    if (isQuota) {
      console.error('[QUOTA_EXHAUSTED][fetch-comtrade] Comtrade daily limit reached (500 calls/day) —',
        cached.hasData
          ? 'serving stale cache (age=' + Math.round(cached.ageMs / 86400000) + 'd)'
          : 'no cache for ' + reporter + '/' + partner + '/' + year);

      // Serve stale trade data — annual figures don't change mid-year
      if (cached.isStale && cached.hasData) {
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            ...cached.payload,
            cached:     true,
            degraded:   true,
            staleAgeMs: cached.ageMs,
            error:      'upstream_quota_exhausted',
          }),
        };
      }

      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:       true,
          status:      429,
          message:     'Comtrade daily quota reached (500 calls/day). Data temporarily unavailable; try again tomorrow.',
          retry_after: 86400,
        }),
      };
    }

    if (isAuth) {
      return {
        statusCode: err.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:   true,
          status:  err.status,
          message: 'Invalid or expired Comtrade subscription key. Check COMTRADE_SUBSCRIPTION_KEY in Netlify env vars.',
        }),
      };
    }

    console.error('[fetch-comtrade] fetch failed:', err.message);

    // Serve stale on any upstream failure if within stale window
    if (cached.isStale && cached.hasData) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          ...cached.payload,
          cached:     true,
          degraded:   true,
          staleAgeMs: cached.ageMs,
          error:      'upstream_error',
        }),
      };
    }

    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Comtrade upstream unavailable', message: err.message }),
    };
  }

  const payload = {
    reporter:    reporter,
    partner:     partner,
    year:        year,
    exports:     tradeData.exports,
    imports:     tradeData.imports,
    balance_usd: tradeData.balance_usd,
    top_exports: tradeData.top_exports,
    top_imports: tradeData.top_imports,
    no_data:     tradeData.no_data || false,
    ts:          Date.now(),
    source:      'UN Comtrade',
  };

  // ── Cache write ────────────────────────────────────────────────────────────
  await Cache.writeCache(supabase, cacheKey, payload);

  // Write individual records to bilateral_trade_cache for analytics
  try {
    const rows = [];
    const allExport = tradeData.exports.records;
    const allImport = tradeData.imports.records;
    for (var i = 0; i < allExport.length; i++) {
      rows.push({
        reporter_iso3:   reporter,
        partner_iso3:    partner,
        year:            year,
        flow_direction:  'export',
        commodity_code:  allExport[i].code || 'TOTAL',
        trade_value_usd: allExport[i].value_usd,
        quantity:        allExport[i].quantity,
        quantity_unit:   allExport[i].unit,
        commodity_desc:  allExport[i].desc,
        fetched_at:      new Date().toISOString(),
      });
    }
    for (var j = 0; j < allImport.length; j++) {
      rows.push({
        reporter_iso3:   reporter,
        partner_iso3:    partner,
        year:            year,
        flow_direction:  'import',
        commodity_code:  allImport[j].code || 'TOTAL',
        trade_value_usd: allImport[j].value_usd,
        quantity:        allImport[j].quantity,
        quantity_unit:   allImport[j].unit,
        commodity_desc:  allImport[j].desc,
        fetched_at:      new Date().toISOString(),
      });
    }
    if (rows.length) {
      await supabase
        .from('bilateral_trade_cache')
        .upsert(rows, { onConflict: 'reporter_iso3,partner_iso3,year,flow_direction,commodity_code' });
    }
  } catch (err) {
    console.warn('[fetch-comtrade] record write failed:', err.message);
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify(payload),
  };
};
