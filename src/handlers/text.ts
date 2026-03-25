import { Context } from 'grammy';
import { identifyFromText, getMovieDetails } from '../services/movieService';
import { getCached, setCache, upsertUser, incrementUserRequests, getWindowRequestCount } from '../db';
import { sendMovieResult } from './photo';
import { USER_REQUEST_LIMIT, isUnlimitedUser } from '../config/limits';

export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;

  const userId = ctx.from?.id;
  if (!userId) return;

  upsertUser(userId, ctx.from?.username, ctx.from?.first_name);

  if (!isUnlimitedUser(userId)) {
    if (getWindowRequestCount(userId) >= USER_REQUEST_LIMIT) {
      await ctx.reply(
        `⚠️ So'rov limiti tugadi (${USER_REQUEST_LIMIT} ta / 12 soat).\n` +
          '⏳ 12 soatdan keyin yana 3 ta ochiladi.'
      );
      return;
    }
    incrementUserRequests(userId);
  }

  const processing = await ctx.reply('🔍 Qidirilmoqda...');

  try {
    const identified = await identifyFromText(text);

    if (!identified) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processing.message_id,
        '❌ Film topilmadi. Aniqroq yozing:\n• Film nomi (inglizcha yoki o\'zbekcha)\n• Aktyor ismi\n• Syujet tavsifi'
      );
      return;
    }

    await ctx.api.editMessageText(ctx.chat!.id, processing.message_id, `🎯 "${identified.title}" topildi! Yuklanmoqda...`);

    const cached = getCached(identified.title);
    let details;

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

    await ctx.api.deleteMessage(ctx.chat!.id, processing.message_id);
    await sendMovieResult(ctx, details);
  } catch (err) {
    console.error('Text handler xato:', err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processing.message_id,
      '❌ Xatolik yuz berdi. Qayta urinib ko\'ring.'
    ).catch(() => {});
  }
}
