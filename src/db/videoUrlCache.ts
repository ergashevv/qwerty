import { getPostgresPool } from './postgres';

/** movie_cache bilan bir xil — 30 kun */
const VIDEO_URL_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface VideoUrlCacheRow {
  title: string;
  media_type: 'movie' | 'tv';
  tmdb_id: number | null;
}

export async function getVideoUrlCache(urlHash: string): Promise<VideoUrlCacheRow | null> {
  const pool = getPostgresPool();
  const now = Math.floor(Date.now() / 1000);
  const r = await pool.query(
    `SELECT title, media_type, tmdb_id
     FROM video_url_cache
     WHERE url_hash = $1 AND ($2 - created_at) < $3`,
    [urlHash, now, VIDEO_URL_CACHE_TTL_SECONDS]
  );
  const row = r.rows[0] as VideoUrlCacheRow | undefined;
  if (!row) return null;

  await pool.query(`UPDATE video_url_cache SET hit_count = hit_count + 1 WHERE url_hash = $1`, [urlHash]);
  return {
    title: row.title,
    media_type: row.media_type,
    tmdb_id: row.tmdb_id,
  };
}

export async function setVideoUrlCache(
  urlHash: string,
  normalizedUrl: string,
  data: { title: string; mediaType: 'movie' | 'tv'; tmdbId: number | null }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getPostgresPool().query(
    `
    INSERT INTO video_url_cache (url_hash, normalized_url, title, media_type, tmdb_id, created_at, hit_count)
    VALUES ($1, $2, $3, $4, $5, $6, 0)
    ON CONFLICT (url_hash) DO UPDATE SET
      normalized_url = EXCLUDED.normalized_url,
      title = EXCLUDED.title,
      media_type = EXCLUDED.media_type,
      tmdb_id = EXCLUDED.tmdb_id,
      created_at = EXCLUDED.created_at,
      hit_count = video_url_cache.hit_count
  `,
    [urlHash, normalizedUrl, data.title, data.mediaType, data.tmdbId, now]
  );
}
