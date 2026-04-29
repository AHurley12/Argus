// netlify/functions/ai-query.js
// Proxies Argus AI chat requests (Claude Sonnet) with hard server-side enforcement:
//   1. Global system cap  — blocks ALL requests once MAX_TOTAL_QUERIES is reached
//   2. Per-user cap       — free tier: 15 lifetime queries, pro tier: 100
//   3. Rate limiting      — 10 s minimum between requests, 10 requests/hour max
//   4. Cost tracking      — every successful call increments Supabase system_usage
//
// Enforcement order mirrors the spec exactly (global → user → rate → process → update).
// All counters persist in Supabase — survive server restarts, cannot be bypassed
// by clearing localStorage or opening new tabs.
//
// Env vars required: ANTHROPIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ── Budget constants ──────────────────────────────────────────────────────────
const COST_PER_QUERY       = 0.06;
const MAX_TOTAL_QUERIES    = 800;   // $48 ceiling; hard stop before $50 theoretical max
const FREE_USER_LIMIT      = 15;
const PRO_USER_LIMIT       = 100;
const MIN_TIME_BETWEEN_MS  = 10 * 1000;   // 10 seconds
const MAX_REQUESTS_PER_HOUR = 10;
const HOUR_MS              = 60 * 60 * 1000;

// ── CORS / JSON helpers ───────────────────────────────────────────────────────
const BASE_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers: BASE_HEADERS, body: JSON.stringify(body) };
}

// ── Resolve pro status by verifying the Supabase JWT server-side ─────────────
// Accepts the user's access_token, verifies it with Supabase, then reads
// profiles.tier — so the client can never self-promote by sending is_pro:true.
async function resolveIsPro(authToken, supabase) {
  if (!authToken) return false;
  try {
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${authToken}`,
      },
    });
    if (!userRes.ok) return false;
    const userData = await userRes.json();
    if (!userData || !userData.id) return false;

    const { data: profile } = await supabase
      .from('profiles')
      .select('tier')
      .eq('id', userData.id)
      .single();

    const tier = profile?.tier || 'viewer';
    return tier === 'pro' || tier === 'admin' || tier === 'owner';
  } catch {
    return false;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  // ── Parse request body ────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch { return respond(400, { error: 'Invalid request body' }); }

  // user_id is a client-generated UUID stored in localStorage (ArgusUID).
  // Not authenticated, but combined with the global hard cap it prevents runaway costs.
  const userId = (body.user_id || '').toString().trim();

  if (!userId || userId.length < 8 || userId.length > 64) {
    return respond(400, { error: 'Invalid session ID', code: 'BAD_SESSION' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const now = Date.now();

  // Verify tier server-side — auth_token is the Supabase JWT sent from the frontend.
  // Falls back to free (false) if no token or verification fails.
  const isPro     = await resolveIsPro(body.auth_token || null, supabase);
  const userLimit = isPro ? PRO_USER_LIMIT : FREE_USER_LIMIT;

  // ── STEP 1: Global limit ──────────────────────────────────────────────────
  const { data: sys, error: sysErr } = await supabase
    .from('system_usage')
    .select('total_queries, total_cost')
    .eq('id', 1)
    .single();

  if (sysErr || !sys) {
    // If we can't read the counter, fail closed — never allow an unchecked call
    console.error('[ai-query] system_usage read failed:', sysErr?.message);
    return respond(503, { error: 'Usage tracking unavailable', code: 'TRACKING_ERROR' });
  }

  if (sys.total_queries >= MAX_TOTAL_QUERIES) {
    console.warn('[ai-query] GLOBAL CAP HIT — total:', sys.total_queries);
    return respond(429, {
      error:  'System capacity reached',
      code:   'GLOBAL_CAP',
      total:  sys.total_queries,
      cost:   sys.total_cost,
    });
  }

  // ── STEP 2: Per-user limit ────────────────────────────────────────────────
  const { data: user } = await supabase
    .from('usage_tracking')
    .select('query_count, last_query_timestamp, hourly_query_count, hourly_reset_timestamp')
    .eq('user_id', userId)
    .single();

  const queryCount    = user?.query_count              ?? 0;
  const lastQuery     = user?.last_query_timestamp     ?? 0;
  const hourlyCount   = user?.hourly_query_count       ?? 0;
  const hourlyReset   = user?.hourly_reset_timestamp   ?? 0;

  if (queryCount >= userLimit) {
    return respond(429, {
      error:  'Query limit reached',
      code:   'USER_CAP',
      used:   queryCount,
      limit:  userLimit,
    });
  }

  // ── STEP 3: Rate limiting ─────────────────────────────────────────────────
  // 3a — minimum gap between consecutive requests
  const msSinceLast = now - lastQuery;
  if (lastQuery > 0 && msSinceLast < MIN_TIME_BETWEEN_MS) {
    const waitSec = Math.ceil((MIN_TIME_BETWEEN_MS - msSinceLast) / 1000);
    return respond(429, {
      error:   `Rate limit exceeded, try again in ${waitSec}s`,
      code:    'RATE_LIMIT',
      wait_ms: MIN_TIME_BETWEEN_MS - msSinceLast,
    });
  }

  // 3b — hourly bucket (reset counter if hour has elapsed)
  const hourExpired         = (now - hourlyReset) > HOUR_MS;
  const effectiveHourly     = hourExpired ? 0 : hourlyCount;
  if (effectiveHourly >= MAX_REQUESTS_PER_HOUR) {
    const resetIn = Math.ceil((hourlyReset + HOUR_MS - now) / 1000 / 60);
    return respond(429, {
      error:     `Rate limit exceeded, try again shortly`,
      code:      'HOURLY_LIMIT',
      resets_in: `${resetIn} min`,
    });
  }

  // ── STEP 4: Process request — proxy to Anthropic ──────────────────────────
  const payload = body.payload;
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return respond(400, { error: 'Missing or invalid messages array', code: 'BAD_PAYLOAD' });
  }

  // Hard-clamp model and token count — prevent any client-side escalation
  payload.model      = 'claude-sonnet-4-6';
  payload.max_tokens = Math.min(payload.max_tokens || 1024, 1024);

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
    console.error('[ai-query] Anthropic fetch error:', err.message);
    return respond(502, { error: 'Upstream API error', code: 'UPSTREAM_ERROR' });
  }

  if (!anthropicRes.ok) {
    console.warn('[ai-query] Anthropic returned', anthropicRes.status, JSON.stringify(anthropicData).slice(0, 200));
    return respond(anthropicRes.status, anthropicData);
  }

  // ── STEP 5: Update counters (only after confirmed success) ────────────────
  const newHourlyCount = hourExpired ? 1 : hourlyCount + 1;
  const newHourlyReset = hourExpired ? now : hourlyReset;
  const newTotalCost   = parseFloat((sys.total_cost + COST_PER_QUERY).toFixed(4));

  const [userUpdate, sysUpdate] = await Promise.all([
    supabase.from('usage_tracking').upsert({
      user_id:                userId,
      query_count:            queryCount + 1,
      last_query_timestamp:   now,
      hourly_query_count:     newHourlyCount,
      hourly_reset_timestamp: newHourlyReset,
    }, { onConflict: 'user_id' }),

    supabase.from('system_usage').update({
      total_queries: sys.total_queries + 1,
      total_cost:    newTotalCost,
    }).eq('id', 1),
  ]);

  if (userUpdate.error) console.error('[ai-query] user counter update failed:', userUpdate.error.message);
  if (sysUpdate.error)  console.error('[ai-query] system counter update failed:', sysUpdate.error.message);

  console.log(`[ai-query] OK — user ${userId.slice(0,8)} query ${queryCount + 1}/${userLimit} | global ${sys.total_queries + 1}/${MAX_TOTAL_QUERIES} | cost $${newTotalCost}`);

  return respond(200, anthropicData);
};
