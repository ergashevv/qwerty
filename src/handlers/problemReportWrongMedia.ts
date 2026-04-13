import { Context } from 'grammy';
import { getUserLocale } from '../db';
import { getProblemReportPending } from '../db/feedbackProblemReport';
import { feedbackT } from '../i18n/feedbackStrings';

/** Shikoyat rejimida matn/rasmdan boshqa tur yuborilganda */
export async function handleProblemReportUnsupportedMedia(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;
  if (!(await getProblemReportPending(uid))) return;
  const loc = await getUserLocale(uid);
  await ctx.reply(feedbackT(loc).wrongMedia, { parse_mode: 'HTML' });
}
