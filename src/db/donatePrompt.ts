import { getPostgresPool } from './postgres';

export interface UserDonateRow {
  telegram_id: number;
  positive_feedback_total: number;
  successful_ident_total: number;
  last_donate_prompt_at: Date | null;
  donate_prompt_opt_out: boolean;
  donate_last_feedback_milestone: number;
  donate_last_success_milestone: number;
}

function rowFromDb(r: Record<string, unknown>): UserDonateRow {
  return {
    telegram_id: Number(r.telegram_id),
    positive_feedback_total: Number(r.positive_feedback_total ?? 0),
    successful_ident_total: Number(r.successful_ident_total ?? 0),
    last_donate_prompt_at: r.last_donate_prompt_at ? new Date(String(r.last_donate_prompt_at)) : null,
    donate_prompt_opt_out: Boolean(r.donate_prompt_opt_out),
    donate_last_feedback_milestone: Number(r.donate_last_feedback_milestone ?? 0),
    donate_last_success_milestone: Number(r.donate_last_success_milestone ?? 0),
  };
}

export async function incrementSuccessfulIdent(telegramId: number): Promise<UserDonateRow | null> {
  const pool = getPostgresPool();
  const r = await pool.query(
    `
    INSERT INTO users (telegram_id, successful_ident_total)
    VALUES ($1, 1)
    ON CONFLICT (telegram_id) DO UPDATE SET
      successful_ident_total = users.successful_ident_total + 1
    RETURNING telegram_id, positive_feedback_total, successful_ident_total,
      last_donate_prompt_at, donate_prompt_opt_out,
      donate_last_feedback_milestone, donate_last_success_milestone
    `,
    [telegramId]
  );
  const row = r.rows[0];
  return row ? rowFromDb(row as Record<string, unknown>) : null;
}

export async function incrementPositiveFeedback(telegramId: number): Promise<UserDonateRow | null> {
  const pool = getPostgresPool();
  const r = await pool.query(
    `
    INSERT INTO users (telegram_id, positive_feedback_total)
    VALUES ($1, 1)
    ON CONFLICT (telegram_id) DO UPDATE SET
      positive_feedback_total = users.positive_feedback_total + 1
    RETURNING telegram_id, positive_feedback_total, successful_ident_total,
      last_donate_prompt_at, donate_prompt_opt_out,
      donate_last_feedback_milestone, donate_last_success_milestone
    `,
    [telegramId]
  );
  const row = r.rows[0];
  return row ? rowFromDb(row as Record<string, unknown>) : null;
}

export async function markDonatePromptShown(
  telegramId: number,
  track: 'feedback' | 'success',
  milestoneValue: number
): Promise<void> {
  await getPostgresPool().query(
    `
    UPDATE users SET
      last_donate_prompt_at = NOW(),
      donate_last_feedback_milestone = CASE
        WHEN $2::text = 'feedback' THEN $3::integer
        ELSE donate_last_feedback_milestone
      END,
      donate_last_success_milestone = CASE
        WHEN $2::text = 'success' THEN $3::integer
        ELSE donate_last_success_milestone
      END
    WHERE telegram_id = $1
    `,
    [telegramId, track, milestoneValue]
  );
}

export async function setDonateOptOut(telegramId: number): Promise<void> {
  await getPostgresPool().query(
    `UPDATE users SET donate_prompt_opt_out = TRUE WHERE telegram_id = $1`,
    [telegramId]
  );
}
