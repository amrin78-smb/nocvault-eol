import AppLayout from '@/components/AppLayout';
import AdminActions from '@/components/AdminActions';
import EolWatchActions from '@/components/EolWatchActions';
import OsCyclesActions from '@/components/OsCyclesActions';
import OuiActions from '@/components/OuiActions';
import CveActions from '@/components/CveActions';
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
      <AdminActions />
      {/* The watch belongs beside the EOL feed it reports on, and ABOVE the CVE
          panel: it raises review items for the curated seed those buttons
          publish. It writes no dates of its own. */}
      <EolWatchActions />
      {/* The third corpus: OS branches, its own signed feed and its own blob
          store. Sits with the EOL panels because it answers the same question
          one layer down — not "is this box supported" but "is the software it
          runs still receiving fixes". */}
      <OsCyclesActions />
      {/* The fourth corpus: IEEE MAC address blocks. Not lifecycle data at all —
          it is here because the hub is the one component that can reach the
          registry and sign what it found, which DDIVault's five-month-stale
          hand-maintained copy is the argument for. */}
      <OuiActions />
      {/* Separate panel, separate tables, separate feed — the CVE corpus shares
          nothing with the EOL catalogue above it. */}
      <CveActions />
    </AppLayout>
  );
}
