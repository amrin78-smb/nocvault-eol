export { default } from 'next-auth/middleware';

export const config = {
  matcher: ['/dashboard/:path*', '/vendors/:path*', '/manual-entry/:path*', '/api-explorer/:path*'],
};
