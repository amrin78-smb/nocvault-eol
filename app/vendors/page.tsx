import Link from 'next/link';
import AppLayout from '@/components/AppLayout';
import ScrapeButton from '@/components/ScrapeButton';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface VendorRow {
  id: number;
  slug: string;
  name: string;
  scrape_status: string;
  manual_only: boolean;
  record_count: number;
  last_scraped_at: string | null;
  scrape_url: string | null;
  description: string | null;
}

export default async function VendorsPage() {
  const { rows } = await query<VendorRow>(
    `SELECT id, slug, name, scrape_status, manual_only, record_count,
            to_char(last_scraped_at, 'YYYY-MM-DD HH24:MI') AS last_scraped_at,
            scrape_url, description
     FROM vendors
     ORDER BY name`
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
              <th>Source</th>
              <th>Records</th>
              <th>Last Scraped</th>
              <th>Status</th>
              <th>Manual Only</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((vendor) => (
              <tr key={vendor.id}>
                <td>
                  {vendor.name}
                  {vendor.description && (
                    <div className="vendor-note">{vendor.description}</div>
                  )}
                </td>
                <td>
                  {vendor.scrape_url ? (
                    <a
                      className="source-link"
                      href={vendor.scrape_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source ↗
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{vendor.record_count}</td>
                <td>{vendor.last_scraped_at ?? '—'}</td>
                <td>
                  <span className={`badge badge-${vendor.scrape_status}`}>
                    {vendor.scrape_status}
                  </span>
                </td>
                <td>{vendor.manual_only ? 'Yes' : 'No'}</td>
                <td>
                  <div className="row-actions">
                    <ScrapeButton slug={vendor.slug} manualOnly={vendor.manual_only} />
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
