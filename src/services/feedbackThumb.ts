import type { Context } from 'grammy';
import sharp from 'sharp';

const MAX_OUT_BYTES = 65_000;

/**
 * Fikr bosilganda Telegramdan rasmni olish va dashboard uchun kichik JPEG (base64).
 * Keyinroq getFile ishlamasa ham, saqlangan thumb ko‘rinadi.
 */
export async function tryBuildFeedbackThumbB64(ctx: Context, fileId: string | null): Promise<string | null> {
  const id = fileId?.trim();
  if (!id) return null;

  const token = process.env.BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    const file = await ctx.api.getFile(id);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 25 * 1024 * 1024) return null;

    let jpeg = await sharp(buf)
      .rotate()
      .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();

    if (jpeg.length > MAX_OUT_BYTES) {
      jpeg = await sharp(buf)
        .rotate()
        .resize(240, 240, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 68, mozjpeg: true })
        .toBuffer();
    }
    if (jpeg.length > MAX_OUT_BYTES) {
      jpeg = await sharp(buf)
        .resize(180, 180, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    }

    return jpeg.toString('base64');
  } catch (e) {
    console.warn('feedbackThumb:', (e as Error).message);
    return null;
  }
}
