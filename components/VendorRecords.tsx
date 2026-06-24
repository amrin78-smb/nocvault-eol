'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface RecordRow {
  id: number;
  model_raw: string;
  support_end_date: string | null;
  end_of_sale: string | null;
  os_eol_date: string | null;
  confidence: string;
  verified: boolean;
  source_url: string | null;
}

interface FormState {
  model_raw: string;
  support_end_date: string;
  end_of_sale: string;
  os_eol_date: string;
  confidence: string;
  source_url: string;
  note: string;
  verified: boolean;
}

interface RecordFormProps {
  title: string;
  form: FormState;
  showVerified: boolean;
  submitLabel: string;
  error: string;
  onChange: (next: FormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function emptyForm(): FormState {
  return {
    model_raw: '',
    support_end_date: '',
    end_of_sale: '',
    os_eol_date: '',
    confidence: 'high',
    source_url: '',
    note: '',
    verified: false,
  };
}

function RecordForm(props: RecordFormProps) {
  const { title, form, showVerified, submitLabel, error, onChange, onSubmit, onCancel } = props;

  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="form-row">
          <div className="form-group">
            <label>Model</label>
            <input
              type="text"
              required
              value={form.model_raw}
              onChange={(e) => onChange({ ...form, model_raw: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Confidence</label>
            <select
              value={form.confidence}
              onChange={(e) => onChange({ ...form, confidence: e.target.value })}
            >
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Support End Date</label>
            <input
              type="date"
              value={form.support_end_date}
              onChange={(e) => onChange({ ...form, support_end_date: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>End of Sale</label>
            <input
              type="date"
              value={form.end_of_sale}
              onChange={(e) => onChange({ ...form, end_of_sale: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>OS EOL Date</label>
            <input
              type="date"
              value={form.os_eol_date}
              onChange={(e) => onChange({ ...form, os_eol_date: e.target.value })}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Source URL</label>
            <input
              type="text"
              value={form.source_url}
              onChange={(e) => onChange({ ...form, source_url: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Note</label>
            <input
              type="text"
              value={form.note}
              onChange={(e) => onChange({ ...form, note: e.target.value })}
            />
          </div>
          {showVerified ? (
            <div className="form-group">
              <label>Verified</label>
              <input
                type="checkbox"
                checked={form.verified}
                onChange={(e) => onChange({ ...form, verified: e.target.checked })}
              />
            </div>
          ) : null}
        </div>
        <div className="row-actions">
          <button type="submit" className="btn btn-primary">
            {submitLabel}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

interface VendorRecordsProps {
  vendorId: number;
  vendorName: string;
  records: RecordRow[];
}

export default function VendorRecords({ vendorId, vendorName, records }: VendorRecordsProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addForm, setAddForm] = useState<FormState>(emptyForm());
  const [editForm, setEditForm] = useState<FormState>(emptyForm());
  const [addError, setAddError] = useState('');
  const [editError, setEditError] = useState('');

  const filtered = records.filter((r) =>
    r.model_raw.toLowerCase().includes(search.toLowerCase())
  );

  async function handleAdd() {
    setAddError('');
    try {
      const res = await fetch('/api/admin/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_id: vendorId,
          model_raw: addForm.model_raw,
          support_end_date: addForm.support_end_date,
          end_of_sale: addForm.end_of_sale,
          os_eol_date: addForm.os_eol_date,
          confidence: addForm.confidence,
          source_url: addForm.source_url,
          note: addForm.note,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAddError(data.error || 'Failed to add record');
        return;
      }
      setShowAdd(false);
      setAddForm(emptyForm());
      router.refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add record');
    }
  }

  function startEdit(row: RecordRow) {
    setEditingId(row.id);
    setEditError('');
    setEditForm({
      model_raw: row.model_raw,
      support_end_date: row.support_end_date ?? '',
      end_of_sale: row.end_of_sale ?? '',
      os_eol_date: row.os_eol_date ?? '',
      confidence: row.confidence,
      source_url: row.source_url ?? '',
      note: '',
      verified: row.verified,
    });
  }

  async function handleEdit() {
    if (editingId === null) return;
    setEditError('');
    try {
      const res = await fetch(`/api/admin/records/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_raw: editForm.model_raw,
          support_end_date: editForm.support_end_date,
          end_of_sale: editForm.end_of_sale,
          os_eol_date: editForm.os_eol_date,
          confidence: editForm.confidence,
          source_url: editForm.source_url,
          note: editForm.note,
          verified: editForm.verified,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditError(data.error || 'Failed to update record');
        return;
      }
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update record');
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this record?')) return;
    try {
      const res = await fetch(`/api/admin/records/${id}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // ignore
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>{vendorName} Records</h2>
        <button
          className="btn btn-primary"
          onClick={() => {
            setShowAdd((v) => !v);
            setAddError('');
          }}
        >
          Add Record
        </button>
      </div>

      {showAdd ? (
        <RecordForm
          title="Add Record"
          form={addForm}
          showVerified={false}
          submitLabel="Save"
          error={addError}
          onChange={setAddForm}
          onSubmit={handleAdd}
          onCancel={() => {
            setShowAdd(false);
            setAddError('');
          }}
        />
      ) : null}

      {editingId !== null ? (
        <RecordForm
          title="Edit Record"
          form={editForm}
          showVerified
          submitLabel="Update"
          error={editError}
          onChange={setEditForm}
          onSubmit={handleEdit}
          onCancel={() => {
            setEditingId(null);
            setEditError('');
          }}
        />
      ) : null}

      <div className="card">
        <input
          type="text"
          placeholder="Filter by model..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Support End</th>
              <th>End of Sale</th>
              <th>OS EOL</th>
              <th>Confidence</th>
              <th>Verified</th>
              <th>Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id}>
                <td>{row.model_raw}</td>
                <td>{row.support_end_date ?? '—'}</td>
                <td>{row.end_of_sale ?? '—'}</td>
                <td>{row.os_eol_date ?? '—'}</td>
                <td>
                  <span className={`badge badge-${row.confidence}`}>
                    {row.confidence}
                  </span>
                </td>
                <td>
                  {row.verified ? (
                    <span className="badge badge-yes">Yes</span>
                  ) : (
                    <span className="badge badge-no">No</span>
                  )}
                </td>
                <td>
                  {row.source_url ? (
                    <a
                      className="source-link"
                      href={row.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source ↗
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => startEdit(row)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleDelete(row.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
