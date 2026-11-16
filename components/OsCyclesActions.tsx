'use client';

import { useCallback, useEffect, useState } from 'react';

type Product = { vendor: string; product: string; n: number; supported: number; eol: number };
type Status = {
  total: number;
  byProduct: Product[];
  latest: { feed_version: string; generated_at: string; row_count: number } | null;
  appliedAt: string | null;
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

export default function OsCyclesActions() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/os-feed');
      const d = await res.json();
      if (res.ok && d.ok) setStatus(d);
    } catch { /* best effort; the buttons still work */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(mode: 'seed' | 'publish' | 'both', label: string) {
    setBusy(label); setMsg(null);
    try {
      const res = await fetch('/api/admin/os-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      const parts: string[] = [];
      if (d.applied) {
        parts.push(`Loaded ${d.applied.total} cycles`
          + (d.applied.removed ? `, ${d.applied.removed} removed` : ''));
      }
      if (d.publish) {
        parts.push(d.publish.unchanged
          ? `Feed unchanged (${d.publish.feed_version}) — pointer refreshed`
          : d.publish.published
            ? `Published ${d.publish.feed_version}: ${d.publish.row_count} cycles`
            : `NOT published: ${d.publish.publish_note}`);
      }
      setMsg({ kind: 'ok', text: parts.join('. ') + '.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  }

  return (
    <div style={{
      marginTop: '1.5rem', padding: '1.25rem', border: '1px solid #e2e8f0',
      borderRadius: 12, background: '#fff',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>OS / firmware branch lifecycle</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        Which <strong>branch</strong> of a vendor OS is still supported — a separate corpus and a
        separate signed feed (<code>/api/v1/os-feed</code>). A device whose branch is EOL will
        never receive a fix, whatever its hardware support date says.
      </div>

      {status && (
        <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          <strong>{status.total}</strong> cycles · corpus loaded {ago(status.appliedAt)}
          {status.latest
            ? <> · feed <strong>{status.latest.feed_version}</strong> ({status.latest.row_count} rows, {ago(status.latest.generated_at)})</>
            : <span style={{ color: '#b54708' }}> · no feed published yet</span>}
        </div>
      )}

      {status && status.byProduct.length > 0 && (
        <div style={{ fontSize: '0.82rem', marginBottom: '0.9rem' }}>
          {status.byProduct.map((p) => (
            <div key={`${p.vendor}/${p.product}`} style={{
              display: 'flex', gap: '0.75rem', padding: '0.25rem 0',
              borderBottom: '1px solid #f1f5f9',
            }}>
              <span style={{ minWidth: 190, fontWeight: 600 }}>{p.vendor} {p.product}</span>
              <span style={{ minWidth: 80, opacity: 0.7 }}>{p.n} branches</span>
              <span style={{ minWidth: 110, color: '#067647' }}>{p.supported} supported</span>
              <span style={{ color: p.eol ? '#b42318' : '#667085' }}>{p.eol} EOL</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button style={btn} disabled={!!busy} onClick={() => run('seed', 'seed')}>
          {busy === 'seed' ? 'Loading…' : 'Load OS corpus'}
        </button>
        <button
          style={{ ...btn, background: '#0b5fff', color: '#fff', borderColor: '#0b5fff' }}
          disabled={!!busy}
          onClick={() => run('both', 'publish')}
        >
          {busy === 'publish' ? 'Publishing…' : 'Load & Publish OS feed'}
        </button>
        <button style={btn} disabled={!!busy} onClick={load}>Refresh</button>
      </div>

      <div style={{ marginTop: '0.75rem', fontSize: '0.78rem', opacity: 0.6 }}>
        The corpus is rebuilt by hand with <code>npm run build:os-cycles</code> and reviewed as a
        git diff — these buttons only load the deployed file and publish it.
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
