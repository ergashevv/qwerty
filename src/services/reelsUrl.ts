import crypto from 'crypto';

function stripUrlNoise(raw: string): string {
  return raw
    .trim()
    .replace(/^<+|>+$/g, '')
    .replace(/^[("'`]+/g, '')
    .replace(/[)"'`,.!?]+$/g, '');
}

function ensureUrlProtocol(raw: string): string {
  const cleaned = stripUrlNoise(raw);
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function canonicalInstagramVideoUrl(rawUrl: string, depth = 0): string | null {
  if (depth > 2) return null;
  let u: URL;
  try {
    u = new URL(ensureUrlProtocol(rawUrl));
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'l.instagram.com' || host === 'lm.instagram.com') {
    const redirected = u.searchParams.get('u') || u.searchParams.get('url');
    return redirected ? canonicalInstagramVideoUrl(redirected, depth + 1) : null;
  }

  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;

  const parts = u.pathname
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const kind = parts[0].toLowerCase();
  const canonicalKind =
    kind === 'reels' ? 'reel' :
    kind === 'reel' || kind === 'p' || kind === 'tv' ? kind :
    null;
  if (canonicalKind && parts[1]) {
    return `https://www.instagram.com/${canonicalKind}/${parts[1]}/`;
  }

  if (kind === 'share' && parts.length >= 3) {
    const shareKind = parts[1].toLowerCase();
    if (shareKind === 'reel' || shareKind === 'p' || shareKind === 'tv') {
      return `https://www.instagram.com/share/${shareKind}/${parts[2]}/`;
    }
  }

  return null;
}

/**
 * Instagram / YouTube havolasini kesh kaliti uchun barqaror qilib beradi (tracking parametrlarsiz).
 */
export function normalizeVideoUrlForCache(url: string): string {
  const t = url.trim();
  try {
    const instagram = canonicalInstagramVideoUrl(t);
    if (instagram) return instagram;

    const u = new URL(ensureUrlProtocol(t));
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
    if ((host === 'youtube.com' || host === 'm.youtube.com') && u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
        return `https://www.youtube.com/shorts/${id}`;
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
  const matches = text.matchAll(/(?:https?:\/\/)?(?:[\w-]+\.)?instagram\.com\/[^\s<>()]+/gi);
  for (const match of matches) {
    const canonical = canonicalInstagramVideoUrl(match[0]);
    if (canonical) return canonical;
  }
  return null;
}

/** Birinchi http(s) havolasini olib tashlab, qolgan matnni izoh sifatida qaytaradi (matn + havola). */
export function extractUserHintBesideFirstUrl(text: string): string | null {
  const stripped = text
    .trim()
    .replace(/(?:https?:\/\/[^\s]+|(?:www\.)?(?:instagram\.com|l\.instagram\.com|lm\.instagram\.com|youtube\.com|m\.youtube\.com|youtu\.be)\/[^\s]+)/i, '')
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
