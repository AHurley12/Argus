/**
 * argus-esri-ingestion / index.js
 * ──────────────────────────────────────────────────────────
 * Main orchestrator for the Argus ArcGIS ingestion layer.
 *
 * What this does:
 *  1. Initialises ArcGIS auth (anonymous for public layers)
 *  2. Fetches IMF PortWatch data via the generic fetch module
 *  3. Normalizes raw features into PORT_ACTIVITY records
 *  4. Outputs result as:
 *       • JSON file  → /data/ports.json   (OUTPUT_MODE=file)
 *       • HTTP GET   → localhost:PORT/     (OUTPUT_MODE=http)
 *  5. Polls on POLL_INTERVAL_MS (default 10 min); respects --once flag
 *
 * ISOLATION GUARANTEE:
 *  - Zero imports from Argus frontend, AIS, or neural web modules
 *  - No writes outside /argus-esri-ingestion/data/
 *  - No modifications to existing Netlify functions
 * ──────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import http   from 'http';
import fs     from 'fs/promises';
import path   from 'path';
import { fileURLToPath } from 'url';

import { initializeArcGISAuth } from './modules/auth.js';
import { fetchArcGISLayer }     from './modules/fetch.js';
import { normalizeLayer }       from './modules/normalize.js';

// ── Constants ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORTWATCH_URL =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services' +
  '/Daily_Ports_Data/FeatureServer/0/query';

// 80/20 — only high-value fields, matches existing Netlify function contract
const PORTWATCH_FIELDS = [
  'portid', 'portname', 'country',
  'portcalls',
  'import', 'export',
  'import_container', 'export_container',
  'import_tanker',    'export_tanker',
  'date',
].join(',');

const OUTPUT_MODE      = process.env.OUTPUT_MODE       || 'file';
const PORT             = parseInt(process.env.PORT     || '3747', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '600000', 10);
const RUN_ONCE         = process.argv.includes('--once') || POLL_INTERVAL_MS === 0;

// Safety guard: never poll faster than 5 minutes
const SAFE_INTERVAL_MS = Math.max(POLL_INTERVAL_MS, 300_000);

const DATA_FILE = path.join(__dirname, 'data', 'ports.json');

// ── In-memory cache ──────────────────────────────────────

let _cache = null;   // { ports, meta } — last successful result

// ── Layer registry ───────────────────────────────────────
// Add new Esri layers here. Each entry is self-contained.
// fetchArcGISLayer + normalizeLayer handle the rest automatically.
const LAYER_REGISTRY = [
  {
    id:        'imf-portwatch',
    type:      'PORT_ACTIVITY',
    url:       PORTWATCH_URL,
    outFields: PORTWATCH_FIELDS,
    buildWhere,   // function — allows dynamic date filtering
  },
  // Future layers:
  // {
  //   id:        'esri-infrastructure',
  //   type:      'INFRASTRUCTURE',
  //   url:       '...',
  //   outFields: '...',
  //   buildWhere: () => '1=1',   // or a real filter
  // },
];

// ── Entry point ──────────────────────────────────────────

async function main() {
  console.log('[argus-esri-ingestion] Starting …');
  console.log(`  output:   ${OUTPUT_MODE}`);
  console.log(`  interval: ${RUN_ONCE ? 'once' : `${SAFE_INTERVAL_MS / 1000}s`}`);

  // Auth initialises once — session/key reused across polls
  const { authentication } = await initializeArcGISAuth();

  if (OUTPUT_MODE === 'http') {
    startHttpServer();
  }

  // Run immediately, then poll
  await runIngestion(authentication);

  if (!RUN_ONCE) {
    setInterval(() => runIngestion(authentication), SAFE_INTERVAL_MS);
  }
}

// ── Core ingestion cycle ─────────────────────────────────

async function runIngestion(authentication) {
  console.log(`\n[ingest] Cycle start — ${new Date().toISOString()}`);

  const allPorts = [];

  for (const layer of LAYER_REGISTRY) {
    try {
      const where = layer.buildWhere();
      console.log(`[ingest] Fetching layer "${layer.id}" — where: ${where}`);

      const features = await fetchArcGISLayer(
        layer.url,
        { where, outFields: layer.outFields },
        { authentication },
      );

      // If current period is empty, retry with previous month (PortWatch lag ~1 month)
      let resolvedFeatures = features;
      let period = currentPeriodLabel();

      if (resolvedFeatures.length === 0 && layer.id === 'imf-portwatch') {
        console.log(`[ingest] Current month empty — falling back to previous month …`);
        const prevWhere = buildWhere(-1);
        resolvedFeatures = await fetchArcGISLayer(
          layer.url,
          { where: prevWhere, outFields: layer.outFields },
          { authentication },
        );
        period = prevPeriodLabel();
      }

      const normalized = normalizeLayer(layer.type, resolvedFeatures);
      allPorts.push(...normalized);

      console.log(`[ingest] "${layer.id}" → ${normalized.length} records (period: ${period})`);

    } catch (err) {
      // Per-layer errors are non-fatal — log and continue with other layers
      console.error(`[ingest] Layer "${layer.id}" failed:`, err.message);
    }
  }

  const result = {
    ports: allPorts,
    meta: {
      timestamp:   new Date().toISOString(),
      recordCount: allPorts.length,
    },
  };

  // Only update cache + output if we got data
  if (allPorts.length > 0) {
    _cache = result;
    await writeOutput(result);
    console.log(`[ingest] Cycle complete — ${allPorts.length} total records.`);
  } else {
    console.warn('[ingest] Cycle produced 0 records — cache retained from previous run.');
  }

  return result;
}

// ── Output: file ─────────────────────────────────────────

async function writeOutput(result) {
  if (OUTPUT_MODE !== 'file' && OUTPUT_MODE !== 'both') return;

  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[output] Written to ${DATA_FILE}`);
  } catch (err) {
    console.error('[output] File write failed:', err.message);
  }
}

// ── Output: HTTP server ───────────────────────────────────

function startHttpServer() {
  const server = http.createServer((req, res) => {
    // CORS — allow local frontend consumption during development
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type',                 'application/json');
    res.setHeader('Cache-Control',                'public, max-age=300');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url !== '/' && req.url !== '/ports') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found. Use GET /' }));
      return;
    }

    if (!_cache) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Ingestion not yet complete — try again shortly.' }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify(_cache));
  });

  server.listen(PORT, () => {
    console.log(`[http] Server running at http://localhost:${PORT}/`);
  });
}

// ── Date helpers ─────────────────────────────────────────

/**
 * Builds a PortWatch-compatible where clause.
 * @param {number} monthOffset - 0 for current, -1 for previous
 */
function buildWhere(monthOffset = 0) {
  const d     = new Date();
  let year    = d.getUTCFullYear();
  let month   = d.getUTCMonth() + 1 + monthOffset;

  if (month < 1) { month = 12; year -= 1; }
  if (month > 12) { month = 1;  year += 1; }

  return `year=${year} AND month=${month}`;
}

function currentPeriodLabel() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function prevPeriodLabel() {
  const d = new Date();
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();  // 0-indexed → previous month
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ── Run ──────────────────────────────────────────────────

main().catch(err => {
  console.error('[argus-esri-ingestion] Fatal error:', err.message);
  process.exit(1);
});
