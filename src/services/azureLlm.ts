/**
 * Azure OpenAI (Chat Completions) — Kinova multimodal/matn LLM yo‘li.
 * MUHIM: oddiy `OpenAI` klienti Bearer yuboradi; Azure esa `api-key` + to‘g‘ri URL
 * uchun `AzureOpenAI` ishlatiladi (vision ishlashi shart).
 *
 * Sozlamalar: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT.
 * Ixtiyoriy: AZURE_OPENAI_DEPLOYMENT_VISION — rasm uchun alohida deployment.
 */

import { AzureOpenAI, APIError } from 'openai';
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { recordOpenAiChatUsage } from './geminiUsage';

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AZURE_OPENAI_MAX_CONCURRENT || '8', 10));
const MIN_GAP_MS = Math.max(0, parseInt(process.env.AZURE_OPENAI_MIN_GAP_MS || '55', 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.AZURE_OPENAI_MAX_RETRIES || '4', 10));

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
  const any = e as { status?: number; message?: string; code?: string };
  if (any.status === 429) return true;
  const msg = String(any.message ?? e);
  if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('Rate limit')) return true;
  return false;
}

function shouldNotRetry(e: unknown): boolean {
  const any = e as { status?: number };
  const s = any.status;
  if (s === 400 || s === 404 || s === 403) return true;
  return false;
}

function getRetryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

function logAzureFailure(operation: string, e: unknown): void {
  if (e instanceof APIError) {
    const errBody: unknown = e.error;
    const detail =
      typeof errBody === 'object' && errBody !== null
        ? JSON.stringify(errBody).slice(0, 500)
        : '';
    console.warn(
      `Azure OpenAI xato [${operation}]: HTTP ${e.status} — ${e.message}${detail ? ` | ${detail}` : ''}`
    );
    return;
  }
  console.warn(`Azure OpenAI xato [${operation}]:`, String((e as Error)?.message ?? e).slice(0, 400));
}

export async function withAzureSlot<T>(fn: () => Promise<T>): Promise<T> {
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
        const delay = getRetryDelayMs(attempt);
        console.warn(`Azure OpenAI 429 — ${delay}ms keyin qayta urinish (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        attempt++;
      }
    }
  } finally {
    releaseSlot();
  }
}

function normalizeEndpoint(raw: string): string {
  return raw.replace(/\/+$/, '');
}

const deploymentClients = new Map<string, AzureOpenAI>();

function clientForDeployment(deployment: string): AzureOpenAI {
  let c = deploymentClients.get(deployment);
  if (!c) {
    const endpoint = normalizeEndpoint(process.env.AZURE_OPENAI_ENDPOINT || '');
    const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
    c = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion: azureApiVersion(),
      deployment,
    });
    deploymentClients.set(deployment, c);
  }
  return c;
}

export function isAzureLlmConfigured(): boolean {
  const ep = (process.env.AZURE_OPENAI_ENDPOINT || '').trim();
  const key = (process.env.AZURE_OPENAI_API_KEY || '').trim();
  const dep = (process.env.AZURE_OPENAI_DEPLOYMENT || '').trim();
  return !!(ep && key && dep);
}

export function azureTextDeployment(): string {
  return (process.env.AZURE_OPENAI_DEPLOYMENT || '').trim();
}

/** Rasm/tasdiq uchun — bo‘lmasa matn deployment ishlatiladi */
export function azureVisionDeployment(): string {
  const v = (process.env.AZURE_OPENAI_DEPLOYMENT_VISION || '').trim();
  return v || azureTextDeployment();
}

export function azureApiVersion(): string {
  return (process.env.AZURE_OPENAI_API_VERSION || '2024-10-21').trim();
}

export async function azureChatText(
  operation: string,
  userText: string,
  explicitTelegramId?: number,
): Promise<string> {
  const deployment = azureTextDeployment();
  const client = clientForDeployment(deployment);
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: userText }];
  try {
    const res: ChatCompletion = await withAzureSlot(() =>
      client.chat.completions.create({
        model: deployment,
        messages,
        temperature: 0.2,
        max_tokens: 2048,
      })
    );
    const text = res.choices[0]?.message?.content?.trim() ?? '';
    recordOpenAiChatUsage(operation, res.usage, explicitTelegramId);
    return text;
  } catch (e) {
    logAzureFailure(operation, e);
    throw e;
  }
}

export async function azureChatVision(
  operation: string,
  base64: string,
  mimeType: string,
  userPrompt: string,
  explicitTelegramId?: number,
): Promise<string> {
  const deployment = azureVisionDeployment();
  const client = clientForDeployment(deployment);
  const safeMime = mimeType.toLowerCase().includes('png')
    ? 'image/png'
    : mimeType.toLowerCase().includes('webp')
      ? 'image/webp'
      : 'image/jpeg';
  const dataUrl = `data:${safeMime};base64,${base64}`;
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
        { type: 'text', text: userPrompt },
      ],
    },
  ];
  try {
    const res: ChatCompletion = await withAzureSlot(() =>
      client.chat.completions.create({
        model: deployment,
        messages,
        temperature: 0.2,
        max_tokens: 2048,
      })
    );
    const text = res.choices[0]?.message?.content?.trim() ?? '';
    recordOpenAiChatUsage(operation, res.usage, explicitTelegramId);
    return text;
  } catch (e) {
    logAzureFailure(operation, e);
    throw e;
  }
}
