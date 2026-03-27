/**
 * Ixtiyoriy donate prompt — faqat .env orqali yoqiladi.
 */

function parseIntList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw?.trim()) return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : [...fallback];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_FEEDBACK = [3, 10, 25];
const DEFAULT_SUCCESS = [20, 60, 150];

export interface DonateConfig {
  enabled: boolean;
  cooldownDays: number;
  feedbackMilestones: number[];
  successMilestones: number[];
  cardNumber: string | null;
  cardholder: string | null;
  paymeUrl: string | null;
  extraNote: string | null;
}

export function getDonateConfig(): DonateConfig {
  const enabled =
    process.env.DONATE_ENABLED?.trim().toLowerCase() === 'true' &&
    Boolean(process.env.DONATE_CARD_NUMBER?.trim());

  return {
    enabled,
    cooldownDays: parsePositiveInt(process.env.DONATE_COOLDOWN_DAYS, 14),
    feedbackMilestones: parseIntList(process.env.DONATE_FEEDBACK_MILESTONES, DEFAULT_FEEDBACK),
    successMilestones: parseIntList(process.env.DONATE_SUCCESS_MILESTONES, DEFAULT_SUCCESS),
    cardNumber: process.env.DONATE_CARD_NUMBER?.trim() || null,
    cardholder: process.env.DONATE_CARDHOLDER?.trim() || null,
    paymeUrl: process.env.DONATE_PAYME_URL?.trim() || null,
    extraNote: process.env.DONATE_NOTE?.trim() || null,
  };
}

/** Keyingi ko‘rsatiladigan milestone (har bir track uchun alohida lastShown). */
export function nextMilestoneForTrack(
  count: number,
  milestones: number[],
  lastShownMilestone: number
): number | null {
  const eligible = milestones.filter((m) => m <= count && m > lastShownMilestone);
  if (eligible.length === 0) return null;
  return Math.min(...eligible);
}

export function cooldownAllowsPrompt(lastPromptAt: Date | null, cooldownDays: number): boolean {
  if (!lastPromptAt) return true;
  const ms = cooldownDays * 24 * 60 * 60 * 1000;
  return Date.now() - lastPromptAt.getTime() >= ms;
}
