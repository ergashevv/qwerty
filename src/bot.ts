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
import { initPostgresSchema, pingPostgres, runAnalyticsRetention } from './db/postgres';
import { handleIdentificationFeedback } from './handlers/feedback';

const _botToken = process.env.BOT_TOKEN;
if (!_botToken) {
  console.error('❌ BOT_TOKEN topilmadi! .env faylni tekshiring.');
  process.exit(1);
}
const botToken: string = _botToken;

if (!process.env.DATABASE_URL?.trim()) {
  console.error('❌ DATABASE_URL majburiy — barcha ma’lumotlar Postgres (Neon) da.');
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  try {
    await initPostgresSchema();
    await pruneUserActivityHistory();
    if (await pingPostgres()) console.log('✅ Postgres (Neon) tayyor');
    await runAnalyticsRetention();
  } catch (e) {
    console.error('❌ Postgres:', (e as Error).message);
    process.exit(1);
  }

  const bot = new Bot(botToken);

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

      await ctx.reply(
        `📊 <b>Statistika</b>\n\n` +
          `<b>Foydalanuvchilar</b>\n` +
          `👥 Jami akkauntlar: ${aud.totalUsers}\n\n` +
          `<b>Faollik (UTC)</b>\n` +
          `Bugun: ${aud.dau}\n` +
          `Joriy hafta: ${aud.wau}\n` +
          `Joriy oy: ${aud.mau}\n\n` +
          `<b>Result</b>\n` +
          `✅ To‘g‘ri topildi (Ha): ${fb.yes}\n` +
          `❌ Boshqa (Yo‘q): ${fb.no}\n` +
          `📌 Jami javob: ${fbTotal}`,
        { parse_mode: 'HTML' }
      );
    } catch {
      await ctx.reply('Statistika olishda xatolik.');
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

  bot.callbackQuery(/^fb:/, async (ctx) => {
    await handleIdentificationFeedback(ctx);
  });

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
  });

  console.log('🤖 Kinova Bot ishga tushmoqda...');
  await bot.start({
    onStart: (info) => console.log(`✅ Bot ishga tushdi: @${info.username}`),
  });
}

void bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
