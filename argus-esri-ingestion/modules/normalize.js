/**
 * modules/normalize.js
 * ──────────────────────────────────────────────────────────
 * Data normalization for Argus Esri ingestion.
 *
 * Transforms raw ArcGIS feature arrays into strict, consistent
 * Argus-compatible schema objects.
 *
 * Design:
 *  - normalizeIMF()      → PORT_ACTIVITY schema (IMF PortWatch)
 *  - normalizeLayer()    → dispatcher for future layer types
 *
 * Rules:
 *  - Missing numeric values default to 0
 *  - No extra fields added (80/20 rule — only high-value fields)
 *  - Schema is strict and consistent across records
 * ──────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────────────────────────
// IMF PortWatch → PORT_ACTIVITY
// ──────────────────────────────────────────────────────────

/**
 * normalizeIMF(features)
 *
 * Converts raw ArcGIS features from the IMF PortWatch
 * FeatureServer into Argus PORT_ACTIVITY records.
 *
 * @param {Array} features - Raw feature objects from fetchArcGISLayer
 * @returns {Array<PortActivityRecord>}
 */
export function normalizeIMF(features) {
  if (!Array.isArray(features) || features.length === 0) {
    return [];
  }

  return features
    .map((feature, idx) => {
      const a = feature?.attributes;
      if (!a) {
        console.warn(`[normalize] Feature at index ${idx} has no attributes — skipped.`);
        return null;
      }

      return {
        id:           safeString(a.portid),
        type:         'PORT_ACTIVITY',
        port:         safeString(a.portname),
        country:      safeString(a.country),
        total_calls:  safeNum(a.portcalls),
        imports_total: safeNum(a.import),
        exports_total: safeNum(a.export),
        imports: {
          container: safeNum(a.import_container),
          tanker:    safeNum(a.import_tanker),
        },
        exports: {
          container: safeNum(a.export_container),
          tanker:    safeNum(a.export_tanker),
        },
        date:   safeDate(a.date),   // epoch ms — handles string "YYYY-MM-DD" or numeric
        source: 'IMF_PORTWATCH',
      };
    })
    .filter(Boolean);  // drop null entries (malformed features)
}

// ──────────────────────────────────────────────────────────
// Extensibility dispatcher
// ──────────────────────────────────────────────────────────

/**
 * normalizeLayer(type, features)
 *
 * Central dispatcher — routes raw features to the correct
 * normalizer based on the layer type string.
 *
 * Add new cases here as additional Esri layers are onboarded.
 *
 * @param {string} type     - Layer type identifier
 * @param {Array}  features - Raw ArcGIS feature objects
 * @returns {Array}
 */
export function normalizeLayer(type, features) {
  switch (type) {
    case 'PORT_ACTIVITY':
      return normalizeIMF(features);

    // Future layer types — implement normalizer functions and add cases:
    // case 'ECONOMIC_ACTIVITY':
    //   return normalizeEconomicActivity(features);
    // case 'INFRASTRUCTURE':
    //   return normalizeInfrastructure(features);
    // case 'RISK_ZONES':
    //   return normalizeRiskZones(features);

    default:
      throw new Error(`[normalize] Unknown layer type: "${type}". Add a case to normalizeLayer().`);
  }
}

// ──────────────────────────────────────────────────────────
// Safe value helpers (defensive, no throws)
// ──────────────────────────────────────────────────────────

/** Returns a number, defaulting to 0 for null/undefined/NaN */
function safeNum(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Returns a trimmed string, defaulting to empty string */
function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Returns epoch ms from a date value.
 * ArcGIS returns dates as "YYYY-MM-DD" strings or epoch ms numbers.
 * Defaults to 0 if unparseable.
 */
function safeDate(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : 0;
}
