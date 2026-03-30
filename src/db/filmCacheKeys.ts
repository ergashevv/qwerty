/** TMDB asosidagi barqaror kesh kaliti (title hashidan mustaqil). */
export function canonicalCacheKey(tmdbId: number, mediaType: 'movie' | 'tv'): string {
  return `tmdb:${tmdbId}:${mediaType}`;
}

export function isCanonicalCacheKey(key: string): boolean {
  return /^tmdb:\d+:(movie|tv)$/.test(key);
}
