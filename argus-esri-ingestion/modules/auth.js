/**
 * modules/auth.js
 * ──────────────────────────────────────────────────────────
 * ArcGIS authentication layer for Argus Esri ingestion.
 *
 * Supports:
 *  - Unauthenticated (public endpoints like IMF PortWatch)
 *  - Username/password sign-in via ArcGISIdentityManager
 *  - Optional API key generation from the logged-in session
 *
 * API keys are held in memory only — never written to disk.
 * ──────────────────────────────────────────────────────────
 */

import { ArcGISIdentityManager } from '@esri/arcgis-rest-request';
import { getSelf } from '@esri/arcgis-rest-portal';
import { createApiKey } from '@esri/arcgis-rest-developer-credentials';

const PORTAL_URL = process.env.ARCGIS_PORTAL_URL || 'https://www.arcgis.com';

/**
 * initializeArcGISAuth()
 *
 * Returns { authentication, apiKey }.
 *
 * If no credentials are set in env, both values are null and the
 * caller should proceed as an anonymous/public request. All IMF
 * PortWatch endpoints are public — auth is only needed for
 * restricted Esri layers added in future.
 *
 * @returns {Promise<{ authentication: ArcGISIdentityManager|null, apiKey: string|null }>}
 */
export async function initializeArcGISAuth() {
  const username = process.env.ARCGIS_USERNAME?.trim();
  const password = process.env.ARCGIS_PASSWORD?.trim();

  if (!username || !password) {
    console.log('[auth] No credentials set — proceeding as anonymous (public endpoints only).');
    return { authentication: null, apiKey: null };
  }

  let authentication;
  try {
    console.log(`[auth] Signing in as ${username} …`);
    authentication = await ArcGISIdentityManager.signIn({
      username,
      password,
      portal: `${PORTAL_URL}/sharing/rest`,
    });
  } catch (err) {
    throw new Error(`[auth] Sign-in failed: ${err.message}`);
  }

  // Verify the session is alive and log the portal user
  try {
    const self = await getSelf({ authentication });
    console.log(`[auth] Authenticated as: ${self.fullName || self.username} (${self.orgId || 'no org'})`);
  } catch (err) {
    // Non-fatal — session may still be valid
    console.warn('[auth] getSelf warning:', err.message);
  }

  // Generate an API key scoped to FeatureServer read access.
  // Held in memory only — never written to any file or log.
  let apiKey = null;
  try {
    const keyItem = await createApiKey({
      title: `argus-esri-ingestion-${Date.now()}`,
      description: 'Temporary read-only key for Argus ingestion layer',
      privileges: ['premium:user:featureReport'],
      authentication,
    });
    apiKey = keyItem.apiKey ?? null;
    if (apiKey) {
      console.log('[auth] API key generated (held in memory only).');
    }
  } catch (err) {
    // API key creation requires developer credentials plan.
    // Fall back to session-based auth — fully acceptable.
    console.warn('[auth] API key creation skipped (requires developer plan):', err.message);
  }

  return { authentication, apiKey };
}
