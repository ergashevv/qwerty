import { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  clearProblemReportPending,
  getProblemReportPending,
  resetFeedbackNoStreak,
} from '../db/feedbackProblemReport';
import { feedbackT } from '../i18n/feedbackStrings';
import type { BotLocale } from '../i18n/locale';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { getUserLocale } from '../db';

/** Shikoyat yozish rejimidan chiqish (xuddi /cancel) */
export const FEEDBACK_BACK_CALLBACK = 'fbc:back';

export function feedbackModeReplyMarkup(locale: BotLocale = DEFAULT_LOCALE): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: feedbackT(locale).feedbackBack, callback_data: FEEDBACK_BACK_CALLBACK }]],
  };
}

export async function handleFeedbackModeBack(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;

  await ctx.answerCallbackQuery();

  const locale = await getUserLocale(uid);
  const fb = feedbackT(locale);

  const pending = await getProblemReportPending(uid);
  if (!pending) {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* ignore */
    }
    await ctx.reply(fb.feedbackNoMode);
    return;
  }

  await clearProblemReportPending(uid);
  await resetFeedbackNoStreak(uid);

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }

  await ctx.reply(fb.cancelOk, { parse_mode: 'HTML' });
}
