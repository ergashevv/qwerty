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
/** Matnli syujet qidiruvida Google Search grounding (pulli; Serper snippetlari ixtiyoriy o‘chadi). */
const GEMINI_GROUNDING_TEXT = process.env.GEMINI_GROUNDING_TEXT_SEARCH === 'true';
/** Faqat Gemini (multimodal + matn + tarjima). */
const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT    = 8000;

// ─── YORDAMCHI ───────────────────────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/[ʻʼ'`‘·]/g, '\'') // Standartlashtirish
    .replace(/[^a-z0-9\s']/g, ' ') // Har qanday boshqa belgilarni bo'shliq bilan almashtirish
    .replace(/\s*\(\d{4}.*?\)/g, '')
    .replace(/\s*[-–—|]\s*(wikipedia|imdb|rotten|letterboxd).*/i, '')
    .replace(/\s+/g, ' ').trim();
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

  // includes() check: require the shorter string to be at least 6 chars
  // to avoid false positives from short common words like "iron", "man", "the"
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  // Exact substring match (only for long strings)
  if (shorter.length >= 10 && longer.includes(shorter)) return true;

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

/** movie_cache da watch_links bo‘sh [] bo‘lsa, eski bug’dan qolgan — qayta getMovieDetails chaqiriladi. */
export function cachedWatchLinksNonEmpty(watchLinksJson: string | null | undefined): boolean {
  if (!watchLinksJson) return false;
  try {
    const arr = JSON.parse(watchLinksJson) as unknown;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
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
        // Kamida 100 ta ovoz — bu obscure/behind-the-scenes kontentni filtrlab tashlaydi
        (m.vote_count ?? 0) >= 100
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

// ─── SERPER ──────────────────────────────────────────────────────────────────

interface SerperResult { title: string; link: string; snippet?: string; }

async function serperSearch(query: string, gl = 'uz', hl = 'uz'): Promise<SerperResult[]> {
  if (!SERPER_KEY) return [];
  try {
    const r = await axios.post('https://google.serper.dev/search',
      { q: query, gl, hl, num: 10 },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return r.data.organic || [];
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

Look at the screenshot carefully. Based on the scene details (costumes, setting, lighting, props, visible text in the film frame), which ONE of the candidates does this screenshot belong to? Also identify which part/sequel if applicable.

If none of the candidates fit the scene, respond with: {"title": "", "type": "movie", "confidence": "low"}

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

async function identifyByGemini(base64: string): Promise<MovieIdentified | null> {
  if (!GEMINI_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() =>
      model.generateContent([
        {
          inlineData: { data: base64, mimeType: 'image/jpeg' },
        },
        `You are an expert in world cinema including Turkish, Korean, Hollywood, Russian, and Uzbek films.

Identify the EXACT movie or TV show in this screenshot.

Key clues to analyze:
1. Actors' faces — recognize them if possible
2. Costumes and clothing style (prison uniform? Ottoman period? Modern?)  
3. Setting and location (prison cell? Village? Istanbul?)
4. Any visible text (subtitles, watermarks, logos) — ignore social media app UI
5. Scene emotion and context

For Turkish prison dramas with an innocent/simple man: consider "7. Koğuştaki Mucize".
For Turkish historical: consider "Diriliş: Ertuğrul", "Kuruluş: Osman".
For Turkish crime: consider "Çukur", "Ezel", "Kara Para Aşk".

Respond ONLY with JSON:
{"title": "Exact title or unknown", "type": "movie" or "tv", "confidence": "high/medium/low", "reasoning": "brief explanation"}

If you are not sure which ONE film this is, use "unknown" for title and "low" for confidence.`,
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
async function geminiVerify(base64: string, candidateTitle: string, mimeType: string): Promise<boolean> {
  if (!GEMINI_KEY) return false;
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

Answer ONLY with JSON: {"match": true} or {"match": false, "reason": "brief explanation"}`,
        },
      ])
    );
    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return false;
    const parsed = JSON.parse(m[0]) as { match?: boolean; reason?: string };
    const ok = parsed.match === true;
    console.log(`🔍 Gemini verify "${candidateTitle}": ${ok} — ${parsed.reason || ''}`);
    return ok;
  } catch {
    return false;
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
export async function identifyMovie(base64: string, mimeType: string): Promise<MovieIdentified | null> {
  const withTimeout = <T>(p: Promise<T>, ms = 10000): Promise<T | null> =>
    Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]).catch(() => null);

  if (!GEMINI_KEY) {
    console.warn('identifyMovie: GEMINI_API_KEY yo\'q — rasm bo\'yicha aniqlash o\'chirilgan');
    return null;
  }

  const croppedBase64 = await cropFrame(base64);
  const cropMime = 'image/jpeg';

  const [faces, vision, gemini] = await Promise.all([
    withTimeout(identifyByFaces(croppedBase64)),
    withTimeout(identifyByVision(croppedBase64)),
    withTimeout(identifyByGemini(croppedBase64)),
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
  for (let i = 0; i < Math.min(ordered.length, MAX_VERIFY); i++) {
    const cand = ordered[i];
    const ok = (await withTimeout(geminiVerify(croppedBase64, cand.title, cropMime))) === true;
    if (ok) {
      console.log('✅ Tasdiqlangan:', cand.title);
      return cand;
    }
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
  const searchResults = await serperSearch(`${query} movie imdb`);
  for (const res of searchResults) {
    const m = res.link.match(/imdb\.com\/title\/(tt\d+)/);
    if (!m) continue;
    const found = await omdbById(m[1]);
    if (!found) continue;
    if (titlesMatch(query, found.title)) {
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
      const voteCount = tmdb.result.vote_count ?? 0;
      if (titlesMatch(query, tmdbTitle) || voteCount >= 500) {
        return found({ title: tmdbTitle, type: tmdb.type });
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

  // 3. Serper konteksti + LLM — uzun tavsiflar
  if (!GEMINI_KEY) return notFound();

  const contextResults = GEMINI_GROUNDING_TEXT
    ? []
    : await serperSearch(`${query} qaysi film kino`, 'uz', 'uz');
  const snippets = GEMINI_GROUNDING_TEXT
    ? '(Google Search grounding yoqilgan — qidiruv model ichida)'
    : contextResults.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n\n');

  const llmPrompt = `You are a professional movie expert. Identify the exact movie/TV show from this USER query.
The user might be describing a specific scene, plot, or character they remember.

USER QUERY: "${query}"
GOOGLE SEARCH CONTEXT (clues):
${snippets}

Rules:
1. Match the USER'S FULL PLOT, not only loose keywords. Example: "robot" + "love" appears in many works — pick the one whose ENTIRE scenario fits (setting, premise, ending).
2. Prefer a single famous FEATURE FILM over an anthology TV series when the description is one continuous story (e.g. obese passive humans floating in chairs + one main small robot + Earth/space ship setting → the Pixar film "WALL-E", NOT "Love, Death & Robots" unless they clearly describe that anthology's format).
3. Provide the exact ORIGINAL English title (e.g. "WALL-E", not a translated title).
4. DO NOT translate the movie title literally into Uzbek.
5. If two titles share words but only one matches the plot details, choose that one. If still ambiguous, use confidence "medium" or "low".

Respond ONLY with this JSON structure:
{"title": "Original English Title", "type": "movie" or "tv", "confidence": "high/medium/low"}`;

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
        tmdbOverview = tmdbVerified.result.overview || null;
        if (titlesMatch(p.title, tmdbTitle) || (tmdbVerified.result.vote_count ?? 0) >= 1000) {
          verifiedTitle = tmdbTitle;
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
3. If there is no well-known Uzbek market title, output the English title "${disp}" unchanged (Latin script), not a guessed translation.
4. Output ONLY the Uzbek market title or English title — one line, no quotes, no explanation.`
      )
    );
    const result = r.response.text()?.trim().replace(/^["']|["']$/g, '') || displayTitle;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    return norm(result) === norm(disp) ? disp : result;
  } catch {
    return displayTitle;
  }
}

const ALLOWED_HOSTS = [
  'ok.ru','vk.com','vkvideo.ru','rutube.ru','dailymotion.com',
  'uzmovi.tv','uzmovi.com','uzmovi.uz','kinopoisk.ru','hd.kinopoisk.ru',
  'ivi.ru','start.ru','yandex.ru','netflix.com','primevideo.com',
  'hbomax.com','max.com','disneyplus.com',
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

async function findWatchLinks(
  englishDisplayTitle: string,
  originalTitle: string,
  year: string,
  uzTitle?: string,
  imdbId?: string | null,
): Promise<WatchLink[]> {
  const a = (originalTitle || '').trim();
  const b = (englishDisplayTitle || '').trim();
  const uz = (uzTitle || '').trim();
  const allTitles = [...new Set([a, b, uz].filter(x => x.length > 0))];

  const searchTitles = [...new Set([a, b].filter((x) => x.length > 0))];
  const primary = searchTitles[0] || b;

  const qUz1 = `${primary} ${year} o'zbek tilida`.trim();
  const qUz2 = `${primary} o'zbek tilida`.trim();
  const qUz3 = `${primary} uzbek tilida`.trim();
  const qRu = `${primary} смотреть онлайн`;

  const extraTitle = searchTitles.length > 1 && searchTitles[1] !== primary ? searchTitles[1] : null;
  const qUzAlt = extraTitle ? `${extraTitle} o'zbek tilida`.trim() : null;

  const needUzTitleSearch = uz && uz.toLowerCase() !== primary.toLowerCase()
    && (!extraTitle || uz.toLowerCase() !== extraTitle.toLowerCase());
  const qUzT1 = needUzTitleSearch ? `${uz} o'zbek tilida` : null;
  const qUzT2 = needUzTitleSearch ? `${uz} ${year} o'zbek tilida` : null;

  const tt = imdbId && /^tt\d+$/i.test(imdbId) ? imdbId : null;
  const qImdbUz = tt ? `${tt} o'zbek tilida` : null;
  const qImdbRu = tt ? `${tt} смотреть онлайн` : null;

  const settle = (r: PromiseSettledResult<SerperResult[]>) =>
    r.status === 'fulfilled' ? r.value : [];

  const [
    resUz1, resUz2, resUz3, resRu, resUzAlt, resUzT1, resUzT2, resImdbUz, resImdbRu,
  ] = await Promise.allSettled([
    serperSearch(qUz1, 'uz', 'uz'),
    serperSearch(qUz2, 'uz', 'uz'),
    serperSearch(qUz3, 'uz', 'uz'),
    serperSearch(qRu, 'ru', 'ru'),
    qUzAlt ? serperSearch(qUzAlt, 'uz', 'uz') : Promise.resolve([] as SerperResult[]),
    qUzT1 ? serperSearch(qUzT1, 'uz', 'uz') : Promise.resolve([] as SerperResult[]),
    qUzT2 ? serperSearch(qUzT2, 'uz', 'uz') : Promise.resolve([] as SerperResult[]),
    qImdbUz ? serperSearch(qImdbUz, 'uz', 'uz') : Promise.resolve([] as SerperResult[]),
    qImdbRu ? serperSearch(qImdbRu, 'ru', 'ru') : Promise.resolve([] as SerperResult[]),
  ]);

  const uzResults = [
    ...settle(resImdbUz),
    ...settle(resUzT1), ...settle(resUzT2),
    ...settle(resUz1), ...settle(resUz2), ...settle(resUz3),
    ...settle(resUzAlt),
  ];
  const ruResults = [...settle(resImdbRu), ...settle(resRu)];

  const seen = new Set<string>();
  const finalLinks: WatchLink[] = [];

  collectWatchLinksFromResults(uzResults, seen, finalLinks, allTitles, year, imdbId, 'uz', false, 3);

  const ruCountLimit = finalLinks.length === 0 ? 3 : 2;
  let ruAdded = 0;
  for (const item of ruResults) {
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    if (!isLinkRelevantToMovie(item, allTitles, year, imdbId)) {
      console.log(`🔗 Skipped (ru): ${host} — "${item.title?.slice(0, 60)}"`);
      continue;
    }
    seen.add(host);
    const ruTitle = item.title.length > 50 ? host : item.title;
    finalLinks.push({ title: ruTitle, link: item.link, source: `${host} (RU)` });
    ruAdded++;
    if (ruAdded >= ruCountLimit || finalLinks.length >= 5) break;
  }

  if (finalLinks.length < 4) {
    collectWatchLinksFromResults(uzResults, seen, finalLinks, allTitles, year, imdbId, 'uz-fill', false, 0);
  }

  if (finalLinks.length === 0) {
    relaxedFillFromResults(uzResults, ruResults, seen, finalLinks);
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
      if (titlesMatch(title, rt) || titlesMatch(title, ro)) {
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
