import { getPostgresPool } from './postgres';

/** Tasdiqlangan screenshot ↔ TMDB bog‘lanishi (analytics va kelajakdagi vizual qidiruv uchun). */
export async function insertFilmPhotoEvidence(params: {
  telegramUserId: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  imdbId: string | null;
  telegramFileId: string | null;
}): Promise<void> {
  if (!params.telegramFileId) return;
  const now = Math.floor(Date.now() / 1000);
  const pool = getPostgresPool();
  await pool.query(
    `
    INSERT INTO film_photo_evidence (telegram_user_id, tmdb_id, media_type, imdb_id, telegram_file_id, created_at)
    SELECT $1, $2, $3, $4, $5, $6
    WHERE NOT EXISTS (
      SELECT 1 FROM film_photo_evidence e
      WHERE e.telegram_user_id = $1
        AND e.tmdb_id = $2
        AND e.media_type = $3
        AND e.telegram_file_id = $5
    )
  `,
    [
      params.telegramUserId,
      params.tmdbId,
      params.mediaType,
      params.imdbId,
      params.telegramFileId,
      now,
    ]
  );
}
