import { insertAnalyticsEvent } from '../db/postgres';

function hasTraceStorage(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function clipText(value: unknown, max = 500): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeTraceValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') return clipText(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => normalizeTraceValue(item));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeTraceValue(v);
    }
    return out;
  }
  return clipText(String(value), 500);
}

async function writeTrace(eventType: string, metadata: Record<string, unknown>): Promise<void> {
  if (!hasTraceStorage()) return;
  await insertAnalyticsEvent(eventType, normalizeTraceValue(metadata) as Record<string, unknown>);
}

export async function logIdentificationRequest(metadata: Record<string, unknown>): Promise<void> {
  await writeTrace('identification_request', metadata);
}

export async function logIdentificationResult(metadata: Record<string, unknown>): Promise<void> {
  await writeTrace('identification_result', metadata);
}

export { clipText as clipIdentificationTraceText };
