import crypto from 'crypto';

/**
 * Instagram / YouTube havolasini kesh kaliti uchun barqaror qilib beradi (tracking parametrlarsiz).
 */
export function normalizeVideoUrlForCache(url: string): string {
  const t = url.trim();
  try {
    const u = new URL(t);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
        return `https://www.youtube.com/watch?v=${v}`;
      }
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
        return `https://www.youtube.com/watch?v=${id}`;
      }
    }
    if (host === 'youtube.com' && u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
        return `https://www.youtube.com/shorts/${id}`;
      }
    }
    if (host.includes('instagram.com')) {
      const m = u.pathname.match(/\/(reel|reels|p)\/([^/?#]+)/i);
      if (m) {
        const kind = m[1].toLowerCase();
        const code = m[2];
        return kind === 'p'
          ? `https://www.instagram.com/p/${code}/`
          : `https://www.instagram.com/reel/${code}/`;
      }
    }
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return t;
  }
}

export function hashVideoUrlForCache(url: string): string {
  return crypto.createHash('sha256').update(normalizeVideoUrlForCache(url)).digest('hex');
}

/**
 * Matndan birinchi Instagram video havolasini ajratadi (Reels yoki /p/ post — ikkalasi ham video bo‘lishi mumkin).
 * Eski regex faqat /reel/ ni tutardi; /p/SHORTCODE havolalari matn qidiruvga tushib qolardi.
 */
export function extractInstagramReelUrl(text: string): string | null {
  const m = text.match(
    /https?:\/\/(?:www\.)?instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]+)/i
  );
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const code = m[2];
  if (kind === 'p') {
    return `https://www.instagram.com/p/${code}/`;
  }
  return `https://www.instagram.com/reel/${code}/`;
}

/** Birinchi http(s) havolasini olib tashlab, qolgan matnni izoh sifatida qaytaradi (matn + havola). */
export function extractUserHintBesideFirstUrl(text: string): string | null {
  const stripped = text
    .trim()
    .replace(/https?:\/\/[^\s]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 2 ? stripped : null;
}

/**
 * Matndan birinchi YouTube video havolasini ajratadi (watch, Shorts, youtu.be).
 * Qaytarilgan URL yt-dlp uchun barqaror shaklda.
 */
export function extractYouTubeUrl(text: string): string | null {
  const watch = text.match(/https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?[^\s]+/i);
  if (watch) {
    try {
      const u = new URL(watch[0]);
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
        return `https://www.youtube.com/watch?v=${v}`;
      }
    } catch {
      /* ignore */
    }
  }
  const short = text.match(/https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[^\s]*)?/i);
  if (short) {
    return `https://www.youtube.com/watch?v=${short[1]}`;
  }
  const shorts = text.match(/https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[^\s]*)?/i);
  if (shorts) {
    return `https://www.youtube.com/shorts/${shorts[1]}`;
  }
  return null;
}
