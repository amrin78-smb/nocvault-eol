import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { query } from './db';

interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  role: string;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.toLowerCase().trim() ?? '';
        // TEMP debug logging — visible in Netlify function logs. Remove once auth is confirmed working.
        console.log('[auth] authorize called, email received:', JSON.stringify(email));

        if (!email || !credentials?.password) {
          console.log('[auth] missing email or password');
          return null;
        }

        try {
          const { rows } = await query<AdminRow>(
            'SELECT id, email, password_hash, role FROM admin_users WHERE email = $1 LIMIT 1',
            [email]
          );
          const user = rows[0];
          console.log('[auth] DB user found:', Boolean(user));
          if (!user) return null;

          const ok = await bcrypt.compare(credentials.password, user.password_hash);
          console.log('[auth] bcrypt.compare succeeded:', ok);
          if (!ok) return null;

          return { id: String(user.id), email: user.email, name: user.role };
        } catch (err) {
          // Surface the real failure (DB connection, schema init, etc.) instead of
          // letting it bubble up as a generic "Invalid email or password".
          console.error('[auth] authorize error:', err);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).name ?? 'admin';
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role ?? 'admin';
      }
      return session;
    },
  },
};
