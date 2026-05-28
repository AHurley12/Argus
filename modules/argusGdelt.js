window.gdelt = (function() {
'use strict';

var CACHE_KEY = 'argus_gdelt_v3';    // bumped — clears any failed-fetch cache
var CACHE_TS  = 'argus_gdelt_ts_v3';
var TTL       = 25 * 60 * 1000; // 25 min — GDELT sweet spot (15 min update + ~10 min propagation)
var activeTab = 'news';
var data      = { events: [], tones: {}, chokeScores: {}, context: '' };

// ── GDELT proxies — null (file://) origin safe, tried in order ───────────────
// Key constraint: file:// sends Origin: null — many proxies block this.
// Proxies below are ordered by reliability from null origin in 2025-2026.
var GDELT_PROXIES = [
  // 1. codetabs — rate-limited fallback (file:// origin only)
  function(url) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url); },
  // 2. corsproxy.io — final fallback (file:// origin only)
  function(url) { return 'https://corsproxy.io/?url=' + encodeURIComponent(url); },
];

// ── Inject tab toggle into events panel ──────────────────────────────────────
(function injectTabs() {
  var header = document.querySelector('.events-header');
  if (!header) return;
  var toggle = document.createElement('div');
  toggle.id = 'feed-toggle';
  toggle.innerHTML =
    '<div class="feed-tab is-news-active" id="tab-news" onclick="gdelt.switchTab(\'news\')">NEWS</div>' +
    '<div class="feed-tab" id="tab-gdelt" onclick="gdelt.switchTab(\'gdelt\')">GDELT</div>' +
    '<div class="feed-tab" id="tab-disaster" onclick="gdelt.switchTab(\'disaster\')">⚠ DISASTER</div>';
  header.insertAdjacentElement('afterend', toggle);
})();

// ── Plot priority scoring — humanitarian first (70%), economics second (30%) ──
var GDELT_HUM_RE  = /war|conflict|attack|airstrike|bombing|casualties|killed|wounded|massacre|coup|terror|genocide|displacement|refugee|famine|civilian|siege|offensive|shelling|protest|crackdown|arrest|detained|execution|disappear|torture|human.rights|persecution|uprising|mutiny|rebellion/i;
var GDELT_ECO_RE  = /sanction|tariff|trade|oil|gas|energy|inflation|recession|market|supply.chain|shipping|logistics|embargo|default|debt|gdp|currency|devaluation|export|import|port|pipeline|commodity|wheat|grain|food.price|fertilizer|semiconductor|rare.earth|lithium|investment|bank|financial|bond|yield|deficit/i;
var GDELT_SEV_W   = { CRITICAL: 100, WARNING: 65, WATCH: 35, LOW: 10 };
function scorePlotPriority(ev) {
  var full        = (ev.title || '') + ' ' + (ev.impact || ev.domain || '');
  var humHit      = GDELT_HUM_RE.test(full) ? 1 : 0;
  var ecoHit      = GDELT_ECO_RE.test(full) ? 1 : 0;
  var sevScore    = GDELT_SEV_W[ev.severity] || 10;
  var typeBonus   = (ev.type === 'CONFLICT' || ev.type === 'DISASTER') ? 20 : 0;
  var sourceBoost = (window.getSourceBoost || function(){return 0;})(ev.source || ev.domain || '');
  var raw = Math.round((humHit * 0.50 + ecoHit * 0.50) * sevScore + typeBonus + sourceBoost);
  // Sentiment adjustment: hostile signal boosts globe visibility; positive news suppresses it
  if (typeof ev._sentiment === 'number') {
    if (ev._sentiment < -50) raw += 10;
    if (ev._sentiment >  40) raw -= 8;
  }
  return Math.max(0, Math.min(120, raw));
}

// ── Article classifier ────────────────────────────────────────────────────────
function classifyArticle(article, idx) {
  // V2Tone: GKG format is comma-separated "Tone,Positive,Negative,Polarity,ActivityDensity,SelfGroupDensity"
  // DOC API returns a plain float; handle both forms.
  var rawTone = article.tone;
  var tone = (typeof rawTone === 'string' && rawTone.indexOf(',') !== -1)
    ? (parseFloat(rawTone.split(',')[0]) || 0)
    : parseFloat(rawTone || 0);

  // GCAM: extract v19.1 (ANEW Valence) and c8.3 (RID Anxiety) when present
  var valence = null, anxiety = null;
  if (article.gcam) {
    String(article.gcam).split(',').forEach(function(part) {
      var kv = part.split(':');
      if (kv.length === 2) {
        var k = kv[0].trim(), v = parseFloat(kv[1]);
        if (k === 'v19.1') valence = isNaN(v) ? null : v;
        else if (k === 'c8.3') anxiety = isNaN(v) ? null : v;
      }
    });
  }
  // Combined Stability Score: weighted blend of raw tone and ANEW valence
  var stabilityScore = valence !== null ? (tone * 0.7) + (valence * 0.3) : null;

  var title = (article.title || '').slice(0, 80);
  var low   = title.toLowerCase();

  // Tone-based baseline (GDELT V2Tone: negative = more hostile)
  var toneSev = tone < -8 ? 'CRITICAL' : tone < -4 ? 'WARNING' : tone < -1 ? 'WATCH' : 'LOW';

  // Keyword-based baseline — supplements tone when tone is weak or absent
  var _kwResult  = window.scoreArticleRisk ? window.scoreArticleRisk(title, title) : null;
  var kwSev      = _kwResult ? _kwResult.sev : 'LOW';

  // Take the higher of tone-based and keyword-based severity
  var _SEV_NUM   = { LOW: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 };
  var _SEV_NAMES = ['LOW','WATCH','WARNING','CRITICAL'];
  var sev = _SEV_NAMES[Math.max(_SEV_NUM[toneSev] || 0, _SEV_NUM[kwSev] || 0)];

  // ── Sentiment second-pass: keyword cross-check against GDELT V2Tone baseline ──
  var _gdeltSent = null;
  if (window.calcSentimentScore && window.deriveSeverity) {
    _gdeltSent = window.calcSentimentScore(title, title);
    var _gdeltSrcB = (window.getSourceBoost || function(){return 0;})(article.domain || '');
    sev = window.deriveSeverity(sev, _gdeltSent, _gdeltSrcB);
  }

  var type = window.argusClassifyType ? window.argusClassifyType(low) : 'POLICY';
  // seendate format from GDELT: "20250314T083200Z"
  var seendate = '';
  if (article.seendate) {
    try {
      var s  = article.seendate;
      var yr = s.slice(0,4), mo = s.slice(4,6), dy = s.slice(6,8);
      var hr = s.slice(9,11), mn = s.slice(11,13);
      var mo_names = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      seendate = parseInt(dy) + ' ' + mo_names[parseInt(mo)-1] + ' ' + yr + ' · ' + hr + ':' + mn + ' UTC';
    } catch(e) {}
  }

  var ev = { id: 2000 + idx, type: type, severity: sev, title: title, tone: tone,
             valence: valence, anxiety: anxiety, stabilityScore: stabilityScore,
             url: article.url || '', seendate: seendate,
             country: (article.sourcecountry || '').toUpperCase(),
             domain:  article.domain || '',
             _sentiment: _gdeltSent };
  ev.plotPriority = scorePlotPriority(ev);
  return ev;
}

// ── GDELT DOC v2 query ───────────────────────────────────────────────────────
// file:// origin is treated as "null" by browsers — GDELT blocks it via CORS.
// Proxy is required. Correct approach: build a fully-encoded GDELT URL first,
// then pass that pre-encoded string to PG (which wraps it in encodeURIComponent
// one time). The proxy decodes once → GDELT receives a clean, valid URL.
function makeUrl(query, maxrecs, timespan) {
  // Return raw GDELT URL — safeFetch handles proxy wrapping
  return 'https://api.gdeltproject.org/api/v2/doc/doc' +
    '?query='       + encodeURIComponent(query) +
    '&mode=ArtList' +
    '&maxrecords='  + maxrecs +
    '&format=json'  +
    '&timespan='    + timespan +
    '&sort=DateDesc';
}

async function safeFetch(gdeltUrl) {
  for (var p = 0; p < GDELT_PROXIES.length; p++) {
    if (p > 0) await new Promise(function(r) { setTimeout(r, 7000); });
    var proxyUrl = GDELT_PROXIES[p](gdeltUrl);
    try {
      var r = await fetch(proxyUrl);
      if (!r.ok) { console.warn('GDELT proxy[' + p + ']: HTTP ' + r.status); continue; }
      var trimmed = (await r.text()).trim();
      if (!trimmed) { console.warn('GDELT proxy[' + p + ']: empty response'); continue; }

      // allorigins /get wraps payload as { contents: "...", status: {...} }
      if (trimmed.startsWith('{"contents"')) {
        try {
          var wrapper = JSON.parse(trimmed);
          trimmed = (wrapper.contents || '').trim();
        } catch(e) { console.warn('GDELT proxy[' + p + ']: wrapper parse fail'); continue; }
      }

      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        console.warn('GDELT proxy[' + p + ']: non-JSON:', trimmed.slice(0, 80));
        continue;
      }
      try {
        var parsed = JSON.parse(trimmed);
        if (p > 0) console.log('GDELT: proxy[' + p + '] succeeded');
        return parsed;
      } catch(e) { console.warn('GDELT proxy[' + p + '] parse fail:', e.message); continue; }
    } catch(e) { console.warn('GDELT proxy[' + p + '] error:', e.message); continue; }
  }
  console.warn('GDELT: all proxies failed');
  return null;
}

// ── Country/chokepoint keyword maps ──────────────────────────────────────────
var COUNTRY_KEYS = {
  RUS: ['russia','russian','moscow','putin','kremlin','ukraine war'],
  IRN: ['iran','iranian','tehran','khamenei','nuclear deal','hormuz'],
  CHN: ['china','chinese','beijing','xi jinping','taiwan','semiconductor'],
  SAU: ['saudi','riyadh','aramco','opec','mbs'],
  PRK: ['north korea','pyongyang','kim jong','dprk'],
  UKR: ['ukraine','kyiv','zelensky','ukrainian'],
};
var CHOKE_KEYS = {
  bab_cp:     ['bab el mandeb','houthi','red sea','yemen'],
  suez:       ['suez','canal'],
  hormuz:     ['hormuz','strait of hormuz'],
  bosphorus:  ['bosphorus','black sea','istanbul'],
  dardanelles:['dardanelles','canakkale','çanakkale'],
  oresund:    ['oresund','øresund','copenhagen','baltic sea','swedish'],
  great_belt: ['great belt','storebælt','storebalt','denmark'],
  taiwan_cp:  ['taiwan strait','pla','taiwan'],
  lombok:     ['lombok','vlcc','deep water passage'],
  sunda:      ['sunda','java','sumatra'],
};

// ── Main fetch ────────────────────────────────────────────────────────────────
async function fetchAll() {
  try {
    var c = localStorage.getItem(CACHE_KEY);
    var t = parseInt(localStorage.getItem(CACHE_TS) || '0');
    if (c && Date.now() - t < TTL) {
      data = JSON.parse(c);
      applyToGlobe();
      if (activeTab === 'gdelt') renderGdeltTab();
      // 'GDELT: from cache —', data.events.length, 'events');
      return;
    }
  } catch(e) {}


  // Try Netlify function first (no proxy, no CORS, server-side)
  var feedJson = null;
  try {
    var nRes = await fetch('/.netlify/functions/fetch-gdelt');
    if (nRes.ok) feedJson = await nRes.json();
  } catch(e) {}

  // Fallback to proxy chain if Netlify unavailable
  if (!feedJson || !feedJson.articles || !feedJson.articles.length) {
    await new Promise(function(r) { setTimeout(r, 5000); });
    feedJson = await safeFetch(makeUrl(
      '(supply chain OR shipping OR sanctions OR conflict OR war OR Houthi OR Suez OR Hormuz OR Russia OR China OR Iran OR semiconductor OR tariff OR embargo OR famine OR coup OR pipeline)',
      15, '48h'
    ));
  }
  var articles = (feedJson && feedJson.articles) || [];

  if (!articles.length) { applyToGlobe(); if (activeTab === 'gdelt') renderGdeltTab(); return; }

  data.events = [];
  data.tones  = {};
  data.chokeScores = {};
  var toneBuckets  = {};
  var chokeBuckets = {};

  await new Promise(function(resolve) {
    (window.requestIdleCallback || function(cb) { setTimeout(cb, 0); })(function() {
      articles.forEach(function(a, i) {
        var raw  = ((a.title || '') + ' ' + (a.url || '')).toLowerCase();
        var tone = parseFloat(a.tone || 0);
        if (i < 30) data.events.push(classifyArticle(a, i));

        Object.keys(COUNTRY_KEYS).forEach(function(code) {
          if (COUNTRY_KEYS[code].some(function(k) { return raw.indexOf(k) !== -1; })) {
            if (!toneBuckets[code]) toneBuckets[code] = [];
            toneBuckets[code].push(tone);
          }
        });
        Object.keys(CHOKE_KEYS).forEach(function(id) {
          if (CHOKE_KEYS[id].some(function(k) { return raw.indexOf(k) !== -1; })) {
            if (!chokeBuckets[id]) chokeBuckets[id] = { tones: [], titles: [] };
            chokeBuckets[id].tones.push(tone);
            if (chokeBuckets[id].titles.length < 3) chokeBuckets[id].titles.push(a.title || '');
          }
        });
      });
      resolve();
    });
  });

  // Sort events: humanitarian risk first (70%), economic risk second (30%)
  data.events.sort(function(a, b) { return b.plotPriority - a.plotPriority; });

  Object.keys(toneBuckets).forEach(function(code) {
    var tones = toneBuckets[code];
    data.tones[code] = { tone: tones.reduce(function(s, v) { return s + v; }, 0) / tones.length, count: tones.length };
  });
  Object.keys(chokeBuckets).forEach(function(id) {
    var b = chokeBuckets[id];
    if (b.tones.length) {
      var avg = b.tones.reduce(function(s, v) { return s + v; }, 0) / b.tones.length;
      data.chokeScores[id] = {
        score: Math.min(100, Math.round(b.tones.length * 5 + Math.abs(Math.min(0, avg)) * 3)),
        tone: avg, count: b.tones.length, headlines: b.titles
      };
    }
  });

  // Build AI context string
  var topEvts  = data.events.filter(function(e) { return e.severity === 'CRITICAL' || e.severity === 'WARNING'; }).slice(0, 5);
  var chokeStr = Object.keys(data.chokeScores).map(function(id) {
    var d2 = data.chokeScores[id];
    return '  ' + id.toUpperCase() + ': threat ' + d2.score + '/100, tone ' + d2.tone.toFixed(1) + ', ' + d2.count + ' articles';
  }).join('\n');
  var ctrStr = Object.keys(data.tones).map(function(c) {
    return '  ' + c + ': tone ' + data.tones[c].tone.toFixed(1) + ' (' + data.tones[c].count + ' articles)';
  }).join('\n');

  data.context = [
    'GDELT LIVE (' + new Date().toUTCString().slice(0, 16) + '):',
    'TOP ALERTS:\n' + (topEvts.map(function(e) { return '  • ' + e.title + ' [' + e.severity + ']'; }).join('\n') || '  none'),
    'CHOKEPOINT GDELT SCORES:\n' + (chokeStr || '  none'),
    'COUNTRY TONES:\n' + (ctrStr || '  none'),
  ].join('\n');

  var base = window._liveEventContext || '';
  window._liveEventContext = base ? base + '\n\n' + data.context : data.context;

  // Defer the ~150 KB GDELT serialization so it doesn't block applyToGlobe()
  window._lsWrite(CACHE_KEY, data);
  window._lsWrite(CACHE_TS, String(Date.now()));

  applyToGlobe();
  if (activeTab === 'gdelt') renderGdeltTab();
  console.log('GDELT: done —', data.events.length, 'events,', Object.keys(data.tones).length, 'country tones');
}

// ── Apply tones to globe markers ──────────────────────────────────────────────
function applyToGlobe() {
  var RISK_COLORS = { CRITICAL:'#ff0044', WARNING:'#ff9933', WATCH:'#ffcc00', LOW:'#00ff88' };
  var toneToRisk  = function(t) { return t < -9 ? 'CRITICAL' : t < -5 ? 'WARNING' : t < -2 ? 'WATCH' : 'LOW'; };
  var RANK        = { LOW:0, WATCH:1, WARNING:2, CRITICAL:3 };

  if (window.countryMarkers) {
    window.countryMarkers.forEach(function(mesh) {
      var td = data.tones[mesh.userData.code];
      if (!td) return;
      var gRisk = toneToRisk(td.tone);
      var sRisk = mesh.userData.risk || 'LOW';
      if (RANK[gRisk] > RANK[sRisk]) {
        mesh.material.color.set(RISK_COLORS[gRisk]);
        mesh.userData._gdeltRisk = gRisk;
        // Sync upgraded risk color to the InstancedMesh visual layer.
        if (window.ArgusCountriesInstanced) window.ArgusCountriesInstanced.updateColor(mesh.userData.code, RISK_COLORS[gRisk]);
      }
      mesh.userData._gdeltTone  = td.tone;
      mesh.userData._gdeltCount = td.count;
    });
  }
  if (window.chokepointMarkers) {
    window.chokepointMarkers.forEach(function(mesh) {
      var cs = data.chokeScores[mesh.userData.id];
      if (!cs) return;
      mesh.userData._gdeltThreat = cs.score;
      mesh.userData._gdeltTone   = cs.tone;
      mesh.userData._gdeltHeads  = cs.headlines;
      var cur  = mesh.userData._gdeltRisk || mesh.userData.risk || 'LOW';
      var nRisk = cs.score > 60 ? 'CRITICAL' : cs.score > 35 ? 'WARNING' : cur;
      if (RANK[nRisk] > RANK[cur]) { mesh.material.color.set(RISK_COLORS[nRisk]); mesh.userData._gdeltRisk = nRisk; }
    });
  }
}

// ── Render GDELT tab ──────────────────────────────────────────────────────────
function renderGdeltTab() {
  if (window.ArgusDataAge) ArgusDataAge.mark('data-age-events');
  var evList = document.getElementById('ev-list');
  if (!evList) return;
  evList.innerHTML = '';

  // Hydrate from localStorage if in-memory data hasn't loaded yet
  if (!data.events.length) {
    try {
      var cached = localStorage.getItem(CACHE_KEY);
      if (cached) { data = JSON.parse(cached); }
    } catch(e) {}
  }

  if (!data.events.length) {
    evList.innerHTML = '<div style="font-size:10px;color:#4a7da8;padding:12px 0;letter-spacing:1px">AWAITING GDELT FEED…</div>';
    return;
  }

  var badge = document.createElement('div');
  badge.style.cssText = 'font-size:8px;letter-spacing:2px;color:#00ccff;margin-bottom:4px;display:flex;align-items:center;gap:6px';
  badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#00ccff;display:inline-block;box-shadow:0 0 6px #00ccff"></span>GDELT 2.0 — ' + new Date().toUTCString().slice(0, 16).toUpperCase();
  evList.appendChild(badge);

  var sub = document.createElement('div');
  sub.style.cssText = 'font-size:10px;letter-spacing:1.5px;color:#4a9bb8;margin-bottom:10px;padding-left:12px;border-left:2px solid #00ccff44';
  sub.textContent = 'INTERNATIONAL NEWS';
  evList.appendChild(sub);

  var RC2 = { LOW:'#00ff88', WATCH:'#ffcc00', WARNING:'#ff9933', CRITICAL:'#ff0044' };
  var RB2 = { LOW:'rgba(0,255,136,0.07)', WATCH:'rgba(255,204,0,0.07)', WARNING:'rgba(255,153,51,0.09)', CRITICAL:'rgba(255,0,68,0.12)' };

  data.events.forEach(function(ev, idx) {
    var col  = RC2[ev.severity] || '#0099ff';
    var bg   = RB2[ev.severity] || 'transparent';
    var norm = Math.min(100, Math.max(0, 50 + ev.tone * 4));
    var tcol = ev.tone < -4 ? '#ff0044' : ev.tone < 0 ? '#ff9933' : '#00ff88';
    var div  = document.createElement('div');
    div.className = 'event-card';
    div.style.cssText = 'border-left-color:' + col + ';border-color:' + col + '44;background:' + bg +
      ';--card-i:' + idx;
    div.innerHTML =
      '<div class="event-card__row"><span class="event-card__type" style="color:' + col + '">' + ev.type + '</span>' +
        '<span class="event-card__type" style="color:' + col + '">' + ev.severity + (window.severityTrend ? window.severityTrend(ev) : "") + '</span></div>' +
      '<div class="event-card__title">' + ev.title + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
        (ev.country  ? '<span style="font-size:8px;letter-spacing:1px;color:#00ccff">◈ ' + ev.country + '</span>' : '') +
        (ev.seendate ? '<span style="font-size:8px;letter-spacing:1px;color:#4a7da8;margin-left:auto">' + ev.seendate + '</span>' : '') +
      '</div>' +
      '<div class="tone-bar-wrap"><div class="tone-bar" style="width:' + norm + '%;background:' + tcol + '"></div></div>' +
      '<div class="event-card__detail">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span class="gdelt-source">GDELT TONE ' + ev.tone.toFixed(2) + '</span>' +
          (window.hcBadge ? window.hcBadge(ev.title, ev.title) : '') +
        '</div>' +
        (ev.domain ? '<span style="display:block;margin-top:4px;font-size:8px;letter-spacing:1px;color:#4a6080">' + ev.domain + '</span>' : '') +
        '<a href="' + (ev.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" ' +
           'style="display:block;margin-top:5px;color:#0099ff;font-size:8px;letter-spacing:1px;text-decoration:underline;word-break:break-all">↗ SOURCE</a>' +
      '</div>';
    div.addEventListener('click', function() { div.classList.toggle('is-open'); });
    evList.appendChild(div);
  });

  if (typeof window.updateNodeCounts === 'function') window.updateNodeCounts();
  var fc = document.getElementById('ev-feed-count');
  if (fc) fc.textContent = data.events.length;
}

// ── Tab switch ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  var newsTab     = document.getElementById('tab-news');
  var gdeltTab    = document.getElementById('tab-gdelt');
  var disasterTab = document.getElementById('tab-disaster');
  if (newsTab)     { newsTab.className     = 'feed-tab' + (tab === 'news'     ? ' is-news-active'     : ''); }
  if (gdeltTab)    { gdeltTab.className    = 'feed-tab' + (tab === 'gdelt'    ? ' is-gdelt-active'    : ''); }
  if (disasterTab) { disasterTab.className = 'feed-tab' + (tab === 'disaster' ? ' is-disaster-active' : ''); }

  if (tab === 'gdelt') {
    renderGdeltTab();
  } else if (tab === 'disaster') {
    renderDisasterTab();
  } else {
    try {
      var c = localStorage.getItem('argus_live_events_v2');
      if (c) { window.renderEvents(JSON.parse(c), true); return; }
    } catch(e) {}
    var evList = document.getElementById('ev-list');
    if (evList) evList.innerHTML = '<div style="font-size:10px;color:#4a7da8;padding:12px 0;letter-spacing:1px">AWAITING NEWS FEED…</div>';
  }
}

// Boot: 4s delay then refresh every 15 min
setTimeout(fetchAll, 4000);
setInterval(function () { if (!document.hidden) fetchAll(); }, TTL);

// ── DISASTER tab — NOAA severe weather fetch ──────────────────────────────────
(function loadNOAA() {
  var URL      = 'https://api.weather.gov/alerts/active?limit=50';
  var CACHE_K  = 'argus_noaa_v2';
  var CACHE_T  = 'argus_noaa_ts_v2';
  var TTL_MS   = 30 * 60 * 1000; // 30 min — weather events stable enough for strategic view
  try {
    var cached = localStorage.getItem(CACHE_K);
    var ts     = parseInt(localStorage.getItem(CACHE_T) || '0');
    if (cached && Date.now() - ts < TTL_MS) { window._noaaEvents = JSON.parse(cached); return; }
  } catch(e) {}
  fetch(URL, { headers: { 'Accept': 'application/geo+json', 'User-Agent': 'ArgusIntelligence/1.0 (contact@argus.app)' } })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(data) {
    if (!data || !data.features) return;
    var events = data.features.slice(0, 15).map(function(f, i) {
      var p   = f.properties || {};
      var sev = p.severity === 'Extreme' ? 'CRITICAL' : p.severity === 'Severe' ? 'WARNING' : 'WATCH';
      return {
        id: 9800 + i,
        type: 'DISASTER',
        severity: sev,
        title: (p.event || 'Weather Alert') + (p.areaDesc ? ' — ' + p.areaDesc.split(';')[0] : ''),
        impact: p.description ? p.description.slice(0, 180) + '…' : (p.headline || ''),
        region: p.areaDesc ? p.areaDesc.split(';')[0].trim() : 'USA',
        pubDate: p.effective ? new Date(p.effective).toUTCString().slice(0,22) : '',
        source: 'NOAA',
        link: p['@id'] || '',
        lat: null, lon: null,
        plotPriority: sev === 'CRITICAL' ? 85 : sev === 'WARNING' ? 55 : 30,
      };
    });
    window._noaaEvents = events;
    try { localStorage.setItem(CACHE_K, JSON.stringify(events)); localStorage.setItem(CACHE_T, String(Date.now())); } catch(e) {}
    if (activeTab === 'disaster') renderDisasterTab();
  })
  .catch(function() {});
})();


// ── NASA FIRMS — Active Wildfire Data ────────────────────────────────────────
// MODIS/VIIRS active fire detections updated every 24h, global coverage
(function loadWildfires() {
  var CACHE_K = 'argus_firms_v2', CACHE_T = 'argus_firms_ts_v2';
  var TTL = 4 * 60 * 60 * 1000; // 4 hours — MODIS/VIIRS revisit cadence
  try {
    var cached = localStorage.getItem(CACHE_K);
    var ts = parseInt(localStorage.getItem(CACHE_T) || '0');
    if (cached && Date.now() - ts < TTL) {
      window._fireEvents = JSON.parse(cached);
      if (typeof activeTab !== 'undefined' && activeTab === 'disaster') renderDisasterTab();
      return;
    }
  } catch(e) {}

  var canUseBackend = window.location.protocol !== 'file:';

  if (canUseBackend) {
    // Use Netlify function — server-side, no CORS issues, uses FIRMS_MAP_KEY env var
    fetch('/.netlify/functions/fetch-firms')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(res) {
      if (!res || !res.data || !res.data.length) throw new Error('No data from fetch-firms');
      // Translate clusters into event format expected by downstream consumers
      var events = res.data.slice(0, 20).map(function(g, i) {
        var sev = g.count > 50 ? 'CRITICAL' : g.count > 15 ? 'WARNING' : 'WATCH';
        return {
          id: 9850 + i,
          type: 'WILDFIRE',
          severity: sev,
          title: 'Active Fire Cluster — ' + g.count + ' detections (' + g.lat.toFixed(1) + '\u00b0, ' + g.lon.toFixed(1) + '\u00b0)',
          impact: 'NASA VIIRS satellite fire detections in past 24h. ' + g.count + ' hotspots in cluster.',
          region: '',
          pubDate: res.ts ? res.ts.slice(0, 10) : '',
          source: 'NASA FIRMS',
          link: 'https://firms.modaps.eosdis.nasa.gov/map/',
          lat: g.lat, lon: g.lon,
          plotPriority: sev === 'CRITICAL' ? 82 : sev === 'WARNING' ? 52 : 28,
        };
      }).sort(function(a, b) { return b.plotPriority - a.plotPriority; });

      window._fireEvents = events;
      try { localStorage.setItem(CACHE_K, JSON.stringify(events)); localStorage.setItem(CACHE_T, String(Date.now())); } catch(e) {}
      console.log('NASA FIRMS via Netlify: ' + events.length + ' fire clusters loaded');
      if (typeof activeTab !== 'undefined' && activeTab === 'disaster') renderDisasterTab();
    })
    .catch(function(e) { console.warn('FIRMS Netlify fetch failed:', e.message); });
    return;
  }

  // Fallback: third-party proxy chain (GitHub Pages / non-Netlify environments)
  // NASA FIRMS CSV — VIIRS SNPP last 24h, world
  // Direct fetch is CORS-blocked on desktop. Use proxy chain.
  var firmsUrl = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';
  // corsproxy.io returns 413 (payload too large) and allorigins CORS-blocks this file.
  // thingproxy handles large payloads; codetabs is the fallback.
  var proxies = [
    'https://thingproxy.freeboard.io/fetch/' + firmsUrl,
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(firmsUrl),
  ];

  function tryProxy(idx) {
    if (idx >= proxies.length) { console.warn('FIRMS: all proxies failed'); return; }
    fetch(proxies[idx])
    .then(function(r) { return r.ok ? r.text() : Promise.reject('HTTP ' + r.status); })
    .then(function(csv) {
      if (!csv || csv.indexOf(',') === -1) return tryProxy(idx + 1);
      handleCSV(csv);
    })
    .catch(function() { tryProxy(idx + 1); });
  }
  tryProxy(0);

  function handleCSV(csv) {
    var rows = csv.trim().split('\n');
    var headers = rows[0].split(',');
    var latIdx  = headers.indexOf('latitude');
    var lonIdx  = headers.indexOf('longitude');
    var brightIdx = headers.indexOf('bright_ti4');
    var confIdx = headers.indexOf('confidence');
    var dateIdx = headers.indexOf('acq_date');

    // Group detections by 2-degree grid cells to cluster nearby fires
    var grid = {};
    rows.slice(1).forEach(function(row) {
      var cols = row.split(',');
      var lat  = parseFloat(cols[latIdx]);
      var lon  = parseFloat(cols[lonIdx]);
      var conf = cols[confIdx] || '';
      if (isNaN(lat) || isNaN(lon)) return;
      if (conf === 'l') return; // skip low confidence
      var key = Math.round(lat / 2) + ',' + Math.round(lon / 2);
      if (!grid[key]) grid[key] = { lat: lat, lon: lon, count: 0, date: cols[dateIdx] || '' };
      grid[key].count++;
    });

    var events = Object.keys(grid).slice(0, 20).map(function(k, i) {
      var g   = grid[k];
      var sev = g.count > 50 ? 'CRITICAL' : g.count > 15 ? 'WARNING' : 'WATCH';
      return {
        id: 9850 + i,
        type: 'WILDFIRE',
        severity: sev,
        title: 'Active Fire Cluster — ' + g.count + ' detections (' + g.lat.toFixed(1) + '°, ' + g.lon.toFixed(1) + '°)',
        impact: 'NASA VIIRS satellite fire detections in past 24h. ' + g.count + ' hotspots in cluster.',
        region: '',
        pubDate: g.date,
        source: 'NASA FIRMS',
        link: 'https://firms.modaps.eosdis.nasa.gov/map/',
        lat: g.lat, lon: g.lon,
        plotPriority: sev === 'CRITICAL' ? 82 : sev === 'WARNING' ? 52 : 28,
      };
    }).sort(function(a, b) { return b.plotPriority - a.plotPriority; });

    window._fireEvents = events;
    try { localStorage.setItem(CACHE_K, JSON.stringify(events)); localStorage.setItem(CACHE_T, String(Date.now())); } catch(e) {}
    console.log('NASA FIRMS: ' + events.length + ' fire clusters loaded');
    if (typeof activeTab !== 'undefined' && activeTab === 'disaster') renderDisasterTab();
  }
})();

// ── NHC Active Storms — NOAA National Hurricane Center RSS — free, no key ────
(function loadStorms() {
  var CACHE_K = 'argus_nhc_v1', CACHE_T = 'argus_nhc_ts_v1';
  var TTL = 30 * 60 * 1000; // 30 min
  try {
    var cached = localStorage.getItem(CACHE_K);
    var ts = parseInt(localStorage.getItem(CACHE_T) || '0');
    if (cached && Date.now() - ts < TTL) {
      window._stormEvents = JSON.parse(cached);
      if (typeof activeTab !== 'undefined' && activeTab === 'disaster') renderDisasterTab();
      return;
    }
  } catch(e) {}

  // NHC Atlantic + Pacific active storm advisories RSS
  var feeds = [
    'https://www.nhc.noaa.gov/index-at.xml',   // Atlantic
    'https://www.nhc.noaa.gov/index-ep.xml',   // East Pacific
  ];

  var allStorms = [];
  var done = 0;

  feeds.forEach(function(feedUrl, fi) {
    fetch('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(feedUrl))
    .then(function(r) { return r.ok ? r.text() : null; })
    .then(function(xml) {
      if (xml) {
        // Parse storm titles and descriptions from RSS
        var items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        items.forEach(function(item, i) {
          var title   = (item.match(/<title>([\s\S]*?)<\/title>/)   || [])[1] || '';
          var desc    = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
          var link    = (item.match(/<link>([\s\S]*?)<\/link>/)     || [])[1] || '';
          title = title.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
          desc  = desc.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
          if (!title || title.toLowerCase().includes('national hurricane')) return;
          var isHurricane = /hurricane/i.test(title);
          var isTropical  = /tropical storm/i.test(title);
          var sev = isHurricane ? 'CRITICAL' : isTropical ? 'WARNING' : 'WATCH';
          allStorms.push({
            id: 9870 + fi * 10 + i,
            type: 'TROPICAL STORM',
            severity: sev,
            title: title.slice(0, 100),
            impact: desc.slice(0, 200),
            region: fi === 0 ? 'Atlantic' : 'East Pacific',
            pubDate: '',
            source: 'NOAA NHC',
            link: link,
            lat: null, lon: null,
            plotPriority: sev === 'CRITICAL' ? 88 : sev === 'WARNING' ? 58 : 32,
          });
        });
      }
      done++;
      if (done === feeds.length) {
        window._stormEvents = allStorms;
        try { localStorage.setItem(CACHE_K, JSON.stringify(allStorms)); localStorage.setItem(CACHE_T, String(Date.now())); } catch(e) {}
        console.log('NHC storms: ' + allStorms.length + ' advisories loaded');
        if (typeof activeTab !== 'undefined' && activeTab === 'disaster') renderDisasterTab();
      }
    })
    .catch(function() { done++; });
  });
})();

// ── renderDisasterTab — aggregates all disaster sources ───────────────────────
function renderDisasterTab() {
  var evList = document.getElementById('ev-list');
  if (!evList) return;

  var usgs   = window._usgsEvents    || [];
  var rw     = window._rwCrisisEvents || [];
  var noaa   = window._noaaEvents    || [];
  var fires  = window._fireEvents    || [];
  var storms = window._stormEvents   || [];

  // Map GDACS from _rwData into ev format
  var gdacs = [];
  if (window._rwData) {
    Object.keys(window._rwData).forEach(function(iso, i) {
      var entry = window._rwData[iso];
      if (!entry.disasters || !entry.disasters.length) return;
      entry.disasters.forEach(function(d, j) {
        gdacs.push({
          id: 9700 + i * 10 + j,
          type: 'DISASTER',
          severity: d.sev || 'WATCH',
          title: (d.name || 'Disaster') + ' — ' + iso,
          impact: 'Active GDACS disaster. Types: ' + (d.types ? d.types.join(', ') : 'Unknown'),
          region: iso,
          pubDate: '',
          source: 'GDACS',
          link: '',
          lat: null, lon: null,
          plotPriority: d.sev === 'CRITICAL' ? 80 : d.sev === 'WARNING' ? 50 : 25,
        });
      });
    });
  }

  var all = usgs.concat(rw).concat(gdacs).concat(noaa).concat(fires).concat(storms);
  all.sort(function(a, b) { return b.plotPriority - a.plotPriority; });

  evList.innerHTML = '';
  // Header badge
  var hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:8px;letter-spacing:2px;color:#ff9900;margin-bottom:8px;display:flex;align-items:center;gap:6px';
  hdr.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#ff9900;display:inline-block;box-shadow:0 0 6px #ff9900"></span>DISASTERS & WEATHER — ' + all.length + ' ACTIVE';
  evList.appendChild(hdr);

  if (!all.length) {
    evList.innerHTML += '<div style="font-size:10px;color:#4a7da8;padding:20px 0;text-align:center;letter-spacing:1px;">NO ACTIVE ALERTS</div>';
    return;
  }

  if (window.renderEvents) {
    window.renderEvents(all, false);
    // Re-stamp header since renderEvents clears the list
    evList.insertBefore(hdr, evList.firstChild);
  }
}
window.renderDisasterTab = renderDisasterTab;

return { switchTab: switchTab, getData: function() { return data; } };

})(); // end gdelt
