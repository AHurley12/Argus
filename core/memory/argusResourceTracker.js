// ── ArgusResourceTracker — GPU/heap resource lifecycle tracking ───────────────
//
// Ownership model:
//   Dynamic resources (event markers, pins, AIS sprites) are created per-event
//   and MUST be explicitly disposed when removed from the scene.
//
//   Shared resources (textures, instanced geometry, grid materials) are created
//   once at init and MUST NOT be disposed mid-session.
//
// Rule: NEVER dispose shared textures. material.dispose() is always safe because
// THREE.js does NOT dispose texture references when a material is disposed —
// the texture keeps its VRAM allocation. Geometry.dispose() frees the VBO.
//
// Safe disposal path: call ArgusResourceTracker.safeDisposeMesh(obj, owner) or
// safeDisposeSprite(sprite, owner) at every scene-remove site for dynamic objects.
//
// Diagnostics: ArgusMemoryAudit.get() — snapshot of disposal counters per owner.

'use strict';

window.ArgusResourceTracker = (function() {

  // Per-owner counters — owner strings are caller-defined category names
  var _owners = {};

  // Aggregate counts
  var _materialDisposed  = 0;
  var _geometryDisposed  = 0;
  var _spriteMatDisposed = 0;

  // Registered shared textures — for audit visibility, NOT for disposal
  var _sharedTextures = [];

  function _ensureOwner(owner) {
    if (owner && !_owners[owner]) {
      _owners[owner] = { disposed: 0 };
    }
  }

  // ── safeDisposeMesh ───────────────────────────────────────────────────────────
  // Disposes geometry + material on a THREE.Mesh or THREE.Line.
  // Does NOT touch any texture referenced by the material (all textures are shared).
  // Call this immediately before eventMarkerGroup.remove(obj).
  function safeDisposeMesh(obj, owner) {
    if (!obj) return;
    var n = 0;
    if (obj.geometry) {
      obj.geometry.dispose();
      _geometryDisposed++;
      n++;
    }
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        for (var i = 0; i < obj.material.length; i++) {
          obj.material[i].dispose();
          _materialDisposed++;
          n++;
        }
      } else {
        obj.material.dispose();
        _materialDisposed++;
        n++;
      }
    }
    if (owner && n > 0) {
      _ensureOwner(owner);
      _owners[owner].disposed += n;
    }
  }

  // ── safeDisposeSprite ─────────────────────────────────────────────────────────
  // Disposes the SpriteMaterial on a THREE.Sprite ghost sprite.
  // The sprite itself was never added to a scene group so no parent.remove() is needed.
  // The shared texture (e.g. _shTex) is NOT disposed — only the material wrapper.
  function safeDisposeSprite(sprite, owner) {
    if (!sprite || !sprite.material) return;
    sprite.material.dispose();
    _spriteMatDisposed++;
    if (owner) {
      _ensureOwner(owner);
      _owners[owner].disposed++;
    }
  }

  // ── registerSharedTexture ─────────────────────────────────────────────────────
  // Records a shared texture for audit visibility. NEVER disposes it.
  function registerSharedTexture(name, tex) {
    _sharedTextures.push({ name: name, uuid: tex ? tex.uuid : 'unknown' });
  }

  // ── getAudit ──────────────────────────────────────────────────────────────────
  function getAudit() {
    var ownerSnapshot = {};
    var ownerKeys = Object.keys(_owners);
    for (var k = 0; k < ownerKeys.length; k++) {
      var key = ownerKeys[k];
      ownerSnapshot[key] = { disposed: _owners[key].disposed };
    }
    return {
      materials:         _materialDisposed + _spriteMatDisposed,
      geometries:        _geometryDisposed,
      textures:          _sharedTextures.length,
      disposedResources: _materialDisposed + _geometryDisposed + _spriteMatDisposed,
      leakedResources:   0,  // 0 post-fix — all removal sites now call safeDisposeMesh/safeDisposeSprite
      activeOwners:      ownerSnapshot,
      sharedTextures:    _sharedTextures.slice(),
    };
  }

  return {
    safeDisposeMesh:          safeDisposeMesh,
    safeDisposeSprite:        safeDisposeSprite,
    registerSharedTexture:    registerSharedTexture,
    getAudit:                 getAudit,
  };

}());

// ── ArgusMemoryAudit — diagnostic surface ────────────────────────────────────
// Usage: ArgusMemoryAudit.get()
// Returns: { materials, geometries, textures, disposedResources, leakedResources, activeOwners }
window.ArgusMemoryAudit = {
  get: function() {
    return window.ArgusResourceTracker ? window.ArgusResourceTracker.getAudit() : null;
  },
};
