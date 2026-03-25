/** Har bir foydalanuvchi uchun so'rovlar oynasi (sekund) — 12 soat */
export const REQUEST_WINDOW_SECONDS = 12 * 60 * 60;

/** Oynadagi maksimal so'rovlar (keyingi oynada qayta 3 ta) */
export const USER_REQUEST_LIMIT = 3;

/**
 * Cheksiz limit — vergul bilan ajratilgan Telegram user id lar.
 * Env: UNLIMITED_TELEGRAM_IDS=123,456
 */
function parseUnlimitedIds(): Set<number> {
  const raw = process.env.UNLIMITED_TELEGRAM_IDS ?? '5737309471';
  const ids = raw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
  return new Set(ids);
}

const unlimitedIds = parseUnlimitedIds();

export function isUnlimitedUser(telegramId: number): boolean {
  return unlimitedIds.has(telegramId);
}
