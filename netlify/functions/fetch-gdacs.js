// netlify/functions/fetch-gdacs.js
// Proxies GDACS disaster event list. No API key required.
// Server-side fetch bypasses the CORS restriction that blocks browsers on GitHub Pages.

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800', // 30 min — disaster events update infrequently
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  var source = 'gdacs';
  var GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP' +
    '?eventtypes=EQ,TC,FL,VO,DR,WF&alertlevel=Green,Orange,Red&limit=50';

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 10000);

    var res = await fetch(GDACS_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ArgusIntel/1.0',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error('GDACS HTTP ' + res.status);

    var json = await res.json();
    var events = json && (json.features || json.events || []);

    // Normalise — GDACS returns GeoJSON FeatureCollection
    if (json && json.type === 'FeatureCollection') {
      events = json.features || [];
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ data: events, source: source, ts: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('fetch-gdacs error:', err.message);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message, source: source }),
    };
  }
};
