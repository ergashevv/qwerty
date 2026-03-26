import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

/** Bitta manba: Neon Postgres. DATABASE_URL bo‘lmasa ishlamaydi. */
export function getPostgresPool(): Pool {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL majburiy — barcha ma’lumotlar Postgres (Neon) da saqlanadi.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on('error', (err) => console.error('Postgres pool xato:', err.message));
  }
  return pool;
}

export async function pingPostgres(): Promise<boolean> {
  try {
    const r = await getPostgresPool().query('SELECT 1 AS ok');
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function initPostgresSchema(): Promise<void> {
  const p = getPostgresPool();
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

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at BIGINT NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint),
      request_count INTEGER NOT NULL DEFAULT 0,
      last_request_at BIGINT,
      started_at BIGINT
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS movie_cache (
      cache_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      uz_title TEXT,
      original_title TEXT,
      year TEXT,
      poster_url TEXT,
      plot_uz TEXT,
      watch_links TEXT,
      rating TEXT,
      imdb_url TEXT,
      created_at BIGINT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_movie_cache_created ON movie_cache (created_at)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS photo_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_photo_user_time ON photo_requests (telegram_id, created_at)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS reels_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_reels_user_time ON reels_requests (telegram_id, created_at)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS pending_identification_feedback (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('photo','text','reels')),
      predicted_title TEXT NOT NULL,
      predicted_uz_title TEXT,
      tmdb_id INTEGER,
      imdb_id TEXT,
      media_type TEXT,
      confidence TEXT,
      photo_file_id TEXT,
      keyboard_keep_json TEXT,
      feedback_token TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_feedback_token
    ON pending_identification_feedback (feedback_token)
    WHERE feedback_token IS NOT NULL
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_pending_fb_user ON pending_identification_feedback (telegram_user_id)
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_pending_fb_created ON pending_identification_feedback (created_at)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS user_activity_day (
      telegram_id BIGINT NOT NULL,
      day_utc DATE NOT NULL,
      PRIMARY KEY (telegram_id, day_utc)
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_user_activity_day ON user_activity_day (day_utc)
  `);

  /** Eski bazalar: feedback source ga `reels` qo‘shish */
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE pending_identification_feedback DROP CONSTRAINT pending_identification_feedback_source_check;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE pending_identification_feedback ADD CONSTRAINT pending_identification_feedback_source_check
        CHECK (source IN ('photo','text','reels'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
}

export async function withPgClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T | null> {
  const c = await getPostgresPool().connect();
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

export async function insertAnalyticsEvent(
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await getPostgresPool().query(`INSERT INTO analytics_events (event_type, metadata) VALUES ($1, $2::jsonb)`, [
      eventType,
      JSON.stringify(metadata),
    ]);
  } catch (e) {
    console.warn('analytics_events:', (e as Error).message);
  }
}

export async function runAnalyticsRetention(): Promise<void> {
  try {
    const r = await getPostgresPool().query(`
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
