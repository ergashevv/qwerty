import { Context, InputFile } from 'grammy';
import { getPendingFeedbackByToken } from '../db/feedbackPending';
import { getCached, getCachedByTmdb } from '../db';
import { renderShareCardPng } from '../services/shareCardImage';

const PREFIX = 'shc:';

export async function handleShareCard(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(PREFIX)) return;

  const token = data.slice(PREFIX.length);
  const uid = ctx.from?.id;
  if (!uid || token.length < 16) {
    await ctx.answerCallbackQuery({ text: 'Noto‘g‘ri.', show_alert: true });
    return;
  }

  const row = await getPendingFeedbackByToken(uid, token);
  if (!row) {
    await ctx.answerCallbackQuery({
      text: 'Bu kartaning muddati tugagan. Qayta qidiring.',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Karta tayyorlanmoqda…' });

  let posterUrl: string | null = null;
  try {
    const tmdbId = row.tmdb_id;
    const mt = row.media_type === 'tv' ? 'tv' : 'movie';
    if (tmdbId != null) {
      const c = await getCachedByTmdb(tmdbId, mt);
      if (c?.poster_url) posterUrl = c.poster_url;
    }
    if (!posterUrl) {
      const c2 = await getCached(row.predicted_title);
      if (c2?.poster_url) posterUrl = c2.poster_url;
    }
  } catch {
    /* ignore */
  }

  try {
    const png = await renderShareCardPng({
      posterUrl,
      title: row.predicted_title,
      uzTitle: row.predicted_uz_title,
    });

    await ctx.replyWithPhoto(new InputFile(png, 'kinova-share.jpg'), {
      caption: '📤 <b>Kinova</b> — Story yoki do‘stlarga yuborish uchun.',
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('shareCard:', (e as Error).message);
    await ctx.reply('⚠️ Kartani yaratib bo‘lmadi. Keyinroq qayta urinib ko‘ring.');
  }
}
