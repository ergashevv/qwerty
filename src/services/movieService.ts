import axios from 'axios';
import { isAzureLlmConfigured, azureChatText, azureChatVision } from './azureLlm';
import sharpLib from 'sharp';
import { recognizeCelebrities, extractImdbId } from './rekognition';
import type { BotLocale } from '../i18n/locale';
import { DEFAULT_LOCALE } from '../i18n/locale';
import type { MovieCacheEntry } from '../db';
import { getCached, getCachedByTmdb } from '../db';

export type MediaType = 'movie' | 'tv';

export interface MovieIdentified {
  title: string;
  type: MediaType;
  confidence?: string;
  /**
   * Ichki siyosat: verify muvaffaqiyatsiz bo'lsa ham foydalanuvchiga
   * "Taxminiy variant" sifatida ko'rsatish xavfsizmi.
   */
  allowAmbiguousFallback?: boolean;
}

/** Rasm bo‘yicha aniqlash: topilmadi — yoki nomzod bor lekin LLM tasdiqidan o‘tmadi */
export type IdentifyMovieResult =
  | { ok: true; identified: MovieIdentified }
  | { ok: false; reason: 'no_candidates' }
  | { ok: false; reason: 'llm_verify_failed'; candidates: MovieIdentified[] };

export interface MovieDetails {
  title: string;
  uzTitle: string;
  originalTitle: string;
  year: string;
  rating: string;
  posterUrl: string | null;
  plotUz: string;
  imdbUrl: string | null;
  watchLinks: WatchLink[];
  /** Analytics / feedback — cache yo‘lda bo‘sh bo‘lishi mumkin */
  tmdbId?: number | null;
  imdbId?: string | null;
  mediaType?: MediaType;
}

/** Cache dan kelgan imdb_url dan tt... ID */
export function imdbIdFromMovieUrl(imdbUrl: string | null | undefined): string | null {
  if (!imdbUrl) return null;
  const m = imdbUrl.match(/(tt\d+)/);
  return m ? m[1] : null;
}

export interface WatchLink {
  title: string;
  link: string;
  source: string;
}

const TMDB_KEY   = process.env.TMDB_API_KEY   || '';
const OMDB_KEY   = process.env.OMDB_API_KEY   || '';
const IMGBB_KEY  = process.env.IMGBB_API_KEY   || '';
/** Barcha LLM: faqat Azure OpenAI */
const AI_LLM_ENABLED = isAzureLlmConfigured();
const KP_KEY     = process.env.KINOPOISK_API_KEY || '';
const KP_BASE    = 'https://kinopoiskapiunofficial.tech';
/** Tasdiq bosqichi: har bir nomzod uchun alohida multimodal chaqiruv */
const MAX_VERIFY = Math.min(
  8,
  Math.max(1, parseInt(process.env.LLM_MAX_VERIFY || process.env.GEMINI_MAX_VERIFY || '4', 10))
);
const IMAGE_ALLOW_BEST_EFFORT_FALLBACK =
  (process.env.IMAGE_ALLOW_BEST_EFFORT_FALLBACK || 'true').trim().toLowerCase() !== 'false';
const IMAGE_ACCEPT_ALTERNATIVE_WITHOUT_SECOND_VERIFY =
  (process.env.IMAGE_ACCEPT_ALTERNATIVE_WITHOUT_SECOND_VERIFY || 'true').trim().toLowerCase() !== 'false';
const IMAGE_BEST_EFFORT_MIN_CONFIDENCE_RANK = Math.min(
  3,
  Math.max(0, parseInt(process.env.IMAGE_BEST_EFFORT_MIN_CONFIDENCE_RANK || '2', 10))
);
/** Rasm uzun tomoni (px) — token tejash */
const AI_IMAGE_MAX_EDGE = Math.min(
  2048,
  Math.max(768, parseInt(process.env.LLM_IMAGE_MAX_EDGE || process.env.GEMINI_IMAGE_MAX_EDGE || '1280', 10))
);
/** Instagram @username analytics — faqat UI o‘qish, kichik rasm yetarli */
const INSTAGRAM_EXTRACT_MAX_EDGE = Math.min(1280, Math.max(480, parseInt(process.env.INSTAGRAM_EXTRACT_MAX_EDGE || '720', 10)));
const TIMEOUT    = 8000;
const MIN_CELEBRITIES_FOR_STRONG_FACE_SIGNAL = 2;

/** Vergul bilan ajratilgan domenlar — tomosh havolalari ro'yxatidan chiqariladi (masalan: bir sayt boshqalarini bosib qolganda). */
function watchLinkBannedHosts(): Set<string> {
  const raw = process.env.WATCH_LINK_BANNED_HOSTS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((h) => h.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]?.toLowerCase())
      .filter(Boolean),
  );
}

function withAmbiguousFallback(candidate: MovieIdentified, allow: boolean): MovieIdentified {
  return { ...candidate, allowAmbiguousFallback: allow };
}

function canSurfaceAmbiguousCandidate(candidate: MovieIdentified): boolean {
  return candidate.allowAmbiguousFallback !== false;
}

function stripAmbiguousFallbackFlag(candidate: MovieIdentified): MovieIdentified {
  const { allowAmbiguousFallback: _allowAmbiguousFallback, ...cleanCandidate } = candidate;
  return cleanCandidate;
}

function confidenceRank(confidence: string | undefined): number {
  const value = (confidence || '').toLowerCase();
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 0;
  return 1;
}

function bestEffortIdentified(candidate: MovieIdentified): MovieIdentified {
  const clean = stripAmbiguousFallbackFlag(candidate);
  return {
    ...clean,
    confidence: 'medium',
  };
}

function canReturnBestEffortCandidate(
  candidate: MovieIdentified,
  consensusCandidate: MovieIdentified | null
): boolean {
  if (!IMAGE_ALLOW_BEST_EFFORT_FALLBACK) return false;
  if (!canSurfaceAmbiguousCandidate(candidate)) return false;
  if (consensusCandidate && titlesMatch(consensusCandidate.title, candidate.title)) return true;
  return confidenceRank(candidate.confidence) >= IMAGE_BEST_EFFORT_MIN_CONFIDENCE_RANK;
}

// ─── YORDAMCHI ───────────────────────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  // Year parens and source markers must be stripped BEFORE the special-char replacement,
  // because that step converts ( ) — | into spaces, preventing the patterns from matching.
  return t
    .replace(/\s*\(\d{4}[^)]*\)/g, '')
    .replace(/\s*[-–—|]\s*(wikipedia|imdb|rotten|letterboxd).*/i, '')
    .toLowerCase()
    .replace(/[ʻʼ'\`‘·]/g, "'")
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ\u2018\u2019\u02BC\u02B9'`'·]/g, '')
    .replace(/[^a-z0-9\u0400-\u04ff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * So'rovda bo'shliqdan keyin qism (masalan "Iron Man 4") bo'lsa, sarlavhada ham shu raqam bo'lishi kerak.
 * Yil (1917) bilan adashmaslik uchun faqat oxirida bo'shliq bilan kelgan 2–15 oralig'idagi raqamlar.
 */
function sequelNumberMismatch(query: string, title: string): boolean {
  const m = query.trim().toLowerCase().match(/\s(\d{1,2})\s*$/);
  if (!m) return false;
  const num = m[1];
  const n = parseInt(num, 10);
  if (n < 2 || n > 15) return false;
  const re = new RegExp(`(^|\\s|\\()${num}(\\s|$|:|\\)|-)`, 'i');
  return !re.test(title);
}

/** OMDB/TMDB matn qidiruvi — titlesMatch + serial raqamini hisobga oladi */
function titlesMatchForSearchQuery(userQuery: string, title: string): boolean {
  if (!titlesMatch(userQuery, title)) return false;
  return !sequelNumberMismatch(userQuery, title);
}

/**
 * Kirill, turk, arab va boshqa non-ASCII matnlar uchun to'g'ridan-to'g'ri solishtirish.
 * normalizeTitle() ular uchun ishlamaydi (barcha non-ASCII ni o'chirib tashlaydi).
 */
export function titlesMatchNative(query: string, ...titles: string[]): boolean {
  const q = query.toLowerCase().trim();
  for (const t of titles) {
    if (!t) continue;
    const tc = t.toLowerCase().trim();
    if (tc === q) return true;
    if (tc.length >= 4 && q.includes(tc)) {
      const idx = q.indexOf(tc);
      const suffix = q.slice(idx + tc.length).trim();
      if (suffix === '') return true;
      // "Iron Man 4" vs "Iron Man" — raqam so'rovda bo'lsa, sarlavhada ham bo'lishi kerak
      if (/^\d+$/.test(suffix)) {
        const re = new RegExp(`(^|\\s|\\()${suffix}(\\s|$|:|\\)|-)`, 'i');
        if (!re.test(t)) continue;
        return true;
      }
      // "iron man something" vs "iron man" — avtomatik mos demaymiz; quyidagi titlesMatch sinasin
      continue;
    }
    if (q.length >= 4 && tc.includes(q)) return true;
    // titlesMatch (ASCII-normalized) ham sinab ko'ramiz
    if (titlesMatch(q, tc)) {
      if (sequelNumberMismatch(query, t)) continue;
      return true;
    }
  }
  return false;
}

type PopularTitleAlias = {
  canonicalTitle: string;
  type: MediaType;
  aliases: string[];
};

const POPULAR_TITLE_ALIASES: PopularTitleAlias[] = [
  {
    canonicalTitle: 'Iron Man',
    type: 'movie',
    aliases: ['temir odam', 'temir odam filmi', 'iron man', 'ironman'],
  },
  {
    canonicalTitle: 'Iron Man 2',
    type: 'movie',
    aliases: ['temir odam 2', 'iron man 2', 'ironman 2'],
  },
  {
    canonicalTitle: 'Iron Man 3',
    type: 'movie',
    aliases: ['temir odam 3', 'iron man 3', 'ironman 3'],
  },
  {
    canonicalTitle: 'The Avengers',
    type: 'movie',
    aliases: ['qasoskorlar', 'qasoskorlar filmi', 'the avengers', 'avengers'],
  },
  {
    canonicalTitle: 'Avengers: Endgame',
    type: 'movie',
    aliases: ['qasoskorlar yakuniy o\'yin', 'qasoskorlar endgame', 'avengers endgame'],
  },
  {
    canonicalTitle: 'Spider-Man',
    type: 'movie',
    aliases: ["o'rgimchak odam", 'orgimchak odam', 'spider man', 'spiderman', 'spider-man'],
  },
  {
    canonicalTitle: 'Black Panther',
    type: 'movie',
    aliases: ['qora pantera', 'black panther'],
  },
  {
    canonicalTitle: 'The Dark Knight',
    type: 'movie',
    aliases: ['qorong\'u ritsar', 'qorongu ritsar', 'dark knight'],
  },
  {
    canonicalTitle: 'Batman',
    type: 'movie',
    aliases: ['betmen', 'batman'],
  },
  {
    canonicalTitle: 'WALL-E',
    type: 'movie',
    aliases: ['walle', 'wall e', 'wall-e'],
  },
  {
    canonicalTitle: 'Parasite',
    type: 'movie',
    aliases: ['parazit', 'parasite'],
  },
  {
    canonicalTitle: 'Miracle in Cell No. 7',
    type: 'movie',
    aliases: ['7. koğuştaki mucize', '7 kogustaki mucize', '7 koğustaki mucize', 'miracle in cell no 7'],
  },
];

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'i',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
  қ: 'q', ғ: 'g', ў: "o'", ҳ: 'h', 'ʼ': "'", '’': "'", 'ʻ': "'",
};

function transliterateCyrillicToLatin(text: string): string {
  return Array.from(text.toLowerCase())
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('');
}

function normalizeAliasKey(text: string): string {
  return transliterateCyrillicToLatin(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ‘’`´]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAliasKey(text: string): string {
  return normalizeAliasKey(text).replace(/\s+/g, '');
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function scoreAliasMatch(query: string, alias: string): number {
  const q = normalizeAliasKey(query);
  const a = normalizeAliasKey(alias);
  if (!q || !a) return 0;
  if (q === a) return 100 + a.length;

  const qc = q.replace(/\s+/g, '');
  const ac = a.replace(/\s+/g, '');
  if (!qc || !ac) return 0;
  if (qc === ac) return 98 + ac.length;
  if (qc.startsWith(ac) && qc.length - ac.length <= 3) return 95 + ac.length;
  if (ac.startsWith(qc) && ac.length - qc.length <= 3) return 92 + qc.length;
  if (q.includes(a) || a.includes(q)) {
    const shorter = qc.length <= ac.length ? qc : ac;
    const longer = qc.length <= ac.length ? ac : qc;
    if (shorter.length >= 4 && longer.length - shorter.length <= 4) {
      return 88 + shorter.length;
    }
  }

  const dist = levenshteinDistance(qc, ac);
  const maxLen = Math.max(qc.length, ac.length);
  const limit = maxLen <= 10 ? 2 : maxLen <= 18 ? 3 : 1;
  if (dist <= limit) return 80 - dist * 4 + Math.min(10, ac.length);
  return 0;
}

function resolvePopularTitleAlias(query: string): MovieIdentified | null {
  let best: { score: number; title: string; type: MediaType } | null = null;
  for (const entry of POPULAR_TITLE_ALIASES) {
    for (const alias of entry.aliases) {
      const score = scoreAliasMatch(query, alias);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { score, title: entry.canonicalTitle, type: entry.type };
      }
    }
  }
  if (!best) return null;
  return { title: best.title, type: best.type, confidence: best.score >= 95 ? 'high' : 'medium' };
}

// Stop-words that are too common to count as meaningful matches
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is',
  // Uzbek stop-words
  'kinosi', 'filmi', 'haqida', 'kino', 'korsatuv', 'serial', 'seriali',
  'multfilm', 'multfilmi', 'uzbek', 'tilida', 'ozbek', 'o\'zbek', 'uzbekcha',
  'kino', 'filmi', 'haqidagi', 'chiqqan', 'korgan', 'manosi', 'nomi'
]);

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // includes() check: shorter must be >= 6 chars to avoid false positives from
  // short common words ("man", "iron", "the"). 6+ chars like "Avengers" pass.
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;

  // Jaccard similarity on meaningful tokens (strip stop-words)
  const tok = (s: string) => s
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  const ta = tok(na), tb = tok(nb);
  if (!ta.length || !tb.length) return false;

  // Single-word short queries must match exactly
  if (ta.length <= 1 && tb.length <= 1) return na === nb;
  if (ta.length <= 1 && na.length < 10) return false;
  if (tb.length <= 1 && nb.length < 10) return false;

  const setB = new Set(tb);
  const inter = ta.filter(w => setB.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  const score = union > 0 ? inter / union : 0;

  // Multi-word similarity threshold
  return inter >= 1 && score >= 0.7;
}

/**
 * movie_cache da eski xato yozuvlar bo‘lishi mumkin (bir xil kalit emas, lekin title noto‘g‘ri yozilgan yoki
 * avvalgi bug bilan WALL-E o‘rniga boshqa film saqlangan). Identifikatsiya bilan mos kelmasa keshni rad etamiz.
 */
export function cacheEntryMatchesIdentified(
  identified: MovieIdentified,
  cached: { title: string; original_title?: string | null }
): boolean {
  if (titlesMatch(identified.title, cached.title)) return true;
  if (cached.original_title && titlesMatch(identified.title, cached.original_title)) return true;
  return false;
}

/**
 * Havola topilmagan filmlar uchun sentinel: {"empty":true,"at":UNIX_TS}.
 * 24 soat ichida qayta qidirmaslik — cache / SearXNG yukini tejaydi.
 */
const EMPTY_LINKS_COOLDOWN = 24 * 60 * 60;

export function makeEmptyLinksSentinel(): string {
  return JSON.stringify({ empty: true, at: Math.floor(Date.now() / 1000) });
}

function isEmptyLinksSentinel(watchLinksJson: string): boolean {
  try {
    const p = JSON.parse(watchLinksJson) as { empty?: boolean; at?: number };
    if (!p.empty) return false;
    return Math.floor(Date.now() / 1000) - (p.at ?? 0) < EMPTY_LINKS_COOLDOWN;
  } catch {
    return false;
  }
}

/**
 * Bo'sh [] (eski bug) → qayta qidirish (false).
 * Sentinel 24 soat o'tmagan → qayta qidirmaslik (true).
 * Havola bor → true.
 */
export function cachedWatchLinksNonEmpty(watchLinksJson: string | null | undefined): boolean {
  if (!watchLinksJson) return false;
  if (isEmptyLinksSentinel(watchLinksJson)) return true;
  try {
    const arr = JSON.parse(watchLinksJson) as unknown;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

function plotEmpty(locale: BotLocale): string {
  return locale === 'ru' ? 'Описание недоступно' : 'Tavsif mavjud emas';
}

/**
 * O‘zbek UI: kirill sarlavha — kesh eskirgan.
 * Rus UI: kirill normal.
 */
export function cachedLocalizedTitleIsValid(
  localizedTitle: string | null | undefined,
  locale: BotLocale
): boolean {
  if (!localizedTitle) return true;
  if (locale === 'ru') return true;
  return !/[Ѐ-ӿ]/.test(localizedTitle);
}

/** @deprecated — faqat testlar / eski chaqiriqlar */
export function cachedUzTitleIsValid(uzTitle: string | null | undefined): boolean {
  return cachedLocalizedTitleIsValid(uzTitle, 'uz');
}

export function isNoisyTitle(title: string): boolean {
  return /\b(music video|official video|lyrics|ft\.|feat\.|vevo|trailer)\b/i.test(title);
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

export interface TmdbResult {
  id: number; title?: string; name?: string;
  original_title?: string; original_name?: string;
  release_date?: string; first_air_date?: string;
  vote_average?: number; vote_count?: number;
  /** TMDB "trend" — mashhur aktyorlar uchun reytingdan ko'ra yaxshi taroziladi */
  popularity?: number;
  poster_path?: string | null;
  overview?: string; media_type?: string;
}

/** Aktyor filmografiyasida va yuz-kesishuv nomzodlarida saralash */
function sortTmdbByRelevance(a: TmdbResult, b: TmdbResult): number {
  const pa = a.popularity ?? 0;
  const pb = b.popularity ?? 0;
  if (Math.abs(pa - pb) > 1e-6) return pb - pa;
  const va = (b.vote_average ?? 0) - (a.vote_average ?? 0);
  if (Math.abs(va) > 1e-6) return va;
  return (b.vote_count ?? 0) - (a.vote_count ?? 0);
}

/** Talk/variety — bir necha mehmon qism; narrative film kadrlari bilan adashadi. Popularity pastlashtiriladi. */
function varietyTalkShowPenaltyPopularity(m: TmdbResult): number {
  const t = (m.title || m.name || '').toLowerCase();
  if (
    /\b(saturday night live|\bsnl\b|the daily show|late night with|late show with|tonight show|jimmy kimmel|conan\b|last week tonight|the colbert report|real time with|meet the press|today show)\b/i.test(
      t
    )
  ) {
    return 22;
  }
  return 0;
}

function isLikelyVarietyTalkTitle(title: string): boolean {
  return /\b(saturday night live|\bsnl\b|the daily show|late night with|late show with|tonight show|jimmy kimmel|conan\b|last week tonight|the colbert report|real time with|meet the press|today show|ellen degeneres show|graham norton show|scene of the crime)\b/i.test(
    title
  );
}

function prioritizeNarrativeCandidates(list: TmdbResult[]): TmdbResult[] {
  if (list.length === 0) return list;
  const nonVariety = list.filter((m) => !isLikelyVarietyTalkTitle((m.title || m.name || '').trim()));
  return nonVariety.length > 0 ? nonVariety : list;
}

/** Yuz → TMDB credits: mashhurlik + film > TV (yaxshilangan tartib) */
function sortTmdbByFaceCredits(a: TmdbResult, b: TmdbResult): number {
  const pa = Math.max(0, (a.popularity ?? 0) - varietyTalkShowPenaltyPopularity(a));
  const pb = Math.max(0, (b.popularity ?? 0) - varietyTalkShowPenaltyPopularity(b));
  if (Math.abs(pa - pb) > 0.15) return pb - pa;
  if (a.media_type !== b.media_type) {
    if (a.media_type === 'movie' && b.media_type === 'tv') return -1;
    if (a.media_type === 'tv' && b.media_type === 'movie') return 1;
  }
  return sortTmdbByRelevance(a, b);
}

/** Yuz → TMDB: kesishuvdan keyin LLM tanlaydigan nomzodlar soni */
const FACE_CANDIDATE_LIMIT = 20;
/** Bitta aktyor uchun TMDB dan olinadigan maksimal film (30 — pastda qolgan mashhur dramalar) */
const PERSON_CREDITS_MAX = 60;

export async function tmdbSearch(query: string, type: MediaType | 'multi' = 'multi'): Promise<{ result: TmdbResult; type: MediaType } | null> {
  try {
    const endpoint = type === 'multi' ? 'search/multi' : `search/${type}`;
    const r = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, {
      params: { api_key: TMDB_KEY, query, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const results: TmdbResult[] = r.data.results || [];
    
    // Exact match yoki yuqori mashhurlikka ega natijani qidirish (movie/tv da ham birinchi natija doim to‘g‘ri emas)
    const hit = type === 'multi'
      ? (results.find(x => (x.media_type === 'movie' || x.media_type === 'tv') && titlesMatchForSearchQuery(query, x.title || x.name || '')) || 
         results.find(x => x.media_type === 'movie' || x.media_type === 'tv'))
      : (results.find(x => titlesMatchForSearchQuery(query, x.title || x.name || '')) || results[0]);

    if (!hit) return null;
    const mtype: MediaType = (hit.media_type === 'tv' || type === 'tv') ? 'tv' : 'movie';
    return { result: hit, type: mtype };
  } catch { return null; }
}

/** Bir xil nomli bir nechta film (masalan "War Machine" 2017 va 2026) poster/aktyor bo‘yicha ajratish */
async function tmdbSearchMoviesList(query: string, limit = 15): Promise<TmdbResult[]> {
  if (!TMDB_KEY) return [];
  try {
    const r = await axios.get('https://api.themoviedb.org/3/search/movie', {
      params: { api_key: TMDB_KEY, query, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const results: TmdbResult[] = r.data.results || [];
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeActorRough(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function actorNamesRoughMatch(creditName: string, guess: string): boolean {
  const a = normalizeActorRough(creditName);
  const b = normalizeActorRough(guess);
  if (!b || !a) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const partsB = b.split(' ').filter((p) => p.length > 2);
  if (partsB.length === 0) return false;
  return partsB.every((p) => a.includes(p));
}

async function tmdbMovieTopCastIncludesActor(movieId: number, actorGuess: string): Promise<boolean> {
  if (!TMDB_KEY) return false;
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/movie/${movieId}/credits`, {
      params: { api_key: TMDB_KEY },
      timeout: TIMEOUT,
    });
    const cast = (r.data.cast || []).slice(0, 22) as Array<{ name?: string }>;
    return cast.some((c) => c.name && actorNamesRoughMatch(c.name, actorGuess));
  } catch {
    return false;
  }
}

/**
 * Vision poster sarlavhasi + ixtiyoriy billing (masalan "ALAN RITCHSON") bo‘yicha to‘g‘ri TMDB film sarlavhasi.
 * Bir xil nomdagi eski filmlardan (Brad Pitt "War Machine") yangi Netflix nusxasini ajratadi.
 */
async function pickTmdbMovieForPosterTitle(
  title: string,
  mediaType: MediaType,
  billingActor: string | undefined,
  posterTitleReadable: boolean,
): Promise<MovieIdentified | null> {
  if (!TMDB_KEY || mediaType === 'tv') return null;
  const list = await tmdbSearchMoviesList(title.trim(), 16);
  if (list.length === 0) return null;

  const titlePool = list.filter((m) => {
    const nm = m.title || '';
    return titlesMatchForSearchQuery(title, nm) || normalizeTitle(title) === normalizeTitle(nm);
  });
  const pool = titlePool.length > 0 ? titlePool : list;

  const billing = (billingActor || '').trim();
  if (billing.length > 2) {
    let checked = 0;
    for (const m of pool) {
      if (!m.id || checked >= 6) break;
      checked++;
      if (await tmdbMovieTopCastIncludesActor(m.id, billing)) {
        return { title: m.title || title, type: 'movie', confidence: 'high' };
      }
    }
  }

  const sorted = [...pool].sort((a, b) => {
    const ya = parseInt((a.release_date || '').slice(0, 4), 10) || 0;
    const yb = parseInt((b.release_date || '').slice(0, 4), 10) || 0;
    if (posterTitleReadable || titlePool.length > 1) {
      if (ya !== yb) return yb - ya;
    }
    return (b.popularity ?? 0) - (a.popularity ?? 0);
  });
  const best = sorted[0];
  if (!best?.title) return null;
  return { title: best.title, type: 'movie', confidence: posterTitleReadable ? 'high' : undefined };
}

async function tmdbByImdbId(imdbId: string): Promise<{ result: TmdbResult; type: MediaType } | null> {
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: { api_key: TMDB_KEY, external_source: 'imdb_id', language: 'en-US' },
      timeout: TIMEOUT,
    });
    const movies: TmdbResult[] = r.data.movie_results || [];
    const tvs: TmdbResult[]    = r.data.tv_results    || [];
    if (movies[0]) return { result: movies[0], type: 'movie' };
    if (tvs[0])    return { result: tvs[0],    type: 'tv' };
    return null;
  } catch { return null; }
}

async function tmdbPersonMovies(personName: string): Promise<TmdbResult[]> {
  try {
    const personRes = await axios.get('https://api.themoviedb.org/3/search/person', {
      params: { api_key: TMDB_KEY, query: personName, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const person = personRes.data.results?.[0];
    if (!person) return [];

    const credRes = await axios.get(`https://api.themoviedb.org/3/person/${person.id}/combined_credits`, {
      params: { api_key: TMDB_KEY, language: 'en-US' },
      timeout: TIMEOUT,
    });
    const cast: TmdbResult[] = credRes.data.cast || [];
    return cast
      .filter(m =>
        (m.media_type === 'movie' || m.media_type === 'tv') &&
        // Kamida 10 ta ovoz — SNG/CIS (qozoq, turk, o'zbek) filmlar ham o'tishi uchun pastlatildi
        (m.vote_count ?? 0) >= 10
      )
      .sort(sortTmdbByFaceCredits)
      .slice(0, PERSON_CREDITS_MAX);
  } catch { return []; }
}

// ─── OMDB ────────────────────────────────────────────────────────────────────

interface OmdbItem { Title: string; Year: string; imdbID: string; Type: string; Genre?: string; }

export async function omdbSearch(query: string, type?: 'movie' | 'series'): Promise<{ title: string; type: MediaType; imdbId: string } | null> {
  if (!OMDB_KEY) return null;
  try {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: OMDB_KEY, s: query, type: type || undefined },
      timeout: TIMEOUT,
    });
    const list: OmdbItem[] = r.data?.Search || [];
    for (const item of list) {
      if (item.Type !== 'movie' && item.Type !== 'series') continue;
      if (isNoisyTitle(item.Title)) continue;
      if (!titlesMatchForSearchQuery(query, item.Title)) continue;
      return { title: item.Title, type: item.Type === 'series' ? 'tv' : 'movie', imdbId: item.imdbID };
    }
  } catch { /* ignore */ }
  return null;
}

async function omdbById(imdbId: string): Promise<{ title: string; type: MediaType; imdbId: string } | null> {
  if (!OMDB_KEY) return null;
  try {
    const r = await axios.get('https://www.omdbapi.com/', {
      params: { apikey: OMDB_KEY, i: imdbId },
      timeout: TIMEOUT,
    });
    if (r.data?.Title && (r.data.Type === 'movie' || r.data.Type === 'series')) {
      // Sifat tekshiruvi: ovoz yo'q yoki plot yo'q bo'lgan obscure yozuvlarni o'tkazib yuboramiz
      const votes = parseInt((r.data.imdbVotes || '').replace(/,/g, '') || '0', 10);
      const hasPlot = r.data.Plot && r.data.Plot !== 'N/A';
      // Kamida 10 ta ovoz YOKI plot mavjud bo'lishi kerak
      if (!hasPlot && votes < 10) return null;
      return {
        title: r.data.Title,
        type: r.data.Type === 'series' ? 'tv' : 'movie',
        imdbId,
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ─── VEB IZ (faqat SearXNG — o‘z VPS) ────────────────────────────────────────

interface WebSearchSnippet { title: string; link: string; snippet?: string; }

function searxngBaseUrl(): string | null {
  const raw = process.env.SEARXNG_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * SearXNG (ochiq kod, odatda o'z serveringiz) — JSON API.
 * @see https://docs.searxng.org/dev/search_api.html
 */
async function searxngSearch(query: string): Promise<WebSearchSnippet[]> {
  const base = searxngBaseUrl();
  if (!base) return [];
  try {
    const r = await axios.get(`${base}/search`, {
      params: {
        q: query,
        format: 'json',
        categories: 'general',
      },
      timeout: TIMEOUT,
      headers: { Accept: 'application/json' },
      validateStatus: (s) => s === 200,
    });
    const rawResults = r.data?.results;
    if (!Array.isArray(rawResults) || rawResults.length === 0) return [];
    return rawResults
      .slice(0, 15)
      .map((item: { title?: string; url?: string; content?: string }) => ({
        title: String(item.title ?? '').trim(),
        link: String(item.url ?? '').trim(),
        snippet: String(item.content ?? '').trim(),
      }))
      .filter((x) => x.link.length > 0 && /^https?:\/\//i.test(x.link));
  } catch (e) {
    console.warn('SearXNG xato:', (e as Error).message?.slice(0, 80));
    return [];
  }
}

/** Veb fragmentlar — faqat `SEARXNG_URL` (o‘z instansingiz). Boshqa provayderlar yo‘q. */
async function webSearch(query: string, _gl = 'uz', _hl = 'uz'): Promise<WebSearchSnippet[]> {
  const q = query.slice(0, 40);
  const sx = await searxngSearch(query);
  if (sx.length > 0) {
    console.log(`🌐 SearXNG: "${q}" (${sx.length} natija)`);
    return sx;
  }
  if (searxngBaseUrl()) {
    console.log(`🌐 SearXNG bo'sh yoki sozlanmagan: "${q}"`);
  }
  return [];
}


// ─── KINOPOISK ────────────────────────────────────────────────────────────────

interface KpFilm {
  filmId: number;
  nameRu?: string;
  nameEn?: string;
  nameOriginal?: string;
  type?: string;
  year?: string | number;
  rating?: string;
  ratingVoteCount?: number;
  posterUrl?: string;
  description?: string;
  imdbId?: string;
  professionKey?: string;
}

/** Kinopoisk kalit-so'z bo'yicha qidiruv — SNG/CIS filmlarni ingliz bazasidan ko'ra yaxshi topadi. */
async function kinopoiskSearch(query: string): Promise<{ film: KpFilm; type: MediaType } | null> {
  if (!KP_KEY) return null;
  try {
    const r = await axios.get(`${KP_BASE}/api/v2.1/films/search-by-keyword`, {
      params: { keyword: query, page: 1 },
      headers: { 'X-API-KEY': KP_KEY },
      timeout: TIMEOUT,
    });
    const films: KpFilm[] = r.data?.films || [];
    if (!films.length) return null;

    const toMediaType = (kpType?: string): MediaType =>
      (kpType === 'TV_SERIES' || kpType === 'MINI_SERIES' || kpType === 'TV_SHOW') ? 'tv' : 'movie';

    // Avval aniq nom mos keluvchisini qidirish
    for (const film of films) {
      if (titlesMatchNative(query, film.nameRu || '', film.nameEn || '', film.nameOriginal || '')) {
        return { film, type: toMediaType(film.type) };
      }
    }
    return null;
  } catch (e) {
    console.warn('Kinopoisk search xato:', (e as Error).message?.slice(0, 60));
    return null;
  }
}

/** Kinopoisk filmId bo'yicha IMDB ID ni olish — TMDB/OMDB bilan ko'prik. */
async function kinopoiskGetImdbId(filmId: number): Promise<string | null> {
  if (!KP_KEY) return null;
  try {
    const r = await axios.get(`${KP_BASE}/api/v2.2/films/${filmId}`, {
      headers: { 'X-API-KEY': KP_KEY },
      timeout: TIMEOUT,
    });
    const imdbId = r.data?.imdbId;
    if (imdbId && /^tt\d+$/i.test(String(imdbId))) return String(imdbId);
  } catch { /* ignore */ }
  return null;
}

/**
 * Aktyor nomi bo'yicha Kinopoisk filmografiyasi — TMDB da topilmagan SNG aktorlar uchun fallback.
 * Qaytarilgan filmlar nameEn/nameOriginal orqali TMDB da ham qidiriladi.
 */
async function kinopoiskPersonMovies(personName: string): Promise<KpFilm[]> {
  if (!KP_KEY) return [];
  try {
    const personRes = await axios.get(`${KP_BASE}/api/v1/persons`, {
      params: { name: personName, page: 1 },
      headers: { 'X-API-KEY': KP_KEY },
      timeout: TIMEOUT,
    });
    const persons: Array<{ personId: number }> = personRes.data?.items || [];
    if (!persons[0]) return [];

    const staffRes = await axios.get(`${KP_BASE}/api/v1/staff/${persons[0].personId}`, {
      headers: { 'X-API-KEY': KP_KEY },
      timeout: TIMEOUT,
    });
    const films: KpFilm[] = (staffRes.data?.films || [])
      .filter((f: KpFilm) => !f.professionKey || f.professionKey === 'ACTOR')
      .filter((f: KpFilm) => !f.type || f.type === 'FILM' || f.type === 'TV_SERIES' || f.type === 'MINI_SERIES');
    return films.slice(0, 40);
  } catch { return []; }
}

// ─── IMGBB UPLOAD ────────────────────────────────────────────────────────────

async function uploadToImgbb(base64: string): Promise<string | null> {
  if (!IMGBB_KEY) return null;
  try {
    const params = new URLSearchParams();
    params.append('key', IMGBB_KEY);
    params.append('image', base64);
    params.append('expiration', '600');
    const r = await axios.post('https://api.imgbb.com/1/upload', params, { timeout: TIMEOUT });
    return r.data?.data?.url || null;
  } catch { return null; }
}

// ─── AWS REKOGNITION → TMDb KESISHUVI ────────────────────────────────────────

async function identifyByFaces(base64: string): Promise<MovieIdentified | null> {
  const celebrities = await recognizeCelebrities(base64);
  if (celebrities.length === 0) return null;
  const allowFaceOnlyAmbiguousFallback =
    celebrities.length >= MIN_CELEBRITIES_FOR_STRONG_FACE_SIGNAL ||
    (celebrities[0]?.confidence ?? 0) >= 96;

  console.log('🎭 Rekognition:', celebrities.map(c => `${c.name}(${c.confidence.toFixed(0)}%)`).join(', '));

  const allFilmSets = await Promise.all(
    celebrities.slice(0, 3).map(c => tmdbPersonMovies(c.name))
  );


  // Kinopoisk fallback: TMDB da birinchi aktyor uchun filmlar bo'sh bo'lsa
  // (SNG/turk aktorlar TMDB da filmografiyasi cheklangan)
  if (allFilmSets.length > 0 && allFilmSets[0].length === 0 && KP_KEY) {
    const kpFilmSets = await Promise.all(
      celebrities.slice(0, 3).map(async (c) => {
        const kpFilms = await kinopoiskPersonMovies(c.name);
        const tmdbResults: TmdbResult[] = [];
        for (const kf of kpFilms.slice(0, 15)) {
          const searchTitle = kf.nameEn || kf.nameOriginal || kf.nameRu || '';
          if (!searchTitle) continue;
          const tmdbHit = await tmdbSearch(searchTitle);
          if (tmdbHit?.result) tmdbResults.push(tmdbHit.result);
        }
        return tmdbResults;
      })
    );
    const kpCandidates = kpFilmSets[0];
    if (kpCandidates.length > 0) {
      const sortedKp = prioritizeNarrativeCandidates(kpCandidates).sort(sortTmdbByFaceCredits).slice(0, FACE_CANDIDATE_LIMIT);
      const names = celebrities.map(c => c.name).join(', ');
      const titles = sortedKp.map(c => c.title || c.name).join(' | ');
      console.log(`\u{1F3AC} Kinopoisk person fallback candidates: ${titles}`);
      if (sortedKp.length === 1) {
        const c = sortedKp[0];
        return withAmbiguousFallback(
          {
            title: c.title || c.name || '',
            type: (c.media_type === 'tv' ? 'tv' : 'movie') as MediaType,
            confidence: 'medium',
          },
          allowFaceOnlyAmbiguousFallback,
        );
      }
      if (AI_LLM_ENABLED) {
        const pickG = await llmPickFromCandidates(base64, names, titles);
        if (pickG) return withAmbiguousFallback(pickG, allowFaceOnlyAmbiguousFallback);
      }
    }
  }
  if (allFilmSets.length === 0 || allFilmSets[0].length === 0) return null;



  // Kesishuv: bitta aktyor uchun ham natija ber, ko'p aktyor uchun esa intersection
  let candidates: TmdbResult[] = allFilmSets[0];
  for (let i = 1; i < allFilmSets.length; i++) {
    const ids = new Set(allFilmSets[i].map(f => f.id));
    const intersection = candidates.filter(f => ids.has(f.id));
    if (intersection.length > 0) candidates = intersection;
  }

  candidates = prioritizeNarrativeCandidates(candidates).sort(sortTmdbByFaceCredits).slice(0, FACE_CANDIDATE_LIMIT);
  console.log('🎬 Candidates:', candidates.map(c => c.title || c.name).join(', '));

  // Bitta qolsa — yuz tanish xato bo'lishi mumkin; "high" verifydan keyin emas
  if (candidates.length === 1) {
    const c = candidates[0];
    const title = c.title || c.name || '';
    const type: MediaType = (c.media_type === 'tv') ? 'tv' : 'movie';
    return withAmbiguousFallback({ title, type, confidence: 'medium' }, allowFaceOnlyAmbiguousFallback);
  }

  // Ko'p nomzod: LLM tanlaydi; topilmasa — TMDB reytingi bo'yicha fallback
  if (candidates.length > 1 && AI_LLM_ENABLED) {
    const names = celebrities.map(c => c.name).join(', ');
    const titles = candidates.map(c => c.title || c.name).join(' | ');
    const pickG = await llmPickFromCandidates(base64, names, titles);
    if (pickG) return withAmbiguousFallback(pickG, allowFaceOnlyAmbiguousFallback);
  }
  if (candidates.length > 1) {
    if (!allowFaceOnlyAmbiguousFallback) {
      console.log('⚠️ Bitta mashhur aktyor bo‘yicha ko‘p film chiqdi — reyting fallback ishlatilmaydi');
      return null;
    }
    const best = [...candidates].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
    return withAmbiguousFallback(
      {
        title: best.title || best.name || '',
        type: best.media_type === 'tv' ? 'tv' : 'movie',
        confidence: 'medium',
      },
      allowFaceOnlyAmbiguousFallback,
    );
  }

  return null;
}

async function llmPickFromCandidates(base64: string, actors: string, candidates: string): Promise<MovieIdentified | null> {
  if (!AI_LLM_ENABLED) return null;
  const candidateTitles = candidates
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (candidateTitles.length === 0) return null;
    const userPrompt = `Recognized actors: ${actors}
Candidate movies/shows: ${candidates}

Look at the screenshot carefully. Based on scene details (costumes, setting, lighting, props, visible text in the film frame), choose the best candidate ONLY if it is genuinely plausible.

IMPORTANT RULES:
1. Use ONLY titles from the candidates list. Do NOT invent outside titles.
2. If candidates are mostly talk-show/variety entries but the frame looks like a narrative film scene, set confidence to "low" and title to empty.
3. Use "high" or "medium" only when the chosen candidate is visually consistent with the frame.
4. If uncertain or generic frame with no clear match, return low confidence with empty title.
4a. If the only real clue is a famous actor's face and several candidates share that actor, DO NOT choose based on actor identity alone. A generic Tom Cruise close-up, for example, must return low/empty unless costumes, setting, props, or readable text clearly point to one work.
5. If the image is a MOVIE POSTER or KEY ART with obvious typography/title treatment, the candidate MUST match that world: do NOT pick an unrelated live-action show if the art is clearly animated, family-rated musical style, or biblical/epic illustration style.
6. If the frame is clearly ANIMATED or CGI and a candidate is only a live-action erotic/comedy/drama series with no animation, that candidate is NOT plausible — use "low" and empty title.

Respond ONLY with JSON:
{"title": "Exact title from candidates", "type": "movie" or "tv", "confidence": "high/medium/low"}`;
  try {
    const text = await azureChatVision('llmPickFromCandidates', base64, 'image/jpeg', userPrompt);
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
    const t = (parsed.title || '').trim();
    const conf = (parsed.confidence || '').toLowerCase();
    if (!t || t.toLowerCase() === 'unknown' || conf === 'low') return null;
    const inCandidates = candidateTitles.some((ct) => titlesMatch(ct, t));
    if (!inCandidates) return null;
    return {
      title: t,
      type: parsed.type === 'tv' ? 'tv' : 'movie',
      confidence: parsed.confidence,
    };
  } catch { return null; }
}

// ─── LLM KADR ANALIZI (Azure vision) ─────────────────────────────────────────

async function identifyByVisionLlm(base64: string, textHint?: string | null): Promise<MovieIdentified | null> {
  if (!AI_LLM_ENABLED) return null;
  try {
    const hintLine = textHint
      ? `\nUser hint (may be a movie name, actor, or description in Uzbek/Russian/English): "${textHint.slice(0, 200)}" — use this as an additional clue, but only if it actually matches the screenshot.`
      : '';
    const userPrompt = `You are a world cinema expert. Identify the EXACT movie or TV show in this screenshot.

The film can be from ANY country: Hollywood, Turkey, Korea, Russia, Kazakhstan, Uzbekistan, Kyrgyzstan, Azerbaijan, India, Iran, or anywhere else. Do NOT bias toward any region.${hintLine}

Key clues to analyze:
1. **Theatrical POSTER / key art**: large printed title (e.g. one prominent word like "DAVID") — transcribe that title text literally as the primary answer when legible.
2. Actors' faces — recognize them if possible (on posters: illustrated faces differ from live-action celebrities)
3. Costumes/clothing era; animated/CG vs live-action
4. Setting (biblical epic, fantasy, modern city, etc.)
5. Any visible text — ignore social media UI chrome only
6. Overall visual style: family animation, gritty drama, erotic comedy, etc. must stay CONSISTENT with your title

Respond ONLY with JSON:
{"title": "Exact title or unknown", "type": "movie" or "tv", "confidence": "high/medium/low", "posterTitleReadable": true/false, "billingName": "lead actor name EXACTLY as printed on poster (billing block), or empty string"}

Rules:
- Use confidence "high" or "medium" only if you genuinely recognize this specific work OR the poster title text is clearly readable.
- **billingName**: if the poster shows cast credits (e.g. above/below title), copy the main star line (e.g. "Alan Ritchson"). If none visible, use "".
- **posterTitleReadable**: true if the main movie title text on the poster is clearly legible.
- Use "unknown" + "low" if you cannot name the exact release — do NOT substitute a random popular title with a loose thematic link.
- A famous actor alone is NOT enough. If this is just a generic close-up of Tom Cruise / Shah Rukh Khan / Jackie Chan / etc. and you lack work-specific cues, answer unknown + low.
- Never output an unrelated adult live-action series for a bright family-style animated or illustrated poster.
- Do NOT guess a title just because it fits the genre — only respond with a title you actually recognize or read from the image.
- Two films can share a title (e.g. "War Machine" 2017 vs 2026): still output the poster title you read; billingName helps disambiguate.`;
    const text = await azureChatVision('identifyByVisionLlm', base64, 'image/jpeg', userPrompt);
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      title?: string;
      type?: string;
      confidence?: string;
      posterTitleReadable?: boolean;
      billingName?: string;
    };
    if (!parsed.title || parsed.title.toLowerCase() === 'unknown') return null;
    const gemConf = (parsed.confidence || '').toLowerCase();
    // "low" ham saqlanadi: asosiy tartibda asosan ishlatilmaydi, lekin boshqa signal bo'lmasa
    // tasdiq (llmVerifyCandidate) bosqichiga yuboriladi — aks holda "Tasdiq uchun nomzod yo'q".
    if (gemConf !== 'high' && gemConf !== 'medium' && gemConf !== 'low') return null;

    const mediaType: MediaType = parsed.type === 'tv' ? 'tv' : 'movie';
    const posterReadable = parsed.posterTitleReadable === true;
    const billing = (parsed.billingName || '').trim();
    const allowAmbiguous = posterReadable || gemConf === 'high' || gemConf === 'medium';

    if (mediaType === 'movie') {
      const picked = await pickTmdbMovieForPosterTitle(
        parsed.title,
        'movie',
        billing || undefined,
        posterReadable || gemConf === 'high' || gemConf === 'medium',
      );
      if (picked) {
        const confOut = picked.confidence ?? parsed.confidence;
        return withAmbiguousFallback(
          { title: picked.title, type: 'movie', confidence: confOut },
          allowAmbiguous || Boolean(picked.confidence),
        );
      }
    }

    const verified = await omdbSearch(parsed.title);
    if (verified) {
      return withAmbiguousFallback(
        { title: verified.title, type: verified.type, confidence: parsed.confidence },
        allowAmbiguous,
      );
    }
    return withAmbiguousFallback(
      { title: parsed.title, type: mediaType, confidence: parsed.confidence },
      allowAmbiguous,
    );
  } catch (e) {
    console.warn('LLM (rasm) xato:', (e as Error).message?.slice(0, 200));
    return null;
  }
}

// ─── SMART CROP (watermark/UI olib tashlash) ─────────────────────────────────

/**
 * Vision LLM / Rekognition uchun: juda katta JPEG larni token tejash uchun
 * uzun tomoni AI_IMAGE_MAX_EDGE dan oshmasin (sifat — kadr tuzilishi/yuzlar uchun odatda yetarli).
 */
async function downscaleForAiPipeline(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return base64;
    const longEdge = Math.max(w, h);
    if (longEdge <= AI_IMAGE_MAX_EDGE) return base64;
    const out = await sharpLib(buf)
      .rotate()
      .resize(AI_IMAGE_MAX_EDGE, AI_IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    return out.toString('base64');
  } catch {
    return base64;
  }
}

async function downscaleForInstagramExtract(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return base64;
    if (Math.max(w, h) <= INSTAGRAM_EXTRACT_MAX_EDGE) return base64;
    const out = await sharpLib(buf)
      .rotate()
      .resize(INSTAGRAM_EXTRACT_MAX_EDGE, INSTAGRAM_EXTRACT_MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return out.toString('base64');
  } catch {
    return base64;
  }
}

async function enhanceForAiVariant(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    let img = sharpLib(buf).rotate().normalize().sharpen();
    if (w && h) {
      const longEdge = Math.max(w, h);
      if (longEdge > AI_IMAGE_MAX_EDGE) {
        img = img.resize(AI_IMAGE_MAX_EDGE, AI_IMAGE_MAX_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
    }
    const out = await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return out.toString('base64');
  } catch {
    return base64;
  }
}

type PreparedImageVariant = {
  label: string;
  base64: string;
};

function pushPreparedVariant(variants: PreparedImageVariant[], variant: PreparedImageVariant): boolean {
  if (variants.some((existing) => existing.base64 === variant.base64)) return false;
  variants.push(variant);
  return true;
}

async function cropFrame(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 1080;
    const h = meta.height || 1920;
    const ratio = w / h;

    // Kino posterlari (~2:3, 3:4): sarlavha va billing odatda tepa/pastda — kesish matnni yo'qotadi.
    // TikTok/Reels (~9:16) uchun kesish saqlanadi (ratio ~0.5625).
    if (ratio >= 0.58 && ratio <= 0.82) {
      return base64;
    }

    let cropTop: number, cropBottom: number;
    if (ratio >= 0.9) {
      cropTop = Math.round(h * 0.05); cropBottom = Math.round(h * 0.07);
    } else if (ratio <= 0.56) {
      cropTop = Math.round(h * 0.10); cropBottom = Math.round(h * 0.14);
    } else {
      cropTop = Math.round(h * 0.12); cropBottom = Math.round(h * 0.18);
    }

    const cropH = Math.max(1, h - cropTop - cropBottom);
    const cropped = await sharpLib(buf)
      .extract({ left: 0, top: cropTop, width: w, height: cropH })
      .jpeg({ quality: 90 })
      .toBuffer();
    return cropped.toString('base64');
  } catch { return base64; }
}

// ─── LLM BILAN TASDIQLASH ────────────────────────────────────────────────────

/** Faqat aniq "match": true bo'lsa true — taxminni rad etish uchun "fail-closed". */
interface VerifyResult {
  match: boolean;
  /** Verify false bo'lsa lekin LLM boshqa aniq sarlavha bilsa */
  alternativeTitle?: string;
  alternativeType?: MediaType;
}

async function llmVerifyCandidate(base64: string, candidateTitle: string, mimeType: string): Promise<VerifyResult> {
  if (!AI_LLM_ENABLED) return { match: false };
  const userPrompt = `Does this screenshot belong to the movie/TV show "${candidateTitle}"? (single-frame identification — lean practical, not courtroom certainty.)

CRITICAL RULES:
1. IGNORE watermarks, channel logos, player UI, timestamps, and social media chrome around the video
2. Focus on the actual scene: faces, costumes, setting, lighting, live-action vs animation, poster typography
3. If "${candidateTitle}" is ONLY a documentary / clip show ABOUT cinema (not the narrative work), answer false
4. **Medium mismatch**: if the image is clearly ANIMATED, ILLUSTRATED POSTER ART, or family/CG feature style and "${candidateTitle}" is exclusively a live-action adult comedy/drama that looks nothing like this art — answer **false**
5. **Poster title conflict**: if large readable poster text clearly names a different film than "${candidateTitle}", answer **false**
6. Answer true if the frame is CONSISTENT with "${candidateTitle}" and you see nothing that clearly contradicts it
7. Answer false when you are fairly sure it is a different title, wrong medium, or the setting/era clearly conflicts
8. Same actor alone is NOT sufficient when that actor appears in many famous films. For generic close-ups, romance shots, or plain indoor scenes, require work-specific cues before answering true.
9. Do not require "100% proof" from one still — memorable films often have generic-looking rooms; if it plausibly fits "${candidateTitle}" AND medium/genre match, prefer true
10. If match is false but you KNOW the exact correct title, set "alternativeTitle" / "alternativeType"; otherwise empty strings

Answer ONLY with JSON:
{"match": true} 
or
{"match": false, "reason": "brief explanation", "alternativeTitle": "Exact title or empty string", "alternativeType": "movie or tv or empty string"}`;
  try {
    const text = await azureChatVision('llmVerifyCandidate', base64, mimeType, userPrompt);
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return { match: false };
    const parsed = JSON.parse(m[0]) as {
      match?: boolean;
      reason?: string;
      alternativeTitle?: string;
      alternativeType?: string;
    };
    const ok = parsed.match === true;
    const alt = (parsed.alternativeTitle || '').trim();
    const altType: MediaType = parsed.alternativeType === 'tv' ? 'tv' : 'movie';
    if (!ok && alt && titlesMatch(candidateTitle, alt)) {
      console.log(`🔁 Tasdiq LLM ziddiyatli javob berdi; alternativ sarlavha o‘sha nomning o‘zi: "${candidateTitle}"`);
      return { match: true };
    }
    console.log(`🔍 Tasdiq LLM "${candidateTitle}": ${ok} — ${parsed.reason || ''}${alt ? ` | alt: "${alt}"` : ''}`);
    return {
      match: ok,
      alternativeTitle: alt || undefined,
      alternativeType: alt ? altType : undefined,
    };
  } catch {
    return { match: false };
  }
}

export async function verifyImageMatchesMovie(
  base64: string,
  mimeType: string,
  candidateTitle: string
): Promise<boolean> {
  if (!candidateTitle?.trim()) return false;
  if (!AI_LLM_ENABLED) return true;
  const croppedBase64 = await cropFrame(base64);
  const aiBase64 = await downscaleForAiPipeline(croppedBase64);
  const safeMime = mimeType.toLowerCase().startsWith('image/') ? mimeType : 'image/jpeg';
  const verifyRes = await llmVerifyCandidate(aiBase64, candidateTitle.trim(), safeMime);
  return verifyRes.match;
}

// ─── ASOSIY ANIQLASH ─────────────────────────────────────────────────────────

function pushDistinct(candidates: MovieIdentified[], m: MovieIdentified | null | undefined): void {
  if (!m?.title) return;
  if (candidates.some(c => titlesMatch(c.title, m.title))) return;
  candidates.push(m);
}

function mergeDistinctCandidates(...lists: MovieIdentified[][]): MovieIdentified[] {
  const merged: MovieIdentified[] = [];
  for (const list of lists) {
    for (const item of list) {
      pushDistinct(merged, item);
    }
  }
  return merged;
}

async function identifyMovieOnPreparedImage(
  preparedBase64: string,
  mimeType: string,
  textHint?: string | null,
  passLabel = 'Pass1'
): Promise<IdentifyMovieResult> {
  const withTimeout = <T>(p: Promise<T>, ms = 24000): Promise<T | null> =>
    Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]).catch(() => null);
  const aiBase64 = preparedBase64;
  const cropMime = mimeType.toLowerCase().startsWith('image/') ? mimeType : 'image/jpeg';

  const [faces, visionLlm] = await Promise.all([
    withTimeout(identifyByFaces(aiBase64), 25000),
    withTimeout(identifyByVisionLlm(aiBase64, textHint)),
  ]);

  console.log(`${passLabel} — Faces: ${faces?.title || '-'}, LLM: ${visionLlm?.title || '-'}`);

  const ordered: MovieIdentified[] = [];
  const pass1 = [faces, visionLlm].filter(Boolean) as MovieIdentified[];

  for (let i = 0; i < pass1.length; i++) {
    for (let j = i + 1; j < pass1.length; j++) {
      if (titlesMatch(pass1[i].title, pass1[j].title)) {
        pushDistinct(ordered, pass1[i]);
        break;
      }
    }
  }

  if (faces?.confidence === 'high') {
    pushDistinct(ordered, faces);
  }

  if (visionLlm && visionLlm.confidence !== 'low') {
    pushDistinct(ordered, visionLlm);
  }

  if (faces?.confidence === 'medium') {
    pushDistinct(ordered, faces);
  }

  if (ordered.length === 0) {
    pushDistinct(ordered, faces);
    if (visionLlm && visionLlm.confidence !== 'low') {
      pushDistinct(ordered, visionLlm);
    }
    // Faqat vision "low" bersa ham (yoki faces yo'q): tasdiq tsikl ishlashi uchun oxirgi imkon
    if (ordered.length === 0) {
      pushDistinct(ordered, visionLlm);
    }
  }

  console.log(`${passLabel} — Nomzodlar tartibi (tasdiq): ${ordered.map((c) => c.title).join(' → ') || '—'}`);

  /** Yuz + LLM bir xil bo‘lsa ham verify bosqichidan o‘tkazamiz — bir aktyorning boshqa filmi bo‘lishi mumkin. */
  let consensusCandidate: MovieIdentified | null = null;
  if (
    faces?.title &&
    visionLlm?.title &&
    visionLlm.confidence !== 'low' &&
    titlesMatch(faces.title, visionLlm.title)
  ) {
    consensusCandidate = {
      title: faces.title,
      type: faces.type ?? visionLlm.type,
      confidence: visionLlm.confidence ?? faces.confidence,
      allowAmbiguousFallback:
        canSurfaceAmbiguousCandidate(faces) || canSurfaceAmbiguousCandidate(visionLlm),
    };
    console.log(`${passLabel} — 🤝 faces+LLM konsensus — verify navbatiga birinchi qo‘yildi:`, consensusCandidate.title);
  }

  let lastAlternative: MovieIdentified | null = null;
  let verifyRan = false;
  const verifyQueue = consensusCandidate
    ? [consensusCandidate, ...ordered.filter((c) => !titlesMatch(c.title, consensusCandidate!.title))]
    : ordered;

  for (let i = 0; i < Math.min(verifyQueue.length, MAX_VERIFY); i++) {
    verifyRan = true;
    const cand = verifyQueue[i];
    const verifyRes = await withTimeout(llmVerifyCandidate(aiBase64, cand.title, cropMime), 28000);
    if (verifyRes?.match) {
      console.log(`${passLabel} — ✅ Tasdiqlangan:`, cand.title);
      return { ok: true, identified: stripAmbiguousFallbackFlag(cand) };
    }
    // Verify false bo'lsa lekin LLM aniq alternativ sarlavha bilsa — saqlab qo'yamiz
    if (verifyRes?.alternativeTitle && !lastAlternative) {
      lastAlternative = {
        title: verifyRes.alternativeTitle,
        type: verifyRes.alternativeType ?? cand.type,
        allowAmbiguousFallback: false,
      };
      console.log(`${passLabel} — 💡 LLM alternativ taklif:`, lastAlternative.title);
    }
  }

  // Hech bir nomzod tasdiqlanmadi, lekin LLM alternativ taklif bilsa —
  // uni ham verify dan o'tkazamiz (tasdiqsiz qaytarmaslik uchun)
  if (lastAlternative) {
    verifyRan = true;
    const altVerify = await withTimeout(llmVerifyCandidate(aiBase64, lastAlternative.title, cropMime), 28000);
    if (altVerify?.match) {
      console.log(`${passLabel} — ✅ Alternativ sarlavha tasdiqlandi:`, lastAlternative.title);
      return { ok: true, identified: stripAmbiguousFallbackFlag(lastAlternative) };
    }
    console.log(`${passLabel} — ⚠️ Alternativ sarlavha ham tasdiqlanmadi:`, lastAlternative.title);
    if (IMAGE_ACCEPT_ALTERNATIVE_WITHOUT_SECOND_VERIFY) {
      console.log(`${passLabel} — ✅ Alternativ sarlavha best-effort natija sifatida qabul qilindi:`, lastAlternative.title);
      return { ok: true, identified: bestEffortIdentified(lastAlternative) };
    }
  }

  if (!lastAlternative) {
    const bestEffort = verifyQueue.find((cand) =>
      canReturnBestEffortCandidate(cand, consensusCandidate)
    );
    if (bestEffort) {
      console.log(`${passLabel} — ✅ Best-effort natija (verify qattiq rad etdi, lekin signal kuchli):`, bestEffort.title);
      return { ok: true, identified: bestEffortIdentified(bestEffort) };
    }
  }

  if (!verifyRan) {
    console.log(`${passLabel} — ⚠️ Tasdiq uchun nomzod yo‘q`);
    return { ok: false, reason: 'no_candidates' };
  }
  const ambiguousList: MovieIdentified[] = [];
  for (const c of verifyQueue) {
    pushDistinct(ambiguousList, c);
  }
  if (lastAlternative) {
    pushDistinct(ambiguousList, lastAlternative);
  }
  const surfacedAmbiguous = ambiguousList.filter(canSurfaceAmbiguousCandidate);
  if (surfacedAmbiguous.length === 0) {
    console.log(`${passLabel} — ⚠️ Tasdiqdan keyin faqat zaif aktyor-taxminlari qoldi — nomzodlar ko‘rsatilmaydi`);
    return { ok: false, reason: 'no_candidates' };
  }
  console.log(`${passLabel} — ⚠️ Hech bir nomzod LLM tasdiqidan o\'tmadi — foydalanuvchiga nomzodlar:`, ambiguousList.map((x) => x.title).join(', '));
  return {
    ok: false,
    reason: 'llm_verify_failed',
    candidates: surfacedAmbiguous.slice(0, 5).map(stripAmbiguousFallbackFlag),
  };
}

/**
 * Rasm bo'yicha film: Azure OpenAI multimodal LLM + AWS Rekognition / tasdiq.
 */
export async function identifyMovie(base64: string, mimeType: string, textHint?: string | null): Promise<IdentifyMovieResult> {
  if (!AI_LLM_ENABLED) {
    console.warn('identifyMovie: Azure OpenAI sozlanmagan — rasm bo\'yicha aniqlash o\'chirilgan');
    return { ok: false, reason: 'no_candidates' };
  }

  const variants: PreparedImageVariant[] = [];
  const croppedBase64 = await cropFrame(base64);
  const primaryBase64 = await downscaleForAiPipeline(croppedBase64);
  pushPreparedVariant(variants, { label: 'Pass1', base64: primaryBase64 });

  const collected: MovieIdentified[][] = [];
  let firstFailure: IdentifyMovieResult | null = null;
  let fullPrepared = false;
  let enhancedPrepared = false;

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const result = await identifyMovieOnPreparedImage(variant.base64, 'image/jpeg', textHint, variant.label);
    if (result.ok) return result;
    if (!firstFailure) firstFailure = result;
    if (result.reason === 'llm_verify_failed' && result.candidates.length > 0) {
      collected.push(result.candidates);
    }

    if (i === 0 && !fullPrepared) {
      const fullBase64 = await downscaleForAiPipeline(base64);
      const addedFull = pushPreparedVariant(variants, { label: 'Pass2', base64: fullBase64 });
      fullPrepared = true;
      if (!addedFull && !enhancedPrepared) {
        const enhancedBase64 = await enhanceForAiVariant(base64);
        pushPreparedVariant(variants, { label: 'Pass3', base64: enhancedBase64 });
        enhancedPrepared = true;
      }
    } else if (i === 1 && !enhancedPrepared) {
      const enhancedBase64 = await enhanceForAiVariant(base64);
      pushPreparedVariant(variants, { label: 'Pass3', base64: enhancedBase64 });
      enhancedPrepared = true;
    }
  }

  const merged = mergeDistinctCandidates(...collected);
  if (merged.length > 0) {
    return { ok: false, reason: 'llm_verify_failed', candidates: merged.slice(0, 5) };
  }

  return firstFailure ?? { ok: false, reason: 'no_candidates' };
}

/**
 * Yakuniy film tanlanmaganda: Rekognition topgan aktyor(lar) bo‘yicha TMDB (va kerak bo‘lsa Kinopoisk) dan top-3 taxmin.
 */
export async function getActorFilmFallbackCandidates(
  base64: string
): Promise<{ actorNames: string[]; candidates: MovieIdentified[] } | null> {
  if (!TMDB_KEY) return null;
  let cropped: string;
  try {
    cropped = await cropFrame(base64);
    cropped = await downscaleForAiPipeline(cropped);
  } catch {
    cropped = base64;
  }
  const celebrities = await recognizeCelebrities(cropped);
  if (celebrities.length === 0) return null;
  if (
    celebrities.length < MIN_CELEBRITIES_FOR_STRONG_FACE_SIGNAL &&
    (celebrities[0]?.confidence ?? 0) < 96
  ) {
    console.log('⚠️ Fallback aktyor tavsiyalari bostirildi: signal zaif');
    return null;
  }

  const actorNames = celebrities.slice(0, 3).map((c) => c.name);
  const primary = celebrities[0].name;
  let films = await tmdbPersonMovies(primary);

  if (films.length === 0 && KP_KEY) {
    const kpFilms = await kinopoiskPersonMovies(primary);
    const tmdbResults: TmdbResult[] = [];
    for (const kf of kpFilms.slice(0, 15)) {
      const searchTitle = kf.nameEn || kf.nameOriginal || kf.nameRu || '';
      if (!searchTitle) continue;
      const tmdbHit = await tmdbSearch(searchTitle);
      if (tmdbHit?.result) tmdbResults.push(tmdbHit.result);
    }
    films = tmdbResults.sort(sortTmdbByRelevance).slice(0, PERSON_CREDITS_MAX);
  }
  if (films.length === 0) return null;

  const candidates: MovieIdentified[] = films.slice(0, 3).map((c) => ({
    title: c.title || c.name || '',
    type: (c.media_type === 'tv' ? 'tv' : 'movie') as MediaType,
    confidence: 'medium',
  }));
  return { actorNames, candidates };
}

// ─── MATN ORQALI FILM QIDIRISH ────────────────────────────────────────────────

/**
 * WALL-E ga xos syujet (o‘zbek/rus/lotin): kelajak, odamlar semirish, kursilarda passiv, bitta asosiy robot.
 * LLM ba’zan faqat "robot + sevgi" ni Love, Death & Robots bilan adashtiradi — shu uchun deterministik yo‘l.
 */
/**
 * Uzun syujet / gap ko'rinishidagi so'rovlarda TMDB/OMDB "birinchi nomzod"ni qabul qilmaslik —
 * foydalanuvchi "noto'g'ri topildi" deb yozadi.
 */
function looksLikeSentencePlot(q: string): boolean {
  const t = q.trim();
  if (t.length > 95) return true;
  const wc = t.split(/\s+/).filter(Boolean).length;
  if (wc > 11) return true;
  if (/[.!?][\s\S]{20,}[.!?]/.test(t)) return true;
  if (
    /\b(film|kino|serial)(da|ni|ni)?\b/i.test(t) &&
    /\b(edi|ekan|idi|qilgan|bo\'lgan|uchun|chunki|demak|keyin|boshida|oxirida|qachon|qayerda|kim)\b/i.test(t) &&
    wc >= 6
  ) {
    return true;
  }
  return false;
}

function looksLikeWallEPlotDescription(q: string): boolean {
  const n = q
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'");
  const obesity = /(semir|semiz|semirish|tols|tolst|ожирел|полн)/i.test(n);
  const chairs = /(kursi|kreslo|кресл|stul|кресел)/i.test(n);
  const robot = /robot|робот/i.test(n);
  return obesity && chairs && robot;
}

/** Faqat so‘rov bilan sarlavha mos kelsa (uzun syujet matnida birinchi IMDb — doimiy xato, masalan Westler). */
async function verifyPlotMatch(userQuery: string, movieTitle: string, tmdbOverview: string): Promise<boolean> {
  if (!AI_LLM_ENABLED || !tmdbOverview || tmdbOverview.length < 20) return true;
  const plotPrompt = `User described a movie/show like this (may be in Uzbek, Russian, or another language):
"${userQuery.slice(0, 500)}"

The system identified it as: "${movieTitle}"
Official plot: "${tmdbOverview}"

Does the user's description plausibly match this movie's plot? The user may describe only one scene, character, or aspect — not the full plot.
Answer ONLY "yes" or "no".`;
  try {
    const text = (await azureChatText('verifyPlotMatch', plotPrompt))?.trim().toLowerCase();
    if (text?.startsWith('no')) {
      console.log(`⚠️ Plot verification failed: user query vs "${movieTitle}"`);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function fetchTmdbLocalizedRecord(mediaType: MediaType, id: number, lang: string): Promise<TmdbResult | null> {
  if (!TMDB_KEY) return null;
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${id}`, {
      params: { api_key: TMDB_KEY, language: lang },
      timeout: TIMEOUT,
    });
    return r.data as TmdbResult;
  } catch {
    return null;
  }
}

async function identifyByWebSearch(query: string): Promise<MovieIdentified | null> {
  // Birinchi inglizcha qidiruv, keyin rus tilidagi (SNG filmlar uchun)
  const [enResults, ruResults] = await Promise.all([
    webSearch(`${query} movie imdb`),
    webSearch(`${query} фильм imdb`, 'ru', 'ru'),
  ]);
  for (const res of [...enResults, ...ruResults]) {
    const m = res.link.match(/imdb\.com\/title\/(tt\d+)/);
    if (!m) continue;
    const found = await omdbById(m[1]);
    if (!found) continue;
    if (titlesMatchNative(query, found.title)) {
      return { title: found.title, type: found.type };
    }
  }
  return null;
}

export type IdentifyFromTextResult =
  | { outcome: 'found'; identified: MovieIdentified }
  | { outcome: 'unclear' }
  | { outcome: 'not_found' };

/** Matnli qidiruv: topildi / noaniq (yil-janr so‘rang) / topilmadi */
export async function identifyFromTextDetailed(query: string): Promise<IdentifyFromTextResult> {
  const notFound = (): IdentifyFromTextResult => ({ outcome: 'not_found' });
  const found = (identified: MovieIdentified): IdentifyFromTextResult => ({ outcome: 'found', identified });
  const unclear = (): IdentifyFromTextResult => ({ outcome: 'unclear' });

  if (!query || query.trim().length < 2) return notFound();
  const normalizedQuery = query.trim().toLowerCase();
  const words = normalizedQuery.split(/\s+/).filter(w => w.length > 2);

  // 1. Literal OMDB/TMDB — nom bo'lib ko'rinadigan qisqa so'rovlar (7 gacha so'z; syujet emas)
  const literalWordOk = words.length >= 1 && words.length <= 7;
  if (literalWordOk && !looksLikeSentencePlot(query)) {
    const aliasHit = resolvePopularTitleAlias(query);
    if (aliasHit) {
      console.log(`🔤 Alias match: "${query}" -> "${aliasHit.title}"`);
      return found(aliasHit);
    }

    const omdb = await omdbSearch(query);
    if (omdb) return found({ title: omdb.title, type: omdb.type });

    const tmdb = await tmdbSearch(query);
    if (tmdb?.result) {
      const tmdbTitle = tmdb.result.title || tmdb.result.name || '';
      const tmdbOrigTitle = tmdb.result.original_title || tmdb.result.original_name || '';
      // SNG/CIS filmlar uchun: original_title (kirill/turk) bilan ham solishtirish
      // voteCount >= N yolg'iz shart qo'shilmasin — title match bo'lmasa noto'g'ri film qaytadi
      const queryMatches = titlesMatchNative(query, tmdbTitle, tmdbOrigTitle);
      if (queryMatches) {
        // Agar inglizcha sarlavha bo'sh bo'lsa, original sarlavhani ishlatamiz
        return found({ title: tmdbTitle || tmdbOrigTitle, type: tmdb.type });
      }
    }
  }

  // 2a. WALL-E syujeti — API xatosiz to‘g‘ridan-to‘g‘ri (OMDB ba’zan boshqa filmga ulab yuboradi)
  if (looksLikeWallEPlotDescription(query)) {
    console.log(`🎯 Plot heuristic → WALL-E (semirgan + kursi + robot)`);
    return found({ title: 'WALL-E', type: 'movie' });
  }

  // 2b. Veb qidiruv (SearXNG) — faqat so‘rov film sarlavhasiga o‘xshaganda
  const webHit = await identifyByWebSearch(query);
  if (webHit) {
    console.log(`🔍 Text identification (web): "${query}" -> Found "${webHit.title}"`);
    return found(webHit);
  }


  // 2c. Kinopoisk — SNG/CIS/turk filmlar uchun asosiy fallback (OMDB/TMDB topilmasa)
  if (KP_KEY && words.length <= 7) {
    const kp = await kinopoiskSearch(query);
    if (kp) {
      const kpTitle = kp.film.nameEn || kp.film.nameOriginal || kp.film.nameRu || '';
      console.log(`\u{1F3AC} Kinopoisk hit: "${kpTitle}" (${kp.film.filmId})`);
      const kpImdbId = await kinopoiskGetImdbId(kp.film.filmId);
      if (kpImdbId) {
        const omdbRes = await omdbById(kpImdbId);
        if (omdbRes) return found({ title: omdbRes.title, type: omdbRes.type });
        const tmdbRes = await tmdbByImdbId(kpImdbId);
        if (tmdbRes) {
          return found({ title: tmdbRes.result.title || tmdbRes.result.name || kpTitle, type: tmdbRes.type });
        }
      }
      if (kpTitle) return found({ title: kpTitle, type: kp.type });
    }
  }

  // 3. Veb qidiruv konteksti + LLM — uzun tavsiflar
  if (!AI_LLM_ENABLED) return notFound();

  const contextResults = await webSearch(`${query} qaysi film kino`, 'uz', 'uz');
  const snippets =
    contextResults.length > 0
      ? contextResults.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n\n')
      : '(Veb qidiruv natijalari bo‘sh — faqat foydalanuvchi tavsifiga tayan)';

  const llmPrompt = `You are a professional world cinema expert (Hollywood, Turkish, Korean, Russian, Kazakh, Kyrgyz, Uzbek, CIS/SNG, Bollywood, Iranian, Arab, etc.).
The user writes in Uzbek (Latin/Cyrillic) or Russian; they may paste a title, a poor transliteration, OR a scene/plot memory. The work can be from any country.

USER QUERY: "${query}"
WEB SEARCH SNIPPETS (may be empty or noisy):
${snippets}

Rules:
1. Plot descriptions: match the USER'S scenario (setting + premise), not loose keywords ("robot"+"love" alone is NOT enough).
2. If the query is mainly a TITLE (few words, no story): pick the film/series that matches that title in any script; prefer the standard English or original release title for TMDB lookup.
3. Prefer one famous FEATURE FILM over an anthology when the story is one continuous narrative.
4. CIS/SNG: use the most searchable primary title (sometimes Russian or English trade title, not a literal Uzbek translation of words).
5. Turkish: original Turkish title. Hollywood: original English title.
6. Output "title" must be the primary lookup string for TMDB/OMDB (NOT Uzbek marketing wording in the JSON — the bot adds Uzbek display separately).
7. If CIS/Central Asian setting is strongly suggested, consider CIS cinema before defaulting to Hollywood.
8. If still unsure but one title is most likely, use confidence "medium". Reserve "low" only when wildly ambiguous.

Respond ONLY with JSON:
{"title": "Primary searchable title", "type": "movie" or "tv", "confidence": "high/medium/low"}`;

  try {
    const textResponse = await azureChatText('identifyFromText_llm', llmPrompt);
    console.log(`🤖 Text identification (LLM): "${query}" -> Response:`, textResponse);

    const m = textResponse.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
      const conf = (p.confidence || '').toLowerCase();
      if (!p.title || p.title.toLowerCase() === 'unknown') return notFound();

      let verifiedTitle: string | null = null;
      let verifiedType: MediaType = p.type === 'tv' ? 'tv' : 'movie';
      let tmdbOverview: string | null = null;

      const omdbResult = await omdbSearch(p.title);
      if (omdbResult) {
        verifiedTitle = omdbResult.title;
        verifiedType = omdbResult.type;
      }

      const tmdbVerified = !verifiedTitle ? await tmdbSearch(p.title) : null;
      if (tmdbVerified?.result) {
        const tmdbTitle = tmdbVerified.result.title || tmdbVerified.result.name || '';
        const tmdbOrigTitle = tmdbVerified.result.original_title || tmdbVerified.result.original_name || '';
        tmdbOverview = tmdbVerified.result.overview || null;
        // SNG/CIS filmlar uchun: original_title (kirill/turk) bilan ham solishtirish, threshold 100 ga tushirildi
        if (titlesMatchNative(p.title, tmdbTitle, tmdbOrigTitle)) {
          verifiedTitle = tmdbTitle || tmdbOrigTitle;
          verifiedType = tmdbVerified.type;
        }
      }

      if (!verifiedTitle) {
        console.log(`🔍 LLM title verification (web): "${p.title}"`);
        const webVerify = await identifyByWebSearch(p.title);
        if (webVerify) {
          verifiedTitle = webVerify.title;
          verifiedType = webVerify.type;
        }
      }

      const isPlotQuery = words.length > 6;

      if (verifiedTitle && isPlotQuery) {
        if (!tmdbOverview) {
          const tmdbForPlot = await tmdbSearch(verifiedTitle);
          tmdbOverview = tmdbForPlot?.result?.overview || null;
        }
        if (tmdbOverview) {
          const plotOk = await verifyPlotMatch(query, verifiedTitle, tmdbOverview);
          if (!plotOk) return unclear();
        }
      }

      // Oxirida raqam bo'lsa (masalan "Iron Man 4"), sarlavhada shu raqam bo'lmasa — rad.
      // "Spider-Man 3" kabi nomdagi raqam titlesMatchNative bilan adashadi — faqat sequelNumberMismatch ishlatiladi.
      if (verifiedTitle && /\s\d{1,2}\s*$/.test(query.trim()) && sequelNumberMismatch(query, verifiedTitle)) {
        console.log(`LLM rad: so'rov "${query}" ↔ "${verifiedTitle}" (serial raqam mos emas)`);
        return notFound();
      }

      if (verifiedTitle) {
        return found({
          title: verifiedTitle,
          type: verifiedType,
          confidence: conf === 'high' ? undefined : 'medium',
        });
      }

      if (conf === 'high') {
        if (isPlotQuery) {
          if (!tmdbOverview) {
            const tmdbForPlot = await tmdbSearch(p.title);
            tmdbOverview = tmdbForPlot?.result?.overview || null;
          }
          if (tmdbOverview) {
            const plotOk = await verifyPlotMatch(query, p.title, tmdbOverview);
            if (!plotOk) return unclear();
          }
        }
        if (/\s\d{1,2}\s*$/.test(query.trim()) && sequelNumberMismatch(query, p.title)) {
          return notFound();
        }
        return found({ title: p.title, type: verifiedType });
      }
      return unclear();
    }
  } catch (err) {
    console.error(`❌ Text identification (LLM) error:`, (err as Error).message);
    return notFound();
  }

  return notFound();
}

export async function identifyFromText(query: string): Promise<MovieIdentified | null> {
  const r = await identifyFromTextDetailed(query);
  return r.outcome === 'found' ? r.identified : null;
}

// ─── FILM MA'LUMOTLARI VA WATCH LINKS ────────────────────────────────────────

async function translateToUzbek(text: string): Promise<string> {
  if (!text) return text;
  if (!AI_LLM_ENABLED) return text;
  const tPrompt = `Translate the following movie plot into Uzbek using Latin script only.

Output rules (critical):
- Return ONLY the translated plot text. No title, no preamble.
- Do NOT write "THOUGHTS:", explanations, chain-of-thought, or English commentary.
- Do NOT repeat the instructions.

Plot to translate:
${text}`;
  try {
    let out = (await azureChatText('translateToUzbek', tPrompt))?.trim() || text;
    const parts = out.split(/\n\n+/).filter((p) => {
      const t = p.trim();
      if (!t) return false;
      if (/^THOUGHTS:/i.test(t)) return false;
      if (/^I need to translate/i.test(t)) return false;
      if (/^Translate the following movie plot/i.test(t)) return false;
      if (/^Output rules/i.test(t)) return false;
      return true;
    });
    out = parts.join('\n\n').trim() || text;
    return out || text;
  } catch {
    return text;
  }
}

async function translateTitle(
  displayTitle: string,
  originalTitle: string,
  year: string,
  mediaType: MediaType,
): Promise<string> {
  if (!AI_LLM_ENABLED) return displayTitle;
  const kind = mediaType === 'tv' ? 'TV show' : 'movie';
  const orig = (originalTitle || '').trim();
  const disp = (displayTitle || '').trim();
  const y = (year || '').trim();
  const titlePrompt = `You are naming this ${kind} for Uzbek-speaking viewers (dubs, streaming, cinema).

TMDB English/international title: "${disp}"
Original title (may differ from English for foreign films): "${orig || disp}"
Release year: ${y || 'unknown'}

Rules — CRITICAL:
1. Do NOT produce a literal word-for-word translation of the English (or original) title. Uzbek releases often use a completely different market title (short phrase, different wording, or kept English).
2. Output the title that is actually used on Uzbek posters, TV, or sites like uzmovi / kinoxit when you know it. If several names exist, pick the most common search term users type.
3. If there is no well-known Uzbek market title, output the English title "${disp}" unchanged, not a guessed translation.
4. Output ONLY the Uzbek market title or English title — one line, no quotes, no explanation.
5. IMPORTANT: Output MUST be in Uzbek Latin script. Do NOT use Cyrillic characters. If you know the title only in Cyrillic, transliterate it to Uzbek Latin (e.g. "Sargardon Zamin" not "Блуждающая Земля").
6. If the film is only known in Uzbekistan under the original English (or Turkish, Korean, etc.) title, output that title unchanged — do NOT invent a "translation".`;
  try {
    const raw =
      (await azureChatText('translateTitle', titlePrompt))?.trim().replace(/^["']|["']$/g, '') || displayTitle;
    // Kirill harflari kelsa — noto'g'ri, displayTitle qaytaramiz
    const hasCyrillic = /[\u0400-\u04ff]/.test(raw);
    const result = hasCyrillic ? displayTitle : raw;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    return norm(result) === norm(disp) ? disp : result;
  } catch {
    return displayTitle;
  }
}

const ALLOWED_HOSTS = [
  // O'zbek streaming saytlari
  'kinoxit.net','uzmovi.tv','uzmovi.com','uzmovi.uz',
  'uzfilms.uz','kinolar.uz','movieuz.net','kino.uz',
  'cinemakachucha.com','kinogo.uz','kinouzbek.com',
  'freekino.net','uzbeklar.biz','hdkinolar.org','kinouzbek.net',
  'uzkinolar.com','kinozal.uz','tomosha.uz','kinouz.net',
  'uzplay.net','ziyouz.com','kinomor.uz','kinohd.uz',
  // Rossiya/CIS streaming
  'ok.ru','vk.com','vkvideo.ru','rutube.ru','dailymotion.com',
  'kinopoisk.ru','hd.kinopoisk.ru','ivi.ru','start.ru',
  'kinogo.biz','kinogo.fm','filmix.ac','lordfilm.rs','lordfilm.mx',
  'rezka.ag','hdrezka.me','hdrezka.ag','kinozal.tv','rutor.info',
  'yandex.ru','smotret-online.ru','kinopub.me',
  // Global platformalar
  'netflix.com','primevideo.com','hbomax.com','max.com','disneyplus.com',
];
const BLOCKED_HOSTS = [
  'youtube.com','youtu.be','tiktok.com','instagram.com','facebook.com',
  'twitter.com','x.com','t.me','google.com','wikipedia.org','reddit.com',
  'github.com','medium.com','academia.edu','pdf',
];

function canonHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\.|^m\./, ''); } catch { return ''; }
}

function isAllowedWatchUrl(url: string, title?: string): boolean {
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    if (title && /\b(pdf|kitob|leksiya|referat)\b/i.test(title)) return false;
    const host = canonHost(url);
    const banned = watchLinkBannedHosts();
    if (banned.has(host)) return false;
    if (BLOCKED_HOSTS.some(b => host === b || host.endsWith(`.${b}`))) return false;
    return ALLOWED_HOSTS.some(a => host === a || host.endsWith(`.${a}`));
  } catch { return false; }
}

/**
 * Sarlava oxiridagi qism raqami (2–15), yillar bilan adashmaslik — `sequelNumberMismatch` bilan bir xil oralig‘.
 */
function endSequelNumInSlug(titleSlug: string): number | null {
  const m = titleSlug.match(/\s(\d{1,2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n >= 2 && n <= 15) return n;
  return null;
}

function requiredSequelNumbersForWatchLink(allTitles: string[]): Set<number> {
  const s = new Set<number>();
  for (const raw of allTitles) {
    if (!raw?.trim()) continue;
    const n = endSequelNumInSlug(slugifyForMatch(raw));
    if (n != null) s.add(n);
  }
  return s;
}

function haystackHasSequelNumbers(haystack: string, nums: Set<number>): boolean {
  if (nums.size === 0) return true;
  for (const n of nums) {
    const num = String(n);
    const re = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`);
    if (!re.test(haystack)) return false;
  }
  return true;
}

/** TMDB sarlavhalaridan kelgan serial raqami snippet/url da alohida token bo‘lmasa, havola rad etiladi (masalan Dhoom 2 ≠ Dhoom 3). */
export function watchLinkSequelConstraintOk(allTitles: string[], haystack: string): boolean {
  return haystackHasSequelNumbers(haystack, requiredSequelNumbersForWatchLink(allTitles));
}

/**
 * Tomosha havolalari qidiruvi: saytlar odatda inglizcha (yoki TMDB original_title) nom bilan.
 * O‘zbekcha tarjima nomi (masalan "Yettinchi farzand") bilan qidiruv bo‘sh chiqishi mumkin.
 */
function isLinkRelevantToMovie(
  result: WebSearchSnippet,
  allTitles: string[],
  year: string,
  imdbId?: string | null,
): boolean {
  const blob = `${result.title || ''} ${result.snippet || ''} ${result.link}`.toLowerCase();
  if (imdbId && /^tt\d+$/i.test(imdbId) && blob.includes(imdbId.toLowerCase())) return true;

  let urlPath = '';
  try {
    urlPath = decodeURIComponent(new URL(result.link).pathname).replace(/[-_./]/g, ' ');
  } catch {
    urlPath = result.link;
  }

  const haystack = [
    slugifyForMatch(result.title || ''),
    slugifyForMatch(result.snippet || ''),
    slugifyForMatch(urlPath),
  ].join(' ');

  const seqNums = requiredSequelNumbersForWatchLink(allTitles);
  if (!haystackHasSequelNumbers(haystack, seqNums)) return false;

  const haystackWords = haystack.split(/\s+/).filter(w => w.length >= 3);

  for (const rawTitle of allTitles) {
    if (!rawTitle || rawTitle.trim().length < 2) continue;
    const titleSlug = slugifyForMatch(rawTitle);
    if (titleSlug.length < 2) continue;

    if (haystack.includes(titleSlug)) return true;

    const words = titleSlug.split(/\s+/).filter(w => w.length >= 3);
    if (words.length === 0) continue;

    const matchCount = words.filter(w =>
      haystack.includes(w) ||
      (w.length >= 4 && haystackWords.some(hw => hw.startsWith(w.slice(0, 4)) || w.startsWith(hw.slice(0, 4))))
    ).length;

    const threshold = words.length <= 2 ? words.length : Math.ceil(words.length * 0.5);
    if (matchCount >= threshold) return true;
  }

  if (year && year.length === 4 && haystack.includes(year)) {
    for (const rawTitle of allTitles) {
      const words = slugifyForMatch(rawTitle).split(/\s+/).filter(w => w.length >= 4);
      for (const w of words) {
        if (haystack.includes(w)) return true;
        if (haystackWords.some(hw => hw.startsWith(w.slice(0, 4)) || w.startsWith(hw.slice(0, 4)))) return true;
      }
    }
  }

  const primaryLatin = allTitles.find(t => /[a-z]/i.test(t));
  if (primaryLatin) {
    const longTok = slugifyForMatch(primaryLatin).split(/\s+/).filter(w => w.length >= 6 && !STOP_WORDS.has(w));
    for (const w of longTok) {
      if (haystack.includes(w)) return true;
    }
  }

  return false;
}

function collectWatchLinksFromResults(
  items: WebSearchSnippet[],
  seen: Set<string>,
  finalLinks: WatchLink[],
  allTitles: string[],
  year: string,
  imdbId: string | null | undefined,
  tag: string,
  ruSuffix: boolean,
  maxAdd: number,
): void {
  const startLen = finalLinks.length;
  for (const item of items) {
    if (finalLinks.length >= 5) break;
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    if (!isLinkRelevantToMovie(item, allTitles, year, imdbId)) {
      console.log(`🔗 Skipped (${tag}): ${host} — "${item.title?.slice(0, 60)}"`);
      continue;
    }
    seen.add(host);
    const t = item.title.length > 50 && ruSuffix ? host : item.title;
    finalLinks.push({ title: t, link: item.link, source: ruSuffix ? `${host} (RU)` : host });
    if (maxAdd > 0 && finalLinks.length - startLen >= maxAdd) break;
  }
}

/** Qat'iy filtr hech narsa qoldirmasa: qidiruv natijasidagi birinchi ruxsat etilgan havolalar (kinopoisk/ru odatda lotin sarlavha bermaydi). */
function relaxedFillFromResults(
  uzResults: WebSearchSnippet[],
  ruResults: WebSearchSnippet[],
  seen: Set<string>,
  finalLinks: WatchLink[],
  allTitles: string[],
): void {
  const seqNums = requiredSequelNumbersForWatchLink(allTitles);
  for (const item of [...uzResults, ...ruResults]) {
    if (finalLinks.length >= 4) break;
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    let pathPart = '';
    try {
      pathPart = decodeURIComponent(new URL(item.link).pathname).replace(/[-_./]/g, ' ');
    } catch {
      pathPart = item.link;
    }
    const haystack = [
      slugifyForMatch(item.title || ''),
      slugifyForMatch(item.snippet || ''),
      slugifyForMatch(pathPart),
    ].join(' ');
    if (!haystackHasSequelNumbers(haystack, seqNums)) continue;
    seen.add(host);
    const ru = /[а-яё]/i.test(item.title || '') && !/[a-z]{4,}/i.test(item.title || '');
    const t = (item.title || '').length > 50 ? host : item.title;
    finalLinks.push({ title: t, link: item.link, source: ru ? `${host} (RU)` : host });
    console.log(`🔗 Relaxed (title-only search match): ${host}`);
  }
}

/**
 * Tomosha havolalari: til bo'yicha qidiruv (veb: uz | ru | en). Bot default: `uz`.
 * UZ: O'zbek → (yetmasa) rus → IMDb.
 * RU: rus qidiruv.
 * EN: inglizcha "watch online" qidiruv.
 */
export async function findWatchLinks(
  englishDisplayTitle: string,
  originalTitle: string,
  year: string,
  uzTitle?: string,
  imdbId?: string | null,
  linkLocale: 'uz' | 'ru' | 'en' = 'uz',
): Promise<WatchLink[]> {
  const a   = (originalTitle || '').trim();
  const b   = (englishDisplayTitle || '').trim();
  const uz  = (uzTitle || '').trim();
  const allTitles = [...new Set([a, b, uz].filter(x => x.length > 0))];
  const primary   = a || b;
  const tt        = imdbId && /^tt\d+$/i.test(imdbId) ? imdbId : null;

  const seen       = new Set<string>();
  const finalLinks: WatchLink[] = [];

  if (linkLocale === 'en') {
    const q1 = year ? `${primary} ${year} watch online streaming` : `${primary} watch online streaming`;
    const r1 = await webSearch(q1, 'us', 'en');
    collectWatchLinksFromResults(r1, seen, finalLinks, allTitles, year, imdbId, 'en', false, 5);
    if (finalLinks.length < 2) {
      const r2 = await webSearch(`${primary} stream online Netflix Prime Video`, 'us', 'en');
      collectWatchLinksFromResults(r2, seen, finalLinks, allTitles, year, imdbId, 'en2', false, 4);
    }
    if (finalLinks.length === 0 && tt) {
      const imdb = await webSearch(`${tt} watch online`, 'us', 'en');
      collectWatchLinksFromResults(imdb, seen, finalLinks, allTitles, year, imdbId, 'imdb-en', false, 4);
    }
    if (finalLinks.length === 0) {
      relaxedFillFromResults(r1, [], seen, finalLinks, allTitles);
    }
    return finalLinks.slice(0, 5);
  }

  if (linkLocale === 'ru') {
    const q1 = year ? `${primary} ${year} смотреть онлайн` : `${primary} смотреть онлайн бесплатно`;
    const r1 = await webSearch(q1, 'ru', 'ru');
    collectWatchLinksFromResults(r1, seen, finalLinks, allTitles, year, imdbId, 'ru', true, 5);
    if (finalLinks.length < 2) {
      const r2 = await webSearch(`${primary} смотреть онлайн`, 'ru', 'ru');
      collectWatchLinksFromResults(r2, seen, finalLinks, allTitles, year, imdbId, 'ru2', true, 4);
    }
    if (finalLinks.length === 0 && tt) {
      const imdb = await webSearch(`${tt} смотреть онлайн`, 'ru', 'ru');
      collectWatchLinksFromResults(imdb, seen, finalLinks, allTitles, year, imdbId, 'imdb-ru', true, 4);
    }
    if (finalLinks.length === 0) {
      relaxedFillFromResults(r1, [], seen, finalLinks, allTitles);
    }
    return finalLinks.slice(0, 5);
  }

  // ── UZ: Step 1: O'zbek qidiruv ───────────────────────────────────────────
  // Bitta query da year + har ikkala yozuv variantini qamrab oladi (10 natija kifoya)
  const qUz = year
    ? `${primary} ${year} uzbek o'zbek tilida`
    : `${primary} uzbek o'zbek tilida`;

  const uzRes = await webSearch(qUz, 'uz', 'uz');

  // O'zbekcha nomda alohida qidiruv faqat agar nom juda farqli bo'lsa
  let uzTitleRes: WebSearchSnippet[] = [];
  if (uz && uz.toLowerCase() !== primary.toLowerCase() && uz.length > 3) {
    uzTitleRes = await webSearch(`${uz} uzbek tilida`, 'uz', 'uz');
  }

  collectWatchLinksFromResults(
    [...uzRes, ...uzTitleRes], seen, finalLinks, allTitles, year, imdbId, 'uz', false, 4
  );

  // ── Step 2: Rus qidiruv (faqat yetarli havola bo'lmasa) ─────────────────
  if (finalLinks.length < 2) {
    const ruRes = await webSearch(`${primary} смотреть онлайн`, 'ru', 'ru');
    for (const item of ruRes) {
      if (finalLinks.length >= 5) break;
      if (!isAllowedWatchUrl(item.link, item.title)) continue;
      const host = canonHost(item.link);
      if (seen.has(host)) continue;
      if (!isLinkRelevantToMovie(item, allTitles, year, imdbId)) continue;
      seen.add(host);
      finalLinks.push({ title: item.title.length > 50 ? host : item.title, link: item.link, source: `${host} (RU)` });
    }
  }

  // ── Step 3: IMDb ID bilan aniq qidiruv (hali ham bo'sh bo'lsa) ──────────
  if (finalLinks.length === 0 && tt) {
    const imdbRes = await webSearch(`${tt} o'zbek tilida смотреть`, 'uz', 'uz');
    collectWatchLinksFromResults(imdbRes, seen, finalLinks, allTitles, year, imdbId, 'imdb', false, 3);
    if (finalLinks.length === 0) {
      relaxedFillFromResults(imdbRes, [], seen, finalLinks, allTitles);
    }
  }

  // ── Fallback: hech narsa topilmasa — qat'iy filtr olmirish ──────────────
  if (finalLinks.length === 0) {
    relaxedFillFromResults([...uzRes, ...uzTitleRes], [], seen, finalLinks, allTitles);
  }

  return finalLinks.slice(0, 5);
}

export interface ResolvedTmdbMeta {
  tmdbId: number;
  mediaType: MediaType;
  imdbId: string | null;
  tmdbResult: TmdbResult;
  displayTitle: string;
  originalTitle: string;
  year: string;
}

export type ResolveTmdbResult =
  | { ok: true; meta: ResolvedTmdbMeta }
  | { ok: false; imdbId: string | null };

/** TMDB aniqlash (tarjima / havolalarsiz) — kesh va getMovieDetails uchun umumiy. */
export async function resolveTmdbMetadata(identified: MovieIdentified): Promise<ResolveTmdbResult> {
  const { title, type } = identified;

  let imdbId: string | null = null;
  const omdb = await omdbSearch(title, type === 'tv' ? 'series' : 'movie');
  if (omdb) imdbId = omdb.imdbId;

  let tmdbResult: TmdbResult | null = null;
  if (imdbId) {
    const found = await tmdbByImdbId(imdbId);
    if (found) {
      const rt = found.result.title || found.result.name || '';
      const ro = found.result.original_title || found.result.original_name || '';
      if (titlesMatchNative(title, rt, ro)) {
        tmdbResult = found.result;
      } else {
        imdbId = null;
      }
    }
  }
  if (!tmdbResult) {
    const found = await tmdbSearch(title, type);
    if (found) tmdbResult = found.result;
  }

  if (tmdbResult?.id) {
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbResult.id}`, {
        params: { api_key: TMDB_KEY, language: 'en-US' },
        timeout: TIMEOUT,
      });
      tmdbResult = { ...tmdbResult, ...r.data };
    } catch { /* ignore */ }
  }
  if (tmdbResult && !imdbId) {
    const ext = (tmdbResult as { imdb_id?: string }).imdb_id;
    if (ext && /^tt\d+$/i.test(String(ext))) imdbId = String(ext);
  }

  if (!tmdbResult?.id) {
    return { ok: false, imdbId };
  }

  const displayTitle = (type === 'tv' ? tmdbResult.name : tmdbResult.title) || title;
  const originalTitle = (type === 'tv' ? tmdbResult.original_name : tmdbResult.original_title) || title;
  const year = ((type === 'tv' ? tmdbResult.first_air_date : tmdbResult.release_date) || '').split('-')[0];

  return {
    ok: true,
    meta: {
      tmdbId: tmdbResult.id,
      mediaType: type,
      imdbId,
      tmdbResult,
      displayTitle,
      originalTitle,
      year,
    },
  };
}

export async function buildDetailsFromResolved(
  identified: MovieIdentified,
  meta: ResolvedTmdbMeta,
  locale: BotLocale = DEFAULT_LOCALE
): Promise<MovieDetails> {
  const { type } = identified;
  const { tmdbResult, displayTitle, originalTitle, year, imdbId } = meta;
  const rating = tmdbResult.vote_average ? tmdbResult.vote_average.toFixed(1) : 'N/A';
  const posterUrl = tmdbResult.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}` : null;
  const englishPlot = tmdbResult.overview || '';

  if (locale === 'ru') {
    const ruRec = tmdbResult.id ? await fetchTmdbLocalizedRecord(type, tmdbResult.id, 'ru-RU') : null;
    const ruLine = ((type === 'tv' ? ruRec?.name : ruRec?.title) || '').trim();
    const primaryRu = ruLine || displayTitle;
    let plotRu = (ruRec?.overview || '').trim();
    if (!plotRu && englishPlot) plotRu = englishPlot;
    const [plotOut, watchLinks] = await Promise.all([
      Promise.resolve(plotRu || plotEmpty('ru')),
      findWatchLinks(displayTitle, originalTitle, year, primaryRu, imdbId, 'ru'),
    ]);
    return {
      title: displayTitle,
      uzTitle: primaryRu,
      originalTitle,
      year,
      rating,
      posterUrl,
      plotUz: plotOut,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}` : null,
      watchLinks,
      tmdbId: tmdbResult.id ?? null,
      imdbId,
      mediaType: type,
    };
  }

  const uzRec = tmdbResult.id
    ? await fetchTmdbLocalizedRecord(type, tmdbResult.id, 'uz-UZ')
    : null;
  const tmdbUzLine = ((type === 'tv' ? uzRec?.name : uzRec?.title) || '').trim();
  const tmdbUzUsable =
    tmdbUzLine.length > 0 &&
    !titlesMatch(tmdbUzLine, displayTitle) &&
    !titlesMatch(tmdbUzLine, originalTitle);

  const uzTitle = tmdbUzUsable
    ? tmdbUzLine
    : await translateTitle(displayTitle, originalTitle, year, type);
  const [plotUz, watchLinks] = await Promise.all([
    englishPlot ? translateToUzbek(englishPlot) : Promise.resolve(plotEmpty('uz')),
    findWatchLinks(displayTitle, originalTitle, year, uzTitle, imdbId, 'uz'),
  ]);

  return {
    title: displayTitle,
    uzTitle,
    originalTitle,
    year,
    rating,
    posterUrl,
    plotUz,
    imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}` : null,
    watchLinks,
    tmdbId: tmdbResult.id ?? null,
    imdbId,
    mediaType: type,
  };
}

export async function buildDetailsWithoutTmdb(
  identified: MovieIdentified,
  imdbIdFromOmdb: string | null,
  locale: BotLocale = DEFAULT_LOCALE
): Promise<MovieDetails> {
  const { title, type } = identified;
  const displayTitle = title;
  const originalTitle = title;
  const year = '';
  const rating = 'N/A';
  const posterUrl = null;
  const englishPlot = '';

  if (locale === 'ru') {
    const uzTitle = displayTitle;
    const [plotUz, watchLinks] = await Promise.all([
      Promise.resolve(plotEmpty('ru')),
      findWatchLinks(displayTitle, originalTitle, year, uzTitle, imdbIdFromOmdb, 'ru'),
    ]);
    return {
      title: displayTitle,
      uzTitle,
      originalTitle,
      year,
      rating,
      posterUrl,
      plotUz,
      imdbUrl: imdbIdFromOmdb ? `https://www.imdb.com/title/${imdbIdFromOmdb}` : null,
      watchLinks,
      tmdbId: null,
      imdbId: imdbIdFromOmdb,
      mediaType: type,
    };
  }

  const uzTitle = await translateTitle(displayTitle, originalTitle, year, type);
  const [plotUz, watchLinks] = await Promise.all([
    englishPlot ? translateToUzbek(englishPlot) : Promise.resolve(plotEmpty('uz')),
    findWatchLinks(displayTitle, originalTitle, year, uzTitle, imdbIdFromOmdb, 'uz'),
  ]);

  return {
    title: displayTitle,
    uzTitle,
    originalTitle,
    year,
    rating,
    posterUrl,
    plotUz,
    imdbUrl: imdbIdFromOmdb ? `https://www.imdb.com/title/${imdbIdFromOmdb}` : null,
    watchLinks,
    tmdbId: null,
    imdbId: imdbIdFromOmdb,
    mediaType: type,
  };
}

export function movieDetailsFromCache(
  cached: MovieCacheEntry,
  opts: { tmdbId: number | null; imdbId: string | null; mediaType: MediaType },
  locale: BotLocale = DEFAULT_LOCALE
): MovieDetails {
  const imdbUrl = opts.imdbId ? `https://www.imdb.com/title/${opts.imdbId}` : null;
  let watchLinks: WatchLink[] = [];
  try {
    watchLinks = cached.watch_links ? (JSON.parse(cached.watch_links) as WatchLink[]) : [];
  } catch {
    watchLinks = [];
  }
  return {
    title: cached.title,
    uzTitle: cached.uz_title || cached.title,
    originalTitle: cached.original_title || cached.title,
    year: cached.year || '',
    rating: cached.rating || 'N/A',
    posterUrl: cached.poster_url || null,
    plotUz: cached.plot_uz || plotEmpty(locale),
    imdbUrl,
    watchLinks,
    tmdbId: opts.tmdbId,
    imdbId: opts.imdbId,
    mediaType: opts.mediaType,
  };
}

export type FilmCacheResolveResult =
  | { phase: 'hit'; details: MovieDetails }
  | { phase: 'miss'; r: ResolveTmdbResult };

/**
 * Title kesh → TMDB resolve → canonical kesh. Miss bo‘lsa handler `withRotatingStatus` ichida build qiladi.
 */
export async function resolveFilmCachePhase(
  identified: MovieIdentified,
  locale: BotLocale = DEFAULT_LOCALE
): Promise<FilmCacheResolveResult> {
  const cachedTitle = await getCached(identified.title, locale);
  if (
    cachedTitle &&
    cacheEntryMatchesIdentified(identified, cachedTitle) &&
    cachedWatchLinksNonEmpty(cachedTitle.watch_links) &&
    cachedLocalizedTitleIsValid(cachedTitle.uz_title, locale)
  ) {
    return {
      phase: 'hit',
      details: movieDetailsFromCache(
        cachedTitle,
        {
          tmdbId: cachedTitle.tmdb_id ?? null,
          imdbId: imdbIdFromMovieUrl(cachedTitle.imdb_url),
          mediaType: identified.type,
        },
        locale
      ),
    };
  }

  const r = await resolveTmdbMetadata(identified);
  if (r.ok) {
    const cachedTmdb = await getCachedByTmdb(r.meta.tmdbId, r.meta.mediaType, locale);
    if (
      cachedTmdb &&
      cacheEntryMatchesIdentified(identified, cachedTmdb) &&
      cachedWatchLinksNonEmpty(cachedTmdb.watch_links) &&
      cachedLocalizedTitleIsValid(cachedTmdb.uz_title, locale)
    ) {
      return {
        phase: 'hit',
        details: movieDetailsFromCache(
          cachedTmdb,
          {
            tmdbId: r.meta.tmdbId,
            imdbId: r.meta.imdbId,
            mediaType: r.meta.mediaType,
          },
          locale
        ),
      };
    }
  }

  return { phase: 'miss', r };
}

export async function getMovieDetails(
  identified: MovieIdentified,
  locale: BotLocale = DEFAULT_LOCALE
): Promise<MovieDetails> {
  const r = await resolveTmdbMetadata(identified);
  if (!r.ok) return buildDetailsWithoutTmdb(identified, r.imdbId, locale);
  return buildDetailsFromResolved(identified, r.meta, locale);
}

/** Instagram username validatsiya regex: harf, raqam, nuqta, pastki chiziq, 5-30 belgi */
const IG_USERNAME_RE = /^[a-z0-9][a-z0-9._]{3,28}[a-z0-9]$/;

/**
 * Rasmda Instagram UI ko'rinib turganida account nomini ajratib oladi.
 * Original (crop qilinmagan) rasm bilan chaqirilishi kerak.
 * Model avval platformani aniqlaydi — Instagram emasligiga ishonch hosil qilsa null qaytaradi.
 */
export async function extractInstagramSource(base64: string, telegramUserId?: number): Promise<string | null> {
  if (!AI_LLM_ENABLED) return null;
  const igPrompt = `Look at this image carefully.

Step 1 — Is this clearly an Instagram screenshot (Reels or post)?
You must see Instagram-specific UI elements: the Instagram profile avatar circle, username text next to it, follow button, like/comment/share icons in Instagram style, or @handle overlay on a Reel.
If you are NOT confident this is Instagram (e.g. it's a movie frame, TikTok, Telegram, a photo without any social media UI) → return {"platform": null, "account": null}

Step 2 — If it IS Instagram, find the account username shown in the UI (not a watermark on the video itself, not subtitle text, not a movie title).
The username appears next to the profile avatar circle, at the top of the post/reel, or as "@username" overlay.

Respond ONLY with JSON:
{"platform": "instagram", "account": "exact_username_here"}
or
{"platform": null, "account": null}

Rules:
- account must be the raw username, no @ symbol, lowercase
- If you see multiple usernames (e.g. collab post), return the PRIMARY/first account
- Return null if you cannot clearly read the username or are not sure`;
  try {
    const compact = await downscaleForInstagramExtract(base64);
    const text = await azureChatVision('extractInstagramSource', compact, 'image/jpeg', igPrompt, telegramUserId);
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { platform?: string | null; account?: string | null };

    if (!parsed.platform || parsed.platform !== 'instagram') return null;

    const acc = (parsed.account || '').trim().toLowerCase().replace(/^@/, '');
    if (!acc || acc === 'null') return null;
    if (!IG_USERNAME_RE.test(acc)) return null;

    return acc;
  } catch {
    return null;
  }
}
