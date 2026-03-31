import { Context } from 'grammy';
import { upsertUser, recordUserActivityDay } from '../db';
import { insertAnalyticsEvent } from '../db/postgres';
import {
  clearProblemReportPending,
  getProblemReportPending,
  insertIdentificationProblemReport,
  resetFeedbackNoStreak,
} from '../db/feedbackProblemReport';
import { safeReply } from '../utils/safeTelegram';

const MAX_BODY = 4000;

/**
 * Agar foydalanuvchi shikoyat matni kutilayotgan bo‘lsa — yozuvni saqlaydi va true qaytaradi.
 */
export async function tryCompleteProblemReport(
  ctx: Context,
  userId: number,
  bodyText: string
): Promise<boolean> {
  const problemReportCtx = await getProblemReportPending(userId);
  if (!problemReportCtx) return false;

  await Promise.all([
    upsertUser(userId, ctx.from?.username, ctx.from?.first_name),
    recordUserActivityDay(userId),
  ]);

  try {
    const reportId = await insertIdentificationProblemReport(
      userId,
      bodyText.slice(0, MAX_BODY),
      problemReportCtx
    );
    await clearProblemReportPending(userId);
    await resetFeedbackNoStreak(userId);
    await insertAnalyticsEvent('identification_problem_report', {
      report_id: reportId,
      telegram_user_id: userId,
      predicted_title: problemReportCtx.predictedTitle,
      predicted_uz_title: problemReportCtx.predictedUzTitle,
      source: problemReportCtx.source,
      body_preview: bodyText.slice(0, 500),
    });
    await ctx.reply(
      'Rahmat! Yozganingiz qabul qilindi — jamoamiz xabarni ko‘rib chiqadi. Yangi qidiruvni davom ettirishingiz mumkin.',
      { link_preview_options: { is_disabled: true } }
    );
  } catch (e) {
    console.error('identification_problem_report:', e);
    await safeReply(
      ctx,
      '❌ Hozir yozuvni saqlab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring yoki /help orqali yordam oling.'
    );
  }

  return true;
}
