// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts"

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: `Hello ${name}!`,
  }

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  )
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/ingest-tracking' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/

// ── AISstream Addition ──────────────────────────────────────────────────────────
//
// ENVIRONMENT SETUP (run once before deploying):
//   1. Get free API key at https://aisstream.io
//      → sign in → Account → API Keys → Generate
//   2. supabase secrets set AISSTREAM_API_KEY=your_key_here
//   3. supabase functions deploy ingest-tracking
//   4. Run supabase/migrations/add_ais_tracking.sql in the Supabase SQL editor
//      (Database → SQL Editor → paste file → Run)
//
// HOW IT WORKS:
//   This block runs concurrently with the HTTP handler above (both are top-level
//   async operations in the same Deno isolate).  It opens a persistent WebSocket
//   to AISstream, buffers PositionReport messages in memory, and flushes them to
//   public.tracking_data via the Supabase REST API in batches of BATCH_SIZE or
//   every FLUSH_MS — whichever comes first.  On disconnect it waits 5 s and
//   reconnects automatically.
//
// DEPENDENCIES: Deno std lib only — no npm packages added.
// ──────────────────────────────────────────────────────────────────────────────

const _AIS_SUPABASE_URL     = Deno.env.get('SUPABASE_URL')              ?? '';
const _AIS_SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const _AIS_API_KEY          = Deno.env.get('AISSTREAM_API_KEY')         ?? '';

const _AIS_BATCH_SIZE = 50;
const _AIS_FLUSH_MS   = 5_000; // flush every 5 s if batch hasn't hit 50 yet

interface _AISRecord {
  mmsi:       string;
  ship_name:  string | null;
  lat:        number;
  lon:        number;
  heading:    number | null;
  velocity:   number | null;
  nav_status: string | null;
  timestamp:  number;
  source:     'aisstream';
  raw:        unknown;
}

// Upsert a batch of AIS records into public.tracking_data.
// Uses Supabase REST API (no SDK) — zero additional dependencies.
// ON CONFLICT (mmsi) → update position + meta columns, leave created_at alone.
async function _aisFlushBatch(batch: _AISRecord[]): Promise<void> {
  if (!batch.length) return;
  try {
    const res = await fetch(`${_AIS_SUPABASE_URL}/rest/v1/tracking_data`, {
      method: 'POST',
      headers: {
        'apikey':        _AIS_SUPABASE_SERVICE,
        'Authorization': `Bearer ${_AIS_SUPABASE_SERVICE}`,
        'Content-Type':  'application/json',
        // merge-duplicates → ON CONFLICT (mmsi) DO UPDATE
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('[AISstream] upsert HTTP', res.status, '—', text.slice(0, 300));
    } else {
      console.log(`[AISstream] upserted ${batch.length} records`);
    }
  } catch (err) {
    console.warn('[AISstream] upsert fetch error:', (err as Error).message);
  }
}

// Open one WebSocket session to AISstream.
// Resolves when the socket closes (caller reconnects after a delay).
async function _aisConnect(): Promise<void> {
  if (!_AIS_API_KEY) {
    console.warn('[AISstream] AISSTREAM_API_KEY is not set — connection skipped');
    return;
  }
  if (!_AIS_SUPABASE_URL || !_AIS_SUPABASE_SERVICE) {
    console.warn('[AISstream] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — connection skipped');
    return;
  }

  console.log('[AISstream] opening WebSocket…');
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  const batch: _AISRecord[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Schedule a time-based flush if one isn't already pending.
  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!batch.length) return;
      const toFlush = batch.splice(0, batch.length);
      await _aisFlushBatch(toFlush);
    }, _AIS_FLUSH_MS);
  }

  // Flush immediately if batch is full; otherwise schedule.
  async function maybeFlush() {
    if (batch.length >= _AIS_BATCH_SIZE) {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      const toFlush = batch.splice(0, batch.length);
      await _aisFlushBatch(toFlush);
    } else {
      scheduleFlush();
    }
  }

  return new Promise<void>((resolve) => {
    ws.onopen = () => {
      console.log('[AISstream] connected — subscribing to PositionReport (global bbox)');
      ws.send(JSON.stringify({
        APIKey:             _AIS_API_KEY,
        BoundingBoxes:      [[[-90, -180], [90, 180]]],  // global coverage
        FilterMessageTypes: ['PositionReport'],
      }));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const msg    = JSON.parse(event.data as string);
        const meta   = msg?.MetaData   ?? {};
        const report = msg?.Message?.PositionReport ?? {};

        const lat = meta.latitude;
        const lon = meta.longitude;
        // Skip null islands and missing positions
        if (lat == null || lon == null) return;
        if (lat === 0   && lon === 0)   return;

        // TrueHeading 511 = "not available" per ITU-R M.1371 — fall back to COG
        const trueHeading = report.TrueHeading;
        const cog         = report.Cog ?? null;
        const heading: number | null =
          (trueHeading != null && trueHeading !== 511)
            ? parseFloat(Number(trueHeading).toFixed(1))
            : (cog != null ? parseFloat(Number(cog).toFixed(1)) : null);

        const navRaw = report.NavigationalStatus;

        const record: _AISRecord = {
          mmsi:       String(meta.MMSI ?? '').trim(),
          ship_name:  (meta.ShipName ?? '').trim() || null,
          lat:        parseFloat(Number(lat).toFixed(5)),
          lon:        parseFloat(Number(lon).toFixed(5)),
          heading,
          velocity:   report.Sog != null
                        ? parseFloat(Number(report.Sog).toFixed(2))
                        : null,
          nav_status: navRaw != null ? String(navRaw) : null,
          timestamp:  Date.now(),
          source:     'aisstream',
          raw:        msg,  // kept for debugging; remove after confirming stable
        };

        // Skip records with no MMSI (can't deduplicate)
        if (!record.mmsi) return;

        batch.push(record);
        await maybeFlush();
      } catch (err) {
        console.warn('[AISstream] message parse error:', (err as Error).message);
      }
    };

    ws.onerror = (ev: Event) => {
      // Log but don't crash — onclose fires next and triggers reconnect
      console.warn('[AISstream] WebSocket error event:', (ev as ErrorEvent).message ?? 'unknown');
      ws.close();
    };

    ws.onclose = (ev: CloseEvent) => {
      console.warn(`[AISstream] disconnected (code ${ev.code}, reason: "${ev.reason}") — reconnecting in 5 s`);
      // Flush whatever is buffered before giving up this connection
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      if (batch.length) {
        const toFlush = batch.splice(0, batch.length);
        _aisFlushBatch(toFlush).finally(() => resolve());
      } else {
        resolve();
      }
    };
  });
}

// Outer reconnect loop — keeps the ingestor alive for the lifetime of the
// function instance.  Only starts when AISSTREAM_API_KEY is present so the
// function boots cleanly in environments without the secret configured.
if (_AIS_API_KEY) {
  (async function _aisReconnectLoop() {
    while (true) {
      await _aisConnect();
      // 5 s back-off before reconnect (matches spec)
      await new Promise<void>(r => setTimeout(r, 5_000));
    }
  })();
}
