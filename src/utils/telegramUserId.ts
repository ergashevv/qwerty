/**
 * Postgres `BIGINT` node-pg da ko‘pincha string qaytadi — Telegram API uchun yagona raqam.
 * Noto‘g‘ri qiymatni erta ushlaymiz.
 */
export function parseTelegramUserIdFromDb(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 && Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}
