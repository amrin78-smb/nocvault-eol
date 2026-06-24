'use client';

import { useState, FormEvent } from 'react';

type Vendor = { id: number; name: string };

export default function ManualEntryForm({ vendors }: { vendors: Vendor[] }) {
  const [vendorId, setVendorId] = useState<string>(
    vendors.length > 0 ? String(vendors[0].id) : ''
  );
  const [model, setModel] = useState('');
  const [endOfSale, setEndOfSale] = useState('');
  const [supportEndDate, setSupportEndDate] = useState('');
  const [osEolDate, setOsEolDate] = useState('');
  const [confidence, setConfidence] = useState('high');
  const [sourceUrl, setSourceUrl] = useState('');
  const [note, setNote] = useState('');
  const [aliases, setAliases] = useState('');

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
          end_of_sale: endOfSale,
          support_end_date: supportEndDate,
          os_eol_date: osEolDate,
          confidence,
          source_url: sourceUrl,
          note,
          aliases,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Failed to save record.');
      } else {
        setSuccess('Record saved.');
        setModel('');
        setEndOfSale('');
        setSupportEndDate('');
        setOsEolDate('');
        setConfidence('high');
        setSourceUrl('');
        setNote('');
        setAliases('');
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
          <label htmlFor="end_of_sale">End of Sale</label>
          <input
            id="end_of_sale"
            type="date"
            value={endOfSale}
            onChange={(e) => setEndOfSale(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="support_end_date">Support End Date</label>
          <input
            id="support_end_date"
            type="date"
            value={supportEndDate}
            onChange={(e) => setSupportEndDate(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="os_eol_date">OS EOL Date</label>
          <input
            id="os_eol_date"
            type="date"
            value={osEolDate}
            onChange={(e) => setOsEolDate(e.target.value)}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="confidence">Confidence</label>
          <select
            id="confidence"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          >
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </div>
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

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="note">Note</label>
          <input
            id="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="aliases">Aliases (comma-separated)</label>
          <input
            id="aliases"
            type="text"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="alias-1, alias-2"
          />
        </div>
      </div>

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving...' : 'Save Record'}
      </button>
    </form>
  );
}
