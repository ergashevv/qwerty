/**
 * Film kesh: canonical kalitlar, keshdan MovieDetails qurish, DB bilan integratsiya (ixtiyoriy).
 */
import { canonicalCacheKey, isCanonicalCacheKey } from '../db/filmCacheKeys';
import { movieDetailsFromCache } from '../services/movieService';
import type { MovieCacheEntry } from '../db';
import {
  getCachedByTmdb,
  setCache,
  getPostgresPool,
  initPostgresSchema,
  closePostgresPool,
} from '../db';

describe('canonicalCacheKey', () => {
  test('bir xil film uchun barqaror string', () => {
    expect(canonicalCacheKey(550, 'movie')).toBe('tmdb:550:movie');
    expect(canonicalCacheKey(1396, 'tv')).toBe('tmdb:1396:tv');
  });

  test('title hash bilan adashmaydi', () => {
    const titleKey = 'a'.repeat(32);
    expect(canonicalCacheKey(550, 'movie')).not.toBe(titleKey);
  });
});

describe('isCanonicalCacheKey', () => {
  test('to‘g‘ri format', () => {
    expect(isCanonicalCacheKey('tmdb:550:movie')).toBe(true);
    expect(isCanonicalCacheKey('tmdb:1:tv')).toBe(true);
  });

  test('noto‘g‘ri', () => {
    expect(isCanonicalCacheKey('deadbeef')).toBe(false);
    expect(isCanonicalCacheKey('tmdb:abc:movie')).toBe(false);
  });
});

describe('movieDetailsFromCache', () => {
  test('kesh qatoridan MovieDetails to‘ldiriladi', () => {
    const cached: MovieCacheEntry = {
      title: 'Fight Club',
      uz_title: 'Fight Club',
      original_title: 'Fight Club',
      year: '1999',
      poster_url: 'https://example.com/p.jpg',
      plot_uz: 'Syujet.',
      watch_links: JSON.stringify([{ title: 'Test', link: 'https://kinoxit.net/x', source: 'kinoxit' }]),
      rating: '8.8',
      imdb_url: 'https://www.imdb.com/title/tt0137523',
    };
    const d = movieDetailsFromCache(cached, {
      tmdbId: 550,
      imdbId: 'tt0137523',
      mediaType: 'movie',
    });
    expect(d.title).toBe('Fight Club');
    expect(d.tmdbId).toBe(550);
    expect(d.imdbId).toBe('tt0137523');
    expect(d.watchLinks).toHaveLength(1);
    expect(d.mediaType).toBe('movie');
  });
});

const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)('film kesh — Postgres (DATABASE_URL)', () => {
  jest.setTimeout(25_000);

  afterAll(async () => {
    await closePostgresPool();
  });

  test('setCache TMDB bilan ikkala kalitda yozadi va getCachedByTmdb o‘qiydi', async () => {
    await initPostgresSchema();
    const suffix = `test-${Date.now()}`;
    const title = `Canonical Cache Film ${suffix}`;
    const data: MovieCacheEntry = {
      title,
      uz_title: `Uz ${suffix}`,
      original_title: title,
      year: '2020',
      plot_uz: 'Test plot.',
      watch_links: JSON.stringify([]),
      rating: '7',
    };
    const tmdbId = 9_999_001;
    await setCache(title, data, { tmdbId, mediaType: 'movie' });

    const byTmdb = await getCachedByTmdb(tmdbId, 'movie');
    expect(byTmdb).not.toBeNull();
    expect(byTmdb?.title).toBe(title);
    expect(byTmdb?.uz_title).toBe(`Uz ${suffix}`);

    const pool = getPostgresPool();
    const titleKeyRow = await pool.query(`SELECT cache_key, tmdb_id FROM movie_cache WHERE uz_title = $1`, [`Uz ${suffix}`]);
    const keys = titleKeyRow.rows.map((r: { cache_key: string }) => r.cache_key);
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toMatch(/^tmdb:\d+:(movie|tv)$/);
    expect((titleKeyRow.rows[0] as { tmdb_id: number }).tmdb_id).toBe(tmdbId);

    await pool.query(`DELETE FROM movie_cache WHERE uz_title = $1`, [`Uz ${suffix}`]);
  });
});
