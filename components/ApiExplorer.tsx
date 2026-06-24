'use client';

import { useState } from 'react';

type FeedResult = {
  feed_version?: string;
  generated_at?: string;
  row_count?: number;
  error?: string;
  [key: string]: unknown;
};

export default function ApiExplorer() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FeedResult | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleLoad() {
    setLoading(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const res = await fetch('/api/v1/feed/latest');
      setStatus(res.status);
      const data: FeedResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-title">Published Feed Preview</div>
        <p style={{ opacity: 0.75 }}>
          Live per-device lookup is retired — matching now happens locally in the
          consuming app (NetVault). This page previews the published feed.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleLoad}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Load Latest Feed'}
        </button>
      </div>

      <div className="card">
        <div className="card-title">Latest Feed</div>

        {error ? (
          <div className="alert alert-error">{error}</div>
        ) : result ? (
          <>
            <p>
              {status != null && <span>HTTP {status}</span>}
              {result.feed_version && (
                <span> &middot; Version: {result.feed_version}</span>
              )}
              {typeof result.row_count === 'number' && (
                <span> &middot; Rows: {result.row_count}</span>
              )}
              {result.generated_at && (
                <span> &middot; Generated: {result.generated_at}</span>
              )}
            </p>
            <pre className="json">{JSON.stringify(result, null, 2)}</pre>
          </>
        ) : (
          <p style={{ opacity: 0.6 }}>
            Load the latest feed to preview the published version.
          </p>
        )}
      </div>
    </>
  );
}
