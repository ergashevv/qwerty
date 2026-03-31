import { getPostgresPool } from './postgres';

export type FeedbackSource = 'photo' | 'text' | 'reels';

/** `/feedback` dan kelgan umumiy shikoyat — DB ga NULL sifatida yoziladi */
export const FREE_COMPLAINT_SENTINEL = '(umumiy shikoyat)';

export interface ProblemReportPendingContext {
  predictedTitle: string;
  predictedUzTitle: string | null;
  source: FeedbackSource;
}

/** Ketma-ket «Yo‘q» bosishlari (Ha bosilganda 0 ga qaytadi). */
export async function incrementFeedbackNoStreak(telegramId: number): Promise<number> {
  const r = await getPostgresPool().query(
    `UPDATE users SET feedback_no_streak = feedback_no_streak + 1 WHERE telegram_id = $1 RETURNING feedback_no_streak`,
    [telegramId]
  );
  return Number(r.rows[0]?.feedback_no_streak ?? 1);
}

export async function resetFeedbackNoStreak(telegramId: number): Promise<void> {
  await getPostgresPool().query(`UPDATE users SET feedback_no_streak = 0 WHERE telegram_id = $1`, [telegramId]);
}

/** Foydalanuvchi `/feedback` bosganda — keyingi matn shikoyat sifatida saqlanadi (film natijasiga bog‘lanmagan). */
export async function setFreeComplaintPending(telegramId: number): Promise<void> {
  await setProblemReportPending(telegramId, {
    predictedTitle: FREE_COMPLAINT_SENTINEL,
    predictedUzTitle: null,
    source: 'text',
  });
}

export async function setProblemReportPending(
  telegramId: number,
  ctx: ProblemReportPendingContext
): Promise<void> {
  await getPostgresPool().query(
    `
    INSERT INTO identification_problem_report_pending (telegram_id, predicted_title, predicted_uz_title, source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_id) DO UPDATE SET
      predicted_title = EXCLUDED.predicted_title,
      predicted_uz_title = EXCLUDED.predicted_uz_title,
      source = EXCLUDED.source,
      created_at = NOW()
    `,
    [telegramId, ctx.predictedTitle, ctx.predictedUzTitle, ctx.source]
  );
}

export async function getProblemReportPending(
  telegramId: number
): Promise<ProblemReportPendingContext | null> {
  const r = await getPostgresPool().query(
    `SELECT predicted_title, predicted_uz_title, source FROM identification_problem_report_pending WHERE telegram_id = $1`,
    [telegramId]
  );
  const row = r.rows[0] as
    | { predicted_title: string | null; predicted_uz_title: string | null; source: string }
    | undefined;
  if (!row) return null;
  const src = row.source;
  if (src !== 'photo' && src !== 'text' && src !== 'reels') return null;
  return {
    predictedTitle: row.predicted_title ?? '',
    predictedUzTitle: row.predicted_uz_title,
    source: src,
  };
}

export async function clearProblemReportPending(telegramId: number): Promise<void> {
  await getPostgresPool().query(`DELETE FROM identification_problem_report_pending WHERE telegram_id = $1`, [
    telegramId,
  ]);
}

export async function insertIdentificationProblemReport(
  telegramUserId: number,
  bodyText: string,
  ctx: ProblemReportPendingContext | null,
  photoFileId?: string | null
): Promise<number> {
  const predTitle =
    ctx?.predictedTitle === FREE_COMPLAINT_SENTINEL ? null : (ctx?.predictedTitle ?? null);
  const predUz = ctx?.predictedTitle === FREE_COMPLAINT_SENTINEL ? null : (ctx?.predictedUzTitle ?? null);
  const fileId =
    photoFileId?.trim() && ctx?.source === 'photo' ? photoFileId.trim() : null;
  const r = await getPostgresPool().query(
    `
    INSERT INTO identification_problem_reports (telegram_user_id, body_text, predicted_title, predicted_uz_title, source, photo_file_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
    `,
    [telegramUserId, bodyText, predTitle, predUz, ctx?.source ?? null, fileId]
  );
  return Number(r.rows[0]?.id ?? 0);
}
