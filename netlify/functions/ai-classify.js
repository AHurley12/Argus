// netlify/functions/ai-classify.js
// Proxies background news classification requests (Claude Haiku).
// Enforces a global daily batch cap stored in Supabase — persists across all users
// and server restarts. Each batch classifies up to 10 article titles.
//
// Daily cap rationale:
//   300 batches/day × ~$0.002/batch (Haiku, 10 articles, 70-char titles) = $0.60/day max
//   That's ~$18/month — well within the $50 total budget when combined with chat queries.
//
// This function does NOT enforce per-user limits — classification is background/automated
// and tied to news refresh cycles, not interactive user queries.
//
// Env vars required: ANTHROPIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

'use strict';

const { createClient } = require('@supabase/supabase-js');

const CLASSIFY_DAILY_CAP = 300;  // global batches per UTC calendar day

const BASE_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers: BASE_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body); }
  catch { return respond(400, { error: 'Invalid request body' }); }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC

  // ── STEP 1: Check global daily classification cap ─────────────────────────
  const { data: daily, error: dailyErr } = await supabase
    .from('classify_usage')
    .select('batch_count')
    .eq('date', today)
    .single();

  if (dailyErr && dailyErr.code !== 'PGRST116') {
    // PGRST116 = row not found (first request of the day) — that's fine
    console.error('[ai-classify] classify_usage read failed:', dailyErr.message);
    return respond(503, { error: 'Usage tracking unavailable', code: 'TRACKING_ERROR' });
  }

  const batchCount = daily?.batch_count ?? 0;

  if (batchCount >= CLASSIFY_DAILY_CAP) {
    console.warn('[ai-classify] daily cap hit:', batchCount);
    return respond(429, {
      error:     'System capacity reached',
      code:      'CLASSIFY_CAP',
      used:      batchCount,
      limit:     CLASSIFY_DAILY_CAP,
      resets_at: today + 'T00:00:00Z (next UTC day)',
    });
  }

  // ── STEP 2: Validate payload ──────────────────────────────────────────────
  const payload = body.payload;
  if (!payload || !payload.messages || !payload.system) {
    return respond(400, { error: 'Missing payload fields', code: 'BAD_PAYLOAD' });
  }

  // Hard-lock to Haiku — never let the client escalate to a more expensive model
  payload.model      = 'claude-haiku-4-5-20251001';
  payload.max_tokens = Math.min(payload.max_tokens || 400, 400);

  // ── STEP 3: Proxy to Anthropic ────────────────────────────────────────────
  let anthropicRes, anthropicData;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    anthropicData = await anthropicRes.json();
  } catch (err) {
    console.error('[ai-classify] Anthropic fetch error:', err.message);
    return respond(502, { error: 'Upstream API error', code: 'UPSTREAM_ERROR' });
  }

  if (!anthropicRes.ok) {
    return respond(anthropicRes.status, anthropicData);
  }

  // ── STEP 4: Increment daily counter (only on success) ─────────────────────
  const { error: upsertErr } = await supabase
    .from('classify_usage')
    .upsert({ date: today, batch_count: batchCount + 1 }, { onConflict: 'date' });

  if (upsertErr) console.error('[ai-classify] counter upsert failed:', upsertErr.message);

  console.log(`[ai-classify] OK — batch ${batchCount + 1}/${CLASSIFY_DAILY_CAP} today`);

  return respond(200, anthropicData);
};
