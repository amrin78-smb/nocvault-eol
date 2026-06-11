'use client';

import { signOut } from 'next-auth/react';

export default function SignOutButton() {
  return (
    <button className="btn btn-sm" style={{ width: '100%' }} onClick={() => signOut({ callbackUrl: '/login' })}>
      Sign out
    </button>
  );
}
