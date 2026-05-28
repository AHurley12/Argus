'use strict';
// netlify/functions/fetch-reliefweb.js
// UN OCHA ReliefWeb active crises proxy.
//
// ReliefWeb's POST API works fine server-side but the OPTIONS preflight fails from
// browser origins (CORS). This function proxies the request server-side.
//
// Response shape:
//   { data: [...], count: N, source: 'reliefweb', ts: epoch }
//
// Env: none required.

const RW_URL    = 'https://api.reliefweb.int/v1/disasters?appname=argus-intel';
const TIMEOUT_MS = 10000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;

  let raw;
  try {
    const resp = await fetch(RW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        filter: { field: 'status', value: 'current' },
        fields: { include: ['name', 'country', 'type', 'date', 'status'] },
        limit: 20,
      }),
      signal,
    });

    if (!resp.ok) {
      console.warn('[fetch-reliefweb] HTTP', resp.status);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ data: [], source: 'reliefweb', ts: Date.now(), note: 'upstream HTTP ' + resp.status }),
      };
    }

    raw = await resp.json();
  } catch (err) {
    console.warn('[fetch-reliefweb] fetch error:', err.message);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ data: [], source: 'reliefweb', ts: Date.now(), note: err.message }),
    };
  }

  const data = Array.isArray(raw.data) ? raw.data : [];
  console.log('[fetch-reliefweb] returned', data.length, 'crises');

  return {
    statusCode: 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
    }),
    body: JSON.stringify({ data, source: 'reliefweb', ts: Date.now(), count: data.length }),
  };
};
