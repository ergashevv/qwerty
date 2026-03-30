import { getAudienceStats } from '../db';
import { getPostgresPool } from '../db/postgres';
import { getReelsQueueDepth } from '../services/reelsQueue';

export interface HealthCheckComponent {
  status: 'ok' | 'degraded' | 'error';
  /** Response time in milliseconds (where applicable) */
  responseTimeMs?: number;
  /** Human-readable detail */
  detail?: string;
}

export interface HealthStatus {
  /** Overall health: ok = all green, degraded = non-critical issues, error = critical failure */
  status: 'ok' | 'degraded' | 'error';
  /** ISO 8601 timestamp of this check */
  timestamp: string;
  /** Process uptime in seconds */
  uptimeSeconds: number;
  components: {
    postgres: HealthCheckComponent;
    reelsQueue: HealthCheckComponent;
  };
  metrics: {
    /** Active users today */
    dau: number;
    /** Total registered users */
    totalUsers: number;
    /** Search requests in the last 24 h broken down by source */
    searchRequestsH24: SearchRequestTriple;
    /** Identification error rate in the last 24 h (0–1), null if no feedback yet */
    errorRateH24: number | null;
    /** Identification error rate in the last 1 h (0–1), null if no feedback yet */
    errorRateH1: number | null;
    /** Current reels queue depth (pending jobs) */
    reelsQueueDepth: number;
  };
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const now = new Date();
  const uptimeSeconds = Math.floor(process.uptime());

  // --- Postgres ping with timing ---
  let postgresComponent: HealthCheckComponent;
  let postgresOk = false;
  try {
    const pgStart = Date.now();
    await getPostgresPool().query('SELECT 1');
    const pgMs = Date.now() - pgStart;
    postgresOk = true;
    postgresComponent = {
      status: pgMs > 2000 ? 'degraded' : 'ok',
      responseTimeMs: pgMs,
      detail: pgMs > 2000 ? 'slow response' : undefined,
    };
  } catch (e) {
    postgresComponent = {
      status: 'error',
      detail: (e as Error).message.slice(0, 120),
    };
  }

  // --- Reels queue depth ---
  const reelsQueueDepth = getReelsQueueDepth();
  const reelsQueueComponent: HealthCheckComponent = {
    status: reelsQueueDepth > 20 ? 'degraded' : 'ok',
    detail: reelsQueueDepth > 20 ? `${reelsQueueDepth} jobs pending` : undefined,
  };

  // --- Key metrics (best-effort; fall back to 0 on error) ---
  let dau = 0;
  let totalUsers = 0;
  let searchH24: SearchRequestTriple = { ...EMPTY_SEARCH_TRIPLE };
  let errorRateH24: number | null = null;
  let errorRateH1: number | null = null;

  if (postgresOk) {
    try {
      const aud = await getAudienceStats();
      dau = aud.dau;
      totalUsers = aud.totalUsers;
    } catch { /* ignore */ }

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      searchH24 = await searchRequestCountsSince(nowSec - 86400);
    } catch { /* ignore */ }

    // Error rate: wrong / (correct + wrong) for last 24 h and last 1 h
    try {
      const pool = getPostgresPool();
      const [r24, r1] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true)::int  AS ok,
            COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false)::int AS bad
          FROM analytics_events
          WHERE event_type = 'identification_feedback'
            AND created_at >= NOW() - INTERVAL '24 hours'
        `),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true)::int  AS ok,
            COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false)::int AS bad
          FROM analytics_events
          WHERE event_type = 'identification_feedback'
            AND created_at >= NOW() - INTERVAL '1 hour'
        `),
      ]);
      const ok24 = Number(r24.rows[0]?.ok ?? 0);
      const bad24 = Number(r24.rows[0]?.bad ?? 0);
      const total24 = ok24 + bad24;
      errorRateH24 = total24 > 0 ? Math.round((bad24 / total24) * 1000) / 1000 : null;

      const ok1 = Number(r1.rows[0]?.ok ?? 0);
      const bad1 = Number(r1.rows[0]?.bad ?? 0);
      const total1 = ok1 + bad1;
      errorRateH1 = total1 > 0 ? Math.round((bad1 / total1) * 1000) / 1000 : null;
    } catch { /* ignore */ }
  }

  // --- Overall status ---
  let overallStatus: HealthStatus['status'] = 'ok';
  if (postgresComponent.status === 'error') {
    overallStatus = 'error';
  } else if (
    postgresComponent.status === 'degraded' ||
    reelsQueueComponent.status === 'degraded'
  ) {
    overallStatus = 'degraded';
  }

  return {
    status: overallStatus,
    timestamp: now.toISOString(),
    uptimeSeconds,
    components: {
      postgres: postgresComponent,
      reelsQueue: reelsQueueComponent,
    },
    metrics: {
      dau,
      totalUsers,
      searchRequestsH24: searchH24,
      errorRateH24,
      errorRateH1,
      reelsQueueDepth,
    },
  };
}

export interface DayPoint {
  label: string;
  value: number;
}

export interface FilmRow {
  title: string;
  hits: number;
}

export interface FeedbackSourceBreakdown {
  yes: number;
  no: number;
}

export interface FeedbackEventRow {
  id: string;
  createdAt: string;
  telegramUserId: number;
  /** users jadvalidan (bor bo‘lsa) */
  userFirstName: string | null;
  userUsername: string | null;
  correct: boolean;
  source: string;
  predictedTitle: string;
  predictedUzTitle: string | null;
  photoFileId: string | null;
  /** Fikr bosilganda saqlangan kichik JPEG (base64) — Telegram getFile siz */
  dashboardThumbB64: string | null;
  tmdbId: number | null;
  /** Faqat matn qidiruvi: foydalanuvchi matni */
  userQueryText: string | null;
  /** Faqat matn qidiruvi: bot javobi (qisqa) */
  botReplyPreview: string | null;
}

/** 30 kun: “Ha” / “Yo‘q” ichida rasm · matn · reels ulushi (tahlil) */
export interface FeedbackSourceSplit30d {
  ha: { photo: number; text: number; reels: number };
  yoq: { photo: number; text: number; reels: number };
  haPct: { photo: number; text: number; reels: number } | null;
  yoqPct: { photo: number; text: number; reels: number } | null;
}

/** Haqiqiy qidiruvlar: matn / screenshot / reels (search_requests jadvali) */
export interface SearchRequestTriple {
  text: number;
  photo: number;
  reels: number;
}

export interface SearchRequestDayRow {
  label: string;
  text: number;
  photo: number;
  reels: number;
}

/** Dashboard: foydalanuvchi bo‘yicha so‘rovlar va Ha/Yo‘q (asosan 30 kun) */
export interface UserActivityRow {
  telegramUserId: number;
  userFirstName: string | null;
  userUsername: string | null;
  /** users.request_count — matn qidiruvlari (jami, botdan boshlab) */
  textRequestsTotal: number;
  photoRequests30d: number;
  reelsRequests30d: number;
  /** identification_feedback — oxirgi 30 kun */
  feedbackHa30d: number;
  feedbackYoq30d: number;
  feedbackTotal30d: number;
}

export interface DashboardPayload {
  users: number;
  usersStarted: number;
  dau: number;
  wau: number;
  mau: number;
  photoTotal: number;
  reelsTotal: number;
  textSum: number;
  photoByDay: DayPoint[];
  topFilms: FilmRow[];
  postgresOk: boolean;
  analyticsByDay: DayPoint[];
  /** Oxirgi 30 kun — dashboard grafiklari bilan mos */
  feedbackCorrect: number;
  feedbackWrong: number;
  feedbackTotal: number;
  /** Barcha vaqt — Telegram /stats bilan mos */
  feedbackCorrectAll: number;
  feedbackWrongAll: number;
  feedbackTotalAll: number;
  feedbackBySource30d: Record<string, FeedbackSourceBreakdown>;
  /** SUM(request_count) / COUNT(users) */
  avgTextRequestsPerUser: number;
  /** Screenshot yuborgan noyob userlar bo‘yicha o‘rtacha */
  avgScreenshotsPerPhotoUser: number | null;
  /** 30 kunda kamida bitta feedback bergan userlar soni */
  distinctFeedbackUsers30d: number;
  /** photo / text / reels manbasi bo‘yicha noyob userlar (30 kun) */
  photoFeedbackUsers30d: number;
  textFeedbackUsers30d: number;
  reelsFeedbackUsers30d: number;
  /** 30 kun — Ha va Yo‘q ichida manba foizlari (rasm/matn/reels) */
  feedbackSourceSplit30d: FeedbackSourceSplit30d;
  /** Faol foydalanuvchilar (so‘rov yoki feedback bo‘yicha) — tahlil uchun */
  userActivityTop: UserActivityRow[];
  /** Asosiy sahifada “nima so‘radi / nima chiqdi” — oxirgi hodisalar */
  recentFeedbackPreview: FeedbackEventRow[];
  /** Har bir urinish (matn/rasm/reels) — grounding byudjet va h.k. uchun */
  searchRequests: {
    h24: SearchRequestTriple;
    d7: SearchRequestTriple;
    d30: SearchRequestTriple;
  };
  /** So‘nggi 14 kun — kunlik, manba bo‘yicha */
  searchRequestsByDay14: SearchRequestDayRow[];
}

const EMPTY_SEARCH_TRIPLE: SearchRequestTriple = { text: 0, photo: 0, reels: 0 };

async function searchRequestCountsSince(sinceEpoch: number): Promise<SearchRequestTriple> {
  try {
    const r = await getPostgresPool().query(
      `SELECT source, COUNT(*)::int AS c FROM search_requests WHERE created_at >= $1 GROUP BY source`,
      [sinceEpoch]
    );
    const out: SearchRequestTriple = { ...EMPTY_SEARCH_TRIPLE };
    for (const row of r.rows as { source: string; c: number }[]) {
      const c = Number(row.c ?? 0);
      if (row.source === 'text') out.text = c;
      else if (row.source === 'photo') out.photo = c;
      else if (row.source === 'reels') out.reels = c;
    }
    return out;
  } catch {
    return { ...EMPTY_SEARCH_TRIPLE };
  }
}

async function loadSearchRequestsByDay14(): Promise<SearchRequestDayRow[]> {
  try {
    const pool = getPostgresPool();
    const now = Math.floor(Date.now() / 1000);
    const since = now - 14 * 86400;
    const r = await pool.query(
      `
      SELECT
        to_char(to_timestamp(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
        source,
        COUNT(*)::int AS c
      FROM search_requests
      WHERE created_at >= $1
      GROUP BY d, source
      ORDER BY d
      `,
      [since]
    );
    const byDay = new Map<string, { text: number; photo: number; reels: number }>();
    for (const row of r.rows as { d: string; source: string; c: number }[]) {
      const key = String(row.d).slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, { text: 0, photo: 0, reels: 0 });
      const cell = byDay.get(key)!;
      const c = Number(row.c ?? 0);
      if (row.source === 'text') cell.text = c;
      else if (row.source === 'photo') cell.photo = c;
      else if (row.source === 'reels') cell.reels = c;
    }
    const out: SearchRequestDayRow[] = [];
    for (let i = 13; i >= 0; i--) {
      const dt = new Date();
      dt.setUTCHours(0, 0, 0, 0);
      dt.setUTCDate(dt.getUTCDate() - i);
      const label = dt.toISOString().slice(0, 10);
      const v = byDay.get(label) ?? { text: 0, photo: 0, reels: 0 };
      out.push({ label, ...v });
    }
    return out;
  } catch {
    return [];
  }
}

async function photoByDayLast14(): Promise<DayPoint[]> {
  try {
    const r = await getPostgresPool().query(`
      SELECT to_char(to_timestamp(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, COUNT(*)::int AS c
      FROM photo_requests
      WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint - 14 * 86400
      GROUP BY d
      ORDER BY d
    `);
    return r.rows.map((row: { d: string; c: number }) => ({ label: row.d, value: row.c }));
  } catch {
    return [];
  }
}

async function analyticsByDayPostgres(): Promise<DayPoint[]> {
  try {
    const r = await getPostgresPool().query(
      `
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, COUNT(*)::int AS c
      FROM analytics_events
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY d
      ORDER BY d
    `
    );
    return r.rows.map((row: { d: string; c: number }) => ({
      label: row.d,
      value: row.c,
    }));
  } catch {
    return [];
  }
}

async function feedbackStatsPostgres(): Promise<{ correct: number; wrong: number }> {
  try {
    const r = await getPostgresPool().query(`
      SELECT
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true) AS c_ok,
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false) AS c_bad
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at >= NOW() - INTERVAL '30 days'
    `);
    return {
      correct: Number(r.rows[0]?.c_ok ?? 0),
      wrong: Number(r.rows[0]?.c_bad ?? 0),
    };
  } catch {
    return { correct: 0, wrong: 0 };
  }
}

async function feedbackStatsAllTime(): Promise<{ correct: number; wrong: number }> {
  try {
    const r = await getPostgresPool().query(`
      SELECT
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true) AS c_ok,
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false) AS c_bad
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
    `);
    return {
      correct: Number(r.rows[0]?.c_ok ?? 0),
      wrong: Number(r.rows[0]?.c_bad ?? 0),
    };
  } catch {
    return { correct: 0, wrong: 0 };
  }
}

async function feedbackBySource30d(): Promise<Record<string, FeedbackSourceBreakdown>> {
  const out: Record<string, FeedbackSourceBreakdown> = {};
  try {
    const r = await getPostgresPool().query(`
      SELECT
        COALESCE(metadata->>'source', 'unknown') AS src,
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true)::int AS y,
        COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false)::int AS n
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY COALESCE(metadata->>'source', 'unknown')
    `);
    for (const row of r.rows as { src: string; y: number; n: number }[]) {
      out[row.src] = { yes: row.y, no: row.n };
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function distinctFeedbackUsers30d(): Promise<number> {
  try {
    const r = await getPostgresPool().query(`
      SELECT COUNT(DISTINCT (metadata->>'telegram_user_id'))::int AS c
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND metadata ? 'telegram_user_id'
    `);
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function feedbackUsersBySource30d(): Promise<{ photo: number; text: number; reels: number }> {
  const pool = getPostgresPool();
  const q = (src: string) =>
    pool.query(
      `
      SELECT COUNT(DISTINCT (metadata->>'telegram_user_id'))::int AS c
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND metadata->>'source' = $1
        AND metadata ? 'telegram_user_id'
    `,
      [src]
    );
  try {
    const [p, t, r] = await Promise.all([q('photo'), q('text'), q('reels')]);
    return {
      photo: Number(p.rows[0]?.c ?? 0),
      text: Number(t.rows[0]?.c ?? 0),
      reels: Number(r.rows[0]?.c ?? 0),
    };
  } catch {
    return { photo: 0, text: 0, reels: 0 };
  }
}

const SEC_30D = 30 * 86400;

async function loadUserActivityTop(limit: number): Promise<UserActivityRow[]> {
  const lim = Math.min(Math.max(1, limit), 80);
  try {
    const r = await getPostgresPool().query(
      `
      WITH fb AS (
        SELECT
          (metadata->>'telegram_user_id')::bigint AS uid,
          COUNT(*)::int AS fb_total,
          COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = true)::int AS y,
          COUNT(*) FILTER (WHERE (metadata->>'correct')::boolean = false)::int AS n
        FROM analytics_events
        WHERE event_type = 'identification_feedback'
          AND created_at >= NOW() - INTERVAL '30 days'
          AND metadata ? 'telegram_user_id'
          AND (metadata->>'telegram_user_id') ~ '^[0-9]+$'
        GROUP BY 1
      ),
      ph AS (
        SELECT telegram_id, COUNT(*)::int AS c
        FROM photo_requests
        WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint - $1
        GROUP BY telegram_id
      ),
      rl AS (
        SELECT telegram_id, COUNT(*)::int AS c
        FROM reels_requests
        WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint - $1
        GROUP BY telegram_id
      )
      SELECT
        u.telegram_id,
        u.first_name,
        u.username,
        COALESCE(u.request_count, 0)::int AS text_req,
        COALESCE(ph.c, 0)::int AS photo_30,
        COALESCE(rl.c, 0)::int AS reels_30,
        COALESCE(fb.y, 0)::int AS ha,
        COALESCE(fb.n, 0)::int AS yoq,
        COALESCE(fb.fb_total, 0)::int AS fb_tot
      FROM users u
      LEFT JOIN fb ON fb.uid = u.telegram_id
      LEFT JOIN ph ON ph.telegram_id = u.telegram_id
      LEFT JOIN rl ON rl.telegram_id = u.telegram_id
      WHERE COALESCE(fb.fb_total, 0) > 0
         OR COALESCE(ph.c, 0) > 0
         OR COALESCE(rl.c, 0) > 0
         OR COALESCE(u.request_count, 0) > 0
      ORDER BY
        (COALESCE(fb.fb_total, 0) + COALESCE(ph.c, 0) + COALESCE(rl.c, 0) + COALESCE(u.request_count, 0)) DESC,
        u.telegram_id DESC
      LIMIT $2
    `,
      [SEC_30D, lim]
    );
    return (r.rows as Record<string, unknown>[]).map((row) => {
      const tid = Number(row.telegram_id);
      const fn =
        row.first_name != null && String(row.first_name).trim() !== ''
          ? String(row.first_name).trim()
          : null;
      const un =
        row.username != null && String(row.username).trim() !== ''
          ? String(row.username).trim()
          : null;
      return {
        telegramUserId: Number.isFinite(tid) ? tid : 0,
        userFirstName: fn,
        userUsername: un,
        textRequestsTotal: Number(row.text_req ?? 0),
        photoRequests30d: Number(row.photo_30 ?? 0),
        reelsRequests30d: Number(row.reels_30 ?? 0),
        feedbackHa30d: Number(row.ha ?? 0),
        feedbackYoq30d: Number(row.yoq ?? 0),
        feedbackTotal30d: Number(row.fb_tot ?? 0),
      };
    });
  } catch {
    return [];
  }
}

async function loadFeedbackSourceSplit30d(): Promise<FeedbackSourceSplit30d> {
  const empty: FeedbackSourceSplit30d = {
    ha: { photo: 0, text: 0, reels: 0 },
    yoq: { photo: 0, text: 0, reels: 0 },
    haPct: null,
    yoqPct: null,
  };
  try {
    const r = await getPostgresPool().query(`
      SELECT
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = true AND metadata->>'source' = 'photo'
        )::int AS ha_photo,
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = true AND metadata->>'source' = 'text'
        )::int AS ha_text,
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = true AND metadata->>'source' = 'reels'
        )::int AS ha_reels,
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = false AND metadata->>'source' = 'photo'
        )::int AS yq_photo,
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = false AND metadata->>'source' = 'text'
        )::int AS yq_text,
        COUNT(*) FILTER (
          WHERE (metadata->>'correct')::boolean = false AND metadata->>'source' = 'reels'
        )::int AS yq_reels
      FROM analytics_events
      WHERE event_type = 'identification_feedback'
        AND created_at >= NOW() - INTERVAL '30 days'
    `);
    const row = r.rows[0] as Record<string, number>;
    const ha = {
      photo: Number(row.ha_photo ?? 0),
      text: Number(row.ha_text ?? 0),
      reels: Number(row.ha_reels ?? 0),
    };
    const yoq = {
      photo: Number(row.yq_photo ?? 0),
      text: Number(row.yq_text ?? 0),
      reels: Number(row.yq_reels ?? 0),
    };
    const pct = (n: number, t: number) => (t > 0 ? Math.round((100 * n) / t) : 0);
    const haTot = ha.photo + ha.text + ha.reels;
    const yoqTot = yoq.photo + yoq.text + yoq.reels;
    return {
      ha,
      yoq,
      haPct:
        haTot > 0
          ? { photo: pct(ha.photo, haTot), text: pct(ha.text, haTot), reels: pct(ha.reels, haTot) }
          : null,
      yoqPct:
        yoqTot > 0
          ? { photo: pct(yoq.photo, yoqTot), text: pct(yoq.text, yoqTot), reels: pct(yoq.reels, yoqTot) }
          : null,
    };
  } catch {
    return empty;
  }
}

export interface FeedbackEventsPage {
  items: FeedbackEventRow[];
  total: number;
  limit: number;
  offset: number;
  days: number;
  /** Qo‘llangan filtrlar (UI) */
  filters: { source: string | null; vote: string | null };
}

export async function loadFeedbackEventsPage(
  limit: number,
  offset: number,
  days: number,
  filters?: { source?: string; vote?: string }
): Promise<FeedbackEventsPage> {
  const pool = getPostgresPool();
  const lim = Math.min(Math.max(1, limit), 200);
  const off = Math.max(0, offset);
  const d = Math.min(Math.max(1, days), 365);

  let srcPg: string | null = null;
  const s = filters?.source?.trim();
  if (s === 'photo' || s === 'text' || s === 'reels') srcPg = s;

  let corrPg: string | null = null;
  const v = filters?.vote?.trim().toLowerCase();
  if (v === 'yes' || v === 'ha') corrPg = 'true';
  else if (v === 'no' || v === 'yoq') corrPg = 'false';

  const [countR, rowsR] = await Promise.all([
    pool.query(
      `
      SELECT COUNT(*)::int AS c
      FROM analytics_events ae
      WHERE ae.event_type = 'identification_feedback'
        AND ae.created_at >= NOW() - ($1::integer * INTERVAL '1 day')
        AND ($2::text IS NULL OR ae.metadata->>'source' = $2)
        AND ($3::text IS NULL OR ae.metadata->>'correct' = $3)
    `,
      [d, srcPg, corrPg]
    ),
    pool.query(
      `
      SELECT
        ae.id::text AS id,
        ae.created_at,
        (ae.metadata->>'telegram_user_id') AS uid,
        (ae.metadata->>'correct') AS corr,
        COALESCE(ae.metadata->>'source', '') AS src,
        COALESCE(ae.metadata->>'predicted_title', '') AS pred_title,
        ae.metadata->>'predicted_uz_title' AS pred_uz,
        ae.metadata->>'photo_file_id' AS photo_id,
        ae.metadata->>'dashboard_thumb_b64' AS thumb_b64,
        ae.metadata->>'user_query_text' AS user_q,
        ae.metadata->>'bot_reply_preview' AS bot_prev,
        NULLIF(TRIM(ae.metadata->>'tmdb_id'), '') AS tmdb_raw,
        u.first_name AS u_first_name,
        u.username AS u_username
      FROM analytics_events ae
      LEFT JOIN users u ON (
        (ae.metadata->>'telegram_user_id') ~ '^[0-9]+$'
        AND u.telegram_id = (ae.metadata->>'telegram_user_id')::bigint
      )
      WHERE ae.event_type = 'identification_feedback'
        AND ae.created_at >= NOW() - ($3::integer * INTERVAL '1 day')
        AND ($4::text IS NULL OR ae.metadata->>'source' = $4)
        AND ($5::text IS NULL OR ae.metadata->>'correct' = $5)
      ORDER BY ae.created_at DESC
      LIMIT $1 OFFSET $2
    `,
      [lim, off, d, srcPg, corrPg]
    ),
  ]);

  const total = Number(countR.rows[0]?.c ?? 0);
  const items: FeedbackEventRow[] = (rowsR.rows as Record<string, unknown>[]).map((row) => {
    const uid = Number(row.uid);
    const corr = String(row.corr) === 'true';
    let tmdbId: number | null = null;
    if (row.tmdb_raw != null && String(row.tmdb_raw) !== '') {
      const n = parseInt(String(row.tmdb_raw), 10);
      tmdbId = Number.isFinite(n) ? n : null;
    }
    const created = row.created_at as Date;
    const fn = row.u_first_name != null && String(row.u_first_name).trim() !== '' ? String(row.u_first_name).trim() : null;
    const un = row.u_username != null && String(row.u_username).trim() !== '' ? String(row.u_username).trim() : null;

    return {
      id: String(row.id),
      createdAt: created.toISOString(),
      telegramUserId: Number.isFinite(uid) ? uid : 0,
      userFirstName: fn,
      userUsername: un,
      correct: corr,
      source: String(row.src || 'unknown'),
      predictedTitle: String(row.pred_title || '—'),
      predictedUzTitle: row.pred_uz != null && String(row.pred_uz) !== '' ? String(row.pred_uz) : null,
      photoFileId:
        row.photo_id != null && String(row.photo_id).trim() !== '' ? String(row.photo_id).trim() : null,
      dashboardThumbB64:
        row.thumb_b64 != null && String(row.thumb_b64).length > 0 ? String(row.thumb_b64) : null,
      tmdbId,
      userQueryText:
        row.user_q != null && String(row.user_q).trim() !== '' ? String(row.user_q) : null,
      botReplyPreview:
        row.bot_prev != null && String(row.bot_prev).trim() !== '' ? String(row.bot_prev) : null,
    };
  });

  return {
    items,
    total,
    limit: lim,
    offset: off,
    days: d,
    filters: {
      source: srcPg,
      vote: corrPg === 'true' ? 'yes' : corrPg === 'false' ? 'no' : null,
    },
  };
}

export async function loadDashboardPayload(): Promise<DashboardPayload> {
  const pool = getPostgresPool();
  const aud = await getAudienceStats();

  const photoRow = await pool.query(`SELECT COUNT(*)::int AS c FROM photo_requests`);
  const reelsRow = await pool.query(`SELECT COUNT(*)::int AS c FROM reels_requests`);
  const textRow = await pool.query(`SELECT COALESCE(SUM(request_count), 0)::bigint AS s FROM users`);
  const userCountRow = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
  const distinctPhotoUsersRow = await pool.query(`
    SELECT COUNT(DISTINCT telegram_id)::int AS c FROM photo_requests
  `);

  const topFilms = (
    await pool.query(`SELECT title, hit_count AS hits FROM movie_cache ORDER BY hit_count DESC LIMIT 10`)
  ).rows as FilmRow[];

  let postgresOk = false;
  try {
    await pool.query('SELECT 1');
    postgresOk = true;
  } catch {
    postgresOk = false;
  }

  const analyticsByDay = await analyticsByDayPostgres();
  const fb = await feedbackStatsPostgres();
  const fbAll = await feedbackStatsAllTime();
  const feedbackTotal = fb.correct + fb.wrong;
  const feedbackTotalAll = fbAll.correct + fbAll.wrong;
  const photoByDay = await photoByDayLast14();
  const bySrc = await feedbackBySource30d();
  const fbUsers = await distinctFeedbackUsers30d();
  const fbBySrcUsers = await feedbackUsersBySource30d();
  const fbSplit = await loadFeedbackSourceSplit30d();
  const userActivityTop = await loadUserActivityTop(45);
  let recentFeedbackPreview: FeedbackEventRow[] = [];
  try {
    recentFeedbackPreview = (await loadFeedbackEventsPage(12, 0, 30)).items;
  } catch {
    recentFeedbackPreview = [];
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const [srH24, srD7, srD30, searchRequestsByDay14] = await Promise.all([
    searchRequestCountsSince(nowSec - 86400),
    searchRequestCountsSince(nowSec - 7 * 86400),
    searchRequestCountsSince(nowSec - 30 * 86400),
    loadSearchRequestsByDay14(),
  ]);

  const userCount = Number(userCountRow.rows[0]?.c ?? 0);
  const textSum = Number(textRow.rows[0]?.s ?? 0);
  const avgText = userCount > 0 ? Math.round((textSum / userCount) * 100) / 100 : 0;

  const photoTotal = Number(photoRow.rows[0]?.c ?? 0);
  const distinctPhotoUsers = Number(distinctPhotoUsersRow.rows[0]?.c ?? 0);
  const avgPhoto =
    distinctPhotoUsers > 0 ? Math.round((photoTotal / distinctPhotoUsers) * 100) / 100 : null;

  return {
    users: aud.totalUsers,
    usersStarted: aud.usersStarted,
    dau: aud.dau,
    wau: aud.wau,
    mau: aud.mau,
    photoTotal,
    reelsTotal: Number(reelsRow.rows[0]?.c ?? 0),
    textSum,
    photoByDay,
    topFilms,
    postgresOk,
    analyticsByDay,
    feedbackCorrect: fb.correct,
    feedbackWrong: fb.wrong,
    feedbackTotal,
    feedbackCorrectAll: fbAll.correct,
    feedbackWrongAll: fbAll.wrong,
    feedbackTotalAll,
    feedbackBySource30d: bySrc,
    avgTextRequestsPerUser: avgText,
    avgScreenshotsPerPhotoUser: avgPhoto,
    distinctFeedbackUsers30d: fbUsers,
    photoFeedbackUsers30d: fbBySrcUsers.photo,
    textFeedbackUsers30d: fbBySrcUsers.text,
    reelsFeedbackUsers30d: fbBySrcUsers.reels,
    feedbackSourceSplit30d: fbSplit,
    userActivityTop,
    recentFeedbackPreview,
    searchRequests: { h24: srH24, d7: srD7, d30: srD30 },
    searchRequestsByDay14,
  };
}
