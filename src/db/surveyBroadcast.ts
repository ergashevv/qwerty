import { getPostgresPool } from './postgres';
import { parseTelegramUserIdFromDb } from '../utils/telegramUserId';

/**
 * Faqat bu bot bilan avval muloqot qilgan userlar.
 *
 * **Saqlash:** `upsertUser` / `markUserStarted` — `telegram_id` doim `ctx.from.id` (private chatda user ID).
 * **Yuborish:** `sendMessage(telegram_id)` — shu ID; format xato emas.
 *
 * **«chat not found» ko‘p bo‘lsa:** odatda **boshqa bot token** (masalan test `@bot`) + **prod bazadagi**
 * userlar — ular asosiy botni boshlagan, lekin *shu* bot bilan chat ochmagan. Bu blok yoki DB xatosi emas.
 */
export async function getSurveyRecipientIds(): Promise<number[]> {
  const r = await getPostgresPool().query(
    `
    SELECT u.telegram_id FROM users u
    WHERE u.blocked_at IS NULL
      AND (
        u.started_at IS NOT NULL
        OR u.last_request_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM user_activity_day uad WHERE uad.telegram_id = u.telegram_id)
      )
    ORDER BY u.telegram_id
    `
  );
  const out: number[] = [];
  for (const row of r.rows as { telegram_id: unknown }[]) {
    const id = parseTelegramUserIdFromDb(row.telegram_id);
    if (id != null) out.push(id);
    else
      console.warn('[survey] users.telegram_id noto‘g‘ri qator o‘tkazildi:', row.telegram_id);
  }
  return out;
}

export async function insertSurveySatisfied(
  campaignId: string,
  telegramUserId: number,
  satisfied: boolean,
  problemText: string | null
): Promise<'inserted' | 'duplicate'> {
  const r = await getPostgresPool().query(
    `
    INSERT INTO survey_broadcast_responses (campaign_id, telegram_user_id, satisfied, problem_text)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_user_id, campaign_id) DO NOTHING
    RETURNING id
    `,
    [campaignId, telegramUserId, satisfied, problemText]
  );
  return r.rowCount && r.rowCount > 0 ? 'inserted' : 'duplicate';
}

export async function clearSurveyProblemPending(telegramUserId: number): Promise<void> {
  await getPostgresPool().query(`DELETE FROM survey_problem_pending WHERE telegram_id = $1`, [
    telegramUserId,
  ]);
}

export async function setSurveyProblemPending(
  telegramUserId: number,
  campaignId: string
): Promise<void> {
  await getPostgresPool().query(
    `
    INSERT INTO survey_problem_pending (telegram_id, campaign_id)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO UPDATE SET campaign_id = $2, created_at = NOW()
    `,
    [telegramUserId, campaignId]
  );
}

export async function getSurveyProblemPending(
  telegramUserId: number
): Promise<{ campaignId: string } | null> {
  const r = await getPostgresPool().query(
    `SELECT campaign_id FROM survey_problem_pending WHERE telegram_id = $1`,
    [telegramUserId]
  );
  const row = r.rows[0] as { campaign_id: string } | undefined;
  return row ? { campaignId: row.campaign_id } : null;
}

export async function completeSurveyProblemText(
  telegramUserId: number,
  campaignId: string,
  problemText: string
): Promise<boolean> {
  const pool = getPostgresPool();
  const del = await pool.query(
    `DELETE FROM survey_problem_pending WHERE telegram_id = $1 AND campaign_id = $2 RETURNING telegram_id`,
    [telegramUserId, campaignId]
  );
  if (!del.rowCount) return false;
  const ins = await insertSurveySatisfied(campaignId, telegramUserId, false, problemText);
  return ins === 'inserted' || ins === 'duplicate';
}
