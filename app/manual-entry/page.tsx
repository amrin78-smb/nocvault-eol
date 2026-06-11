import AppLayout from '@/components/AppLayout';
import ManualEntryForm from '@/components/ManualEntryForm';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Vendor = { id: number; name: string };

export default async function ManualEntryPage() {
  const { rows } = await query<Vendor>(
    'SELECT id, name FROM vendors ORDER BY name'
  );

  return (
    <AppLayout title="Manual Entry">
      <div className="page-head">
        <h2>Manual Entry</h2>
      </div>
      <ManualEntryForm vendors={rows} />
    </AppLayout>
  );
}
