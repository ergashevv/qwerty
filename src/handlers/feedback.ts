import { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { insertAnalyticsEvent } from '../db/postgres';
import { insertFilmPhotoEvidence } from '../db';
import { consumePendingFeedback } from '../db/feedbackPending';
import {
  clearProblemReportPending,
  resetFeedbackNoStreak,
  setProblemReportPending,
} from '../db/feedbackProblemReport';
import { offerChannelPromoAfterPositiveFeedback } from '../services/channelPromo';
import { tryBuildFeedbackThumbB64 } from '../services/feedbackThumb';
import { maybeDonateAfterFeedbackYes } from './donatePrompt';
import { feedbackModeReplyMarkup } from './feedbackModeBack';
import { feedbackT } from '../i18n/feedbackStrings';
import { getUserLocale } from '../db';
import { safeReply } from '../utils/safeTelegram';

const PREFIX = 'fb:';

export async function handleIdentificationFeedback(ctx: Context): Promise<void> {
  const cq = ctx.callbackQuery;
  const data = cq?.data;
  if (!data?.startsWith(PREFIX)) return;

  const uid = ctx.from?.id;
  const fb = uid ? feedbackT(await getUserLocale(uid)) : feedbackT('uz');

  const rest = data.slice(PREFIX.length);
  const colon = rest.lastIndexOf(':');
  if (colon <= 0) {
    await ctx.answerCallbackQuery({ text: fb.callbackBadFormat, show_alert: true });
    return;
  }
  const keyPart = rest.slice(0, colon);
  const vote = rest.slice(colon + 1);
  if (vote !== 'y' && vote !== 'n') {
    await ctx.answerCallbackQuery({ text: fb.callbackBadButton, show_alert: true });
    return;
  }

  if (!uid) {
    await ctx.answerCallbackQuery({ text: fb.callbackErr, show_alert: true });
    return;
  }

  /**
   * Telegram callback ~10s ichida answerCallbackQuery talab qiladi.
   * DB sekin bo‘lsa — "query is too old", foydalanuvchi hech narsa ko‘rmaydi.
   * Avvalo callback ni yopamiz (matnsiz — ikkinchi bosishda noto‘g‘ri "Rahmat" chiqmasin).
   */
  await ctx.answerCallbackQuery(
    vote === 'y' ? { text: fb.thanksYes } : { text: fb.thanksNo }
  );

  let row;
  try {
    row = await consumePendingFeedback(keyPart, uid);
  } catch (e) {
    console.error('consumePendingFeedback:', (e as Error).message);
    await safeReply(ctx, feedbackT(await getUserLocale(uid)).consumeError);
    return;
  }

  if (!row) {
    /** Ikkinchi bosish / boshqa user / eski tugma */
    return;
  }

  const correct = vote === 'y';

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

  const dashboardThumbB64 = await tryBuildFeedbackThumbB64(ctx, row.photo_file_id);

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
    photo_file_id: row.photo_file_id ?? null,
    ...(dashboardThumbB64 ? { dashboard_thumb_b64: dashboardThumbB64 } : {}),
    ...(row.source === 'text' && (row.user_query_text || row.bot_reply_preview)
      ? {
          user_query_text: row.user_query_text ?? null,
          bot_reply_preview: row.bot_reply_preview ?? null,
        }
      : row.source === 'reels' && row.user_query_text
        ? { user_query_text: row.user_query_text }
        : {}),
  });

  if (correct) {
    await resetFeedbackNoStreak(uid);
    await clearProblemReportPending(uid);
    if (
      row.source === 'photo' &&
      row.photo_file_id &&
      row.tmdb_id != null &&
      (row.media_type === 'movie' || row.media_type === 'tv')
    ) {
      await insertFilmPhotoEvidence({
        telegramUserId: row.telegram_user_id,
        tmdbId: row.tmdb_id,
        mediaType: row.media_type,
        imdbId: row.imdb_id,
        telegramFileId: row.photo_file_id,
      }).catch(() => {});
    }
    await maybeDonateAfterFeedbackYes(ctx).catch(() => {});
    await offerChannelPromoAfterPositiveFeedback(ctx).catch(() => {});
  } else {
    await setProblemReportPending(uid, {
      predictedTitle: row.predicted_title,
      predictedUzTitle: row.predicted_uz_title,
      source: row.source,
    });

    const loc = await getUserLocale(uid);
    await safeReply(ctx, feedbackT(loc).problemAfterNo, {
      parse_mode: 'HTML',
      reply_markup: feedbackModeReplyMarkup(loc),
    });
  }
}
