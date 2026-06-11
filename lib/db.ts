import { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var _nvPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

// Reuse a single pool across hot reloads / serverless invocations.
export const pool: Pool = global._nvPool ?? createPool();
if (process.env.NODE_ENV !== 'production') {
  global._nvPool = pool;
}

export async function query<T = any>(
  text: string,
  params: any[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  await ensureSchema();
  const res = await pool.query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

// Raw query that does NOT trigger schema init — used by the init routine itself.
export async function rawQuery<T = any>(
  text: string,
  params: any[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await pool.query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

// ---- One-time schema + seed initialisation (memoised) ----
import { runInit } from './init';

declare global {
  // eslint-disable-next-line no-var
  var _nvInit: Promise<void> | undefined;
}

export function ensureSchema(): Promise<void> {
  if (!global._nvInit) {
    global._nvInit = runInit().catch((err) => {
      // Reset so a later request can retry after a transient failure.
      global._nvInit = undefined;
      throw err;
    });
  }
  return global._nvInit;
}
