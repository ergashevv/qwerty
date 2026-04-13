import { Context } from 'grammy';
import {
  MovieDetails,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
  getActorFilmFallbackCandidates,
  type MediaType,
} from '../services/movieService';
import {
  setCache,
  tryReserveReelsSlot,
  recordSearchRequest,
  getVideoUrlCache,
  setVideoUrlCache,
  getUserLocale,
} from '../db';
import type { BotLocale } from '../i18n/locale';
import { statusDetailsLines, statusIdentifyLines, t } from '../i18n/strings';
import { insertPendingFeedback } from '../db/feedbackPending';
import { buildBotReplyPreview } from '../utils/feedbackPreview';
import { buildWatchKeyboard, sendMovieResult } from './photo';
import { enqueueReelsJob } from '../services/reelsQueue';
import { identifyMovieFromReelVideo, type ReelsIdentifyResult } from '../services/reelsPipeline';
import { REELS_LIMIT_PER_WINDOW, REELS_WINDOW_SECONDS } from '../config/limits';
import { withRotatingStatus } from './rotatingStatus';
import { ackTyping, safeEditOrNotify } from '../utils/safeTelegram';
import { runWithLlmUsageContext } from '../services/llmUsageContext';
import {
  extractUserHintBesideFirstUrl,
  normalizeVideoUrlForCache,
  hashVideoUrlForCache,
} from '../services/reelsUrl';

export type VideoLinkPlatform = 'instagram' | 'youtube';

export interface HandleVideoLinkOpts {
  platform: VideoLinkPlatform;
  /** Foydalanuvchi xabari — matn + havola bo‘lsa izoh identify ga uzatiladi va feedback da saqlanadi */
  fullText?: string;
}

async function deliverResolvedReelsResult(
  ctx: Context,
  params: {
    userId: number;
    chatId: number;
    processingMsgId: number;
    identified: ReelsIdentifyResult;
    queryForFeedback: string | null;
    urlHash: string;
    normalizedUrl: string;
    writeUrlCache: boolean;
    locale: BotLocale;
  }
): Promise<void> {
  const {
    userId,
    chatId,
    processingMsgId,
    identified,
    queryForFeedback,
    urlHash,
    normalizedUrl,
    writeUrlCache,
    locale,
  } = params;

  const u = t(locale);
  const fakeIdentified = {
    title: identified.title,
    type: identified.type,
    confidence: identified.confidence,
  };

  const cacheRes = await resolveFilmCachePhase(fakeIdentified, locale);
  let details: MovieDetails;

  if (cacheRes.phase === 'hit') {
    await ctx.api.editMessageText(chatId, processingMsgId, u.detailsOut(identified.title));
    details = cacheRes.details;
  } else {
    const detailLines = statusDetailsLines(locale, identified.title);
    await ctx.api.editMessageText(chatId, processingMsgId, detailLines[0]);
    const r = cacheRes.r;
    details = await withRotatingStatus(
      ctx,
      chatId,
      processingMsgId,
      detailLines,
      () =>
        r.ok
          ? buildDetailsFromResolved(fakeIdentified, r.meta, locale)
          : buildDetailsWithoutTmdb(fakeIdentified, r.imdbId, locale),
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
      { tmdbId: details.tmdbId, mediaType: details.mediaType, locale }
    );
  }

  if (writeUrlCache) {
    await setVideoUrlCache(urlHash, normalizedUrl, {
      title: details.title,
      mediaType: (details.mediaType ?? identified.type) as MediaType,
      tmdbId: details.tmdbId ?? null,
    });
  }

  await ctx.api.deleteMessage(chatId, processingMsgId);

  const watchKb = buildWatchKeyboard(details, locale);
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
    userQueryText: queryForFeedback,
    botReplyPreview: buildBotReplyPreview({
      uzTitle: details.uzTitle,
      title: details.title,
      plotUz: details.plotUz,
    }),
  });

  await sendMovieResult(ctx, details, {
    pendingFeedbackToken: pendingToken,
    confidence: identified.confidence,
    locale,
  });
}

/**
 * Instagram yoki YouTube havolasi: bir xil limit, yt-dlp + kadr + aniqlash.
 */
export async function handleVideoLink(ctx: Context, videoUrl: string, opts: HandleVideoLinkOpts): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  ackTyping(ctx);

  const locale = await getUserLocale(userId);
  const u = t(locale);
  const ig = { check: u.reelsIgCheck, download: u.reelsIgDownload, fail: u.reelsIgFail, processErr: u.reelsIgErr };
  const yt = { check: u.reelsYtCheck, download: u.reelsYtDownload, fail: u.reelsYtFail, processErr: u.reelsYtErr };
  const COPY = opts.platform === 'instagram' ? ig : yt;

  const normalizedUrl = normalizeVideoUrlForCache(videoUrl);
  const urlHash = hashVideoUrlForCache(videoUrl);

  const urlCached = await getVideoUrlCache(urlHash);
  if (urlCached) {
    void recordSearchRequest(userId, 'reels').catch(() => {});
    const chatId = ctx.chat!.id;
    const processing = await ctx.reply(u.reelsCached);
    const msgId = processing.message_id;
    void ctx.api.sendChatAction(chatId, 'typing');

    const queryForFeedback = opts.fullText?.trim().slice(0, 4000) || null;

    const identified: ReelsIdentifyResult = {
      title: urlCached.title,
      type: urlCached.media_type,
      confidence: undefined,
      usedFrameIndex: -1,
    };

    try {
      await runWithLlmUsageContext(userId, async () =>
        deliverResolvedReelsResult(ctx, {
          userId,
          chatId,
          processingMsgId: msgId,
          identified,
          queryForFeedback,
          urlHash,
          normalizedUrl,
          writeUrlCache: false,
          locale,
        })
      );
    } catch (err) {
      console.error('Video URL cache deliver xato:', err);
      await safeEditOrNotify(ctx, chatId, processing.message_id, u.reelsCacheError);
    }
    return;
  }

  const reserved = await tryReserveReelsSlot(userId);
  if (!reserved) {
    const h = Math.round(REELS_WINDOW_SECONDS / 3600);
    await ctx.reply(u.reelsLimit(REELS_LIMIT_PER_WINDOW, h), { parse_mode: 'HTML' });
    return;
  }

  const chatId = ctx.chat!.id;
  let processing: { message_id: number } | undefined;
  const c = COPY;
  const hint = opts.fullText ? extractUserHintBesideFirstUrl(opts.fullText) : null;
  const queryForFeedback = opts.fullText?.trim().slice(0, 4000) || null;

  try {
    processing = await ctx.reply(c.check);
    void recordSearchRequest(userId, 'reels').catch(() => {});
    const msgId = processing.message_id;
    void ctx.api.sendChatAction(chatId, 'typing');

    await ctx.api.editMessageText(chatId, msgId, u.reelsQueue);

    const outcome = await enqueueReelsJob(async () => {
      await ctx.api.editMessageText(chatId, msgId, c.download);
      return runWithLlmUsageContext(userId, async () =>
        withRotatingStatus(
          ctx,
          chatId,
          msgId,
          statusIdentifyLines(locale),
          () => identifyMovieFromReelVideo(videoUrl, hint),
          { intervalMs: 3000 }
        )
      );
    });

    if (!outcome.ok) {
      let failText = c.fail;
      let replyMarkup: { inline_keyboard: { text: string; url: string }[][] } | undefined;

      if (outcome.lastFrameBase64) {
        const fb = await getActorFilmFallbackCandidates(outcome.lastFrameBase64);
        if (fb && fb.candidates.length > 0) {
          failText += u.actorGuessReels(fb.actorNames.slice(0, 2).join(', '));
          replyMarkup = {
            inline_keyboard: fb.candidates.map((c, i) => [
              {
                text: `${i + 1}. ${c.title.length > 46 ? `${c.title.slice(0, 45)}…` : c.title}`,
                url: `https://duckduckgo.com/?q=${encodeURIComponent(`${c.title} film`)}`,
              },
            ]),
          };
        }
      }

      await ctx.api.editMessageText(chatId, msgId, failText, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return;
    }

    await runWithLlmUsageContext(userId, async () =>
      deliverResolvedReelsResult(ctx, {
        userId,
        chatId,
        processingMsgId: msgId,
        identified: outcome.identified,
        queryForFeedback,
        urlHash,
        normalizedUrl,
        writeUrlCache: true,
        locale,
      })
    );
  } catch (err) {
    console.error('Video link handler xato:', err);
    const msg =
      err instanceof Error && err.message === 'process_timeout' ? u.reelsTimeout : c.processErr;
    await safeEditOrNotify(ctx, chatId, processing?.message_id, msg);
  }
}

export async function handleInstagramReelUrl(ctx: Context, reelUrl: string, fullText?: string): Promise<void> {
  return handleVideoLink(ctx, reelUrl, { platform: 'instagram', fullText });
}
