/**
 * Foydalanuvchining oxirgi matn so'rovini qisqa vaqt saqlaydigan in-memory store.
 * Foto yuborishdan oldin matn yozgan bo'lsa, foto handler shu matnni context sifatida ishlatadi.
 */

interface TextContext {
  text: string;
  timestamp: number;
}

const store = new Map<number, TextContext>();

/** Matn xabar kelganda saqlash (handleText dan chaqiriladi) */
export function setUserTextContext(userId: number, text: string): void {
  store.set(userId, { text, timestamp: Date.now() });
}

/**
 * Foydalanuvchining so'nggi matni — faqat `maxAgeMs` ichida (default: 3 daqiqa).
 * Foto handler bu matnni hint sifatida ishlatadi.
 */
export function getRecentUserText(userId: number, maxAgeMs = 3 * 60 * 1000): string | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > maxAgeMs) {
    store.delete(userId);
    return null;
  }
  return entry.text;
}

/** Foto ishlov bergandan keyin kontekstni tozalash (takroriy ishlashni oldini olish) */
export function clearUserTextContext(userId: number): void {
  store.delete(userId);
}
