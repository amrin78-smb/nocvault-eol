'use client';

import { useState, FormEvent } from 'react';

type Vendor = { id: number; name: string };

export default function ManualEntryForm({ vendors }: { vendors: Vendor[] }) {
  const [vendorId, setVendorId] = useState<string>(
    vendors.length > 0 ? String(vendors[0].id) : ''
  );
  const [model, setModel] = useState('');
  const [category, setCategory] = useState('');
  const [eolDate, setEolDate] = useState('');
  const [eosDate, setEosDate] = useState('');
  const [eoslDate, setEoslDate] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!vendorId || !model.trim()) {
      setError('Vendor and Model are required.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/admin/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_id: Number(vendorId),
          model_raw: model,
          category,
          eol_date: eolDate,
          eos_date: eosDate,
          eosl_date: eoslDate,
          source_url: sourceUrl,
          entry_method: 'manual',
          confidence: 'high',
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Failed to save record.');
      } else {
        setSuccess('Record saved.');
        setModel('');
        setCategory('');
        setEolDate('');
        setEosDate('');
        setEoslDate('');
        setSourceUrl('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save record.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="card-title">Add EOL Record</div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="vendor_id">Vendor</label>
          <select
            id="vendor_id"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            required
          >
            <option value="">Select a vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
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
            required
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="category">Category</label>
          <input
            id="category"
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="eol_date">EOL Date</label>
          <input
            id="eol_date"
            type="date"
            value={eolDate}
            onChange={(e) => setEolDate(e.target.value)}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="eos_date">EOS Date</label>
          <input
            id="eos_date"
            type="date"
            value={eosDate}
            onChange={(e) => setEosDate(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="eosl_date">EOSL Date</label>
          <input
            id="eosl_date"
            type="date"
            value={eoslDate}
            onChange={(e) => setEoslDate(e.target.value)}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="source_url">Source URL</label>
          <input
            id="source_url"
            type="text"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        </div>
      </div>

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving...' : 'Save Record'}
      </button>
    </form>
  );
}
