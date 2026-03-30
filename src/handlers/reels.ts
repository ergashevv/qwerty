import { Context } from 'grammy';
import {
  MovieDetails,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
} from '../services/movieService';
import {
  setCache,
  tryReserveReelsSlot,
  recordSearchRequest,
} from '../db';
import { insertPendingFeedback } from '../db/feedbackPending';
import { buildWatchKeyboard, sendMovieResult } from './photo';
import { enqueueReelsJob } from '../services/reelsQueue';
import { identifyMovieFromReelVideo } from '../services/reelsPipeline';
import { REELS_LIMIT_PER_WINDOW, REELS_WINDOW_SECONDS } from '../config/limits';
import { STATUS_DETAILS_LINES, STATUS_IDENTIFY_LINES, withRotatingStatus } from './rotatingStatus';

export async function handleInstagramReelUrl(ctx: Context, reelUrl: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const reserved = await tryReserveReelsSlot(userId);
  if (!reserved) {
    const h = Math.round(REELS_WINDOW_SECONDS / 3600);
    await ctx.reply(
      `⚠️ Instagram Reels orqali film qidirish limiti tugadi.\n\n` +
        `<b>${REELS_LIMIT_PER_WINDOW}</b> ta urinish / <b>${h}</b> soat.\n` +
        `Keyingi urinishlar uchun biroz kuting yoki screenshot yuboring / matn bilan yozing.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await recordSearchRequest(userId, 'reels');

  const processing = await ctx.reply('🔍 Reels tekshirilmoqda...');
  const chatId = ctx.chat!.id;
  const msgId = processing.message_id;
  void ctx.api.sendChatAction(chatId, 'typing');

  try {
    await ctx.api.editMessageText(
      chatId,
      msgId,
      '⏳ Navbatda yoki yuklanmoqda (boshqa Reels ish tugaguncha kutadi)...'
    );

    const identified = await enqueueReelsJob(async () => {
      await ctx.api.editMessageText(chatId, msgId, '📥 Instagram dan video olinmoqda...');
      return withRotatingStatus(
        ctx,
        chatId,
        msgId,
        STATUS_IDENTIFY_LINES,
        () => identifyMovieFromReelVideo(reelUrl),
        { intervalMs: 3000 }
      );
    });

    if (!identified) {
      await ctx.api.editMessageText(
        chatId,
        msgId,
        '❌ Bu Reels dan filmni aniqlay olmadim.\n\n' +
          '• Instagram havolasi ochiq va to‘g‘ri ekanini tekshiring\n' +
          '• Yoki shu sahna screenshot qilib yuboring\n' +
          '• Yoki filmni qisqacha matn bilan tasvirlab yozing'
      );
      return;
    }

    const fakeIdentified = {
      title: identified.title,
      type: identified.type,
      confidence: identified.confidence,
    };

    const cacheRes = await resolveFilmCachePhase(fakeIdentified);
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
            ? buildDetailsFromResolved(fakeIdentified, r.meta)
            : buildDetailsWithoutTmdb(fakeIdentified, r.imdbId),
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

    await ctx.api.deleteMessage(chatId, msgId);

    const watchKb = buildWatchKeyboard(details);
    const pendingToken = await insertPendingFeedback({
      telegramUserId: userId,
      chatId: ctx.chat!.id,
      source: 'reels',
      predictedTitle: details.title,
      predictedUzTitle: details.uzTitle,
      tmdbId: details.tmdbId ?? null,
      imdbId: details.imdbId ?? null,
      mediaType: details.mediaType ?? identified.type,
      confidence: identified.confidence ?? null,
      photoFileId: null,
      keyboardKeepJson: JSON.stringify({ inline_keyboard: watchKb }),
    });

    await sendMovieResult(ctx, details, { pendingFeedbackToken: pendingToken, confidence: identified.confidence });
  } catch (err) {
    console.error('Reels handler xato:', err);
    const msg =
      err instanceof Error && err.message === 'process_timeout'
        ? '❌ Video yoki kadr qayta ishlash vaqti tugadi. Keyinroq qayta urinib ko‘ring.'
        : '❌ Reels ni qayta ishlab bo‘lmadi (yuklash yoki Instagram cheklovi). Screenshot yoki matn bilan urinib ko‘ring.';
    await ctx.api.editMessageText(chatId, msgId, msg).catch(() => {});
  }
}
