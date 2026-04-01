import type { GenerateContentResult } from '@google/generative-ai';
import { getPostgresPool } from '../db/postgres';
import { getGeminiUsageTelegramId } from './geminiUsageContext';

const DISABLED = process.env.GEMINI_USAGE_RECORDING === 'false';

/**
 * Gemini javobidan token statistikasi — dashboard va byudjet tahlili uchun.
 * `usageMetadata` ba’zi xatolarda bo‘lmasligi mumkin.
 */
export function recordGeminiUsage(
  operation: string,
  response: GenerateContentResult['response'] | undefined,
  explicitTelegramId?: number
): void {
  if (DISABLED || !process.env.DATABASE_URL?.trim()) return;
  const u = response?.usageMetadata;
  const total = u?.totalTokenCount ?? 0;
  if (!u || total <= 0) return;

  const telegramId = explicitTelegramId ?? getGeminiUsageTelegramId();
  const prompt = u.promptTokenCount ?? 0;
  const out = u.candidatesTokenCount ?? 0;
  const now = Math.floor(Date.now() / 1000);

  void getPostgresPool()
    .query(
      `INSERT INTO gemini_usage (telegram_id, operation, prompt_tokens, output_tokens, total_tokens, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [telegramId ?? null, operation.slice(0, 64), prompt, out, total, now]
    )
    .catch((e) => console.warn('gemini_usage:', (e as Error).message?.slice(0, 120)));
}

export function tapGeminiGenerateContent(
  operation: string,
  promise: Promise<GenerateContentResult>,
  explicitTelegramId?: number
): Promise<GenerateContentResult> {
  return promise.then((result) => {
    recordGeminiUsage(operation, result.response, explicitTelegramId);
    return result;
  });
}
