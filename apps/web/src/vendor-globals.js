/**
 * vendor-globals.js
 * ──────────────────────────────────────────────────────────
 * Imports THREE and ThreeGlobe from npm and exposes them as
 * window globals, replacing the CDN <script src> pattern.
 *
 * Built as an IIFE bundle by vite.vendor.config.js:
 *   cd apps/web && npm run build:vendor
 *
 * Output: ../../vendor/vendor.js  →  served at /vendor/vendor.js
 *
 * The IIFE format means the bundle is a plain synchronous script —
 * window.THREE and window.ThreeGlobe are set before any other code runs,
 * maintaining the same load order guarantee as the CDN scripts.
 * ──────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import ThreeGlobe from 'three-globe';

window.THREE      = THREE;
window.ThreeGlobe = ThreeGlobe;
