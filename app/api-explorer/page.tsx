import AppLayout from '@/components/AppLayout';
import ApiExplorer from '@/components/ApiExplorer';

export const dynamic = 'force-dynamic';

export default function ApiExplorerPage() {
  return (
    <AppLayout title="API Explorer">
      <div className="page-head">
        <h2>API Explorer</h2>
      </div>
      <ApiExplorer />
    </AppLayout>
  );
}
