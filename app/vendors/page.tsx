import Link from 'next/link';
import AppLayout from '@/components/AppLayout';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface VendorRow {
  id: number;
  slug: string;
  name: string;
  manual_only: boolean;
  lifecycle_source_url: string | null;
  record_count: number;
}

export default async function VendorsPage() {
  const { rows } = await query<VendorRow>(
    `SELECT v.id, v.slug, v.name, v.manual_only, v.lifecycle_source_url,
            (SELECT count(*) FROM eol_models m WHERE m.vendor_id = v.id)::int AS record_count
     FROM vendors v
     ORDER BY v.name`
  );

  return (
    <AppLayout title="Vendors">
      <div className="page-head">
        <h2>Vendors</h2>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Models</th>
              <th>Manual Only</th>
              <th>Lifecycle Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((vendor) => (
              <tr key={vendor.id}>
                <td>{vendor.name}</td>
                <td>{vendor.record_count}</td>
                <td>
                  {vendor.manual_only ? (
                    <span className="badge badge-yes">Yes</span>
                  ) : (
                    <span className="badge badge-no">No</span>
                  )}
                </td>
                <td>
                  {vendor.lifecycle_source_url ? (
                    <a
                      className="source-link"
                      href={vendor.lifecycle_source_url}
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
                    <Link className="btn btn-sm" href={`/vendors/${vendor.slug}`}>
                      View Records
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppLayout>
  );
}
