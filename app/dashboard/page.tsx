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

interface FeedRow {
  feed_version: string;
  generated_at: string | null;
  row_count: number;
}

export default async function DashboardPage() {
  const [vendorsRes, modelsRes, verifiedRes, feedRes] = await Promise.all([
    query<CountRow>('SELECT COUNT(*)::int AS count FROM vendors'),
    query<CountRow>('SELECT COUNT(*)::int AS count FROM eol_models'),
    query<VerifiedRow>(
      'SELECT COUNT(*) FILTER (WHERE verified)::int AS verified, COUNT(*) FILTER (WHERE NOT verified)::int AS unverified FROM eol_models'
    ),
    query<FeedRow>(
      `SELECT feed_version, to_char(generated_at,'YYYY-MM-DD HH24:MI') AS generated_at, row_count
       FROM feed_versions ORDER BY generated_at DESC LIMIT 1`
    ),
  ]);

  const totalVendors = vendorsRes.rows[0]?.count ?? 0;
  const totalModels = modelsRes.rows[0]?.count ?? 0;
  const verified = verifiedRes.rows[0]?.verified ?? 0;
  const unverified = verifiedRes.rows[0]?.unverified ?? 0;
  const latestFeed = feedRes.rows[0] ?? null;

  return (
    <AppLayout title="Dashboard">
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Total Models</div>
          <div className="value">{totalModels}</div>
        </div>
        <div className="stat-card">
          <div className="label">Verified Models</div>
          <div className="value">{verified}</div>
          <div className="sub">{unverified} unverified</div>
        </div>
        <div className="stat-card">
          <div className="label">Vendors</div>
          <div className="value">{totalVendors}</div>
        </div>
        <div className="stat-card">
          <div className="label">Latest Feed</div>
          {latestFeed ? (
            <>
              <div className="value">{latestFeed.feed_version}</div>
              <div className="sub">
                {latestFeed.row_count} rows &middot; {latestFeed.generated_at ?? '—'}
              </div>
            </>
          ) : (
            <div className="value" style={{ fontSize: '1rem', opacity: 0.6 }}>
              no feed published yet
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
