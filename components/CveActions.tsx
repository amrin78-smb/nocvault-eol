'use client';

import { useCallback, useEffect, useState } from 'react';

// ⛔ ONE CLICK, MANY CALLS — and that is not a workaround, it is the shape the
// constraint forces. NVD allows one request per six seconds without an API key,
// and the six supported vendors span 32 verified CPE strings: ~192 seconds of
// waiting at minimum, against a 10s function budget. So the server does ONE
// bounded step per call and this loops until it reports nothing left.
//
// ⛔ The loop is capped and stops on repeated failure. A sweep that retried for
// ever would look like progress while hammering a refusing API.

const btn: React.CSSProperties = {
  padding: '0.55rem 0.95rem',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  background: '#fff',
  fontSize: '0.9rem',
  cursor: 'pointer',
};

type Status = {
  targets: number;
  neverRun: number;
  staleOver24h: number;
  failing: number;
  advisories: number;
  byVendor: Array<{ vendor: string; advisories: number }>;
  rateLimitMs: number;
  hasApiKey: boolean;
};

const MAX_STEPS = 200;          // hard stop: ~32 targets × a few pages each
const MAX_CONSECUTIVE_FAILS = 5; // stop sweeping if NVD is simply refusing

export default function CveActions() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/ingest-cve');
      const d = await r.json();
      if (r.ok) setStatus(d);
    } catch {
      // A failed status read is not worth an alarm — the buttons still work.
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function sweep() {
    setBusy(true);
    setMsg(null);
    let steps = 0;
    let fails = 0;
    let inserted = 0;
    let updated = 0;
    try {
      for (; steps < MAX_STEPS; steps++) {
        const r = await fetch('/api/admin/ingest-cve', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);

        inserted += d.inserted || 0;
        updated += d.updated || 0;

        if (d.ok === false) {
          fails++;
          setProgress(`${d.vendor ?? '?'} / ${d.cpeString ?? '?'} failed (${d.error ?? 'unknown'}) — continuing`);
          // ⛔ Keep going: the server has already deprioritised that target, and
          // one unreachable CPE string must not stop the sweep.
          if (fails >= MAX_CONSECUTIVE_FAILS) {
            throw new Error(`${fails} consecutive failures — stopping. Last: ${d.error ?? 'unknown'}`);
          }
        } else {
          fails = 0;
          setProgress(
            `${d.vendor} / ${String(d.cpeString).split(':').slice(3, 5).join(':')} — `
            + `${d.fetched} records, ${d.targetsRemaining} target(s) left`
          );
        }

        if (d.targetsRemaining === 0 && !d.moreForThisTarget) break;
      }
      setMsg({ kind: 'ok', text: `Sweep finished after ${steps + 1} step(s): ${inserted} new, ${updated} updated.` });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Sweep failed.' });
    } finally {
      setProgress('');
      setBusy(false);
      refresh();
    }
  }

  async function oneStep() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/ingest-cve', { method: 'POST' });
      const d = await r.json();
      setMsg(
        d.ok === false
          ? { kind: 'err', text: `${d.vendor ?? '?'}: ${d.error ?? 'failed'}` }
          : { kind: 'ok', text: `${d.vendor} — ${d.fetched} records, ${d.inserted} new, ${d.updated} updated, ${d.targetsRemaining} target(s) left.` }
      );
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Step failed.' });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <div
      style={{
        marginTop: '1.5rem',
        padding: '1.25rem',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        background: '#fff',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Vulnerability feed (CVE)</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        Pulls NVD for every supported firewall vendor into the central CVE corpus. Separate from the
        EOL feed — nothing here touches the model catalogue.
      </div>

      {status && (
        <div style={{ fontSize: '0.85rem', marginBottom: '0.9rem', lineHeight: 1.7 }}>
          <div>
            <strong>{status.advisories.toLocaleString()}</strong> advisories ·{' '}
            {status.targets} targets · {status.neverRun} never run · {status.staleOver24h} stale
            {status.failing > 0 && <> · <span style={{ color: '#b42318' }}>{status.failing} failing</span></>}
          </div>
          {status.byVendor.length > 0 && (
            <div style={{ opacity: 0.75 }}>
              {status.byVendor.map((v) => `${v.vendor} ${v.advisories}`).join(' · ')}
            </div>
          )}
          {/* ⛔ The API key is the single biggest reason to centralise: it takes
              NVD from one request per six seconds to five per thirty. Without it
              a full sweep is ~192s of pure waiting. Say so where it is actioned. */}
          {!status.hasApiKey && (
            <div style={{ color: '#b54708' }}>
              No NVD_API_KEY set — rate limited to one request per {Math.round(status.rateLimitMs / 1000)}s.
              A key makes a full sweep roughly nine times faster.
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          style={{ ...btn, background: '#0b5fff', color: '#fff', borderColor: '#0b5fff' }}
          disabled={busy}
          onClick={sweep}
        >
          {busy ? 'Ingesting…' : 'Ingest CVEs (full sweep)'}
        </button>
        <button style={btn} disabled={busy} onClick={oneStep}>
          One step
        </button>
        <button style={btn} disabled={busy} onClick={refresh}>
          Refresh
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: '0.9rem', fontSize: '0.85rem', opacity: 0.8 }}>{progress}</div>
      )}
      {msg && (
        <div
          style={{
            marginTop: '0.9rem',
            fontSize: '0.85rem',
            color: msg.kind === 'ok' ? '#067647' : '#b42318',
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
