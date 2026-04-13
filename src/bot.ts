import 'dotenv/config';
import { Bot, Composer, GrammyError, HttpError, type Context } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { handlePhoto } from './handlers/photo';
import { handleText } from './handlers/text';
import {
  getAudienceStats,
  getIdentificationFeedbackStats,
  getUserLocale,
  markUserStarted,
  pruneUserActivityHistory,
  recordUserActivityDay,
  setUserLocale,
  upsertUser,
} from './db';
import { feedbackT } from './i18n/feedbackStrings';
import type { BotLocale } from './i18n/locale';
import { DEFAULT_LOCALE, parseBotLocale } from './i18n/locale';
import { t } from './i18n/strings';
import { getPostgresPool, initPostgresSchema, pingPostgres, runAnalyticsRetention } from './db/postgres';
import { handleIdentificationFeedback } from './handlers/feedback';
import { feedbackModeReplyMarkup, handleFeedbackModeBack } from './handlers/feedbackModeBack';
import { handleDonateCallback } from './handlers/donatePrompt';
import {
  buildDonateBroadcastConfirmKeyboard,
  handleDonateBroadcastConfirm,
  handleSurveyCallback,
  runSurveyDeleteCampaign,
} from './handlers/surveyBroadcast';
import { isAdminTelegram } from './utils/isAdmin';
import { safeReply } from './utils/safeTelegram';
import {
  clearProblemReportPending,
  getProblemReportPending,
  resetFeedbackNoStreak,
  setFreeComplaintPending,
} from './db/feedbackProblemReport';
import { handleProblemReportUnsupportedMedia } from './handlers/problemReportWrongMedia';
import { escHtml } from './handlers/photo';
import {
  getChannelPromoKeyboard,
  getChannelPromoMessageHtml,
  isChannelPromoEnabled,
  setChannelPromoEnabled,
} from './services/channelPromo';
import {
  getUserChannelPromoState,
  markUserChannelPromoBroadcastSent,
} from './db/postgres';

/** `t.me/bot?start=feedback` — xabar matni: `/start feedback` */
const START_PAYLOAD_FEEDBACK = 'feedback';

function parseStartPayload(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(text.trim());
  return m?.[1]?.trim();
}

async function runFeedbackFlow(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return;
  const loc = await getUserLocale(uid);
  const fb = feedbackT(loc);
  const kb = { reply_markup: feedbackModeReplyMarkup(loc) };
  if (await getProblemReportPending(uid)) {
    await ctx.reply(fb.writeNext, { parse_mode: 'HTML', ...kb });
    return;
  }
  await setFreeComplaintPending(uid);
  await ctx.reply(fb.writeNext, { parse_mode: 'HTML', ...kb });
}

function languageReplyMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "🇺🇿 O'zbekcha", callback_data: 'lang:uz' },
        { text: '🇷🇺 Русский', callback_data: 'lang:ru' },
      ],
    ],
  };
}

function startWelcomeText(ctx: Context, locale: BotLocale): string {
  const u = t(locale);
  const name = escHtml(
    ctx.from?.first_name || (locale === 'ru' ? 'друг' : "Do'stim")
  );
  const botU = ctx.me?.username ?? process.env.BOT_USERNAME?.replace(/^@/, '') ?? '';
  const feedbackLine = botU ? u.feedbackLine(botU) : u.feedbackLinePlain;
  return `${u.langPrompt}\n\n${u.startWelcome(name)}\n\n${feedbackLine}\n\n${u.langCommandHint}`;
}

const _botToken = process.env.BOT_TOKEN;
if (!_botToken) {
  console.error('❌ BOT_TOKEN topilmadi! .env faylni tekshiring.');
  process.exit(1);
}
const botToken: string = _botToken;

if (!process.env.DATABASE_URL?.trim()) {
  console.error("❌ DATABASE_URL majburiy — barcha ma'lumotlar Postgres (Neon) da.");
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  try {
    await initPostgresSchema();
    await pruneUserActivityHistory();
    if (await pingPostgres()) console.log('✅ Postgres tayyor');
    await runAnalyticsRetention();
    if (!process.env.ADMIN_TELEGRAM_ID?.trim()) {
      console.warn(
        '⚠️ ADMIN_TELEGRAM_ID .env da yo‘q — /donate ishlamaydi; admin buyruqlar ID bilan tekshirilmaydi. VPS da qo‘shib pm2 restart qiling.'
      );
    }
  } catch (e) {
    console.error('❌ Postgres:', (e as Error).message);
    process.exit(1);
  }

  const bot = new Bot(botToken);

  /** `@grammyjs/runner` `run()` handle — `SIGTERM` da `stop()` uchun */
  let runnerHandle: ReturnType<typeof run> | undefined;

  /**
   * Callback query'lar `sequentialize` ichidagi xabar pipeline'iga tushmasligi kerak.
   * `sequentialize` faqat `messagePipeline` ichida — mos kelgan callbacklar bu yerga kelmaydi.
   * `my_chat_member` ham shu pipeline'da emas — bloklash/yangi a'zo hodisalari uzoq foto
   * qidiruvi tugashini kutmaydi.
   */
  bot.callbackQuery(/^lang:/, async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const raw = ctx.callbackQuery?.data?.replace(/^lang:/, '').trim();
    const lang = parseBotLocale(raw);
    if (!lang) {
      await ctx.answerCallbackQuery({ text: 'Error', show_alert: true });
      return;
    }
    await setUserLocale(uid, lang);
    const u = t(lang);
    await ctx.answerCallbackQuery({ text: u.langSavedToast });
    const text = startWelcomeText(ctx, lang);
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: languageReplyMarkup(),
      });
    } catch {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: languageReplyMarkup(),
      });
    }
  });

  bot.callbackQuery(/^donate:/, async (ctx) => {
    await handleDonateCallback(ctx);
  });

  bot.callbackQuery(/^fbc:/, async (ctx) => {
    await handleFeedbackModeBack(ctx);
  });

  bot.callbackQuery(/^fb:/, async (ctx) => {
    await handleIdentificationFeedback(ctx);
  });

  bot.callbackQuery(/^svy:/, async (ctx) => {
    await handleSurveyCallback(ctx);
  });

  bot.callbackQuery(/^dbc:/, async (ctx) => {
    await handleDonateBroadcastConfirm(ctx);
  });

  /**
   * Buyruqlar sequentialize dan OLDIN — uzoq foto/matn qidiruvi tugamasidan /donate va /stats ishlaydi.
   */
  bot.command('start', async (ctx) => {
    const uid = ctx.from?.id;
    if (uid) {
      await upsertUser(uid, ctx.from?.username, ctx.from?.first_name);
      await markUserStarted(uid);
      await recordUserActivityDay(uid);
    }
    const startArg = parseStartPayload(ctx.message?.text);
    if (startArg === START_PAYLOAD_FEEDBACK) {
      await runFeedbackFlow(ctx);
      return;
    }
    const locale = uid ? await getUserLocale(uid) : DEFAULT_LOCALE;
    await ctx.reply(startWelcomeText(ctx, locale), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: languageReplyMarkup(),
    });
  });

  bot.command('help', async (ctx) => {
    const uid = ctx.from?.id;
    const locale = uid ? await getUserLocale(uid) : DEFAULT_LOCALE;
    await ctx.reply(t(locale).help, { parse_mode: 'HTML' });
  });

  bot.command('lang', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const locale = await getUserLocale(uid);
    await ctx.reply(startWelcomeText(ctx, locale), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: languageReplyMarkup(),
    });
  });

  bot.command('feedback', async (ctx) => {
    await runFeedbackFlow(ctx);
  });

  bot.command('cancel', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const pending = await getProblemReportPending(uid);
    const loc = await getUserLocale(uid);
    const fb = feedbackT(loc);
    if (!pending) {
      await ctx.reply(fb.cancelNothing, { parse_mode: 'HTML' });
      return;
    }
    await clearProblemReportPending(uid);
    await resetFeedbackNoStreak(uid);
    await ctx.reply(fb.cancelOk, { parse_mode: 'HTML' });
  });

  /** Yuborilgan so‘rovnoma xabarlarini o‘chirish (jurnalda `message_id` bo‘lsa) */
  bot.command('surveydelete', async (ctx) => {
    if (!isAdminTelegram(ctx.from?.id)) {
      await ctx.reply('⛔ Bu buyruq faqat admin uchun.');
      return;
    }
    const raw = ctx.message?.text ?? '';
    const arg = raw.replace(/^\/surveydelete(@\w+)?\s*/i, '').trim();
    await runSurveyDeleteCampaign(ctx, arg || null);
  });

  bot.command('donate', async (ctx) => {
    if (!process.env.ADMIN_TELEGRAM_ID?.trim()) {
      await ctx.reply('⚙️ ADMIN_TELEGRAM_ID .env da yo‘q — buyruq ishlamaydi.');
      return;
    }
    if (!isAdminTelegram(ctx.from?.id)) {
      await ctx.reply(
        '⛔ Bu buyruq faqat admin uchun.\n\n' +
          'Sizning Telegram ID `.env` dagi ADMIN_TELEGRAM_ID bilan mos kelmayapti (vergul bilan bir nechta ID ham yozish mumkin).'
      );
      return;
    }
    await ctx.reply(
      'Rostan <b>barcha</b> foydalanuvchilarga so‘rovnoma xabarini yubormoqchimisan?',
      {
        parse_mode: 'HTML',
        reply_markup: buildDonateBroadcastConfirmKeyboard(),
      }
    );
  });

  bot.command('stats', async (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID?.trim();
    if (adminId && !isAdminTelegram(ctx.from?.id)) {
      await safeReply(
        ctx,
        '⛔ /stats faqat admin uchun.\n\nYordam: /help yoki /start'
      );
      return;
    }

    try {
      const [aud, fb, blockedRes] = await Promise.all([
        getAudienceStats(),
        getIdentificationFeedbackStats(),
        getPostgresPool().query(`SELECT COUNT(*) AS cnt FROM users WHERE blocked_at IS NOT NULL`),
      ]);
      const fbTotal = fb.yes + fb.no;
      const blockedCount = Number(blockedRes.rows[0]?.cnt ?? 0);
      const pct = fbTotal > 0 ? Math.round((fb.yes / fbTotal) * 100) : 0;
      const activeUsers = aud.totalUsers - blockedCount;

      await ctx.reply(
        `📊 <b>Statistika</b>\n\n` +
          `👥 Jami: ${aud.totalUsers}  |  ✅ Aktiv: ${activeUsers}  |  🚫 Bloklagan: ${blockedCount}\n\n` +
          `Bugungi faollik\n` +
          `🟢 Bugun: ${aud.dau}\n` +
          `📅 Hafta: ${aud.wau}\n` +
          `🗓 Oy: ${aud.mau}\n\n` +
          `Natija\n` +
          `✅ To'g'ri: ${fb.yes}  ❌ Xato: ${fb.no}\n` +
          `🎯 Aniqlik: ${pct}%  (jami ${fbTotal} javob)`,
        { parse_mode: 'HTML' }
      );
    } catch {
      await safeReply(ctx, 'Statistika olishda xatolik. Keyinroq qayta urinib ko‘ring.');
    }
  });

  bot.command('ad', async (ctx) => {
    if (!isAdminTelegram(ctx.from?.id)) {
      await ctx.reply('⛔ Bu buyruq faqat admin uchun.');
      return;
    }

    const raw = ctx.message?.text ?? '';
    const arg = raw.replace(/^\/ad(@\w+)?\s*/i, '').trim().toLowerCase();

    if (!arg || arg === 'status') {
      const enabled = await isChannelPromoEnabled(true);
      await ctx.reply(
        `📣 Kanal reklama holati: <b>${enabled ? 'ON' : 'OFF'}</b>\n\n` +
          `Boshqaruv:\n` +
          `<code>/ad on</code> — yoqish\n` +
          `<code>/ad off</code> — o‘chirish\n` +
          `<code>/ad status</code> — holat\n` +
          `<code>/ad sendall</code> — hammaga bir martalik yuborish\n\n` +
          `Eslatma: auto-promo obuna bo‘lganlarga ko‘rinmaydi va bir userga tez-tez chiqmaydi.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (arg === 'on') {
      await setChannelPromoEnabled(true);
      await ctx.reply(
        '✅ Kanal reklama yoqildi.\n\n' +
          'Endi muvaffaqiyatli natijalardan keyin bot @kinovaai kanaliga obuna bo‘lish xabarini yuboradi.'
      );
      return;
    }

    if (arg === 'off') {
      await setChannelPromoEnabled(false);
      await ctx.reply('✅ Kanal reklama o‘chirildi.');
      return;
    }

    if (arg === 'sendall' || arg === 'broadcast') {
      const adminUid = ctx.from?.id;
      const rows = await getPostgresPool().query(
        `SELECT telegram_id FROM users WHERE blocked_at IS NULL ORDER BY telegram_id ASC`
      );
      const ids = Array.from(
        new Set(
          (rows.rows
            .map((r) => Number(r.telegram_id))
            .filter((n) => Number.isFinite(n) && n > 0) as number[]).concat(
            adminUid != null ? [adminUid] : []
          )
        )
      );

      const total = ids.length;
      let skippedAlreadySent = 0;
      let ok = 0;
      let fail = 0;
      let failChatNotFound = 0;
      let failBlocked = 0;
      let failOther = 0;

      const progress = await ctx.reply(
        `⏳ <b>Kanal reklama xabari yuborilmoqda…</b>\nJarayon: 0 / ${total}`,
        { parse_mode: 'HTML' }
      );

      const classify = (e: unknown): 'chat_not_found' | 'blocked' | 'other' => {
        const raw =
          e instanceof GrammyError ? e.description : e instanceof Error ? e.message : String(e);
        const m = raw.toLowerCase();
        if (m.includes('chat not found')) return 'chat_not_found';
        if (m.includes('403') || m.includes('forbidden') || m.includes('blocked by the user') || m.includes('bot was blocked')) {
          return 'blocked';
        }
        return 'other';
      };

      for (let i = 0; i < ids.length; i++) {
        const chatId = ids[i]!;
        const st = await getUserChannelPromoState(chatId);
        if (st?.broadcastSentAt != null) {
          skippedAlreadySent++;
          continue;
        }
        try {
          const promoLoc = await getUserLocale(chatId);
          await Promise.race([
            ctx.api.sendMessage(chatId, getChannelPromoMessageHtml(promoLoc), {
              parse_mode: 'HTML',
              reply_markup: getChannelPromoKeyboard(promoLoc),
              link_preview_options: { is_disabled: true },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('sendMessage timeout')), 12000)
            ),
          ]);
          ok++;
          await markUserChannelPromoBroadcastSent(chatId, Math.floor(Date.now() / 1000));
        } catch (e) {
          fail++;
          const kind = classify(e);
          if (kind === 'chat_not_found') failChatNotFound++;
          else if (kind === 'blocked') failBlocked++;
          else failOther++;
          if (kind === 'blocked') {
            await getPostgresPool()
              .query(`UPDATE users SET blocked_at = COALESCE(blocked_at, NOW()) WHERE telegram_id = $1`, [chatId])
              .catch(() => {});
          }
        }

        if ((i + 1) % 25 === 0 || i === ids.length - 1) {
          await ctx.api
            .editMessageText(
              progress.chat.id,
              progress.message_id,
              `⏳ <b>Kanal reklama xabari yuborilmoqda…</b>\n` +
                `Jarayon: ${i + 1} / ${total}\n` +
                `✅ ${ok}  |  ⚠️ ${fail}` +
                `\n⏭ ${skippedAlreadySent} (oldin yuborilgan)`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 35));
      }

      await ctx.api
        .editMessageText(
          progress.chat.id,
          progress.message_id,
          `📣 <b>Kanal reklama yuborildi</b>\n` +
            `✅ Muvaffaqiyat: ${ok}\n` +
            `⚠️ Xato: ${fail}\n` +
            `⏭ Skip (oldin yuborilgan): ${skippedAlreadySent}\n` +
            `Jami candidate: ${total}\n\n` +
            `<b>Xatolar tafsiloti</b>\n` +
            `· chat not found: ${failChatNotFound}\n` +
            `· blocked: ${failBlocked}\n` +
            `· other: ${failOther}`,
          { parse_mode: 'HTML' }
        )
        .catch(async () => {
          await ctx.reply(
            `📣 Yuborish yakunlandi: ✅ ${ok} | ⚠️ ${fail} (jami ${total})`
          );
        });
      return;
    }

    await ctx.reply(
      '❓ Noto‘g‘ri format.\n\n' +
        'To‘g‘ri ishlatish:\n' +
        '<code>/ad on</code>\n' +
        '<code>/ad off</code>\n' +
        '<code>/ad status</code>\n' +
        '<code>/ad sendall</code>',
      { parse_mode: 'HTML' }
    );
  });

  bot.on('my_chat_member', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    if (newStatus === 'kicked') {
      await getPostgresPool().query(
        `UPDATE users SET blocked_at = NOW() WHERE telegram_id = $1`,
        [uid]
      );
    } else if (newStatus === 'member') {
      await getPostgresPool().query(
        `UPDATE users SET blocked_at = NULL WHERE telegram_id = $1`,
        [uid]
      );
    }
  });

  const messagePipeline = new Composer();
  messagePipeline.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'unknown'));
  messagePipeline.on('message:photo', handlePhoto);
  messagePipeline.on('message:document', async (ctx) => {
    const uid = ctx.from?.id;
    if (uid && (await getProblemReportPending(uid))) {
      const doc = ctx.message?.document;
      if (!doc?.mime_type?.startsWith('image/')) {
        const loc = await getUserLocale(uid);
        await ctx.reply(feedbackT(loc).wrongMedia, { parse_mode: 'HTML' });
        return;
      }
    }
    const doc = ctx.message?.document;
    if (!doc?.mime_type?.startsWith('image/')) {
      const loc = uid ? await getUserLocale(uid) : DEFAULT_LOCALE;
      await ctx.reply(feedbackT(loc).documentNotImage);
      return;
    }
    await handlePhoto(ctx);
  });
  /** Shikoyat rejimida matn/rasmdan boshqa tur */
  messagePipeline.on(
    [
      'message:voice',
      'message:video',
      'message:video_note',
      'message:animation',
      'message:audio',
      'message:sticker',
      'message:poll',
      'message:location',
      'message:venue',
      'message:contact',
      'message:dice',
      'message:game',
    ],
    handleProblemReportUnsupportedMedia
  );
  messagePipeline.on('message:text', handleText);
  bot.use(messagePipeline);

  bot.catch((err) => {
    void (async () => {
      const ctx = err.ctx;
      console.error(`Bot xato (update ${ctx.update.update_id}):`);
      if (err.error instanceof GrammyError) {
        console.error('Grammy xato:', err.error.description);
      } else if (err.error instanceof HttpError) {
        console.error('HTTP xato:', err.error);
      } else {
        console.error("Noma'lum xato:", err.error);
      }
      const g = err.error instanceof GrammyError ? err.error.description : '';
      if (g.includes('query is too old') || g.includes('query ID is invalid')) return;

      const uid = ctx.from?.id;
      const loc = uid ? await getUserLocale(uid).catch(() => DEFAULT_LOCALE) : DEFAULT_LOCALE;
      const u = t(loc);
      if (ctx.callbackQuery) {
        void ctx
          .answerCallbackQuery({
            text: u.callbackError,
            show_alert: true,
          })
          .catch(() => {
            if (ctx.chat?.id) void safeReply(ctx, u.fallbackError);
          });
        return;
      }
      if (ctx.message) {
        void safeReply(ctx, u.fallbackError);
      }
    })();
  });

  // Railway / Docker SIGTERM/SIGINT — botni tozalab yopish
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} qabul qilindi — bot yopilmoqda...`);
    try {
      await runnerHandle?.stop();
      console.log("✅ Bot to'xtatildi.");
    } catch (e) {
      console.error("Bot to'xtatishda xato:", e);
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT',  () => void shutdown('SIGINT'));

  /**
   * `bot.start()` barcha update'larni ketma-ket qayta ishlaydi — bir nechta
   * foydalanuvchi uzoq foto/LLM jarayonida bo‘lsa, boshqa userlar callback
   * tugmalari 10s dan kech chiqadi va Telegram "query is too old" beradi.
   * `run()` parallel sink (default ~500) — `sequentialize` har bir user uchun
   * tartibni saqlaydi.
   */
  await bot.init();
  await bot.api.deleteWebhook({
    drop_pending_updates: true,
  });

  const concurrency = Math.min(
    500,
    Math.max(10, Number(process.env.BOT_CONSUMER_CONCURRENCY || 100))
  );

  console.log('🤖 Kinova Bot ishga tushmoqda...');
  runnerHandle = run(bot, {
    sink: { concurrency },
  });

  const me = await bot.api.getMe();
  console.log(`✅ Bot ishga tushdi: @${me.username} (parallel update: ${concurrency})`);

  const task = runnerHandle.task();
  if (task) await task;
}

void bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
