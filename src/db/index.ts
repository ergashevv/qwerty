import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { REQUEST_WINDOW_SECONDS, isUnlimitedUser } from '../config/limits';

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
  `);
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
