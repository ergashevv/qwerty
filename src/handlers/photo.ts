import { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import axios from 'axios';
import {
  identifyMovie,
  identifyFromTextDetailed,
  type IdentifyMovieResult,
  MovieDetails,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
  extractInstagramSource,
} from '../services/movieService';
import { insertAnalyticsEvent } from '../db/postgres';
import { getRecentUserText, clearUserTextContext } from '../services/userContext';
import {
  setCache,
  upsertUser,
  canUserSendPhoto,
  recordPhotoRequest,
  recordUserActivityDay,
} from '../db';
import { insertPendingFeedback } from '../db/feedbackPending';
import {
  PHOTO_BURST_LIMIT,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_DAILY_LIMIT,
} from '../config/limits';
import {
  STATUS_DETAILS_LINES,
  STATUS_IDENTIFY_LINES,
  withRotatingStatus,
} from './rotatingStatus';
import { maybeDonateAfterSuccess } from './donatePrompt';
import { ackTyping, safeEditOrNotify } from '../utils/safeTelegram';
import { getProblemReportPending } from '../db/feedbackProblemReport';
import { tryCompleteProblemReport } from './problemReportSubmit';
import { PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML } from '../messages/feedback';

export async function handlePhoto(ctx: Context): Promise<void> {
  const userId  = ctx.from?.id;
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;

  if (!userId) return;

  const chatId = ctx.chat!.id;
  ackTyping(ctx);

  if (await getProblemReportPending(userId)) {
    const captionForReport = ctx.message?.caption?.trim() ?? '';
    if (captionForReport.length > 0) {
      await tryCompleteProblemReport(ctx, userId, captionForReport);
    } else {
      await ctx.reply(PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML, { parse_mode: 'HTML' });
    }
    return;
  }

  let processing: { message_id: number } | undefined;
  try {
    processing = await ctx.reply('🔍 Qidirilmoqda...');
    void ctx.api.sendChatAction(chatId, 'typing');

    await Promise.all([
      upsertUser(userId, username, firstName),
      recordUserActivityDay(userId),
    ]);

    const photoGate = await canUserSendPhoto(userId);
    if (!photoGate.ok) {
      if (photoGate.reason === 'burst') {
        const m = Math.round(PHOTO_BURST_WINDOW_SECONDS / 60);
        await ctx.api.editMessageText(
          chatId,
          processing.message_id,
          `⏳ Juda tez-tez rasm yuboryapsiz.\n\n` +
            `Bitta filmni topish uchun 3–4 ta kadr yuborishingiz mumkin — ` +
            `lekin ${m} daqiqada maksimal <b>${PHOTO_BURST_LIMIT}</b> ta rasm.\n` +
            `Biroz kutib, yana urinib ko'ring.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.api.editMessageText(
          chatId,
          processing.message_id,
          `⚠️ Kunlik rasm limiti tugadi (<b>${PHOTO_DAILY_LIMIT}</b> ta / kun).\n` +
            `Ertaga yana foydalanishingiz mumkin.`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    await recordPhotoRequest(userId);

    // Telegram dan eng katta o'lchamdagi rasmni olish
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await ctx.api.editMessageText(chatId, processing.message_id, '❌ Rasm topilmadi.');
      return;
    }

    const largest = photos[photos.length - 1];
    const fileInfo = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

    // Rasmni yuklab olish va base64 ga o'girish
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(response.data).toString('base64');
    const mimeType = 'image/jpeg';

    const msgId = processing.message_id;
    await ctx.api.editMessageText(chatId, msgId, STATUS_IDENTIFY_LINES[0]);

    // Foto caption yoki oldingi matn xabardan hint olish
    const captionHint = ctx.message?.caption?.trim() || null;
    const recentTextHint = getRecentUserText(userId);
    const textHint = captionHint || recentTextHint || null;

    const idRes = await withRotatingStatus(
      ctx,
      chatId,
      msgId,
      STATUS_IDENTIFY_LINES,
      () => identifyMovie(base64, mimeType, textHint),
      { intervalMs: 3000 }
    );

    let identified = idRes.ok ? idRes.identified : null;
    const photoFail: IdentifyMovieResult | null = idRes.ok ? null : idRes;

    // Rasm orqali topilmadi — matn hint bilan fallback
    if (!identified && textHint) {
      console.log(`📝 Foto topilmadi, matn hint: "${textHint}"`);
      await ctx.api.editMessageText(chatId, msgId, `🔍 "${textHint.slice(0, 50)}" bo'yicha qidirilmoqda...`);
      const textResult = await identifyFromTextDetailed(textHint);
      if (textResult.outcome === 'found') {
        identified = textResult.identified;
        console.log(`✅ Matn hint orqali topildi: "${identified.title}"`);
      }
    }

    // Kontekstni tozalash
    clearUserTextContext(userId);

    // Instagram source — topildi/topilmadidan qat'iy nazar, fon rejimida
    void extractInstagramSource(base64).then(account => {
      if (account) {
        console.log(`📸 Instagram source: @${account}`);
        insertAnalyticsEvent('instagram_source', {
          account,
          telegram_user_id: userId,
          identified: !!identified,
          movie_title: identified?.title ?? null,
        }).catch(() => {});
      }
    }).catch(() => {});

    if (!identified) {
      const hintMsg = textHint
        ? `\n\n💡 <i>"${textHint.slice(0, 40)}" bo'yicha matn qidiruv ham sinab ko'rildi — topilmadi.</i>`
        : '';
      const geminiRejected =
        photoFail && !photoFail.ok && photoFail.reason === 'gemini_verify_failed';
      const body = geminiRejected
        ? '🔍 <b>Nomzodlar topildi</b>, lekin kadr tanlangan film bilan to‘liq mos kelishini tasdiqlay olmadim — xato deb chiqarib yubormayapman.\n\n' +
          '📸 Boshqa kadr yoki aniqroq sahna yuboring (yuz / muhit yaxshi ko‘rinsin).\n' +
          '✍️ Yoki rasmga izoh yozing — yoki filmni matn bilan batafsilroq tasvirlab yuboring.'
        : '🤔 Bu screenshotdan filmni aniqlay olmadim.' + hintMsg + '\n\n' +
          '📸 Aniqroq kadr yoki boshqa sahna yuborib ko‘ring\n' +
          '✍️ Yoki filmni so‘zlar bilan tasvirlab yozing';
      await ctx.api.editMessageText(chatId, processing.message_id, body, { parse_mode: 'HTML' });
      return;
    }

    const cacheRes = await resolveFilmCachePhase(identified);
    let details: MovieDetails;

    if (cacheRes.phase === 'hit') {
      await ctx.api.editMessageText(
        chatId,
        msgId,
        `🎯 «${identified.title}» topildi — ma’lumotlar chiqarilmoqda...`
      );
      details = cacheRes.details;
    } else {
      const detailLines = STATUS_DETAILS_LINES(identified.title);
      await ctx.api.editMessageText(chatId, msgId, detailLines[0]);
      const r = cacheRes.r;
      details = await withRotatingStatus(
        ctx,
        chatId,
        msgId,
        detailLines,
        () =>
          r.ok
            ? buildDetailsFromResolved(identified, r.meta)
            : buildDetailsWithoutTmdb(identified, r.imdbId),
        { intervalMs: 2800 }
      );
      await setCache(
        identified.title,
        {
          title: details.title,
          uz_title: details.uzTitle,
          original_title: details.originalTitle,
          year: details.year,
          poster_url: details.posterUrl || undefined,
          plot_uz: details.plotUz,
          watch_links: details.watchLinks.length > 0 ? JSON.stringify(details.watchLinks) : makeEmptyLinksSentinel(),
          rating: details.rating,
          imdb_url: details.imdbUrl || undefined,
        },
        { tmdbId: details.tmdbId, mediaType: details.mediaType }
      );
    }

    // Processing xabarini o'chirish
    await ctx.api.deleteMessage(chatId, msgId);

    const watchKb = buildWatchKeyboard(details);
    const pendingToken = await insertPendingFeedback({
      telegramUserId: userId,
      chatId: ctx.chat!.id,
      source: 'photo',
      predictedTitle: details.title,
      predictedUzTitle: details.uzTitle,
      tmdbId: details.tmdbId ?? null,
      imdbId: details.imdbId ?? null,
      mediaType: details.mediaType ?? identified.type,
      confidence: identified.confidence ?? null,
      photoFileId: largest.file_id,
      keyboardKeepJson: JSON.stringify({ inline_keyboard: watchKb }),
    });

    await sendMovieResult(ctx, details, { pendingFeedbackToken: pendingToken, confidence: identified.confidence });
  } catch (err) {
    console.error('Photo handler xato:', err);
    await safeEditOrNotify(
      ctx,
      chatId,
      processing?.message_id,
      '❌ Xatolik yuz berdi. Qayta urinib ko‘ring.'
    );
  }
}

/** Tomosha havolalari + IMDb/Google — fikr tugmalari qo‘shilmasdan */
export function buildWatchKeyboard(details: MovieDetails): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = details.watchLinks.slice(0, 4).map((link) => [
    { text: `▶️ ${link.source}`, url: link.link },
  ]);

  if (details.imdbUrl) {
    rows.push([{ text: '🌐 IMDb', url: details.imdbUrl }]);
  }

  const q =
    (details.originalTitle && details.originalTitle.trim()) ||
    details.title ||
    details.uzTitle;
  rows.push([
    {
      text: "🔍 Google'da qidirish",
      url: `https://www.google.com/search?q=${encodeURIComponent(q + ' uzbek tilida')}`,
    },
  ]);

  return rows;
}

export async function sendMovieResult(
  ctx: Context,
  details: MovieDetails,
  opts?: { pendingFeedbackToken?: string; confidence?: string | null }
): Promise<void> {
  const mainTitle = details.title || details.originalTitle || details.uzTitle;
  const uzLine = details.uzTitle && details.uzTitle !== mainTitle
    ? `\n📽 O'zbekcha: <b>${escHtml(details.uzTitle)}</b>` : '';
  const yearLine  = details.year ? ` | 📅 ${details.year}` : '';
  const ratingLine = details.rating !== 'N/A' ? ` | ⭐ ${details.rating}/10` : '';
  const confidenceLine = opts?.confidence === 'medium'
    ? `\n\n<i>🤖 AI taklifi — noto'g'ri bo'lishi mumkin.</i>`
    : '';

  const caption = [
    `🎬 <b>${escHtml(mainTitle)}</b>${uzLine}`,
    `${yearLine}${ratingLine}`.trim(),
    ``,
    `📖 ${escHtml(details.plotUz.slice(0, 300))}${details.plotUz.length > 300 ? '...' : ''}`,
    confidenceLine,
  ].filter(Boolean).join('\n');

  const watchButtons = buildWatchKeyboard(details);
  const pTok = opts?.pendingFeedbackToken;
  if (pTok != null && pTok.length > 0) {
    watchButtons.push([
      { text: '✅ Ha, shu film', callback_data: `fb:${pTok}:y` },
      { text: "❌ Yo'q, bu emas", callback_data: `fb:${pTok}:n` },
    ]);
  }

  const replyMarkup = { inline_keyboard: watchButtons };

  try {
    if (details.posterUrl) {
      await ctx.replyWithPhoto(details.posterUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } else {
      await ctx.reply(caption, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }
  } catch {
    // Poster yuklab bo'lmasa, matnsiz jo'natish
    await ctx.reply(caption, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }

  await maybeDonateAfterSuccess(ctx).catch(() => {});
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
