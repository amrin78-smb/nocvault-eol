import AppLayout from '@/components/AppLayout';
import VendorRecords, { type RecordRow } from '@/components/VendorRecords';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface VendorRow {
  id: number;
  name: string;
}

export default async function VendorRecordsPage({
  params,
}: {
  params: { slug: string };
}) {
  const { rows: vendors } = await query<VendorRow>(
    `SELECT id, name FROM vendors WHERE slug = $1`,
    [params.slug]
  );

  const vendor = vendors[0];
  if (!vendor) {
    return (
      <AppLayout title="Vendor Records">
        <div className="card">Vendor not found.</div>
      </AppLayout>
    );
  }

  const { rows } = await query<RecordRow>(
    `SELECT id, model_raw,
            support_end_date::text AS support_end_date,
            end_of_sale::text AS end_of_sale,
            os_eol_date::text AS os_eol_date,
            confidence, verified, source_url
     FROM eol_models
     WHERE vendor_id = $1
     ORDER BY model_raw`,
    [vendor.id]
  );

  return (
    <AppLayout title="Vendor Records">
      <VendorRecords vendorId={vendor.id} vendorName={vendor.name} records={rows} />
    </AppLayout>
  );
}
