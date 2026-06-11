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
    `SELECT id, model_raw, category,
            eol_date::text AS eol_date,
            eos_date::text AS eos_date,
            eosl_date::text AS eosl_date,
            source_url, confidence, verified, entry_method
     FROM eol_products
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
