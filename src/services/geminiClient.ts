/**
 * Google Gemini (Generative AI) — Kinova multimodal/matn LLM yo'li.
 * GEMINI_API_KEY majburiy. Model: GEMINI_MODEL env (default: gemini-2.5-flash).
 *
 * Sozlamalar:
 *   GEMINI_API_KEY            — Google AI Studio yoki Vertex AI key
 *   GEMINI_MODEL              — model nomi (default: gemini-2.5-flash)
 *   GEMINI_MAX_CONCURRENT     — parallel slot soni (default: 8)
 *   GEMINI_MIN_GAP_MS         — chaqiruvlar orasidagi minimal pauz ms (default: 55)
 *   GEMINI_MAX_RETRIES        — 429/RESOURCE_EXHAUSTED qayta urinish soni (default: 4)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { recordGeminiUsage } from './geminiUsage';

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.GEMINI_MAX_CONCURRENT || '8', 10));
const MIN_GAP_MS = Math.max(0, parseInt(process.env.GEMINI_MIN_GAP_MS || '55', 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.GEMINI_MAX_RETRIES || '4', 10));

let active = 0;
const waiters: Array<() => void> = [];
let lastStart = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active++;
      resolve();
    } else {
      waiters.push(() => {
        active++;
        resolve();
      });
    }
  });
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

function isRateLimitError(e: unknown): boolean {
  const any = e as { status?: number; statusCode?: number; code?: number; message?: string };
  if (any.status === 429 || any.statusCode === 429 || any.code === 429) return true;
  const msg = String(any.message ?? e);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Too Many Requests');
}

function shouldNotRetry(e: unknown): boolean {
  const any = e as { status?: number; statusCode?: number };
  const s = any.status ?? any.statusCode;
  return s === 400 || s === 404 || s === 403;
}

function getRetryDelayMs(e: unknown, attempt: number): number {
  const any = e as { errorDetails?: Array<{ retryDelay?: string }> };
  if (Array.isArray(any.errorDetails)) {
    for (const d of any.errorDetails) {
      if (d?.retryDelay) {
        const sec = parseInt(String(d.retryDelay).replace(/s$/i, ''), 10);
        if (!Number.isNaN(sec) && sec > 0) return Math.min(sec * 1000, 120_000);
      }
    }
  }
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

export async function withGemini<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    const now = Date.now();
    const waitGap = Math.max(0, lastStart + MIN_GAP_MS - now);
    if (waitGap > 0) await sleep(waitGap);
    lastStart = Date.now();

    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (e) {
        if (shouldNotRetry(e) || !isRateLimitError(e) || attempt >= MAX_RETRIES) throw e;
        const delay = getRetryDelayMs(e, attempt);
        console.warn(`Gemini 429/RESOURCE_EXHAUSTED — ${delay}ms keyin qayta urinish (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        attempt++;
      }
    }
  } finally {
    releaseSlot();
  }
}

export function isGeminiConfigured(): boolean {
  return !!(process.env.GEMINI_API_KEY?.trim());
}

function geminiModelName(): string {
  return (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
}

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }
  return _genAI;
}

function safeMimeType(mimeType: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const raw = mimeType.toLowerCase();
  if (raw.includes('png')) return 'image/png';
  if (raw.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

function logGeminiFailure(operation: string, e: unknown): void {
  console.warn(`Gemini xato [${operation}]: ${String((e as Error)?.message ?? e).slice(0, 400)}`);
}

export async function geminiChatVision(
  operation: string,
  base64: string,
  mimeType: string,
  userPrompt: string,
  explicitTelegramId?: number,
): Promise<string> {
  const model = getGenAI().getGenerativeModel({
    model: geminiModelName(),
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  try {
    const result = await withGemini(() =>
      model.generateContent([
        { inlineData: { mimeType: safeMimeType(mimeType), data: base64 } },
        { text: userPrompt },
      ])
    );
    recordGeminiUsage(operation, result.response, explicitTelegramId);
    return result.response.text().trim();
  } catch (e) {
    logGeminiFailure(operation, e);
    throw e;
  }
}

export async function geminiChatText(
  operation: string,
  userText: string,
  explicitTelegramId?: number,
): Promise<string> {
  const model = getGenAI().getGenerativeModel({
    model: geminiModelName(),
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  try {
    const result = await withGemini(() => model.generateContent(userText));
    recordGeminiUsage(operation, result.response, explicitTelegramId);
    return result.response.text().trim();
  } catch (e) {
    logGeminiFailure(operation, e);
    throw e;
  }
}
