/**
 * Matndan birinchi Instagram Reels havolasini ajratadi (query qismini olib tashlaydi).
 */
export function extractInstagramReelUrl(text: string): string | null {
  const m = text.match(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels)\/([A-Za-z0-9_-]+)/i
  );
  if (!m) return null;
  return `https://www.instagram.com/reel/${m[1]}/`;
}
