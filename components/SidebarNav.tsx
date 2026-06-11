'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/vendors', label: 'Vendors' },
  { href: '/manual-entry', label: 'Manual Entry' },
  { href: '/api-explorer', label: 'API Explorer' },
];

export default function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav className="sidebar-nav">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(link.href + '/');
        return (
          <Link key={link.href} href={link.href} className={active ? 'active' : ''}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
