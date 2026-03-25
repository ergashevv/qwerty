import { Context } from 'grammy';
import axios from 'axios';
import { identifyMovie, getMovieDetails, MovieDetails } from '../services/movieService';
import { getCached, setCache, upsertUser, incrementUserRequests } from '../db';

const DAILY_LIMIT = 30;

export async function handlePhoto(ctx: Context): Promise<void> {
  const userId  = ctx.from?.id;
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;

  if (!userId) return;

  upsertUser(userId, username, firstName);
  const count = incrementUserRequests(userId);

  if (count > DAILY_LIMIT) {
    await ctx.reply(
      `⚠️ Kunlik limitga yetdingiz (${DAILY_LIMIT} ta so'rov). Ertaga qayta urinib ko'ring.`
    );
    return;
  }

  const processing = await ctx.reply('🔍 Qidirilmoqda...');

  try {
    // Telegram dan eng katta o'lchamdagi rasmni olish
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, '❌ Rasm topilmadi.');
      return;
    }

    const largest = photos[photos.length - 1];
    const fileInfo = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;

    // Rasmni yuklab olish va base64 ga o'girish
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(response.data).toString('base64');
    const mimeType = 'image/jpeg';

    await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, '🎬 Film aniqlanmoqda...');

    // Film aniqlanish
    const identified = await identifyMovie(base64, mimeType);

    if (!identified) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processing.message_id,
        '❌ Bu kadrdan filmni ishonchli aniqlay olmadim.\n\n' +
          '📸 Yaxshiroq kadr yuboring: yuz va sahna aniq, kam watermark.\n' +
          '✍️ Yoki filmni qisqacha tasvirlab yozing (nom, aktyor, yil) — matn orqali qidiraman.'
      );
      return;
    }

    await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, `🎯 "${identified.title}" topildi! Ma'lumotlar yuklanmoqda...`);

    // Cache tekshirish
    const cached = getCached(identified.title);
    let details: MovieDetails;

    if (cached) {
      details = {
        title: cached.title,
        uzTitle: cached.uz_title || cached.title,
        originalTitle: cached.original_title || cached.title,
        year: cached.year || '',
        rating: cached.rating || 'N/A',
        posterUrl: cached.poster_url || null,
        plotUz: cached.plot_uz || 'Tavsif mavjud emas',
        imdbUrl: cached.imdb_url || null,
        watchLinks: cached.watch_links ? JSON.parse(cached.watch_links) : [],
      };
    } else {
      details = await getMovieDetails(identified);
      setCache(identified.title, {
        title: details.title,
        uz_title: details.uzTitle,
        original_title: details.originalTitle,
        year: details.year,
        poster_url: details.posterUrl || undefined,
        plot_uz: details.plotUz,
        watch_links: JSON.stringify(details.watchLinks),
        rating: details.rating,
        imdb_url: details.imdbUrl || undefined,
      });
    }

    // Processing xabarini o'chirish
    await ctx.api.deleteMessage(ctx.chat!.id, processing.message_id);

    // Javob yuborish
    await sendMovieResult(ctx, details);
  } catch (err) {
    console.error('Photo handler xato:', err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processing.message_id,
      '❌ Xatolik yuz berdi. Qayta urinib ko\'ring.'
    ).catch(() => {});
  }
}

export async function sendMovieResult(ctx: Context, details: MovieDetails): Promise<void> {
  const title    = details.uzTitle !== details.title ? details.uzTitle : details.title;
  const origLine = details.originalTitle && details.originalTitle !== details.title
    ? `\n📽 Asl nomi: <b>${escHtml(details.originalTitle)}</b>` : '';
  const yearLine  = details.year ? ` | 📅 ${details.year}` : '';
  const ratingLine = details.rating !== 'N/A' ? ` | ⭐ ${details.rating}/10` : '';

  const caption = [
    `🎬 <b>${escHtml(title)}</b>${origLine}`,
    `${yearLine}${ratingLine}`.trim(),
    ``,
    `📖 ${escHtml(details.plotUz.slice(0, 300))}${details.plotUz.length > 300 ? '...' : ''}`,
  ].filter(Boolean).join('\n');

  // Inline keyboard — tomosha qilish havolalari
  const watchButtons = details.watchLinks.slice(0, 4).map(link => ([{
    text: `▶️ ${link.source}`,
    url: link.link,
  }]));

  if (details.imdbUrl) {
    watchButtons.push([{ text: '🌐 IMDb', url: details.imdbUrl }]);
  }

  if (watchButtons.length === 0) {
    watchButtons.push([{ text: '🔍 Google da qidirish', url: `https://www.google.com/search?q=${encodeURIComponent(details.uzTitle + ' o\'zbek tilida tomosha')}` }]);
  }

  const replyMarkup = { inline_keyboard: watchButtons };

  try {
    if (details.posterUrl) {
      await ctx.replyWithPhoto(details.posterUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } else {
      await ctx.reply(caption, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }
  } catch {
    // Poster yuklab bo'lmasa, matnsiz jo'natish
    await ctx.reply(caption, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
