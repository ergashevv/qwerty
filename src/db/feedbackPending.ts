import crypto from 'crypto';
import { getPostgresPool } from './postgres';

export type FeedbackSource = 'photo' | 'text' | 'reels';

export interface PendingFeedbackInsert {
  telegramUserId: number;
  chatId: number;
  source: FeedbackSource;
  predictedTitle: string;
  predictedUzTitle: string;
  tmdbId: number | null;
  imdbId: string | null;
  mediaType: string | null;
  confidence: string | null;
  photoFileId: string | null;
  keyboardKeepJson: string | null;
}

export interface PendingFeedbackRow {
  id: number;
  telegram_user_id: number;
  chat_id: number;
  source: FeedbackSource;
  predicted_title: string;
  predicted_uz_title: string | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  media_type: string | null;
  confidence: string | null;
  photo_file_id: string | null;
  keyboard_keep_json: string | null;
  feedback_token: string | null;
  created_at: number;
}

const PENDING_TTL_SEC = 7 * 24 * 60 * 60;

async function pruneExpiredPending(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_TTL_SEC;
  await getPostgresPool().query(`DELETE FROM pending_identification_feedback WHERE created_at < $1`, [cutoff]);
}

export async function insertPendingFeedback(row: PendingFeedbackInsert): Promise<string> {
  await pruneExpiredPending();
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomBytes(16).toString('hex');
  await getPostgresPool().query(
    `
    INSERT INTO pending_identification_feedback (
      telegram_user_id, chat_id, source, predicted_title, predicted_uz_title,
      tmdb_id, imdb_id, media_type, confidence, photo_file_id, keyboard_keep_json, feedback_token, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `,
    [
      row.telegramUserId,
      row.chatId,
      row.source,
      row.predictedTitle,
      row.predictedUzTitle,
      row.tmdbId,
      row.imdbId,
      row.mediaType,
      row.confidence,
      row.photoFileId,
      row.keyboardKeepJson,
      token,
      now,
    ]
  );
  return token;
}

export async function consumePendingFeedback(key: string, telegramUserId: number): Promise<PendingFeedbackRow | null> {
  const pool = getPostgresPool();
  const isLegacyId = /^\d{1,12}$/.test(key) && key.length < 20;
  const sel = isLegacyId
    ? await pool.query(`SELECT * FROM pending_identification_feedback WHERE id = $1`, [Number(key)])
    : await pool.query(`SELECT * FROM pending_identification_feedback WHERE feedback_token = $1`, [key]);

  const raw = sel.rows[0] as
    | (PendingFeedbackRow & { id: string | number; telegram_user_id: string | number })
    | undefined;
  if (!raw || Number(raw.telegram_user_id) !== telegramUserId) return null;

  await pool.query(`DELETE FROM pending_identification_feedback WHERE id = $1`, [raw.id]);

  return {
    id: Number(raw.id),
    telegram_user_id: Number(raw.telegram_user_id),
    chat_id: Number(raw.chat_id),
    source: raw.source,
    predicted_title: raw.predicted_title,
    predicted_uz_title: raw.predicted_uz_title,
    tmdb_id: raw.tmdb_id,
    imdb_id: raw.imdb_id,
    media_type: raw.media_type,
    confidence: raw.confidence,
    photo_file_id: raw.photo_file_id,
    keyboard_keep_json: raw.keyboard_keep_json,
    feedback_token: raw.feedback_token,
    created_at: Number(raw.created_at),
  };
}
