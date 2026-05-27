'use strict';
// netlify/functions/get-opensky-token.js
// Credential relay for browser-direct OpenSky polling.
//
// OpenSky Network blocks Netlify/AWS IP ranges, so the fetch-opensky proxy
// function cannot reach opensky-network.org. Browser-direct polling bypasses
// this by making the API call from the user's IP. However, credentials must
// not be hardcoded in client-side JS. This function vends the pre-encoded
// Basic Auth header value at runtime so the browser can use it without the
// credentials ever appearing in the repo.
//
// Response: { auth: '<base64 user:pass>' }  — or { auth: null } if unset.
// Cache-Control: 1 hour (credentials don't rotate frequently).
// No Supabase dependency — intentionally lightweight and fast.
//
// Env: OPENSKY_ID (username), OPENSKY_SECRET (password)

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: '',
    };
  }

  const user = process.env.OPENSKY_ID     || '';
  const pass = process.env.OPENSKY_SECRET || '';

  if (!user || !pass) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=3600',
      },
      body: JSON.stringify({ auth: null }),
    };
  }

  const auth = Buffer.from(user + ':' + pass).toString('base64');

  return {
    statusCode: 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=3600',
    },
    body: JSON.stringify({ auth }),
  };
};
