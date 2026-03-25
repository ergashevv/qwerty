import { getDb } from './index';

export type FeedbackSource = 'photo' | 'text';

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
  /** Foydalanuvchi yuborgan screenshot (faqat photo oqimi) */
  photoFileId: string | null;
  /** Fikr tugmalari qo‘shilmasdan oldingi inline klaviatura (JSON) — tugma bosilganda qayta qo‘yiladi */
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
  created_at: number;
}

const PENDING_TTL_SEC = 7 * 24 * 60 * 60;

function pruneExpiredPending(): void {
  const d = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_TTL_SEC;
  d.prepare(`DELETE FROM pending_identification_feedback WHERE created_at < ?`).run(cutoff);
}

export function insertPendingFeedback(row: PendingFeedbackInsert): number {
  pruneExpiredPending();
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r = d
    .prepare(
      `
    INSERT INTO pending_identification_feedback (
      telegram_user_id, chat_id, source, predicted_title, predicted_uz_title,
      tmdb_id, imdb_id, media_type, confidence, photo_file_id, keyboard_keep_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
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
      now
    );
  return Number(r.lastInsertRowid);
}

/** Faqat shu foydalanuvchiga tegishli bo‘lsa o‘chirib qaytaradi */
export function consumePendingFeedback(
  id: number,
  telegramUserId: number
): PendingFeedbackRow | null {
  const d = getDb();
  const row = d
    .prepare(`SELECT * FROM pending_identification_feedback WHERE id = ?`)
    .get(id) as PendingFeedbackRow | undefined;
  if (!row || row.telegram_user_id !== telegramUserId) return null;
  d.prepare(`DELETE FROM pending_identification_feedback WHERE id = ?`).run(id);
  return row;
}
