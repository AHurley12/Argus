/**
 * modules/fetch.js
 * ──────────────────────────────────────────────────────────
 * Generic ArcGIS FeatureServer fetch utility.
 *
 * Handles:
 *  - Safe query-string construction
 *  - where clause + outFields filtering (80/20 rule)
 *  - ArcGIS "exceededTransferLimit" pagination
 *  - Network errors, timeouts, empty responses
 *  - Optional ArcGISIdentityManager token injection
 * ──────────────────────────────────────────────────────────
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_PAGE_SIZE  = 2_000;   // ArcGIS default max per page

/**
 * fetchArcGISLayer(url, params, options)
 *
 * @param {string}  url     - Full FeatureServer query endpoint
 * @param {object}  params  - ArcGIS query parameters
 *   @param {string}  params.where              - SQL where clause (required — never use 1=1)
 *   @param {string}  params.outFields          - Comma-separated field list
 *   @param {number}  [params.resultRecordCount] - Page size (default: 2000)
 *   @param {number}  [params.resultOffset]      - Pagination offset (managed internally)
 * @param {object}  options
 *   @param {object}  [options.authentication]  - ArcGISIdentityManager instance (optional)
 *   @param {number}  [options.timeoutMs]       - Per-request timeout (default: 12s)
 *   @param {boolean} [options.paginate]        - Follow exceededTransferLimit (default: true)
 *   @param {number}  [options.maxFeatures]     - Hard cap on total records (default: 2000)
 *
 * @returns {Promise<Array>} Raw ArcGIS feature objects
 */
export async function fetchArcGISLayer(url, params = {}, options = {}) {
  const {
    authentication = null,
    timeoutMs       = DEFAULT_TIMEOUT_MS,
    paginate        = true,
    maxFeatures     = 2_000,
  } = options;

  if (!params.where) {
    throw new Error('[fetch] params.where is required. Never use unbounded queries.');
  }
  if (!params.outFields) {
    throw new Error('[fetch] params.outFields is required. Specify explicit fields (80/20 rule).');
  }

  const pageSize = params.resultRecordCount ?? DEFAULT_PAGE_SIZE;
  let allFeatures = [];
  let offset      = 0;

  // Pagination loop — follows exceededTransferLimit automatically
  while (true) {
    const queryParams = {
      where:             params.where,
      outFields:         params.outFields,
      resultRecordCount: pageSize,
      resultOffset:      offset,
      f:                 'json',
      ...params,           // allow caller overrides
      // Re-enforce required fields (cannot be overridden via params)
      resultOffset: offset,
    };

    // Inject token if authenticated session is provided
    if (authentication) {
      try {
        queryParams.token = await authentication.getToken(url);
      } catch (err) {
        console.warn('[fetch] Token fetch warning — proceeding without token:', err.message);
      }
    }

    const fullUrl = buildQueryUrl(url, queryParams);
    const page    = await _fetchPage(fullUrl, timeoutMs);

    if (!page || !Array.isArray(page.features)) {
      console.warn('[fetch] Unexpected response shape — treating as empty.');
      break;
    }

    allFeatures = allFeatures.concat(page.features);

    const pageCount = page.features.length;

    // Stop conditions: no more pages, limit reached, or empty page
    if (allFeatures.length >= maxFeatures) {
      console.log(`[fetch] maxFeatures cap (${maxFeatures}) reached — stopping pagination.`);
      allFeatures = allFeatures.slice(0, maxFeatures);
      break;
    }
    if (!paginate || !page.exceededTransferLimit || pageCount === 0) {
      break;
    }

    offset += pageCount;
    console.log(`[fetch] exceededTransferLimit — fetching next page (offset=${offset}) …`);
  }

  return allFeatures;
}

// ──────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────

/**
 * Safely builds a query URL by appending encoded params.
 * Strips any pre-existing query string from the base URL
 * to avoid double-param issues.
 */
function buildQueryUrl(baseUrl, params) {
  // Strip trailing ? from base if present
  const base  = baseUrl.split('?')[0];
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return `${base}?${parts.join('&')}`;
}

/**
 * Single-page fetch with timeout and structured error handling.
 */
async function _fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`ArcGIS HTTP ${res.status} — ${res.statusText}`);
    }

    const payload = await res.json();

    // ArcGIS surfaces errors inside the JSON body
    if (payload?.error) {
      const msg = payload.error.message || JSON.stringify(payload.error);
      throw new Error(`ArcGIS service error: ${msg}`);
    }

    return payload;

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`[fetch] Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
