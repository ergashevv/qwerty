import { Context } from 'grammy';
import {
  identifyFromTextDetailed,
  getMovieDetails,
  imdbIdFromMovieUrl,
  cacheEntryMatchesIdentified,
  cachedWatchLinksNonEmpty,
} from '../services/movieService';
import {
  getCached,
  setCache,
  upsertUser,
  incrementUserRequests,
  getWindowRequestCount,
  recordUserActivityDay,
  recordSearchRequest,
} from '../db';
import { insertPendingFeedback } from '../db/feedbackPending';
import { buildBotReplyPreview } from '../utils/feedbackPreview';
import { buildWatchKeyboard, sendMovieResult } from './photo';
import { USER_REQUEST_LIMIT, isUnlimitedUser } from '../config/limits';
import { extractInstagramReelUrl } from '../services/reelsUrl';
import { handleInstagramReelUrl } from './reels';
import { STATUS_DETAILS_LINES, withRotatingStatus } from './rotatingStatus';

export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;

  const userId = ctx.from?.id;
  if (!userId) return;

  await upsertUser(userId, ctx.from?.username, ctx.from?.first_name);
  await recordUserActivityDay(userId);

  const reelUrl = extractInstagramReelUrl(text);
  if (reelUrl) {
    await handleInstagramReelUrl(ctx, reelUrl);
    return;
  }

  if (!isUnlimitedUser(userId)) {
    if ((await getWindowRequestCount(userId)) >= USER_REQUEST_LIMIT) {
      await ctx.reply(
        `⚠️ So'rov limiti tugadi (${USER_REQUEST_LIMIT} ta / 12 soat).\n` +
          '⏳ 12 soatdan keyin yana 3 ta ochiladi.'
      );
      return;
    }
    await incrementUserRequests(userId);
  }

  // Foydalanuvchiga darhol javob ko'rsatish — limit tekshiruvidan oldin ham
  const processing = await ctx.reply('🔍 Qidirilmoqda...');
  void ctx.api.sendChatAction(ctx.chat!.id, 'typing');

  await recordSearchRequest(userId, 'text', { queryText: text });

  try {
    const idOutcome = await withRotatingStatus(
      ctx,
      ctx.chat!.id,
      processing.message_id,
      ['·'],
      () => identifyFromTextDetailed(text)
    );

    if (idOutcome.outcome === 'unclear') {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processing.message_id,
        '❓ Aniq bitta filmni tanlab bo‘lmadi.\n\n' +
          'Iltimos, qayta yozing — masalan:\n' +
          '• taxminan qaysi yilda chiqqan\n' +
          '• janr (drama, multfilm, ilmiy-fantastika…)\n' +
          '• yoki aktyor / rejissor ismi'
      );
      return;
    }

    if (idOutcome.outcome !== 'found') {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processing.message_id,
        '❌ Film topilmadi. Aniqroq yozing:\n• Film nomi (inglizcha yoki o\'zbekcha)\n• Aktyor ismi\n• Syujet tavsifi'
      );
      return;
    }

    const identified = idOutcome.identified;

    await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, `🎯 "${identified.title}" topildi! Yuklanmoqda...`);

    const cached = await getCached(identified.title);
    let details;

    if (cached && cacheEntryMatchesIdentified(identified, cached) && cachedWatchLinksNonEmpty(cached.watch_links)) {
      details = {
        title: cached.title,
        uzTitle: cached.uz_title || cached.title,
        originalTitle: cached.original_title || cached.title,
        year: cached.year || '',
        rating: cached.rating || 'N/A',
        posterUrl: cached.poster_url || null,
        plotUz: cached.plot_uz || 'Tavsif mavjud emas',
        imdbUrl: cached.imdb_url || null,
        watchLinks: cached.watch_links ? JSON.parse(cached.watch_links) : [],
        tmdbId: null,
        imdbId: imdbIdFromMovieUrl(cached.imdb_url || null),
        mediaType: identified.type,
      };
    } else {
      const detailLines = STATUS_DETAILS_LINES(identified.title);
      await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, detailLines[0]);
      details = await withRotatingStatus(
        ctx,
        ctx.chat!.id,
        processing.message_id,
        detailLines,
        () => getMovieDetails(identified),
        { intervalMs: 2800 }
      );
      await setCache(identified.title, {
        title: details.title,
        uz_title: details.uzTitle,
        original_title: details.originalTitle,
        year: details.year,
        poster_url: details.posterUrl || undefined,
        plot_uz: details.plotUz,
        watch_links: JSON.stringify(details.watchLinks),
        rating: details.rating,
        imdb_url: details.imdbUrl || undefined,
      });
    }

    await ctx.api.deleteMessage(ctx.chat!.id, processing.message_id);

    const watchKb = buildWatchKeyboard(details);
    const pendingToken = await insertPendingFeedback({
      telegramUserId: userId,
      chatId: ctx.chat!.id,
      source: 'text',
      predictedTitle: details.title,
      predictedUzTitle: details.uzTitle,
      tmdbId: details.tmdbId ?? null,
      imdbId: details.imdbId ?? null,
      mediaType: details.mediaType ?? identified.type,
      confidence: identified.confidence ?? null,
      photoFileId: null,
      keyboardKeepJson: JSON.stringify({ inline_keyboard: watchKb }),
      userQueryText: text.slice(0, 4000),
      botReplyPreview: buildBotReplyPreview({
        uzTitle: details.uzTitle,
        title: details.title,
        plotUz: details.plotUz,
      }),
    });

    await sendMovieResult(ctx, details, { pendingFeedbackToken: pendingToken });
  } catch (err) {
    console.error('Text handler xato:', err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processing.message_id,
      '❌ Xatolik yuz berdi. Qayta urinib ko\'ring.'
    ).catch(() => {});
  }
}
