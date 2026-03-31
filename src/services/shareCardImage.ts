import sharp from 'sharp';
import axios from 'axios';

/**
 * TMDB poster havolasi bo‘lsa — `original` o‘lcham (to‘liq piksel).
 * Boshqa CDN lar uchun URL o‘zgarishsiz.
 */
export function resolvePosterUrlForShare(url: string): string {
  if (url.includes('image.tmdb.org') && /\/t\/p\/w\d+\//.test(url)) {
    return url.replace(/\/t\/p\/w\d+\//, '/t/p/original/');
  }
  return url;
}

/** Telegram: juda katta fayllarni yuborishdan oldin chegaralash (px, fit: inside). */
const MAX_W = 1920;
const MAX_H = 2880;

/**
 * Faqat poster rasmi — QR va footer yo‘q. Aspect ratio saqlanadi.
 */
export async function renderShareCardPng(opts: {
  posterUrl: string | null;
  title: string;
  uzTitle?: string | null;
}): Promise<Buffer> {
  void opts.title;
  void opts.uzTitle;

  if (!opts.posterUrl?.trim()) {
    return sharp({
      create: { width: 540, height: 810, channels: 3, background: { r: 26, g: 26, b: 46 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  const url = resolvePosterUrlForShare(opts.posterUrl.trim());

  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 12_000_000,
      validateStatus: (s) => s === 200,
      headers: { Accept: 'image/*' },
    });

    const input = sharp(Buffer.from(res.data));
    const meta = await input.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    if (w > 0 && h > 0 && (w > MAX_W || h > MAX_H)) {
      return input
        .resize(MAX_W, MAX_H, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
    }

    return input.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  } catch {
    return sharp({
      create: { width: 540, height: 810, channels: 3, background: { r: 26, g: 26, b: 46 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
  }
}
