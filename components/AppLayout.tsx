import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import SidebarNav from './SidebarNav';
import SignOutButton from './SignOutButton';
import type { ReactNode } from 'react';

export default async function AppLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? '';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          NocVault <span className="accent">EOL</span>
        </div>
        <SidebarNav />
        <div className="sidebar-footer">
          <span className="email">{email}</span>
          <SignOutButton />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">{title}</header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
