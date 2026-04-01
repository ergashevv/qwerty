import { AsyncLocalStorage } from 'async_hooks';

export interface GeminiUsageContextStore {
  telegramId: number;
}

const storage = new AsyncLocalStorage<GeminiUsageStore>();

type GeminiUsageStore = GeminiUsageContextStore;

/** Bot handler ichida bir marta — barcha ichki `movieService` Gemini chaqiruvlari userga bog‘lanadi */
export function runWithGeminiUsageContext<T>(
  telegramId: number | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (telegramId == null || !Number.isFinite(telegramId)) {
    return fn();
  }
  return storage.run({ telegramId }, fn);
}

export function getGeminiUsageTelegramId(): number | undefined {
  return storage.getStore()?.telegramId;
}
