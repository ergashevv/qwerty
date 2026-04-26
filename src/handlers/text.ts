import { Context } from 'grammy';
import {
  identifyFromTextDetailed,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
} from '../services/movieService';
import {
  clipIdentificationTraceText,
  logIdentificationRequest,
  logIdentificationResult,
} from '../services/identificationTrace';
import {
  setCache,
  upsertUser,
  incrementUserRequests,
  getWindowRequestCount,
  recordUserActivityDay,
  recordSearchRequest,
  getUserLocale,
} from '../db';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { statusDetailsLines, statusTextSearchLines, t } from '../i18n/strings';
import { insertPendingFeedback } from '../db/feedbackPending';
import { buildBotReplyPreview } from '../utils/feedbackPreview';
import { buildWatchKeyboard, sendMovieResult } from './photo';
import { USER_REQUEST_LIMIT, isUnlimitedUser } from '../config/limits';
import { extractInstagramReelUrl, extractYouTubeUrl } from '../services/reelsUrl';
import { handleVideoLink } from './reels';
import { withRotatingStatus } from './rotatingStatus';
import { setUserTextContext } from '../services/userContext';
import { completeSurveyProblemText, getSurveyProblemPending } from '../db/surveyBroadcast';
import { tryCompleteProblemReport } from './problemReportSubmit';
import { ackTyping, safeEditOrNotify, safeReply } from '../utils/safeTelegram';
import { runWithLlmUsageContext } from '../services/llmUsageContext';

export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const userId = ctx.from?.id;
  if (!userId) return;
  ackTyping(ctx);

  const locale = await getUserLocale(userId);
  const u = t(locale);

  const surveyPending = await getSurveyProblemPending(userId);
  if (surveyPending) {
    await Promise.all([
      upsertUser(userId, ctx.from?.username, ctx.from?.first_name),
      recordUserActivityDay(userId),
    ]);
    const saved = await completeSurveyProblemText(
      userId,
      surveyPending.campaignId,
      text.slice(0, 4000)
    );
    if (saved) {
      await ctx.reply(u.surveyThanks);
    } else {
      await safeReply(ctx, u.surveyDuplicate);
    }
    return;
  }

  if ((await tryCompleteProblemReport(ctx, userId, text)) !== 'none') {
    return;
  }

  if (text.startsWith('/')) {
    const adminHint = process.env.ADMIN_TELEGRAM_ID?.trim()
      ? locale === 'ru'
        ? ', /stats, /ad (только admin)'
        : ', /stats, /ad (faqat admin)'
      : '';
    await safeReply(ctx, u.unknownCommand(adminHint));
    return;
  }

  await Promise.all([
    upsertUser(userId, ctx.from?.username, ctx.from?.first_name),
    recordUserActivityDay(userId),
  ]);

  const reelUrl = extractInstagramReelUrl(text);
  if (reelUrl) {
    await handleVideoLink(ctx, reelUrl, { platform: 'instagram', fullText: text });
    return;
  }

  const ytUrl = extractYouTubeUrl(text);
  if (ytUrl) {
    await handleVideoLink(ctx, ytUrl, { platform: 'youtube', fullText: text });
    return;
  }

  void logIdentificationRequest({
    source: 'text',
    telegram_user_id: userId,
    chat_id: ctx.chat!.id,
    query_text: clipIdentificationTraceText(text, 500),
    query_length: text.length,
  }).catch(() => {});

  void recordSearchRequest(userId, 'text', { queryText: text }).catch(() => {});

  // Faqat raqam (kino kodi emas)
  if (/^\d+$/.test(text)) {
    void logIdentificationResult({
      source: 'text',
      telegram_user_id: userId,
      chat_id: ctx.chat!.id,
      outcome: 'invalid_input',
      reason: 'digits_only',
      query_text: clipIdentificationTraceText(text, 500),
    }).catch(() => {});
    await ctx.reply(u.digitsOnly, { parse_mode: 'HTML' });
    return;
  }

  // Juda qisqa (1 harf)
  if (text.replace(/\s+/g, '').length < 2) {
    void logIdentificationResult({
      source: 'text',
      telegram_user_id: userId,
      chat_id: ctx.chat!.id,
      outcome: 'invalid_input',
      reason: 'too_short',
      query_text: clipIdentificationTraceText(text, 500),
    }).catch(() => {});
    await ctx.reply(u.textTooShort);
    return;
  }

  // Keyingi foto yuborilsa context sifatida ishlatish uchun saqlanadi
  setUserTextContext(userId, text);

  if (!isUnlimitedUser(userId)) {
    if ((await getWindowRequestCount(userId)) >= USER_REQUEST_LIMIT) {
      void logIdentificationResult({
        source: 'text',
        telegram_user_id: userId,
        chat_id: ctx.chat!.id,
        outcome: 'rate_limited',
        limit_kind: 'request_window',
        query_text: clipIdentificationTraceText(text, 500),
      }).catch(() => {});
      await ctx.reply(u.limitReached(USER_REQUEST_LIMIT));
      return;
    }
    await incrementUserRequests(userId);
  }

  let processing: { message_id: number } | undefined;
  try {
    await runWithLlmUsageContext(userId, async () => {
      processing = await ctx.reply(u.searchStarted);
      void ctx.api.sendChatAction(ctx.chat!.id, 'typing');

      const idOutcome = await withRotatingStatus(
        ctx,
        ctx.chat!.id,
        processing.message_id,
        statusTextSearchLines(locale),
        () => identifyFromTextDetailed(text),
        { intervalMs: 3600 }
      );

      if (idOutcome.outcome === 'unclear') {
        void logIdentificationResult({
          source: 'text',
          telegram_user_id: userId,
          chat_id: ctx.chat!.id,
          outcome: 'unclear',
          query_text: clipIdentificationTraceText(text, 500),
        }).catch(() => {});
        await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, u.unclear, { parse_mode: 'HTML' });
        return;
      }

      if (idOutcome.outcome !== 'found') {
        void logIdentificationResult({
          source: 'text',
          telegram_user_id: userId,
          chat_id: ctx.chat!.id,
          outcome: 'not_found',
          query_text: clipIdentificationTraceText(text, 500),
        }).catch(() => {});
        await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, u.notFound, { parse_mode: 'HTML' });
        return;
      }

      const identified = idOutcome.identified;

      await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, u.foundLoading(identified.title));

      const cacheRes = await resolveFilmCachePhase(identified, locale);
      let details;

      if (cacheRes.phase === 'hit') {
        details = cacheRes.details;
      } else {
        const detailLines = statusDetailsLines(locale, identified.title);
        await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, detailLines[0]);
        const r = cacheRes.r;
        details = await withRotatingStatus(
          ctx,
          ctx.chat!.id,
          processing.message_id,
          detailLines,
          () =>
            r.ok
              ? buildDetailsFromResolved(identified, r.meta, locale)
              : buildDetailsWithoutTmdb(identified, r.imdbId, locale),
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

      await ctx.api.deleteMessage(ctx.chat!.id, processing.message_id);

      const watchKb = buildWatchKeyboard(details, locale);
      const botReplyPreview = buildBotReplyPreview({
        uzTitle: details.uzTitle,
        title: details.title,
        plotUz: details.plotUz,
      });
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
        botReplyPreview,
      });

      await sendMovieResult(ctx, details, {
        pendingFeedbackToken: pendingToken,
        confidence: identified.confidence,
        locale,
      });

      void logIdentificationResult({
        source: 'text',
        telegram_user_id: userId,
        chat_id: ctx.chat!.id,
        outcome: 'found',
        result_source: cacheRes.phase,
        query_text: clipIdentificationTraceText(text, 500),
        title: details.title,
        type: identified.type,
        confidence: identified.confidence ?? null,
        pending_feedback_token: pendingToken,
        user_query_text: clipIdentificationTraceText(text, 500),
        bot_reply_preview: botReplyPreview,
      }).catch(() => {});
    });
  } catch (err) {
    console.error('Text handler xato:', err);
    const chatId = ctx.chat?.id;
    if (chatId != null) {
      const loc = await getUserLocale(userId).catch(() => DEFAULT_LOCALE);
      await safeEditOrNotify(ctx, chatId, processing?.message_id, t(loc).genericError);
    }
  }
}
