import type { GenerateContentResult } from '@google/generative-ai';
import { getPostgresPool } from '../db/postgres';
import { getGeminiUsageTelegramId } from './geminiUsageContext';
import { getLlmUsageTelegramId } from './llmUsageContext';

const DISABLED =
  process.env.LLM_USAGE_RECORDING === 'false' || process.env.GEMINI_USAGE_RECORDING === 'false';

/** Testlar — usageMetadata shaklida mock */
export type LegacyGeminiGenerateResult = {
  response?: {
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    text?: () => string;
  };
};

function usageTelegramId(explicit?: number): number | undefined {
  if (explicit != null && Number.isFinite(explicit)) return explicit;
  return getLlmUsageTelegramId() ?? getGeminiUsageTelegramId();
}

type OpenAiUsageLike = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
} | null | undefined;

/** Azure OpenAI chat.completions — `gemini_usage` jadvaliga yoziladi (dashboard mos). */
export function recordOpenAiChatUsage(
  operation: string,
  usage: OpenAiUsageLike,
  explicitTelegramId?: number
): void {
  if (DISABLED || !process.env.DATABASE_URL?.trim()) return;
  const total = usage?.total_tokens ?? 0;
  if (!usage || total <= 0) return;

  const telegramId = usageTelegramId(explicitTelegramId);
  const prompt = usage.prompt_tokens ?? 0;
  const out = usage.completion_tokens ?? 0;
  const now = Math.floor(Date.now() / 1000);

  void getPostgresPool()
    .query(
      `INSERT INTO gemini_usage (telegram_id, operation, prompt_tokens, output_tokens, total_tokens, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [telegramId ?? null, `azure:${operation.slice(0, 56)}`, prompt, out, total, now]
    )
    .catch((e) => console.warn('gemini_usage (azure):', (e as Error).message?.slice(0, 120)));
}

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

  const telegramId = usageTelegramId(explicitTelegramId);
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
  promise: Promise<GenerateContentResult | LegacyGeminiGenerateResult>,
  explicitTelegramId?: number
): Promise<GenerateContentResult | LegacyGeminiGenerateResult> {
  return promise.then((result) => {
    recordGeminiUsage(operation, result.response as GenerateContentResult['response'] | undefined, explicitTelegramId);
    return result;
  });
}
