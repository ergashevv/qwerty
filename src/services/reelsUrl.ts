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
