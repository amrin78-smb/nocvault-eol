'use client';

import { useCallback, useEffect, useState } from 'react';

type Source = {
  id: number; vendor: string; label: string; url: string; signalKind: string;
  signalCount: number | null; lastFetchAt: string | null; lastSuccessAt: string | null;
  lastChangedAt: string | null; lastStatus: number | null; lastError: string | null;
  consecutiveFailures: number; baselined: boolean;
};
type Change = {
  id: number; vendor: string; label: string; url: string; detectedAt: string;
  oldCount: number | null; newCount: number | null;
  added: string[]; removed: string[]; detailAvailable: boolean; notifiedAt: string | null;
};
type Status = {
  sources: Source[]; openChanges: Change[]; openCount: number; unreadableCount: number;
  alerting: { ok: boolean; reason: string };
};

const btn: React.CSSProperties = {
  padding: '0.55rem 1rem', borderRadius: 8, border: '1px solid #d0d5dd',
  background: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

export default function EolWatchActions() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/eol-watch');
      const d = await res.json();
      if (res.ok && d.ok) setStatus(d);
    } catch { /* the panel is best-effort; the buttons still work */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function check() {
    setBusy('check'); setMsg(null);
    try {
      // ⛔ THE BUDGET IS SENT. CLAUDE.md records this exact defect twice: a
      // caller that posts no body takes a default sized for a different
      // invocation and starves the fetch it was supposed to make.
      const res = await fetch('/api/admin/eol-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'check', budgetMs: 22000 }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      const mail = d.notify?.notify?.sent
        ? ' Email sent.'
        : d.notify?.notify?.skipped
          ? ` Email: ${d.notify.notify.skipped}.`
          : '';
      setMsg({
        kind: 'ok',
        text:
          `Checked ${d.checked} source(s): ${d.changed} changed, ${d.firstSeen} baselined, `
          + `${d.unchanged} unchanged, ${d.failed} failed. ${d.remaining} still due.${mail}`,
      });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  }

  async function acknowledge(id: number) {
    setBusy(`ack-${id}`);
    try {
      await fetch('/api/admin/eol-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'acknowledge', id }),
      });
      await load();
    } catch { /* reload will show the truth */ }
    finally { setBusy(null); }
  }

  const unreadable = status?.unreadableCount ?? 0;

  return (
    <div style={{
      marginTop: '1.5rem', padding: '1.25rem', border: '1px solid #e2e8f0',
      borderRadius: 12, background: '#fff',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Vendor EOL page watch</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        Watches each vendor&apos;s official lifecycle listing for change and raises a review
        item. <strong>It never writes a date</strong> — the curated seed stays the only source
        of EOL dates.
      </div>

      {status && (
        <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          <strong>{status.sources.length}</strong> sources ·{' '}
          <strong>{status.openCount}</strong> open review item(s)
          {unreadable > 0 && (
            <span style={{ color: '#b42318' }}> · <strong>{unreadable}</strong> unreadable</span>
          )}
          <div style={{ opacity: 0.65, marginTop: '0.2rem' }}>
            Alert delivery: {status.alerting.ok ? 'configured' : status.alerting.reason}
          </div>
        </div>
      )}

      {status && status.openChanges.length > 0 && (
        <div style={{
          marginBottom: '0.9rem', padding: '0.75rem', borderRadius: 8,
          border: '1px solid #fec84b', background: '#fffcf5',
        }}>
          <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
            Review items — a vendor page changed. Check it against data/eol-seed.json.
          </div>
          {status.openChanges.map((c) => (
            <div key={c.id} style={{
              padding: '0.5rem 0', borderTop: '1px solid #fde68a', fontSize: '0.85rem',
            }}>
              <div style={{ fontWeight: 600 }}>
                {c.vendor} — {c.label}{' '}
                <span style={{ fontWeight: 400, opacity: 0.6 }}>
                  ({ago(c.detectedAt)}; {c.oldCount} → {c.newCount} statements
                  {c.notifiedAt ? '' : '; not yet emailed'})
                </span>
              </div>
              <div>
                <a href={c.url} target="_blank" rel="noreferrer" style={{ color: '#0b5fff' }}>
                  {c.url}
                </a>
              </div>
              {!c.detailAvailable && (
                <div style={{ opacity: 0.7 }}>(no line-level detail: stored signal was truncated)</div>
              )}
              {c.added.slice(0, 8).map((l, i) => (
                <div key={`a${i}`} style={{ color: '#067647', fontFamily: 'monospace', fontSize: '0.78rem' }}>+ {l}</div>
              ))}
              {c.removed.slice(0, 8).map((l, i) => (
                <div key={`r${i}`} style={{ color: '#b42318', fontFamily: 'monospace', fontSize: '0.78rem' }}>- {l}</div>
              ))}
              <button
                style={{ ...btn, marginTop: '0.4rem', padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                disabled={busy === `ack-${c.id}`}
                onClick={() => acknowledge(c.id)}
              >
                {busy === `ack-${c.id}` ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            </div>
          ))}
        </div>
      )}

      {status && (
        <div style={{ fontSize: '0.8rem', marginBottom: '0.9rem' }}>
          {status.sources.map((s) => (
            <div key={s.id} style={{
              display: 'flex', gap: '0.5rem', padding: '0.25rem 0',
              borderBottom: '1px solid #f1f5f9',
            }}>
              <span style={{ minWidth: 230, fontWeight: 600 }}>{s.label}</span>
              <span style={{ minWidth: 95, opacity: 0.7 }}>
                {s.baselined ? `${s.signalCount} ${s.signalKind}` : 'no baseline'}
              </span>
              <span style={{ minWidth: 90, opacity: 0.7 }}>{ago(s.lastSuccessAt)}</span>
              <span style={{
                color: s.consecutiveFailures >= 3 ? '#b42318'
                  : s.consecutiveFailures > 0 ? '#b54708' : '#067647',
              }}>
                {s.consecutiveFailures > 0
                  ? `${s.consecutiveFailures} consecutive failure(s): ${(s.lastError || '').slice(0, 110)}`
                  : 'ok'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button style={btn} disabled={!!busy} onClick={check}>
          {busy === 'check' ? 'Checking…' : 'Check vendor EOL pages'}
        </button>
        <button style={btn} disabled={!!busy} onClick={load}>Refresh</button>
      </div>

      {msg && (
        <div style={{
          marginTop: '0.9rem', fontSize: '0.85rem',
          color: msg.kind === 'ok' ? '#067647' : '#b42318',
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
