import { Context } from 'grammy';
import {
  identifyFromTextDetailed,
  buildDetailsFromResolved,
  buildDetailsWithoutTmdb,
  resolveFilmCachePhase,
  makeEmptyLinksSentinel,
} from '../services/movieService';
import {
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
import { extractInstagramReelUrl, extractYouTubeUrl } from '../services/reelsUrl';
import { handleVideoLink } from './reels';
import { STATUS_DETAILS_LINES, withRotatingStatus } from './rotatingStatus';
import { setUserTextContext } from '../services/userContext';
import { completeSurveyProblemText, getSurveyProblemPending } from '../db/surveyBroadcast';
import { tryCompleteProblemReport } from './problemReportSubmit';
import { ackTyping, safeEditOrNotify, safeReply } from '../utils/safeTelegram';

export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const userId = ctx.from?.id;
  if (!userId) return;
  ackTyping(ctx);

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
      await ctx.reply('Rahmat! Yozganingiz qabul qilindi. ❤️');
    } else {
      await safeReply(
        ctx,
        'Bu javob allaqachon qabul qilingan yoki sessiya tugagan. Kerak bo‘lsa, /help ni oching.'
      );
    }
    return;
  }

  /** Shikoyat matni slash bilan boshlangan bo‘lsa ham qabul qilinadi (/ dan oldin tekshirilmaydi). */
  if (await tryCompleteProblemReport(ctx, userId, text)) {
    return;
  }

  if (text.startsWith('/')) {
    const adminHint = process.env.ADMIN_TELEGRAM_ID?.trim() ? ', /stats (faqat admin)' : '';
    await safeReply(
      ctx,
      '❓ Bunday buyruq topilmadi yoki format noto‘g‘ri.\n\n' +
        `Mavjud: /start, /help, /feedback, /cancel${adminHint}.\n\n` +
        'Film nomini yozing yoki screenshot yuboring.'
    );
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

  // Faqat raqam (kino kodi emas)
  if (/^\d+$/.test(text)) {
    await ctx.reply(
      '❓ Raqamdan film topib bo\'lmaydi.\n\n' +
      'Film <b>nomini</b>, aktyor <b>ismini</b> yoki syujet <b>tavsifini</b> yozing.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Juda qisqa (1 harf)
  if (text.replace(/\s+/g, '').length < 2) {
    await ctx.reply('❓ Aniqroq yozing — film nomi, aktyor ismi yoki syujet tavsifi.');
    return;
  }

  // Keyingi foto yuborilsa context sifatida ishlatish uchun saqlanadi
  setUserTextContext(userId, text);

  if (!isUnlimitedUser(userId)) {
    if ((await getWindowRequestCount(userId)) >= USER_REQUEST_LIMIT) {
      await ctx.reply(
        `⚠️ So'rov limiti tugadi (${USER_REQUEST_LIMIT} ta / 12 soat).\n` +
          `⏳ 12 soatdan keyin yana ${USER_REQUEST_LIMIT} ta ochiladi.`
      );
      return;
    }
    await incrementUserRequests(userId);
  }

  let processing: { message_id: number } | undefined;
  try {
    processing = await ctx.reply('🔍 Qidirilmoqda...');
    void ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    void recordSearchRequest(userId, 'text', { queryText: text }).catch(() => {});

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
        '❓ Bir nechta film mos keldi — bittasini tanlab bo‘lmadi.\n\n' +
          '<b>Qayta yozing, aniqroq:</b>\n' +
          '• taxminan yil (masalan: 2014)\n' +
          '• janr (drama, multfilm, ilmiy-fantastika…)\n' +
          '• aktyor yoki rejissor ismi',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (idOutcome.outcome !== 'found') {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processing.message_id,
        '❌ Film topilmadi.\n\n' +
          '<b>Keyingi qadam:</b>\n' +
          '• Film nomi (ingliz yoki o‘zbek)\n' +
          '• Aktyor yoki rejissor ismi\n' +
          '• Yil yoki janr (masalan: 2010, drama)\n' +
          '• Eskidan eslayotgan sahna yoki syujetni 2–3 qator yozing',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const identified = idOutcome.identified;

    await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, `🎯 "${identified.title}" topildi! Yuklanmoqda...`);

    const cacheRes = await resolveFilmCachePhase(identified);
    let details;

    if (cacheRes.phase === 'hit') {
      details = cacheRes.details;
    } else {
      const detailLines = STATUS_DETAILS_LINES(identified.title);
      await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, detailLines[0]);
      const r = cacheRes.r;
      details = await withRotatingStatus(
        ctx,
        ctx.chat!.id,
        processing.message_id,
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

    await sendMovieResult(ctx, details, { pendingFeedbackToken: pendingToken, confidence: identified.confidence });
  } catch (err) {
    console.error('Text handler xato:', err);
    const chatId = ctx.chat?.id;
    if (chatId != null) {
      await safeEditOrNotify(
        ctx,
        chatId,
        processing?.message_id,
        '❌ Xatolik yuz berdi. Qayta urinib ko‘ring.'
      );
    }
  }
}
