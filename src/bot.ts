import 'dotenv/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { handlePhoto } from './handlers/photo';
import { handleText } from './handlers/text';
import { getDb } from './db';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN topilmadi! .env faylni tekshiring.');
  process.exit(1);
}

// DB ni ishga tushirish
getDb();
console.log('✅ Database tayyor');

const bot = new Bot(token);

// Bir foydalanuvchidan ketma-ket so'rovlar aralashib ketmasligi uchun
// har bir foydalanuvchining so'rovlari navbatma-navbat bajariladi
bot.use(sequentialize((ctx) => ctx.from?.id?.toString() ?? 'unknown'));

// ─── /start ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const name = ctx.from?.first_name || 'Do\'stim';
  await ctx.reply(
    `👋 Assalomu alaykum, <b>${name}</b>!\n\n` +
    `🎬 Men <b>Kinova Bot</b>man — istalgan film yoki serialning kadridan uni topib beraman.\n\n` +
    `<b>Qanday foydalanish:</b>\n` +
    `📸 Film yoki serialdan screenshot yuboring\n` +
    `✍️ Yoki film nomi / tavsifini yozing\n\n` +
    `Bot filmni tanib, <b>o'zbek tilida</b> tomosha qilish havolalarini topib beradi! 🇺🇿`,
    { parse_mode: 'HTML' }
  );
});

// ─── /help ───────────────────────────────────────────────────────────────────
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
    `<b>Natijada:</b>\n` +
    `🎬 Film nomi (o'zbekcha)\n` +
    `📖 Qisqacha mazmun\n` +
    `▶️ O'zbek tilida tomosha qilish havolalari`,
    { parse_mode: 'HTML' }
  );
});

// ─── /stats (admin) ──────────────────────────────────────────────────────────
bot.command('stats', async (ctx) => {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (adminId && ctx.from?.id.toString() !== adminId) return;

  try {
    const db = getDb();
    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const cacheCount = (db.prepare('SELECT COUNT(*) as c FROM movie_cache').get() as { c: number }).c;
    const topFilms = db.prepare('SELECT title, hit_count FROM movie_cache ORDER BY hit_count DESC LIMIT 5').all() as { title: string; hit_count: number }[];
    const totalRequests = (db.prepare('SELECT SUM(request_count) as s FROM users').get() as { s: number | null }).s || 0;

    const topList = topFilms.map((f, i) => `${i + 1}. ${f.title} (${f.hit_count} marta)`).join('\n');

    await ctx.reply(
      `📊 <b>Statistika</b>\n\n` +
      `👥 Foydalanuvchilar: ${userCount}\n` +
      `🎬 Cache da filmlar: ${cacheCount}\n` +
      `🔢 Jami so'rovlar: ${totalRequests}\n\n` +
      `🏆 <b>Top 5 film:</b>\n${topList || 'Hali yo\'q'}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply('Statistika olishda xatolik.');
  }
});

// ─── PHOTO HANDLER ────────────────────────────────────────────────────────────
bot.on('message:photo', handlePhoto);

// Document sifatida yuborilgan rasmlar (uncompress)
bot.on('message:document', async (ctx) => {
  const doc = ctx.message?.document;
  if (!doc?.mime_type?.startsWith('image/')) {
    await ctx.reply('📸 Iltimos, rasm yuboring (screenshot yoki foto).');
    return;
  }
  // Document ni photo kabi qayta ishlash
  await handlePhoto(ctx);
});

// ─── TEXT HANDLER ─────────────────────────────────────────────────────────────
bot.on('message:text', handleText);

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Bot xato (update ${ctx.update.update_id}):`);
  if (err.error instanceof GrammyError) {
    console.error('Grammy xato:', err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error('HTTP xato:', err.error);
  } else {
    console.error('Noma\'lum xato:', err.error);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
console.log('🤖 Kinova Bot ishga tushmoqda...');
bot.start({
  onStart: (info) => console.log(`✅ Bot ishga tushdi: @${info.username}`),
});
