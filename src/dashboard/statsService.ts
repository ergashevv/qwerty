import { getAudienceStats, getDb } from '../db';
import { getPostgresPool } from '../db/postgres';

export interface DayPoint {
  label: string;
  value: number;
}

export interface FilmRow {
  title: string;
  hits: number;
}

export interface DashboardPayload {
  /** users jadvalidagi unikal (start yoki rasm/matn) */
  users: number;
  /** Kamida bir marta /start bosgan */
  usersStarted: number;
  /** Bugungi UTC kunida faol */
  dau: number;
  /** So‘nggi 7 kun */
  wau: number;
  /** So‘nggi 30 kun */
  mau: number;
  photoTotal: number;
  textSum: number;
  photoByDay: DayPoint[];
  topFilms: FilmRow[];
  postgresOk: boolean;
  analyticsByDay: DayPoint[];
  /** Foydalanuvchi tugmasi — so‘nggi 30 kun */
  feedbackCorrect: number;
  feedbackWrong: number;
  /** Jami javob berganlar (to‘g‘ri + boshqa) */
  feedbackTotal: number;
}

/** SQLite: rasm so'rovlari kun bo'yicha (so'nggi 14 kun) */
function photoByDaySqlite(): DayPoint[] {
  try {
    const d = getDb();
    const rows = d
      .prepare(
        `
      SELECT date(created_at, 'unixepoch') AS d, COUNT(*) AS c
      FROM photo_requests
      WHERE created_at >= (strftime('%s', 'now') - 14 * 86400)
      GROUP BY d
      ORDER BY d
    `
      )
      .all() as { d: string; c: number }[];

    return rows.map((r) => ({ label: r.d, value: r.c }));
  } catch {
    return [];
  }
}

/** Postgres: analytics_events (bo'sh bo'lishi mumkin) */
async function analyticsByDayPostgres(): Promise<DayPoint[]> {
  const pool = getPostgresPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
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
  const pool = getPostgresPool();
  if (!pool) return { correct: 0, wrong: 0 };
  try {
    const r = await pool.query(`
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

export async function loadDashboardPayload(): Promise<DashboardPayload> {
  let users = 0;
  let usersStarted = 0;
  let dau = 0;
  let wau = 0;
  let mau = 0;
  let photoTotal = 0;
  let textSum = 0;
  let topFilms: FilmRow[] = [];

  try {
    const aud = getAudienceStats();
    users = aud.totalUsers;
    usersStarted = aud.usersStarted;
    dau = aud.dau;
    wau = aud.wau;
    mau = aud.mau;
    const d = getDb();
    photoTotal = (d.prepare('SELECT COUNT(*) AS c FROM photo_requests').get() as { c: number }).c;
    const ts = d.prepare('SELECT COALESCE(SUM(request_count), 0) AS s FROM users').get() as { s: number };
    textSum = ts.s;
    topFilms = d
      .prepare('SELECT title, hit_count AS hits FROM movie_cache ORDER BY hit_count DESC LIMIT 10')
      .all() as FilmRow[];
  } catch {
    /* ignore */
  }

  const photoByDay = photoByDaySqlite();
  let postgresOk = false;
  try {
    const pool = getPostgresPool();
    if (pool) {
      await pool.query('SELECT 1');
      postgresOk = true;
    }
  } catch {
    postgresOk = false;
  }

  const analyticsByDay = await analyticsByDayPostgres();
  const fb = await feedbackStatsPostgres();
  const feedbackTotal = fb.correct + fb.wrong;

  return {
    users,
    usersStarted,
    dau,
    wau,
    mau,
    photoTotal,
    textSum,
    photoByDay,
    topFilms,
    postgresOk,
    analyticsByDay,
    feedbackCorrect: fb.correct,
    feedbackWrong: fb.wrong,
    feedbackTotal,
  };
}
