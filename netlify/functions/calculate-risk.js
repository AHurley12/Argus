// netlify/functions/calculate-risk.js
// Hybrid risk scoring engine: blends static baselines with live GDELT signal.
//
// Score formula (per country):
//   dynamicScore = 0.55 * baseline + 0.30 * eventScore + 0.15 * volatility
//
// eventScore  = sum of (keyword weight × time decay) for each article, normalised 0–100
// volatility  = 24h article density relative to 48h window, scaled 0–100
// time decay  = exp(-age_hours / 48)  — half-life 48 h (matches GDELT query window)
//
// Results cached in Supabase global_events (key: "risk_scores"), TTL 5 minutes.
// Reads article data directly from Supabase cache (key: "gdelt_feed") — avoids
// internal Netlify function-to-function HTTP call latency.

const { createClient } = require('@supabase/supabase-js');
const baseline = require('../../data/baseline.json');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── GDELT sourcecountry name → ISO3 ─────────────────────────────────────────
// GDELT DOC v2 returns full English country names in sourcecountry.
const NAME_TO_ISO3 = {
  'united states': 'USA', 'russia': 'RUS', 'china': 'CHN', 'germany': 'DEU',
  'japan': 'JPN', 'india': 'IND', 'brazil': 'BRA', 'saudi arabia': 'SAU',
  'south korea': 'KOR', 'australia': 'AUS', 'nigeria': 'NGA', 'iran': 'IRN',
  'united kingdom': 'GBR', 'france': 'FRA', 'canada': 'CAN', 'mexico': 'MEX',
  'south africa': 'ZAF', 'turkey': 'TUR', 'argentina': 'ARG', 'indonesia': 'IDN',
  'pakistan': 'PAK', 'bangladesh': 'BGD', 'ethiopia': 'ETH', 'egypt': 'EGY',
  'united arab emirates': 'ARE', 'israel': 'ISR', 'ukraine': 'UKR', 'syria': 'SYR',
  'yemen': 'YEM', 'libya': 'LBY', 'sudan': 'SDN', 'mali': 'MLI', 'somalia': 'SOM',
  'afghanistan': 'AFG', 'north korea': 'PRK', 'venezuela': 'VEN', 'cuba': 'CUB',
  'myanmar': 'MMR', 'iraq': 'IRQ', 'belarus': 'BLR', 'poland': 'POL',
  'philippines': 'PHL', 'thailand': 'THA', 'vietnam': 'VNM', 'malaysia': 'MYS',
  'singapore': 'SGP', 'taiwan': 'TWN', 'hong kong': 'HKG', 'mongolia': 'MNG',
  'colombia': 'COL', 'peru': 'PER', 'chile': 'CHL', 'ecuador': 'ECU',
  'morocco': 'MAR', 'algeria': 'DZA', 'kenya': 'KEN', 'ghana': 'GHA',
  'lebanon': 'LBN', 'jordan': 'JOR', 'qatar': 'QAT', 'kuwait': 'KWT',
  'netherlands': 'NLD', 'belgium': 'BEL', 'spain': 'ESP', 'italy': 'ITA',
  'sweden': 'SWE', 'norway': 'NOR', 'switzerland': 'CHE', 'austria': 'AUT',
  'new zealand': 'NZL', 'democratic republic of the congo': 'COD', 'haiti': 'HTI',
  'nepal': 'NPL', 'sri lanka': 'LKA', 'azerbaijan': 'AZE', 'armenia': 'ARM',
  'georgia': 'GEO', 'kazakhstan': 'KAZ', 'angola': 'AGO', 'mozambique': 'MOZ',
  'zimbabwe': 'ZWE', 'rwanda': 'RWA', 'uganda': 'UGA', 'tanzania': 'TZA',
};

// ── Title keyword → event weight ──────────────────────────────────────────────
function getWeight(title) {
  if (!title) return 1;
  var t = title.toLowerCase();
  if (/war|invasion|airstrike|bombing|missile|offensive|coup|massacre/.test(t)) return 5;
  if (/sanction|embargo|tariff|blockade|seizure|seized/.test(t))               return 4;
  if (/attack|explosion|killed|fighting|offensive|assault/.test(t))            return 4;
  if (/protest|riot|strike|unrest|clash|uprising/.test(t))                     return 3;
  if (/conflict|tension|threat|crisis|warning|disputed/.test(t))               return 2;
  return 1;
}

// ── Exponential time decay — half-life 48 h ───────────────────────────────────
function decay(seendate) {
  try {
    var hours = (Date.now() - new Date(seendate).getTime()) / 3600000;
    return Math.exp(-hours / 48);
  } catch(e) { return 0.5; }
}

// ── Normalise raw score to 0–100 with soft cap ────────────────────────────────
function norm(raw, maxExpected) {
  return Math.min(100, (raw / maxExpected) * 100);
}

// ── score → risk tier ─────────────────────────────────────────────────────────
function scoreToTier(s) {
  if (s >= 75) return 'CRITICAL';
  if (s >= 54) return 'WARNING';
  if (s >= 33) return 'WATCH';
  return 'LOW';
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // ── Check risk_scores cache (5 min TTL) ─────────────────────────────────
    const { data: cached } = await sb
      .from('global_events')
      .select('payload, updated_at')
      .eq('key', 'risk_scores')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'cache', scores: cached.payload }) };
    }

    // ── Read GDELT article cache ─────────────────────────────────────────────
    const { data: gdeltRow } = await sb
      .from('global_events')
      .select('payload')
      .eq('key', 'gdelt_feed')
      .single();

    const articles = (gdeltRow && gdeltRow.payload) || [];

    // ── Group articles by ISO3 country ───────────────────────────────────────
    const byCountry = {};
    articles.forEach(function(a) {
      var raw  = (a.sourcecountry || '').trim().toLowerCase();
      var iso3 = NAME_TO_ISO3[raw];
      if (!iso3) return; // skip unknown countries
      if (!byCountry[iso3]) byCountry[iso3] = [];
      byCountry[iso3].push(a);
    });

    const now = Date.now();

    // ── Compute per-country scores ────────────────────────────────────────────
    const scores = Object.keys(baseline).map(function(iso3) {
      var articles  = byCountry[iso3] || [];
      var base      = baseline[iso3] || 30;

      // Event score: weighted sum with time decay, normalised over expected max
      var rawEvent = articles.reduce(function(sum, a) {
        return sum + getWeight(a.title) * decay(a.seendate);
      }, 0);
      var eventScore = norm(rawEvent, 8); // 8 = ~2 high-weight fresh articles

      // Volatility: 24h density relative to full 48h window
      var recent24h = articles.filter(function(a) {
        try { return now - new Date(a.seendate).getTime() < 86400000; } catch(e) { return false; }
      });
      var volatility = articles.length > 0
        ? norm(recent24h.length / articles.length * articles.length, 5)
        : 0;

      // Blend
      var dynamicScore = Math.min(100, Math.round(
        0.55 * base + 0.30 * eventScore + 0.15 * volatility
      ));

      return {
        iso3,
        dynamicScore,
        baseline:     base,
        eventScore:   Math.round(eventScore),
        volatility:   Math.round(volatility),
        articleCount: articles.length,
        tier:         scoreToTier(dynamicScore),
      };
    });

    // ── Cache results ────────────────────────────────────────────────────────
    await sb.from('global_events').upsert({
      key:        'risk_scores',
      payload:    scores,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return { statusCode: 200, headers, body: JSON.stringify({ source: 'live', scores }) };

  } catch(err) {
    console.error('calculate-risk error:', err.message);
    // Return baseline-only scores as fallback — never hard fail
    const fallback = Object.keys(baseline).map(function(iso3) {
      return { iso3, dynamicScore: baseline[iso3], baseline: baseline[iso3], eventScore: 0, volatility: 0, articleCount: 0, tier: scoreToTier(baseline[iso3]) };
    });
    return { statusCode: 200, headers, body: JSON.stringify({ source: 'fallback', scores: fallback }) };
  }
};
