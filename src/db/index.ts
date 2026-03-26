import crypto from 'crypto';
import {
  REQUEST_WINDOW_SECONDS,
  isUnlimitedUser,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_BURST_LIMIT,
  PHOTO_DAILY_LIMIT,
  REELS_WINDOW_SECONDS,
  REELS_LIMIT_PER_WINDOW,
} from '../config/limits';
import { getPostgresPool } from './postgres';

function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcDayStartUnix(): number {
  const now = new Date();
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor(t / 1000);
}

export async function recordUserActivityDay(telegramId: number): Promise<void> {
  const day = utcDayString();
  await getPostgresPool().query(
    `INSERT INTO user_activity_day (telegram_id, day_utc) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [telegramId, day]
  );
}

export async function markUserStarted(telegramId: number): Promise<void> {
  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `UPDATE users SET started_at = COALESCE(started_at, $1::bigint) WHERE telegram_id = $2`,
    [now, telegramId]
  );
}

export interface AudienceStats {
  totalUsers: number;
  usersStarted: number;
  dau: number;
  wau: number;
  mau: number;
}

export async function getAudienceStats(): Promise<AudienceStats> {
  const pool = getPostgresPool();
  /** Kunlik = bugungi UTC kun; haftalik = joriy hafta (dushanbadan bugungacha, UTC); oylik = joriy oy (1-kundan bugungacha, UTC). */
  const r = await pool.query(`
    WITH bounds AS (
      SELECT
        (now() AT TIME ZONE 'utc')::date AS today_utc,
        (date_trunc('week', (now() AT TIME ZONE 'utc')::timestamp))::date AS week_start_utc,
        (date_trunc('month', (now() AT TIME ZONE 'utc')::timestamp))::date AS month_start_utc
    )
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE started_at IS NOT NULL) AS users_started,
      (SELECT COUNT(DISTINCT uad.telegram_id)::int
       FROM user_activity_day uad, bounds b
       WHERE uad.day_utc = b.today_utc) AS dau,
      (SELECT COUNT(DISTINCT uad.telegram_id)::int
       FROM user_activity_day uad, bounds b
       WHERE uad.day_utc >= b.week_start_utc AND uad.day_utc <= b.today_utc) AS wau,
      (SELECT COUNT(DISTINCT uad.telegram_id)::int
       FROM user_activity_day uad, bounds b
       WHERE uad.day_utc >= b.month_start_utc AND uad.day_utc <= b.today_utc) AS mau
  `);
  const row = r.rows[0] as {
    total_users: number;
    users_started: number;
    dau: number;
    wau: number;
    mau: number;
  };
  return {
    totalUsers: Number(row.total_users ?? 0),
    usersStarted: Number(row.users_started ?? 0),
    dau: Number(row.dau ?? 0),
    wau: Number(row.wau ?? 0),
    mau: Number(row.mau ?? 0),
  };
}

export async function pruneUserActivityHistory(): Promise<void> {
  try {
    await getPostgresPool().query(`
      DELETE FROM user_activity_day
      WHERE day_utc < (now() AT TIME ZONE 'utc')::date - 400
    `);
  } catch {
    /* ignore */
  }
}

export async function canUserSendPhoto(
  telegramId: number
): Promise<{ ok: boolean; reason?: 'burst' | 'daily' }> {
  if (isUnlimitedUser(telegramId)) return { ok: true };

  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  const burstSince = now - PHOTO_BURST_WINDOW_SECONDS;

  const burstRow = await pool.query(
    `SELECT COUNT(*)::int AS c FROM photo_requests WHERE telegram_id = $1 AND created_at >= $2`,
    [telegramId, burstSince]
  );
  if (Number(burstRow.rows[0]?.c ?? 0) >= PHOTO_BURST_LIMIT) return { ok: false, reason: 'burst' };

  const dayStart = utcDayStartUnix();
  const dayRow = await pool.query(
    `SELECT COUNT(*)::int AS c FROM photo_requests WHERE telegram_id = $1 AND created_at >= $2`,
    [telegramId, dayStart]
  );
  if (Number(dayRow.rows[0]?.c ?? 0) >= PHOTO_DAILY_LIMIT) return { ok: false, reason: 'daily' };

  return { ok: true };
}

export async function recordPhotoRequest(telegramId: number): Promise<void> {
  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(`INSERT INTO photo_requests (telegram_id, created_at) VALUES ($1, $2)`, [telegramId, now]);
  const old = now - 4 * 24 * 60 * 60;
  await pool.query(`DELETE FROM photo_requests WHERE created_at < $1`, [old]);
}

export async function canUserReels(telegramId: number): Promise<boolean> {
  if (isUnlimitedUser(telegramId)) return true;
  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  const since = now - REELS_WINDOW_SECONDS;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM reels_requests WHERE telegram_id = $1 AND created_at >= $2`,
    [telegramId, since]
  );
  return Number(r.rows[0]?.c ?? 0) < REELS_LIMIT_PER_WINDOW;
}

export async function recordReelsRequest(telegramId: number): Promise<void> {
  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(`INSERT INTO reels_requests (telegram_id, created_at) VALUES ($1, $2)`, [telegramId, now]);
  const old = now - 8 * 24 * 60 * 60;
  await pool.query(`DELETE FROM reels_requests WHERE created_at < $1`, [old]);
}

/**
 * Reels limitini parallel so‘rovlarda buzmaslik uchun: users qatorini FOR UPDATE bilan qulflash + slot tekshiruvi.
 */
export async function tryReserveReelsSlot(telegramId: number): Promise<boolean> {
  if (isUnlimitedUser(telegramId)) return true;

  const client = await getPostgresPool().connect();
  const now = Math.floor(Date.now() / 1000);
  const since = now - REELS_WINDOW_SECONDS;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT 1 FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM reels_requests WHERE telegram_id = $1 AND created_at >= $2`,
      [telegramId, since]
    );
    if (Number(r.rows[0]?.c ?? 0) >= REELS_LIMIT_PER_WINDOW) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`INSERT INTO reels_requests (telegram_id, created_at) VALUES ($1, $2)`, [telegramId, now]);
    await client.query('COMMIT');
    const old = now - 8 * 24 * 60 * 60;
    await getPostgresPool().query(`DELETE FROM reels_requests WHERE created_at < $1`, [old]);
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function cacheKey(title: string): string {
  return crypto
    .createHash('sha256')
    .update(title.toLowerCase().trim())
    .digest('hex')
    .slice(0, 32);
}

export interface MovieCacheEntry {
  title: string;
  uz_title?: string;
  original_title?: string;
  year?: string;
  poster_url?: string;
  plot_uz?: string;
  watch_links?: string;
  rating?: string;
  imdb_url?: string;
}

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function getCached(title: string): Promise<MovieCacheEntry | null> {
  const pool = getPostgresPool();
  const key = cacheKey(title);
  const now = Math.floor(Date.now() / 1000);
  const r = await pool.query(
    `SELECT cache_key, title, uz_title, original_title, year, poster_url, plot_uz, watch_links, rating, imdb_url, hit_count
     FROM movie_cache
     WHERE cache_key = $1 AND ($2 - created_at) < $3`,
    [key, now, CACHE_TTL_SECONDS]
  );
  const row = r.rows[0] as
    | (MovieCacheEntry & { cache_key: string; hit_count: number; watch_links: string | null })
    | undefined;
  if (!row) return null;

  await pool.query(`UPDATE movie_cache SET hit_count = hit_count + 1 WHERE cache_key = $1`, [key]);
  return row;
}

export async function setCache(title: string, data: MovieCacheEntry): Promise<void> {
  const pool = getPostgresPool();
  const key = cacheKey(title);
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `
    INSERT INTO movie_cache (
      cache_key, title, uz_title, original_title, year, poster_url, plot_uz, watch_links, rating, imdb_url, created_at, hit_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)
    ON CONFLICT (cache_key) DO UPDATE SET
      title = EXCLUDED.title,
      uz_title = EXCLUDED.uz_title,
      original_title = EXCLUDED.original_title,
      year = EXCLUDED.year,
      poster_url = EXCLUDED.poster_url,
      plot_uz = EXCLUDED.plot_uz,
      watch_links = EXCLUDED.watch_links,
      rating = EXCLUDED.rating,
      imdb_url = EXCLUDED.imdb_url,
      created_at = EXCLUDED.created_at,
      hit_count = 0
  `,
    [
      key,
      data.title,
      data.uz_title ?? null,
      data.original_title ?? null,
      data.year ?? null,
      data.poster_url ?? null,
      data.plot_uz ?? null,
      data.watch_links ?? null,
      data.rating ?? null,
      data.imdb_url ?? null,
      now,
    ]
  );
}

export async function upsertUser(telegramId: number, username?: string, firstName?: string): Promise<void> {
  await getPostgresPool().query(
    `
    INSERT INTO users (telegram_id, username, first_name, request_count, last_request_at)
    VALUES ($1, $2, $3, 0, NULL)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name
  `,
    [telegramId, username ?? null, firstName ?? null]
  );
}

export async function incrementUserRequests(telegramId: number): Promise<number> {
  if (isUnlimitedUser(telegramId)) return 0;

  const pool = getPostgresPool();
  await pool.query(
    `
    UPDATE users SET
      request_count = CASE
        WHEN last_request_at IS NULL THEN 1
        WHEN (FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint - last_request_at) >= $1 THEN 1
        ELSE request_count + 1
      END,
      last_request_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint
    WHERE telegram_id = $2
  `,
    [REQUEST_WINDOW_SECONDS, telegramId]
  );
  const row = await pool.query(`SELECT request_count FROM users WHERE telegram_id = $1`, [telegramId]);
  return Number((row.rows[0] as { request_count: number } | undefined)?.request_count ?? 1);
}

export async function getWindowRequestCount(telegramId: number): Promise<number> {
  if (isUnlimitedUser(telegramId)) return 0;
  const pool = getPostgresPool();
  const r = await pool.query(
    `
    SELECT CASE
      WHEN last_request_at IS NULL THEN 0
      WHEN (FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint - last_request_at) >= $1 THEN 0
      ELSE request_count
    END AS effective
    FROM users WHERE telegram_id = $2
  `,
    [REQUEST_WINDOW_SECONDS, telegramId]
  );
  return Number((r.rows[0] as { effective: number } | undefined)?.effective ?? 0);
}

export function getTodayRequestCount(telegramId: number): Promise<number> {
  return getWindowRequestCount(telegramId);
}

export async function getAdminStatsSnapshot(): Promise<{
  cacheCount: number;
  topFilms: { title: string; hit_count: number }[];
  totalRequests: number;
}> {
  const pool = getPostgresPool();
  const [c, films, sum] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM movie_cache`),
    pool.query(`SELECT title, hit_count FROM movie_cache ORDER BY hit_count DESC LIMIT 5`),
    pool.query(`SELECT COALESCE(SUM(request_count), 0)::bigint AS s FROM users`),
  ]);
  return {
    cacheCount: Number(c.rows[0]?.c ?? 0),
    topFilms: films.rows as { title: string; hit_count: number }[],
    totalRequests: Number(sum.rows[0]?.s ?? 0),
  };
}

/** Inline fikr: Ha / Yo‘q — analytics_events (30+ kunlik yozuvlar avtomatik o‘chiriladi) */
export async function getIdentificationFeedbackStats(): Promise<{ yes: number; no: number }> {
  const pool = getPostgresPool();
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true)::int AS yes,
      COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false)::int AS no
    FROM analytics_events
    WHERE event_type = 'identification_feedback'
  `);
  return {
    yes: Number(r.rows[0]?.yes ?? 0),
    no: Number(r.rows[0]?.no ?? 0),
  };
}
