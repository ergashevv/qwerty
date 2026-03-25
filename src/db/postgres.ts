import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

export function getPostgresPool(): Pool | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on('error', (err) => console.error('Postgres pool xato:', err.message));
  }
  return pool;
}

export async function pingPostgres(): Promise<boolean> {
  const p = getPostgresPool();
  if (!p) return false;
  const r = await p.query('SELECT 1 AS ok');
  return r.rows[0]?.ok === 1;
}

/** Minimal jadval — keyingi analytics eventlar uchun */
export async function initPostgresSchema(): Promise<void> {
  const p = getPostgresPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events (created_at DESC)
  `);
}

export async function withPgClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T | null> {
  const p = getPostgresPool();
  if (!p) return null;
  const c = await p.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Foydalanuvchi feedback, moderasiya va dashboard uchun */
export async function insertAnalyticsEvent(
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const p = getPostgresPool();
  if (!p) return;
  try {
    await p.query(`INSERT INTO analytics_events (event_type, metadata) VALUES ($1, $2::jsonb)`, [
      eventType,
      JSON.stringify(metadata),
    ]);
  } catch (e) {
    console.warn('analytics_events:', (e as Error).message);
  }
}

/** Noto‘g‘ri/topilgan feedback — 30 kundan oshiq yozuvlarni o‘chirish */
export async function runAnalyticsRetention(): Promise<void> {
  const p = getPostgresPool();
  if (!p) return;
  try {
    const r = await p.query(`
      DELETE FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at < NOW() - INTERVAL '30 days'
    `);
    const n = r.rowCount ?? 0;
    if (n > 0) console.log(`📉 Analytics: ${n} ta eski feedback (30+ kun) o‘chirildi`);
  } catch (e) {
    console.warn('analytics retention:', (e as Error).message);
  }
}
