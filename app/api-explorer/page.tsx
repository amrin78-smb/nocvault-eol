import AppLayout from '@/components/AppLayout';
import ApiExplorer from '@/components/ApiExplorer';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Vendor = { slug: string; name: string };

export default async function ApiExplorerPage() {
  const { rows } = await query<Vendor>(
    'SELECT slug, name FROM vendors ORDER BY name'
  );

  return (
    <AppLayout title="API Explorer">
      <div className="page-head">
        <h2>API Explorer</h2>
      </div>
      <ApiExplorer vendors={rows} />
    </AppLayout>
  );
}
