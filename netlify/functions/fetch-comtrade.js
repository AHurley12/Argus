// netlify/functions/fetch-comtrade.js
// UN Comtrade bilateral trade data proxy.
//
// Swagger spec base: https://comtradeapi.un.org/public/v1
// Preview path:      /preview/{typeCode}/{freqCode}/{clCode}
//   typeCode = C (commodities), freqCode = A (annual), clCode = HS
//
// Auth: Ocp-Apim-Subscription-Key header (Azure APIM standard).
//   Always uses the preview endpoint. Subscription key raises rate limits
//   on the same URL — no separate endpoint switch needed.
//
// Call strategy (2 sequential calls, 1500ms apart):
//   1. cmdCode=TOTAL  flowCode=M,X  → total import + export in one response
//   2. cmdCode=AG2    flowCode=M,X  → HS-2 commodity breakdown, split by flowCode
//
// Cache TTL: 7 days (Supabase argus_cache table).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, COMTRADE_SUBSCRIPTION_KEY (optional)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const SUBSCRIPTION_KEY = (process.env.COMTRADE_SUBSCRIPTION_KEY || '').trim();

const CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_RECORDS   = 500;
const CALL_DELAY_MS = 1500; // inter-call delay to respect rate limits

// Always the preview endpoint — auth header raises the quota, no URL switch.
// Per swagger: base = https://comtradeapi.un.org/public/v1
//              path = /preview/{typeCode}/{freqCode}/{clCode}
const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';

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
// Built as a plain string (not URLSearchParams) so the comma in flowCode=M,X
// is NOT percent-encoded. Comtrade expects the raw comma as a separator.
// Swagger-confirmed param names: reporterCode, partnerCode, period, flowCode,
// cmdCode, maxRecords, format.
function buildComtradeUrl(reporterM49, partnerM49, year, cmdCode, flowCode) {
  return COMTRADE_BASE +
    '?reporterCode=' + reporterM49 +
    '&partnerCode='  + partnerM49 +
    '&period='       + year +
    '&flowCode='     + flowCode +    // 'M,X' — unencoded comma is intentional
    '&cmdCode='      + cmdCode +     // 'TOTAL' or 'AG2'
    '&maxRecords='   + MAX_RECORDS +
    '&format=JSON';
}

// ── Request headers ───────────────────────────────────────────────────────────
// Ocp-Apim-Subscription-Key is the Azure APIM standard header name.
// Per swagger spec, it can also go as query param "subscription-key" but
// the header is preferred.
function buildHeaders() {
  const h = { 'Accept': 'application/json' };
  if (SUBSCRIPTION_KEY) h['Ocp-Apim-Subscription-Key'] = SUBSCRIPTION_KEY;
  return h;
}

// ── Inter-call delay ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Single Comtrade request with full response validation ──────────────────────
// Handles: 429, 403, non-2xx, 200+empty, 200+error-in-body.
async function comtradeFetch(url) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  const res = await fetch(url, { headers: buildHeaders(), signal: signal });

  // 429 — rate limit
  if (res.status === 429) {
    const hint = SUBSCRIPTION_KEY
      ? 'Comtrade rate limit hit even with subscription key. Wait and retry.'
      : 'Comtrade rate limit hit. Add COMTRADE_SUBSCRIPTION_KEY to Netlify env vars for higher limits.';
    throw Object.assign(new Error('rate_limit'), { status: 429, hint: hint });
  }

  // 403 — invalid or expired subscription key
  if (res.status === 403) {
    throw Object.assign(
      new Error('Comtrade: invalid or expired subscription key (HTTP 403)'),
      { status: 403 }
    );
  }

  if (!res.ok) {
    throw new Error('Comtrade HTTP ' + res.status);
  }

  const json = await res.json();

  // 200 but error object in body — Comtrade sometimes wraps errors this way
  // e.g. { "statusCode": 400, "message": "Bad Request" }
  // or   { "error": true, "errors": [...] }
  if (json && (json.statusCode >= 400 || json.error === true)) {
    throw new Error('Comtrade error in body: ' + (json.message || json.statusCode || 'unknown'));
  }

  // 200 with valid (possibly empty) data array
  return Array.isArray(json.data) ? json.data : [];
}

// ── Record normalizer ─────────────────────────────────────────────────────────
function parsePrimaryValue(r) {
  return parseFloat(r.primaryValue || r.TradeValue || 0) || 0;
}

function normalizeRecord(r) {
  return {
    code:      String(r.cmdCode || ''),
    desc:      String(r.cmdDesc || r.CmdDesc || '').slice(0, 100),
    flow:      String(r.flowCode || r.FlowCode || ''),
    value_usd: parsePrimaryValue(r),
    quantity:  parseFloat(r.qty || r.Qty || 0) || null,
    unit:      String(r.qtyUnitAbbr || r.QtyUnitAbbr || ''),
  };
}

// ── Main data fetch: 2 sequential calls ───────────────────────────────────────
// Call 1: TOTAL aggregate with flowCode=M,X → separates into exports/imports
// Call 2: AG2 (HS-2 digit) with flowCode=M,X → commodity breakdown
// 1500ms delay between calls to respect rate limits.
async function fetchComtradeData(reporterM49, partnerM49, year) {

  // ── Call 1: totals ──────────────────────────────────────────────────────────
  const totalUrl = buildComtradeUrl(reporterM49, partnerM49, year, 'TOTAL', 'M,X');
  console.log('[fetch-comtrade] call 1 (TOTAL):', totalUrl);
  const totalRecords = await comtradeFetch(totalUrl);

  // Split by flowCode field: X = reporter's exports TO partner, M = imports FROM partner
  const expTotalRecords = totalRecords.filter(function(r) {
    return (r.flowCode || r.FlowCode || '') === 'X';
  });
  const impTotalRecords = totalRecords.filter(function(r) {
    return (r.flowCode || r.FlowCode || '') === 'M';
  });

  const exportTotalUSD = expTotalRecords.reduce(function(s, r) { return s + parsePrimaryValue(r); }, 0);
  const importTotalUSD = impTotalRecords.reduce(function(s, r) { return s + parsePrimaryValue(r); }, 0);

  // ── Delay before call 2 ─────────────────────────────────────────────────────
  await sleep(CALL_DELAY_MS);

  // ── Call 2: HS-2 commodity breakdown ───────────────────────────────────────
  // Preview endpoint: maximum 1 cmdCode per request. AG2 is the 2-digit HS
  // aggregate code — a single valid cmdCode that returns all chapters.
  const cmdUrl = buildComtradeUrl(reporterM49, partnerM49, year, 'AG2', 'M,X');
  console.log('[fetch-comtrade] call 2 (AG2):', cmdUrl);
  let cmdRecords = [];
  try {
    cmdRecords = await comtradeFetch(cmdUrl);
  } catch (err) {
    // Commodity breakdown is best-effort — totals still usable if this fails
    console.warn('[fetch-comtrade] AG2 call failed (non-fatal):', err.message);
  }

  // Split commodity records by flow, sort by value, top 10
  const expCmdNorm = cmdRecords
    .filter(function(r) { return (r.flowCode || r.FlowCode || '') === 'X'; })
    .map(normalizeRecord)
    .sort(function(a, b) { return b.value_usd - a.value_usd; });

  const impCmdNorm = cmdRecords
    .filter(function(r) { return (r.flowCode || r.FlowCode || '') === 'M'; })
    .map(normalizeRecord)
    .sort(function(a, b) { return b.value_usd - a.value_usd; });

  const topExports = expCmdNorm.slice(0, 10).map(function(r) {
    return { code: r.code, desc: r.desc, value_usd: r.value_usd };
  });
  const topImports = impCmdNorm.slice(0, 10).map(function(r) {
    return { code: r.code, desc: r.desc, value_usd: r.value_usd };
  });

  console.log('[fetch-comtrade] totals — exports:', exportTotalUSD,
    'imports:', importTotalUSD,
    '| commodity rows X:', expCmdNorm.length, 'M:', impCmdNorm.length);

  return {
    exports:     { total_usd: exportTotalUSD, records: expTotalRecords.map(normalizeRecord) },
    imports:     { total_usd: importTotalUSD, records: impTotalRecords.map(normalizeRecord) },
    balance_usd: exportTotalUSD - importTotalUSD,
    top_exports: topExports,
    top_imports: topImports,
    no_data:     totalRecords.length === 0,
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

  // ── Cache read ─────────────────────────────────────────────────────────────
  try {
    const { data: row } = await supabase
      .from('argus_cache')
      .select('payload, updated_at')
      .eq('key', cacheKey)
      .single();

    if (row && row.payload) {
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed */ }

  // ── Fetch from Comtrade ────────────────────────────────────────────────────
  let tradeData;
  try {
    tradeData = await fetchComtradeData(reporterM49, partnerM49, year);
  } catch (err) {
    if (err.status === 429) {
      return {
        statusCode: 429,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:       true,
          status:      429,
          message:     err.hint || 'Comtrade rate limit hit.',
          retry_after: 60,
        }),
      };
    }
    if (err.status === 403) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:   true,
          status:  403,
          message: 'Comtrade subscription key is invalid or expired. Check COMTRADE_SUBSCRIPTION_KEY in Netlify env vars.',
        }),
      };
    }
    console.error('[fetch-comtrade] fetch failed:', err.message);
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
  try {
    await supabase
      .from('argus_cache')
      .upsert(
        { key: cacheKey, payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
  } catch (err) {
    console.warn('[fetch-comtrade] cache write failed:', err.message);
  }

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
