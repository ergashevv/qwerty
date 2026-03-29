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

  bot.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'unknown'));

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

  bot.command('stats', async (ctx) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId && ctx.from?.id.toString() !== adminId) return;

    try {
      const aud = await getAudienceStats();
      const fb = await getIdentificationFeedbackStats();
      const fbTotal = fb.yes + fb.no;
      const blockedRes = await getPostgresPool().query(
        `SELECT COUNT(*) AS cnt FROM users WHERE blocked_at IS NOT NULL`
      );
      const blockedCount = Number(blockedRes.rows[0]?.cnt ?? 0);

      const pct = fbTotal > 0 ? Math.round((fb.yes / fbTotal) * 100) : 0;

      const nowUtc = new Date();
      const utcDateStr = nowUtc.toISOString().slice(0, 10);           // "2026-03-29"
      const utcTimeStr = nowUtc.toISOString().slice(11, 16) + ' UTC'; // "10:23 UTC"

      await ctx.reply(
        `📊 <b>Statistika</b>\n` +
          `<i>🕐 ${utcTimeStr} | Sana: ${utcDateStr}</i>\n` +
          `<i>(Bugun 00:00 UTC da yangilanadi — mahalliy 05:00)</i>\n\n` +
          `<b>Foydalanuvchilar</b>\n` +
          `👥 Jami akkauntlar: ${aud.totalUsers}\n` +
          `🚫 Bot bloklagan: ${blockedCount}\n\n` +
          `<b>Faollik (UTC kuni bo'yicha)</b>\n` +
          `Bugun [${utcDateStr}]: ${aud.dau}\n` +
          `Joriy hafta: ${aud.wau}\n` +
          `Joriy oy: ${aud.mau}\n\n` +
          `<b>Feedback natijasi</b>\n` +
          `✅ Ha (to'g'ri): ${fb.yes}\n` +
          `❌ Yo'q (noto'g'ri): ${fb.no}\n` +
          `📌 Jami: ${fbTotal}  |  🎯 Aniqlik: ${pct}%`,
        { parse_mode: 'HTML' }
      );
    } catch {
      await ctx.reply('Statistika olishda xatolik.');
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
