import AppLayout from '@/components/AppLayout';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface CountRow {
  count: number;
}

interface VerifiedRow {
  verified: number;
  unverified: number;
}

interface RecentQueryRow {
  queried_at: string | null;
  license_key: string | null;
  vendor: string | null;
  model_query: string | null;
  matched_product_id: number | null;
  cache_hit: boolean;
}

function maskLicenseKey(key: string | null): string {
  if (!key) return '—';
  return `••••${key.slice(-4)}`;
}

export default async function DashboardPage() {
  const [vendorsRes, recordsRes, verifiedRes, queriesTodayRes, recentRes] =
    await Promise.all([
      query<CountRow>('SELECT COUNT(*)::int AS count FROM vendors'),
      query<CountRow>('SELECT COUNT(*)::int AS count FROM eol_products'),
      query<VerifiedRow>(
        'SELECT COUNT(*) FILTER (WHERE verified)::int AS verified, COUNT(*) FILTER (WHERE NOT verified)::int AS unverified FROM eol_products'
      ),
      query<CountRow>(
        'SELECT COUNT(*)::int AS count FROM api_queries WHERE queried_at::date = CURRENT_DATE'
      ),
      query<RecentQueryRow>(
        `SELECT to_char(queried_at,'YYYY-MM-DD HH24:MI') AS queried_at, license_key, vendor, model_query, matched_product_id, cache_hit
         FROM api_queries ORDER BY queried_at DESC LIMIT 10`
      ),
    ]);

  const totalVendors = vendorsRes.rows[0]?.count ?? 0;
  const totalRecords = recordsRes.rows[0]?.count ?? 0;
  const verified = verifiedRes.rows[0]?.verified ?? 0;
  const unverified = verifiedRes.rows[0]?.unverified ?? 0;
  const queriesToday = queriesTodayRes.rows[0]?.count ?? 0;
  const recent = recentRes.rows;

  return (
    <AppLayout title="Dashboard">
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Total Vendors</div>
          <div className="value">{totalVendors}</div>
        </div>
        <div className="stat-card">
          <div className="label">EOL Records</div>
          <div className="value">{totalRecords}</div>
        </div>
        <div className="stat-card">
          <div className="label">Verified Records</div>
          <div className="value">{verified}</div>
          <div className="sub">{unverified} unverified</div>
        </div>
        <div className="stat-card">
          <div className="label">API Queries Today</div>
          <div className="value">{queriesToday}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Recent API Queries</div>
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>License Key</th>
              <th>Vendor</th>
              <th>Model Query</th>
              <th>Matched</th>
              <th>Cache Hit</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No API queries yet.
                </td>
              </tr>
            ) : (
              recent.map((q, i) => (
                <tr key={i}>
                  <td>{q.queried_at ?? '—'}</td>
                  <td>{maskLicenseKey(q.license_key)}</td>
                  <td>{q.vendor ?? '—'}</td>
                  <td>{q.model_query ?? '—'}</td>
                  <td>
                    {q.matched_product_id != null ? (
                      <span className="badge badge-yes">Yes</span>
                    ) : (
                      <span className="badge badge-no">No</span>
                    )}
                  </td>
                  <td>{q.cache_hit ? 'Yes' : 'No'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AppLayout>
  );
}
