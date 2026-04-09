import { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import axios from 'axios';
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
} from '../services/movieService';
import { runWithLlmUsageContext } from '../services/llmUsageContext';
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
import { feedbackModeReplyMarkup } from './feedbackModeBack';
import { PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML } from '../messages/feedback';

const MAX_AMBIGUOUS_IDENTIFY_RESULTS = 4;

/**
 * Tasdiqdan o‘tmagan nomzodlar — har biri poster + qisqa ma’lumot + havolalar (fikr tug‘masiz).
 */
async function sendAmbiguousCandidateResults(ctx: Context, candidates: MovieIdentified[]): Promise<void> {
  const n = Math.min(candidates.length, MAX_AMBIGUOUS_IDENTIFY_RESULTS);
  for (let i = 0; i < n; i++) {
    const identified = candidates[i];
    const cacheRes = await resolveFilmCachePhase(identified);
    let details: MovieDetails;
    if (cacheRes.phase === 'hit') {
      details = cacheRes.details;
    } else {
      const r = cacheRes.r;
      details = r.ok
        ? await buildDetailsFromResolved(identified, r.meta)
        : await buildDetailsWithoutTmdb(identified, r.imdbId);
    }
    const variantHead =
      `🎬 <b>Taxminiy variant ${i + 1}/${n}</b>` +
      (identified.confidence
        ? ` <i>(${escHtml(String(identified.confidence))})</i>`
        : '') +
      `\n\n`;
    const caption =
      variantHead +
      buildMovieResultCaption(details, { confidence: 'medium', feedbackHint: false });
    const kb = buildWatchKeyboard(details);
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
      await ctx.reply(PROBLEM_REPORT_PHOTO_NEED_CAPTION_HTML, {
        parse_mode: 'HTML',
        reply_markup: feedbackModeReplyMarkup(),
      });
    }
    return;
  }

  let processing: { message_id: number } | undefined;
  try {
    await runWithLlmUsageContext(userId, async () => {
    processing = await ctx.reply('🔍 Qidiruv: rasm tahlil qilinmoqda...');
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
      await ctx.api.editMessageText(
        chatId,
        msgId,
        `🔍 Qidiruv: «${textHint.slice(0, 50)}» bo'yicha matn tekshirilmoqda...`
      );
      const textResult = await identifyFromTextDetailed(textHint);
      if (textResult.outcome === 'found') {
        identified = textResult.identified;
        console.log(`✅ Matn hint orqali topildi: "${identified.title}"`);
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
      const hintMsg = textHint
        ? `\n\n💡 <i>"${textHint.slice(0, 40)}" bo'yicha matn qidiruv ham sinab ko'rildi — topilmadi.</i>`
        : '';
      if (
        photoFail &&
        !photoFail.ok &&
        photoFail.reason === 'llm_verify_failed' &&
        photoFail.candidates.length > 0
      ) {
        const amb = photoFail.candidates;
        await ctx.api.deleteMessage(chatId, processing.message_id).catch(() => {});
        await ctx.reply(
          '🔍 <b>Bir nechta nomzod topildi</b>, lekin bitta filmni 100% tasdiqlay olmadim.\n\n' +
            'Quyida har birining <b>posteri</b> va <b>qisqa ma’lumoti</b> — o‘zingiz mosini tanlang. ' +
            'Aniqlashtirish uchun yangi kadr yoki matn ham yuborishingiz mumkin.',
          { parse_mode: 'HTML' }
        );
        await sendAmbiguousCandidateResults(ctx, amb);
        return;
      }

      const llmRejected =
        photoFail && !photoFail.ok && photoFail.reason === 'llm_verify_failed';
      let body = llmRejected
        ? '🔍 <b>Nomzodlar topildi</b>, lekin kadr tanlangan film bilan to‘liq mos kelishini tasdiqlay olmadim — xato deb chiqarib yubormayapman.\n\n' +
          '<b>Keyingi qadam:</b>\n' +
          '• Boshqa kadr yoki aniqroq sahna (yuz / muhit yaxshi ko‘rinsin)\n' +
          '• Rasmga qisqa izoh yozing\n' +
          '• Filmni matn bilan batafsilroq tasvirlab yuboring'
        : '🤔 Bu screenshotdan filmni aniqlay olmadim.' +
          hintMsg +
          '\n\n<b>Keyingi qadam:</b>\n' +
          '• Yaxshi yoritilgan kadr yoki boshqa sahna yuboring\n' +
          '• Aktyor ismi yoki syujetni qisqacha yozing';

      let replyMarkup: { inline_keyboard: { text: string; url: string }[][] } | undefined;
      const fb = await getActorFilmFallbackCandidates(base64);
      if (fb && fb.candidates.length > 0) {
        body +=
          `\n\n🎭 <b>Taxminiy tanilgan aktyor</b>: ${fb.actorNames.slice(0, 2).join(', ')}\n` +
          `Quyidagi <i>taxminiy</i> filmlardan biri bo‘lishi mumkin:`;
        replyMarkup = {
          inline_keyboard: fb.candidates.map((c, i) => [
            {
              text: `${i + 1}. ${c.title.length > 46 ? `${c.title.slice(0, 45)}…` : c.title}`,
              url: `https://duckduckgo.com/?q=${encodeURIComponent(`${c.title} film`)}`,
            },
          ]),
        };
      }

      await ctx.api.editMessageText(chatId, processing.message_id, body, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
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
    });
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
  opts?: { confidence?: string | null; feedbackHint?: boolean }
): string {
  const uz = (details.uzTitle || '').trim();
  const intl = (details.title || details.originalTitle || '').trim();
  const headline = uz || intl || 'Film';
  const intlLine =
    intl && intl.toLowerCase() !== uz.toLowerCase()
      ? `\n🌍 <i>${escHtml(intl)}</i>`
      : '';
  const yearLine = details.year ? ` | 📅 ${details.year}` : '';
  const ratingLine = details.rating !== 'N/A' ? ` | ⭐ ${details.rating}/10` : '';
  const confidenceLine =
    opts?.confidence === 'medium' ? `\n\n<i>🤖 AI taklifi — noto'g'ri bo'lishi mumkin.</i>` : '';
  const feedbackHintLine = opts?.feedbackHint
    ? `\n\n<i>👆 Natija to‘g‘rimi? Pastdagi 2 ta tugmani bosing — bot uchun juda foydali (1–2 soniya).</i>`
    : '';

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
      text: '🔍 Qo‘shimcha qidiruv',
      url: `https://duckduckgo.com/?q=${encodeURIComponent(q + ' uzbek tilida')}`,
    },
  ]);

  return rows;
}

export async function sendMovieResult(
  ctx: Context,
  details: MovieDetails,
  opts?: { pendingFeedbackToken?: string; confidence?: string | null }
): Promise<void> {
  const pTok = opts?.pendingFeedbackToken;
  const caption = buildMovieResultCaption(details, {
    confidence: opts?.confidence,
    feedbackHint: Boolean(pTok && pTok.length > 0),
  });

  /** Tugmalar: avvalo tomosha/IMDb, keyin fikr (Qo‘shimcha qidiruvdan yuqori — ko‘proq bosiladi). */
  const watchButtons = buildWatchKeyboard(details);
  if (pTok != null && pTok.length > 0) {
    const feedbackRow: (typeof watchButtons)[0] = [
      { text: '✅ Ha, to‘g‘ri film', callback_data: `fb:${pTok}:y` },
      { text: "❌ Boshqa film", callback_data: `fb:${pTok}:n` },
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
      watchButtons.push([{ text: '📩 Ulashish', url: shareUrl }]);
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
