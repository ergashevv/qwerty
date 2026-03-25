import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import {
  REQUEST_WINDOW_SECONDS,
  isUnlimitedUser,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_BURST_LIMIT,
  PHOTO_DAILY_LIMIT,
} from '../config/limits';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'kinova.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id   INTEGER PRIMARY KEY,
      username      TEXT,
      first_name    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      request_count INTEGER NOT NULL DEFAULT 0,
      last_request_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS movie_cache (
      cache_key      TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      uz_title       TEXT,
      original_title TEXT,
      year           TEXT,
      poster_url     TEXT,
      plot_uz        TEXT,
      watch_links    TEXT,
      rating         TEXT,
      imdb_url       TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      hit_count      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_movie_cache_created ON movie_cache(created_at);

    CREATE TABLE IF NOT EXISTS photo_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_user_time ON photo_requests(telegram_id, created_at);

    CREATE TABLE IF NOT EXISTS pending_identification_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('photo','text')),
      predicted_title TEXT NOT NULL,
      predicted_uz_title TEXT,
      tmdb_id INTEGER,
      imdb_id TEXT,
      media_type TEXT,
      confidence TEXT,
      photo_file_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_fb_user ON pending_identification_feedback(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_fb_created ON pending_identification_feedback(created_at);

    CREATE TABLE IF NOT EXISTS user_activity_day (
      telegram_id INTEGER NOT NULL,
      day_utc     TEXT NOT NULL,
      PRIMARY KEY (telegram_id, day_utc)
    );
    CREATE INDEX IF NOT EXISTS idx_user_activity_day ON user_activity_day(day_utc);
  `);
  migrateAudienceSchema();
}

/** started_at va boshqa ustunlar — mavjud DB uchun */
function migrateAudienceSchema(): void {
  const d = getDb();
  const cols = d.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'started_at')) {
    d.exec(`ALTER TABLE users ADD COLUMN started_at INTEGER`);
  }
}

/** UTC sana YYYY-MM-DD — SQLite date('now') bilan mos */
function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Kunlik faollik (DAU/WAU/MAU) — har bir user/kun bir marta */
export function recordUserActivityDay(telegramId: number): void {
  const d = getDb();
  const day = utcDayString();
  d.prepare(`INSERT OR IGNORE INTO user_activity_day (telegram_id, day_utc) VALUES (?, ?)`).run(
    telegramId,
    day
  );
}

/** Faqat /start bosilganda — birinchi marta started_at qo‘yiladi */
export function markUserStarted(telegramId: number): void {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  d.prepare(`UPDATE users SET started_at = COALESCE(started_at, ?) WHERE telegram_id = ?`).run(
    now,
    telegramId
  );
}

export interface AudienceStats {
  /** users jadvalidagi barcha (rasm/matn/start orqali yozilgan) */
  totalUsers: number;
  /** Kamida bir marta /start bosgan (started_at mavjud) */
  usersStarted: number;
  /** Bugun UTC bo‘yicha kamida 1 marta faol */
  dau: number;
  /** So‘nggi 7 kun (jumladan bugun) */
  wau: number;
  /** So‘nggi 30 kun */
  mau: number;
}

export function getAudienceStats(): AudienceStats {
  const d = getDb();
  const totalUsers = (d.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  const usersStarted = (
    d.prepare(`SELECT COUNT(*) AS c FROM users WHERE started_at IS NOT NULL`).get() as { c: number }
  ).c;
  const dau = (
    d
      .prepare(
        `SELECT COUNT(DISTINCT telegram_id) AS c FROM user_activity_day WHERE day_utc = date('now')`
      )
      .get() as { c: number }
  ).c;
  const wau = (
    d
      .prepare(
        `SELECT COUNT(DISTINCT telegram_id) AS c FROM user_activity_day
         WHERE day_utc >= date('now', '-6 days') AND day_utc <= date('now')`
      )
      .get() as { c: number }
  ).c;
  const mau = (
    d
      .prepare(
        `SELECT COUNT(DISTINCT telegram_id) AS c FROM user_activity_day
         WHERE day_utc >= date('now', '-29 days') AND day_utc <= date('now')`
      )
      .get() as { c: number }
  ).c;
  return { totalUsers, usersStarted, dau, wau, mau };
}

/** Juda eski kunlar — jadval hajmini cheklash (~1 yil) */
export function pruneUserActivityHistory(): void {
  try {
    const d = getDb();
    d.prepare(`DELETE FROM user_activity_day WHERE day_utc < date('now', '-400 days')`).run();
  } catch {
    /* ignore */
  }
}

function utcDayStartUnix(): number {
  const now = new Date();
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor(t / 1000);
}

/** Rasm yuborish: burst + kunlik limit (matn limitidan alohida) */
export function canUserSendPhoto(telegramId: number): { ok: boolean; reason?: 'burst' | 'daily' } {
  if (isUnlimitedUser(telegramId)) return { ok: true };

  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const burstSince = now - PHOTO_BURST_WINDOW_SECONDS;

  const burstRow = d
    .prepare(`SELECT COUNT(*) AS c FROM photo_requests WHERE telegram_id = ? AND created_at >= ?`)
    .get(telegramId, burstSince) as { c: number };
  if (burstRow.c >= PHOTO_BURST_LIMIT) return { ok: false, reason: 'burst' };

  const dayStart = utcDayStartUnix();
  const dayRow = d
    .prepare(`SELECT COUNT(*) AS c FROM photo_requests WHERE telegram_id = ? AND created_at >= ?`)
    .get(telegramId, dayStart) as { c: number };
  if (dayRow.c >= PHOTO_DAILY_LIMIT) return { ok: false, reason: 'daily' };

  return { ok: true };
}

export function recordPhotoRequest(telegramId: number): void {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  d.prepare(`INSERT INTO photo_requests (telegram_id, created_at) VALUES (?, ?)`).run(telegramId, now);
  const old = now - 4 * 24 * 60 * 60;
  d.prepare(`DELETE FROM photo_requests WHERE created_at < ?`).run(old);
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

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 kun

export function getCached(title: string): MovieCacheEntry | null {
  const d = getDb();
  const key = cacheKey(title);
  const row = d
    .prepare(
      `SELECT * FROM movie_cache WHERE cache_key = ? AND (unixepoch() - created_at) < ?`
    )
    .get(key, CACHE_TTL_SECONDS) as MovieCacheEntry & { cache_key: string; hit_count: number } | undefined;

  if (!row) return null;

  d.prepare(`UPDATE movie_cache SET hit_count = hit_count + 1 WHERE cache_key = ?`).run(key);
  return row;
}

export function setCache(title: string, data: MovieCacheEntry): void {
  const d = getDb();
  const key = cacheKey(title);
  d.prepare(`
    INSERT OR REPLACE INTO movie_cache
      (cache_key, title, uz_title, original_title, year, poster_url, plot_uz, watch_links, rating, imdb_url, created_at, hit_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 0)
  `).run(
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
  );
}

export function upsertUser(telegramId: number, username?: string, firstName?: string): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO users (telegram_id, username, first_name, request_count, last_request_at)
    VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(telegramId, username ?? null, firstName ?? null);
}

export function incrementUserRequests(telegramId: number): number {
  if (isUnlimitedUser(telegramId)) return 0;

  const d = getDb();
  // So'nggi so'rovdan 12 soat o'tgan bo'lsa — yangi oyna, count=1
  d.prepare(`
    UPDATE users SET
      request_count = CASE
        WHEN last_request_at IS NULL THEN 1
        WHEN (unixepoch() - last_request_at) >= ? THEN 1
        ELSE request_count + 1
      END,
      last_request_at = unixepoch()
    WHERE telegram_id = ?
  `).run(REQUEST_WINDOW_SECONDS, telegramId);
  const row = d.prepare(`SELECT request_count FROM users WHERE telegram_id = ?`).get(telegramId) as { request_count: number } | undefined;
  return row?.request_count ?? 1;
}

/**
 * Joriy oynadagi ishlatilgan so'rovlar (increment bilan bir xil qoida).
 * Vaqt: faqat SQLite unixepoch() — Node Date.now() bilan farq bo'lib qolmaydi.
 */
export function getWindowRequestCount(telegramId: number): number {
  if (isUnlimitedUser(telegramId)) return 0;
  const d = getDb();
  const row = d.prepare(`
    SELECT CASE
      WHEN last_request_at IS NULL THEN 0
      WHEN (unixepoch() - last_request_at) >= ? THEN 0
      ELSE request_count
    END AS effective
    FROM users WHERE telegram_id = ?
  `).get(REQUEST_WINDOW_SECONDS, telegramId) as { effective: number } | undefined;
  return row?.effective ?? 0;
}

/** @deprecated getWindowRequestCount ishlating */
export function getTodayRequestCount(telegramId: number): number {
  return getWindowRequestCount(telegramId);
}
