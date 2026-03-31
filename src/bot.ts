import 'dotenv/config';
import { Bot, Composer, GrammyError, HttpError, type Context } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { handlePhoto } from './handlers/photo';
import { handleText } from './handlers/text';
import {
  getAudienceStats,
  getIdentificationFeedbackStats,
  markUserStarted,
  pruneUserActivityHistory,
  recordUserActivityDay,
  upsertUser,
} from './db';
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
import {
  FEEDBACK_CANCEL_NOTHING_HTML,
  FEEDBACK_CANCEL_OK_HTML,
  FEEDBACK_PENDING_REMINDER_HTML,
  FEEDBACK_WRONG_MEDIA_HTML,
  FEEDBACK_WRITE_NEXT_HTML,
} from './messages/feedback';
import { handleProblemReportUnsupportedMedia } from './handlers/problemReportWrongMedia';
import { escHtml } from './handlers/photo';

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
  const kb = { reply_markup: feedbackModeReplyMarkup() };
  if (await getProblemReportPending(uid)) {
    await ctx.reply(FEEDBACK_PENDING_REMINDER_HTML, { parse_mode: 'HTML', ...kb });
    return;
  }
  await setFreeComplaintPending(uid);
  await ctx.reply(FEEDBACK_WRITE_NEXT_HTML, { parse_mode: 'HTML', ...kb });
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
    const name = ctx.from?.first_name || "Do'stim";
    const botU = ctx.me?.username ?? process.env.BOT_USERNAME?.replace(/^@/, '') ?? '';
    const feedbackLine = botU
      ? `<b>Shikoyat yoki taklif</b> — <a href="https://t.me/${botU}?start=${START_PAYLOAD_FEEDBACK}">/feedback</a>`
      : `<b>Shikoyat yoki taklif</b> — <code>/feedback</code>`;
    await ctx.reply(
      `Assalomu alaykum, <b>${escHtml(name)}</b>! 🎬\n\n` +
        `<b>Bu bot nima qiladi?</b>\n\n` +
        `Kadr, video havola yoki matndan filmni topib, o‘zbekcha tomosha havolalarini yuboraman.\n\n` +
        `<b>Yuborishingiz mumkin</b>\n` +
        `📸 Rasm — filmdan screenshot\n` +
        `🔗 Havola — Reels, YouTube\n` +
        `✍️ Matn — nom yoki qisqa tavsif\n\n` +
        `Va filmni berilgan havolalar orqali bemalol tomosha qilishingiz mumkin\n\n` +
        feedbackLine,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `ℹ️ <b>Yordam</b>\n\n` +
        `<b>Screenshot orqali:</b>\n` +
        `Film/serialdan istalgan kadrni yuboring. Bot aktyor yuzlarini, kostyum va sahnani tahlil qilib filmni topadi.\n\n` +
        `<b>Matn orqali:</b>\n` +
        `• Film nomi: <code>Iron Man 3</code>\n` +
        `• O'zbekcha: <code>Temir odam</code>\n` +
        `• Tavsif: <code>temir kostyumli qahramonli Marvel filmi</code>\n` +
        `• Aktyor: <code>Robert Downey Jr filmi</code>\n\n` +
        `<b>Video havola (Instagram / YouTube):</b>\n` +
        `Reels yoki YouTube (trailer, Shorts) havolasini yuboring. Matn bilan birga ham bo‘lishi mumkin. Limit: 2 ta / 6 soat (cheksiz ID lar bundan mustasno).\n\n` +
        `<b>Natijada:</b>\n` +
        `🎬 Film nomi (o'zbekcha)\n` +
        `📖 Qisqacha mazmun\n` +
        `▶️ Tomosha havolalari (tugmalar) · 📩 Ulashish (qisqa matn + bot havolasi)\n\n` +
        `<b>Fikr:</b> <b>✅ Ha, shu film</b> / <b>❌ Yo'q, bu emas</b>. ` +
        `<code>/feedback</code> / <b>Yo‘q</b> — keyingi xabar qisqa shikoyat (qidiruv emas).`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('feedback', async (ctx) => {
    await runFeedbackFlow(ctx);
  });

  bot.command('cancel', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const pending = await getProblemReportPending(uid);
    if (!pending) {
      await ctx.reply(FEEDBACK_CANCEL_NOTHING_HTML, { parse_mode: 'HTML' });
      return;
    }
    await clearProblemReportPending(uid);
    await resetFeedbackNoStreak(uid);
    await ctx.reply(FEEDBACK_CANCEL_OK_HTML, { parse_mode: 'HTML' });
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
          `<b>Bugungi faollik</b>\n` +
          `🟢 Bugun: ${aud.dau}\n` +
          `📅 Hafta: ${aud.wau}\n` +
          `🗓 Oy: ${aud.mau}\n\n` +
          `<b>Natija</b>\n` +
          `✅ To'g'ri: ${fb.yes}  ❌ Xato: ${fb.no}\n` +
          `🎯 Aniqlik: ${pct}%  (jami ${fbTotal} javob)`,
        { parse_mode: 'HTML' }
      );
    } catch {
      await safeReply(ctx, 'Statistika olishda xatolik. Keyinroq qayta urinib ko‘ring.');
    }
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
        await ctx.reply(FEEDBACK_WRONG_MEDIA_HTML, { parse_mode: 'HTML' });
        return;
      }
    }
    const doc = ctx.message?.document;
    if (!doc?.mime_type?.startsWith('image/')) {
      await ctx.reply('📸 Iltimos, rasm yuboring (screenshot yoki foto).');
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

    const fallback =
      "⚠️ Vaqtincha xatolik. Birozdan keyin qayta urinib ko'ring.";
    if (ctx.callbackQuery) {
      void ctx
        .answerCallbackQuery({
          text: 'Vaqtincha xatolik. Keyinroq qayta urinib ko‘ring.',
          show_alert: true,
        })
        .catch(() => {
          if (ctx.chat?.id) void safeReply(ctx, fallback);
        });
      return;
    }
    if (ctx.message) {
      void safeReply(ctx, fallback);
    }
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
   * foydalanuvchi uzoq foto/Gemini qidiruvida bo‘lsa, boshqa userlar callback
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
