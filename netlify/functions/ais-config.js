// netlify/functions/ais-config.js
// Returns the AISstream API key to the frontend so it never lives in source code.
//
// Setup:
//   1. Netlify dashboard → Site → Environment variables → Add:
//        AISSTREAM_KEY = your_key_here
//   2. Deploy — the key is injected at runtime, never committed to git.
//
// Security posture: this endpoint is public (no auth check), so anyone who
// loads the site can retrieve the key.  That is acceptable here because:
//   - AISstream free tier streams public maritime radio data
//   - The key has no cost and can be regenerated instantly
//   - The Supabase anon key is already public in the same HTML
// If you ever upgrade to a paid AISstream plan, add a Supabase JWT check below.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Short cache — key changes are rare but should propagate quickly
    'Cache-Control': 'public, max-age=300',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const key = process.env.AISSTREAM_KEY || '';
  if (!key) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'AISSTREAM_KEY not configured', key: '' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ key }),
  };
};
