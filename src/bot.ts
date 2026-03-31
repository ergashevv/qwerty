import 'dotenv/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
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
import { handleDonateCallback } from './handlers/donatePrompt';
import {
  buildDonateBroadcastConfirmKeyboard,
  handleDonateBroadcastConfirm,
  handleSurveyCallback,
  runSurveyDeleteCampaign,
} from './handlers/surveyBroadcast';
import { isAdminTelegram } from './utils/isAdmin';

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
  } catch (e) {
    console.error('❌ Postgres:', (e as Error).message);
    process.exit(1);
  }

  const bot = new Bot(botToken);

  /**
   * Callback query'lar sequentialize dan OLDIN ishlov olishi kerak.
   * Sabab: sequentialize bir user'dan kelgan barcha update'larni navbatga qo'yadi.
   * Agar foto/matn 15-20 sek ishlayotgan bo'lsa, user ✅/❌ tugmasini bosganda
   * callback query ham navbatda kutadi → 10 sek o'tgach Telegram "query is too old" beradi.
   */
  bot.callbackQuery(/^donate:/, async (ctx) => {
    await handleDonateCallback(ctx);
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
    const name = ctx.from?.first_name || "Do'stim";
    await ctx.reply(
      `👋 Assalomu alaykum, <b>${name}</b>!\n\n` +
        `🎬 Men <b>Kinova Bot</b>man — istalgan film yoki serialning kadridan uni topib beraman.\n\n` +
        `<b>Qanday foydalanish:</b>\n` +
        `📸 Film yoki serialdan screenshot yuboring\n` +
        `🔗 Yoki Instagram <b>Reels</b> havolasini yuboring\n` +
        `✍️ Yoki film nomi / tavsifini yozing\n\n` +
        `Bot filmni tanib, <b>o'zbek tilida</b> tomosha qilish havolalarini topib beradi! 🇺🇿`,
      { parse_mode: 'HTML' }
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
        `<b>Instagram Reels:</b>\n` +
        `Reels havolasini xabar qilib yuboring. Limit: 2 ta / 6 soat (cheksiz ID lar bundan mustasno).\n\n` +
        `<b>Natijada:</b>\n` +
        `🎬 Film nomi (o'zbekcha)\n` +
        `📖 Qisqacha mazmun\n` +
        `▶️ O'zbek tilida tomosha qilish havolalari`,
      { parse_mode: 'HTML' }
    );
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
    if (adminId && !isAdminTelegram(ctx.from?.id)) return;

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
      await ctx.reply('Statistika olishda xatolik.');
    }
  });

  bot.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'unknown'));

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

  bot.on('message:photo', handlePhoto);

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    if (!doc?.mime_type?.startsWith('image/')) {
      await ctx.reply('📸 Iltimos, rasm yuboring (screenshot yoki foto).');
      return;
    }
    await handlePhoto(ctx);
  });

  bot.on('message:text', handleText);

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
    /** Callback allaqachon yopilmagan bo'lsa yoki "query is too old" — qo'shimcha xabar spam qilmaymiz */
    const g = err.error instanceof GrammyError ? err.error.description : '';
    if (g.includes('query is too old') || g.includes('query ID is invalid')) return;
    if (ctx.callbackQuery) return;
    if (ctx.message) {
      void ctx.reply("⚠️ Vaqtincha xatolik. Birozdan keyin qayta urinib ko'ring.").catch(() => {});
    }
  });

  // Railway / Docker SIGTERM/SIGINT — botni tozalab yopish
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} qabul qilindi — bot yopilmoqda...`);
    try {
      await bot.stop();
      console.log("✅ Bot to'xtatildi.");
    } catch (e) {
      console.error("Bot to'xtatishda xato:", e);
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT',  () => void shutdown('SIGINT'));

  console.log('🤖 Kinova Bot ishga tushmoqda...');
  await bot.start({
    onStart: (info) => console.log(`✅ Bot ishga tushdi: @${info.username}`),
    // Bot qayta ishlaganda Telegram eski (allaqachon muddati o'tgan) update'larni
    // yuboradi — callback query'lar darhol "query is too old" beradi.
    // Bu parametr restart paytidagi eski update'larni tashlab ketadi.
    drop_pending_updates: true,
  });
}

void bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
