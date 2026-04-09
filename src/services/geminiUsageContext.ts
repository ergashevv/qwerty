import { AsyncLocalStorage } from 'async_hooks';

export interface GeminiUsageContextStore {
  telegramId: number;
}

type GeminiUsageStore = GeminiUsageContextStore;

const storage = new AsyncLocalStorage<GeminiUsageStore>();

/** Bot handler ichida bir marta — ichki LLM/Gemini chaqiruvlari userga bog‘lanadi */
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
