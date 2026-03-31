import sharp from 'sharp';
import QRCode from 'qrcode';
import axios from 'axios';

const W = 540;
const POSTER_H = 280;
const FOOTER_H = 116;

export function getBotShareDeepLink(): string {
  const u = process.env.BOT_SHARE_URL?.trim();
  if (u) return u;
  const name = process.env.BOT_USERNAME?.trim();
  if (name) return `https://t.me/${name.replace(/^@/, '')}`;
  return 'https://t.me';
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateTitle(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function renderShareCardPng(opts: {
  posterUrl: string | null;
  title: string;
  uzTitle?: string | null;
}): Promise<Buffer> {
  const deepLink = getBotShareDeepLink();
  const qrBuf = await QRCode.toBuffer(deepLink, {
    type: 'png',
    width: 96,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  let posterBuf: Buffer;
  if (opts.posterUrl) {
    try {
      const res = await axios.get<ArrayBuffer>(opts.posterUrl, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxContentLength: 5_000_000,
        validateStatus: (s) => s === 200,
      });
      posterBuf = await sharp(Buffer.from(res.data))
        .resize(W, POSTER_H, { fit: 'cover', position: 'center' })
        .toBuffer();
    } catch {
      posterBuf = await sharp({
        create: { width: W, height: POSTER_H, channels: 3, background: { r: 35, g: 35, b: 58 } },
      })
        .jpeg()
        .toBuffer();
    }
  } else {
    posterBuf = await sharp({
      create: { width: W, height: POSTER_H, channels: 3, background: { r: 35, g: 35, b: 58 } },
    })
      .jpeg()
      .toBuffer();
  }

  const mainLine = truncateTitle(opts.title, 46);
  const subLine =
    opts.uzTitle && opts.uzTitle !== opts.title ? truncateTitle(opts.uzTitle, 40) : '';

  const kinovaY = subLine ? 78 : 58;
  const linkY = subLine ? 94 : 76;

  const svg = `
<svg width="${W}" height="${FOOTER_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1a1a2e"/>
  <text x="16" y="32" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="17" font-weight="600" fill="#ffffff">${escXml(mainLine)}</text>
  ${subLine ? `<text x="16" y="54" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13" fill="#a8b0d8">${escXml(subLine)}</text>` : ''}
  <text x="16" y="${kinovaY}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12" fill="#7a86b8">Kinova — filmni topish</text>
  <text x="16" y="${linkY}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11" fill="#5c6aa8">${escXml(deepLink.replace(/^https:\/\//, ''))}</text>
</svg>`;

  const footerBuf = await sharp(Buffer.from(svg)).png().toBuffer();

  const footerWithQr = await sharp(footerBuf)
    .composite([{ input: qrBuf, left: W - 96 - 12, top: 10 }])
    .png()
    .toBuffer();

  const totalH = POSTER_H + FOOTER_H;
  return sharp({
    create: {
      width: W,
      height: totalH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: posterBuf, top: 0, left: 0 },
      { input: footerWithQr, top: POSTER_H, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}
