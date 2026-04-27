import { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import axios from 'axios';
import type { BotLocale } from '../i18n/locale';
import { DEFAULT_LOCALE } from '../i18n/locale';
import { t } from '../i18n/strings';
import {
  identifyMovie,
  identifyFromTextDetailed,
  type IdentifyMovieResult,
  type MovieIdentified,
  MovieDetails,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
  extractInstagramSource,
  getActorFilmFallbackCandidates,
  verifyImageMatchesMovie,
} from '../services/movieService';
import {
  clipIdentificationTraceText,
  logIdentificationRequest,
  logIdentificationResult,
} from '../services/identificationTrace';
import { runWithLlmUsageContext } from '../services/llmUsageContext';
import { insertAnalyticsEvent } from '../db/postgres';
import { getRecentUserText, clearUserTextContext } from '../services/userContext';
import { buildBotReplyPreview } from '../utils/feedbackPreview';
import {
  setCache,
  upsertUser,
  canUserSendPhoto,
  recordSearchRequest,
  recordPhotoRequest,
  recordUserActivityDay,
  getUserLocale,
} from '../db';
import { insertPendingFeedback } from '../db/feedbackPending';
import {
  PHOTO_BURST_LIMIT,
  PHOTO_BURST_WINDOW_SECONDS,
  PHOTO_DAILY_LIMIT,
} from '../config/limits';
import { statusDetailsLines, statusIdentifyLines } from '../i18n/strings';
import { withRotatingStatus } from './rotatingStatus';
import { maybeDonateAfterSuccess } from './donatePrompt';
import { ackTyping, safeEditOrNotify } from '../utils/safeTelegram';
import { getProblemReportPending } from '../db/feedbackProblemReport';
import { tryCompleteProblemReport } from './problemReportSubmit';
import { feedbackModeReplyMarkup } from './feedbackModeBack';
import { feedbackT } from '../i18n/feedbackStrings';

const MAX_AMBIGUOUS_IDENTIFY_RESULTS = 4;
const PHOTO_ALLOW_UNVERIFIED_TEXT_FALLBACK =
  (process.env.PHOTO_ALLOW_UNVERIFIED_TEXT_FALLBACK || 'true').trim().toLowerCase() !== 'false';

function canUseUnverifiedTextFallback(identified: MovieIdentified): boolean {
  if (!PHOTO_ALLOW_UNVERIFIED_TEXT_FALLBACK) return false;
  return (identified.confidence || '').toLowerCase() !== 'low';
}

function textFallbackConfidence(
  identified: MovieIdentified,
  verified: boolean
): string | undefined {
  if (verified) return identified.confidence;
  return 'medium';
}

function normalizeIncomingImageMimeType(mimeType: string | undefined): string {
  const raw = (mimeType || '').toLowerCase();
  if (raw.includes('png')) return 'image/png';
  if (raw.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

function resolveIncomingImage(ctx: Context): { fileId: string; mimeType: string } | null {
  const photos = ctx.message?.photo;
  if (photos && photos.length > 0) {
    const largest = photos[photos.length - 1];
    if (largest?.file_id) {
      return { fileId: largest.file_id, mimeType: 'image/jpeg' };
    }
  }

  const doc = ctx.message?.document;
  if (doc?.file_id && doc.mime_type?.startsWith('image/')) {
    return {
      fileId: doc.file_id,
      mimeType: normalizeIncomingImageMimeType(doc.mime_type),
    };
  }

  return null;
}

/**
 * Tasdiqdan o‘tmagan nomzodlar — har biri poster + qisqa ma’lumot + havolalar (fikr tug‘masiz).
 */
async function sendAmbiguousCandidateResults(
  ctx: Context,
  candidates: MovieIdentified[],
  locale: BotLocale
): Promise<void> {
  const n = Math.min(candidates.length, MAX_AMBIGUOUS_IDENTIFY_RESULTS);
  const u = t(locale);
  for (let i = 0; i < n; i++) {
    const identified = candidates[i];
    const cacheRes = await resolveFilmCachePhase(identified, locale);
    let details: MovieDetails;
    if (cacheRes.phase === 'hit') {
      details = cacheRes.details;
    } else {
      const r = cacheRes.r;
      details = r.ok
        ? await buildDetailsFromResolved(identified, r.meta, locale)
        : await buildDetailsWithoutTmdb(identified, r.imdbId, locale);
    }
    const variantHead =
      `🎬 <b>${escHtml(u.ambiguousVariant(i + 1, n))}</b>` +
      (identified.confidence
        ? ` <i>(${escHtml(String(identified.confidence))})</i>`
        : '') +
      `\n\n`;
    const caption =
      variantHead +
      buildMovieResultCaption(details, { confidence: 'medium', feedbackHint: false, locale });
    const kb = buildWatchKeyboard(details, locale);
    const opts = {
      parse_mode: 'HTML' as const,
      reply_markup: { inline_keyboard: kb },
    };
    try {
      if (details.posterUrl) {
        await ctx.replyWithPhoto(details.posterUrl, { caption, ...opts });
      } else {
        await ctx.reply(caption, opts);
      }
    } catch {
      await ctx.reply(caption, opts);
    }
  }
}

export async function handlePhoto(ctx: Context): Promise<void> {
  const userId  = ctx.from?.id;
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;

  if (!userId) return;

  const chatId = ctx.chat!.id;
  ackTyping(ctx);

  if (await getProblemReportPending(userId)) {
    const loc = await getUserLocale(userId);
    const captionForReport = ctx.message?.caption?.trim() ?? '';
    if (captionForReport.length > 0) {
      const photos = ctx.message?.photo;
      const largest = photos?.length ? photos[photos.length - 1] : undefined;
      const doc = ctx.message?.document;
      const docImageId =
        doc?.mime_type?.startsWith('image/') && doc.file_id ? doc.file_id : undefined;
      await tryCompleteProblemReport(ctx, userId, captionForReport, {
        photoFileId: largest?.file_id ?? docImageId,
      });
    } else {
      await ctx.reply(feedbackT(loc).photoNeedCaption, {
        parse_mode: 'HTML',
        reply_markup: feedbackModeReplyMarkup(loc),
      });
    }
    return;
  }

  let processing: { message_id: number } | undefined;
  try {
    await runWithLlmUsageContext(userId, async () => {
    const locale = await getUserLocale(userId);
    const u = t(locale);

    processing = await ctx.reply(u.photoSearch);
    void ctx.api.sendChatAction(chatId, 'typing');

    await Promise.all([
      upsertUser(userId, username, firstName),
      recordUserActivityDay(userId),
    ]);

    const incomingImage = resolveIncomingImage(ctx);
    if (!incomingImage) {
      await ctx.api.editMessageText(chatId, processing.message_id, u.photoNoImage);
      return;
    }

    const captionHint = ctx.message?.caption?.trim() || null;
    const recentTextHint = getRecentUserText(userId);
    const textHint = captionHint || recentTextHint || null;
    const textHintSource = captionHint ? 'caption' : recentTextHint ? 'recent_text' : null;
    const photoTraceBase = {
      source: 'photo' as const,
      telegram_user_id: userId,
      chat_id: chatId,
      photo_file_id: incomingImage.fileId,
      text_hint_source: textHintSource,
      text_hint: clipIdentificationTraceText(textHint, 400),
      caption_text: clipIdentificationTraceText(captionHint, 400),
      recent_text_hint: clipIdentificationTraceText(recentTextHint, 400),
      mime_type: incomingImage.mimeType,
    };

    void logIdentificationRequest({
      ...photoTraceBase,
      has_caption: Boolean(captionHint),
    }).catch(() => {});

    void recordSearchRequest(userId, 'photo', { queryText: textHint ?? undefined }).catch(() => {});

    const photoGate = await canUserSendPhoto(userId);
    if (!photoGate.ok) {
      void logIdentificationResult({
        ...photoTraceBase,
        outcome: 'rate_limited',
        rate_limit_reason: photoGate.reason,
      }).catch(() => {});
      if (photoGate.reason === 'burst') {
        const m = Math.round(PHOTO_BURST_WINDOW_SECONDS / 60);
        await ctx.api.editMessageText(
          chatId,
          processing.message_id,
          u.photoBurst(m, PHOTO_BURST_LIMIT),
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.api.editMessageText(
          chatId,
          processing.message_id,
          u.photoDaily(PHOTO_DAILY_LIMIT),
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    await recordPhotoRequest(userId);

    const fileInfo = await ctx.api.getFile(incomingImage.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

    // Rasmni yuklab olish va base64 ga o'girish
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(response.data).toString('base64');
    const mimeType = incomingImage.mimeType;

    const msgId = processing.message_id;
    await ctx.api.editMessageText(chatId, msgId, statusIdentifyLines(locale)[0]);

    const idRes = await withRotatingStatus(
      ctx,
      chatId,
      msgId,
      statusIdentifyLines(locale),
      () => identifyMovie(base64, mimeType, textHint),
      { intervalMs: 3000 }
    );

    let identified = idRes.ok ? idRes.identified : null;
    let identifiedFromTextFallback = false;
    const photoFail: IdentifyMovieResult | null = idRes.ok ? null : idRes;

    // Rasm orqali topilmadi — matn hint bilan fallback
    if (!identified && textHint) {
      console.log(`📝 Foto topilmadi, matn hint: "${textHint}"`);
      await ctx.api.editMessageText(
        chatId,
        msgId,
        u.textHintSearch(textHint.slice(0, 50))
      );
      const textResult = await identifyFromTextDetailed(textHint);
      if (textResult.outcome === 'found') {
        const textFallbackVerified = await verifyImageMatchesMovie(
          base64,
          mimeType,
          textResult.identified.title
        );
        if (textFallbackVerified || canUseUnverifiedTextFallback(textResult.identified)) {
          identified = {
            ...textResult.identified,
            confidence: textFallbackConfidence(textResult.identified, textFallbackVerified),
          };
          identifiedFromTextFallback = true;
          console.log(
            `✅ Matn hint orqali topildi: "${identified.title}"` +
            (textFallbackVerified ? '' : ' (verify yumshatildi)')
          );
        } else {
          console.log(`⚠️ Matn hint topgan film rasm bilan tasdiqlanmadi: "${textResult.identified.title}"`);
        }
      }
    }

    // Kontekstni tozalash
    clearUserTextContext(userId);

    // Instagram source — topildi/topilmadidan qat'iy nazar, fon rejimida
    void extractInstagramSource(base64, userId).then(account => {
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
      const hintMsg = textHint ? u.photoHintTried(textHint.slice(0, 40)) : '';
      if (
        photoFail &&
        !photoFail.ok &&
        photoFail.reason === 'llm_verify_failed' &&
        photoFail.candidates.length > 0
      ) {
        const amb = photoFail.candidates;
        void logIdentificationResult({
          ...photoTraceBase,
          outcome: 'ambiguous',
          reason: photoFail.reason,
          ambiguous_candidate_count: amb.length,
          ambiguous_candidate_titles: amb.map((c) => c.title).slice(0, 5),
        }).catch(() => {});
        await ctx.api.deleteMessage(chatId, processing.message_id).catch(() => {});
        await ctx.reply(u.ambiguousIntro, { parse_mode: 'HTML' });
        await sendAmbiguousCandidateResults(ctx, amb, locale);
        return;
      }

      const llmRejected =
        photoFail && !photoFail.ok && photoFail.reason === 'llm_verify_failed';
      let body = llmRejected ? u.llmRejectedBody : u.photoNotFoundBody + hintMsg + u.photoNextSteps;

      let replyMarkup: { inline_keyboard: { text: string; url: string }[][] } | undefined;
      const fb = await getActorFilmFallbackCandidates(base64);
      if (fb && fb.candidates.length > 0) {
        body += u.actorGuess(fb.actorNames.slice(0, 2).join(', '));
        replyMarkup = {
          inline_keyboard: fb.candidates.map((c, i) => [
            {
              text: `${i + 1}. ${c.title.length > 46 ? `${c.title.slice(0, 45)}…` : c.title}`,
              url: `https://duckduckgo.com/?q=${encodeURIComponent(`${c.title} film`)}`,
            },
          ]),
        };
      }

      void logIdentificationResult({
        ...photoTraceBase,
        outcome: llmRejected ? 'llm_verify_failed' : 'no_candidates',
        reason: photoFail && !photoFail.ok ? photoFail.reason : null,
        fallback_actor_guess_shown: Boolean(fb && fb.candidates.length > 0),
        fallback_actor_names: fb?.actorNames?.slice(0, 3) ?? [],
        fallback_candidate_titles: fb?.candidates?.map((c) => c.title).slice(0, 3) ?? [],
      }).catch(() => {});

      await ctx.api.editMessageText(chatId, processing.message_id, body, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return;
    }

    const cacheRes = await resolveFilmCachePhase(identified, locale);
    let details: MovieDetails;

    if (cacheRes.phase === 'hit') {
      await ctx.api.editMessageText(chatId, msgId, u.detailsOut(identified.title));
      details = cacheRes.details;
    } else {
      const detailLines = statusDetailsLines(locale, identified.title);
      await ctx.api.editMessageText(chatId, msgId, detailLines[0]);
      const r = cacheRes.r;
      details = await withRotatingStatus(
        ctx,
        chatId,
        msgId,
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

    // Processing xabarini o'chirish
    await ctx.api.deleteMessage(chatId, msgId);

    const watchKb = buildWatchKeyboard(details, locale);
    const botReplyPreview = buildBotReplyPreview({
      uzTitle: details.uzTitle,
      title: details.title,
      plotUz: details.plotUz,
    });
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
      photoFileId: incomingImage.fileId,
      keyboardKeepJson: JSON.stringify({ inline_keyboard: watchKb }),
      userQueryText: textHint ?? null,
      botReplyPreview,
    });

    void logIdentificationResult({
      ...photoTraceBase,
      outcome: 'found',
      result_source: identifiedFromTextFallback ? 'text_fallback' : 'image',
      title: details.title,
      type: identified.type,
      confidence: identified.confidence ?? null,
      pending_feedback_token: pendingToken,
      bot_reply_preview: botReplyPreview,
    }).catch(() => {});

    await sendMovieResult(ctx, details, {
      pendingFeedbackToken: pendingToken,
      confidence: identified.confidence,
      locale,
    });
    });
  } catch (err) {
    console.error('Photo handler xato:', err);
    const loc = userId ? await getUserLocale(userId).catch(() => DEFAULT_LOCALE) : DEFAULT_LOCALE;
    await safeEditOrNotify(ctx, chatId, processing?.message_id, t(loc).genericError);
  }
}

const TELEGRAM_CAPTION_MAX = 1024;
/** Inline tugma `url` — Telegram cheklovi. */
const INLINE_KEYBOARD_URL_MAX = 2048;

/**
 * Telegram `t.me/share/url` — faqat qisqa matn + bot havolasi (preview).
 * Uzun tomosha URL larini bu yerga qo‘ymaymiz (chalkash va tushunarsiz).
 */
export function buildTelegramShareUrl(details: MovieDetails, botUsername: string): string | null {
  const u = botUsername.replace(/^@/, '').trim();
  if (!u) return null;
  const botLink = `https://t.me/${u}`;
  const intl = details.title || details.originalTitle || '';
  const uz = (details.uzTitle || '').trim();
  const mainTitle = uz || intl || 'Film';

  const shareTextVariants = (): string[] => {
    if (uz && intl && intl.toLowerCase() !== uz.toLowerCase()) {
      return [`🎬 ${uz}\n🌍 ${intl}`, `🎬 ${uz}`];
    }
    return [`🎬 ${mainTitle}`];
  };

  for (const text of shareTextVariants()) {
    const full = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(text)}`;
    if (full.length <= INLINE_KEYBOARD_URL_MAX) return full;
  }

  for (let max = 200; max >= 10; max -= 10) {
    const text = `🎬 ${mainTitle.slice(0, max)}`;
    const full = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(text)}`;
    if (full.length <= INLINE_KEYBOARD_URL_MAX) return full;
  }
  return null;
}

export function buildMovieResultCaption(
  details: MovieDetails,
  opts?: { confidence?: string | null; feedbackHint?: boolean; locale?: BotLocale }
): string {
  const loc = opts?.locale ?? DEFAULT_LOCALE;
  const u = t(loc);
  const uz = (details.uzTitle || '').trim();
  const intl = (details.title || details.originalTitle || '').trim();
  const headline = uz || intl || u.captionFallbackTitle;
  const intlLine =
    intl && intl.toLowerCase() !== uz.toLowerCase()
      ? `\n🌍 <i>${escHtml(intl)}</i>`
      : '';
  const yearLine = details.year ? ` | 📅 ${details.year}` : '';
  const ratingLine = details.rating !== 'N/A' ? ` | ⭐ ${details.rating}/10` : '';
  const confidenceLine =
    opts?.confidence === 'medium' ? `\n\n<i>${u.confidenceMedium}</i>` : '';
  const feedbackHintLine = opts?.feedbackHint ? `\n\n<i>${u.feedbackHint}</i>` : '';

  const buildWithPlotLimit = (plotLimit: number) => {
    const plotPart =
      details.plotUz.length <= plotLimit
        ? details.plotUz
        : `${details.plotUz.slice(0, plotLimit)}...`;
    return [
      `🎬 <b>${escHtml(headline)}</b>${intlLine}`,
      `${yearLine}${ratingLine}`.trim(),
      ``,
      `📖 ${escHtml(plotPart)}`,
      confidenceLine,
      feedbackHintLine,
    ]
      .filter(Boolean)
      .join('\n');
  };

  let plotLimit = 300;
  for (let i = 0; i < 12; i++) {
    const c = buildWithPlotLimit(plotLimit);
    if (c.length <= TELEGRAM_CAPTION_MAX) return c;
    plotLimit = Math.max(40, Math.floor(plotLimit * 0.7));
  }
  const last = buildWithPlotLimit(40);
  if (last.length <= TELEGRAM_CAPTION_MAX) return last;
  return `${last.slice(0, TELEGRAM_CAPTION_MAX - 3)}...`;
}

/** Tomosha havolalari + IMDb — fikr tugmalari qo‘shilmasdan */
export function buildWatchKeyboard(details: MovieDetails, locale: BotLocale = DEFAULT_LOCALE): InlineKeyboardButton[][] {
  const u = t(locale);
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
  const ddg =
    locale === 'ru'
      ? `https://duckduckgo.com/?q=${encodeURIComponent(`${q} смотреть онлайн`)}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(`${q} uzbek tilida`)}`;
  rows.push([{ text: u.extraSearch, url: ddg }]);

  return rows;
}

export async function sendMovieResult(
  ctx: Context,
  details: MovieDetails,
  opts?: { pendingFeedbackToken?: string; confidence?: string | null; locale?: BotLocale }
): Promise<void> {
  const loc = opts?.locale ?? DEFAULT_LOCALE;
  const u = t(loc);
  const pTok = opts?.pendingFeedbackToken;
  const caption = buildMovieResultCaption(details, {
    confidence: opts?.confidence,
    feedbackHint: Boolean(pTok && pTok.length > 0),
    locale: loc,
  });

  /** Tugmalar: avvalo tomosha/IMDb, keyin fikr (Qo‘shimcha qidiruvdan yuqori — ko‘proq bosiladi). */
  const watchButtons = buildWatchKeyboard(details, loc);
  if (pTok != null && pTok.length > 0) {
    const feedbackRow: (typeof watchButtons)[0] = [
      { text: u.feedbackYes, callback_data: `fb:${pTok}:y` },
      { text: u.feedbackNo, callback_data: `fb:${pTok}:n` },
    ];
    const last = watchButtons[watchButtons.length - 1];
    const ddgRow =
      last?.[0] && 'url' in last[0] && String(last[0].url || '').includes('duckduckgo.com')
        ? watchButtons.pop()
        : undefined;
    watchButtons.push(feedbackRow);
    if (ddgRow) watchButtons.push(ddgRow);
    const botUser = ctx.me?.username ?? process.env.BOT_USERNAME?.replace(/^@/, '')?.trim();
    const shareUrl = botUser ? buildTelegramShareUrl(details, botUser) : null;
    if (shareUrl) {
      watchButtons.push([{ text: u.share, url: shareUrl }]);
    }
  }

  const replyMarkup = { inline_keyboard: watchButtons };

  try {
    const sendOpts = {
      parse_mode: 'HTML' as const,
      reply_markup: replyMarkup,
    };
    if (details.posterUrl) {
      await ctx.replyWithPhoto(details.posterUrl, {
        caption,
        ...sendOpts,
      });
    } else {
      await ctx.reply(caption, sendOpts);
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

export function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
