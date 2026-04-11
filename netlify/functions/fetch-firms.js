// netlify/functions/fetch-firms.js
// Proxies NASA FIRMS VIIRS SNPP active fire CSV, clusters into 2-degree grid cells.
// Env: FIRMS_MAP_KEY (NASA FIRMS MAP key)

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  var FIRMS_KEY = process.env.FIRMS_MAP_KEY;
  var source = 'firms';

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 10000);

    // NASA FIRMS requires MAP key in the URL path for authenticated access
    var firmsUrl = FIRMS_KEY
      ? 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' + FIRMS_KEY + '/VIIRS_SNPP_NRT/world/1'
      : 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';

    var res = await fetch(firmsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ArgusIntel/1.0' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error('FIRMS HTTP ' + res.status);

    var csv = await res.text();
    if (!csv || csv.indexOf(',') === -1) throw new Error('FIRMS: empty or invalid CSV');

    var rows = csv.trim().split('\n');
    var headers_csv = rows[0].split(',');
    var latIdx    = headers_csv.indexOf('latitude');
    var lonIdx    = headers_csv.indexOf('longitude');
    var brightIdx = headers_csv.indexOf('bright_ti4');
    var confIdx   = headers_csv.indexOf('confidence');

    if (latIdx === -1) {
      // Fallback column positions for the authenticated API variant
      latIdx    = 0;
      lonIdx    = 1;
      brightIdx = 2;
      confIdx   = 8;
    }

    // Cluster into 2-degree grid cells
    var grid = {};
    rows.slice(1).forEach(function(row) {
      if (!row.trim()) return;
      var cols = row.split(',');
      var lat  = parseFloat(cols[latIdx]);
      var lon  = parseFloat(cols[lonIdx]);
      var conf = (cols[confIdx] || '').trim();
      var bright = parseFloat(cols[brightIdx]) || 0;
      if (isNaN(lat) || isNaN(lon)) return;
      if (conf === 'l') return; // skip low confidence
      var key = Math.round(lat / 2) + ',' + Math.round(lon / 2);
      if (!grid[key]) grid[key] = { lat: lat, lon: lon, count: 0, maxBrightness: 0 };
      grid[key].count++;
      if (bright > grid[key].maxBrightness) grid[key].maxBrightness = bright;
    });

    // Sort by count desc, return top 20 clusters
    var clusters = Object.keys(grid)
      .map(function(k) { return grid[k]; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 20)
      .map(function(g) {
        return {
          lat:           parseFloat(g.lat.toFixed(4)),
          lon:           parseFloat(g.lon.toFixed(4)),
          count:         g.count,
          maxBrightness: g.maxBrightness,
        };
      });

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ data: clusters, source: source, ts: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('fetch-firms error:', err.message);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message, source: source }),
    };
  }
};
