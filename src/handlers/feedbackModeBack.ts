import { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  clearProblemReportPending,
  getProblemReportPending,
  resetFeedbackNoStreak,
} from '../db/feedbackProblemReport';
import { FEEDBACK_CANCEL_OK_HTML } from '../messages/feedback';

/** Shikoyat yozish rejimidan chiqish (xuddi /cancel) */
export const FEEDBACK_BACK_CALLBACK = 'fbc:back';

export function feedbackModeReplyMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '◀️ Ortga', callback_data: FEEDBACK_BACK_CALLBACK }]],
  };
}

export async function handleFeedbackModeBack(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;

  await ctx.answerCallbackQuery();

  const pending = await getProblemReportPending(uid);
  if (!pending) {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {
      /* ignore */
    }
    await ctx.reply('Shikoyat rejimi yo‘q. Film qidirishingiz mumkin.');
    return;
  }

  await clearProblemReportPending(uid);
  await resetFeedbackNoStreak(uid);

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    /* ignore */
  }

  await ctx.reply(FEEDBACK_CANCEL_OK_HTML, { parse_mode: 'HTML' });
}
