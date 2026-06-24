import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { buildAndPublishFeed } from '@/lib/feed-core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Build, sign and publish the feed. Authorized by an admin session (button) OR a
// matching x-cron-secret header (the Netlify scheduled function).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers.get('x-cron-secret');
  const authorized = !!session || (!!cronSecret && provided === cronSecret);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const result = await buildAndPublishFeed({ publishedBy: session ? 'admin-ui' : 'scheduled' });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
