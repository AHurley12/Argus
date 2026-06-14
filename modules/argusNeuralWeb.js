/* ── ArgusNeuralWeb v2 ───────────────────────────────────────────────────────
   3-layer architecture preserved. New in v2:
   • Trigger-verb Relationship Scanner (causality / correlation / dependency)
   • Entity nodes (Country, Company, Person) + Signal nodes (Market, Supply)
   • Typed edges rendered with distinct colors/dash patterns
   • Intelligence panel: tabbed Inspector | Timeline | Notes
   • Export engine: JSON graph + Markdown for Obsidian
   • Purple aesthetic throughout; visibility-saving logic unchanged.
────────────────────────────────────────────────────────────────────────────── */
window.ArgusNeuralWeb = (function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — DATA: Normalization + Indexed Store
// ═══════════════════════════════════════════════════════════════════════════════

var VALID_TYPES  = { CONFLICT:1, POLICY:1, DISASTER:1, ECONOMIC:1, HUMANITARIAN:1, SUPPLY_CHAIN:1, HUMAN_RIGHTS:1, TENSION:1 };
var VALID_RISKS  = { CRITICAL:1, WARNING:1, WATCH:1, LOW:1 };
var RISK_WEIGHTS = { CRITICAL:4, WARNING:3, WATCH:2, LOW:1 };

// Normalised store — populated by ingestEvents()
var store = {
  events:      [],                    // all normalised events
  byCountry:   new Map(),             // country → Event[]
  byType:      new Map(),             // type    → Event[]
  byRisk:      new Map(),             // risk    → Event[]
  lastIngested: 0,
};

// --- 1.1 normalizeEvent ---
function normalizeEvent(raw, idx) {
  var title   = (raw.title  || '').slice(0, 120).trim();
  if (!title) return null;

  var type = (raw.type || '').toUpperCase().replace(/[-\s]/g, '_');
  if (!VALID_TYPES[type]) type = 'POLICY';

  var risk = (raw.severity || raw.risk || 'LOW').toUpperCase();
  if (!VALID_RISKS[risk]) risk = 'LOW';

  var country = '';
  if (raw.region)      country = raw.region.trim();
  else if (raw.country) country = String(raw.country).trim();
  // Normalise to title-case
  country = country.replace(/\b\w/g, function(c){ return c.toUpperCase(); });

  var ts = 0;
  if (raw.pubDate) {
    try { ts = new Date(raw.pubDate.replace(' ','T') + 'Z').getTime(); } catch(_){}
  }
  if (!ts || isNaN(ts)) ts = Date.now() - (idx * 60000); // stagger fallback

  // Extract keywords from title+impact text
  var text  = title + ' ' + (raw.impact || '') + ' ' + (raw.description || '');
  var keywords = extractKeywords(text);

  return {
    id:        'ev_' + (raw.id || idx),
    country:   country,
    type:      type,
    risk:      risk,
    timestamp: ts,
    title:     title,
    impact:    raw.impact || '',
    source:    raw.source || '',
    keywords:  keywords,
    _raw:      raw,
  };
}

var STOP_WORDS = /^(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|man|new|now|old|see|two|way|who|boy|did|its|let|put|say|she|too|use|with|that|this|from|they|will|been|have|more|when|than|what|were|also|into|over|such|then|thus|upon|very|just|each|much|both|some|yet|said|even|well|back|take|make|come|work|only|year|most|may|might|could|would|should|have|into)$/i;

function extractKeywords(text) {
  var words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w){ return w.length > 3 && !STOP_WORDS.test(w); });

  // Deduplicate + take top 8 by frequency
  var freq = {};
  words.forEach(function(w){ freq[w] = (freq[w] || 0) + 1; });
  return Object.keys(freq)
    .sort(function(a,b){ return freq[b] - freq[a]; })
    .slice(0, 8);
}

// --- 1.2 Index population (incremental) ---
function addToIndex(map, key, event) {
  if (!key) return;
  var arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(event);
}

function ingestEvents(rawEvents) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) return;

  // Reset store on full ingest
  store.events     = [];
  store.byCountry  = new Map();
  store.byType     = new Map();
  store.byRisk     = new Map();

  rawEvents.forEach(function(raw, i) {
    var ev = normalizeEvent(raw, i);
    if (!ev) return;
    store.events.push(ev);
    addToIndex(store.byCountry, ev.country, ev);
    addToIndex(store.byType,    ev.type,    ev);
    addToIndex(store.byRisk,    ev.risk,    ev);
  });

  store.lastIngested = Date.now();
}

// Pull latest events from the live window globals
// _usgsEvents (seismic) is intentionally excluded here — seismic is noise for
// intelligence analysis and surfaces in the DISASTERS tab instead.
function refreshStore() {
  var sources = [];
  if (window._currentEvents  && window._currentEvents.length)  sources = sources.concat(window._currentEvents);
  if (window._noaaEvents     && window._noaaEvents.length)     sources = sources.concat(window._noaaEvents);
  if (window._rwCrisisEvents && window._rwCrisisEvents.length) sources = sources.concat(window._rwCrisisEvents);
  if (window._fireEvents     && window._fireEvents.length)     sources = sources.concat(window._fireEvents);
  if (!sources.length) sources = window.FALLBACK_EVENTS || [];
  ingestEvents(sources);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2 — STATE: Reactive Store
// ═══════════════════════════════════════════════════════════════════════════════

var state = {
  selectedCountry: null,
  filters: {
    types:     new Set(['CONFLICT','POLICY','DISASTER','ECONOMIC','HUMANITARIAN','SUPPLY_CHAIN','HUMAN_RIGHTS','TENSION']),
    risks:     new Set(['CRITICAL','WARNING','WATCH','LOW']),
    timeRange: '7d',
  },
  graph: { nodes: [], edges: [] },
  _prevGraphKey: '',    // for diff detection
  linkMode:    { active: false, sourceNode: null },
  manualEdges: [],      // user-created edges (persist across rebuilds)
  builderType: 'events',
  selectedChokepoint: null,  // id of chokepoint selected for vessel drill-down
  analyticsTimeRange: '24h', // '1h' | '24h' | '7d'
};

// --- 2.1 Controlled state mutations ---
function setCountry(country) {
  state.selectedCountry = country;
  rebuildGraph();
}

function updateFilters(partial) {
  if (partial.types)     state.filters.types     = new Set(partial.types);
  if (partial.risks)     state.filters.risks      = new Set(partial.risks);
  if (partial.timeRange) state.filters.timeRange  = partial.timeRange;
  rebuildGraph();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3A — GRAPH ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

var TIME_MS = { '1d': 86400000, '7d': 604800000, '30d': 2592000000, 'all': Infinity };

// --- 3.2 Filtered event retrieval (O(1) country index + O(k) filter) ---
function getFilteredEvents() {
  // If no country selected, return empty (graph is always country-centric)
  if (!state.selectedCountry) return [];

  // Step 1: pull by country index O(1)
  var events = store.byCountry.get(state.selectedCountry) || [];

  var cutoff  = Date.now() - (TIME_MS[state.filters.timeRange] || Infinity);
  var types   = state.filters.types;
  var risks   = state.filters.risks;

  // Step 2+3: filter by type, risk, time — single pass
  return events.filter(function(ev) {
    return types.has(ev.type) && risks.has(ev.risk) && ev.timestamp >= cutoff;
  });
}

var MAX_NODES = 40;

// --- 3.3 Node construction ---
function buildNodes(events) {
  var nodes = [];

  // ONE central country node
  var countryData = (window.COUNTRIES_DATA || []).find(function(c){
    return c.label === state.selectedCountry || c.code === state.selectedCountry;
  });
  nodes.push({
    id:      'country:' + state.selectedCountry,
    type:    'country',
    label:   state.selectedCountry,
    risk:    countryData ? countryData.risk : 'WATCH',
    data:    countryData || null,
  });

  // Build topic clusters from shared keywords
  var topicMap = {};
  events.forEach(function(ev) {
    (ev.keywords || []).forEach(function(kw) {
      if (!topicMap[kw]) topicMap[kw] = { count: 0, events: [] };
      topicMap[kw].count++;
      topicMap[kw].events.push(ev.id);
    });
  });

  // Top 5 keywords that appear in ≥2 events = topic nodes
  var topTopics = Object.keys(topicMap)
    .filter(function(k){ return topicMap[k].count >= 2; })
    .sort(function(a,b){ return topicMap[b].count - topicMap[a].count; })
    .slice(0, 5);

  topTopics.forEach(function(kw) {
    nodes.push({
      id:     'topic:' + kw,
      type:   'topic',
      label:  kw,
      count:  topicMap[kw].count,
      evIds:  topicMap[kw].events,
    });
  });

  // Event nodes
  var topicSet = new Set(topTopics);
  events.forEach(function(ev) {
    nodes.push({
      id:        ev.id,
      type:      'event',
      risk:      ev.risk,
      eventType: ev.type,
      label:     ev.title,
      timestamp: ev.timestamp,
      impact:    ev.impact,
      source:    ev.source,
      keywords:  ev.keywords,
      topics:    (ev.keywords || []).filter(function(k){ return topicSet.has(k); }),
      _ev:       ev,
    });
  });

  return limitNodes(nodes, MAX_NODES);
}

// --- 3.4 Edge construction (typed) ---
function buildEdges(nodes, events) {
  var edges = [];
  var nodeIds = new Set(nodes.map(function(n){ return n.id; }));
  var countryId = 'country:' + state.selectedCountry;

  nodes.forEach(function(n) {
    if (n.type === 'event' || n.type === 'entity' || n.type === 'signal') {
      // Country → node (structural edge)
      edges.push({ source: countryId, target: n.id, weight: RISK_WEIGHTS[n.risk] || 1, edgeType: 'country' });
      // Event → Topic
      (n.topics || []).forEach(function(kw) {
        var tid = 'topic:' + kw;
        if (nodeIds.has(tid)) edges.push({ source: n.id, target: tid, weight: 0.5, edgeType: 'topic' });
      });
    }
  });

  // Relationship edges are added by scanRelationships() and stored in state.relEdges
  (state.relEdges || []).forEach(function(e) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) edges.push(e);
  });

  // Manual edges — user-created links (survive rebuildGraph)
  (state.manualEdges || []).forEach(function(e) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) edges.push(e);
  });

  return edges;
}

// ── Scan corpus builder — aggregates ALL available text sources ───────────────
function buildScanCorpus() {
  var corpus = [], seen = new Set();
  function add(title, impact, type, risk, ts) {
    var key = (title || '').slice(0, 50);
    if (!key || seen.has(key)) return;
    seen.add(key);
    corpus.push({
      text:  ((title || '') + ' ' + (impact || '')).toLowerCase(),
      title: title || '',
      type:  type  || 'POLICY',
      risk:  risk  || 'LOW',
      ts:    ts    || 0,
    });
  }
  // 1. Current graph event nodes
  state.graph.nodes
    .filter(function(n){ return n.type === 'event'; })
    .forEach(function(n){ add(n.label, n.impact||'', n.eventType, n.risk, n.timestamp); });
  // 2. All store events
  store.events.forEach(function(ev){ add(ev.title, ev.impact, ev.type, ev.risk, ev.timestamp); });
  // 3. Window globals
  [].concat(
    window._currentEvents  || [],
    window._usgsEvents     || [],
    window._noaaEvents     || [],
    window._rwCrisisEvents || [],
    window._fireEvents     || [],
    window.FALLBACK_EVENTS || []
  ).forEach(function(ev) {
    if (!ev) return;
    add(ev.title||ev.name||'', ev.impact||ev.description||'', ev.type||ev.eventType||'POLICY', ev.severity||ev.risk||'LOW', 0);
  });
  // 4. GDELT localStorage (rich article text corpus)
  try {
    var gc = localStorage.getItem('argus_gdelt_v3');
    if (gc) {
      var gd = JSON.parse(gc);
      var arts = Array.isArray(gd) ? gd : (gd.events || gd.articles || []);
      (Array.isArray(arts) ? arts : []).slice(0, 50).forEach(function(a) {
        var t = a.title || a.TITLE || a.name || '';
        if (t) add(t, a.sourceurl||a.url||'', 'POLICY', 'WATCH', 0);
      });
    }
  } catch(_){}
  return corpus;
}

// ── RELATIONSHIP SCANNER — comprehensive multi-source analysis ────────────────
function scanRelationships() {
  var btn = document.getElementById('btn-nw-scan');
  if (btn) { btn.classList.add('is-scanning'); btn.textContent = '⟳ SCANNING…'; }

  refreshStore();

  // Defer CPU work so the button-state paint happens before the loop starts.
  // No Web Worker needed at MAX_NODES = 40 — setTimeout(0) is sufficient.
  setTimeout(function() {
  var _scanT0 = performance.now();

  var corpus    = buildScanCorpus();
  var allTextL  = corpus.map(function(c){ return c.text; }).join(' ');
  var relEdges  = [];
  var newNodes  = [];
  var newNodeIds = new Set(state.graph.nodes.map(function(n){ return n.id; }));

  // Working event set: current graph nodes + corpus injection for selected country
  var evNodes = state.graph.nodes.filter(function(n){ return n.type === 'event'; }).slice();

  // AGGRESSIVE: inject corpus items that mention selected country and aren't already nodes
  if (state.selectedCountry) {
    var cLower = state.selectedCountry.toLowerCase();
    corpus.forEach(function(c, i) {
      if (evNodes.length >= 28 || !c.title) return;
      if (c.text.indexOf(cLower) === -1 && c.text.indexOf(cLower.split(' ')[0]) === -1) return;
      var nid = 'ev_scan_' + i;
      if (newNodeIds.has(nid)) return;
      var sn = {
        id: nid, type: 'event', eventType: c.type, risk: c.risk,
        label: c.title.slice(0, 80), impact: '', source: 'scan',
        keywords: extractKeywords(c.text),
        timestamp: c.ts || (Date.now() - i * 3600000),
        _ev: { timestamp: c.ts || 0, type: c.type, risk: c.risk, title: c.title },
        _injected: true,
      };
      newNodes.push(sn);
      newNodeIds.add(nid);
      evNodes.push(sn);
    });
  }

  function textOf(n) { return ((n.label||'') + ' ' + (n.impact||'')).toLowerCase(); }

  // Pre-compute per-node text strings and keyword Sets once.
  // Avoids re-running textOf() and O(k) indexOf inside every pair comparison.
  var _textCache = evNodes.map(function(n) { return textOf(n); });
  var _kwSets    = evNodes.map(function(n) {
    var s = new Set();
    (n.keywords || []).forEach(function(k) { if (k.length > 4) s.add(k); });
    return s;
  });

  // 1. Event ↔ Event relationship detection (shared keywords → correlation minimum)
  for (var i = 0; i < evNodes.length; i++) {
    var a = evNodes[i]; var ta = _textCache[i];
    for (var j = i + 1; j < evNodes.length; j++) {
      var b = evNodes[j]; var tb = _textCache[j];
      var edgeType = null;

      // Set.has() is O(1) vs indexOf O(k) — measurable at 40 nodes × 8 keywords
      var sharedKws = (a.keywords || []).filter(function(k) {
        return k.length > 4 && _kwSets[j].has(k);
      });
      if (sharedKws.length) {
        var combined = ta + ' ' + tb;
        if (CAUSALITY_VERBS.some(function(v){ return combined.indexOf(v) !== -1; }))     edgeType = 'causality';
        else if (DEPENDENCY_VERBS.some(function(v){ return combined.indexOf(v) !== -1; })) edgeType = 'dependency';
        else edgeType = 'correlation';
      }

      // Fallback: B's keywords in A's text
      if (!edgeType) {
        var aKws = (b.keywords || []).filter(function(k){ return k.length > 3 && ta.indexOf(k) !== -1; });
        if (aKws.length) {
          if (CAUSALITY_VERBS.some(function(v){ return ta.indexOf(v) !== -1; }))     edgeType = 'causality';
          else if (DEPENDENCY_VERBS.some(function(v){ return ta.indexOf(v) !== -1; })) edgeType = 'dependency';
          else edgeType = 'correlation';
        }
      }

      if (edgeType) {
        // Phase 5 — Correlation accuracy: boost weight based on time proximity + geographic co-location
        var baseWeight = 2;

        // Signal 3: Time proximity — events within 7 days of each other are more likely causally linked
        if (a.timestamp && b.timestamp) {
          var tDeltaDays = Math.abs(a.timestamp - b.timestamp) / 86400000;
          if (tDeltaDays <= 1)  baseWeight += 0.8;  // same-day: strongest signal
          else if (tDeltaDays <= 3) baseWeight += 0.5;  // within 3 days
          else if (tDeltaDays <= 7) baseWeight += 0.2;  // within a week
        }

        // Signal 1: Shared geography — both texts mention the same country not already selected
        // Use window.COUNTRIES_DATA directly — _nwCountries is assigned later in this closure
        var aCountries = [], bCountries = [];
        (window.COUNTRIES_DATA || []).forEach(function(cd) {
          var lbl = cd.label.toLowerCase();
          if (state.selectedCountry && lbl === state.selectedCountry.toLowerCase()) return;
          if (lbl.length < 4) return;
          if (ta.indexOf(lbl) !== -1) aCountries.push(lbl);
          if (tb.indexOf(lbl) !== -1) bCountries.push(lbl);
        });
        var sharedGeo = aCountries.filter(function(c){ return bCountries.indexOf(c) !== -1; }).length;
        if (sharedGeo > 0) baseWeight += Math.min(0.6, sharedGeo * 0.2);  // Signal 1: shared geography

        // Signal 4: Shared infrastructure — both texts mention transport/supply keywords
        var INFRA_KWS = ['pipeline','port','strait','canal','corridor','railroad','lng','tanker','chokepoint','shipping'];
        var aInfra = INFRA_KWS.filter(function(k){ return ta.indexOf(k) !== -1; });
        var bInfra = INFRA_KWS.filter(function(k){ return tb.indexOf(k) !== -1; });
        var sharedInfra = aInfra.filter(function(k){ return bInfra.indexOf(k) !== -1; }).length;
        if (sharedInfra > 0) baseWeight += Math.min(0.4, sharedInfra * 0.2);  // Signal 4: infrastructure

        relEdges.push({ source: a.id, target: b.id, weight: Math.min(4, parseFloat(baseWeight.toFixed(1))), edgeType: edgeType, detected: true });
      }
    }
  }

  // 2. Entity extraction from full corpus
  KNOWN_COMPANIES.forEach(function(co) {
    if (allTextL.indexOf(co) === -1) return;
    var nid = 'entity:co:' + co;
    if (newNodeIds.has(nid)) return;
    newNodes.push({ id: nid, type: 'entity', entityType: 'company', label: co.charAt(0).toUpperCase() + co.slice(1), risk: 'LOW' });
    newNodeIds.add(nid);
    evNodes.forEach(function(en) {
      if (textOf(en).indexOf(co) !== -1)
        relEdges.push({ source: en.id, target: nid, weight: 1, edgeType: 'dependency', detected: true });
    });
  });

  // 2b. Country extraction — chunked (25 per tick) to avoid LONG_TASK on 195-entry loop.
  // _signalsAndFinalize() runs after the last chunk completes.
  var _nwCountries = window.COUNTRIES_DATA || [];
  var NW_COUNTRY_CHUNK = 25;

  function _processCountriesChunk(start) {
    var end = Math.min(start + NW_COUNTRY_CHUNK, _nwCountries.length);
    for (var ci = start; ci < end; ci++) {
      var cd = _nwCountries[ci];
      var lbl = cd.label.toLowerCase();
      if (state.selectedCountry && lbl === state.selectedCountry.toLowerCase()) continue;
      if (allTextL.indexOf(lbl) === -1) continue;
      var nid = 'entity:country:' + cd.code;
      if (newNodeIds.has(nid)) continue;
      newNodes.push({ id: nid, type: 'entity', entityType: 'country', label: cd.label, risk: cd.risk || 'LOW' });
      newNodeIds.add(nid);
      evNodes.forEach(function(en) {
        if (textOf(en).indexOf(lbl) !== -1)
          relEdges.push({ source: en.id, target: nid, weight: 1.5, edgeType: 'correlation', detected: true });
      });
    }

    if (end < _nwCountries.length) {
      if (window.ArgusSchedulerAudit) window.ArgusSchedulerAudit.yieldedTasks++;
      setTimeout(function() { _processCountriesChunk(end); }, 0);
    } else {
      _signalsAndFinalize();
    }
  }

  function _signalsAndFinalize() {
  // 3. Signal nodes — text corpus + live market data telemetry
  var mktHits = MARKET_SIGNALS.filter(function(s){ return allTextL.indexOf(s) !== -1; });
  if (window._eiaData  && window._eiaData.brent  && window._eiaData.brent  > 85)    mktHits.push('brent $' + window._eiaData.brent.toFixed(0));
  var _vixEl = document.getElementById('vix-val'); var _vixV = _vixEl ? parseFloat(_vixEl.textContent) : NaN;
  if (!isNaN(_vixV) && _vixV > 30) mktHits.push('vix ' + _vixV.toFixed(1));
  if (window._fredData && window._fredData.yield10y2y !== null && window._fredData.yield10y2y < 0) mktHits.push('inverted yield');
  if (mktHits.length) {
    var mnid = 'signal:market';
    if (!newNodeIds.has(mnid)) {
      newNodes.push({ id: mnid, type: 'signal', signalType: 'market', label: 'MARKET SIGNAL', keywords: mktHits.slice(0,5), risk: 'WATCH' });
      newNodeIds.add(mnid);
      evNodes.forEach(function(en) {
        var etl = textOf(en);
        if (mktHits.some(function(s){ return etl.indexOf(s.split(' ')[0]) !== -1; }))
          relEdges.push({ source: en.id, target: mnid, weight: 2, edgeType: 'correlation', detected: true });
      });
    }
  }

  var supHits = SUPPLY_SIGNALS.filter(function(s){ return allTextL.indexOf(s) !== -1; });
  if (supHits.length) {
    var snid = 'signal:supply';
    if (!newNodeIds.has(snid)) {
      newNodes.push({ id: snid, type: 'signal', signalType: 'supply', label: 'SUPPLY SHOCK', keywords: supHits.slice(0,5), risk: 'WARNING' });
      newNodeIds.add(snid);
      evNodes.forEach(function(en) {
        var etl = textOf(en);
        if (supHits.some(function(s){ return etl.indexOf(s.split(' ')[0]) !== -1; }))
          relEdges.push({ source: en.id, target: snid, weight: 2.5, edgeType: 'dependency', detected: true });
      });
    }
  }

  // Air corridor flux signal from cached traffic data
  try {
    var tc = localStorage.getItem('argus_traffic_v4');
    if (tc) {
      var traffic = JSON.parse(tc);
      if (Array.isArray(traffic) && traffic.length > 8) {
        var anid = 'signal:air_traffic';
        if (!newNodeIds.has(anid)) {
          var corCount = {};
          traffic.forEach(function(ac){ corCount[ac.corridor] = (corCount[ac.corridor]||0)+1; });
          var topCor = Object.keys(corCount).sort(function(a,b){ return corCount[b]-corCount[a]; })[0] || 'UNKNOWN';
          newNodes.push({ id: anid, type: 'signal', signalType: 'market', label: 'AIR CORRIDOR FLUX', keywords: [topCor + ' (' + (corCount[topCor]||0) + ')', traffic.length + ' aircraft'], risk: 'WATCH' });
          newNodeIds.add(anid);
        }
      }
    }
  } catch(_){}

  // Maritime traffic signal from live vessel data
  try {
    var vessels = window._vesselMap ? Array.from(window._vesselMap.values()) : [];
    if (vessels.length > 5) {
      var vnid = 'signal:maritime_traffic';
      if (!newNodeIds.has(vnid)) {
        var vesRegions = {};
        vessels.forEach(function(v){ vesRegions[v.region||'GLOBAL'] = (vesRegions[v.region||'GLOBAL']||0)+1; });
        var topVesReg = Object.keys(vesRegions).sort(function(a,b){ return vesRegions[b]-vesRegions[a]; })[0] || 'GLOBAL';
        newNodes.push({ id: vnid, type: 'signal', signalType: 'supply', label: 'MARITIME TRAFFIC', keywords: [topVesReg + ' (' + (vesRegions[topVesReg]||0) + ')', vessels.length + ' vessels active'], risk: 'WATCH' });
        newNodeIds.add(vnid);
      }
    }
  } catch(_){}

  // ── 4. GEOPOLITICAL CONTEXT ENGINE ──────────────────────────────────────────
  if (state.selectedCountry) {
    var gcd = (window.COUNTRIES_DATA || []).find(function(c){ return c.label === state.selectedCountry; });
    if (gcd) {
      // 4a. Trade dependency: event keywords match country's known exports/imports
      var tradeTerms = [].concat(gcd.topE || [], gcd.topI || []).map(function(t){ return t.toLowerCase().trim(); }).filter(function(t){ return t.length > 3; });
      if (tradeTerms.length) {
        evNodes.forEach(function(en) {
          var etl = textOf(en);
          var tradeHits = tradeTerms.filter(function(t){ return etl.indexOf(t) !== -1; });
          if (tradeHits.length) {
            var tnid = 'signal:trade';
            if (!newNodeIds.has(tnid)) {
              newNodes.push({ id: tnid, type: 'signal', signalType: 'supply', label: 'TRADE EXPOSURE', keywords: tradeHits.slice(0, 5), risk: 'WARNING' });
              newNodeIds.add(tnid);
            }
            relEdges.push({ source: en.id, target: tnid, weight: 2, edgeType: 'dependency', detected: true });
          }
        });
      }
    }
  }

  // 4b. Sanctions / embargo signal
  var SANCTION_TERMS = ['sanction','embargo','export ban','import ban','blacklist','asset freeze','tariff','trade restriction','blocked','banned'];
  var sanctHits = SANCTION_TERMS.filter(function(s){ return allTextL.indexOf(s) !== -1; });
  if (sanctHits.length) {
    var sancNid = 'signal:sanctions';
    if (!newNodeIds.has(sancNid)) {
      newNodes.push({ id: sancNid, type: 'signal', signalType: 'supply', label: 'SANCTIONS / EMBARGO', keywords: sanctHits.slice(0, 5), risk: 'CRITICAL' });
      newNodeIds.add(sancNid);
    }
    evNodes.forEach(function(en) {
      var etl = textOf(en);
      if (SANCTION_TERMS.some(function(s){ return etl.indexOf(s) !== -1; }))
        relEdges.push({ source: en.id, target: sancNid, weight: 3, edgeType: 'causality', detected: true });
    });
  }

  // 4c. Geopolitical / alliance keyword signals
  var GEO_SIGNALS = [
    { key: 'alliance', terms: ['nato','alliance','treaty','pact','multilateral','coalition'], label: 'ALLIANCE DYNAMICS', risk: 'WATCH' },
    { key: 'conflict_escalation', terms: ['escalat','airstrike','missile','offensive','invaded','occupied','siege','blockade'], label: 'CONFLICT ESCALATION', risk: 'CRITICAL' },
    { key: 'economic_warfare', terms: ['currency war','competitive deval','capital flight','default','debt crisis','yield spread','sovereign risk'], label: 'ECONOMIC WARFARE', risk: 'WARNING' },
    { key: 'supply_chain', terms: ['supply chain','semiconductor','rare earth','lithium','cobalt','lng','pipeline','grain corridor'], label: 'SUPPLY CHAIN RISK', risk: 'WARNING' },
  ];
  GEO_SIGNALS.forEach(function(sig) {
    var hits = sig.terms.filter(function(t){ return allTextL.indexOf(t) !== -1; });
    if (!hits.length) return;
    var gnid = 'signal:geo:' + sig.key;
    if (!newNodeIds.has(gnid)) {
      newNodes.push({ id: gnid, type: 'signal', signalType: 'market', label: sig.label, keywords: hits.slice(0, 4), risk: sig.risk });
      newNodeIds.add(gnid);
      evNodes.forEach(function(en) {
        var etl = textOf(en);
        if (sig.terms.some(function(t){ return etl.indexOf(t) !== -1; }))
          relEdges.push({ source: en.id, target: gnid, weight: 2, edgeType: 'correlation', detected: true });
      });
    }
  });

  // 4d. Conflict escalation cascade: CRITICAL events → infer causality to WARNING events sharing ≥1 keyword
  // Build edge Set once for O(1) existence checks (replaces O(edges) relEdges.some per pair).
  var _edgeSet = new Set(relEdges.map(function(e) { return e.source + '|' + e.target; }));
  var critEvents = evNodes.filter(function(n){ return n.risk === 'CRITICAL'; });
  var warnEvents2 = evNodes.filter(function(n){ return n.risk === 'WARNING'; });
  critEvents.forEach(function(ce) {
    warnEvents2.forEach(function(we) {
      if (_edgeSet.has(ce.id + '|' + we.id) || _edgeSet.has(we.id + '|' + ce.id)) return;
      var shared = (ce.keywords || []).filter(function(k){ return k.length > 4 && (we.keywords || []).indexOf(k) !== -1; });
      if (shared.length) relEdges.push({ source: ce.id, target: we.id, weight: 2.5, edgeType: 'causality', detected: true });
    });
  });

  // Commit everything
  state.relEdges = relEdges;
  var allNew = newNodes;

  if (allNew.length) {
    var merged = state.graph.nodes.concat(allNew);
    state.graph = { nodes: merged, edges: buildEdges(merged, []) };
    state._prevGraphKey = merged.map(function(n){ return n.id; }).join('|');
    extendLayout(allNew);
  } else {
    state.graph.edges = buildEdges(state.graph.nodes, []);
  }

  renderGraph();
  updateTopbar();
  renderTimeline();
  // Auto-reveal Timeline so the user sees populated results immediately
  switchTab('timeline');

  // Summary in inspector (will be visible when user clicks back to Inspect)
  var relCount    = relEdges.filter(function(e){ return e.detected; }).length;
  var injCount    = allNew.filter(function(n){ return n._injected; }).length;
  var entityCount = allNew.filter(function(n){ return n.type === 'entity'; }).length;
  var sigCount    = allNew.filter(function(n){ return n.type === 'signal'; }).length;
  var insp = document.getElementById('nw-insp-body');
  if (insp) {
    insp.innerHTML =
      field('SCAN COMPLETE', '<span style="color:var(--nw-purple)">' + relCount + ' relationships · ' + evNodes.length + ' events</span>') +
      field('INJECTED',      injCount + ' corpus events · ' + entityCount + ' entities · ' + sigCount + ' signals') +
      field('EDGE TYPES',
        '<span class="nw-edge-badge nw-edge-cause">CAUSALITY</span>' +
        '<span class="nw-edge-badge nw-edge-corr">CORRELATION</span>' +
        '<span class="nw-edge-badge nw-edge-dep">DEPENDENCY</span>'
      );
  }

  if (window.ArgusPerf) ArgusPerf.record('SCAN_RELATIONSHIPS', performance.now() - _scanT0, 200);
  if (btn) setTimeout(function(){ btn.classList.remove('is-scanning'); btn.textContent = '⬡ SCAN RELATIONS'; }, 900);
  } // end _signalsAndFinalize

  _processCountriesChunk(0);

  }, 0); // end scan defer
}

// Extend layout to position newly added nodes in an outer shell
function extendLayout(newNodes) {
  var canvas = document.getElementById('nw-canvas');
  if (!canvas) return;
  var cx = canvas.width / 2, cy = canvas.height / 2;
  var shellR = Math.min(cx, cy) * 0.82;
  newNodes.forEach(function(n, i) {
    var angle = (2 * Math.PI * i / Math.max(newNodes.length, 1)) + Math.PI / 4;
    layout[n.id] = { x: cx + Math.cos(angle) * shellR, y: cy + Math.sin(angle) * shellR, vx: 0, vy: 0, r: getNodeRadius(n) };
  });
}

// --- 3.5 Density control ---
function limitNodes(nodes, maxNodes) {
  if (nodes.length <= maxNodes) return nodes;

  var country = nodes.filter(function(n){ return n.type === 'country'; });
  var topics  = nodes.filter(function(n){ return n.type === 'topic'; });
  var events  = nodes.filter(function(n){ return n.type === 'event'; });

  // Sort events by risk weight DESC, then timestamp DESC
  events.sort(function(a, b) {
    var rDiff = (RISK_WEIGHTS[b.risk] || 0) - (RISK_WEIGHTS[a.risk] || 0);
    return rDiff !== 0 ? rDiff : b.timestamp - a.timestamp;
  });

  var budget = maxNodes - country.length - topics.length;
  return country.concat(topics).concat(events.slice(0, Math.max(budget, 0)));
}

// --- Graph rebuild pipeline ---
function rebuildGraph() {
  var events = getFilteredEvents();
  var nodes  = buildNodes(events);
  var edges  = buildEdges(nodes, events);

  // Diff: only re-layout if structure changed
  var key = nodes.map(function(n){ return n.id; }).join('|');
  if (key !== state._prevGraphKey) {
    state.graph = { nodes: nodes, edges: edges };
    state._prevGraphKey = key;
    computeLayout();   // recalculate positions only on structural change
  } else {
    state.graph = { nodes: nodes, edges: edges };
  }

  renderGraph();
  updateStats(events);

  // Keep timeline in sync if that tab is currently visible
  var tlPane = document.getElementById('nw-pane-timeline');
  if (tlPane && tlPane.classList.contains('is-active')) renderTimeline();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3B — LAYOUT ENGINE (Radial + light force relaxation)
// ═══════════════════════════════════════════════════════════════════════════════

var layout = {};   // nodeId → {x, y, vx, vy, r}  (canvas coordinates)
var animFrame = null;

var RISK_COLORS = { CRITICAL:'#ff0044', WARNING:'#ff9933', WATCH:'#ffcc00', LOW:'#00ff88' };
var TYPE_COLORS = { CONFLICT:'#ff3355', POLICY:'#0099ff', DISASTER:'#ff9933', ECONOMIC:'#ffcc00', HUMANITARIAN:'#ff6699', SUPPLY_CHAIN:'#00ccff', HUMAN_RIGHTS:'#ff99cc', TENSION:'#aaaaff' };

// ── Relationship Scanner constants ───────────────────────────────────────────
var CAUSALITY_VERBS   = ['triggered','caused','led to','prompted','resulted in','sparked','drove','forced','escalated','disrupted','destabilised','collapsed','pushed','enabled'];
var CORRELATION_VERBS = ['coincided','following','alongside','amid','linked','parallel','concurrent','compounded','reinforced','aggravated','worsened'];
var DEPENDENCY_VERBS  = ['relies on','depends on','tied to','contingent','vulnerable','exposed to','impacted by','at risk','threatened by','relies upon','dependent on'];

var EDGE_TYPES = {
  causality:   { color:'#ff3355', dash:[4,3],  label:'LED TO',     badge:'nw-edge-cause'   },
  correlation: { color:'#00aaff', dash:[2,4],  label:'MOVED WITH', badge:'nw-edge-corr'    },
  dependency:  { color:'#ffcc00', dash:[6,2],  label:'RELIES ON',  badge:'nw-edge-dep'     },
  manual:      { color:'#00ff88', dash:[3,3],  label:'LINKED BY',  badge:'nw-edge-manual'  },
  country:     { color:'#0099ff', dash:[],     label:'',           badge:''                 },
  topic:       { color:'#3a1a7a', dash:[1,3],  label:'',           badge:''                 },
};

// Well-known companies in supply-chain / trade context
var KNOWN_COMPANIES = ['maersk','cosco','evergreen','hapag','msc','fedex','ups','dhl','shell','bp','exxon','aramco','toyota','apple','tsmc','samsung','intel','nvidia','boeing','airbus','caterpillar'];

// Market/supply signal keywords
var MARKET_SIGNALS   = ['oil price','brent','wti','s&p','spy','yield','dollar','usd','gold','treasury','nasdaq','dow','inflation','gdp','fed','rate hike','rate cut'];
var SUPPLY_SIGNALS   = ['shortage','embargo','sanctions','blockade','disruption','supply chain','port closure','canal blocked','semiconductor','chip','fertilizer','wheat','grain'];

function getNodeRadius(n) {
  if (n.type === 'country')  return 26;
  if (n.type === 'topic')    return 10;
  if (n.type === 'entity')   return 13 + (RISK_WEIGHTS[n.risk] || 1);
  if (n.type === 'signal')   return 15;
  if (n.type === 'note')     return 13;
  if (n.type === 'vessel')     return 12 + (RISK_WEIGHTS[n.risk] || 1);
  if (n.type === 'company')    return 13 + (RISK_WEIGHTS[n.risk] || 1);
  if (n.type === 'news')       return 12 + (RISK_WEIGHTS[n.risk] || 1);
  if (n.type === 'aircraft')   return 11;
  if (n.type === 'chokepoint')    return 16 + (RISK_WEIGHTS[n.risk] || 1) * 2;
  if (n.type === 'market_ticker') return 14;
  return 14 + (RISK_WEIGHTS[n.risk] || 1) * 2;
}

function computeLayout() {
  var canvas = document.getElementById('nw-canvas');
  if (!canvas) return;
  var cx = canvas.width  / 2;
  var cy = canvas.height / 2;

  var nodes = state.graph.nodes;
  layout = {};

  var countryNode = nodes.find(function(n){ return n.type === 'country'; });
  var topicNodes  = nodes.filter(function(n){ return n.type === 'topic'; });
  var eventNodes  = nodes.filter(function(n){ return n.type === 'event'; });

  if (countryNode) {
    layout[countryNode.id] = { x: cx, y: cy, vx: 0, vy: 0, r: getNodeRadius(countryNode) };
  }

  // Topic nodes — inner ring
  var topicR = Math.min(cx, cy) * 0.32;
  topicNodes.forEach(function(n, i) {
    var angle = (2 * Math.PI * i / Math.max(topicNodes.length, 1)) - Math.PI / 2;
    layout[n.id] = { x: cx + Math.cos(angle) * topicR, y: cy + Math.sin(angle) * topicR, vx: 0, vy: 0, r: getNodeRadius(n) };
  });

  // Event nodes — outer ring grouped by risk (CRITICAL innermost of outer ring)
  var riskOrder = ['CRITICAL','WARNING','WATCH','LOW'];
  var grouped = {};
  riskOrder.forEach(function(r){ grouped[r] = []; });
  eventNodes.forEach(function(n){ (grouped[n.risk] || (grouped['LOW'])).push(n); });

  var totalEvents = eventNodes.length || 1;
  var outerRBase  = Math.min(cx, cy) * 0.55;
  var placed = 0;

  riskOrder.forEach(function(risk) {
    var rNodes = grouped[risk];
    if (!rNodes.length) return;
    var outerR = outerRBase + (3 - (RISK_WEIGHTS[risk] - 1)) * 28;
    rNodes.forEach(function(n, i) {
      // Spread across the full circle, offset per-risk to avoid overlap
      var startAngle = -Math.PI / 2 + (placed / totalEvents) * 2 * Math.PI;
      var angle = startAngle + (i / Math.max(rNodes.length, 1)) * 2 * Math.PI * (rNodes.length / totalEvents);
      layout[n.id] = { x: cx + Math.cos(angle) * outerR, y: cy + Math.sin(angle) * outerR, vx: 0, vy: 0, r: getNodeRadius(n) };
      placed++;
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 4 — VIEW: Canvas Renderer
// ═══════════════════════════════════════════════════════════════════════════════

var cam = { x: 0, y: 0, scale: 1 };  // pan/zoom camera state
var hoveredNode  = null;
var selectedNode = null;

var FONT_MONO = "'JetBrains Mono', monospace";

function renderGraph() {
  var canvas = document.getElementById('nw-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  var nodes = state.graph.nodes;
  var edges = state.graph.edges;
  if (!nodes.length) return;

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.scale, cam.scale);

  // Draw edges first — typed with color + dash pattern
  edges.forEach(function(e) {
    var a = layout[e.source], b = layout[e.target];
    if (!a || !b) return;
    var et     = EDGE_TYPES[e.edgeType] || EDGE_TYPES.country;
    var alpha  = e.detected ? 0.55 : (e.weight > 1 ? 0.28 : 0.12);
    var lw     = e.detected ? (e.weight > 2 ? 1.8 : 1.2) : (e.weight > 2 ? 1.4 : 0.7);
    ctx.beginPath();
    ctx.setLineDash(et.dash);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = hexToRgba(et.color, alpha);
    ctx.lineWidth   = lw;
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Draw nodes
  nodes.forEach(function(n) {
    var pos = layout[n.id];
    if (!pos) return;
    var isHovered  = hoveredNode  && hoveredNode.id  === n.id;
    var isSelected = selectedNode && selectedNode.id === n.id;

    drawNode(ctx, n, pos, isHovered, isSelected);
    drawNodeLabel(ctx, n, pos);
  });

  ctx.restore();
}

function drawNode(ctx, n, pos, hovered, selected) {
  var r     = pos.r;
  var color = nodeColor(n);

  // Purple glow ring on hover/select for new node types; blue for existing
  if (hovered || selected) {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = (n.type === 'entity' || n.type === 'signal') ? '#b464ff' : color;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = selected ? 0.65 : 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (n.type === 'country') {
    // Large circle — purple-tinted fill
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,5,50,0.45)';
    ctx.fill();
    ctx.strokeStyle = '#b464ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Inner dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#b464ff';
    ctx.fill();

  } else if (n.type === 'topic') {
    // Small muted circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,10,60,0.5)';
    ctx.fill();
    ctx.strokeStyle = '#5a2a8a';
    ctx.lineWidth = 1;
    ctx.stroke();

  } else if (n.type === 'entity') {
    // Diamond shape (rotated square) — distinguishes entities from events
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
    ctx.fillStyle = hexToRgba(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();
    ctx.restore();
    // Inner type dot
    var entColor = n.entityType === 'country' ? '#0099ff' : (n.entityType === 'company' ? '#b464ff' : '#ffcc00');
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = entColor;
    ctx.fill();

  } else if (n.type === 'signal') {
    // Hexagon shape — signals are distinct from events and entities
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var a = (Math.PI / 3) * k - Math.PI / 6;
      if (k === 0) ctx.moveTo(pos.x + r * Math.cos(a), pos.y + r * Math.sin(a));
      else         ctx.lineTo(pos.x + r * Math.cos(a), pos.y + r * Math.sin(a));
    }
    ctx.closePath();
    var sigColor = n.signalType === 'market' ? '#ff9933' : '#ff4488';
    ctx.fillStyle = hexToRgba(sigColor, 0.16);
    ctx.fill();
    ctx.strokeStyle = sigColor;
    ctx.lineWidth = hovered ? 2 : 1.4;
    ctx.stroke();
    // Inner indicator
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(sigColor, 0.7);
    ctx.fill();

  } else if (n.type === 'note') {
    // Sticky note — square with fold corner
    var ns = r * 1.7;
    var nx = pos.x - ns / 2, ny = pos.y - ns / 2;
    ctx.beginPath();
    ctx.moveTo(nx + ns - 5, ny);
    ctx.lineTo(nx, ny);
    ctx.lineTo(nx, ny + ns);
    ctx.lineTo(nx + ns, ny + ns);
    ctx.lineTo(nx + ns, ny + 5);
    ctx.closePath();
    ctx.fillStyle = hexToRgba('#ffe066', 0.13);
    ctx.fill();
    ctx.strokeStyle = '#ffe066';
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();
    // Fold corner
    ctx.beginPath();
    ctx.moveTo(nx + ns - 5, ny);
    ctx.lineTo(nx + ns - 5, ny + 5);
    ctx.lineTo(nx + ns, ny + 5);
    ctx.strokeStyle = hexToRgba('#ffe066', 0.5);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // Pen dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe066';
    ctx.fill();

  } else if (n.type === 'vessel') {
    // Triangle (ship prow pointing up)
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y - r);
    ctx.lineTo(pos.x + r * 0.85, pos.y + r * 0.7);
    ctx.lineTo(pos.x - r * 0.85, pos.y + r * 0.7);
    ctx.closePath();
    ctx.fillStyle = hexToRgba('#00ccff', 0.14);
    ctx.fill();
    ctx.strokeStyle = '#00ccff';
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();

  } else if (n.type === 'aircraft') {
    // Top-down airplane silhouette — fuselage + swept wings + tail
    var ac_col = '#66ddff';
    ctx.save();
    ctx.translate(pos.x, pos.y);
    // Fuselage
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.28, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(ac_col, 0.22);
    ctx.fill();
    ctx.strokeStyle = ac_col;
    ctx.lineWidth = hovered ? 1.8 : 1.1;
    ctx.stroke();
    // Wings
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, -r * 0.12);
    ctx.lineTo(-r * 1.1, r * 0.28);
    ctx.lineTo(-r * 0.9, r * 0.38);
    ctx.lineTo(0, r * 0.08);
    ctx.lineTo(r * 0.9, r * 0.38);
    ctx.lineTo(r * 1.1, r * 0.28);
    ctx.lineTo(r * 0.28, -r * 0.12);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(ac_col, 0.18);
    ctx.fill();
    ctx.strokeStyle = ac_col;
    ctx.lineWidth = hovered ? 1.6 : 0.9;
    ctx.stroke();
    // Tail fins
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, r * 0.6);
    ctx.lineTo(-r * 0.55, r * 0.9);
    ctx.lineTo(-r * 0.38, r * 0.95);
    ctx.lineTo(0, r * 0.7);
    ctx.lineTo(r * 0.38, r * 0.95);
    ctx.lineTo(r * 0.55, r * 0.9);
    ctx.lineTo(r * 0.18, r * 0.6);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(ac_col, 0.24);
    ctx.fill();
    ctx.strokeStyle = ac_col;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

  } else if (n.type === 'chokepoint') {
    // Diamond shape (rotated square) — matches ◇ icon
    var cp_col = '#ffaa33';
    ctx.beginPath();
    ctx.moveTo(pos.x,         pos.y - r * 1.2);
    ctx.lineTo(pos.x + r,     pos.y);
    ctx.lineTo(pos.x,         pos.y + r * 1.2);
    ctx.lineTo(pos.x - r,     pos.y);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(cp_col, 0.13);
    ctx.fill();
    ctx.strokeStyle = cp_col;
    ctx.lineWidth = hovered ? 2.2 : 1.4;
    ctx.stroke();
    // Inner diamond ring
    ctx.beginPath();
    ctx.moveTo(pos.x,         pos.y - r * 0.6);
    ctx.lineTo(pos.x + r * 0.5, pos.y);
    ctx.lineTo(pos.x,         pos.y + r * 0.6);
    ctx.lineTo(pos.x - r * 0.5, pos.y);
    ctx.closePath();
    ctx.strokeStyle = hexToRgba(cp_col, 0.4);
    ctx.lineWidth = 0.7;
    ctx.stroke();

  } else if (n.type === 'company') {
    // Square with inner ring
    ctx.beginPath();
    ctx.rect(pos.x - r, pos.y - r, r * 2, r * 2);
    ctx.fillStyle = hexToRgba('#ff99aa', 0.13);
    ctx.fill();
    ctx.strokeStyle = '#ff99aa';
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba('#ff99aa', 0.55);
    ctx.fill();

  } else if (n.type === 'news') {
    // Octagon — news burst shape
    ctx.beginPath();
    for (var k2 = 0; k2 < 8; k2++) {
      var a2 = (Math.PI / 4) * k2 - Math.PI / 8;
      if (k2 === 0) ctx.moveTo(pos.x + r * Math.cos(a2), pos.y + r * Math.sin(a2));
      else          ctx.lineTo(pos.x + r * Math.cos(a2), pos.y + r * Math.sin(a2));
    }
    ctx.closePath();
    ctx.fillStyle = hexToRgba('#cc88ff', 0.13);
    ctx.fill();
    ctx.strokeStyle = '#cc88ff';
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();

  } else if (n.type === 'market_ticker') {
    // Rounded rectangle badge — green/red tint based on price direction
    var bw = r * 1.9, bh = r * 1.2;
    var brad = 3;
    ctx.beginPath();
    ctx.moveTo(pos.x - bw / 2 + brad, pos.y - bh / 2);
    ctx.lineTo(pos.x + bw / 2 - brad, pos.y - bh / 2);
    ctx.arcTo(pos.x + bw / 2, pos.y - bh / 2, pos.x + bw / 2, pos.y - bh / 2 + brad, brad);
    ctx.lineTo(pos.x + bw / 2, pos.y + bh / 2 - brad);
    ctx.arcTo(pos.x + bw / 2, pos.y + bh / 2, pos.x + bw / 2 - brad, pos.y + bh / 2, brad);
    ctx.lineTo(pos.x - bw / 2 + brad, pos.y + bh / 2);
    ctx.arcTo(pos.x - bw / 2, pos.y + bh / 2, pos.x - bw / 2, pos.y + bh / 2 - brad, brad);
    ctx.lineTo(pos.x - bw / 2, pos.y - bh / 2 + brad);
    ctx.arcTo(pos.x - bw / 2, pos.y - bh / 2, pos.x - bw / 2 + brad, pos.y - bh / 2, brad);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = hovered ? 2 : 1.3;
    ctx.stroke();
    // Candlestick bar icon
    ctx.fillStyle = hexToRgba(color, 0.7);
    ctx.fillRect(pos.x - 2.5, pos.y - r * 0.45, 5, r * 0.9);

  } else {
    // Event node — colored circle with type-color inner dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = hovered ? 2 : 1.2;
    ctx.stroke();
    var typeColor = TYPE_COLORS[n.eventType] || '#4a7da8';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(typeColor, 0.6);
    ctx.fill();
  }
}

function drawNodeLabel(ctx, n, pos) {
  var label = '';
  if (n.type === 'country') {
    label = n.label.toUpperCase();
  } else if (n.type === 'topic') {
    label = n.label;
  } else {
    // Truncate event labels
    label = n.label.length > 22 ? n.label.slice(0, 20) + '…' : n.label;
  }

  ctx.font = (n.type === 'country' ? 'bold 11px ' : '8px ') + FONT_MONO;
  ctx.fillStyle = n.type === 'country' ? '#c0ddf8'
    : n.type === 'topic'   ? '#4a7da8'
    : n.type === 'note'    ? '#ffe066'
    : n.type === 'vessel'     ? '#00ccff'
    : n.type === 'aircraft'   ? '#66ddff'
    : n.type === 'company'    ? '#ff99aa'
    : n.type === 'news'       ? '#cc88ff'
    : n.type === 'chokepoint'    ? '#ffaa33'
    : n.type === 'market_ticker' ? nodeColor(n)
    : '#8899bb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(label, pos.x, pos.y + pos.r + 4);
}

function nodeColor(n) {
  if (n.type === 'country')  return '#b464ff';
  if (n.type === 'topic')    return '#5a2a8a';
  if (n.type === 'entity')   return n.entityType === 'country' ? '#0099ff' : (n.entityType === 'company' ? '#b464ff' : '#ffcc00');
  if (n.type === 'signal')   return n.signalType === 'market' ? '#ff9933' : '#ff4488';
  if (n.type === 'note')     return '#ffe066';
  if (n.type === 'vessel')     return '#00ccff';
  if (n.type === 'company')    return '#ff99aa';
  if (n.type === 'news')       return '#cc88ff';
  if (n.type === 'aircraft')   return '#66ddff';
  if (n.type === 'chokepoint')    return '#ffaa33';
  if (n.type === 'market_ticker') {
    var pct = n._payload && n._payload.change_percent;
    return pct == null ? '#c5d7e8' : pct > 0 ? '#00ff88' : pct < 0 ? '#ff0044' : '#c5d7e8';
  }
  return RISK_COLORS[n.risk] || '#4a7da8';
}

function hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// ── Pan / Zoom + Draggable Nodes ─────────────────────────────────────────────
// Static base: country + topic nodes anchor the graph context.
// Draggable: event, entity, signal nodes can be repositioned freely.
function setupCanvasInteraction() {
  var canvas = document.getElementById('nw-canvas');
  var wrap   = document.getElementById('nw-canvas-wrap');
  if (!canvas) return;

  var DRAGGABLE = { event: 1, entity: 1, signal: 1, note: 1, vessel: 1, company: 1, news: 1, aircraft: 1, chokepoint: 1 };
  var drag     = { active: false, sx: 0, sy: 0, cx: 0, cy: 0 }; // canvas pan
  var nodeDrag = { active: false, node: null };                   // node drag
  var _didMove = false;

  canvas.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    hideContextMenu();
    _didMove = false;
    var n = pickNode(e, canvas);
    if (n && DRAGGABLE[n.type]) {
      // Begin node drag
      nodeDrag.active = true;
      nodeDrag.node   = n;
      canvas.style.cursor = 'grabbing';
    } else {
      // Begin canvas pan
      drag.active = true;
      drag.sx = e.clientX; drag.sy = e.clientY;
      drag.cx = cam.x;     drag.cy = cam.y;
      wrap.classList.add('is-dragging');
    }
  });

  var _graphRafPending = false;
  window.addEventListener('mousemove', function(e) {
    if (nodeDrag.active) {
      _didMove = true;
      var rect = canvas.getBoundingClientRect();
      var mx = (e.clientX - rect.left - cam.x) / cam.scale;
      var my = (e.clientY - rect.top  - cam.y) / cam.scale;
      var pos = layout[nodeDrag.node.id];
      if (pos) {
        pos.x = mx; pos.y = my;
        if (!_graphRafPending) { _graphRafPending = true; requestAnimationFrame(function(){ _graphRafPending = false; renderGraph(); }); }
      }
    } else if (drag.active) {
      _didMove = true;
      cam.x = drag.cx + (e.clientX - drag.sx);
      cam.y = drag.cy + (e.clientY - drag.sy);
      if (!_graphRafPending) { _graphRafPending = true; requestAnimationFrame(function(){ _graphRafPending = false; renderGraph(); }); }
    } else {
      updateHover(e, canvas);
    }
  });

  window.addEventListener('mouseup', function() {
    nodeDrag.active = false;
    nodeDrag.node   = null;
    drag.active     = false;
    wrap.classList.remove('is-dragging');
    canvas.style.cursor = '';
  });

  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    var factor = e.deltaY > 0 ? 0.9 : 1.1;
    var rect   = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    cam.x  = mx - (mx - cam.x) * factor;
    cam.y  = my - (my - cam.y) * factor;
    cam.scale = Math.max(0.25, Math.min(4, cam.scale * factor));
    renderGraph();
  }, { passive: false });

  canvas.addEventListener('click', function(e) {
    if (_didMove) return; // suppress click after drag
    var n = pickNode(e, canvas);
    // Link mode: first click sets source, second creates edge
    if (state.linkMode.active && n && handleLinkClick(n)) return;
    if (n) {
      selectedNode = n;
      showInspector(n);
    } else {
      selectedNode = null;
      showInspector(null);
    }
    renderGraph();
  });

  // Canvas as drag-and-drop target (receives nodes dragged from builder panel)
  canvas.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('drop-target');
  });
  canvas.addEventListener('dragleave', function() { wrap.classList.remove('drop-target'); });
  canvas.addEventListener('drop', function(e) {
    e.preventDefault();
    wrap.classList.remove('drop-target');
    var dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    try {
      var nodeData = JSON.parse(dataStr);
      var rect = canvas.getBoundingClientRect();
      var cx2 = (e.clientX - rect.left - cam.x) / cam.scale;
      var cy2 = (e.clientY - rect.top  - cam.y) / cam.scale;
      addManualNode(nodeData, cx2, cy2);
    } catch(_) {}
  });

  // Right-click context menu
  canvas.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var n = pickNode(e, canvas);
    if (n) {
      selectedNode = n;
      renderGraph();
      showContextMenu(n, e.clientX, e.clientY);
    } else {
      hideContextMenu();
    }
  });
}

// ── Context menu ──────────────────────────────────────────────────────────────
var _ctxMenuOpen = false;
var _ctxMenuNode = null;

function showContextMenu(node, x, y) {
  var menu = document.getElementById('nw-ctx-menu');
  if (!menu) return;
  _ctxMenuNode = node;
  _ctxMenuOpen = true;
  menu.classList.add('is-open');
  // Clamp to viewport edges
  var mw = 168, mh = 110;
  menu.style.left = Math.min(x, window.innerWidth  - mw - 6) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh - 6) + 'px';
  // Reclassify only meaningful for event nodes
  var recEl = document.getElementById('nw-ctx-reclassify');
  if (recEl) recEl.style.display = node.type === 'event' ? '' : 'none';
}

function hideContextMenu() {
  var menu = document.getElementById('nw-ctx-menu');
  if (menu) menu.classList.remove('is-open');
  _ctxMenuOpen = false;
  _ctxMenuNode = null;
}

function editNodeLabel() {
  var node = _ctxMenuNode;
  hideContextMenu();
  if (!node) return;
  var newLabel = prompt('Edit label:', node.label);
  if (newLabel && newLabel.trim()) {
    node.label = newLabel.trim();
    if (node._ev) node._ev.title = node.label;
    renderGraph();
    if (selectedNode && selectedNode.id === node.id) showInspector(node);
    renderTimeline();
  }
}

function reclassifyNode() {
  var node = _ctxMenuNode;
  hideContextMenu();
  if (!node || node.type !== 'event') return;
  var typeList = Object.keys(VALID_TYPES).join(' | ');
  var newType = prompt('Event type (' + typeList + '):', node.eventType || 'POLICY');
  if (!newType) return;
  newType = newType.trim().toUpperCase().replace(/[-\s]/g, '_');
  if (VALID_TYPES[newType]) {
    node.eventType = newType;
    if (node._ev) node._ev.type = newType;
    renderGraph();
    if (selectedNode && selectedNode.id === node.id) showInspector(node);
  }
}

// ── Note linking — click a node, jump to its section in Notes tab ────────────
function noteForNode(node) {
  switchTab('notes');
  var ta = document.getElementById('nw-notes-input');
  if (!ta) return;
  if (!ta.value) ta.value = loadNotes();
  var header = '\n\n## ' + node.label.slice(0, 60) + '\n';
  var anchor = '## ' + node.label.slice(0, 30);
  if (ta.value.indexOf(anchor) === -1) {
    ta.value += header;
    saveNotes(ta.value);
  }
  var idx = ta.value.indexOf(anchor);
  if (idx !== -1) {
    ta.focus();
    ta.setSelectionRange(idx, idx);
    var lh = parseFloat(getComputedStyle(ta).lineHeight) || 15;
    var linesBefore = ta.value.substring(0, idx).split('\n').length;
    ta.scrollTop = Math.max(0, linesBefore - 2) * lh;
  }
}

// Hit-test: returns node under cursor or null
function pickNode(e, canvas) {
  var rect = canvas.getBoundingClientRect();
  var mx = (e.clientX - rect.left - cam.x) / cam.scale;
  var my = (e.clientY - rect.top  - cam.y) / cam.scale;
  var nodes = state.graph.nodes;
  // Check in reverse paint order so topmost node wins
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n   = nodes[i];
    var pos = layout[n.id];
    if (!pos) continue;
    var dx = mx - pos.x, dy = my - pos.y;
    if (Math.sqrt(dx*dx + dy*dy) <= pos.r + 4) return n;
  }
  return null;
}

function updateHover(e, canvas) {
  var n = pickNode(e, canvas);
  if (n !== hoveredNode) {
    hoveredNode = n;
    renderGraph();
    showTooltip(n, e);
  } else if (n) {
    showTooltip(n, e);
  }
}

function showTooltip(node, e) {
  var tip = document.getElementById('nw-tooltip');
  if (!node) { tip.classList.remove('is-visible'); return; }
  var text = node.type === 'country' ? node.label
    : node.type === 'topic'   ? 'TOPIC: ' + node.label + ' (' + node.count + ' events)'
    : node.type === 'note'    ? '📝 ' + node.label.slice(0, 60)
    : node.type === 'vessel'  ? '🚢 ' + node.label
    : node.type === 'company' ? '🏢 ' + node.label
    : node.type === 'news'    ? '📰 ' + node.label.slice(0, 60)
    : '[' + node.risk + '] ' + node.label;
  tip.textContent = text;
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top  = (e.clientY - 10) + 'px';
  tip.classList.add('is-visible');
}

// ══════════════════════════════════════════════════════════════════════════════
// INSPECTOR INTELLIGENCE HELPERS
// Phase 1: Dynamic event indexing
// Phase 2: Node intelligence snapshots
// Phase 3: Correlation explainability
// ══════════════════════════════════════════════════════════════════════════════

// Phase 1 — Dynamic event count: walks all available data sources at call-time
// so the count always reflects live graph state, not a cached snapshot.
function _dynamicEventCount(countryLabel) {
  var seen  = new Set();
  var count = 0;
  var cLow  = (countryLabel || '').toLowerCase();
  if (!cLow) return 0;

  // 1. Direct store index (base ingested events)
  (store.byCountry.get(countryLabel) || []).forEach(function(ev) {
    if (!seen.has(ev.id)) { seen.add(ev.id); count++; }
  });

  // 2. Current graph event nodes (may include scan-injected corpus events)
  (state.graph.nodes || []).forEach(function(n) {
    if (n.type === 'event' && n.id && !seen.has(n.id)) { seen.add(n.id); count++; }
  });

  // 3. GDACS live cache — check affectedRegions + title for country mention
  var gdCache = window.gdacsEventCache;
  if (gdCache && typeof gdCache.forEach === 'function') {
    gdCache.forEach(function(ev) {
      var key = 'gdacs_' + (ev.id || ev.title || '');
      if (seen.has(key)) return;
      var regions = (ev.affectedRegions || []).join(' ').toLowerCase();
      var txt = ((ev.title || '') + ' ' + regions).toLowerCase();
      if (txt.indexOf(cLow) !== -1) { seen.add(key); count++; }
    });
  }

  // 4. NOAA events — check region/country fields
  (window._noaaEvents || []).forEach(function(ev) {
    var key = 'noaa_' + (ev.id || ev.title || '');
    if (seen.has(key)) return;
    var txt = ((ev.title || '') + ' ' + (ev.region || '') + ' ' + (ev.country || '')).toLowerCase();
    if (txt.indexOf(cLow) !== -1) { seen.add(key); count++; }
  });

  // 5. Relationship-linked event nodes (events connected to this country node in graph)
  var countryNodeId = 'country:' + countryLabel;
  (state.relEdges || []).forEach(function(e) {
    var otherId = e.source === countryNodeId ? e.target : (e.target === countryNodeId ? e.source : null);
    if (!otherId || seen.has(otherId)) return;
    var other = state.graph.nodes.find(function(n) { return n.id === otherId; });
    if (other && other.type === 'event') { seen.add(otherId); count++; }
  });

  return count;
}

// Phase 2 — Operational snapshot: ≤3 intelligence bullets derived from live graph state.
// No hardcoded values. No external fetches. All data comes from ingested graph memory.
function _nodeSnapshot(node) {
  var bullets = [];

  if (node.type === 'country') {
    var evs      = store.byCountry.get(node.label) || [];
    var graphEvs = (state.graph.nodes || []).filter(function(n) { return n.type === 'event'; });

    // Bullet 1: Largest active risk driver
    var critEvs = graphEvs.filter(function(n) { return n.risk === 'CRITICAL'; });
    var warnEvs = graphEvs.filter(function(n) { return n.risk === 'WARNING'; });
    if (critEvs.length) {
      bullets.push('CRITICAL DRIVER — ' + critEvs[0].label.slice(0, 52));
    } else if (warnEvs.length) {
      bullets.push('TOP WARNING — ' + warnEvs[0].label.slice(0, 52));
    }

    // Bullet 2: Dominant event category in store
    var typeCounts = {};
    evs.forEach(function(ev) { typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1; });
    var sortedTypes = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; });
    if (sortedTypes.length) {
      bullets.push('DOMINANT CATEGORY — ' + sortedTypes[0].replace(/_/g,' ') + ' · ' + typeCounts[sortedTypes[0]] + ' events');
    }

    // Bullet 3: Highest-connectivity event node (most relEdges)
    var edgeCounts = {};
    (state.relEdges || []).forEach(function(e) {
      edgeCounts[e.source] = (edgeCounts[e.source] || 0) + 1;
      edgeCounts[e.target] = (edgeCounts[e.target] || 0) + 1;
    });
    var topNode = null, topEdgeCount = 0;
    graphEvs.forEach(function(n) {
      var ec = edgeCounts[n.id] || 0;
      if (ec > topEdgeCount) { topEdgeCount = ec; topNode = n; }
    });
    if (topNode && topEdgeCount > 0) {
      bullets.push('MOST CONNECTED — ' + topNode.label.slice(0, 45) + ' · ' + topEdgeCount + ' links');
    }

  } else if (node.type === 'event' || node.type === 'topic') {
    // Event/topic: age signal + related event count + dominant linked region
    var now = Date.now();
    if (node.timestamp) {
      var ageMs  = now - node.timestamp;
      var ageDays = Math.floor(ageMs / 86400000);
      var ageLabel = ageDays === 0 ? 'TODAY' : ageDays === 1 ? '1 DAY AGO' : ageDays + ' DAYS AGO';
      bullets.push('EVENT AGE — ' + ageLabel);
    }
    var relCount = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; }).length;
    if (relCount > 0) {
      bullets.push('RELATIONSHIP LOAD — ' + relCount + ' detected connections');
    }
    // Linked country entities
    var linkedCountries = (state.relEdges || [])
      .filter(function(e){ return e.source === node.id || e.target === node.id; })
      .map(function(e){
        var otherId = e.source === node.id ? e.target : e.source;
        return state.graph.nodes.find(function(n){ return n.id === otherId && n.type === 'entity' && n.entityType === 'country'; });
      })
      .filter(Boolean);
    if (linkedCountries.length) {
      bullets.push('LINKED REGIONS — ' + linkedCountries.slice(0,3).map(function(n){ return n.label; }).join(', '));
    }

  } else if (node.type === 'vessel') {
    // Vessel: nearby op signals + ship category context
    var snap = collectTrackingSnapshot();
    if (snap.ships.length) {
      var typeDist = categoryDistribution(snap.ships);
      var topCat = Object.keys(typeDist).sort(function(a,b){ return typeDist[b]-typeDist[a]; })[0];
      if (topCat) bullets.push('DOMINANT SHIP TYPE — ' + topCat.toUpperCase() + ' · ' + typeDist[topCat] + '% of tracked fleet');
      bullets.push('FLEET SNAPSHOT — ' + snap.ships.length + ' vessels · ' + snap.flights.length + ' aircraft tracked');
    }
    // Nearby disruption signals from relEdges
    var vesDisruptEdges = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    if (vesDisruptEdges.length) {
      bullets.push('DISRUPTION SIGNALS — ' + vesDisruptEdges.length + ' active correlation links');
    }

  } else if (node.type === 'aircraft') {
    var fsnap = collectTrackingSnapshot();
    if (fsnap.flights.length) {
      var ftDist = categoryDistribution(fsnap.flights);
      var ftTopCat = Object.keys(ftDist).sort(function(a,b){ return ftDist[b]-ftDist[a]; })[0];
      if (ftTopCat) bullets.push('DOMINANT FLIGHT TYPE — ' + ftTopCat.toUpperCase() + ' · ' + ftDist[ftTopCat] + '% of tracked');
      bullets.push('AVIATION SNAPSHOT — ' + fsnap.flights.length + ' contacts tracked');
    }

  } else if (node.type === 'company') {
    // Company: connected countries, linked event count
    var coEdges = (state.relEdges || []).concat(state.manualEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    var coLinkedCountries = coEdges.map(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      return state.graph.nodes.find(function(n){ return n.id === otherId && (n.type === 'entity' || n.type === 'country'); });
    }).filter(Boolean);
    if (coLinkedCountries.length) {
      bullets.push('GEOGRAPHIC EXPOSURE — ' + coLinkedCountries.slice(0,3).map(function(n){ return n.label; }).join(', '));
    }
    var coEventEdges = coEdges.filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.type === 'event';
    });
    if (coEventEdges.length) bullets.push('LINKED EVENTS — ' + coEventEdges.length + ' active event connections');
    if (node.keywords && node.keywords.length) {
      bullets.push('OPERATIONAL SECTORS — ' + node.keywords.slice(0, 3).join(', '));
    }

  } else if (node.type === 'news') {
    // News: related entity count, topic cluster
    var newsEdges = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    if (newsEdges.length) {
      bullets.push('RELATED ENTITIES — ' + newsEdges.length + ' graph connections');
    }
    if (node.keywords && node.keywords.length) {
      bullets.push('TOPIC CLUSTER — ' + node.keywords.slice(0, 4).join(', '));
    }

  } else if (node.type === 'signal') {
    var sigEdges = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    if (sigEdges.length) {
      var critLinked = sigEdges.filter(function(e){
        var otherId = e.source === node.id ? e.target : e.source;
        var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
        return other && other.risk === 'CRITICAL';
      }).length;
      bullets.push('ACTIVE CONNECTIONS — ' + sigEdges.length + ' event links' + (critLinked ? ' · ' + critLinked + ' CRITICAL' : ''));
    }
    if (node.keywords && node.keywords.length) {
      bullets.push('TRIGGER TERMS — ' + node.keywords.slice(0,4).join(', '));
    }

  } else if (node.type === 'chokepoint') {
    var cpSnap = collectTrackingSnapshot();
    if (cpSnap.ships.length > 0) {
      bullets.push('LIVE TRAFFIC — ' + cpSnap.ships.length + ' vessels · ' + cpSnap.flights.length + ' aircraft tracked globally');
    }
    var cpRelEdges = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    if (cpRelEdges.length) {
      bullets.push('DISRUPTION LINKS — ' + cpRelEdges.length + ' active event connections');
    }
    if (node.risk === 'CRITICAL' || node.risk === 'WARNING') {
      bullets.push('OPERATIONAL STATUS — ' + node.risk + ' · Monitoring required');
    }
  }

  if (!bullets.length) return '';

  var html = '<div style="margin-top:10px;padding:8px 10px;background:rgba(10,4,26,0.6);border:1px solid rgba(100,50,200,0.15);border-left:2px solid #b464ff">';
  html += '<div style="font-size:7.5px;letter-spacing:1.8px;color:#b464ff;margin-bottom:7px;font-weight:700">⬡ OPERATIONAL SNAPSHOT</div>';
  bullets.slice(0, 3).forEach(function(b) {
    html += '<div style="font-size:8px;color:#8899bb;margin-bottom:5px;line-height:1.5;padding:3px 0 3px 8px;border-left:1px solid rgba(100,50,200,0.25)">· ' + b + '</div>';
  });
  html += '</div>';
  return html;
}

// Phase 3 — Correlation basis: deterministic, graph-derived explanation of WHY
// two nodes are connected. No AI generation. No fabricated reasoning.
function _correlationBasis(node) {
  var edges = (state.relEdges || []).filter(function(e) { return e.source === node.id || e.target === node.id; });
  if (!edges.length) return '';

  var signals = [];
  var myKws   = new Set(node.keywords || []);
  var myTs    = node.timestamp || 0;

  var hasCausality   = false, hasDependency = false, hasCorrelation = false;
  var sharedKwTotal  = 0, timeProxCount = 0, geoCount = 0, infraCount = 0, marketCount = 0;

  edges.forEach(function(e) {
    if (e.edgeType === 'causality')   hasCausality   = true;
    if (e.edgeType === 'dependency')  hasDependency  = true;
    if (e.edgeType === 'correlation') hasCorrelation = true;

    var otherId   = e.source === node.id ? e.target : e.source;
    var other     = state.graph.nodes.find(function(n) { return n.id === otherId; });
    if (!other) return;

    // Shared keywords
    (other.keywords || []).forEach(function(k) { if (myKws.has(k)) sharedKwTotal++; });

    // Time proximity (±72h)
    if (myTs && other.timestamp && Math.abs(other.timestamp - myTs) < 72 * 3600000) timeProxCount++;

    // Geographic entity links
    if (other.type === 'entity' && other.entityType === 'country') geoCount++;

    // Infrastructure/supply signals
    if (other.type === 'signal' && (other.signalType === 'supply' ||
        (other.label || '').indexOf('SUPPLY') !== -1 || (other.label || '').indexOf('TRADE') !== -1 ||
        (other.label || '').indexOf('MARITIME') !== -1)) infraCount++;

    // Market signals
    if (other.type === 'signal' && other.signalType === 'market') marketCount++;
  });

  if (hasCausality)           signals.push('Direct causality chain detected in event text');
  if (sharedKwTotal > 0)      signals.push('Shared keyword overlap · ' + sharedKwTotal + ' common terms');
  if (geoCount > 0)           signals.push('Shared geography · ' + geoCount + ' linked country node' + (geoCount > 1 ? 's' : ''));
  if (timeProxCount > 0)      signals.push('Shared event timeline · ' + timeProxCount + ' event' + (timeProxCount > 1 ? 's' : '') + ' within 72h window');
  if (infraCount > 0)         signals.push('Linked through logistics or supply chain infrastructure');
  if (marketCount > 0)        signals.push('Linked through market exposure signal');
  if (hasDependency && !hasCausality) signals.push('Structural dependency relationship');
  if (hasCorrelation && !hasCausality && !hasDependency) signals.push('Statistical co-movement detected in corpus');

  if (!signals.length) return '';

  var strength      = edges.length >= 4 ? 'HIGH' : edges.length >= 2 ? 'MODERATE' : 'LOW';
  var strengthColor = edges.length >= 4 ? '#ff9933' : edges.length >= 2 ? '#ffcc00' : '#4a7da8';
  var typeStr = [hasCausality?'CAUSALITY':'', hasDependency?'DEPENDENCY':'', hasCorrelation?'CORRELATION':''].filter(Boolean).join(' · ');

  var html = '<div style="margin-top:8px;padding:8px 10px;background:rgba(0,8,22,0.6);border:1px solid rgba(0,130,200,0.12);border-left:2px solid #00aaff">';
  html += '<div style="font-size:7.5px;letter-spacing:1.8px;color:#00aaff;margin-bottom:6px;font-weight:700">◈ CORRELATION BASIS</div>';
  html += '<div style="font-size:7.5px;color:#2a5a7a;margin-bottom:6px">STRENGTH: <span style="color:' + strengthColor + '">' + strength + '</span>  ·  ' + edges.length + ' EDGES  ·  <span style="color:#1a4060">' + typeStr + '</span></div>';
  signals.slice(0, 5).forEach(function(s) {
    html += '<div style="font-size:8px;color:#3a7a9a;margin-bottom:3px;padding-left:2px">✓ ' + s + '</div>';
  });
  html += '</div>';
  return html;
}

// ── Connection count: total unique nodes this node shares any edge with ─────────
// Walks structural edges, relationship edges, and manual edges in one pass.
function _connectionCount(node) {
  var seen = new Set();
  var sources = [state.graph.edges || [], state.relEdges || [], state.manualEdges || []];
  for (var si = 0; si < sources.length; si++) {
    var arr = sources[si];
    for (var ei = 0; ei < arr.length; ei++) {
      var e = arr[ei];
      if (e.source === node.id) seen.add(e.target);
      else if (e.target === node.id) seen.add(e.source);
    }
  }
  return seen.size;
}

// ── Country correlation score (0–100): how strongly is this node tied to the
// currently selected country? Deterministic. Six independent signal components.
// Returns null when not applicable (no country selected, or structural node type).
var _CORR_TYPES = { event: 1, vessel: 1, aircraft: 1, company: 1, news: 1, signal: 1, chokepoint: 1 };

function _countryCorrelationScore(node) {
  if (!state.selectedCountry || !_CORR_TYPES[node.type]) return null;

  var country       = state.selectedCountry;
  var countryNodeId = 'country:' + country;
  var cLow          = country.toLowerCase();
  var cFirst        = cLow.split(' ')[0];  // first word for partial match
  var score         = 0;

  // ── Component 1 (+35): Direct store index match ──────────────────────────────
  // Strongest signal — the event was ingested and indexed under this exact country.
  // Only applicable to event-type nodes (the only type that lives in store.byCountry).
  if (node.type === 'event') {
    var storeEvs = store.byCountry.get(country) || [];
    var evId     = node.id || (node._ev && node._ev.id);
    for (var si = 0; si < storeEvs.length; si++) {
      if (storeEvs[si].id === evId) { score += 35; break; }
    }
  }

  // ── Component 2 (+20 / +8): Country name in node text ────────────────────────
  // Moderate signal — node title, impact, or label explicitly references the country.
  var nodeText = ((node.label || '') + ' ' + (node.impact || '') +
                  ' ' + ((node._ev && node._ev.impact) || '')).toLowerCase();
  if (nodeText.indexOf(cLow) !== -1) {
    score += 20;
  } else if (cFirst.length > 4 && nodeText.indexOf(cFirst) !== -1) {
    score += 8;  // partial match (e.g. "United" in "United States")
  }

  // ── Component 3 (+10): Direct graph edge to country node ─────────────────────
  // Structural or relationship edge connects this node to the country node directly.
  var allE = (state.graph.edges || []).concat(state.relEdges || []).concat(state.manualEdges || []);
  for (var ei = 0; ei < allE.length; ei++) {
    var e = allE[ei];
    if ((e.source === node.id && e.target === countryNodeId) ||
        (e.target === node.id && e.source === countryNodeId)) {
      score += 10; break;
    }
  }

  // ── Component 4 (+5 per hit, max +15): Trade/keyword overlap ─────────────────
  // Node keywords match the country's known exports or imports.
  var cd = null;
  var cds = window.COUNTRIES_DATA || [];
  for (var ci = 0; ci < cds.length; ci++) {
    if (cds[ci].label === country) { cd = cds[ci]; break; }
  }
  if (cd && node.keywords && node.keywords.length) {
    var tradeTerms = [].concat(cd.topE || [], cd.topI || []).map(function(t){ return t.toLowerCase().trim(); });
    var tradeHits = 0;
    for (var ki = 0; ki < node.keywords.length; ki++) {
      var kw = node.keywords[ki];
      for (var ti = 0; ti < tradeTerms.length; ti++) {
        if (tradeTerms[ti].length > 3 && (tradeTerms[ti].indexOf(kw) !== -1 || kw.indexOf(tradeTerms[ti]) !== -1)) {
          tradeHits++; break;
        }
      }
    }
    score += Math.min(15, tradeHits * 5);
  }

  // ── Component 5 (+3–15): Risk severity ───────────────────────────────────────
  // Higher-severity events are inherently more operationally significant.
  var riskBoosts = { CRITICAL: 15, WARNING: 12, WATCH: 8, LOW: 3 };
  score += (riskBoosts[node.risk] || 3);

  // ── Component 6 (+0–5): Recency ──────────────────────────────────────────────
  // More recent events are more likely to reflect current conditions.
  var nodeTs = node.timestamp || (node._ev && node._ev.timestamp) || 0;
  if (nodeTs) {
    var ageDays = (Date.now() - nodeTs) / 86400000;
    if (ageDays <= 7)       score += 5;
    else if (ageDays <= 30) score += 3;
    else if (ageDays <= 90) score += 1;
  }

  return Math.min(100, Math.round(score));
}

// ── Render correlation score block (HTML string) ──────────────────────────────
function _correlationScoreHtml(node) {
  var score = _countryCorrelationScore(node);
  if (score === null) return '';

  var color  = score >= 80 ? '#ff2200' : score >= 60 ? '#ff8800' : score >= 40 ? '#ffcc00' : '#2a6a9a';
  var label  = score >= 80 ? 'HIGH'    : score >= 60 ? 'ELEVATED': score >= 40 ? 'MODERATE': 'LOW';

  return '<div style="margin-top:8px;padding:8px 10px;' +
    'background:rgba(6,2,18,0.65);border:1px solid rgba(80,40,140,0.2);border-left:2px solid ' + color + '">' +
    '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px;">' +
      '<span style="font-size:7.5px;letter-spacing:1.8px;color:#6a3a9a;font-weight:700;">◈ COUNTRY CORRELATION</span>' +
      '<span style="font-size:18px;font-weight:700;color:' + color + ';letter-spacing:-1px;line-height:1;">' + score + '</span>' +
    '</div>' +
    '<div style="height:3px;background:rgba(8,28,56,0.7);border-radius:2px;margin-bottom:4px;">' +
      '<div style="height:3px;width:' + score + '%;background:' + color + ';border-radius:2px;box-shadow:0 0 4px ' + color + ';"></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;">' +
      '<span style="font-size:7.5px;color:' + color + ';letter-spacing:1px;">' + label + '</span>' +
      '<span style="font-size:7px;color:#1a3a5a;">vs. ' + _esc(state.selectedCountry || '') + '</span>' +
    '</div>' +
  '</div>';
}

// ── Append indexed event list toggle to inspector body (country nodes only) ────
// All events in store.byCountry are rendered as clickable rows sorted by risk
// then timestamp. In-graph events are visually distinguished from store-only events
// (those outside the current time/type/risk filter).
function _appendIndexedEventList(body, countryLabel) {
  var allEvs = (store.byCountry.get(countryLabel) || []).slice();
  if (!allEvs.length) return;

  // Sort: CRITICAL → WARNING → WATCH → LOW, then newest first within each tier
  allEvs.sort(function(a, b) {
    var rd = (RISK_WEIGHTS[b.risk] || 0) - (RISK_WEIGHTS[a.risk] || 0);
    return rd !== 0 ? rd : b.timestamp - a.timestamp;
  });

  // Build a Set of node IDs currently present in the graph for in-graph highlighting
  var inGraphIds = new Set((state.graph.nodes || []).map(function(n) { return n.id; }));

  // ── Toggle button ─────────────────────────────────────────────────────────────
  var toggleBtn = document.createElement('button');
  toggleBtn.style.cssText =
    'width:100%;margin-top:1px;padding:5px 10px;' +
    'background:rgba(3,5,14,0.85);border:1px solid rgba(8,28,56,0.5);border-top:none;' +
    'color:#2a5070;font-size:7.5px;letter-spacing:1.4px;cursor:pointer;font-family:inherit;' +
    'display:flex;justify-content:space-between;align-items:center;' +
    'transition:color 120ms ease,background 120ms ease;';

  var labelSpan = document.createElement('span');
  labelSpan.textContent = 'SHOW ' + allEvs.length + ' INDEXED EVENTS';
  var arrowSpan = document.createElement('span');
  arrowSpan.textContent = '▶';
  arrowSpan.style.cssText = 'font-size:7px;transition:transform 120ms ease;';
  toggleBtn.appendChild(labelSpan);
  toggleBtn.appendChild(arrowSpan);

  // Hover state
  toggleBtn.addEventListener('mouseover', function(){ toggleBtn.style.color = '#4a90c0'; toggleBtn.style.background = 'rgba(8,16,40,0.9)'; });
  toggleBtn.addEventListener('mouseout',  function(){ toggleBtn.style.color = '#2a5070'; toggleBtn.style.background = 'rgba(3,5,14,0.85)'; });

  // ── Event list container ──────────────────────────────────────────────────────
  var listEl = document.createElement('div');
  listEl.style.cssText =
    'display:none;max-height:220px;overflow-y:auto;' +
    'background:rgba(2,4,12,0.92);border:1px solid rgba(8,28,56,0.5);border-top:none;';

  // Render up to 150 events (performance guard; store can grow large)
  var CAP = 150;
  allEvs.slice(0, CAP).forEach(function(ev) {
    var inGraph  = inGraphIds.has(ev.id);
    var riskCol  = RISK_COLORS[ev.risk] || '#4a7da8';
    var d        = new Date(ev.timestamp);
    var dateStr  = !isNaN(d) && ev.timestamp ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' \'' + String(d.getUTCFullYear()).slice(2) : '—';

    var evRow = document.createElement('div');
    evRow.style.cssText =
      'padding:5px 10px;border-bottom:1px solid rgba(8,24,48,0.4);cursor:pointer;' +
      'display:flex;align-items:flex-start;gap:6px;' +
      'background:' + (inGraph ? 'rgba(30,10,58,0.35)' : 'transparent') + ';';

    evRow.title = inGraph ? 'In current graph — click to inspect' : 'In store, outside current filter — click to inspect';

    evRow.innerHTML =
      '<span style="flex-shrink:0;font-size:7px;font-weight:700;color:' + riskCol + ';' +
        'min-width:50px;padding-top:1px;letter-spacing:.5px;">' + ev.risk + '</span>' +
      '<span style="flex:1;font-size:8px;color:' + (inGraph ? '#9ab0d0' : '#4a6a8a') + ';' +
        'line-height:1.4;word-break:break-word;">' +
        ev.title.slice(0, 58) + (ev.title.length > 58 ? '…' : '') +
      '</span>' +
      '<span style="flex-shrink:0;font-size:7px;color:#1a3050;padding-top:1px;white-space:nowrap;">' + dateStr + '</span>' +
      (inGraph ? '<span style="flex-shrink:0;font-size:7px;color:#5a2a8a;padding-top:1px;" title="Currently in graph">◈</span>' : '');

    // Hover highlight
    evRow.addEventListener('mouseover', function(){ evRow.style.background = 'rgba(20,8,48,0.6)'; });
    evRow.addEventListener('mouseout',  function(){ evRow.style.background = inGraph ? 'rgba(30,10,58,0.35)' : 'transparent'; });

    // Click: inspect this event. If it's in the graph, select it and re-render.
    evRow.addEventListener('click', (function(ev_) {
      return function() {
        var graphNode = null;
        var gnodes = state.graph.nodes;
        for (var gi = 0; gi < gnodes.length; gi++) {
          if (gnodes[gi].id === ev_.id) { graphNode = gnodes[gi]; break; }
        }
        if (graphNode) {
          selectedNode = graphNode;
          showInspector(graphNode);
          renderGraph();
        } else {
          // Store-only event: synthesise an inspector-compatible node so all
          // fields (age, severity, relationships, correlation score) render correctly.
          showInspector({
            id:        ev_.id,
            type:      'event',
            risk:      ev_.risk,
            eventType: ev_.type,
            label:     ev_.title,
            timestamp: ev_.timestamp,
            impact:    ev_.impact,
            source:    ev_.source,
            keywords:  ev_.keywords || [],
            _ev:       ev_,
          });
        }
      };
    }(ev)));

    listEl.appendChild(evRow);
  });

  // Overflow notice if store exceeds CAP
  if (allEvs.length > CAP) {
    var moreEl = document.createElement('div');
    moreEl.style.cssText = 'padding:5px 10px;font-size:7px;color:#1a3050;text-align:center;font-style:italic;';
    moreEl.textContent = '+ ' + (allEvs.length - CAP) + ' additional events in store';
    listEl.appendChild(moreEl);
  }

  // ── Toggle logic ──────────────────────────────────────────────────────────────
  var _listOpen = false;
  toggleBtn.addEventListener('click', function() {
    _listOpen = !_listOpen;
    listEl.style.display     = _listOpen ? 'block' : 'none';
    arrowSpan.textContent    = _listOpen ? '▼' : '▶';
    labelSpan.textContent    = (_listOpen ? 'HIDE ' : 'SHOW ') + allEvs.length + ' INDEXED EVENTS';
  });

  body.appendChild(toggleBtn);
  body.appendChild(listEl);
}

// ── Inspector panel ─────────────────────────────────────────────────────────────
function showInspector(node) {
  var body = document.getElementById('nw-insp-body');
  if (!body) return;
  if (!node) {
    body.innerHTML = '<div id="nw-insp-placeholder">CLICK A NODE<br>TO INSPECT<br><span style="font-size:7px;color:#2a2a4a;margin-top:8px;display:block">RIGHT-CLICK FOR OPTIONS</span></div>';
    return;
  }
  switchTab('inspect');
  var _node = node; // capture for closure

  if (node.type === 'country') {
    var cd = node.data;
    var dynCount = _dynamicEventCount(node.label);
    var storeCount = (store.byCountry.get(node.label) || []).length;
    var evCountLabel = dynCount + ' events' + (dynCount > storeCount ? ' <span style="color:#3a7a5a;font-size:8px">(+' + (dynCount - storeCount) + ' from linked sources)</span>' : '');
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:var(--nw-purple);margin-bottom:8px">◈ COUNTRY NODE</div>',
      field('COUNTRY', node.label),
      cd ? field('RISK SCORE', '<span class="nw-risk-badge" style="background:' + hexToRgba(RISK_COLORS[cd.risk]||'#4a7da8',0.18) + ';color:' + (RISK_COLORS[cd.risk]||'#4a7da8') + ';border:1px solid ' + (RISK_COLORS[cd.risk]||'#4a7da8') + '">' + cd.risk + ' · ' + (cd.score||'—') + '</span>') : '',
      cd ? field('GDP', cd.gdp || '—') : '',
      cd ? field('TOP EXPORTS', (cd.topE||[]).join(', ') || '—') : '',
      cd ? field('TOP IMPORTS', (cd.topI||[]).join(', ') || '—') : '',
      field('EVENTS INDEXED', evCountLabel),
    ].join('');
    body.innerHTML += _nodeSnapshot(node);

  } else if (node.type === 'topic') {
    var evList = (state.graph.nodes || []).filter(function(n){ return n.type==='event' && (n.topics||[]).indexOf(node.label) !== -1; });
    var topRelEdgeCount = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; }).length;
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#5a2a8a;margin-bottom:8px">⬡ TOPIC CLUSTER</div>',
      field('KEYWORD', node.label),
      field('EVENT COUNT', node.count),
      topRelEdgeCount ? field('RELATIONSHIPS', topRelEdgeCount + ' detected edges') : '',
      field('LINKED EVENTS', evList.map(function(e){ return '<div style="margin-bottom:4px;color:#8899bb;font-size:9px">· ' + e.label.slice(0,52) + '</div>'; }).join('')),
    ].join('');
    body.innerHTML += _nodeSnapshot(node);

  } else if (node.type === 'entity') {
    var relEdgeCount = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; }).length;
    // Count events linked to this entity
    var entLinkedEvs = (state.relEdges || []).filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.type === 'event';
    });
    var entLinkedCountries = (state.relEdges || []).filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && (other.type === 'country' || (other.type === 'entity' && other.entityType === 'country'));
    });
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#b464ff;margin-bottom:8px">◆ ENTITY — ' + (node.entityType || '').toUpperCase() + '</div>',
      field('NAME', node.label),
      field('TYPE', node.entityType || '—'),
      field('RELATIONSHIPS', relEdgeCount + ' detected edges'),
      entLinkedEvs.length    ? field('LINKED EVENTS',   entLinkedEvs.length + ' active event connections') : '',
      entLinkedCountries.length ? field('LINKED REGIONS', entLinkedCountries.length + ' geographic connections') : '',
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else if (node.type === 'market_ticker') {
    var mpd = node._payload || {};
    var mcolor = nodeColor(node);
    var mpct = mpd.change_percent;
    var mpctStr = mpct != null ? (mpct > 0 ? '+' : '') + mpct.toFixed(2) + '%' : '—';
    var mpctCol = mpct == null ? '#c5d7e8' : mpct > 0 ? '#00ff88' : mpct < 0 ? '#ff0044' : '#c5d7e8';
    function mfmt(v, dec, pre) { return v != null ? (pre||'') + parseFloat(v).toFixed(dec||2) : '—'; }
    function mfmtBig(v) {
      if (v == null) return '—';
      if (v >= 1e12) return '$' + (v/1e12).toFixed(2) + 'T';
      if (v >= 1e9)  return '$' + (v/1e9).toFixed(2)  + 'B';
      if (v >= 1e6)  return '$' + (v/1e6).toFixed(2)  + 'M';
      return '$' + v.toFixed(0);
    }
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:' + mcolor + ';margin-bottom:8px">◈ MARKET TICKER</div>',
      field('TICKER',     '<span style="color:' + mcolor + ';font-size:12px;font-weight:700">' + node.label + '</span>'),
      field('NAME',       mpd.name || '—'),
      field('PRICE',      mfmt(mpd.price, 2, '$') + '  <span style="color:' + mpctCol + '">' + mpctStr + '</span>'),
      field('MARKET CAP', mfmtBig(mpd.market_cap)),
      field('P/E RATIO',  mpd.pe_ratio != null ? mpd.pe_ratio.toFixed(2) : '—'),
      field('EPS',        mfmt(mpd.eps, 2, '$')),
      field('50 DMA',     mfmt(mpd.ma_50, 2, '$')),
      field('200 DMA',    mfmt(mpd.ma_200, 2, '$')),
      mpd.context && mpd.context.sector   ? field('SECTOR',   mpd.context.sector)   : '',
      mpd.context && mpd.context.country  ? field('COUNTRY',  mpd.context.country)  : '',
      mpd.context && mpd.context.asset_class ? field('ASSET CLASS', mpd.context.asset_class.toUpperCase()) : '',
    ].join('');

  } else if (node.type === 'signal') {
    var sigEdgesInspect = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    var sigCritCount  = sigEdgesInspect.filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.risk === 'CRITICAL';
    }).length;
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:' + (node.signalType==='market'?'#ff9933':'#ff4488') + ';margin-bottom:8px">⬡ ' + (node.signalType||'').toUpperCase() + ' SIGNAL</div>',
      field('LABEL', node.label),
      field('TRIGGERED BY', (node.keywords || []).join(', ') || '—'),
      sigEdgesInspect.length ? field('ACTIVE CONNECTIONS', sigEdgesInspect.length + ' event links') : '',
      sigCritCount ? field('CRITICAL LINKS', sigCritCount + ' CRITICAL severity events') : '',
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else if (node.type === 'note') {
    var noteLinks = (state.manualEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#ffe066;margin-bottom:8px">📝 NOTE NODE</div>',
      field('TEXT', '<span style="color:#ffe066;line-height:1.6">' + (node.noteText || node.label) + '</span>'),
      field('MANUAL LINKS', noteLinks.length ? noteLinks.length + ' connected node(s)' : '<span style="opacity:0.5">None — use LINK NODES to connect</span>'),
    ].join('');

  } else if (node.type === 'vessel') {
    var vesLinks = (state.relEdges||[]).concat(state.manualEdges||[]).filter(function(e){ return e.source===node.id||e.target===node.id; });
    var vesAnalyticsHtml = buildChokepointAnalyticsHtml(node.label);
    // Vessel type from node data
    var vesType  = node.vesselType || node.badge || node.typeCategory || '—';
    var vesFlag  = node.flag || node.flagState || '—';
    var vesRegion = node.region || node.lastRegion || '—';
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#00ccff;margin-bottom:8px">🚢 VESSEL / ROUTE</div>',
      field('NAME', node.label),
      field('VESSEL TYPE', vesType !== '—' ? '<span style="color:#00ccff">' + vesType.toUpperCase() + '</span>' : '—'),
      vesFlag !== '—' ? field('FLAG STATE', vesFlag) : '',
      vesRegion !== '—' ? field('LAST REGION', vesRegion) : '',
      vesLinks.length ? field('RELATIONSHIPS', vesLinks.length + ' edges') : '',
      vesAnalyticsHtml,
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else if (node.type === 'aircraft') {
    var acLinks = (state.relEdges||[]).concat(state.manualEdges||[]).filter(function(e){ return e.source===node.id||e.target===node.id; });
    var ftLabel = { commercial:'COMMERCIAL', cargo:'CARGO', military:'MILITARY', unknown:'UNCLASSIFIED' };
    var ftCol   = { commercial:'#66ddff', cargo:'#4488ff', military:'#ff4444', unknown:'#5577aa' };
    var ft4 = (node.flightType || 'unknown').toLowerCase();
    // Related aviation disruptions from graph signals
    var acDisruptLinks = acLinks.filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && (other.type === 'signal' || (other.type === 'event' && other.eventType === 'SUPPLY_CHAIN'));
    }).length;
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#66ddff;margin-bottom:8px">✈ FLIGHT NODE</div>',
      field('CALLSIGN / ID', node.label),
      field('AIRCRAFT CLASS', '<span style="color:' + (ftCol[ft4]||'#5577aa') + '">' + (ftLabel[ft4]||ft4.toUpperCase()) + '</span>'),
      node.operator  ? field('OPERATOR', node.operator)           : '',
      node.region    ? field('LAST REGION', node.region)          : '',
      node.altitude != null ? field('ALTITUDE', node.altitude + ' ft') : '',
      node.lat != null && node.lon != null ? field('POSITION', node.lat.toFixed(2) + '°, ' + node.lon.toFixed(2) + '°') : '',
      acLinks.length ? field('RELATIONSHIPS', acLinks.length + ' edges') : '',
      acDisruptLinks ? field('AVIATION DISRUPTIONS', acDisruptLinks + ' linked disruption signals') : '',
    ].join('');
    body.innerHTML += _nodeSnapshot(node);

  } else if (node.type === 'chokepoint') {
    var cpAnalyticsHtml = buildChokepointAnalyticsHtml(node.label);
    var cpLinks = (state.relEdges||[]).concat(state.manualEdges||[]).filter(function(e){ return e.source===node.id||e.target===node.id; });
    // Infrastructure impacts: events linked to this chokepoint
    var cpLinkedEvs = cpLinks.filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.type === 'event';
    });
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#ffaa33;margin-bottom:8px">◇ CHOKEPOINT</div>',
      field('NAME', node.label),
      field('RISK', '<span style="color:' + (RISK_COLORS[node.risk]||'#4a7da8') + '">' + (node.risk || '—') + '</span>'),
      node.traffic ? field('TRAFFIC', node.traffic) : '',
      node.volume  ? field('VOLUME',  node.volume)  : '',
      node.status  ? field('STATUS',  '<span style="color:#c0ddf8;line-height:1.5">' + node.status + '</span>') : '',
      cpLinks.length ? field('RELATIONSHIPS', cpLinks.length + ' edges') : '',
      cpLinkedEvs.length ? field('CONNECTED EVENTS', cpLinkedEvs.length + ' active disruption events') : '',
      cpAnalyticsHtml,
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else if (node.type === 'company') {
    var coLinks = (state.relEdges||[]).concat(state.manualEdges||[]).filter(function(e){ return e.source===node.id||e.target===node.id; });
    // Connected countries via relEdges
    var coCountries = coLinks.map(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      return state.graph.nodes.find(function(n){ return n.id === otherId && (n.type === 'country' || (n.type === 'entity' && n.entityType === 'country')); });
    }).filter(Boolean);
    // Related event exposures
    var coEventLinks = coLinks.filter(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.type === 'event';
    });
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#ff99aa;margin-bottom:8px">🏢 COMPANY</div>',
      field('NAME', node.label),
      field('INDUSTRY', node.industry || node.sector || node.entityType || 'CORPORATE'),
      coLinks.length    ? field('DETECTED EDGES', coLinks.length + ' relationships') : '',
      coEventLinks.length ? field('RELATED EVENTS', coEventLinks.length + ' active event exposures') : '',
      coCountries.length  ? field('CONNECTED COUNTRIES', coCountries.slice(0,4).map(function(n){ return n.label; }).join(', ')) : '',
      node.keywords && node.keywords.length ? field('OPERATIONAL SECTORS', node.keywords.slice(0,4).join(', ')) : '',
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else if (node.type === 'news') {
    var newsLinks = (state.relEdges||[]).filter(function(e){ return e.source===node.id||e.target===node.id; });
    // Related entities (company/country nodes linked to this news)
    var newsEntities = newsLinks.map(function(e){
      var otherId = e.source === node.id ? e.target : e.source;
      return state.graph.nodes.find(function(n){ return n.id === otherId && (n.type === 'entity' || n.type === 'country'); });
    }).filter(Boolean);
    // Regional focus — country entities linked
    var newsFocusRegions = newsEntities.filter(function(n){ return n.type === 'country' || n.entityType === 'country'; });
    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:#cc88ff;margin-bottom:8px">📰 NEWS ARTICLE</div>',
      field('HEADLINE', '<span style="color:#c0ddf8;line-height:1.5">' + node.label + '</span>'),
      node.source ? field('SOURCE', node.source) : '',
      newsLinks.length   ? field('RELATED ENTITIES', newsLinks.length + ' graph connections') : '',
      newsFocusRegions.length ? field('REGIONAL FOCUS', newsFocusRegions.slice(0,3).map(function(n){ return n.label; }).join(', ')) : '',
      node.keywords && node.keywords.length ? field('TOPIC CLUSTER', '<div class="nw-kw-wrap">' + node.keywords.map(function(k){ return '<span class="nw-kw">' + k + '</span>'; }).join('') + '</div>') : '',
    ].join('');
    body.innerHTML += _nodeSnapshot(node);
    body.innerHTML += _correlationBasis(node);

  } else {
    // Event node — show relationship edges + intelligence snapshot
    var ev = node._ev || {};
    var ts = ev.timestamp ? new Date(ev.timestamp).toISOString().replace('T',' ').slice(0,16) + ' UTC' : '—';
    var evRelEdges = (state.relEdges || []).filter(function(e){ return e.source === node.id || e.target === node.id; });
    var relHtml = evRelEdges.map(function(e) {
      var et = EDGE_TYPES[e.edgeType] || {};
      var other = e.source === node.id ? e.target : e.source;
      var otherN = state.graph.nodes.find(function(n){ return n.id === other; });
      var otherLabel = otherN ? otherN.label : other;
      return '<div style="margin-bottom:3px;font-size:8px"><span class="nw-edge-badge ' + (et.badge||'') + '">' + (et.label||e.edgeType) + '</span><span style="color:#8899bb">' + otherLabel.slice(0,36) + '</span></div>';
    }).join('');

    // Event age
    var evAge = '—';
    if (node.timestamp) {
      var ageMs  = Date.now() - node.timestamp;
      var ageDays = Math.floor(ageMs / 86400000);
      var ageHrs  = Math.floor(ageMs / 3600000);
      evAge = ageDays >= 1 ? ageDays + ' day' + (ageDays !== 1 ? 's' : '') + ' ago' : ageHrs + ' hour' + (ageHrs !== 1 ? 's' : '') + ' ago';
    }

    // Linked regions (entity country nodes connected to this event)
    var linkedRegionNodes = evRelEdges.map(function(e) {
      var otherId = e.source === node.id ? e.target : e.source;
      return state.graph.nodes.find(function(n){ return n.id === otherId && n.type === 'entity' && n.entityType === 'country'; });
    }).filter(Boolean);
    var linkedRegionsHtml = linkedRegionNodes.length
      ? linkedRegionNodes.slice(0,4).map(function(n){ return '<span class="nw-kw" style="border-color:#b464ff30">' + n.label + '</span>'; }).join('')
      : '';

    // Related active events (other event nodes sharing this event's edges)
    var relActiveEvCount = evRelEdges.filter(function(e) {
      var otherId = e.source === node.id ? e.target : e.source;
      var other = state.graph.nodes.find(function(n){ return n.id === otherId; });
      return other && other.type === 'event';
    }).length;

    body.innerHTML = [
      '<div style="font-size:8px;letter-spacing:2px;color:' + (RISK_COLORS[node.risk]||'#4a7da8') + ';margin-bottom:8px">' + node.risk + ' · ' + (node.eventType||'') + '</div>',
      field('TITLE', '<span style="color:#c0ddf8;line-height:1.5">' + node.label + '</span>'),
      field('DATE', ts),
      field('EVENT AGE', evAge),
      field('SEVERITY', '<span style="color:' + (RISK_COLORS[node.risk]||'#4a7da8') + '">' + (node.risk||'—') + '</span>'),
      ev.impact ? field('IMPACT', '<span style="line-height:1.5">' + ev.impact + '</span>') : '',
      ev.source ? field('SOURCE', ev.source) : '',
      relActiveEvCount ? field('RELATED ACTIVE EVENTS', relActiveEvCount + ' events share relationship links') : '',
      linkedRegionsHtml ? field('LINKED REGIONS', '<div class="nw-kw-wrap">' + linkedRegionsHtml + '</div>') : '',
      node.keywords && node.keywords.length ? field('KEYWORDS',
        '<div class="nw-kw-wrap">' + node.keywords.map(function(k){ return '<span class="nw-kw">' + k + '</span>'; }).join('') + '</div>'
      ) : '',
      evRelEdges.length ? field('RELATIONSHIPS', relHtml) : '',
    ].join('');
    body.innerHTML += _correlationBasis(node);
  }

  // Connection count — all nodes
  var _connCount = _connectionCount(node);
  if (_connCount > 0) {
    var _connEl = document.createElement('div');
    _connEl.className = 'nw-insp-field';
    _connEl.innerHTML = '<div class="nw-insp-key">CONNECTED NODES</div>' +
      '<div class="nw-insp-val" style="font-size:11px;color:#4a7a9a">' + _connCount +
      ' connection' + (_connCount !== 1 ? 's' : '') + '</div>';
    body.appendChild(_connEl);
  }

  // Correlation score — event-like nodes only
  var _corrHtml = _correlationScoreHtml(node);
  if (_corrHtml) {
    var _corrEl = document.createElement('div');
    _corrEl.innerHTML = _corrHtml;
    body.appendChild(_corrEl);
  }

  // Indexed event list — country nodes only
  if (node.type === 'country') {
    _appendIndexedEventList(body, node.label);
  }

  // Append note-link button for all inspectable nodes
  var noteBtn = document.createElement('button');
  noteBtn.className = 'nw-note-link-btn';
  noteBtn.textContent = '📝 ADD TO NOTES';
  noteBtn.onclick = function(){ noteForNode(_node); };
  body.appendChild(noteBtn);
}

function field(label, value) {
  if (!value && value !== 0) return '';
  return '<div class="nw-insp-field"><div class="nw-insp-key">' + label + '</div><div class="nw-insp-val">' + value + '</div></div>';
}

// ── Timeline renderer — graph events + GDELT feed, sorted by timestamp DESC ───
var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function renderTimeline() {
  var el = document.getElementById('nw-timeline-body');
  if (!el) return;

  // 1. Graph event nodes
  var items = state.graph.nodes
    .filter(function(n){ return n.type === 'event' && n.timestamp; })
    .slice();

  // 2. GDELT articles from localStorage — pulled as external timeline entries
  try {
    var gc = localStorage.getItem('argus_gdelt_v3');
    if (gc) {
      var gd = JSON.parse(gc);
      var arts = Array.isArray(gd) ? gd : (gd.events || gd.articles || []);
      var seen = new Set(items.map(function(n){ return n.label.slice(0, 30); }));
      (Array.isArray(arts) ? arts : []).slice(0, 20).forEach(function(a) {
        var t = a.title || a.TITLE || '';
        if (!t || seen.has(t.slice(0, 30))) return;
        seen.add(t.slice(0, 30));
        // Parse GDELT seendate format: YYYYMMDDTHHMMSSZ
        var rawDate = a.seendate || '';
        var ts = 0;
        if (rawDate.length >= 15) {
          try { ts = new Date(rawDate.slice(0,4)+'-'+rawDate.slice(4,6)+'-'+rawDate.slice(6,8)+'T'+rawDate.slice(9,11)+':'+rawDate.slice(11,13)+':00Z').getTime(); } catch(_){}
        }
        items.push({ label: t, timestamp: ts || Date.now(), risk: 'WATCH', eventType: 'GDELT', _gdelt: true });
      });
    }
  } catch(_){}

  // Sort newest first
  items.sort(function(a, b){ return b.timestamp - a.timestamp; });

  if (!items.length) {
    el.innerHTML = '<div style="padding:24px;text-align:center;font-size:8px;letter-spacing:2px;color:var(--color-text-faint);line-height:2">NO EVENTS<br>RUN ⬡ SCAN RELATIONS</div>';
    return;
  }

  el.innerHTML = '';
  // Header
  var hdr = document.createElement('div');
  hdr.className = 'nw-tl-header';
  hdr.textContent = items.length + ' TIMELINE ENTRIES';
  el.appendChild(hdr);

  items.forEach(function(n) {
    var d   = n.timestamp ? new Date(n.timestamp) : null;
    var ts  = (d && !isNaN(d))
      ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0')
      : '—';
    var col = RISK_COLORS[n.risk] || '#4a7da8';
    var badge = n._injected ? '<span class="nw-tl-scan">SCAN</span>'
              : n._gdelt    ? '<span class="nw-tl-scan">GDELT</span>'
              : '';

    var row = document.createElement('div');
    row.className = 'nw-tl-row' + (n.id ? ' is-clickable' : '');
    row.innerHTML =
      '<div class="nw-tl-ts">' + ts + '</div>' +
      '<div class="nw-tl-dot" style="background:' + hexToRgba(col,0.5) + ';border:1px solid ' + col + '"></div>' +
      '<div><div class="nw-tl-title">' + (n.label.length > 50 ? n.label.slice(0,48) + '…' : n.label) + badge + '</div>' +
      '<div class="nw-tl-meta">' + (n.eventType || 'POLICY') + ' · ' + n.risk + '</div></div>';

    // Click → select node on canvas + open inspector
    if (n.id) {
      (function(node){ row.addEventListener('click', function() {
        selectedNode = node;
        showInspector(node);
        renderGraph();
      }); }(n));
    }
    el.appendChild(row);
  });
}

// ── Notes persistence (localStorage, keyed by country + date) ────────────────
function notesKey() {
  return 'argus_nw_notes_' + (state.selectedCountry || 'global').toLowerCase().replace(/\s+/g,'_') + '_' + new Date().toISOString().slice(0,10);
}
function saveNotes(text) {
  try { localStorage.setItem(notesKey(), text); } catch(_){}
}
function loadNotes() {
  try { return localStorage.getItem(notesKey()) || ''; } catch(_){ return ''; }
}

// ── Export engine ─────────────────────────────────────────────────────────────
function exportGraph(fmt) {
  var nodes   = state.graph.nodes;
  var edges   = state.graph.edges;
  var relEdges = state.relEdges || [];
  var notes   = (document.getElementById('nw-notes-input') || {}).value || '';
  var ts      = new Date().toISOString().replace('T',' ').slice(0,16) + ' UTC';
  var country = state.selectedCountry || 'Unknown';

  // Timeline sorted for export
  var timeline = nodes
    .filter(function(n){ return n.type==='event' && n.timestamp; })
    .sort(function(a,b){ return b.timestamp - a.timestamp; })
    .map(function(n){
      return { timestamp: new Date(n.timestamp).toISOString(), title: n.label, type: n.eventType, risk: n.risk };
    });

  if (fmt === 'json') {
    var exportObj = {
      meta: { generated: ts, country: country, version: 'ArgusNeuralWeb-v2' },
      nodes: nodes.map(function(n){
        return { id: n.id, type: n.type, label: n.label, risk: n.risk || null,
                 eventType: n.eventType || null, entityType: n.entityType || null,
                 signalType: n.signalType || null, keywords: n.keywords || [] };
      }),
      edges: relEdges.map(function(e){
        return { source: e.source, target: e.target, type: e.edgeType, weight: e.weight };
      }),
      timeline: timeline,
      notes: notes,
    };
    downloadFile('argus-graph-' + country.replace(/\s+/g,'-').toLowerCase() + '-' + new Date().toISOString().slice(0,10) + '.json',
      JSON.stringify(exportObj, null, 2), 'application/json');

  } else {
    // Markdown — Obsidian-compatible, complete field export (Phase 4)
    var lines = [
      '# ARGUS Neural Web — ' + country,
      '**Generated:** ' + ts,
      '**Nodes:** ' + nodes.length + '  |  **Relationships:** ' + relEdges.length + '  |  **Country:** ' + country,
      '',
      '---',
      '',
      '## Intelligence Summary',
      '',
    ];

    // Country node — full field export
    var cNode = nodes.find(function(n){ return n.type === 'country'; });
    if (cNode) {
      var cData = cNode.data;
      lines.push('### ' + cNode.label);
      if (cData) {
        lines.push('- **Risk Score:** ' + (cData.risk || '—') + (cData.score ? ' · ' + cData.score : ''));
        lines.push('- **GDP:** ' + (cData.gdp || '—'));
        lines.push('- **Top Exports:** ' + ((cData.topE||[]).join(', ') || '—'));
        lines.push('- **Top Imports:** ' + ((cData.topI||[]).join(', ') || '—'));
      }
      lines.push('- **Events Indexed:** ' + _dynamicEventCount(cNode.label));
      lines.push('');

      // Operational snapshot for country
      var cEvs = store.byCountry.get(cNode.label) || [];
      var cGraphEvs = nodes.filter(function(n){ return n.type === 'event'; });
      var cTypeCounts = {};
      cEvs.forEach(function(ev){ cTypeCounts[ev.type] = (cTypeCounts[ev.type]||0)+1; });
      var cTopType = Object.keys(cTypeCounts).sort(function(a,b){ return cTypeCounts[b]-cTypeCounts[a]; })[0];
      var cCritEvs = cGraphEvs.filter(function(n){ return n.risk === 'CRITICAL'; });
      lines.push('**Operational Snapshot:**');
      if (cCritEvs.length) lines.push('- Critical Driver: ' + cCritEvs[0].label);
      if (cTopType) lines.push('- Dominant Category: ' + cTopType.replace(/_/g,' ') + ' (' + cTypeCounts[cTopType] + ' events)');
      lines.push('');
    }

    // Event nodes — full field export
    var evNodes2 = nodes.filter(function(n){ return n.type === 'event'; });
    if (evNodes2.length) {
      lines.push('## Events\n');
      evNodes2.forEach(function(n) {
        var ev2 = n._ev || {};
        var evTs = n.timestamp ? new Date(n.timestamp).toISOString().replace('T',' ').slice(0,16) + ' UTC' : '—';
        var ageDays2 = n.timestamp ? Math.floor((Date.now() - n.timestamp) / 86400000) : null;
        lines.push('### ' + n.label);
        lines.push('- **Risk:** ' + (n.risk || '—') + '  |  **Type:** ' + (n.eventType || '—'));
        lines.push('- **Date:** ' + evTs + (ageDays2 !== null ? '  |  **Age:** ' + ageDays2 + ' days' : ''));
        if (ev2.impact) lines.push('- **Impact:** ' + ev2.impact);
        if (ev2.source) lines.push('- **Source:** ' + ev2.source);
        if (n.keywords && n.keywords.length) lines.push('- **Keywords:** ' + n.keywords.join(', '));
        // Relationship edges for this node
        var nEdges = relEdges.filter(function(e){ return e.source === n.id || e.target === n.id; });
        if (nEdges.length) {
          lines.push('- **Relationships:**');
          nEdges.forEach(function(e) {
            var otherId = e.source === n.id ? e.target : e.source;
            var otherN = nodes.find(function(x){ return x.id === otherId; });
            if (otherN) lines.push('  - [' + (EDGE_TYPES[e.edgeType]||{}).label + '] ' + otherN.label + ' (weight: ' + (e.weight||1).toFixed(1) + ')');
          });
        }
        lines.push('');
      });
    }

    // Entity nodes
    var entityNodes = nodes.filter(function(n){ return n.type === 'entity'; });
    if (entityNodes.length) {
      lines.push('## Entities\n');
      entityNodes.forEach(function(n) {
        var entEdgeCount = relEdges.filter(function(e){ return e.source === n.id || e.target === n.id; }).length;
        lines.push('- **' + n.label + '** `' + (n.entityType||'entity').toUpperCase() + '`' +
          (n.risk ? ' · ' + n.risk : '') +
          (entEdgeCount ? ' · ' + entEdgeCount + ' edges' : ''));
      });
      lines.push('');
    }

    // Signal nodes
    var signalNodes = nodes.filter(function(n){ return n.type === 'signal'; });
    if (signalNodes.length) {
      lines.push('## Signals\n');
      signalNodes.forEach(function(n) {
        var sigEdgeCnt = relEdges.filter(function(e){ return e.source === n.id || e.target === n.id; }).length;
        lines.push('- **' + n.label + '** `' + (n.signalType||'').toUpperCase() + '` · risk: ' + (n.risk||'—'));
        if (n.keywords && n.keywords.length) lines.push('  - Triggered by: ' + n.keywords.join(', '));
        if (sigEdgeCnt) lines.push('  - Active connections: ' + sigEdgeCnt);
      });
      lines.push('');
    }

    // Chokepoint + vessel nodes
    var cpVesNodes = nodes.filter(function(n){ return n.type === 'chokepoint' || n.type === 'vessel'; });
    if (cpVesNodes.length) {
      lines.push('## Chokepoints / Vessels\n');
      cpVesNodes.forEach(function(n) {
        lines.push('- **' + n.label + '** `' + n.type.toUpperCase() + '`' + (n.risk ? ' · ' + n.risk : '') +
          (n.traffic ? ' · ' + n.traffic : '') + (n.status ? ' — ' + n.status : ''));
      });
      lines.push('');
    }

    // Full relationship table with correlation basis
    if (relEdges.length) {
      lines.push('## Relationships\n');
      var edgeGroups = { causality: [], correlation: [], dependency: [], manual: [] };
      relEdges.forEach(function(e){ if (edgeGroups[e.edgeType]) edgeGroups[e.edgeType].push(e); });

      ['causality','correlation','dependency','manual'].forEach(function(et) {
        if (!edgeGroups[et].length) return;
        lines.push('### ' + et.toUpperCase() + ' (' + edgeGroups[et].length + ')');
        edgeGroups[et].forEach(function(e) {
          var srcN = nodes.find(function(n){ return n.id === e.source; });
          var tgtN = nodes.find(function(n){ return n.id === e.target; });
          if (srcN && tgtN) {
            lines.push('- [[' + srcN.label.slice(0,60) + ']] → [[' + tgtN.label.slice(0,60) + ']]' +
              ' (weight: ' + (e.weight||1).toFixed(1) + ')');
          }
        });
        lines.push('');
      });
    }

    // Timeline
    if (timeline.length) {
      lines.push('## Timeline\n');
      timeline.forEach(function(e) {
        lines.push('- **' + e.timestamp.slice(0,10) + '** `' + e.risk + '` ' + e.title + ' (' + e.type + ')');
      });
      lines.push('');
    }

    // Analyst notes
    if (notes.trim()) {
      lines.push('## Analyst Notes\n');
      lines.push(notes.trim());
      lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by [[ARGUS Intelligence Terminal]] · ArgusNeuralWeb-v2*');
    downloadFile('argus-' + country.replace(/\s+/g,'-').toLowerCase() + '-' + new Date().toISOString().slice(0,10) + '.md',
      lines.join('\n'), 'text/markdown');
  }
}

function downloadFile(filename, content, mime) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('#nw-intel-tabs .nw-tab-btn').forEach(function(btn) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#nw-intel-panel .nw-tab-pane').forEach(function(pane) {
    pane.classList.toggle('is-active', pane.id === 'nw-pane-' + tab);
  });
  if (tab === 'timeline') renderTimeline();
  // 'analytics' tab now shows INTEL domain content (Phase B) — no renderAnalytics() call
  if (tab === 'notes') {
    var ta = document.getElementById('nw-notes-input');
    if (ta && !ta.value) ta.value = loadNotes();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEURAL WEB — CHOKEPOINT ANALYTICS + FLIGHT INTEGRATION
// Additive layer: haversine spatial filter → category distribution → UI render
// ═══════════════════════════════════════════════════════════════════════════════

// ── Haversine great-circle distance in km ─────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Collect current tracking snapshot ────────────────────────────────────────
// Returns { ships: [{lat,lon,category},...], flights: [{lat,lon,category},...] }
function collectTrackingSnapshot() {
  var ships   = [];
  var flights = [];

  // From live markers (most up-to-date)
  var acMarkers  = window._aircraftMarkers || [];
  var shMarkers  = window._vesselMarkers   || [];

  acMarkers.forEach(function(s) {
    var ud = s && s.userData;
    if (ud && ud.isAircraft && ud.lat != null && ud.lon != null) {
      flights.push({ lat: ud.lat, lon: ud.lon, category: (ud.flightType || 'unknown').toLowerCase() });
    }
  });

  shMarkers.forEach(function(s) {
    var ud = s && s.userData;
    if (ud && ud.isShip && ud.lat != null && ud.lon != null) {
      ships.push({ lat: ud.lat, lon: ud.lon, category: (ud.typeCategory || 'other').toLowerCase() });
    }
  });

  // Supplement from normalized tracking data if markers are sparse
  if ((ships.length + flights.length) === 0) {
    (window._trackingData || []).forEach(function(t) {
      if (t.lat == null || t.lon == null) return;
      if (t.type === 'aircraft') {
        flights.push({ lat: t.lat, lon: t.lon, category: (t.flightType || 'unknown').toLowerCase() });
      } else if (t.type === 'vessel') {
        ships.push({ lat: t.lat, lon: t.lon, category: (t.typeCategory || 'other').toLowerCase() });
      }
    });
  }

  // Supplement flights from localStorage cache
  if (!flights.length) {
    try {
      var lsRaw = localStorage.getItem('argus_traffic_v4');
      if (lsRaw) {
        var lsJson = JSON.parse(lsRaw);
        var lsAc   = Array.isArray(lsJson) ? lsJson : (Array.isArray(lsJson.aircraft) ? lsJson.aircraft : []);
        lsAc.forEach(function(ac) {
          if (ac.lat != null && ac.lon != null) {
            flights.push({ lat: ac.lat, lon: ac.lon, category: (ac.flightType || 'unknown').toLowerCase() });
          }
        });
      }
    } catch(_){}
  }

  return { ships: ships, flights: flights };
}

// ── Category distribution → percentage map ────────────────────────────────────
function categoryDistribution(items) {
  if (!items.length) return {};
  var counts = {};
  items.forEach(function(i) { counts[i.category] = (counts[i.category] || 0) + 1; });
  var total = items.length;
  var pct   = {};
  Object.keys(counts).forEach(function(k) { pct[k] = Math.round(counts[k] / total * 100); });
  return pct;
}

// ── Per-chokepoint spatial analytics (cached) ─────────────────────────────────
var _cpCache = {};
var _cpCacheKey = '';

function computeAllChokepointAnalytics() {
  var snap    = collectTrackingSnapshot();
  var cacheKey = snap.ships.length + '_' + snap.flights.length;

  if (_cpCacheKey === cacheKey && Object.keys(_cpCache).length) return _cpCache;
  _cpCacheKey = cacheKey;
  _cpCache    = {};

  var RADIUS_KM = 450;  // broad enough to capture approaching + in-strait + departing traffic

  (window.CHOKEPOINTS_DATA || []).forEach(function(cp) {
    var nearShips   = snap.ships.filter(function(s) {
      return haversineKm(cp.rawLat, cp.rawLon, s.lat, s.lon) <= RADIUS_KM;
    });
    var nearFlights = snap.flights.filter(function(f) {
      return haversineKm(cp.rawLat, cp.rawLon, f.lat, f.lon) <= RADIUS_KM;
    });

    _cpCache[cp.id] = {
      id:          cp.id,
      label:       cp.label,
      shipCount:   nearShips.length,
      flightCount: nearFlights.length,
      shipDist:    categoryDistribution(nearShips),
      flightDist:  categoryDistribution(nearFlights),
      // global (for reference)
      globalShips:   snap.ships.length,
      globalFlights: snap.flights.length,
    };
  });

  return _cpCache;
}

// ── Time-range comparison (multi-baseline, stored in localStorage) ────────────
// Each range key stores the oldest baseline we have captured within that window.
// TTLs: '1h' refreshes after 1h, '24h' after 24h, '7d' after 7d.
var NW_BASE_KEYS = {
  '1h':  { key: 'argus_base_1h',  ttl: 60  * 60 * 1000 },
  '24h': { key: 'argus_base_24h', ttl: 24  * 60 * 60 * 1000 },
  '7d':  { key: 'argus_base_7d',  ttl: 7   * 24 * 60 * 60 * 1000 },
};

function getOrSetAnalyticsBaseline(currentShips, currentFlights, timeRange) {
  var tr     = timeRange || state.analyticsTimeRange || '24h';
  var cfg    = NW_BASE_KEYS[tr] || NW_BASE_KEYS['24h'];
  var nowMs  = Date.now();
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(cfg.key) || 'null'); } catch(_){}

  if (!stored || (nowMs - stored.ts) > cfg.ttl) {
    stored = { ts: nowMs, ships: currentShips, flights: currentFlights };
    try { localStorage.setItem(cfg.key, JSON.stringify(stored)); } catch(_){}
  }
  return stored;
}

function pctChange(current, previous) {
  if (!previous) return null;
  return Math.round((current - previous) / previous * 100);
}

// ── Mini bar chart (text-based, fits in 180px panel) ─────────────────────────
function miniBar(pct, color) {
  var clamped = Math.max(0, Math.min(100, pct));
  return '<span style="display:inline-flex;align-items:center;gap:5px;vertical-align:middle">' +
    '<span style="display:inline-block;width:80px;height:5px;background:rgba(42,16,64,0.6);border-radius:2px;overflow:hidden;flex-shrink:0">' +
      '<span style="display:block;width:' + clamped + '%;height:100%;background:' + color + ';border-radius:2px;transition:width 0.2s"></span>' +
    '</span>' +
    '<span style="font-size:8px;color:' + color + ';min-width:26px;text-align:right">' + clamped + '%</span>' +
  '</span>';
}

// ── Chokepoint analytics HTML for the vessel inspector ────────────────────────
function buildChokepointAnalyticsHtml(nodeLabel) {
  var snap = collectTrackingSnapshot();
  if (!snap.ships.length && !snap.flights.length) return '';

  // Match node label to a known chokepoint
  var cp = (window.CHOKEPOINTS_DATA || []).find(function(c) {
    var lbl = c.label.toLowerCase();
    var nl  = (nodeLabel || '').toLowerCase();
    return nl.indexOf(lbl) !== -1 || lbl.indexOf(nl.replace(' route','').replace(' strait','')) !== -1;
  });
  if (!cp) return '';

  var analytics = computeAllChokepointAnalytics();
  var d = analytics[cp.id];
  if (!d) return '';

  var RADIUS_KM = 450;
  var html = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a0840">';
  html += '<div style="font-size:9px;letter-spacing:1.5px;color:#00ccff;margin-bottom:6px">◈ CHOKEPOINT ANALYTICS <span style="color:#4a6888;font-size:8px">(' + RADIUS_KM + 'km radius)</span></div>';
  html += field('SHIPS NEARBY', d.shipCount + (d.globalShips ? ' <span style="color:#4a6888;font-size:10px">of ' + d.globalShips + ' tracked</span>' : ''));
  html += field('FLIGHTS NEARBY', d.flightCount + (d.globalFlights ? ' <span style="color:#4a6888;font-size:10px">of ' + d.globalFlights + ' tracked</span>' : ''));

  // Ship category distribution
  if (d.shipCount > 0 && Object.keys(d.shipDist).length) {
    var SHIP_COLORS = { cargo:'#4488ff', tanker:'#ff9933', military:'#ff4444', passenger:'#00ff88', fishing:'#ffcc00', other:'#5577aa' };
    var sdHtml = Object.keys(d.shipDist).sort(function(a,b){ return d.shipDist[b]-d.shipDist[a]; }).map(function(k) {
      return '<div style="margin-bottom:3px"><span style="color:#4a7da8;width:70px;display:inline-block">' + k.toUpperCase() + '</span>' + miniBar(d.shipDist[k], SHIP_COLORS[k]||'#5577aa') + '</div>';
    }).join('');
    html += field('SHIP TYPES', sdHtml);
  }

  // Flight category distribution
  if (d.flightCount > 0 && Object.keys(d.flightDist).length) {
    var FLT_COLORS = { commercial:'#66ddff', cargo:'#4488ff', military:'#ff4444', unknown:'#5577aa' };
    var fdHtml = Object.keys(d.flightDist).sort(function(a,b){ return d.flightDist[b]-d.flightDist[a]; }).map(function(k) {
      return '<div style="margin-bottom:3px"><span style="color:#4a7da8;width:70px;display:inline-block">' + k.toUpperCase() + '</span>' + miniBar(d.flightDist[k], FLT_COLORS[k]||'#5577aa') + '</div>';
    }).join('');
    html += field('FLIGHT TYPES', fdHtml);
  }

  html += '</div>';
  return html;
}

// ══════════════════════════════════════════════════════════════════════════════
// IMF PORTWATCH — MACRO analytics hierarchy (MACRO → MESO → MICRO layering)
// buildPortAnalytics()  : memoized 3-level computation
// renderPortMacro()     : HTML string for the MACRO section
// Injected at top of renderAnalytics() — additive, no existing code removed.
// ══════════════════════════════════════════════════════════════════════════════

var _portAnalyticsCache = { period: null, data: null };

// ── REGION MAP: country → region label ────────────────────────────────────────
var PORT_REGION_MAP = (function() {
  var m = {};
  // East Asia
  ['China','Japan','South Korea','Taiwan','Hong Kong','Vietnam','Philippines','Indonesia','Malaysia','Singapore','Thailand','Cambodia','Myanmar','Brunei'].forEach(function(c){ m[c]='East Asia'; });
  // South Asia
  ['India','Pakistan','Bangladesh','Sri Lanka'].forEach(function(c){ m[c]='South Asia'; });
  // Middle East
  ['Saudi Arabia','UAE','Qatar','Kuwait','Bahrain','Oman','Iran','Iraq','Yemen','Jordan','Israel','Egypt'].forEach(function(c){ m[c]='Middle East'; });
  // Europe
  ['Germany','Netherlands','Belgium','France','Spain','Italy','Greece','Turkey','United Kingdom','Norway','Sweden','Denmark','Finland','Poland','Portugal','Russia','Ukraine','Romania','Bulgaria','Croatia','Slovenia','Latvia','Lithuania','Estonia'].forEach(function(c){ m[c]='Europe'; });
  // Americas
  ['United States','Canada','Mexico','Brazil','Argentina','Chile','Colombia','Peru','Ecuador','Panama','Costa Rica','Guatemala','Honduras'].forEach(function(c){ m[c]='Americas'; });
  // Africa
  ['South Africa','Nigeria','Kenya','Egypt','Morocco','Algeria','Tunisia','Tanzania','Mozambique','Angola','Ghana','Djibouti','Somalia','Eritrea'].forEach(function(c){ m[c]='Africa'; });
  // Oceania
  ['Australia','New Zealand','Papua New Guinea','Fiji'].forEach(function(c){ m[c]='Oceania'; });
  return m;
})();

function _portRegion(country) {
  return PORT_REGION_MAP[country] || 'Other';
}

// ── Core computation — returns hierarchical analytics object ──────────────────
function buildPortAnalytics() {
  var pw = window._portWatchState;
  if (!pw || !pw.ports || pw.ports.size === 0) return null;

  // Memoize by period string — only recompute when IMF data refreshes
  var period = pw.period || 'unknown';
  if (_portAnalyticsCache.period === period && _portAnalyticsCache.data) {
    return _portAnalyticsCache.data;
  }

  var ports = [];
  pw.ports.forEach(function(p) { ports.push(p); });

  // ── Global totals ──────────────────────────────────────────────────────────
  var gTotalCalls = 0, gImports = 0, gExports = 0;
  var gImpCont = 0, gExpCont = 0, gImpTank = 0, gExpTank = 0;

  ports.forEach(function(p) {
    gTotalCalls += p.total_calls;
    gImports    += p.imports_total;
    gExports    += p.exports_total;
    gImpCont    += p.categories.import_container;
    gExpCont    += p.categories.export_container;
    gImpTank    += p.categories.import_tanker;
    gExpTank    += p.categories.export_tanker;
  });

  var gFlow = gImports + gExports || 1;
  var _gContTotal = gImpCont + gExpCont;
  var _gTankTotal = gImpTank + gExpTank;
  var _gContPct   = Math.round(_gContTotal / gFlow * 100);
  var _gTankPct   = Math.round(_gTankTotal / gFlow * 100);
  var global = {
    portCount:  ports.length,
    totalCalls: gTotalCalls,
    imports:    gImports,
    exports:    gExports,
    balance:    gImports - gExports,
    ieRatio:    gExports > 0 ? Math.round(gImports / gExports * 100) / 100 : null,
    contPct:    _gContPct,
    tankPct:    _gTankPct,
    otherPct:   Math.max(0, 100 - _gContPct - _gTankPct),
    categories: {
      imp_container_pct: gFlow ? Math.round(gImpCont / gFlow * 100) : 0,
      exp_container_pct: gFlow ? Math.round(gExpCont / gFlow * 100) : 0,
      imp_tanker_pct:    gFlow ? Math.round(gImpTank / gFlow * 100) : 0,
      exp_tanker_pct:    gFlow ? Math.round(gExpTank / gFlow * 100) : 0,
    },
  };

  // ── Regional aggregation ───────────────────────────────────────────────────
  var regionMap = {};
  ports.forEach(function(p) {
    var r = _portRegion(p.country);
    if (!regionMap[r]) regionMap[r] = { name: r, ports: [], totalCalls: 0, imports: 0, exports: 0, impCont: 0, expCont: 0, impTank: 0, expTank: 0 };
    var R = regionMap[r];
    R.ports.push(p);
    R.totalCalls += p.total_calls;
    R.imports    += p.imports_total;
    R.exports    += p.exports_total;
    R.impCont    += p.categories.import_container;
    R.expCont    += p.categories.export_container;
    R.impTank    += p.categories.import_tanker;
    R.expTank    += p.categories.export_tanker;
  });

  // Compute region-level derived fields
  Object.keys(regionMap).forEach(function(r) {
    var R = regionMap[r];
    var rFlow = R.imports + R.exports || 1;
    var activity = R.totalCalls || 1;
    R.pctOfGlobal      = gTotalCalls ? Math.round(R.totalCalls / gTotalCalls * 100) : 0;
    R.containerShare   = Math.round((R.impCont + R.expCont) / rFlow * 100);
    R.tankerShare      = Math.round((R.impTank + R.expTank) / rFlow * 100);
    R.dominantCargo    = R.tankerShare > R.containerShare ? 'TANKER' : 'CONTAINER';
    R.balance          = R.imports - R.exports;
    // Congestion proxy: avg calls per port, normalized 0-100
    R.portCount        = R.ports.length;
    R.avgCallsPerPort  = R.portCount ? Math.round(R.totalCalls / R.portCount) : 0;
    // Top port by total_calls
    R.ports.sort(function(a, b) { return b.total_calls - a.total_calls; });
    R.topPort = R.ports[0] ? R.ports[0].port : '';
  });

  // Sort regions by totalCalls desc
  var regions = Object.keys(regionMap)
    .map(function(r) { return regionMap[r]; })
    .sort(function(a, b) { return b.totalCalls - a.totalCalls; });

  // ── Port-level: top 5 ports per region ────────────────────────────────────
  var topPortsByRegion = {};
  regions.forEach(function(R) {
    var regionMaxCalls = R.ports.length ? (R.ports[0].total_calls || 1) : 1;
    topPortsByRegion[R.name] = R.ports.slice(0, 5).map(function(p) {
      var flow = p.imports_total + p.exports_total || 1;
      return {
        id:           p.id,
        name:         p.port,
        country:      p.country,
        calls:        p.total_calls,
        imports:      p.imports_total,
        exports:      p.exports_total,
        pctOfRegion:  R.totalCalls ? Math.round(p.total_calls / R.totalCalls * 100) : 0,
        pctOfGlobal:  gTotalCalls  ? Math.round(p.total_calls / gTotalCalls  * 100) : 0,
        tankerShare:  Math.round((p.categories.import_tanker + p.categories.export_tanker) / flow * 100),
        contShare:    Math.round((p.categories.import_container + p.categories.export_container) / flow * 100),
        ieRatio:      p.exports_total > 0 ? Math.round(p.imports_total / p.exports_total * 10) / 10 : null,
        activityScore: Math.round(p.total_calls / regionMaxCalls * 100),
        visual:       p.visual,
        chokepointId: p.chokepointId,
      };
    });
  });

  var result = { global: global, regions: regions, topPortsByRegion: topPortsByRegion, period: period, portCount: ports.length };
  _portAnalyticsCache = { period: period, data: result };
  return result;
}

// ── OpenSky supplemental aircraft analytics (memoized) ───────────────────────
// Reads window.aircraftLiveCache (Map<icao24, normalizedRecord>) — the OpenSky
// supplemental provider cache. Separate from snap.flights which comes from the
// primary ADS-B render pipeline.

var OSKY_BASE_KEYS = {
  '1h':  { key: 'argus_osky_base_1h',  ttl: 60  * 60 * 1000 },
  '24h': { key: 'argus_osky_base_24h', ttl: 24  * 60 * 60 * 1000 },
  '7d':  { key: 'argus_osky_base_7d',  ttl: 7   * 24 * 60 * 60 * 1000 },
};

function getOrSetOpenSkyBaseline(currentCount, timeRange) {
  var tr     = timeRange || '24h';
  var cfg    = OSKY_BASE_KEYS[tr] || OSKY_BASE_KEYS['24h'];
  var nowMs  = Date.now();
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(cfg.key) || 'null'); } catch (_) {}
  if (!stored || (nowMs - stored.ts) > cfg.ttl) {
    stored = { ts: nowMs, count: currentCount };
    try { localStorage.setItem(cfg.key, JSON.stringify(stored)); } catch (_) {}
  }
  return stored;
}

// Map lat/lon to a named aviation region
function _oskyRegion(lat, lon) {
  if (lat == null || lon == null) return 'OTHER';
  if (lat >= 15 && lat <= 72  && lon >= -170 && lon <= -55) return 'N. AMERICA';
  if (lat >  -55 && lat < 15  && lon >= -85  && lon <= -30) return 'L. AMERICA';
  if (lat >= 35  && lat <= 72  && lon >= -10  && lon <= 45)  return 'EUROPE';
  if (lat >= -35 && lat <  35  && lon >= -18  && lon <= 55)  return 'AFRICA / ME';
  if (lat >= 5   && lat <= 55  && lon >  45   && lon <= 150) return 'ASIA';
  if (lat >  -50 && lat <  5   && lon >= 95   && lon <= 180) return 'OCEANIA';
  return 'OTHER';
}

var _oskyCache    = null;
var _oskyCacheKey = '';

function buildOpenSkyAnalytics() {
  var liveCache = window.aircraftLiveCache;
  if (!liveCache || !liveCache.size) return null;

  var cacheKey = String(liveCache.size);
  if (_oskyCacheKey === cacheKey && _oskyCache) return _oskyCache;
  _oskyCacheKey = cacheKey;

  var typeCounts  = {};
  var altBands    = { high: 0, medium: 0, low: 0 };
  var altHasData  = 0;
  var totalGs     = 0;
  var gsCount     = 0;
  var regionCounts = {};
  var total       = 0;

  liveCache.forEach(function (ac) {
    total++;

    var ft = ac.flightType || 'unknown';
    typeCounts[ft] = (typeCounts[ft] || 0) + 1;

    if (ac.alt != null) {
      altHasData++;
      if      (ac.alt > 20000) { altBands.high++;   }
      else if (ac.alt >= 5000) { altBands.medium++; }
      else                     { altBands.low++;    }
    }

    if (ac.gs != null && ac.gs > 0) {
      totalGs += ac.gs;
      gsCount++;
    }

    var region = _oskyRegion(ac.lat, ac.lon);
    regionCounts[region] = (regionCounts[region] || 0) + 1;
  });

  // Convert raw counts to integer percentages
  var typePct = {};
  Object.keys(typeCounts).forEach(function (k) {
    typePct[k] = Math.round(typeCounts[k] / total * 100);
  });

  var altBandPct = {};
  if (altHasData > 0) {
    altBandPct.high   = Math.round(altBands.high   / altHasData * 100);
    altBandPct.medium = Math.round(altBands.medium / altHasData * 100);
    altBandPct.low    = Math.round(altBands.low    / altHasData * 100);
  }

  var regionPct = {};
  Object.keys(regionCounts).forEach(function (k) {
    regionPct[k] = Math.round(regionCounts[k] / total * 100);
  });

  _oskyCache = {
    total:      total,
    typePct:    typePct,
    altBandPct: altBandPct,
    avgGs:      gsCount > 0 ? Math.round(totalGs / gsCount) : null,
    regionPct:  regionPct,
  };
  return _oskyCache;
}

// ── Collapsible section helper (toggle via onclick on header) ─────────────────
var _portMacroCollapsed = { macro: false, meso: false, opensky: false, regions: false, ports: false, imf_global: false, imf_regions: true, imf_signals: true };

function _macroSection(id, title, badge, colorCls, contentHtml) {
  // 'r_*' region keys default to collapsed (not in initial object)
  var collapsed = (id in _portMacroCollapsed)
    ? !!_portMacroCollapsed[id]
    : (id.length > 2 && id.charAt(0) === 'r' && id.charAt(1) === '_');
  var arrow = collapsed ? '▸' : '▾';
  var display = collapsed ? 'none' : 'block';
  return '<div style="margin-bottom:2px">' +
    '<div data-pwsec="' + id + '" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;border-bottom:1px solid #1a0840;user-select:none" ' +
      'onclick="window._pwToggle(\'' + id + '\')">' +
      '<span style="font-size:9px;letter-spacing:1.5px;color:' + colorCls + '">' + arrow + ' ' + title + '</span>' +
      (badge ? '<span style="font-size:8px;color:#4a6888">' + badge + '</span>' : '') +
    '</div>' +
    '<div id="pw-sec-' + id + '" style="display:' + display + '">' + contentHtml + '</div>' +
  '</div>';
}

window._pwToggle = function(id) {
  // Initialise region keys (not in initial object) as collapsed before first toggle
  if (!(id in _portMacroCollapsed)) {
    _portMacroCollapsed[id] = (id.length > 2 && id.charAt(0) === 'r' && id.charAt(1) === '_') ? true : false;
  }
  _portMacroCollapsed[id] = !_portMacroCollapsed[id];
  if (typeof renderAnalytics === 'function') renderAnalytics();
};

// ── Anomaly detection: macro + cross-layer signals ────────────────────────────
// Runs against precomputed buildPortAnalytics() result — no heavy iteration.
function buildIMFAnomalies(pa, snap) {
  if (!pa) return [];
  var anomalies = [];
  var G = pa.global;

  // 1. IMF × Vessel cross-layer mismatch
  if (snap.ships.length > 0 && G.totalCalls > 0) {
    var callsPerShip = G.totalCalls / snap.ships.length;
    if (callsPerShip < 0.5) {
      anomalies.push({
        type:   'CROSS_LAYER',
        col:    '#ff4466',
        detail: snap.ships.length + ' vessels tracked vs ' + G.totalCalls.toLocaleString() + ' IMF port calls — possible AIS coverage gap or traffic anomaly',
      });
    } else if (callsPerShip > 50) {
      anomalies.push({
        type:   'CROSS_LAYER',
        col:    '#00ccff',
        detail: '↑ High IMF port activity (' + G.totalCalls.toLocaleString() + ' calls) relative to ' + snap.ships.length + ' tracked vessels — elevated macro throughput',
      });
    }
  }

  // 2. Global tanker dominance
  if (G.tankPct > 50) {
    anomalies.push({
      type:   'TANKER_SURGE',
      col:    '#ff9933',
      detail: 'Global cargo mix ' + G.tankPct + '% tanker-weighted — elevated energy route sensitivity across all regions',
    });
  }

  // 3. Activity concentration (top region > 50% of global)
  if (pa.regions.length > 0 && pa.regions[0].pctOfGlobal > 50) {
    anomalies.push({
      type:   'CONCENTRATION',
      col:    '#cc99ff',
      detail: pa.regions[0].name + ' accounts for ' + pa.regions[0].pctOfGlobal + '% of global port activity — supply chain concentration risk',
    });
  }

  // 4. Global trade imbalance (macro level)
  if (G.ieRatio !== null && G.exports > 0 && G.imports > 0) {
    if (G.ieRatio > 1.3) {
      anomalies.push({
        type:   'TRADE_IMBALANCE',
        col:    '#ffcc00',
        detail: 'Global import surplus ' + G.ieRatio.toFixed(2) + ':1 across ' + pa.portCount + ' ports — possible demand accumulation or export constraints',
      });
    } else if (G.ieRatio < 0.77) {
      anomalies.push({
        type:   'TRADE_IMBALANCE',
        col:    '#ffcc00',
        detail: 'Global export surplus ' + (1 / G.ieRatio).toFixed(2) + ':1 across ' + pa.portCount + ' ports — possible demand shock or strategic drawdown',
      });
    }
  }

  // 5. Tanker-dominant regions (per-region, top 2 only to cap noise)
  var tankerRegions = pa.regions.filter(function(R) { return R.tankerShare > 60 && R.pctOfGlobal >= 5; });
  tankerRegions.slice(0, 2).forEach(function(R) {
    anomalies.push({
      type:   'TANKER_SURGE',
      col:    '#ff9933',
      detail: R.name + ': ' + R.tankerShare + '% tanker-weighted at ' + R.pctOfGlobal + '% of global activity — energy route elevated risk',
    });
  });

  return anomalies.slice(0, 5);
}

// ── Render the full IMF Economic Intelligence section ─────────────────────────
// 3-section hierarchy: Global Overview / Regional Breakdown / Signals & Anomalies
// Each section is independently collapsible. Regions contain nested port detail cards.
function renderPortMacro() {
  var pa = buildPortAnalytics();
  if (!pa) return '';

  var G    = pa.global;
  var html = '';

  // Section header (outside collapsibles — always visible inside the macro wrapper)
  html += '<div style="font-size:9px;letter-spacing:1.5px;color:#00ccff;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #1a0840">' +
    '◈ ECONOMIC INTELLIGENCE' +
    '<span style="color:#4a6888;font-size:8px"> IMF PORTWATCH · ' + (pa.period || '—') + ' · ' + pa.portCount + ' PORTS</span>' +
  '</div>';

  // ── SECTION 1: GLOBAL OVERVIEW ─────────────────────────────────────────────
  var globalHtml = '';
  globalHtml += field('PORT CALLS',     '<span style="color:#00ccff">' + G.totalCalls.toLocaleString() + '</span>');
  globalHtml += field('GLOBAL IMPORTS', '<span style="color:#00ff88">' + G.imports.toLocaleString()    + '</span>');
  globalHtml += field('GLOBAL EXPORTS', '<span style="color:#ff9933">' + G.exports.toLocaleString()    + '</span>');

  if (G.ieRatio !== null) {
    var ieCol   = G.ieRatio > 1.2 ? '#00ff88' : (G.ieRatio < 0.83 ? '#ff9933' : '#4a7da8');
    var ieLabel = G.ieRatio > 1.1 ? 'import-heavy' : (G.ieRatio < 0.9 ? 'export-heavy' : 'balanced');
    globalHtml += field('I/E RATIO',
      '<span style="color:' + ieCol + '">' + G.ieRatio.toFixed(2) + ':1</span>' +
      ' <span style="color:#4a6888;font-size:9px">' + ieLabel + '</span>');
  }

  var balColor = G.balance > 0 ? '#00ff88' : (G.balance < 0 ? '#ff4466' : '#4a7da8');
  globalHtml += field('TRADE BALANCE',
    '<span style="color:' + balColor + '">' + (G.balance > 0 ? '+' : '') + G.balance.toLocaleString() + '</span>');

  // Cargo breakdown: container / tanker / other
  globalHtml += '<div style="margin-top:5px"><div style="font-size:8px;letter-spacing:1px;color:#4a6888;margin-bottom:4px">CARGO MIX</div>';
  globalHtml += '<div style="margin-bottom:3px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:9px">CONTAINER</span>' + miniBar(G.contPct,  '#4488ff') + '</div>';
  globalHtml += '<div style="margin-bottom:3px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:9px">TANKER</span>'    + miniBar(G.tankPct,  '#ff9933') + '</div>';
  if (G.otherPct > 0) {
    globalHtml += '<div style="margin-bottom:3px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:9px">OTHER</span>' + miniBar(G.otherPct, '#5577aa') + '</div>';
  }
  globalHtml += '</div>';

  html += _macroSection('imf_global', 'GLOBAL OVERVIEW', pa.portCount + ' ports', '#00ccff', globalHtml);

  // ── SECTION 2: REGIONAL BREAKDOWN ──────────────────────────────────────────
  // Each region is its own toggle; clicking expands per-port detail cards inside.
  var regOuterHtml = '';
  pa.regions.forEach(function(R) {
    if (!R.totalCalls) return;
    var domCol  = R.dominantCargo === 'TANKER' ? '#ff9933' : '#4488ff';
    var rPorts  = pa.topPortsByRegion[R.name] || [];
    var rBadge  = R.pctOfGlobal + '% global · ' + R.portCount + ' ports';

    // Region summary + nested port cards (shown when region is expanded)
    var rInnerHtml = '';
    rInnerHtml +=
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:5px;padding:4px 0;border-bottom:1px solid rgba(42,16,64,0.45)">' +
        '<span style="font-size:9px;color:#4a7da8">CALLS <span style="color:#00ccff">' + R.totalCalls.toLocaleString() + '</span></span>' +
        '<span style="font-size:9px;color:#4a7da8">IMP <span style="color:#00ff88">'   + R.imports.toLocaleString()    + '</span></span>' +
        '<span style="font-size:9px;color:#4a7da8">EXP <span style="color:#ff9933">'   + R.exports.toLocaleString()    + '</span></span>' +
        '<span style="font-size:9px;color:' + domCol + '">' + R.dominantCargo + '</span>' +
      '</div>' +
      '<div style="margin-bottom:5px">' + miniBar(R.pctOfGlobal, '#7755cc') +
        ' <span style="font-size:8px;color:#4a6888">of global</span></div>';

    // ── Port detail cards ────────────────────────────────────────────────────
    if (rPorts.length) {
      rInnerHtml += '<div style="font-size:8px;letter-spacing:1px;color:#4a6888;margin-bottom:4px">TOP PORTS (' + rPorts.length + ')</div>';
      rPorts.forEach(function(p) {
        var vcol     = (p.visual && p.visual.color) ? p.visual.color : '#00ccff';
        var cpTag    = p.chokepointId ? ' <span style="color:#ffcc00;font-size:8px">⬡</span>' : '';
        var contDom  = p.contShare >= p.tankerShare;
        var domCargo = contDom ? 'CONTAINER' : 'TANKER';
        var domColor = contDom ? '#4488ff' : '#ff9933';

        var ieStr = '';
        if (p.ieRatio !== null && p.ieRatio !== undefined) {
          var ieDir    = p.ieRatio > 1.15 ? '↑IMP' : (p.ieRatio < 0.87 ? '↑EXP' : 'BAL');
          var ieDirCol = p.ieRatio > 1.15 ? '#00ff88' : (p.ieRatio < 0.87 ? '#ff9933' : '#4a6888');
          ieStr = ' <span style="color:' + ieDirCol + ';font-size:8px">' + ieDir + ' ' + p.ieRatio.toFixed(1) + '</span>';
        }

        rInnerHtml +=
          '<div style="padding:5px 0;border-bottom:1px solid rgba(42,16,64,0.35)">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
              '<span style="font-size:10px;color:' + vcol + '">' + p.name + cpTag + '</span>' +
              '<span style="font-size:8px;color:#4a6888">' + p.pctOfRegion + '%R · ' + p.pctOfGlobal + '%G</span>' +
            '</div>' +
            '<div style="font-size:9px;color:#4a6888;margin-bottom:3px">' +
              p.country + ' · CALLS <span style="color:#00ccff">' + p.calls + '</span>' + ieStr +
            '</div>' +
            '<div style="margin-bottom:2px"><span style="color:#4a7da8;display:inline-block;width:72px;font-size:9px">CONTAINER</span>' + miniBar(p.contShare,    '#4488ff') + '</div>' +
            '<div style="margin-bottom:2px"><span style="color:#4a7da8;display:inline-block;width:72px;font-size:9px">TANKER</span>'    + miniBar(p.tankerShare,  '#ff9933') + '</div>' +
            '<div><span style="color:#4a7da8;display:inline-block;width:72px;font-size:9px">ACTIVITY</span>'  + miniBar(p.activityScore, '#00ccff') + '</div>' +
          '</div>';
      });
    }

    regOuterHtml += _macroSection('r_' + R.name, R.name.toUpperCase(), rBadge, '#cc99ff', rInnerHtml);
  });

  html += _macroSection('imf_regions', 'REGIONAL BREAKDOWN', pa.regions.length + ' regions', '#7755cc',
    regOuterHtml || '<div style="padding:6px 0;font-size:9px;color:#4a6888">No regional data</div>');

  // ── SECTION 3: SIGNALS & ANOMALIES ─────────────────────────────────────────
  var snap      = collectTrackingSnapshot();
  var anomalies = buildIMFAnomalies(pa, snap);

  // Merge port-level IMF signals with computed macro anomalies
  // Port signals first (more specific), macro anomalies appended
  var portSigs  = (window._portWatchSignals || []).slice(0, 4);
  var allSigs   = portSigs.concat(anomalies).slice(0, 8);

  var SIG_COL = {
    DISRUPTION:           '#ff4466',
    TRADE_IMBALANCE:      '#ffcc00',
    ENERGY_CONCENTRATION: '#ff9933',
    TANKER_SURGE:         '#ff9933',
    CROSS_LAYER:          '#00ccff',
    CONCENTRATION:        '#cc99ff',
    MISMATCH:             '#ff4466',
  };

  var sigHtml = '';
  if (allSigs.length) {
    allSigs.forEach(function(s) {
      var col = s.col || SIG_COL[s.type] || '#4a7da8';
      sigHtml +=
        '<div style="padding:5px 0;border-bottom:1px solid rgba(42,16,64,0.4);font-size:9px;line-height:1.5">' +
          '<span style="color:' + col + ';letter-spacing:0.5px">' + (s.type || 'SIGNAL').replace(/_/g, ' ') + '</span>' +
          (s.chokepointId ? ' <span style="color:#ffcc00;font-size:8px">⬡CP</span>' : '') +
          '<br><span style="color:#4a7da8">' + (s.detail || '') + '</span>' +
        '</div>';
    });
  } else {
    sigHtml = '<div style="padding:8px 0;font-size:9px;color:#4a6888;text-align:center;letter-spacing:0.5px">NO SIGNALS DETECTED</div>';
  }

  html += _macroSection('imf_signals', 'SIGNALS & ANOMALIES', allSigs.length ? allSigs.length + ' active' : 'clear', '#ff9933', sigHtml);

  return html;
}

// ── Main analytics panel renderer ─────────────────────────────────────────────
function renderAnalytics() {
  // ArgusAnalytics owns this pane when present — delegate and exit.
  if (window.ArgusAnalytics) {
    window.ArgusAnalytics.init();
    return;
  }

  var body = document.getElementById('nw-analytics-body');
  if (!body) return;

  var snap      = collectTrackingSnapshot();
  var analytics = computeAllChokepointAnalytics();
  var baseline  = getOrSetAnalyticsBaseline(snap.ships.length, snap.flights.length, state.analyticsTimeRange);

  var noData = !snap.ships.length && !snap.flights.length;

  // ── Time range selector ───────────────────────────────────────────────────────
  var TR_LABELS = { '1h': '1H', '24h': '24H', '7d': '7D' };
  var trHtml = '<div style="display:flex;gap:4px;margin-bottom:10px">' +
    Object.keys(TR_LABELS).map(function(tr) {
      var active = state.analyticsTimeRange === tr;
      return '<button data-nw-tr="' + tr + '" style="flex:1;background:' + (active ? '#2a1050' : 'none') + ';border:1px solid ' + (active ? '#7755cc' : '#2a1050') + ';color:' + (active ? '#cc99ff' : '#4a7da8') + ';font-size:9px;letter-spacing:1px;padding:3px 0;cursor:pointer;border-radius:2px">' + TR_LABELS[tr] + '</button>';
    }).join('') + '</div>';

  var baseAgeMin = Math.round((Date.now() - baseline.ts) / 60000);
  var baseAgeStr = baseAgeMin < 60
    ? baseAgeMin + 'm ago'
    : Math.round(baseAgeMin / 60) + 'h ago';

  var shipChange    = pctChange(snap.ships.length,   baseline.ships);
  var flightChange  = pctChange(snap.flights.length, baseline.flights);
  var chgFmt = function(v, n) {
    if (v === null || !n) return '<span style="color:#4a6888">N/A</span>';
    var col = v > 0 ? '#00ff88' : (v < 0 ? '#ff4466' : '#4a7da8');
    return '<span style="color:' + col + '">' + (v > 0 ? '+' : '') + v + '%</span> vs ' + baseAgeStr;
  };

  // ── Build MACRO content (IMF PortWatch) ──────────────────────────────────────
  var macroInner = renderPortMacro();
  var macroCount = (window._portWatchState && window._portWatchState.ports) ? window._portWatchState.ports.size : 0;
  var macroBadge = macroCount ? macroCount + ' ports' : 'no data';

  // ── Build MESO/MICRO content (AIS + ADS-B) ───────────────────────────────────
  var mesoInner = '';
  mesoInner += trHtml;

  if (noData) {
    mesoInner += '<div style="padding:10px 0;text-align:center;font-size:9px;letter-spacing:1px;color:var(--nw-purple-dim);opacity:0.6">ENABLE SHIP OR AIRCRAFT LAYER<br>TO LOAD DATA</div>';
  } else {
    mesoInner += field('VESSELS TRACKED',
      snap.ships.length + '&nbsp;&nbsp;' + chgFmt(shipChange, snap.ships.length));
    mesoInner += field('FLIGHTS TRACKED',
      snap.flights.length + '&nbsp;&nbsp;' + chgFmt(flightChange, snap.flights.length));

    if (snap.ships.length > 0) {
      var SHIP_COLORS2 = { cargo:'#4488ff', tanker:'#ff9933', military:'#ff4444', passenger:'#00ff88', fishing:'#ffcc00', other:'#5577aa' };
      var gShipDist = categoryDistribution(snap.ships);
      var gsHtml = Object.keys(gShipDist).sort(function(a,b){ return gShipDist[b]-gShipDist[a]; }).map(function(k) {
        return '<div style="margin-bottom:4px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:10px">' + k.toUpperCase() + '</span>' + miniBar(gShipDist[k], SHIP_COLORS2[k]||'#5577aa') + '</div>';
      }).join('');
      mesoInner += field('VESSEL TYPES', gsHtml);
    }

    if (snap.flights.length > 0) {
      var FLT_COLORS2 = { commercial:'#66ddff', cargo:'#4488ff', military:'#ff4444', unknown:'#5577aa' };
      var gFlightDist = categoryDistribution(snap.flights);
      var gfHtml = Object.keys(gFlightDist).sort(function(a,b){ return gFlightDist[b]-gFlightDist[a]; }).map(function(k) {
        return '<div style="margin-bottom:4px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:10px">' + k.toUpperCase() + '</span>' + miniBar(gFlightDist[k], FLT_COLORS2[k]||'#5577aa') + '</div>';
      }).join('');
      mesoInner += field('FLIGHT TYPES', gfHtml);
    }

    var cpKeys = Object.keys(analytics);
    if (cpKeys.length) {
      mesoInner += '<div style="font-size:9px;letter-spacing:1.5px;color:var(--nw-purple);margin:12px 0 6px;padding-top:8px;border-top:1px solid #1a0840">◈ CHOKEPOINT VOLUMES <span style="color:#4a6888;font-size:8px">(450km radius)</span></div>';
      var sortedCps = cpKeys.map(function(k){ return analytics[k]; })
        .sort(function(a,b){ return (b.shipCount + b.flightCount) - (a.shipCount + a.flightCount) });
      var RISK_COL2 = { CRITICAL:'#ff0044', WARNING:'#ff9933', WATCH:'#ffcc00', LOW:'#00ff88' };
      sortedCps.forEach(function(d2) {
        var cpData = (window.CHOKEPOINTS_DATA || []).find(function(c){ return c.id === d2.id; });
        var rCol   = cpData ? (RISK_COL2[cpData.risk] || '#4a7da8') : '#4a7da8';
        var total  = d2.shipCount + d2.flightCount;
        if (!total && !d2.globalShips && !d2.globalFlights) return;
        mesoInner += '<div style="padding:6px 0;border-bottom:1px solid rgba(42,16,64,0.5)">';
        mesoInner += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">';
        mesoInner += '<span style="font-size:10px;color:' + rCol + ';letter-spacing:0.5px">' + d2.label + '</span>';
        mesoInner += '<span style="font-size:9px;color:#4a6888">' + (cpData ? cpData.risk : '') + '</span>';
        mesoInner += '</div>';
        mesoInner += '<div style="display:flex;gap:12px">';
        mesoInner += '<span style="font-size:10px;color:#4a7da8">⚓ <span style="color:#00ccff">' + d2.shipCount + '</span> ships</span>';
        mesoInner += '<span style="font-size:10px;color:#4a7da8">✈ <span style="color:#66ddff">' + d2.flightCount + '</span> flights</span>';
        mesoInner += '</div>';
        if (d2.shipCount > 0 && Object.keys(d2.shipDist).length) {
          var CP_SHIP_COL = { cargo:'#4488ff', tanker:'#ff9933', military:'#ff4444', passenger:'#00ff88', fishing:'#ffcc00', other:'#5577aa' };
          mesoInner += '<div style="margin-top:3px">';
          Object.keys(d2.shipDist).sort(function(a,b){ return d2.shipDist[b]-d2.shipDist[a]; }).slice(0,3).forEach(function(k) {
            mesoInner += '<div style="font-size:9px;color:#4a6888;margin-bottom:1px"><span style="color:#4a7da8;display:inline-block;width:60px">' + k + '</span>' + miniBar(d2.shipDist[k], CP_SHIP_COL[k]||'#5577aa') + '</div>';
          });
          mesoInner += '</div>';
        }
        if (d2.flightCount > 0 && Object.keys(d2.flightDist).length) {
          var CP_FLT_COL = { commercial:'#66ddff', cargo:'#4488ff', military:'#ff4444', unknown:'#5577aa' };
          mesoInner += '<div style="margin-top:2px">';
          Object.keys(d2.flightDist).sort(function(a,b){ return d2.flightDist[b]-d2.flightDist[a]; }).slice(0,3).forEach(function(k) {
            mesoInner += '<div style="font-size:9px;color:#4a6888;margin-bottom:1px"><span style="color:#4a7da8;display:inline-block;width:60px">' + k + '</span>' + miniBar(d2.flightDist[k], CP_FLT_COL[k]||'#5577aa') + '</div>';
          });
          mesoInner += '</div>';
        }
        mesoInner += '</div>';
      });
    }

    var TR_LABEL_MAP = { '1h': '1 HOUR', '24h': '24 HOURS', '7d': '7 DAYS' };
    mesoInner += '<div style="margin-top:10px;font-size:9px;letter-spacing:0.5px;color:#4a6888;opacity:0.8;line-height:1.6">';
    mesoInner += 'BASELINE FROM ' + baseAgeStr.toUpperCase() + ' · DELTA: ' + (TR_LABEL_MAP[state.analyticsTimeRange] || state.analyticsTimeRange);
    mesoInner += '</div>';
  }

  var mesoBadge = noData ? 'no layer' : (snap.ships.length + 'v ' + snap.flights.length + 'f');

  // ── Build OPENSKY section ─────────────────────────────────────────────────────
  var oskyData   = buildOpenSkyAnalytics();
  var oskyBase   = getOrSetOpenSkyBaseline(oskyData ? oskyData.total : 0, state.analyticsTimeRange);
  var oskyAgeMin = Math.round((Date.now() - oskyBase.ts) / 60000);
  var oskyAgeStr = oskyAgeMin < 60 ? oskyAgeMin + 'm ago' : Math.round(oskyAgeMin / 60) + 'h ago';
  var oskyInner  = '';

  if (!oskyData) {
    oskyInner = '<div style="padding:10px 0;text-align:center;font-size:9px;letter-spacing:1px;color:#4a6888;opacity:0.6">ENABLE AIRCRAFT LAYER<br>OR AWAITING OPENSKY POLL</div>';
  } else {
    var oskyChange = pctChange(oskyData.total, oskyBase.count);
    var oskyChgFmt = function(v) {
      if (v === null) return '<span style="color:#4a6888">N/A</span>';
      var col = v > 0 ? '#00ff88' : (v < 0 ? '#ff4466' : '#4a7da8');
      return '<span style="color:' + col + '">' + (v > 0 ? '+' : '') + v + '%</span>';
    };

    oskyInner += trHtml;
    oskyInner += field('SUPPLEMENTAL AC', oskyData.total + '&nbsp;&nbsp;' + oskyChgFmt(oskyChange));

    // Flight type distribution
    var OSKY_TYPE_COL = { commercial: '#66ddff', cargo: '#4488ff', military: '#ff4444', unknown: '#5577aa' };
    var oskyTypeHtml = Object.keys(oskyData.typePct)
      .sort(function (a, b) { return oskyData.typePct[b] - oskyData.typePct[a]; })
      .map(function (k) {
        return '<div style="margin-bottom:4px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:10px">' +
          k.toUpperCase() + '</span>' + miniBar(oskyData.typePct[k], OSKY_TYPE_COL[k] || '#5577aa') + '</div>';
      }).join('');
    if (oskyTypeHtml) oskyInner += field('FLIGHT TYPES', oskyTypeHtml);

    // Altitude band distribution
    if (oskyData.altBandPct.high != null || oskyData.altBandPct.medium != null || oskyData.altBandPct.low != null) {
      var OSKY_ALT_COL = { high: '#00ccff', medium: '#66ddff', low: '#ffcc00' };
      var OSKY_ALT_LBL = { high: '>20K FT', medium: '5-20K FT', low: '<5K FT' };
      var oskyAltHtml = ['high', 'medium', 'low'].filter(function (k) { return oskyData.altBandPct[k]; }).map(function (k) {
        return '<div style="margin-bottom:4px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:10px">' +
          OSKY_ALT_LBL[k] + '</span>' + miniBar(oskyData.altBandPct[k], OSKY_ALT_COL[k]) + '</div>';
      }).join('');
      if (oskyAltHtml) oskyInner += field('ALTITUDE BANDS', oskyAltHtml);
    }

    // Average speed
    if (oskyData.avgGs != null) {
      oskyInner += field('AVG SPEED', '<span style="color:#66ddff">' + oskyData.avgGs + '</span> <span style="color:#4a6888">kt</span>');
    }

    // Regional distribution (top 5)
    var oskyRegKeys = Object.keys(oskyData.regionPct)
      .sort(function (a, b) { return oskyData.regionPct[b] - oskyData.regionPct[a]; })
      .slice(0, 5);
    if (oskyRegKeys.length) {
      var oskyRegHtml = oskyRegKeys.map(function (k) {
        return '<div style="margin-bottom:4px"><span style="color:#4a7da8;display:inline-block;width:76px;font-size:10px">' +
          k + '</span>' + miniBar(oskyData.regionPct[k], '#88aacc') + '</div>';
      }).join('');
      oskyInner += field('REGIONS', oskyRegHtml);
    }

    oskyInner += '<div style="margin-top:10px;font-size:9px;letter-spacing:0.5px;color:#4a6888;opacity:0.8;line-height:1.6">' +
      'BASELINE FROM ' + oskyAgeStr.toUpperCase() + ' · SUPPLEMENTAL ONLY' +
      '</div>';
  }

  var oskyBadge = oskyData ? oskyData.total + ' ac' : 'no data';

  // ── Assemble with top-level collapsible wrappers ──────────────────────────────
  var html = '';
  html += _macroSection('macro',   'IMF PORTWATCH',   macroBadge, '#00ccff',          macroInner || '<div style="padding:8px 0;font-size:9px;color:#4a6888;text-align:center">AWAITING DATA</div>');
  html += _macroSection('meso',    'AIS / ADS-B',     mesoBadge,  'var(--nw-purple)', mesoInner);
  html += _macroSection('opensky', 'OPENSKY NETWORK', oskyBadge,  '#66ddff',          oskyInner);

  body.innerHTML = html;
  _bindAnalyticsTimeRange(body);
}

function _bindAnalyticsTimeRange(body) {
  (body || document.getElementById('nw-analytics-body') || { querySelectorAll: function(){return [];} })
    .querySelectorAll('[data-nw-tr]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        state.analyticsTimeRange = this.dataset.nwTr;
        renderAnalytics();
      });
    });
}

// ── Country selector ──────────────────────────────────────────────────────────
function buildCountryList(filter) {
  var list  = document.getElementById('nw-country-list');
  if (!list) return;
  var countries = window.COUNTRIES_DATA || [];
  filter = (filter || '').toLowerCase();

  // Build a set of countries that appear in the store + all COUNTRIES_DATA entries
  var storeKeys = Array.from(store.byCountry.keys());
  var countrySet = {};
  countries.forEach(function(c){ countrySet[c.label] = c; });
  // Also include store keys not in COUNTRIES_DATA
  storeKeys.forEach(function(k){ if (k && !countrySet[k]) countrySet[k] = { label: k, risk: 'LOW' }; });

  var items = Object.keys(countrySet)
    .filter(function(k){ return !filter || k.toLowerCase().indexOf(filter) !== -1; })
    .sort(function(a,b){
      // Sort: higher-risk countries first, then alphabetical
      var rA = RISK_WEIGHTS[countrySet[a].risk] || 0;
      var rB = RISK_WEIGHTS[countrySet[b].risk] || 0;
      return rB - rA || a.localeCompare(b);
    })
    .slice(0, 60);

  list.innerHTML = items.map(function(label) {
    var cd = countrySet[label];
    var pip = RISK_COLORS[cd.risk] || '#4a7da8';
    var evCount = (store.byCountry.get(label) || []).length;
    var selClass = state.selectedCountry === label ? ' is-selected' : '';
    return '<div class="nw-country-item' + selClass + '" role="option" data-country="' + label + '">' +
      '<span class="nw-risk-pip" style="background:' + pip + ';box-shadow:0 0 4px ' + pip + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' + label + '</span>' +
      (evCount ? '<span style="font-size:7px;color:#2a5a8a">' + evCount + '</span>' : '') +
      '</div>';
  }).join('');

  // Delegate click
  list.onclick = function(e) {
    var item = e.target.closest('.nw-country-item');
    if (!item) return;
    var country = item.dataset.country;
    if (country) { setCountry(country); buildCountryList(filter); }
  };
}

function updateStats(events) {
  var el = document.getElementById('nw-stats');
  if (!el) return;
  var counts = { CRITICAL:0, WARNING:0, WATCH:0, LOW:0 };
  events.forEach(function(e){ counts[e.risk]  = (counts[e.risk]||0)+1; });
  el.innerHTML =
    '<span style="color:#ff0044">' + counts.CRITICAL + ' CRITICAL</span> · ' +
    '<span style="color:#ff9933">' + counts.WARNING  + ' WARNING</span> · ' +
    '<span style="color:#ffcc00">' + counts.WATCH    + ' WATCH</span> · ' +
    '<span style="color:#00ff88">' + counts.LOW      + ' LOW</span><br>' +
    events.length + ' events · ' + state.graph.nodes.length + ' nodes';
}

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  var canvas = document.getElementById('nw-canvas');
  var wrap   = document.getElementById('nw-canvas-wrap');
  if (!canvas || !wrap) return;
  canvas.width  = wrap.clientWidth  || 800;
  canvas.height = wrap.clientHeight || 600;
  if (state.selectedCountry) { computeLayout(); renderGraph(); }
}

// ── Filter chip wiring ────────────────────────────────────────────────────────
function wireFilters() {
  // Only wire event-type + risk chips (scoped to filter section, not builder tabs)
  document.querySelectorAll('#nw-type-chips .nw-chip, #nw-risk-chips .nw-chip').forEach(function(btn) {
    btn.addEventListener('click', function() {
      this.classList.toggle('is-on');
      syncFilterState();
    });
  });

  document.getElementById('nw-time-select').addEventListener('change', function() {
    state.filters.timeRange = this.value;
    rebuildGraph();
  });

  document.getElementById('nw-country-search').addEventListener('input', function() {
    buildCountryList(this.value);
  });

  // ── Relationship Scanner ────────────────────────────────────────────────────
  var scanBtn = document.getElementById('btn-nw-scan');
  if (scanBtn) scanBtn.addEventListener('click', scanRelationships);

  // ── Export buttons ──────────────────────────────────────────────────────────
  var expJson = document.getElementById('btn-nw-export-json');
  var expMd   = document.getElementById('btn-nw-export-md');
  if (expJson) expJson.addEventListener('click', function() { exportGraph('json'); });
  if (expMd)   expMd.addEventListener('click',   function() { exportGraph('md');   });

  // Top-bar export button (shows JSON by default)
  var expTop = document.getElementById('btn-nw-export');
  if (expTop) expTop.addEventListener('click', function() { exportGraph('json'); });

  // ── Notes persistence ───────────────────────────────────────────────────────
  var notesIn = document.getElementById('nw-notes-input');
  var notesCl = document.getElementById('btn-nw-notes-clear');
  if (notesIn) notesIn.addEventListener('input', function() { saveNotes(notesIn.value); });
  if (notesCl) notesCl.addEventListener('click', function() {
    var ta = document.getElementById('nw-notes-input');
    if (ta) { ta.value = ''; saveNotes(''); }
  });

  // ── Intelligence panel tab buttons ─────────────────────────────────────────
  document.querySelectorAll('#nw-intel-tabs .nw-tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
  });

  // ── Context menu buttons ────────────────────────────────────────────────────
  var ctxEdit    = document.getElementById('nw-ctx-edit');
  var ctxReclass = document.getElementById('nw-ctx-reclassify');
  var ctxNote    = document.getElementById('nw-ctx-note');
  var ctxLink    = document.getElementById('nw-ctx-link');
  var ctxDelete  = document.getElementById('nw-ctx-delete');
  if (ctxEdit)    ctxEdit.addEventListener('click', editNodeLabel);
  if (ctxReclass) ctxReclass.addEventListener('click', reclassifyNode);
  if (ctxNote)    ctxNote.addEventListener('click', function() {
    var n = _ctxMenuNode; hideContextMenu(); if (n) noteForNode(n);
  });
  if (ctxLink) ctxLink.addEventListener('click', function() {
    var n = _ctxMenuNode; hideContextMenu();
    if (n) { state.linkMode.active = false; toggleLinkMode(); state.linkMode.sourceNode = n; var ind = document.getElementById('nw-link-indicator'); if (ind) ind.textContent = 'SOURCE: ' + n.label.slice(0,30) + '  ·  CLICK TARGET TO LINK'; }
  });
  if (ctxDelete) ctxDelete.addEventListener('click', deleteNode);
  // Dismiss context menu on outside mousedown
  document.addEventListener('mousedown', function(e) {
    if (_ctxMenuOpen && !e.target.closest('#nw-ctx-menu')) hideContextMenu();
  });

  // ── Sidebar mode toggle ─────────────────────────────────────────────────────
  document.querySelectorAll('#nw-sidebar-mode .nw-sidebar-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#nw-sidebar-mode .nw-sidebar-mode-btn').forEach(function(b){ b.classList.remove('is-active'); });
      this.classList.add('is-active');
      var mode = this.dataset.smode;
      var cs = document.getElementById('nw-countries-section');
      var bs = document.getElementById('nw-builder-section');
      if (mode === 'countries') {
        if (cs) cs.classList.remove('is-hidden');
        if (bs) bs.classList.remove('is-visible');
      } else {
        if (cs) cs.classList.add('is-hidden');
        if (bs) bs.classList.add('is-visible');
        renderNodeCandidates(state.builderType, '');
      }
    });
  });

  // ── Node builder type tabs ──────────────────────────────────────────────────
  document.querySelectorAll('#nw-builder-tabs .nw-chip').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#nw-builder-tabs .nw-chip').forEach(function(b){ b.classList.remove('is-on'); });
      this.classList.add('is-on');
      state.builderType = this.dataset.btype;
      if (state.builderType !== 'vessels') state.selectedChokepoint = null;
      var q = (document.getElementById('nw-builder-search') || {}).value || '';
      renderNodeCandidates(state.builderType, q);
    });
  });

  // ── Node builder search ─────────────────────────────────────────────────────
  var builderSearch = document.getElementById('nw-builder-search');
  if (builderSearch) builderSearch.addEventListener('input', function() {
    renderNodeCandidates(state.builderType, this.value);
  });

  // ── Add note node + link mode buttons ──────────────────────────────────────
  var addNoteBtn = document.getElementById('btn-nw-add-note');
  var linkModeBtn = document.getElementById('btn-nw-link-mode');
  if (addNoteBtn)  addNoteBtn.addEventListener('click', addNoteNode);
  if (linkModeBtn) linkModeBtn.addEventListener('click', toggleLinkMode);
}

function syncFilterState() {
  var types = [], risks = [];
  document.querySelectorAll('#nw-type-chips .nw-chip.is-on').forEach(function(b){ types.push(b.dataset.val); });
  document.querySelectorAll('#nw-risk-chips .nw-chip.is-on').forEach(function(b){ risks.push(b.dataset.val); });
  state.filters.types = new Set(types);
  state.filters.risks = new Set(risks);
  rebuildGraph();
}

// ── Open / Close ──────────────────────────────────────────────────────────────
var _initialized = false;

function open() {
  var overlay = document.getElementById('nw-overlay');
  if (!overlay) return;
  overlay.classList.add('is-open');
  document.getElementById('btn-neural-web').classList.add('is-active');

  if (!_initialized) {
    _initialized = true;
    wireFilters();
    setupCanvasInteraction();
    window.addEventListener('resize', resizeCanvas);
  }

  // Refresh data and rebuild
  refreshStore();
  resizeCanvas();
  buildCountryList();

  // Auto-select highest-risk country on first open
  if (!state.selectedCountry) {
    var top = (window.COUNTRIES_DATA || []).slice().sort(function(a,b){ return (b.score||0)-(a.score||0); })[0];
    if (top) { setCountry(top.label); buildCountryList(); }
  }

  // Update topbar
  updateTopbar();
}

function close() {
  var overlay = document.getElementById('nw-overlay');
  if (overlay) overlay.classList.remove('is-open');
  document.getElementById('btn-neural-web').classList.remove('is-active');
  hoveredNode = null;
  document.getElementById('nw-tooltip').classList.remove('is-visible');
}

function toggle() {
  // Gate: Neural Web requires a paid tier (pro / admin / owner)
  var tier = window.ArgusSession ? window.ArgusSession.tier : 'viewer';
  if (tier !== 'pro' && tier !== 'admin' && tier !== 'owner') {
    if (window.ArgusUI && typeof window.ArgusUI.showUpgradePrompt === 'function') {
      window.ArgusUI.showUpgradePrompt({
        title: 'NEURAL WEB ENGINE',
        desc:  'The Neural Web intelligence graph is available to Pro analysts. Upgrade to map relationships across geopolitical events, vessels, flights, and market signals.',
      });
    }
    return;
  }
  var overlay = document.getElementById('nw-overlay');
  if (overlay && overlay.classList.contains('is-open')) close();
  else open();
}

function updateTopbar() {
  var title = document.getElementById('nw-country-title');
  var sub   = document.getElementById('nw-subtitle');
  if (!title) return;
  if (state.selectedCountry) {
    title.textContent = state.selectedCountry.toUpperCase();
    var n = state.graph.nodes.length;
    var e = state.graph.edges.length;
    if (sub) sub.textContent = n + ' NODES · ' + e + ' EDGES';
  } else {
    title.textContent = 'SELECT A COUNTRY';
    if (sub) sub.textContent = '';
  }
  var empty = document.getElementById('nw-empty');
  if (empty) empty.style.display = state.selectedCountry ? 'none' : 'flex';
}

// Override setCountry to also update topbar
var _origSetCountry = setCountry;
setCountry = function(country) {
  _origSetCountry(country);
  updateTopbar();
};

// Keyboard shortcut: N = toggle neural web, ESC = cancel link mode
window.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && state.linkMode.active) { toggleLinkMode(); return; }
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (e.key.toLowerCase() === 'n') toggle();
});

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 5 — INTERACTIVE GRAPH BUILDER: Node candidates + Drag-drop + Link mode
// ═══════════════════════════════════════════════════════════════════════════════

var BUILDER_ICONS = { events:'🌍', disasters:'🌪', news:'📰', companies:'🏢', chokepoints:'◇', vessels:'🚢', flights:'✈' };

// ── Node candidate search by type ────────────────────────────────────────────
function buildNodeCandidates(type, query) {
  var ql = (query || '').toLowerCase().trim();
  var results = [];

  if (type === 'events') {
    // ── Primary: classified events already in store (plotted on globe) ────────
    store.events.slice(0, 200).forEach(function(ev) {
      if (ql && ev.title.toLowerCase().indexOf(ql) === -1) return;
      if (state.graph.nodes.some(function(n){ return n.id === ev.id; })) return;
      results.push({ id: ev.id, type: 'event', label: ev.title, badge: ev.risk, badgeColor: RISK_COLORS[ev.risk] || '#4a7da8', eventType: ev.type, risk: ev.risk, keywords: ev.keywords, timestamp: ev.timestamp, impact: ev.impact, source: ev.source, _ev: ev });
    });

    // ── Supplement: full GDELT classified feed (includes articles not yet plotted) ─
    // Reads from the live gdelt module first; falls back to localStorage cache.
    var _gdeltEvts = [];
    try {
      var _gd = window.gdelt && window.gdelt.getData ? window.gdelt.getData() : null;
      if (_gd && Array.isArray(_gd.events) && _gd.events.length) {
        _gdeltEvts = _gd.events;
      } else {
        var _gc = localStorage.getItem('argus_gdelt_v3');
        if (_gc) {
          var _gp = JSON.parse(_gc);
          var _ga = Array.isArray(_gp) ? _gp : (_gp.events || _gp.articles || []);
          _gdeltEvts = Array.isArray(_ga) ? _ga : [];
        }
      }
    } catch(_) {}

    // Deduplicate against already-added titles to avoid store.events overlap
    var _seenTitles = new Set(results.map(function(r){ return r.label; }));
    _gdeltEvts.slice(0, 100).forEach(function(a, gi) {
      var t = (a.title || a.TITLE || a.name || '').slice(0, 120);
      if (!t || _seenTitles.has(t)) return;
      if (ql && t.toLowerCase().indexOf(ql) === -1) return;
      var geid = 'gdelt_ev_' + gi;
      if (state.graph.nodes.some(function(n){ return n.id === geid; })) return;
      var sev = a.severity || 'WATCH';
      _seenTitles.add(t);
      results.push({
        id:        geid,
        type:      'event',
        label:     t,
        badge:     sev,
        badgeColor: RISK_COLORS[sev] || '#4a7da8',
        eventType: a.type || 'POLICY',
        risk:      sev,
        keywords:  extractKeywords(t),
        timestamp: 0,
        impact:    '',
        source:    a.url || a.sourceurl || a.domain || '',
        _ev:       a,
      });
    });

  } else if (type === 'disasters') {
    var disPool = [].concat(window._usgsEvents || [], window._noaaEvents || [], window._fireEvents || []);
    disPool.slice(0, 150).forEach(function(ev, i) {
      var t = ev.title || ev.name || '';
      if (!t || (ql && t.toLowerCase().indexOf(ql) === -1)) return;
      var nid = 'disaster_' + i + '_' + t.slice(0, 10).replace(/[^a-z0-9]/gi,'_');
      if (state.graph.nodes.some(function(n){ return n.id === nid; })) return;
      var rsk = ev.severity || ev.risk || 'WATCH';
      results.push({ id: nid, type: 'event', label: t, badge: rsk, badgeColor: RISK_COLORS[rsk] || '#ffcc00', eventType: 'DISASTER', risk: rsk, keywords: extractKeywords(t + ' ' + (ev.description || '')), _ev: ev });
    });

  } else if (type === 'news') {
    var newsPool = store.events.filter(function(ev){ return ev.type === 'POLICY' || ev.type === 'ECONOMIC'; }).slice(0, 80);

    // ── Source 1: NewsData.io classified feed (events box NEWS tab) ──────────
    // Same data that drives the main events feed — already classified with
    // severity, type, and keywords by fetchAndClassify(). Highest fidelity source.
    try {
      var ndRaw = localStorage.getItem('argus_live_events_v2');
      if (ndRaw) {
        var ndEvts = JSON.parse(ndRaw);
        (Array.isArray(ndEvts) ? ndEvts : []).slice(0, 60).forEach(function(a, ni) {
          var t = a.title || '';
          if (t) newsPool.push({
            id:       'nd_' + ni,
            type:     a.type || 'POLICY',
            risk:     a.severity || a.risk || 'WATCH',
            title:    t,
            timestamp: a.time || 0,
            keywords: a.keywords || extractKeywords(t),
            impact:   a.impact || '',
            source:   a.link || a.source || '',
          });
        });
      }
    } catch(_) {}

    // ── Source 2: GDELT classified feed ─────────────────────────────────────
    try {
      var gc3 = localStorage.getItem('argus_gdelt_v3');
      if (gc3) {
        var gd3 = JSON.parse(gc3);
        var arts3 = Array.isArray(gd3) ? gd3 : (gd3.events || gd3.articles || []);
        (Array.isArray(arts3) ? arts3 : []).slice(0, 50).forEach(function(a, ii) {
          var t2 = a.title || a.TITLE || a.name || '';
          if (t2) newsPool.push({ id: 'gdelt_' + ii, type: 'POLICY', risk: 'WATCH', title: t2, timestamp: 0, keywords: extractKeywords(t2), impact: '', source: a.sourceurl || a.url || '' });
        });
      }
    } catch(_) {}

    newsPool.forEach(function(ev) {
      var t3 = ev.title || '';
      if (!t3 || (ql && t3.toLowerCase().indexOf(ql) === -1)) return;
      var nid2 = 'news:' + ev.id;
      if (state.graph.nodes.some(function(n){ return n.id === nid2; })) return;
      results.push({ id: nid2, type: 'news', label: t3, badge: ev.risk || 'WATCH', badgeColor: RISK_COLORS[ev.risk] || '#ffcc00', eventType: ev.type || 'POLICY', risk: ev.risk || 'WATCH', keywords: ev.keywords || [], source: ev.source || '', _ev: ev });
    });

  } else if (type === 'companies') {
    var compPool = KNOWN_COMPANIES.concat([
      'lockheed','raytheon','bae systems','thales','rheinmetall','hanwha','saab',
      'pemex','gazprom','rosneft','petrobras','equinor','chevron','totalenergies',
      'riotinto','bhp','glencore','vale','freeport','alcoa',
      'walmart','amazon','alibaba','tencent','microsoft',
    ]);
    compPool.forEach(function(co) {
      if (ql && co.indexOf(ql) === -1) return;
      var cid = 'entity:co:' + co;
      if (state.graph.nodes.some(function(n){ return n.id === cid; })) return;
      results.push({ id: cid, type: 'company', label: co.charAt(0).toUpperCase() + co.slice(1), badge: 'CORP', badgeColor: '#ff99aa', entityType: 'company', risk: 'LOW', keywords: [co] });
    });

  } else if (type === 'chokepoints') {
    var analytics_cpt = computeAllChokepointAnalytics();
    var RISK_COL_B = { CRITICAL:'#ff0044', WARNING:'#ff9933', WATCH:'#ffcc00', LOW:'#00ff88' };
    (window.CHOKEPOINTS_DATA || []).forEach(function(cp) {
      if (ql && cp.label.toLowerCase().indexOf(ql) === -1) return;
      var cid = 'chokepoint:' + cp.id;
      if (state.graph.nodes.some(function(n){ return n.id === cid; })) return;
      var d = analytics_cpt[cp.id] || {};
      var rCol = RISK_COL_B[cp.risk] || '#4a7da8';
      results.push({
        id: cid, type: 'chokepoint', label: cp.label,
        badge: cp.risk, badgeColor: rCol,
        risk: cp.risk, traffic: cp.traffic, volume: cp.volume, status: cp.status,
        chokepointId: cp.id, rawLat: cp.rawLat, rawLon: cp.rawLon,
        shipCount: d.shipCount || 0, flightCount: d.flightCount || 0,
        keywords: [cp.label.toLowerCase(), cp.risk.toLowerCase()],
        // store drill-down count for display
        _vesselCount: d.shipCount || 0,
      });
    });

  } else if (type === 'vessels') {
    var vesPool = [];
    try {
      var vc2 = localStorage.getItem('argus_vessels') || localStorage.getItem('argus_ais_v1');
      if (vc2) vesPool = JSON.parse(vc2) || [];
    } catch(_) {}
    if (!Array.isArray(vesPool)) vesPool = [];
    // Pull from live vessel markers
    (window._vesselMarkers || []).forEach(function(s) {
      var ud = s && s.userData;
      if (ud && ud.isShip && ud.lat != null) {
        vesPool.push({ name: ud.title || ud.name || '', lat: ud.lat, lon: ud.lon,
                       type: ud.typeCategory || 'other', typeCategory: ud.typeCategory });
      }
    });
    if (window._vesselData && Array.isArray(window._vesselData)) vesPool = vesPool.concat(window._vesselData);

    // Spatial assignment: tag each vessel with nearest chokepoint within 450km
    var VES_RADIUS_KM = 450;
    var cpList = window.CHOKEPOINTS_DATA || [];
    vesPool.forEach(function(v) {
      if (v._cpId !== undefined) return; // already tagged
      var vlat = parseFloat(v.lat || v.LAT || 0);
      var vlon = parseFloat(v.lon || v.LON || 0);
      if (!vlat && !vlon) { v._cpId = null; return; }
      var bestCp = null, bestDist = Infinity;
      cpList.forEach(function(cp) {
        var d = haversineKm(cp.rawLat, cp.rawLon, vlat, vlon);
        if (d < VES_RADIUS_KM && d < bestDist) { bestDist = d; bestCp = cp; }
      });
      v._cpId    = bestCp ? bestCp.id    : null;
      v._cpLabel = bestCp ? bestCp.label : null;
      v._lat = vlat; v._lon = vlon;
    });

    // Filter by selected chokepoint if drilling down
    var filteredPool = vesPool;
    if (state.selectedChokepoint) {
      filteredPool = vesPool.filter(function(v){ return v._cpId === state.selectedChokepoint; });
    }

    if (!filteredPool.length && !state.selectedChokepoint) {
      // Static fallback when no live data and no drill-down active
      filteredPool = [
        { id:'vessel_suez',      name:'SUEZ CANAL ROUTE',    type:'ROUTE', _cpId:'suez'      },
        { id:'vessel_hormuz',    name:'STRAIT OF HORMUZ',     type:'ROUTE', _cpId:'hormuz'    },
        { id:'vessel_malacca',   name:'STRAIT OF MALACCA',    type:'ROUTE', _cpId:'malacca'   },
        { id:'vessel_taiwan',    name:'TAIWAN STRAIT',        type:'ROUTE', _cpId:'taiwan_cp' },
        { id:'vessel_bosphorus', name:'BOSPHORUS STRAIT',     type:'ROUTE', _cpId:'bosphorus' },
        { id:'vessel_bab',       name:'BAB-EL-MANDEB STRAIT', type:'ROUTE', _cpId:'bab_cp'    },
        { id:'vessel_panama',    name:'PANAMA CANAL ROUTE',   type:'ROUTE', _cpId:'panama_cp' },
      ];
    }
    filteredPool.slice(0, 100).forEach(function(v) {
      var vname = v.name || v.shipname || v.vessel || v.SHIPNAME || '';
      if (!vname || (ql && vname.toLowerCase().indexOf(ql) === -1)) return;
      var vid = v.id || ('vessel:' + vname.replace(/\s+/g,'_'));
      if (state.graph.nodes.some(function(n){ return n.id === vid; })) return;
      var cat = (v.typeCategory || v.type || 'other').toLowerCase();
      var CAT_COLORS = { cargo:'#4488ff', tanker:'#ff9933', military:'#ff4444', passenger:'#00ff88', fishing:'#ffcc00', other:'#5577aa' };
      results.push({
        id: vid, type: 'vessel', label: vname,
        badge: cat.toUpperCase(), badgeColor: CAT_COLORS[cat] || '#00ccff',
        risk: 'WATCH', keywords: [vname.toLowerCase()],
        lat: v._lat || null, lon: v._lon || null,
        typeCategory: cat,
        chokepointId: v._cpId, chokepointLabel: v._cpLabel,
      });
    });

  } else if (type === 'flights') {
    var flPool = [];
    // Pull from localStorage snapshot (primary source)
    try {
      var flRaw = localStorage.getItem('argus_traffic_v4');
      if (flRaw) {
        var flJson = JSON.parse(flRaw);
        flPool = Array.isArray(flJson) ? flJson : (Array.isArray(flJson.aircraft) ? flJson.aircraft : []);
      }
    } catch(_){}
    // Also pull from live markers in memory
    var liveAcArr = window._aircraftMarkers || [];
    liveAcArr.forEach(function(s) {
      var ud = s.userData;
      if (ud && ud.isAircraft && ud.lat != null) {
        flPool.push({ icao24: ud.icao24, cs: ud.title, lat: ud.lat, lon: ud.lon,
                      flightType: ud.flightType, alt: ud.alt, region: ud.region });
      }
    });
    // Fallback: major air corridors as static nodes
    if (!flPool.length) {
      flPool = [
        { id:'ac_north_atlantic', cs:'NORTH ATLANTIC CORRIDOR', flightType:'commercial', region:'NAT'      },
        { id:'ac_transpacific',   cs:'TRANS-PACIFIC CORRIDOR',  flightType:'commercial', region:'PACIFIC'  },
        { id:'ac_europe_asia',    cs:'EUROPE-ASIA CORRIDOR',    flightType:'cargo',      region:'EUR-ASIA' },
        { id:'ac_middle_east',    cs:'MIDDLE EAST CORRIDOR',    flightType:'commercial', region:'MID-EAST' },
        { id:'ac_nato_corridor',  cs:'NATO AIR CORRIDOR',       flightType:'military',   region:'EUROPE'   },
        { id:'ac_polar_route',    cs:'POLAR ROUTE',             flightType:'commercial', region:'ARCTIC'   },
      ];
    }
    var FT_COLORS_B = { commercial:'#66ddff', cargo:'#4488ff', military:'#ff4444', unknown:'#5577aa' };
    var flSeen = new Set();
    flPool.slice(0, 150).forEach(function(ac) {
      var cs3 = (ac.cs || ac.callsign || '').trim();
      if (!cs3 || flSeen.has(cs3)) return;
      flSeen.add(cs3);
      if (ql && cs3.toLowerCase().indexOf(ql) === -1) return;
      var fid3 = ac.id || ('aircraft:' + (ac.icao24 || cs3.replace(/[^a-z0-9]/gi,'_')));
      if (state.graph.nodes.some(function(n){ return n.id === fid3; })) return;
      var ft3   = (ac.flightType || 'unknown').toLowerCase();
      var bc3   = FT_COLORS_B[ft3] || '#5577aa';
      results.push({
        id: fid3, type: 'aircraft', label: cs3,
        badge: ft3.toUpperCase(), badgeColor: bc3,
        flightType: ft3, risk: 'LOW',
        lat: ac.lat || null, lon: ac.lon || null,
        region: ac.region || '',
        altitude: ac.alt || null,
        keywords: [cs3.toLowerCase(), ft3, ac.region || ''],
      });
    });
  }

  return results.slice(0, 40);
}

// ── Render candidate list with draggable items ────────────────────────────────
var _candidateCache = {};

function renderNodeCandidates(type, query) {
  var el = document.getElementById('nw-builder-results');
  if (!el) return;
  var results = buildNodeCandidates(type, query);
  _candidateCache = {};
  results.forEach(function(r){ _candidateCache[r.id] = r; });

  var icon = BUILDER_ICONS[type] || '·';
  var html = '';

  // ── Vessels: back button when drilling into a chokepoint ──────────────────
  if (type === 'vessels' && state.selectedChokepoint) {
    var cpObj = (window.CHOKEPOINTS_DATA || []).find(function(c){ return c.id === state.selectedChokepoint; });
    var cpLbl = cpObj ? cpObj.label : state.selectedChokepoint;
    html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 10px 4px;border-bottom:1px solid #1a0840">' +
      '<button data-nw-back-vessels style="background:none;border:1px solid #2a1050;color:#7755cc;font-size:7px;letter-spacing:1px;padding:2px 6px;cursor:pointer;border-radius:2px">← BACK</button>' +
      '<span style="font-size:7px;letter-spacing:1px;color:#4a7da8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">◇ ' + cpLbl.toUpperCase() + '</span>' +
      '</div>';
  }

  if (!results.length) {
    html += '<div style="padding:20px 14px;font-size:8px;letter-spacing:1.5px;color:var(--nw-purple-dim);opacity:0.5;text-align:center">' +
      (state.selectedChokepoint ? 'NO VESSELS IN RANGE' : (state.selectedCountry ? 'NO RESULTS' : 'SELECT A COUNTRY FIRST')) + '</div>';
    el.innerHTML = html;
    _bindCandidateEvents(el, type);
    return;
  }

  // ── Chokepoints: show vessel count + drill-in button beside each ──────────
  if (type === 'chokepoints') {
    html += results.map(function(r) {
      var bc = r.badgeColor || '#4a7da8';
      var vesCount = r._vesselCount || 0;
      return '<div class="nw-candidate" draggable="true" data-nid="' + r.id + '" title="Drag to add, or use ▸ to browse vessels">' +
        '<span class="nw-candidate-icon">' + icon + '</span>' +
        '<span class="nw-candidate-label" style="flex:1">' + r.label.slice(0, 60) + '</span>' +
        '<span style="font-size:7px;color:#4a7da8;margin-right:4px;flex-shrink:0">' + (vesCount ? '⚓' + vesCount : '') + '</span>' +
        '<span class="nw-candidate-meta" style="background:' + hexToRgba(bc,0.15) + ';color:' + bc + ';border:1px solid ' + hexToRgba(bc,0.4) + '">' + r.badge + '</span>' +
        '<button data-nw-drill="' + r.chokepointId + '" title="Browse vessels at this chokepoint" ' +
          'style="margin-left:4px;background:none;border:1px solid #2a1050;color:#7755cc;font-size:8px;padding:1px 5px;cursor:pointer;border-radius:2px;flex-shrink:0">▸</button>' +
        '</div>';
    }).join('');
  } else {
    html += results.map(function(r) {
      var bc = r.badgeColor || '#4a7da8';
      var sub = (type === 'vessels' && r.chokepointLabel)
        ? '<span style="font-size:6px;color:#4a6888;display:block;margin-top:1px">◇ ' + r.chokepointLabel + '</span>'
        : '';
      return '<div class="nw-candidate" draggable="true" data-nid="' + r.id + '" title="Drag to canvas or click to add">' +
        '<span class="nw-candidate-icon">' + icon + '</span>' +
        '<span class="nw-candidate-label" style="flex:1">' + r.label.slice(0, 80) + sub + '</span>' +
        '<span class="nw-candidate-meta" style="background:' + hexToRgba(bc,0.15) + ';color:' + bc + ';border:1px solid ' + hexToRgba(bc,0.4) + '">' + r.badge + '</span>' +
        '</div>';
    }).join('');
  }

  el.innerHTML = html;
  _bindCandidateEvents(el, type);
}

function _bindCandidateEvents(el, type) {
  // Drag + click to add
  el.querySelectorAll('.nw-candidate[draggable]').forEach(function(item) {
    item.addEventListener('dragstart', function(e) {
      var data = _candidateCache[this.dataset.nid];
      if (data) { e.dataTransfer.setData('text/plain', JSON.stringify(data)); e.dataTransfer.effectAllowed = 'copy'; }
    });
    item.addEventListener('click', function(e) {
      // Don't add node if the drill or back button was clicked
      if (e.target.dataset.nwDrill || e.target.dataset.nwBackVessels !== undefined) return;
      var data = _candidateCache[this.dataset.nid];
      if (data) addManualNode(data, null, null);
    });
  });

  // Chokepoint drill-down: switch to vessels view filtered by this chokepoint
  el.querySelectorAll('[data-nw-drill]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      state.selectedChokepoint = this.dataset.nwDrill;
      // Switch builder tab to vessels
      document.querySelectorAll('#nw-builder-tabs .nw-chip').forEach(function(b){ b.classList.remove('is-on'); });
      var vesBtn = document.querySelector('#nw-builder-tabs .nw-chip[data-btype="vessels"]');
      if (vesBtn) vesBtn.classList.add('is-on');
      state.builderType = 'vessels';
      var q = (document.getElementById('nw-builder-search') || {}).value || '';
      renderNodeCandidates('vessels', q);
    });
  });

  // Back button: clear selected chokepoint
  var backBtn = el.querySelector('[data-nw-back-vessels]');
  if (backBtn) {
    backBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      state.selectedChokepoint = null;
      var q = (document.getElementById('nw-builder-search') || {}).value || '';
      renderNodeCandidates('vessels', q);
    });
  }
}

// ── Add a node to the graph (from drag-drop or click) ────────────────────────
function addManualNode(nodeData, canvasX, canvasY) {
  if (!nodeData) return;
  if (state.graph.nodes.some(function(n){ return n.id === nodeData.id; })) return;

  var canvas = document.getElementById('nw-canvas');
  if (!canvas) return;
  var cx = canvas.width / 2, cy = canvas.height / 2;
  var x = (canvasX !== null && canvasX !== undefined) ? canvasX : cx + (Math.random() - 0.5) * cx * 0.8;
  var y = (canvasY !== null && canvasY !== undefined) ? canvasY : cy + (Math.random() - 0.5) * cy * 0.8;

  // Deep-clone to avoid reference issues
  var node = JSON.parse(JSON.stringify(nodeData));
  layout[node.id] = { x: x, y: y, vx: 0, vy: 0, r: getNodeRadius(node) };
  state.graph.nodes = state.graph.nodes.concat([node]);

  autoCorrelateNode(node);
  state.graph.edges = buildEdges(state.graph.nodes, []);
  renderGraph();
  updateTopbar();

  // Refresh candidate list (item disappears once added)
  var q = (document.getElementById('nw-builder-search') || {}).value || '';
  renderNodeCandidates(state.builderType, q);
}

// ── Auto-correlation for newly dropped node ───────────────────────────────────
function autoCorrelateNode(newNode) {
  var newAuto = [], newManual = [];
  var cid = state.selectedCountry ? 'country:' + state.selectedCountry : null;

  // 1. Structural edge to country anchor
  if (cid && newNode.type !== 'topic' && newNode.type !== 'country') {
    newManual.push({ source: cid, target: newNode.id, weight: 1, edgeType: 'country', detected: false });
  }

  // 2. Keyword overlap with existing events/news
  state.graph.nodes.filter(function(n){ return (n.type === 'event' || n.type === 'news') && n.id !== newNode.id; }).forEach(function(en) {
    var shared = (newNode.keywords || []).filter(function(k){ return k.length > 4 && (en.keywords || []).indexOf(k) !== -1; });
    if (!shared.length) return;
    var et = 'correlation';
    var combined = ((newNode.label||'') + ' ' + (en.label||'')).toLowerCase();
    if (CAUSALITY_VERBS.some(function(v){ return combined.indexOf(v) !== -1; })) et = 'causality';
    else if (DEPENDENCY_VERBS.some(function(v){ return combined.indexOf(v) !== -1; })) et = 'dependency';
    newAuto.push({ source: newNode.id, target: en.id, weight: 2, edgeType: et, detected: true });
  });

  // 3. Company/vessel name match in event text
  if (newNode.type === 'company' || newNode.type === 'vessel') {
    var nameLow = (newNode.label || '').toLowerCase();
    state.graph.nodes.filter(function(n){ return n.type === 'event'; }).forEach(function(en) {
      if (((en.label||'') + ' ' + (en.impact||'')).toLowerCase().indexOf(nameLow) !== -1)
        newAuto.push({ source: en.id, target: newNode.id, weight: 1.5, edgeType: 'dependency', detected: true });
    });
  }

  // 4. Note auto-links to currently selected node
  if (newNode.type === 'note' && selectedNode && selectedNode.id !== newNode.id) {
    newManual.push({ source: selectedNode.id, target: newNode.id, weight: 1, edgeType: 'manual', detected: false, manual: true });
  }

  state.relEdges    = (state.relEdges    || []).concat(newAuto);
  state.manualEdges = (state.manualEdges || []).concat(newManual);

  // Inspector feedback
  var insp = document.getElementById('nw-insp-body');
  if (insp) {
    var ac = newAuto.filter(function(e){ return e.detected; }).length;
    insp.innerHTML =
      field('NODE ADDED', '<span style="color:var(--nw-purple)">' + newNode.label.slice(0,55) + '</span>') +
      field('AUTO-DETECTED', ac + ' relationship' + (ac === 1 ? '' : 's')) +
      (ac === 0
        ? field('SUGGESTION', '<span style="color:#ffe066">No correlation found — add a 📝 Note Node or use ⟷ LINK NODES</span>')
        : field('STATUS', ac < 2 ? 'Weak signal — verify manually' : 'Edges drawn automatically'));
    switchTab('inspect');
  }
}

// ── Note Node creation ────────────────────────────────────────────────────────
function addNoteNode() {
  var text = prompt('Note text (will appear as a graph node):');
  if (!text || !text.trim()) return;
  addManualNode({
    id:       'note:' + Date.now(),
    type:     'note',
    label:    text.trim().slice(0, 80),
    noteText: text.trim(),
    risk:     'LOW',
    keywords: extractKeywords(text),
  }, null, null);
}

// ── Manual link mode ──────────────────────────────────────────────────────────
function toggleLinkMode() {
  state.linkMode.active = !state.linkMode.active;
  state.linkMode.sourceNode = null;
  var btn  = document.getElementById('btn-nw-link-mode');
  var ind  = document.getElementById('nw-link-indicator');
  var wrap = document.getElementById('nw-canvas-wrap');
  if (state.linkMode.active) {
    if (btn)  btn.classList.add('is-active');
    if (ind)  { ind.classList.add('is-visible'); ind.textContent = 'CLICK SOURCE NODE  ·  ESC TO CANCEL'; }
    if (wrap) wrap.classList.add('link-mode');
  } else {
    if (btn)  btn.classList.remove('is-active');
    if (ind)  ind.classList.remove('is-visible');
    if (wrap) wrap.classList.remove('link-mode');
    renderGraph();
  }
}

function handleLinkClick(node) {
  if (!state.linkMode.active) return false;
  if (!state.linkMode.sourceNode) {
    state.linkMode.sourceNode = node;
    var ind = document.getElementById('nw-link-indicator');
    if (ind) ind.textContent = 'FROM: ' + node.label.slice(0,28) + '  →  CLICK TARGET';
    renderGraph();
    return true;
  }
  var src = state.linkMode.sourceNode, tgt = node;
  if (src.id !== tgt.id) {
    var exists = (state.manualEdges || []).some(function(e){ return (e.source===src.id&&e.target===tgt.id)||(e.source===tgt.id&&e.target===src.id); });
    if (!exists) {
      state.manualEdges = (state.manualEdges || []).concat([{ source: src.id, target: tgt.id, weight: 2, edgeType: 'manual', detected: false, manual: true }]);
      state.graph.edges = buildEdges(state.graph.nodes, []);
      renderGraph();
      updateTopbar();
      var insp = document.getElementById('nw-insp-body');
      if (insp) {
        insp.innerHTML =
          field('MANUAL LINK CREATED', '<span style="color:#00ff88">' + src.label.slice(0,30) + ' ⟷ ' + tgt.label.slice(0,30) + '</span>') +
          field('TYPE', 'USER-DEFINED EDGE') +
          field('TIP', '<span style="color:#ffe066">Add a 📝 Note Node to explain this relationship</span>');
        switchTab('inspect');
      }
    }
  }
  state.linkMode.sourceNode = null;
  var ind2 = document.getElementById('nw-link-indicator');
  if (ind2) ind2.textContent = 'CLICK SOURCE NODE  ·  ESC TO CANCEL';
  return true;
}

// ── Delete node ───────────────────────────────────────────────────────────────
function deleteNode() {
  var node = _ctxMenuNode;
  hideContextMenu();
  if (!node || node.type === 'country') return;
  state.graph.nodes  = state.graph.nodes.filter(function(n){ return n.id !== node.id; });
  state.relEdges     = (state.relEdges    || []).filter(function(e){ return e.source !== node.id && e.target !== node.id; });
  state.manualEdges  = (state.manualEdges || []).filter(function(e){ return e.source !== node.id && e.target !== node.id; });
  if (selectedNode && selectedNode.id === node.id) { selectedNode = null; showInspector(null); }
  delete layout[node.id];
  state.graph.edges = buildEdges(state.graph.nodes, []);
  renderGraph();
  updateTopbar();
}

// ── Ingest payload from event bus ─────────────────────────────────────────────
// Derives risk level and risk score from market data for use in node coloring.
function deriveMarketRisk(payload) {
  var pct = payload.data && payload.data.change_percent;
  if (pct == null) return 'WATCH';
  if (pct < -5) return 'CRITICAL';
  if (pct < -2) return 'WARNING';
  return 'WATCH';
}

function ingest(payload) {
  if (!payload || !payload.type || !payload.data) return;

  var nodeId = payload.type + ':' + (payload.data.ticker || payload.source) + ':' + payload.timestamp;

  var node = {
    id:        nodeId,
    type:      payload.type,
    label:     payload.data.ticker || nodeId,
    risk:      deriveMarketRisk(payload),
    source:    payload.source,
    timestamp: payload.timestamp,
    _payload:  payload.data,
  };

  // Open overlay first so canvas is sized before addManualNode computes position
  open();
  // Add to graph with random canvas position (addManualNode handles layout + re-render)
  addManualNode(node, null, null);
}

// ── Public API ────────────────────────────────────────────────────────────────
return {
  open:          open,
  close:         close,
  toggle:        toggle,
  ingest:        ingest,
  setCountry:    function(c){ setCountry(c); buildCountryList(); updateTopbar(); },
  updateFilters:    updateFilters,
  rebuildGraph:     rebuildGraph,
  scanRelationships: scanRelationships,
  exportGraph:      exportGraph,
  getState:         function(){ return state; },
  getStore:         function(){ return store; },
  // Analytics bridge — exposes IIFE-scoped functions for ArgusAnalytics
  getAnalyticsData: function() {
    return {
      snap:        collectTrackingSnapshot(),
      cpAnalytics: computeAllChokepointAnalytics(),
    };
  },
  getPortAnalytics: buildPortAnalytics,
  appendNote: function(text) {
    open();
    var ta = document.getElementById('nw-notes-input');
    if (ta) {
      if (!ta.value) ta.value = loadNotes();
      ta.value = (ta.value ? ta.value.trimEnd() + '\n\n' : '') + text;
      saveNotes(ta.value);
    }
    switchTab('notes');
  },
};

if (window.ArgusModuleAudit) window.ArgusModuleAudit.register('ArgusNeuralWeb');
}());
