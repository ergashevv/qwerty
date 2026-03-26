import { getAudienceStats } from '../db';
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
  users: number;
  usersStarted: number;
  dau: number;
  wau: number;
  mau: number;
  photoTotal: number;
  textSum: number;
  photoByDay: DayPoint[];
  topFilms: FilmRow[];
  postgresOk: boolean;
  analyticsByDay: DayPoint[];
  feedbackCorrect: number;
  feedbackWrong: number;
  feedbackTotal: number;
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

export async function loadDashboardPayload(): Promise<DashboardPayload> {
  const pool = getPostgresPool();
  const aud = await getAudienceStats();

  const photoRow = await pool.query(`SELECT COUNT(*)::int AS c FROM photo_requests`);
  const textRow = await pool.query(`SELECT COALESCE(SUM(request_count), 0)::bigint AS s FROM users`);
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
  const feedbackTotal = fb.correct + fb.wrong;
  const photoByDay = await photoByDayLast14();

  return {
    users: aud.totalUsers,
    usersStarted: aud.usersStarted,
    dau: aud.dau,
    wau: aud.wau,
    mau: aud.mau,
    photoTotal: Number(photoRow.rows[0]?.c ?? 0),
    textSum: Number(textRow.rows[0]?.s ?? 0),
    photoByDay,
    topFilms,
    postgresOk,
    analyticsByDay,
    feedbackCorrect: fb.correct,
    feedbackWrong: fb.wrong,
    feedbackTotal,
  };
}
