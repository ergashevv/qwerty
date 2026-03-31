import { Context } from 'grammy';
import { upsertUser, recordUserActivityDay } from '../db';
import { insertAnalyticsEvent } from '../db/postgres';
import {
  clearProblemReportPending,
  FREE_COMPLAINT_SENTINEL,
  getProblemReportPending,
  insertIdentificationProblemReport,
  resetFeedbackNoStreak,
} from '../db/feedbackProblemReport';
import {
  PROBLEM_REPORT_REJECT_COMMAND_HTML,
  PROBLEM_REPORT_REJECT_NUMBERS_ONLY_HTML,
  PROBLEM_REPORT_REJECT_TOO_SHORT_HTML,
  PROBLEM_REPORT_REJECT_URL_HTML,
} from '../messages/feedback';
import { feedbackModeReplyMarkup } from './feedbackModeBack';
import { safeReply } from '../utils/safeTelegram';

const MAX_BODY = 4000;

export type ProblemReportSubmitResult = 'none' | 'saved' | 'invalid' | 'error';

/**
 * Havola, buyruq yoki noto‘g‘ri format — shikoyat sifatida saqlanmaydi, foydalanuvchiga yo‘l-yo‘riq beriladi.
 */
export function validateProblemReportBody(bodyText: string): { ok: true } | { ok: false; html: string } {
  const t = bodyText.trim();
  if (t.length < 6) {
    return { ok: false, html: PROBLEM_REPORT_REJECT_TOO_SHORT_HTML };
  }
  if (/https?:\/\/|www\.instagram\.com|instagram\.com\/|youtu\.be|youtube\.com\/|tiktok\.com|t\.me\//i.test(t)) {
    return { ok: false, html: PROBLEM_REPORT_REJECT_URL_HTML };
  }
  if (/^\s*\/[A-Za-z][A-Za-z0-9_]*\s*$/.test(t)) {
    return { ok: false, html: PROBLEM_REPORT_REJECT_COMMAND_HTML };
  }
  const digitsOnly = t.replace(/\s/g, '');
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length <= 8) {
    return { ok: false, html: PROBLEM_REPORT_REJECT_NUMBERS_ONLY_HTML };
  }
  return { ok: true };
}

/**
 * Agar foydalanuvchi shikoyat matni kutilayotgan bo‘lsa — yozuvni saqlaydi.
 * @returns `none` — navbat yo‘q; `saved` — saqlandi; `invalid` — format noto‘g‘ri, navbat saqlanadi.
 */
export async function tryCompleteProblemReport(
  ctx: Context,
  userId: number,
  bodyText: string,
  options?: { photoFileId?: string }
): Promise<ProblemReportSubmitResult> {
  const problemReportCtx = await getProblemReportPending(userId);
  if (!problemReportCtx) return 'none';

  const check = validateProblemReportBody(bodyText);
  if (!check.ok) {
    await safeReply(ctx, check.html, {
      parse_mode: 'HTML',
      reply_markup: feedbackModeReplyMarkup(),
    });
    return 'invalid';
  }

  await Promise.all([
    upsertUser(userId, ctx.from?.username, ctx.from?.first_name),
    recordUserActivityDay(userId),
  ]);

  try {
    const reportId = await insertIdentificationProblemReport(
      userId,
      bodyText.slice(0, MAX_BODY),
      problemReportCtx,
      options?.photoFileId
    );
    await clearProblemReportPending(userId);
    await resetFeedbackNoStreak(userId);
    const freeComplaint = problemReportCtx.predictedTitle === FREE_COMPLAINT_SENTINEL;
    await insertAnalyticsEvent('identification_problem_report', {
      report_id: reportId,
      telegram_user_id: userId,
      predicted_title: freeComplaint ? null : problemReportCtx.predictedTitle,
      predicted_uz_title: freeComplaint ? null : problemReportCtx.predictedUzTitle,
      source: problemReportCtx.source,
      body_preview: bodyText.slice(0, 500),
      ...(freeComplaint ? { complaint_kind: 'free_text' } : {}),
    });
    await ctx.reply(
      'Rahmat! Yozganingiz qabul qilindi — jamoamiz xabarni ko‘rib chiqadi. Yangi qidiruvni davom ettirishingiz mumkin.',
      { link_preview_options: { is_disabled: true } }
    );
    return 'saved';
  } catch (e) {
    console.error('identification_problem_report:', e);
    await safeReply(
      ctx,
      '❌ Hozir yozuvni saqlab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring yoki /help orqali yordam oling.'
    );
    return 'error';
  }
}
