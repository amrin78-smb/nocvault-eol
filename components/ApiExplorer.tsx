'use client';

import { useState } from 'react';

type Vendor = { slug: string; name: string };

type ApiExplorerProps = {
  vendors: Vendor[];
};

type ApiResult = {
  matched?: boolean;
  vendor?: string;
  model_normalized?: string;
  model_raw?: string | null;
  eol_date?: string | null;
  eos_date?: string | null;
  confidence?: string | null;
  verified?: boolean;
  source_url?: string | null;
  similarity_score?: number;
  error?: string;
  [key: string]: unknown;
};

export default function ApiExplorer({ vendors }: ApiExplorerProps) {
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setLoading(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const url = `/api/v1/eol?vendor=${encodeURIComponent(vendor)}&model=${encodeURIComponent(
        model
      )}&license_key=${encodeURIComponent(licenseKey)}`;
      const res = await fetch(url);
      setStatus(res.status);
      const data: ApiResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  const hasMatch = result != null && typeof result.matched === 'boolean';
  const hasSimilarity = result != null && typeof result.similarity_score === 'number';

  return (
    <>
      <div className="card">
        <div className="card-title">Query EOL API</div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="vendor">Vendor</label>
            <select
              id="vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            >
              <option value="">Select a vendor</option>
              {vendors.map((v) => (
                <option key={v.slug} value={v.slug}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="model">Model</label>
            <input
              id="model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Cisco ISR 4321/K9"
            />
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="licenseKey">License Key</label>
          <input
            id="licenseKey"
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="API secret key"
          />
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={handleTest}
          disabled={loading}
        >
          {loading ? 'Testing...' : 'Test'}
        </button>
      </div>

      <div className="card">
        <div className="card-title">Response</div>

        {error ? (
          <div className="alert alert-error">{error}</div>
        ) : result ? (
          <>
            <p>
              {status != null && <span>HTTP {status}</span>}
              {hasMatch && <span> &middot; Match: {result.matched ? 'Yes' : 'No'}</span>}
              {hasSimilarity && <span> &middot; Similarity: {result.similarity_score}</span>}
              {hasSimilarity && <span> &middot; Method: pg_trgm similarity</span>}
            </p>
            <pre className="json">{JSON.stringify(result, null, 2)}</pre>
          </>
        ) : (
          <p style={{ opacity: 0.6 }}>Run a query to see the response.</p>
        )}
      </div>
    </>
  );
}
