// AdsbPanel.jsx
// Diagnostic overlay — shows proxy fetch result after a 15s startup delay.
// Delay prevents the diagnostic from colliding with the globe's first poll at t=8s.

import { useEffect, useState } from 'react';
import { runAdsbDiagnostic } from './adsbDiagnostic';

const STARTUP_DELAY_MS = 15000;

const PANEL_STYLE = {
  position:      'fixed',
  top:           '12px',
  left:          '12px',
  zIndex:        9999,
  background:    'rgba(0, 0, 0, 0.82)',
  color:         '#00ff88',
  fontFamily:    'monospace',
  fontSize:      '12px',
  lineHeight:    '1.6',
  padding:       '12px 16px',
  borderRadius:  '4px',
  border:        '1px solid #00ff8855',
  maxWidth:      '380px',
  whiteSpace:    'pre-wrap',
  wordBreak:     'break-all',
  pointerEvents: 'none',
};

const LABEL_STYLE  = { color: '#ffffff', fontWeight: 'bold' };
const ERROR_STYLE  = { color: '#ff4444' };
const MUTED_STYLE  = { color: '#888888' };

function Row({ label, value, isError, isMuted }) {
  return (
    <div>
      <span style={LABEL_STYLE}>{label}: </span>
      <span style={isError ? ERROR_STYLE : isMuted ? MUTED_STYLE : {}}>{value}</span>
    </div>
  );
}

export default function AdsbPanel() {
  const [result,  setResult]  = useState(null);
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    const startTimer = setTimeout(function() {
      setWaiting(false);
      setRunning(true);
      runAdsbDiagnostic()
        .then(function(r) {
          setResult(r);
          setRunning(false);
        })
        .catch(function(err) {
          console.error('[AdsbPanel] unexpected throw:', err);
          setResult({
            final: { ok: false, error: String(err), errorType: 'UNEXPECTED', status: null, durationMs: null }
          });
          setRunning(false);
        });
    }, STARTUP_DELAY_MS);

    return function() { clearTimeout(startTimer); };
  }, []);

  const f = result && result.final;

  return (
    <div style={PANEL_STYLE}>
      <div style={{ ...LABEL_STYLE, fontSize: '13px', marginBottom: '6px' }}>
        ADS-B PROXY DIAGNOSTIC
      </div>

      {waiting && (
        <div style={MUTED_STYLE}>waiting 15s (globe poll runs first)…</div>
      )}

      {running && <div>fetching via proxy…</div>}

      {!waiting && !running && f && (
        <>
          <Row
            label="status"
            value={f.ok ? 'OK' : 'FAIL (' + (f.errorType || 'unknown') + ')'}
            isError={!f.ok}
          />
          <Row label="source"    value="proxy (/adsb)" />
          <Row label="http"      value={f.status != null ? String(f.status) : 'n/a'} />
          <Row label="duration"  value={f.durationMs != null ? f.durationMs + ' ms' : 'n/a'} />
          <Row label="count"     value={f.count != null ? String(f.count) : 'n/a'} />
          <Row label="firstIcao" value={f.firstIcao || 'n/a'} />
          <Row label="ts"        value={f.ts ? new Date(f.ts).toISOString() : 'n/a'} isMuted />
          {f.error && (
            <Row label="error" value={f.error} isError />
          )}
        </>
      )}
    </div>
  );
}
