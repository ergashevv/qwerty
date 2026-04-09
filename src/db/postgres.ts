import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

const PG_RETRY_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.PG_QUERY_RETRY_ATTEMPTS || 3)));
const PG_RETRY_BASE_MS = Math.max(50, Number(process.env.PG_QUERY_RETRY_BASE_MS || 200));

function isTransientPgError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  if (/Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|connection timeout|Connection closed/i.test(msg)) {
    return true;
  }
  const code = (e as { code?: string })?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
  return false;
}

/**
 * Neon / tarmoq: uzoq idle yoki uzilishdan keyin birinchi so‘rov ba’zan yiqiladi — qayta urinib yangi ulanish olinadi.
 */
export async function withPgRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= PG_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientPgError(e) || attempt === PG_RETRY_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, PG_RETRY_BASE_MS * attempt));
    }
  }
  throw last;
}

function wrapPoolQueryWithRetry(p: Pool): void {
  const original = p.query.bind(p) as (...args: unknown[]) => Promise<unknown>;
  (p as { query: typeof original }).query = (...args: unknown[]) =>
    withPgRetry(() => original(...args));
}

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
      /** Server tomonida idle yopilishidan oldin klient ulanishni yangilash */
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 30_000,
      keepAlive: true,
    });
    pool.on('error', (err) => console.error('Postgres pool xato:', err.message));
    wrapPoolQueryWithRetry(pool);
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
  /** Dashboard / event_type bo‘yicha tez filtrlash */
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_event_type_created
    ON analytics_events (event_type, created_at DESC)
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_identification_feedback
    ON analytics_events (created_at DESC)
    WHERE event_type = 'identification_feedback'
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
    DO $$ BEGIN
      ALTER TABLE movie_cache ADD COLUMN tmdb_id INTEGER;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE movie_cache ADD COLUMN media_type TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE movie_cache ADD CONSTRAINT movie_cache_media_type_check
        CHECK (media_type IS NULL OR media_type IN ('movie','tv'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  /** TMDB bo‘yicha kesh qidiruv (ikki qatorli canonical kalit o‘rniga) */
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_movie_cache_tmdb_lookup
    ON movie_cache (tmdb_id, media_type)
    WHERE tmdb_id IS NOT NULL
  `);
  /**
   * Eski dual-write: cache_key = 'tmdb:ID:movie|tv' — title qatori bilan bir xil ma’lumot.
   * Endi TMDB lookup ustun orqali (idx_movie_cache_tmdb_lookup), shuning uchun ortiqcha.
   */
  await p.query(`DELETE FROM movie_cache WHERE cache_key LIKE 'tmdb:%'`);

  /** Instagram / YouTube havolasi → bir marta aniqlangan film (yt-dlp + AI qayta ishlatmaslik) */
  await p.query(`
    CREATE TABLE IF NOT EXISTS video_url_cache (
      url_hash TEXT PRIMARY KEY,
      normalized_url TEXT NOT NULL,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
      tmdb_id INTEGER,
      created_at BIGINT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_video_url_cache_created ON video_url_cache (created_at)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS film_photo_evidence (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
      imdb_id TEXT,
      telegram_file_id TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_film_photo_evidence_tmdb ON film_photo_evidence (tmdb_id, media_type)
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

  /** Har bir matn / rasm / reels qidiruvi — statistika (feedbackdan mustaqil) */
  await p.query(`
    CREATE TABLE IF NOT EXISTS search_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('text','photo','reels')),
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_search_requests_time ON search_requests (created_at DESC)
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_search_requests_src_time ON search_requests (source, created_at DESC)
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE search_requests ADD COLUMN query_text TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
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
    DO $$ BEGIN
      ALTER TABLE pending_identification_feedback ADD COLUMN user_query_text TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE pending_identification_feedback ADD COLUMN bot_reply_preview TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
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

  /** Donate prompt: hisoblagichlar va milestone kuzatuv */
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN positive_feedback_total INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN successful_ident_total INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN last_donate_prompt_at TIMESTAMPTZ NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN donate_prompt_opt_out BOOLEAN NOT NULL DEFAULT FALSE;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN donate_last_feedback_milestone INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN donate_last_success_milestone INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN blocked_at TIMESTAMPTZ NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  await p.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN feedback_no_streak INTEGER NOT NULL DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS identification_problem_report_pending (
      telegram_id BIGINT PRIMARY KEY,
      predicted_title TEXT,
      predicted_uz_title TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS identification_problem_reports (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      body_text TEXT NOT NULL,
      predicted_title TEXT,
      predicted_uz_title TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_identification_problem_reports_time
    ON identification_problem_reports (created_at DESC)
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_identification_problem_reports_user
    ON identification_problem_reports (telegram_user_id, created_at DESC)
  `);

  await p.query(`
    DO $$ BEGIN
      ALTER TABLE identification_problem_reports ADD COLUMN photo_file_id TEXT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS survey_broadcast_responses (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      telegram_user_id BIGINT NOT NULL,
      satisfied BOOLEAN NOT NULL,
      problem_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (telegram_user_id, campaign_id)
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_survey_broadcast_campaign
    ON survey_broadcast_responses (campaign_id, created_at DESC)
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS survey_problem_pending (
      telegram_id BIGINT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS survey_broadcast_sent (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      telegram_id BIGINT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_survey_broadcast_sent_campaign
    ON survey_broadcast_sent (campaign_id, created_at DESC)
  `);

  /** LLM tokenlar (Azure); jadval nomi tarixiy */
  await p.query(`
    CREATE TABLE IF NOT EXISTS gemini_usage (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT,
      operation TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_gemini_usage_created ON gemini_usage (created_at DESC)
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_gemini_usage_user_time ON gemini_usage (telegram_id, created_at DESC)
  `);

  /** Bot runtime flaglari (admin commandlar orqali boshqariladi) */
  await p.query(`
    CREATE TABLE IF NOT EXISTS bot_runtime_flags (
      flag_key TEXT PRIMARY KEY,
      flag_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /** Kanal promo: user darajasida oxirgi ko‘rsatish va obuna holati */
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_channel_promo_state (
      telegram_id BIGINT PRIMARY KEY,
      last_shown_at BIGINT,
      subscribed BOOLEAN NOT NULL DEFAULT FALSE,
      subscribed_checked_at BIGINT
    )
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

export async function getBotRuntimeFlag(flagKey: string): Promise<string | null> {
  try {
    const r = await getPostgresPool().query(
      `SELECT flag_value FROM bot_runtime_flags WHERE flag_key = $1 LIMIT 1`,
      [flagKey]
    );
    return (r.rows[0]?.flag_value as string | undefined) ?? null;
  } catch (e) {
    console.warn('bot_runtime_flags get:', (e as Error).message?.slice(0, 120));
    return null;
  }
}

export async function setBotRuntimeFlag(flagKey: string, flagValue: string): Promise<void> {
  try {
    await getPostgresPool().query(
      `INSERT INTO bot_runtime_flags (flag_key, flag_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (flag_key)
       DO UPDATE SET flag_value = EXCLUDED.flag_value, updated_at = NOW()`,
      [flagKey, flagValue]
    );
  } catch (e) {
    console.warn('bot_runtime_flags set:', (e as Error).message?.slice(0, 120));
  }
}

export interface UserChannelPromoState {
  telegramId: number;
  lastShownAt: number | null;
  subscribed: boolean;
  subscribedCheckedAt: number | null;
}

export async function getUserChannelPromoState(
  telegramId: number
): Promise<UserChannelPromoState | null> {
  try {
    const r = await getPostgresPool().query(
      `SELECT telegram_id, last_shown_at, subscribed, subscribed_checked_at
       FROM user_channel_promo_state
       WHERE telegram_id = $1
       LIMIT 1`,
      [telegramId]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      telegramId: Number(row.telegram_id),
      lastShownAt:
        row.last_shown_at == null ? null : Number(row.last_shown_at),
      subscribed: Boolean(row.subscribed),
      subscribedCheckedAt:
        row.subscribed_checked_at == null ? null : Number(row.subscribed_checked_at),
    };
  } catch (e) {
    console.warn('user_channel_promo_state get:', (e as Error).message?.slice(0, 120));
    return null;
  }
}

export async function markUserChannelPromoShown(
  telegramId: number,
  shownAtEpochSec: number
): Promise<void> {
  try {
    await getPostgresPool().query(
      `INSERT INTO user_channel_promo_state (telegram_id, last_shown_at)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET last_shown_at = EXCLUDED.last_shown_at`,
      [telegramId, shownAtEpochSec]
    );
  } catch (e) {
    console.warn('user_channel_promo_state shown:', (e as Error).message?.slice(0, 120));
  }
}

export async function setUserChannelPromoSubscribed(
  telegramId: number,
  subscribed: boolean,
  checkedAtEpochSec: number
): Promise<void> {
  try {
    await getPostgresPool().query(
      `INSERT INTO user_channel_promo_state (telegram_id, subscribed, subscribed_checked_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id)
       DO UPDATE SET subscribed = EXCLUDED.subscribed, subscribed_checked_at = EXCLUDED.subscribed_checked_at`,
      [telegramId, subscribed, checkedAtEpochSec]
    );
  } catch (e) {
    console.warn('user_channel_promo_state subscribed:', (e as Error).message?.slice(0, 120));
  }
}

/**
 * Feedback: dashboard_thumb_b64 (base64) faqat so‘nggi N kunda saqlanadi — keyin metadata dan olib tashlanadi.
 * To‘liq qator M kundan keyin o‘chiriladi (M >= N bo‘lishi kerak).
 * Env: FEEDBACK_THUMB_RETENTION_DAYS (default 30), FEEDBACK_ANALYTICS_RETENTION_DAYS (default 90).
 */
export async function runAnalyticsRetention(): Promise<void> {
  const pool = getPostgresPool();
  const thumbDays = Math.min(365, Math.max(1, parseInt(process.env.FEEDBACK_THUMB_RETENTION_DAYS || '30', 10)));
  let eventDays = Math.min(730, Math.max(1, parseInt(process.env.FEEDBACK_ANALYTICS_RETENTION_DAYS || '90', 10)));
  if (eventDays < thumbDays) eventDays = thumbDays;

  try {
    const strip = await pool.query(
      `
      UPDATE analytics_events
      SET metadata = metadata - 'dashboard_thumb_b64' - 'user_query_text' - 'bot_reply_preview'
      WHERE event_type = 'identification_feedback'
        AND created_at < NOW() - ($1::integer * INTERVAL '1 day')
        AND (
          metadata ? 'dashboard_thumb_b64'
          OR metadata ? 'user_query_text'
          OR metadata ? 'bot_reply_preview'
        )
    `,
      [thumbDays]
    );
    const ns = strip.rowCount ?? 0;
    if (ns > 0) {
      console.log(
        `📉 Analytics: ${ns} ta feedbackdan rasm/matn qoldiqlari o‘chirildi (${thumbDays}+ kun)`
      );
    }
  } catch (e) {
    console.warn('analytics thumb retention:', (e as Error).message);
  }

  try {
    const r = await pool.query(
      `
      DELETE FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at < NOW() - ($1::integer * INTERVAL '1 day')
    `,
      [eventDays]
    );
    const n = r.rowCount ?? 0;
    if (n > 0) {
      console.log(`📉 Analytics: ${n} ta eski feedback yozuvi o‘chirildi (${eventDays}+ kun)`);
    }
  } catch (e) {
    console.warn('analytics retention:', (e as Error).message);
  }

  const geminiUsageDays = Math.min(
    365,
    Math.max(
      14,
      parseInt(process.env.LLM_USAGE_RETENTION_DAYS || process.env.GEMINI_USAGE_RETENTION_DAYS || '90', 10)
    )
  );
  try {
    const gr = await pool.query(`DELETE FROM gemini_usage WHERE created_at < $1`, [
      Math.floor(Date.now() / 1000) - geminiUsageDays * 86400,
    ]);
    const gn = gr.rowCount ?? 0;
    if (gn > 0) {
      console.log(`📉 gemini_usage: ${gn} ta eski yozuv o‘chirildi (${geminiUsageDays}+ kun)`);
    }
  } catch (e) {
    console.warn('gemini_usage retention:', (e as Error).message);
  }
}
