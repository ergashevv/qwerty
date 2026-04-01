import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { identifyMovie, type MovieIdentified } from './movieService';

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.REELS_DOWNLOAD_TIMEOUT_MS || '90000', 10);
const FFMPEG_TIMEOUT_MS = parseInt(process.env.REELS_FFMPEG_TIMEOUT_MS || '45000', 10);
const MAX_FILE_MB = parseInt(process.env.REELS_MAX_DOWNLOAD_MB || '80', 10);

/** Sekund — qora kadr / titr ehtimolini kamaytirish (default 4 nuqta — sifatni saqlab token tejash) */
const FRAME_OFFSETS_SEC = (() => {
  const raw = process.env.REELS_FRAME_OFFSETS_SEC?.trim();
  const fallback = [0.5, 2.0, 4.5, 7.5];
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n) && n >= 0);
  return parts.length > 0 ? parts : fallback;
})();

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const errChunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('process_timeout'));
    }, options.timeoutMs);
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

async function downloadVideo(reelUrl: string, workDir: string): Promise<string> {
  const outTmpl = path.join(workDir, 'src.%(ext)s');
  const args = [
    '--max-filesize',
    `${MAX_FILE_MB}M`,
    '-f',
    'best[height<=720]/best',
    '--no-playlist',
    '--socket-timeout',
    '25',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '-o',
    outTmpl,
    reelUrl,
  ];
  const r = await runProcess(YT_DLP, args, { cwd: workDir, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`yt-dlp: ${r.stderr.slice(-400) || 'xato'}`);
  }
  const names = fs.readdirSync(workDir).filter((n) => /\.(mp4|webm|mkv|mov)$/i.test(n));
  if (names.length === 0) {
    throw new Error('video_fayl_topilmadi');
  }
  return path.join(workDir, names[0]);
}

async function extractOneFrame(videoPath: string, workDir: string, offsetSec: number, index: number): Promise<string | null> {
  const out = path.join(workDir, `frame_${index}.jpg`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(offsetSec),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    out,
  ];
  const r = await runProcess(FFMPEG, args, { cwd: workDir, timeoutMs: FFMPEG_TIMEOUT_MS });
  if (r.code !== 0 || !fs.existsSync(out)) return null;
  return out;
}

export interface ReelsIdentifyResult extends Pick<MovieIdentified, 'title' | 'type' | 'confidence'> {
  usedFrameIndex: number;
}

export type ReelsIdentifyOutcome =
  | { ok: true; identified: ReelsIdentifyResult }
  | { ok: false; lastFrameBase64: string | null };

/**
 * Videodan ketma-kadrlar bilan identifyMovie — birinchi muvaffaqiyatli natija.
 * Muvaffaqiyatsiz bo‘lsa, oxirgi olingan kadr (fallback: aktyor film taxminlari) uchun base64 qaytariladi.
 */
export async function identifyMovieFromReelVideo(
  reelUrl: string,
  textHint?: string | null
): Promise<ReelsIdentifyOutcome> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinova-reel-'));
  let lastFrameBase64: string | null = null;
  try {
    const videoPath = await downloadVideo(reelUrl, workDir);

    for (let i = 0; i < FRAME_OFFSETS_SEC.length; i++) {
      const off = FRAME_OFFSETS_SEC[i];
      const fp = await extractOneFrame(videoPath, workDir, off, i);
      if (!fp) continue;
      const base64 = fs.readFileSync(fp).toString('base64');
      lastFrameBase64 = base64;
      const id = await identifyMovie(base64, 'image/jpeg', textHint?.trim() || null);
      if (id.ok && id.identified.title) {
        return {
          ok: true,
          identified: {
            title: id.identified.title,
            type: id.identified.type,
            confidence: id.identified.confidence,
            usedFrameIndex: i,
          },
        };
      }
    }
    return { ok: false, lastFrameBase64 };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
