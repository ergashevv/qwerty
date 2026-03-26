/** Matn so'rovlari: har bir foydalanuvchi uchun oyna (sekund) — 12 soat */
export const REQUEST_WINDOW_SECONDS = 12 * 60 * 60;

/** Matn: oynadagi maksimal so'rovlar */
export const USER_REQUEST_LIMIT = 3;

/**
 * Rasm: bir film qidirganda 3–4 ta screenshot + zaxira.
 * Qisqa oynada burst (sekund) — masalan 15 daqiqa.
 */
export const PHOTO_BURST_WINDOW_SECONDS = parseInt(process.env.PHOTO_BURST_WINDOW_SECONDS || '900', 10);

/** Shu oynada maksimal rasm (6 = 3–4 urinish + zaxira) */
export const PHOTO_BURST_LIMIT = parseInt(process.env.PHOTO_BURST_LIMIT || '6', 10);

/** Kuniga maksimal rasm (spam oldini olish) */
export const PHOTO_DAILY_LIMIT = parseInt(process.env.PHOTO_DAILY_LIMIT || '80', 10);

/** Instagram Reels: har bir foydalanuvchi uchun oyna (sekund) — default 6 soat */
export const REELS_WINDOW_SECONDS = parseInt(process.env.REELS_WINDOW_SECONDS || String(6 * 60 * 60), 10);

/** Shu oynada maksimal Reels qidiruv (har urinish hisoblanadi) */
export const REELS_LIMIT_PER_WINDOW = parseInt(process.env.REELS_LIMIT_PER_WINDOW || '2', 10);

/**
 * Cheksiz limit — vergul bilan ajratilgan Telegram user id lar.
 * Env: UNLIMITED_TELEGRAM_IDS=123,456
 */
function parseUnlimitedIds(): Set<number> {
  const raw = process.env.UNLIMITED_TELEGRAM_IDS ?? '5737309471';
  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return new Set(ids);
}

const unlimitedIds = parseUnlimitedIds();

export function isUnlimitedUser(telegramId: number): boolean {
  return unlimitedIds.has(telegramId);
}
