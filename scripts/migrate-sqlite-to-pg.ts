/**
 * Bir martalik: eski kinova.db (SQLite) → Neon Postgres.
 *
 *   npm run migrate:sqlite -- /path/to/kinova.db
 *
 * Yoki .env: DATABASE_URL + ixtiyoriy SQLITE_MIGRATE_PATH (default: ./kinova.db)
 *
 * analytics_events SQLite da yo‘q — o‘tkazilmaydi.
 * photo_requests ikki marta import qilinsa dublikat bo‘lishi mumkin — skriptni bir marta ishga tushiring.
 * Qayta ishlatish: MIGRATE_SKIP_PHOTO=1 npm run migrate:sqlite — faqat users, cache, faollik, pending.
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { initPostgresSchema, getPostgresPool, closePostgresPool } from '../src/db/postgres';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`❌ ${name} majburiy`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  requireEnv('DATABASE_URL');

  const sqlitePath =
    process.argv[2]?.trim() ||
    process.env.SQLITE_MIGRATE_PATH?.trim() ||
    path.join(process.cwd(), 'kinova.db');

  if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ SQLite fayl topilmadi: ${sqlitePath}`);
    process.exit(1);
  }

  console.log(`📂 SQLite: ${sqlitePath}`);

  await initPostgresSchema();
  const pg = getPostgresPool();

  const sqlite = new Database(sqlitePath, { readonly: true });

  try {
    const uRows = sqlite.prepare(`SELECT * FROM users`).all() as {
      telegram_id: number;
      username: string | null;
      first_name: string | null;
      created_at: number;
      request_count: number;
      last_request_at: number | null;
      started_at?: number | null;
    }[];

    let n = 0;
    for (const r of uRows) {
      await pg.query(
        `
        INSERT INTO users (telegram_id, username, first_name, created_at, request_count, last_request_at, started_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name,
          created_at = EXCLUDED.created_at,
          request_count = EXCLUDED.request_count,
          last_request_at = EXCLUDED.last_request_at,
          started_at = EXCLUDED.started_at
      `,
        [
          r.telegram_id,
          r.username,
          r.first_name,
          r.created_at,
          r.request_count,
          r.last_request_at,
          r.started_at ?? null,
        ]
      );
      n++;
    }
    console.log(`✅ users: ${n} qator`);

    const mRows = sqlite.prepare(`SELECT * FROM movie_cache`).all() as {
      cache_key: string;
      title: string;
      uz_title: string | null;
      original_title: string | null;
      year: string | null;
      poster_url: string | null;
      plot_uz: string | null;
      watch_links: string | null;
      rating: string | null;
      imdb_url: string | null;
      created_at: number;
      hit_count: number;
    }[];

    n = 0;
    for (const r of mRows) {
      await pg.query(
        `
        INSERT INTO movie_cache (
          cache_key, title, uz_title, original_title, year, poster_url, plot_uz, watch_links, rating, imdb_url, created_at, hit_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          hit_count = EXCLUDED.hit_count
      `,
        [
          r.cache_key,
          r.title,
          r.uz_title,
          r.original_title,
          r.year,
          r.poster_url,
          r.plot_uz,
          r.watch_links,
          r.rating,
          r.imdb_url,
          r.created_at,
          r.hit_count,
        ]
      );
      n++;
    }
    console.log(`✅ movie_cache: ${n} qator`);

    const skipPhoto = process.env.MIGRATE_SKIP_PHOTO === '1' || process.env.MIGRATE_SKIP_PHOTO === 'true';
    if (skipPhoto) {
      console.log(`⏭️ photo_requests: o‘tkazildi (MIGRATE_SKIP_PHOTO)`);
    } else {
      const pRows = sqlite.prepare(`SELECT telegram_id, created_at FROM photo_requests`).all() as {
        telegram_id: number;
        created_at: number;
      }[];

      n = 0;
      for (const r of pRows) {
        await pg.query(`INSERT INTO photo_requests (telegram_id, created_at) VALUES ($1, $2)`, [
          r.telegram_id,
          r.created_at,
        ]);
        n++;
      }
      console.log(`✅ photo_requests: ${n} qator`);
    }

    const aRows = sqlite.prepare(`SELECT telegram_id, day_utc FROM user_activity_day`).all() as {
      telegram_id: number;
      day_utc: string;
    }[];

    let inserted = 0;
    for (const r of aRows) {
      const ins = await pg.query(
        `INSERT INTO user_activity_day (telegram_id, day_utc) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
        [r.telegram_id, r.day_utc]
      );
      if ((ins.rowCount ?? 0) > 0) inserted++;
    }
    console.log(`✅ user_activity_day: ${aRows.length} qator urinish, ${inserted} yangi (qolganlari allaqachon bor edi)`);

    let pendRows: Record<string, unknown>[] = [];
    try {
      pendRows = sqlite.prepare(`SELECT * FROM pending_identification_feedback`).all() as Record<string, unknown>[];
    } catch {
      console.log(`⚠️ pending_identification_feedback: jadval yo‘q yoki bo‘sh — o‘tkazilmadi`);
    }

    n = 0;
    let skipped = 0;
    for (const r of pendRows) {
      const token = (r.feedback_token as string | undefined) ?? null;
      const kb = (r.keyboard_keep_json as string | undefined) ?? null;
      try {
        await pg.query(
          `
          INSERT INTO pending_identification_feedback (
            telegram_user_id, chat_id, source, predicted_title, predicted_uz_title,
            tmdb_id, imdb_id, media_type, confidence, photo_file_id, keyboard_keep_json, feedback_token, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
          [
            Number(r.telegram_user_id),
            Number(r.chat_id),
            r.source,
            r.predicted_title,
            r.predicted_uz_title ?? null,
            r.tmdb_id != null ? Number(r.tmdb_id) : null,
            r.imdb_id ?? null,
            r.media_type ?? null,
            r.confidence ?? null,
            r.photo_file_id ?? null,
            kb,
            token,
            Number(r.created_at),
          ]
        );
        n++;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('duplicate key') || msg.includes('unique')) skipped++;
        else throw e;
      }
    }
    if (pendRows.length) console.log(`✅ pending_identification_feedback: ${n} qator (takroriy token: ${skipped})`);

    console.log('\n✅ Migratsiya tugadi.');
  } finally {
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
    await closePostgresPool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
