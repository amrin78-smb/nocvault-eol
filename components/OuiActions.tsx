'use client';

import { useCallback, useEffect, useState } from 'react';

type Reg = { registry: string; n: number };
type Refresh = { registry: string; lastSuccessAt: string | null; lastRows: number | null; lastError: string | null; consecutiveFailures: number };
type Status = {
  total: number; byRegistry: Reg[]; registryBlocks: number; refresh: Refresh[];
  latest: { feed_version: string; generated_at: string; row_count: number } | null;
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
  return `${(h / 24).toFixed(0)}d ago`;
}

export default function OuiActions() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/oui');
      const d = await res.json();
      if (res.ok && d.ok) setStatus(d);
    } catch { /* best effort */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(mode: 'refresh' | 'publish' | 'both', label: string) {
    setBusy(label); setMsg(null);
    try {
      const res = await fetch('/api/admin/oui', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        // ⛔ A REFUSED REFRESH IS SHOWN AS A REFUSAL WITH ITS REASONS, not as a
        // generic failure — the operator needs to know the catalogue is intact.
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const parts: string[] = [];
      if (d.refresh) parts.push(`Refreshed ${d.refresh.total} assignments`
        + (d.refresh.skippedRows ? ` (${d.refresh.skippedRows} skipped)` : ''));
      if (d.publish) parts.push(d.publish.unchanged
        ? `Feed unchanged (${d.publish.feed_version})`
        : d.publish.published
          ? `Published ${d.publish.feed_version}: ${d.publish.row_count} rows, ${Math.round(d.publish.bytes / 1024)} KB`
          : `NOT published: ${d.publish.publish_note}`);
      setMsg({ kind: 'ok', text: parts.join('. ') + '.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  }

  const stale = status?.refresh.some((r) => r.consecutiveFailures > 0);

  return (
    <div style={{
      marginTop: '1.5rem', padding: '1.25rem', border: '1px solid #e2e8f0',
      borderRadius: 12, background: '#fff',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>MAC vendor catalogue (OUI)</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        The IEEE MAC address block registries, signed and served at <code>/api/v1/oui-feed</code>.
        Match <strong>longest prefix first</strong> — 442 of the 24-bit blocks belong to IEEE
        itself and are subdivided, so a 24-bit-only lookup names the registry instead of the vendor.
      </div>

      {status && (
        <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          <strong>{status.total.toLocaleString()}</strong> assignments ·{' '}
          {status.byRegistry.map((r) => `${r.registry} ${r.n.toLocaleString()}`).join(' · ')}
          {status.registryBlocks > 0 && <> · {status.registryBlocks} IEEE-held blocks</>}
          <div style={{ opacity: 0.7, marginTop: '0.2rem' }}>
            {status.latest
              ? <>feed <strong>{status.latest.feed_version}</strong> ({status.latest.row_count.toLocaleString()} rows, {ago(status.latest.generated_at)})</>
              : <span style={{ color: '#b54708' }}>no feed published yet</span>}
          </div>
        </div>
      )}

      {status && status.refresh.length > 0 && (
        <div style={{ fontSize: '0.8rem', marginBottom: '0.9rem' }}>
          {status.refresh.map((r) => (
            <div key={r.registry} style={{
              display: 'flex', gap: '0.75rem', padding: '0.25rem 0', borderBottom: '1px solid #f1f5f9',
            }}>
              <span style={{ minWidth: 60, fontWeight: 600 }}>{r.registry}</span>
              <span style={{ minWidth: 90, opacity: 0.7 }}>{r.lastRows?.toLocaleString() ?? '—'} rows</span>
              <span style={{ minWidth: 90, opacity: 0.7 }}>{ago(r.lastSuccessAt)}</span>
              <span style={{ color: r.consecutiveFailures > 0 ? '#b42318' : '#067647' }}>
                {r.consecutiveFailures > 0
                  ? `${r.consecutiveFailures} failure(s): ${(r.lastError || '').slice(0, 90)}`
                  : 'ok'}
              </span>
            </div>
          ))}
        </div>
      )}

      {stale && (
        <div style={{
          fontSize: '0.82rem', marginBottom: '0.75rem', padding: '0.5rem',
          borderRadius: 6, background: '#fffcf5', border: '1px solid #fec84b',
        }}>
          A registry read failed. The existing catalogue was <strong>kept</strong> — a refresh is
          admitted or refused as a whole, never partially applied.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button style={btn} disabled={!!busy} onClick={() => run('refresh', 'refresh')}>
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh from IEEE'}
        </button>
        <button
          style={{ ...btn, background: '#0b5fff', color: '#fff', borderColor: '#0b5fff' }}
          disabled={!!busy} onClick={() => run('both', 'publish')}
        >
          {busy === 'publish' ? 'Publishing…' : 'Refresh & Publish OUI feed'}
        </button>
        <button style={btn} disabled={!!busy} onClick={load}>Refresh view</button>
      </div>

      {msg && (
        <div style={{ marginTop: '0.9rem', fontSize: '0.85rem', color: msg.kind === 'ok' ? '#067647' : '#b42318' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
