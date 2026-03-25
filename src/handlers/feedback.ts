import { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { insertAnalyticsEvent } from '../db/postgres';
import { consumePendingFeedback } from '../db/feedbackPending';

const PREFIX = 'fb:';

export async function handleIdentificationFeedback(ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery;
  const data = cq?.data;
  if (!data?.startsWith(PREFIX)) return;

  const rest = data.slice(PREFIX.length);
  const colon = rest.lastIndexOf(':');
  if (colon <= 0) {
    await ctx.answerCallbackQuery({ text: 'Noto‘g‘ri format.', show_alert: true });
    return;
  }
  const keyPart = rest.slice(0, colon);
  const vote = rest.slice(colon + 1);
  if (vote !== 'y' && vote !== 'n') {
    await ctx.answerCallbackQuery({ text: 'Noto‘g‘ri tugma.', show_alert: true });
    return;
  }

  const uid = ctx.from?.id;
  if (!uid) {
    await ctx.answerCallbackQuery({ text: 'Xato.', show_alert: true });
    return;
  }

  const row = consumePendingFeedback(keyPart, uid);
  if (!row) {
    /** Ikkinchi bosish, eski xabar yoki boshqa user — ogohlantirishsiz */
    await ctx.answerCallbackQuery({ text: 'Qabul qilingan' });
    return;
  }

  const correct = vote === 'y';

  await ctx.answerCallbackQuery({
    text: correct ? 'Rahmat! ❤️' : 'Rahmat, yaxshilaymiz 🙏',
    show_alert: false,
  });

  /** Fikr tugmalarini olib tashlash; tomosha havolalari qoladi */
  const keep = row.keyboard_keep_json;
  try {
    if (keep) {
      const markup = JSON.parse(keep) as InlineKeyboardMarkup;
      await ctx.editMessageReplyMarkup({ reply_markup: markup });
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    }
  } catch {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  await insertAnalyticsEvent('identification_feedback', {
    correct,
    source: row.source,
    predicted_title: row.predicted_title,
    predicted_uz_title: row.predicted_uz_title ?? null,
    tmdb_id: row.tmdb_id ?? null,
    imdb_id: row.imdb_id ?? null,
    media_type: row.media_type ?? null,
    confidence: row.confidence ?? null,
    telegram_user_id: row.telegram_user_id,
    ...(correct ? {} : { photo_file_id: row.photo_file_id ?? null }),
  });
}
