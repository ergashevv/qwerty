import { Context } from 'grammy';
import { getProblemReportPending } from '../db/feedbackProblemReport';
import { FEEDBACK_WRONG_MEDIA_HTML } from '../messages/feedback';

/** Shikoyat rejimida matn/rasmdan boshqa tur yuborilganda */
export async function handleProblemReportUnsupportedMedia(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;
  if (!(await getProblemReportPending(uid))) return;
  await ctx.reply(FEEDBACK_WRONG_MEDIA_HTML, { parse_mode: 'HTML' });
}
