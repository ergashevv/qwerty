import { GoogleGenerativeAI } from '@google/generative-ai';
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
/** Faqat Gemini (multimodal + matn + tarjima). */
const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT    = 8000;

// ─── YORDAMCHI ───────────────────────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/\s*\(\d{4}.*?\)/g, '')
    .replace(/\s*[-–—|]\s*(wikipedia|imdb|rotten|letterboxd).*/i, '')
    .replace(/\s+/g, ' ').trim();
}

// Stop-words that are too common to count as meaningful matches
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is']);

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // includes() check: require the shorter string to be at least 6 chars
  // to avoid false positives from short common words like "iron", "man", "the"
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

  // Single-word short queries must match exactly — Jaccard too lenient for them
  // (e.g. "iron" should NOT fuzzy-match "Iron Man 3")
  if (ta.length <= 1 && na.length < 6) return false;
  if (tb.length <= 1 && nb.length < 6) return false;

  const setB = new Set(tb);
  const inter = ta.filter(w => setB.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter >= 1 && (union > 0 ? inter / union : 0) >= 0.4;
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
    const hit = type === 'multi'
      ? results.find(x => x.media_type === 'movie' || x.media_type === 'tv')
      : results[0];
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

export async function identifyFromText(query: string): Promise<MovieIdentified | null> {
  // OMDb — to'g'ridan qidirish (faqat so'rov nomi natija nomi bilan mos kelsa)
  const omdb = await omdbSearch(query);
  if (omdb) return { title: omdb.title, type: omdb.type };

  // TMDb — natijani so'rov bilan solishtirib tekshirish
  const tmdb = await tmdbSearch(query);
  if (tmdb?.result) {
    const tmdbTitle = tmdb.result.title || tmdb.result.name || '';
    const voteCount = tmdb.result.vote_count ?? 0;
    // Ikkita holda TMDB natijasiga ishonamiz:
    // 1) Nom so'rov bilan mos kelsa (inglizcha)
    // 2) Nom mos kelmasa ham, film juda mashhur bo'lsa (≥500 ovoz) —
    //    bu boshqa tilda yozilgan so'rovlarda TMDB o'zi to'g'ri topishi mumkin
    if (titlesMatch(query, tmdbTitle) || voteCount >= 500) {
      return { title: tmdbTitle, type: tmdb.type };
    }
    // TMDb natijasi so'rov bilan mos kelmadi va mashxur emas — Gemini LLM
  }

  const llmPrompt = `Identify the EXACT movie or TV show from this query (may be in Uzbek, Russian, Turkish, or English title/description):
"${query}"

Rules:
- If the query is a movie/show title in another language, return the original international title
- If it's a description, identify the most likely match
- Only respond if confidence is medium or high

Respond ONLY with JSON:
{"title": "Exact original title", "type": "movie" or "tv", "confidence": "high/medium/low"}`;

  async function resolveLlmMovie(p: { title?: string; type?: string; confidence?: string }): Promise<MovieIdentified | null> {
    if (!p.title || p.title.toLowerCase() === 'unknown' || p.confidence === 'low') return null;
    const verified = await omdbSearch(p.title);
    if (verified) return { title: verified.title, type: verified.type };
    const tmdbVerified = await tmdbSearch(p.title);
    if (tmdbVerified?.result) {
      return {
        title: tmdbVerified.result.title || tmdbVerified.result.name || p.title,
        type: tmdbVerified.type,
      };
    }
    if (p.confidence === 'high') {
      return { title: p.title, type: p.type === 'tv' ? 'tv' : 'movie' };
    }
    return null;
  }

  if (!GEMINI_KEY) return null;

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await withGemini(() => model.generateContent(llmPrompt));
    const text = result.response.text();
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]) as { title?: string; type?: string; confidence?: string };
      const resolved = await resolveLlmMovie(p);
      if (resolved) return resolved;
    }
  } catch { /* ignore */ }

  return null;
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

async function translateTitle(englishTitle: string): Promise<string> {
  if (!GEMINI_KEY) return englishTitle;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const r = await withGemini(() =>
      model.generateContent(
        `Translate ONLY the movie/TV show title "${englishTitle}" to Uzbek (official localization used in Uzbek dubbing). If no official Uzbek title exists, transliterate or keep original. Output ONLY the title, nothing else.`
      )
    );
    const result = r.response.text()?.trim() || englishTitle;
    return result.toLowerCase() === englishTitle.toLowerCase() ? englishTitle : result;
  } catch { return englishTitle; }
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

async function findWatchLinks(title: string, originalTitle: string, year: string): Promise<WatchLink[]> {
  const base = originalTitle || title;
  const q1 = `${base} ${year} o'zbek tilida tomosha ko'rish`.trim();
  const q2 = `${base} o'zbek tilida`.trim();
  const q3 = `${base} смотреть онлайн`;

  const [r1, r2, r3] = await Promise.allSettled([
    serperSearch(q1, 'uz', 'uz'),
    serperSearch(q2, 'uz', 'uz'),
    serperSearch(q3, 'ru', 'ru'),
  ]);

  const all = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ];

  const seen = new Set<string>();
  const links: WatchLink[] = [];

  for (const item of all) {
    if (!isAllowedWatchUrl(item.link, item.title)) continue;
    const host = canonHost(item.link);
    if (seen.has(host)) continue;
    seen.add(host);
    links.push({ title: item.title, link: item.link, source: host });
    if (links.length >= 4) break;
  }

  return links;
}

export async function getMovieDetails(identified: MovieIdentified): Promise<MovieDetails> {
  const { title, type } = identified;

  // OMDb dan IMDb ID
  let imdbId: string | null = null;
  const omdb = await omdbSearch(title, type === 'tv' ? 'series' : 'movie');
  if (omdb) imdbId = omdb.imdbId;

  // TMDb detallar
  let tmdbResult: TmdbResult | null = null;
  if (imdbId) {
    const found = await tmdbByImdbId(imdbId);
    if (found) tmdbResult = found.result;
  }
  if (!tmdbResult) {
    const found = await tmdbSearch(title, type);
    if (found) tmdbResult = found.result;
  }

  // TMDb dan to'liq detallar
  if (tmdbResult?.id) {
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbResult.id}`, {
        params: { api_key: TMDB_KEY, language: 'en-US' },
        timeout: TIMEOUT,
      });
      tmdbResult = { ...tmdbResult, ...r.data };
    } catch { /* ignore */ }
  }

  const displayTitle = (type === 'tv' ? tmdbResult?.name : tmdbResult?.title) || title;
  const originalTitle = (type === 'tv' ? tmdbResult?.original_name : tmdbResult?.original_title) || title;
  const year = ((type === 'tv' ? tmdbResult?.first_air_date : tmdbResult?.release_date) || '').split('-')[0];
  const rating = tmdbResult?.vote_average ? tmdbResult.vote_average.toFixed(1) : 'N/A';
  const posterUrl = tmdbResult?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}` : null;

  // Plot va title tarjimasi parallel
  const englishPlot = tmdbResult?.overview || '';
  const [uzTitle, plotUz, watchLinks] = await Promise.all([
    translateTitle(displayTitle),
    englishPlot ? translateToUzbek(englishPlot) : Promise.resolve('Tavsif mavjud emas'),
    findWatchLinks(displayTitle, originalTitle, year),
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
