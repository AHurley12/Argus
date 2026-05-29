// src/debug/testAdsb.js
// ADS-B multi-region test utility — correctness validation only.
// No caching, no workers, no abstraction layers.
//
// Exposed as window.testAdsb() for console access.
// Usage: testAdsb()

var CENTERS = [
  { label: 'US East',     lat: 40,  lon: -75  },
  { label: 'US Central',  lat: 37,  lon: -100 },
  { label: 'Europe',      lat: 50,  lon:  10  },
  { label: 'Middle East', lat: 25,  lon:  55  },
  { label: 'East Asia',   lat: 35,  lon:  125 },
];

function fetchRegion(center) {
  var url = '/adsb/api/v2/lat/' + center.lat + '/lon/' + center.lon + '/dist/249';
  console.log('[ADSB FETCH]', center.label, '->', url);

  return fetch(url, { headers: { Accept: 'application/json' } })
    .then(function(resp) {
      console.log('[ADSB STATUS]', center.label, resp.status);

      var ct = resp.headers.get('content-type') || '';
      console.log('[ADSB CONTENT-TYPE]', center.label, ct || '(none)');

      if (!ct.includes('application/json')) {
        return resp.text().then(function(text) {
          console.error('[ADSB INVALID RESPONSE]', center.label, text.slice(0, 300));
          return [];
        });
      }

      if (!resp.ok) {
        console.warn('[ADSB STATUS]', center.label, 'non-OK:', resp.status);
        return [];
      }

      return resp.json()
        .then(function(d) {
          console.log('[ADSB JSON OK]', center.label);

          if (!d || !Array.isArray(d.aircraft)) {
            console.warn('[ADSB AIRCRAFT COUNT]', center.label, '0 — no aircraft array. Keys:', Object.keys(d || {}).join(', '));
            return [];
          }

          console.log('[ADSB AIRCRAFT COUNT]', center.label, d.aircraft.length);
          return d.aircraft;
        })
        .catch(function(err) {
          console.error('[ADSB JSON PARSE ERROR]', center.label, err.message);
          return [];
        });
    })
    .catch(function(err) {
      console.error('[ADSB FETCH ERROR]', center.label, err.message);
      return [];
    });
}

function runAdsbTest() {
  console.log('[ADSB TEST] ══ START MULTI-REGION POLL ══');

  return Promise.allSettled(CENTERS.map(fetchRegion))
    .then(function(results) {
      var seen   = {};
      var merged = [];

      results.forEach(function(r) {
        if (r.status !== 'fulfilled') return;
        r.value.forEach(function(ac) {
          if (!ac || !ac.hex || ac.lat == null || ac.lon == null) return;
          if (seen[ac.hex]) return;
          seen[ac.hex] = true;
          merged.push(ac);
        });
      });

      console.log('[ADSB TOTAL UNIQUE]', merged.length, 'aircraft across', CENTERS.length, 'regions');
      console.log('[ADSB TEST] ══ END ══');
      return merged;
    });
}

window.testAdsb = runAdsbTest;

export { runAdsbTest };
