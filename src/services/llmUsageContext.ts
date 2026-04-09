import { AsyncLocalStorage } from 'async_hooks';

export interface LlmUsageContextStore {
  telegramId: number;
}

const storage = new AsyncLocalStorage<LlmUsageContextStore>();

/** Bot handler ichida bir marta — Azure LLM chaqiruvlari token yozuvi uchun user ID */
export function runWithLlmUsageContext<T>(
  telegramId: number | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (telegramId == null || !Number.isFinite(telegramId)) {
    return fn();
  }
  return storage.run({ telegramId }, fn);
}

export function getLlmUsageTelegramId(): number | undefined {
  return storage.getStore()?.telegramId;
}
