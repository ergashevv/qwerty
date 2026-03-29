import { GoogleGenerativeAI, DynamicRetrievalMode } from '@google/generative-ai';
import axios from 'axios';
import { withGemini } from './geminiClient';
import sharpLib from 'sharp';
import { recognizeCelebrities, extractImdbId } from './rekognition';

export type MediaType = 'movie' | 'tv';

export interface MovieIdentified {
  title: string;
  type: MediaType;
  confidence?: string;
}

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
const SERPER_KEY = process.env.SERPER_API_KEY  || '';
const VISION_KEY = process.env.VISION_API_KEY  || '';
const IMGBB_KEY  = process.env.IMGBB_API_KEY   || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY  || '';
const KP_KEY     = process.env.KINOPOISK_API_KEY || '';
const KP_BASE    = 'https://kinopoiskapiunofficial.tech';
/** Matnli syujet qidiruvida Google Search grounding (pulli; Serper snippetlari ixtiyoriy o‘chadi). */
const GEMINI_GROUNDING_TEXT = process.env.GEMINI_GROUNDING_TEXT_SEARCH === 'true';
/** Faqat Gemini (multimodal + matn + tarjima). */
const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT    = 8000;

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
 * Kirill, turk, arab va boshqa non-ASCII matnlar uchun to'g'ridan-to'g'ri solishtirish.
 * normalizeTitle() ular uchun ishlamaydi (barcha non-ASCII ni o'chirib tashlaydi).
 */
export function titlesMatchNative(query: string, ...titles: string[]): boolean {
  const q = query.toLowerCase().trim();
  for (const t of titles) {
    if (!t) continue;
    const tc = t.toLowerCase().trim();
    if (tc === q) return true;
    if (tc.length >= 4 && q.includes(tc)) return true;
    if (q.length >= 4 && tc.includes(q)) return true;
    // titlesMatch (ASCII-normalized) ham sinab ko'ramiz
    if (titlesMatch(q, tc)) return true;
  }
  return false;
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
 * 24 soat ichida qayta qidirmaslik — Serper/Brave kreditini tejaydi.
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

/** uz_title Kirill harflarini o'z ichiga olsa — kesh eskirgan, qayta fetch kerak. */
export function cachedUzTitleIsValid(uzTitle: string | null | undefined): boolean {
  if (!uzTitle) return true;
  return !/[Ѐ-ӿ]/.test(uzTitle);
}

export function isNoisyTitle(title: string): boolean {
  return /\b(music video|official video|lyrics|ft\.|feat\.|vevo|trailer)\b/i.test(title);
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

interface TmdbResult {
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

/** Yuz → TMDB: kesishuvdan keyin Gemini tanlaydigan nomzodlar soni (oldingi 5 — juda tor) */
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
      ? (results.find(x => (x.media_type === 'movie' || x.media_type === 'tv') && titlesMatch(query, x.title || x.name || '')) || 
         results.find(x => x.media_type === 'movie' || x.media_type === 'tv'))
      : (results.find(x => titlesMatch(query, x.title || x.name || '')) || results[0]);

    if (!hit) return null;
    const mtype: MediaType = (hit.media_type === 'tv' || type === 'tv') ? 'tv' : 'movie';
    return { result: hit, type: mtype };
  } catch { return null; }
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
      .sort(sortTmdbByRelevance)
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
      if (!titlesMatch(query, item.Title)) continue;
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

// ─── SERPER / BRAVE / GOOGLE CSE ─────────────────────────────────────────────

interface SerperResult { title: string; link: string; snippet?: string; }

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const CSE_KEY   = process.env.GOOGLE_CSE_KEY || '';
const CSE_ID    = process.env.GOOGLE_CSE_ID  || '';
let _cseDisabled = false; // bir marta xato bo'lsa, qayta urinmaymiz

/** Brave Search API — ~1000 bepul/oy (api.search.brave.com) */
async function braveSearch(query: string): Promise<SerperResult[]> {
  if (!BRAVE_KEY) return [];
  try {
    const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: 10 },
      headers: { 'X-Subscription-Token': BRAVE_KEY, 'Accept': 'application/json' },
      timeout: TIMEOUT,
    });
    return (r.data.web?.results || []).map((item: { title: string; url: string; description?: string }) => ({
      title: item.title || '',
      link: item.url || '',
      snippet: item.description || '',
    }));
  } catch (e) {
    console.warn('Brave Search xato:', (e as Error).message?.slice(0, 80));
    return [];
  }
}

/** Google Custom Search — 100 bepul/kun (console.cloud.google.com) */
async function googleCseSearch(query: string): Promise<SerperResult[]> {
  if (!CSE_KEY || !CSE_ID || _cseDisabled) return [];
  try {
    const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: { key: CSE_KEY, cx: CSE_ID, q: query, num: 10 },
      timeout: TIMEOUT,
    });
    return (r.data.items || []).map((item: { title: string; link: string; snippet?: string }) => ({
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
    }));
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 403) {
      _cseDisabled = true;
      console.warn('⚠️ Google CSE 403 — o\'chirildi (session davomida qayta urinilmaydi)');
    } else {
      console.warn('Google CSE xato:', (e as Error).message?.slice(0, 80));
    }
    return [];
  }
}

/**
 * Qidiruv: Serper (asosiy) → Brave (fallback 1) → Google CSE (fallback 2).
 * Serper kredit tugasa yoki key yo'q bo'lsa avtomatik keyingiga o'tadi.
 */
async function serperSearch(query: string, gl = 'uz', hl = 'uz'): Promise<SerperResult[]> {
  if (SERPER_KEY) {
    try {
      const r = await axios.post('https://google.serper.dev/search',
        { q: query, gl, hl, num: 10 },
        { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
      );
      const results = r.data.organic || [];
      console.log(`🔎 Serper: "${query.slice(0, 40)}" → ${results.length} natija`);
      return results;
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 400 || status === 402 || status === 429) {
        console.warn(`⚠️ Serper ${status} kredit/limit — Brave ga o'tilmoqda`);
        console.log(`🦁 Brave: "${query.slice(0, 40)}"`);
        const brave = await braveSearch(query);
        if (brave.length > 0) return brave;
        console.log(`🔍 Google CSE: "${query.slice(0, 40)}"`);
        return googleCseSearch(query);
      }
      return [];
    }
  }
  // Serper key yo'q — Brave, so'ng Google CSE
  console.log(`🦁 Brave: "${query.slice(0, 40)}"`);
  const brave = await braveSearch(query);
  if (brave.length > 0) return brave;
  console.log(`🔍 Google CSE: "${query.slice(0, 40)}"`);
  return googleCseSearch(query);
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
    // Aniq mos kelmasa — birinchi natija (odatda eng mos keladigan)
    return { film: films[0], type: toMediaType(films[0].type) };
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

// ─── GOOGLE VISION ───────────────────────────────────────────────────────────

interface VisionWebDetection {
  bestGuessLabels?: Array<{ label?: string }>;
  pagesWithMatchingImages?: Array<{ pageTitle?: string; url?: string }>;
  webEntities?: Array<{ description?: string; score?: number }>;
}

const VISION_SKIP = new Set([
  'screenshot','film','cinema','movie','video','image','television','person',
  'man','woman','actor','actress','entertainment','scene','media','watermark',
  'poster','photo','picture','human','people','face','faces','portrait','crowd',
  'instagram','tiktok','telegram','reels','social media',
  // Uzbek streaming platform watermarks — rasmni adashtirib yuboradi
  'tasavvur','cinemascenefuz','kinogo','uzmovi','multfilm','uzkinofilm',
  'kinolar.uz','ok.ru','rutube','ivi','kinopoisk','uzfilms',
  // "Behind the scenes" / documentary noise — film sahnalari emas
  'behind the scenes','making of','nos bastidores','bastidores de hollywood',
  'on the set','film set','movie set','hollywood history',
]);

async function identifyByVision(base64: string): Promise<MovieIdentified | null> {
  if (!VISION_KEY) return null;
  try {
    const r = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`,
      { requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 20 }] }] },
      { timeout: TIMEOUT }
    );
    const wd: VisionWebDetection = r.data?.responses?.[0]?.webDetection || {};

    const pages = (wd.pagesWithMatchingImages || []).filter(
      p => !/youtube|youtu\.be|tiktok|instagram|facebook|twitter|spotify|vevo/i.test(p.url || '')
    );

    // IMDb URL dan to'g'ridan topish
    for (const p of pages) {
      const m = (p.url || '').match(/imdb\.com\/title\/(tt\d+)/);
      if (m && OMDB_KEY) {
        const found = await omdbById(m[1]);
        if (found) return { title: found.title, type: found.type };
      }
    }

    // IMDb sahifa nomi
    const imdbPage = pages.find(p => /imdb/i.test(p.url || '') && p.pageTitle);
    if (imdbPage) {
      const title = imdbPage.pageTitle!
        .replace(/\s*[-–|]\s*IMDb.*/i, '')
        .replace(/\s*\(\d{4}\).*/,'').trim();
      if (title.length > 2) {
        const found = await omdbSearch(title);
        if (found) return { title: found.title, type: found.type };
      }
    }

    // bestGuess — VISION_SKIP ga kirgan so'zlar bo'lsa o'tkazib yuboramiz
    const bg = wd.bestGuessLabels?.[0]?.label || '';
    const bgWords = bg.toLowerCase().split(/\s+/);
    const bgHasNoise = bgWords.some(w => VISION_SKIP.has(w));
    if (bg && !bgHasNoise && !VISION_SKIP.has(bg.toLowerCase()) && bg.length > 2) {
      const found = await omdbSearch(bg);
      if (found) return { title: found.title, type: found.type };
    }

    // web entities — faqat aniq film nomlari; shovqinli yoki watermark so'zlar o'tkaziladi
    const isNoisy = (desc: string) => {
      const lower = desc.toLowerCase();
      // To'liq so'z to'plami tekshiruvi
      if (VISION_SKIP.has(lower)) return true;
      // "behind the scenes", "bastidores", watermark nomlari — qisman moslik
      if (/bastidores|behind.the.scenes|making.of|on.the.set|tasavvur|cinemascenefuz/i.test(lower)) return true;
      return false;
    };
    const entities = (wd.webEntities || [])
      .filter(e => (e.score || 0) > 0.6 && e.description && !isNoisy(e.description))
      .map(e => e.description!)
      .slice(0, 5);
    for (const entity of entities) {
      const found = await omdbSearch(entity);
      if (found) return { title: found.title, type: found.type };
    }
  } catch (e) {
    console.warn('Vision xato:', (e as Error).message?.slice(0, 60));
  }
  return null;
}

// ─── AWS REKOGNITION → TMDb KESISHUVI ────────────────────────────────────────

async function identifyByFaces(base64: string): Promise<MovieIdentified | null> {
  const celebrities = await recognizeCelebrities(base64);
  if (celebrities.length === 0) return null;

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
      const sortedKp = kpCandidates.sort(sortTmdbByRelevance).slice(0, FACE_CANDIDATE_LIMIT);
      const names = celebrities.map(c => c.name).join(', ');
      const titles = sortedKp.map(c => c.title || c.name).join(' | ');
      console.log(`\u{1F3AC} Kinopoisk person fallback candidates: ${titles}`);
      if (sortedKp.length === 1) {
        const c = sortedKp[0];
        return { title: c.title || c.name || '', type: (c.media_type === 'tv' ? 'tv' : 'movie') as MediaType, confidence: 'medium' };
      }
      if (GEMINI_KEY) {
        const pickG = await geminiPickFromCandidates(base64, names, titles);
        if (pickG) return pickG;
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

  candidates = candidates.sort(sortTmdbByRelevance).slice(0, FACE_CANDIDATE_LIMIT);
  console.log('🎬 Candidates:', candidates.map(c => c.title || c.name).join(', '));

  // Bitta qolsa — aniq
  if (candidates.length === 1) {
    const c = candidates[0];
    const title = c.title || c.name || '';
    const type: MediaType = (c.media_type === 'tv') ? 'tv' : 'movie';
    return { title, type, confidence: 'high' };
  }

  // Ko'p nomzod: Gemini tanlaydi; topilmasa — TMDB reytingi bo'yicha fallback
  if (candidates.length > 1 && GEMINI_KEY) {
    const names = celebrities.map(c => c.name).join(', ');
    const titles = candidates.map(c => c.title || c.name).join(' | ');
    const pickG = await geminiPickFromCandidates(base64, names, titles);
    if (pickG) return pickG;
  }
  if (candidates.length > 1) {
    const best = [...candidates].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
    return {
      title: best.title || best.name || '',
      type: best.media_type === 'tv' ? 'tv' : 'movie',
      confidence: 'medium',
    };
  }

  return null;
}

async function geminiPickFromCandidates(base64: string, actors: string, candidates: string): Promise<MovieIdentified | null> {
  if (!GEMINI_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() =>
      model.generateContent([
        { inlineData: { data: base64, mimeType: 'image/jpeg' } },
        {
          text: `Recognized actors: ${actors}
Candidate movies/shows (pick exactly ONE from this list): ${candidates}

Look at the screenshot carefully. Based on the scene details (costumes, setting, lighting, props, visible text in the film frame), which ONE of the candidates does this screenshot belong to?

IMPORTANT RULES:
1. You MUST pick from the candidates list ONLY — do NOT suggest any title outside this list.
2. These actors were identified with high confidence by face recognition — the film is almost certainly in this list.
3. If you are uncertain between two, pick the one whose visual context (style, setting, tone) best matches.
4. Use "medium" confidence if you are not fully sure — but still pick the best match from the list.
5. Only use confidence "low" with empty title if the image has NO connection to any candidate (e.g. it is clearly a non-film image like a real-life photo or meme).

Respond ONLY with JSON:
{"title": "Exact title from candidates", "type": "movie" or "tv", "confidence": "high/medium/low"}`,
        },
      ])
    );
    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
    const t = (parsed.title || '').trim();
    if (!t) return null;
    const conf = (parsed.confidence || '').toLowerCase();
    if (conf === 'low') return null;
    return {
      title: t,
      type: parsed.type === 'tv' ? 'tv' : 'movie',
      confidence: parsed.confidence,
    };
  } catch { return null; }
}

// ─── GEMINI CROSS-CHECK ───────────────────────────────────────────────────────

async function identifyByGemini(base64: string, textHint?: string | null): Promise<MovieIdentified | null> {
  if (!GEMINI_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const hintLine = textHint
      ? `\nUser hint (may be a movie name, actor, or description in Uzbek/Russian/English): "${textHint.slice(0, 200)}" — use this as an additional clue, but only if it actually matches the screenshot.`
      : '';
    const result = await withGemini(() =>
      model.generateContent([
        {
          inlineData: { data: base64, mimeType: 'image/jpeg' },
        },
        `You are a world cinema expert. Identify the EXACT movie or TV show in this screenshot.

The film can be from ANY country: Hollywood, Turkey, Korea, Russia, Kazakhstan, Uzbekistan, Kyrgyzstan, Azerbaijan, India, Iran, or anywhere else. Do NOT bias toward any region.${hintLine}

Key clues to analyze:
1. Actors' faces — recognize them if possible
2. Costumes and clothing style (fantasy? period? modern? nomad? prison?)
3. Setting and location (fantasy world? steppe? city? historical?)
4. Any visible text (subtitles, watermarks, on-screen logos in any language) — ignore social media UI overlay
5. Language of subtitles if visible
6. Overall visual style and production quality

Respond ONLY with JSON:
{"title": "Exact title or unknown", "type": "movie" or "tv", "confidence": "high/medium/low"}

Rules:
- Use confidence "high" or "medium" only if you genuinely recognize this specific film.
- Use "unknown" + "low" if you cannot identify the specific title (not just the genre/region).
- Do NOT guess a title just because it fits the genre — only respond with a title you actually recognize.`,
      ])
    );
    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
    if (!parsed.title || parsed.title.toLowerCase() === 'unknown') return null;
    const gemConf = (parsed.confidence || '').toLowerCase();
    if (gemConf !== 'high' && gemConf !== 'medium') return null;

    const verified = await omdbSearch(parsed.title);
    if (verified) return { title: verified.title, type: verified.type, confidence: parsed.confidence };
    return { title: parsed.title, type: parsed.type === 'tv' ? 'tv' : 'movie', confidence: parsed.confidence };
  } catch (e) {
    console.warn('Gemini xato:', (e as Error).message?.slice(0, 200));
    return null;
  }
}

// ─── SMART CROP (watermark/UI olib tashlash) ─────────────────────────────────

async function cropFrame(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharpLib(buf).metadata();
    const w = meta.width || 1080;
    const h = meta.height || 1920;
    const ratio = w / h;

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

// ─── GEMINI BILAN TASDIQLASH ─────────────────────────────────────────────────

/** Faqat aniq "match": true bo'lsa true — taxminni rad etish uchun "fail-closed". */
interface VerifyResult {
  match: boolean;
  /** Verify false bo'lsa lekin Gemini boshqa aniq sarlavha bilsa — shu yerda qaytariladi */
  alternativeTitle?: string;
  alternativeType?: MediaType;
}

async function geminiVerify(base64: string, candidateTitle: string, mimeType: string): Promise<VerifyResult> {
  if (!GEMINI_KEY) return { match: false };
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() =>
      model.generateContent([
        { inlineData: { data: base64, mimeType: mimeType } },
        {
          text: `Does this screenshot clearly belong to the movie/TV show "${candidateTitle}"?

CRITICAL RULES:
1. IGNORE watermarks and overlaid text (TASAVVUR, CINEMASCENEUZ, channel logos, player UI, timestamps)
2. IGNORE social media interface around the video
3. Focus on the actual film scene: faces, costumes, setting, lighting, animation vs live-action
4. If "${candidateTitle}" is a documentary / behind-the-scenes / book about cinema (not a narrative film), answer false
5. Answer true ONLY if you are confident this frame is from "${candidateTitle}" — not from a similar title, sequel, or different film with the same actor
6. Answer false if: image quality is too poor, scene could plausibly be from several different films, wrong medium (e.g. cartoon vs live-action), or you have meaningful doubt
7. If match is false but you are CONFIDENT you know the EXACT correct title, fill in "alternativeTitle" and "alternativeType". Only fill these if you are certain — leave empty strings if unsure.

Answer ONLY with JSON:
{"match": true} 
or
{"match": false, "reason": "brief explanation", "alternativeTitle": "Exact title or empty string", "alternativeType": "movie or tv or empty string"}`,
        },
      ])
    );
    const text = result.response.text();
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
    console.log(`🔍 Gemini verify "${candidateTitle}": ${ok} — ${parsed.reason || ''}${alt ? ` | alt: "${alt}"` : ''}`);
    return {
      match: ok,
      alternativeTitle: alt || undefined,
      alternativeType: alt ? altType : undefined,
    };
  } catch {
    return { match: false };
  }
}

// ─── ASOSIY ANIQLASH ─────────────────────────────────────────────────────────

function pushDistinct(candidates: MovieIdentified[], m: MovieIdentified | null | undefined): void {
  if (!m?.title) return;
  if (candidates.some(c => titlesMatch(c.title, m.title))) return;
  candidates.push(m);
}

/**
 * Rasm bo'yicha film: faqat Gemini (multimodal) + Vision / Rekognition / tasdiq.
 * GEMINI_API_KEY majburiy.
 */
export async function identifyMovie(base64: string, mimeType: string, textHint?: string | null): Promise<MovieIdentified | null> {
  const withTimeout = <T>(p: Promise<T>, ms = 10000): Promise<T | null> =>
    Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]).catch(() => null);

  if (!GEMINI_KEY) {
    console.warn('identifyMovie: GEMINI_API_KEY yo\'q — rasm bo\'yicha aniqlash o\'chirilgan');
    return null;
  }

  const croppedBase64 = await cropFrame(base64);
  const cropMime = 'image/jpeg';

  const [faces, vision, gemini] = await Promise.all([
    withTimeout(identifyByFaces(croppedBase64), 25000),
    withTimeout(identifyByVision(croppedBase64)),
    withTimeout(identifyByGemini(croppedBase64, textHint)),
  ]);

  console.log(`Pass1 — Faces: ${faces?.title || '-'}, Vision: ${vision?.title || '-'}, Gemini: ${gemini?.title || '-'}`);

  /**
   * Tasdiq tartibi: avvalo ikki manba (yuz + vision yoki boshqa juftlik) kelishgan nomzod,
   * keyin yuqori ishonchli yuz, vision, eng oxirida yolg‘iz Gemini taklifi.
   * Oldin Gemini birinchi qo‘yilgandi — shunda noto‘g‘ri Gemini javobi birinchi tekshirilib,
   * “tasdiqlangan” bo‘lib qolardi, aslida to‘g‘ri konsensus (masalan Faces+Vision) esa keyin.
   */
  const ordered: MovieIdentified[] = [];
  const pass1 = [faces, vision, gemini].filter(Boolean) as MovieIdentified[];

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

  if (vision) {
    pushDistinct(ordered, vision);
  }

  if (gemini && gemini.confidence !== 'low') {
    pushDistinct(ordered, gemini);
  }

  if (faces?.confidence === 'medium') {
    pushDistinct(ordered, faces);
  }

  if (ordered.length === 0) {
    pushDistinct(ordered, faces);
    pushDistinct(ordered, vision);
    if (gemini && gemini.confidence !== 'low') {
      pushDistinct(ordered, gemini);
    }
  }

  console.log(`Nomzodlar tartibi (tasdiq): ${ordered.map((c) => c.title).join(' → ') || '—'}`);

  /**
   * Rekognition (yuz) va Vision ikkalasi ham bir xil filmni ko‘rsatsa — bu mustaqil konsensus.
   * Keyingi bosqichdagi geminiVerify aynan shu kadrlarda tez-tez false negative beradi (xuddi rasm, turli marta rad).
   * Shuning uchun konsensusda Gemini verify o‘tkazilmaydi.
   */
  if (faces?.title && vision?.title && titlesMatch(faces.title, vision.title)) {
    const consensus: MovieIdentified = {
      title: faces.title,
      type: faces.type ?? vision.type,
      confidence: faces.confidence ?? vision.confidence,
    };
    console.log('✅ faces+vision konsensus — Gemini verify o‘tkazilmaydi:', consensus.title);
    return consensus;
  }

  const MAX_VERIFY = 8;
  let lastAlternative: MovieIdentified | null = null;

  for (let i = 0; i < Math.min(ordered.length, MAX_VERIFY); i++) {
    const cand = ordered[i];
    const verifyRes = await withTimeout(geminiVerify(croppedBase64, cand.title, cropMime));
    if (verifyRes?.match) {
      console.log('✅ Tasdiqlangan:', cand.title);
      return cand;
    }
    // Verify false bo'lsa lekin Gemini aniq alternativ sarlavha bilsa — saqlab qo'yamiz
    if (verifyRes?.alternativeTitle && !lastAlternative) {
      lastAlternative = { title: verifyRes.alternativeTitle, type: verifyRes.alternativeType ?? cand.type };
      console.log('💡 Gemini alternativ taklif:', lastAlternative.title);
    }
  }

  // Hech bir nomzod tasdiqlanmadi, lekin Gemini alternativ taklif bilsa —
  // uni ham verify dan o'tkazamiz (tasdiqsiz qaytarmaslik uchun)
  if (lastAlternative) {
    const altVerify = await withTimeout(geminiVerify(croppedBase64, lastAlternative.title, cropMime));
    if (altVerify?.match) {
      console.log('✅ Alternativ sarlavha tasdiqlandi:', lastAlternative.title);
      return lastAlternative;
    }
    console.log('⚠️ Alternativ sarlavha ham tasdiqlanmadi:', lastAlternative.title);
  }

  console.log('⚠️ Hech bir nomzod Gemini tasdiqidan o\'tmadi');
  return null;
}

// ─── MATN ORQALI FILM QIDIRISH ────────────────────────────────────────────────

/**
 * WALL-E ga xos syujet (o‘zbek/rus/lotin): kelajak, odamlar semirish, kursilarda passiv, bitta asosiy robot.
 * LLM ba’zan faqat "robot + sevgi" ni Love, Death & Robots bilan adashtiradi — shu uchun deterministik yo‘l.
 */
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
  if (!GEMINI_KEY || !tmdbOverview || tmdbOverview.length < 20) return true;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() =>
      model.generateContent(
        `User described a movie/show like this (may be in Uzbek, Russian, or another language):
"${userQuery.slice(0, 500)}"

The system identified it as: "${movieTitle}"
Official plot: "${tmdbOverview}"

Does the user's description plausibly match this movie's plot? The user may describe only one scene, character, or aspect — not the full plot.
Answer ONLY "yes" or "no".`
      )
    );
    const text = result.response.text()?.trim().toLowerCase();
    if (text?.startsWith('no')) {
      console.log(`⚠️ Plot verification failed: user query vs "${movieTitle}"`);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function identifyBySerper(query: string): Promise<MovieIdentified | null> {
  // Birinchi inglizcha qidiruv, keyin rus tilidagi (SNG filmlar uchun)
  const [enResults, ruResults] = await Promise.all([
    serperSearch(`${query} movie imdb`),
    serperSearch(`${query} фильм imdb`, 'ru', 'ru'),
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

  // 1. Literal OMDB/TMDB check — faqat QISQA so'rovlar (nomlar) uchun
  if (words.length <= 4) {
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

  // 2b. Serper — faqat so‘rov film sarlavhasiga o‘xshaganda (matn bilan titlesMatch)
  const serper = await identifyBySerper(query);
  if (serper) {
    console.log(`🔍 Text identification (Serper): "${query}" -> Found "${serper.title}"`);
    return found(serper);
  }


  // 2c. Kinopoisk — SNG/CIS/turk filmlar uchun asosiy fallback (OMDB/TMDB topilmasa)
  if (KP_KEY && words.length <= 5) {
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

  // 3. Serper konteksti + LLM — uzun tavsiflar
  if (!GEMINI_KEY) return notFound();

  const contextResults = GEMINI_GROUNDING_TEXT
    ? []
    : await serperSearch(`${query} qaysi film kino`, 'uz', 'uz');
  const snippets = GEMINI_GROUNDING_TEXT
    ? '(Google Search grounding yoqilgan — qidiruv model ichida)'
    : contextResults.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n\n');

  const llmPrompt = `You are a professional world cinema expert with deep knowledge of Hollywood, Turkish, Korean, Russian, Kazakh, Kyrgyz, Uzbek, Azerbaijani, Tajik, and other CIS/SNG cinema. You also know Bollywood, Iranian, and Arab cinema.
The user (Uzbek-speaking) might be describing a specific scene, plot, or character they remember. The film could be from ANY country.

USER QUERY: "${query}"
GOOGLE SEARCH CONTEXT (clues):
${snippets}

Rules:
1. Match the USER'S FULL PLOT, not only loose keywords. Example: "robot" + "love" appears in many works — pick the one whose ENTIRE scenario fits (setting, premise, ending).
2. Prefer a single famous FEATURE FILM over an anthology TV series when the description is one continuous story.
3. For CIS/SNG films: provide the most widely known title — could be Russian, Kazakh, Turkish, or English depending on which is most searchable. Example: Kazakh film "Nomad" is better than its Kazakh title "Көшпенділер".
4. For Turkish films/series: provide the original Turkish title (e.g. "Diriliş: Ertuğrul", not translated).
5. For Hollywood/international: provide the original English title.
6. DO NOT translate the movie title literally into Uzbek.
7. If the description sounds like a CIS/Central Asian film (steppe landscape, nomad culture, Soviet-era setting, collective farm, etc.) — consider CIS cinema first.
8. If two titles share words but only one matches the plot details, choose that one. If still ambiguous, use confidence "medium" or "low".

Respond ONLY with this JSON structure:
{"title": "Most searchable title for this film", "type": "movie" or "tv", "confidence": "high/medium/low"}`;

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = GEMINI_GROUNDING_TEXT
      ? genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          tools: [
            {
              googleSearchRetrieval: {
                dynamicRetrievalConfig: {
                  mode: DynamicRetrievalMode.MODE_DYNAMIC,
                  dynamicThreshold: 0.3,
                },
              },
            },
          ],
        })
      : genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() => model.generateContent(llmPrompt));
    const textResponse = result.response.text();
    console.log(`🤖 Text identification (LLM): "${query}" -> Response:`, textResponse);

    const m = textResponse.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
      const conf = (p.confidence || '').toLowerCase();
      if (!p.title || p.title.toLowerCase() === 'unknown') return notFound();
      if (conf === 'low') return unclear();

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
        if (titlesMatchNative(p.title, tmdbTitle, tmdbOrigTitle) || (tmdbVerified.result.vote_count ?? 0) >= 100) {
          verifiedTitle = tmdbTitle || tmdbOrigTitle;
          verifiedType = tmdbVerified.type;
        }
      }

      if (!verifiedTitle) {
        console.log(`🔍 LLM title verification (Serper): "${p.title}"`);
        const serperVerify = await identifyBySerper(p.title);
        if (serperVerify) {
          verifiedTitle = serperVerify.title;
          verifiedType = serperVerify.type;
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

      if (verifiedTitle) {
        return found({ title: verifiedTitle, type: verifiedType });
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
  if (!GEMINI_KEY) return text;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const r = await withGemini(() =>
      model.generateContent(
        `Translate this movie plot to Uzbek (lotin yozuvida). Only output the translation:\n"${text}"`
      )
    );
    return r.response.text()?.trim() || text;
  } catch { return text; }
}

async function translateTitle(
  displayTitle: string,
  originalTitle: string,
  year: string,
  mediaType: MediaType,
): Promise<string> {
  if (!GEMINI_KEY) return displayTitle;
  const kind = mediaType === 'tv' ? 'TV show' : 'movie';
  const orig = (originalTitle || '').trim();
  const disp = (displayTitle || '').trim();
  const y = (year || '').trim();
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const r = await withGemini(() =>
      model.generateContent(
        `You are naming this ${kind} for Uzbek-speaking viewers (dubs, streaming, cinema).

TMDB English/international title: "${disp}"
Original title (may differ from English for foreign films): "${orig || disp}"
Release year: ${y || 'unknown'}

Rules — CRITICAL:
1. Do NOT produce a literal word-for-word translation of the English (or original) title. Uzbek releases often use a completely different market title (short phrase, different wording, or kept English).
2. Output the title that is actually used on Uzbek posters, TV, or sites like uzmovi / kinoxit when you know it. If several names exist, pick the most common search term users type.
3. If there is no well-known Uzbek market title, output the English title "${disp}" unchanged, not a guessed translation.
4. Output ONLY the Uzbek market title or English title — one line, no quotes, no explanation.
5. IMPORTANT: Output MUST be in Uzbek Latin script. Do NOT use Cyrillic characters. If you know the title only in Cyrillic, transliterate it to Uzbek Latin (e.g. "Sargardon Zamin" not "Блуждающая Земля").`
      )
    );
    const raw = r.response.text()?.trim().replace(/^["']|["']$/g, '') || displayTitle;
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
    if (BLOCKED_HOSTS.some(b => host === b || host.endsWith(`.${b}`))) return false;
    return ALLOWED_HOSTS.some(a => host === a || host.endsWith(`.${a}`));
  } catch { return false; }
}

/**
 * Tomosha havolalari qidiruvi: saytlar odatda inglizcha (yoki TMDB original_title) nom bilan.
 * O‘zbekcha tarjima nomi (masalan "Yettinchi farzand") bilan qidiruv bo‘sh chiqishi mumkin.
 */
function isLinkRelevantToMovie(
  result: SerperResult,
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
  items: SerperResult[],
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
  uzResults: SerperResult[],
  ruResults: SerperResult[],
  seen: Set<string>,
  finalLinks: WatchLink[],
): void {
  for (const item of [...uzResults, ...ruResults]) {
    if (finalLinks.length >= 4) break;
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    seen.add(host);
    const ru = /[а-яё]/i.test(item.title || '') && !/[a-z]{4,}/i.test(item.title || '');
    const t = (item.title || '').length > 50 ? host : item.title;
    finalLinks.push({ title: t, link: item.link, source: ru ? `${host} (RU)` : host });
    console.log(`🔗 Relaxed (title-only search match): ${host}`);
  }
}

/**
 * Tomosha havolalari: LAZY strategiya — oldingi call yetarli bo'lsa keyingisi chaqirilmaydi.
 * 9 parallel call o'rniga max 3 call → API kredit sarfi ~3x kamayadi.
 *
 * Step 1: O'zbek qidiruv (asosiy)      — 1 call
 * Step 2: Rus qidiruv (yetmasa)         — 1 call
 * Step 3: IMDb ID bilan aniq (yetmasa)  — 1 call
 * Jami: max 3 call, odatda 1-2 kifoya.
 */
async function findWatchLinks(
  englishDisplayTitle: string,
  originalTitle: string,
  year: string,
  uzTitle?: string,
  imdbId?: string | null,
): Promise<WatchLink[]> {
  const a   = (originalTitle || '').trim();
  const b   = (englishDisplayTitle || '').trim();
  const uz  = (uzTitle || '').trim();
  const allTitles = [...new Set([a, b, uz].filter(x => x.length > 0))];
  const primary   = a || b;
  const tt        = imdbId && /^tt\d+$/i.test(imdbId) ? imdbId : null;

  const seen       = new Set<string>();
  const finalLinks: WatchLink[] = [];

  // ── Step 1: O'zbek qidiruv ───────────────────────────────────────────────
  // Bitta query da year + har ikkala yozuv variantini qamrab oladi (10 natija kifoya)
  const qUz = year
    ? `${primary} ${year} uzbek o'zbek tilida`
    : `${primary} uzbek o'zbek tilida`;

  const uzRes = await serperSearch(qUz, 'uz', 'uz');

  // O'zbekcha nomda alohida qidiruv faqat agar nom juda farqli bo'lsa
  let uzTitleRes: SerperResult[] = [];
  if (uz && uz.toLowerCase() !== primary.toLowerCase() && uz.length > 3) {
    uzTitleRes = await serperSearch(`${uz} uzbek tilida`, 'uz', 'uz');
  }

  collectWatchLinksFromResults(
    [...uzRes, ...uzTitleRes], seen, finalLinks, allTitles, year, imdbId, 'uz', false, 4
  );

  // ── Step 2: Rus qidiruv (faqat yetarli havola bo'lmasa) ─────────────────
  if (finalLinks.length < 2) {
    const ruRes = await serperSearch(`${primary} смотреть онлайн`, 'ru', 'ru');
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
    const imdbRes = await serperSearch(`${tt} o'zbek tilida смотреть`, 'uz', 'uz');
    collectWatchLinksFromResults(imdbRes, seen, finalLinks, allTitles, year, imdbId, 'imdb', false, 3);
    if (finalLinks.length === 0) {
      relaxedFillFromResults(imdbRes, [], seen, finalLinks);
    }
  }

  // ── Fallback: hech narsa topilmasa — qat'iy filtr olmirish ──────────────
  if (finalLinks.length === 0) {
    relaxedFillFromResults([...uzRes, ...uzTitleRes], [], seen, finalLinks);
  }

  return finalLinks.slice(0, 5);
}

export async function getMovieDetails(identified: MovieIdentified): Promise<MovieDetails> {
  const { title, type } = identified;

  // OMDb dan IMDb ID — birinchi mos keluvchi ba’zan boshqa film bo‘lishi mumkin; TMDB bilan tekshiramiz
  let imdbId: string | null = null;
  const omdb = await omdbSearch(title, type === 'tv' ? 'series' : 'movie');
  if (omdb) imdbId = omdb.imdbId;

  let tmdbResult: TmdbResult | null = null;
  if (imdbId) {
    const found = await tmdbByImdbId(imdbId);
    if (found) {
      const rt = found.result.title || found.result.name || '';
      const ro = found.result.original_title || found.result.original_name || '';
      // SNG/CIS filmlar uchun: kirill/turk sarlavhalarini ham solishtirish
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

  // TMDb dan to'liq detallar (imdb_id shu yerda keladi)
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

  const displayTitle = (type === 'tv' ? tmdbResult?.name : tmdbResult?.title) || title;
  const originalTitle = (type === 'tv' ? tmdbResult?.original_name : tmdbResult?.original_title) || title;
  const year = ((type === 'tv' ? tmdbResult?.first_air_date : tmdbResult?.release_date) || '').split('-')[0];
  const rating = tmdbResult?.vote_average ? tmdbResult.vote_average.toFixed(1) : 'N/A';
  const posterUrl = tmdbResult?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}` : null;

  const englishPlot = tmdbResult?.overview || '';
  const uzTitle = await translateTitle(displayTitle, originalTitle, year, type);
  const [plotUz, watchLinks] = await Promise.all([
    englishPlot ? translateToUzbek(englishPlot) : Promise.resolve('Tavsif mavjud emas'),
    findWatchLinks(displayTitle, originalTitle, year, uzTitle, imdbId),
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
    tmdbId: tmdbResult?.id ?? null,
    imdbId,
    mediaType: type,
  };
}
