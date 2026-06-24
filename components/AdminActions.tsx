'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Result = { ok?: boolean; error?: string; [k: string]: unknown };

export default function AdminActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function run(path: string, label: string, summarize: (d: Result) => string) {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      const data: Result = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ kind: 'ok', text: summarize(data) });
      router.refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const btn: React.CSSProperties = {
    padding: '0.55rem 1rem',
    borderRadius: 8,
    border: '1px solid #d0d5dd',
    background: '#fff',
    cursor: busy ? 'wait' : 'pointer',
    fontWeight: 600,
    fontSize: '0.9rem',
  };

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
      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Feed actions</div>
      <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.9rem' }}>
        Re-seed the curated models, then build &amp; publish the signed feed to storage.
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          style={btn}
          disabled={!!busy}
          onClick={() =>
            run('/api/admin/seed', 'seed', (d) => `Seeded: ${d.models} models, ${d.aliases} aliases.`)
          }
        >
          {busy === 'seed' ? 'Seeding…' : 'Load curated seed'}
        </button>
        <button
          style={{ ...btn, background: '#0b5fff', color: '#fff', borderColor: '#0b5fff' }}
          disabled={!!busy}
          onClick={() =>
            run('/api/admin/publish-feed', 'publish', (d) =>
              `Published ${d.feed_version}: ${d.row_count} models${
                d.published ? '' : ` — WARNING blobs not written: ${d.publish_note}`
              }.`
            )
          }
        >
          {busy === 'publish' ? 'Publishing…' : 'Build & Publish Feed'}
        </button>
      </div>
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
