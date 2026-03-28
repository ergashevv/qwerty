/**
 * Gemini chaqiruvlari: global navbat + daqiqada RPM uchun oralig',
 * 429 uchun qayta urinish (backoff + Retry-After).
 * Tier ~1000 RPM bo'lsa ham, foydalanuvchiga tartib — oldindan cheklash.
 */

/** Default 10 — navbat qisqaroq; 429 ko‘p bo‘lsa GEMINI_MAX_CONCURRENT kamaytiring yoki API tier oshiring */
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.GEMINI_MAX_CONCURRENT || '10', 10));
/** Ketma-ket chaqiruvlar orasidagi minimal pause (ms) — burstni yumshatadi */
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
    const tryRun = () => {
      if (active < MAX_CONCURRENT) {
        active++;
        resolve();
        return;
      }
      waiters.push(() => {
        active++;
        resolve();
      });
    };
    tryRun();
  });
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

function isRateLimitError(e: unknown): boolean {
  const any = e as { status?: number; statusCode?: number; code?: number; message?: string; errorDetails?: unknown };
  if (any.status === 429 || any.statusCode === 429 || any.code === 429) return true;
  const msg = String(any.message ?? e);
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Too Many Requests')) return true;
  return false;
}

function shouldNotRetry(e: unknown): boolean {
  const any = e as { status?: number; statusCode?: number };
  const s = any.status ?? any.statusCode;
  if (s === 400 || s === 404 || s === 403) return true;
  return false;
}

function getRetryDelayMs(e: unknown, attempt: number): number {
  const any = e as { errorDetails?: Array<{ retryDelay?: string }> };
  const details = any.errorDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
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

/**
 * Barcha model.generateContent chaqiruvlari shu wrapper orqali.
 */
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
        console.warn(`Gemini 429 / limit — ${delay}ms keyin qayta urinish (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        attempt++;
      }
    }
  } finally {
    releaseSlot();
  }
}
