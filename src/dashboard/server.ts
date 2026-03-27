import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { loadDashboardPayload, loadFeedbackEventsPage } from './statsService';
import { renderFeedbackListPage } from './feedbackListHtml';

function isPlausibleTelegramFileId(fileId: string): boolean {
  if (fileId.length < 5 || fileId.length > 800) return false;
  if (/[\u0000-\u001f\u007f]/.test(fileId)) return false;
  return true;
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 3) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Dashboard / login: avvalo Untitled-1-02.png (yoki DASHBOARD_LOGO_FILE), yo‘q bo‘lsa birinchi rasm */
function pickLogoHref(): string | null {
  const dir = path.join(process.cwd(), 'logos');
  const preferred = (process.env.DASHBOARD_LOGO_FILE || 'Untitled-1-02.png').trim();
  try {
    if (!fs.existsSync(dir)) return null;
    const preferredPath = path.join(dir, preferred);
    if (preferred && fs.existsSync(preferredPath)) {
      return `/logos/${encodeURIComponent(preferred)}`;
    }
    const files = fs.readdirSync(dir);
    const img = files.find((f) => /\.(png|jpe?g|svg|webp|gif)$/i.test(f));
    return img ? `/logos/${encodeURIComponent(img)}` : null;
  } catch {
    return null;
  }
}

function loginPage(error?: string): string {
  const logo = pickLogoHref();
  const errBlock = error
    ? `<p class="err">${error.replace(/</g, '&lt;')}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kinova — kirish</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg0:#07090d;
      --bg1:#0f1419;
      --line:rgba(255,255,255,.09);
      --text:#eef3f8;
      --muted:rgba(233,238,245,.72);
      --accent:#2dd4bf;
      --accent2:#fbbf24;
      --err:#fb7185;
      --logo-bg:#1a3328;
    }
    *{box-sizing:border-box}
    body{
      margin:0;min-height:100vh;font-family:'Outfit',system-ui,sans-serif;font-size:16px;
      -webkit-font-smoothing:antialiased;
      background:
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(45,212,191,.12), transparent),
        radial-gradient(ellipse 60% 40% at 100% 100%, rgba(251,191,36,.08), transparent),
        linear-gradient(165deg, var(--bg0), var(--bg1));
      color:var(--text);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .card{
      width:100%;max-width:420px;padding:2.25rem 2rem;border-radius:20px;
      background:rgba(255,255,255,.03);border:1px solid var(--line);
      box-shadow:0 24px 80px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04);
      backdrop-filter:blur(12px);
    }
    .brand{display:flex;align-items:center;gap:18px;margin-bottom:1.5rem}
    .logo-brand{flex-shrink:0;padding:14px 22px;min-height:72px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(160deg,#1a3d30 0%,#142a22 100%);border-radius:16px;border:1px solid rgba(255,255,255,.1);
      box-shadow:0 8px 32px rgba(0,0,0,.4)}
    .logo-brand img{height:46px;width:auto;max-width:180px;object-fit:contain;display:block}
    .brand h1{margin:0;font-size:1.35rem;font-weight:700;letter-spacing:-.02em}
    .brand span{font-size:.875rem;color:var(--muted);font-weight:500;line-height:1.4}
    label{display:block;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:.75rem 0 .35rem}
    input{
      width:100%;padding:.85rem 1rem;border-radius:12px;border:1px solid var(--line);
      background:rgba(0,0,0,.25);color:var(--text);font-size:1rem;font-family:inherit;
    }
    input:focus{outline:none;border-color:rgba(45,212,191,.45);box-shadow:0 0 0 3px rgba(45,212,191,.12)}
    button{
      margin-top:1.35rem;width:100%;padding:.95rem;border:none;border-radius:12px;
      font-weight:600;font-size:1rem;font-family:inherit;cursor:pointer;
      background:linear-gradient(135deg,#2dd4bf,#14b8a6);color:#04120f;
      box-shadow:0 8px 24px rgba(45,212,191,.25);
    }
    button:hover{filter:brightness(1.06)}
    .err{color:var(--err);font-size:.9rem;margin:0 0 .5rem}
    .foot{margin-top:1.25rem;font-size:.8125rem;color:var(--muted);text-align:center;line-height:1.45}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      ${logo ? `<div class="logo-brand"><img src="${logo}" alt="Kinova"/></div>` : `<div class="logo-brand" style="min-width:120px;background:linear-gradient(135deg,var(--accent),var(--accent2));opacity:.88"></div>`}
      <div><h1>Kinova</h1><span>Statistika va boshqaruv</span></div>
    </div>
    ${errBlock}
    <form method="post" action="/login">
      <label for="u">Login</label>
      <input id="u" name="username" autocomplete="username" required/>
      <label for="p">Parol</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required/>
      <button type="submit">Kirish</button>
    </form>
    <p class="foot">Bu sahifani faqat ishonchli odamlar ko‘rishi kerak.</p>
  </div>
</body>
</html>`;
}

function dashboardPage(logoHref: string | null): string {
  const logoBlock = logoHref
    ? `<div class="logo-brand"><img src="${logoHref}" alt="Kinova"/></div>`
    : `<div class="logo-fallback" aria-hidden="true"></div>`;

  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kinova — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg: #05070a;
      --surface: rgba(13, 17, 23, 0.7);
      --surface-border: rgba(255, 255, 255, 0.08);
      --surface-lighter: rgba(255, 255, 255, 0.03);
      --accent: #2dd4bf;
      --accent-glow: rgba(45, 212, 191, 0.15);
      --secondary: #6366f1;
      --warning: #f59e0b;
      --error: #f43f5e;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --font-main: 'Outfit', system-ui, sans-serif;
      --font-ui: 'Inter', system-ui, sans-serif;
    }

    * { box-sizing: border-box; }
    
    body {
      margin: 0;
      font-family: var(--font-main);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      background-image: 
        radial-gradient(circle at 0% 0%, rgba(45, 212, 191, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 100% 100%, rgba(99, 102, 241, 0.05) 0%, transparent 40%),
        linear-gradient(180deg, #05070a 0%, #080a0f 100%);
      background-attachment: fixed;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 24px 80px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 48px;
      gap: 24px;
      flex-wrap: wrap;
    }

    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .logo-brand {
      height: 64px;
      padding: 12px 20px;
      background: linear-gradient(145deg, #112a24, #0a1a16);
      border: 1px solid rgba(45, 212, 191, 0.2);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .logo-brand img {
      height: 100%;
      width: auto;
      max-width: 160px;
      object-fit: contain;
    }

    .logo-fallback {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--secondary));
    }

    .title-group h1 {
      margin: 0;
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge-live {
      background: var(--accent-glow);
      color: var(--accent);
      font-size: 0.65rem;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 6px;
      font-weight: 700;
      letter-spacing: 0.05em;
      border: 1px solid rgba(45, 212, 191, 0.3);
    }

    .header-actions {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .btn {
      padding: 10px 20px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 0.9rem;
      text-decoration: none;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-ui);
    }

    .btn-outline {
      border: 1px solid var(--surface-border);
      background: var(--surface);
      color: var(--text);
      backdrop-filter: blur(10px);
    }

    .btn-outline:hover {
      background: var(--surface-lighter);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    .btn-accent {
      background: var(--accent);
      color: #05070a;
      box-shadow: 0 4px 15px rgba(45, 212, 191, 0.3);
    }

    .btn-accent:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }

    /* KPI Cards */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      padding: 24px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      position: relative;
      overflow: hidden;
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; width: 4px; height: 100%;
      background: var(--accent);
    }

    .kpi-label {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 8px;
      font-family: var(--font-ui);
    }

    .kpi-value {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .kpi-hint {
      margin-top: 12px;
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Section Styles */
    .section-title {
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--surface-border);
    }

    /* Dashboard Layout */
    .dashboard-row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }

    @media (max-width: 1024px) {
      .dashboard-row { grid-template-columns: 1fr; }
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 24px;
      padding: 28px;
      backdrop-filter: blur(10px);
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .panel-header h2 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }

    .panel-note {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 20px;
    }

    .chart-container {
      height: 300px;
      width: 100%;
      position: relative;
    }

    /* Top Films Table-like list */
    .film-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .film-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
    }

    .film-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .film-title {
      font-size: 0.95rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .film-bar-wrap {
      height: 6px;
      background: var(--surface-lighter);
      border-radius: 10px;
      overflow: hidden;
    }

    .film-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--secondary));
      border-radius: 10px;
      transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .film-hits {
      font-family: var(--font-ui);
      font-weight: 700;
      font-size: 0.9rem;
      color: var(--accent);
      min-width: 40px;
      text-align: right;
    }

    /* Feedback Cards */
    .feedback-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 48px;
    }

    .accuracy-card {
      background: linear-gradient(135deg, rgba(45, 212, 191, 0.1), rgba(99, 102, 241, 0.05));
      border: 1px solid rgba(45, 212, 191, 0.2);
      border-radius: 24px;
      padding: 28px;
    }

    .accuracy-metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 20px;
    }

    .acc-stat {
      text-align: center;
    }

    .acc-val {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .acc-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .pg-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 99px;
      background: var(--surface);
      border: 1px solid var(--surface-border);
    }

    .pg-status.ok { color: var(--accent); border-color: rgba(45, 212, 191, 0.3); }
    .pg-status.bad { color: var(--error); border-color: rgba(244, 63, 94, 0.3); }
    
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }

    /* Foydalanuvchilar ro'yxati */
    .user-activity-scroll {
      max-height: 520px;
      overflow-y: auto;
      padding-right: 8px;
      margin: 0 -4px;
    }
    .user-activity-scroll::-webkit-scrollbar { width: 6px; }
    .user-activity-scroll::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.12);
      border-radius: 99px;
    }
    .ua-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 14px;
      align-items: start;
      padding: 16px 14px;
      border-radius: 16px;
      border: 1px solid var(--surface-border);
      background: rgba(0,0,0,.18);
      margin-bottom: 12px;
    }
    .ua-row:last-child { margin-bottom: 0; }
    .ua-avatar {
      width: 44px; height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(45,212,191,.25), rgba(99,102,241,.2));
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 1rem; color: var(--accent);
      flex-shrink: 0;
    }
    .ua-head { margin-bottom: 8px; }
    .ua-name { font-weight: 600; font-size: 0.95rem; letter-spacing: -0.02em; }
    .ua-meta { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-ui); margin-top: 2px; }
    .ua-stats {
      display: flex; flex-wrap: wrap; gap: 8px;
      align-items: center;
    }
    .ua-chip {
      font-size: 0.72rem; font-weight: 600; font-family: var(--font-ui);
      padding: 5px 10px; border-radius: 8px;
      background: rgba(255,255,255,.04);
      border: 1px solid var(--surface-border);
      color: var(--text-muted);
    }
    .ua-chip strong { color: var(--text); font-weight: 700; }
    .ua-chip.ha { border-color: rgba(45,212,191,.35); color: var(--accent); }
    .ua-chip.yoq { border-color: rgba(244,63,94,.35); color: var(--error); }

    /* So'nggi feedback kartochkalari */
    .fb-preview-scroll {
      max-height: 520px;
      overflow-y: auto;
      padding-right: 8px;
      display: flex; flex-direction: column; gap: 14px;
    }
    .fb-preview-card {
      border-radius: 16px;
      border: 1px solid var(--surface-border);
      background: rgba(0,0,0,.22);
      padding: 14px 16px;
      position: relative;
      overflow: hidden;
    }
    .fb-preview-card::before {
      content: '';
      position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
      background: var(--accent);
    }
    .fb-preview-card.bad::before { background: var(--error); }
    .fb-preview-top {
      display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .fb-preview-user { font-weight: 600; font-size: 0.9rem; }
    .fb-preview-when { font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-ui); }
    .fb-badge {
      font-size: 0.7rem; font-weight: 700; padding: 4px 10px; border-radius: 6px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .fb-badge.ha { background: rgba(45,212,191,.15); color: var(--accent); }
    .fb-badge.yoq { background: rgba(244,63,94,.15); color: var(--error); }
    .fb-preview-film {
      font-size: 0.88rem; font-weight: 500; margin-bottom: 8px; line-height: 1.4;
    }
    .fb-preview-film .uz { font-size: 0.8rem; color: var(--text-muted); display: block; margin-top: 4px; }
    .fb-preview-src { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 10px; font-family: var(--font-ui); }
    .fb-qgrid {
      display: grid;
      gap: 8px;
    }
    .fb-qbox {
      font-size: 0.8rem; line-height: 1.45;
      background: rgba(0,0,0,.35);
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--surface-border);
      font-family: var(--font-ui);
    }
    .fb-qbox .lbl {
      font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 6px;
    }
    .fb-preview-media {
      margin-top: 10px;
      display: flex; align-items: center; gap: 12px;
    }
    .fb-thumb {
      width: 72px; height: 72px; border-radius: 10px; overflow: hidden;
      background: rgba(255,255,255,.06); flex-shrink: 0;
    }
    .fb-thumb img { width: 100%; height: 100%; object-fit: cover; }

    #dashErr {
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid var(--error);
      color: var(--error);
      padding: 16px;
      border-radius: 12px;
      margin-bottom: 24px;
      font-family: var(--font-ui);
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand-wrap">
        ${logoBlock}
        <div class="title-group">
          <h1>Kinova <span class="badge-live">Live</span></h1>
          <div id="pgStatus"></div>
        </div>
      </div>
      <div class="header-actions">
        <a href="/dashboard/feedback" class="btn btn-outline">Batafsil tahlil</a>
        <a href="/logout" class="btn btn-outline" style="color:var(--error)">Chiqish</a>
      </div>
    </header>

    <div id="dashErr" style="display:none"></div>

    <div class="section-title">Asosiy statistika</div>
    <div class="section-title" style="font-size:1rem;margin-top:8px;opacity:.85">Qidiruvlar (har bir urinish — matn / rasm / Reels)</div>
    <div class="kpi-grid" style="margin-bottom:28px">
      <div class="kpi-card" style="--accent: #a855f7">
        <div class="kpi-label">Matn qidiruvlari</div>
        <div class="kpi-value" id="valSrText">…</div>
        <div class="kpi-hint" id="hintSrText">24 soat / 7 kun / 30 kun</div>
      </div>
      <div class="kpi-card" style="--accent: var(--warning)">
        <div class="kpi-label">Screenshot qidiruvlari</div>
        <div class="kpi-value" id="valSrPhoto">…</div>
        <div class="kpi-hint" id="hintSrPhoto">24 soat / 7 kun / 30 kun</div>
      </div>
      <div class="kpi-card" style="--accent: #f472b6">
        <div class="kpi-label">Reels qidiruvlari</div>
        <div class="kpi-value" id="valSrReels">…</div>
        <div class="kpi-hint" id="hintSrReels">24 soat / 7 kun / 30 kun</div>
      </div>
    </div>
    <div class="kpi-grid" id="mainKpis">
      <div class="kpi-card" style="--accent: var(--accent)">
        <div class="kpi-label">Jami foydalanuvchilar</div>
        <div class="kpi-value" id="valUsers">...</div>
        <div class="kpi-hint" id="valUsersStarted">...</div>
      </div>
      <div class="kpi-card" style="--accent: var(--secondary)">
        <div class="kpi-label">DAU (Bugun)</div>
        <div class="kpi-value" id="valDau">...</div>
        <div class="kpi-hint">Sutkalik faol foydalanuvchilar</div>
      </div>
      <div class="kpi-card" style="--accent: var(--warning)">
        <div class="kpi-label">Screenshotlar</div>
        <div class="kpi-value" id="valPhotos">...</div>
        <div class="kpi-hint">Barcha vaqt davomida</div>
      </div>
      <div class="kpi-card" style="--accent: #a855f7">
        <div class="kpi-label">O'rtacha faollik</div>
        <div class="kpi-value" id="valAvg">...</div>
        <div class="kpi-hint">Soha bo'yicha tahlil</div>
      </div>
    </div>

    <div class="dashboard-row">
      <div class="panel">
        <div class="panel-header">
          <h2>Qidiruvlar — kunlik</h2>
          <div class="pg-status" style="font-size: 0.7rem; padding: 4px 10px;">So'nggi 14 kun (UTC)</div>
        </div>
        <div class="chart-container">
          <canvas id="chartActivity"></canvas>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Aniqroqlik (30 kun)</h2>
        </div>
        <div class="chart-container" style="height: 180px;">
          <canvas id="chartAccuracy"></canvas>
        </div>
        <div class="accuracy-metrics" id="accuracyMetrics">
          <!-- Dynamically filled -->
        </div>
      </div>
    </div>

    <div class="section-title">Manbalar va mazmun</div>
    <div class="dashboard-row" style="grid-template-columns: 1fr 1fr;">
      <div class="panel">
        <h2>Qidiruv manbalari</h2>
        <p class="panel-note">Haqiqiy qidiruv urinishlari — oxirgi 30 kun (feedback emas).</p>
        <div class="chart-container" style="height: 250px;">
          <canvas id="chartSources"></canvas>
        </div>
      </div>
      <div class="panel">
        <h2>Eng ko'p qidirilganlar</h2>
        <p class="panel-note">Cache bo'yicha eng yuqori hitga ega filmlar.</p>
        <div class="film-list" id="filmList">
          <!-- Dynamically filled -->
        </div>
      </div>
    </div>

    <div class="section-title">Foydalanuvchilar va so‘nggi javoblar</div>
    <div class="dashboard-row" style="grid-template-columns: 1fr 1fr;">
      <div class="panel">
        <div class="panel-header">
          <h2>Faol foydalanuvchilar</h2>
        </div>
        <p class="panel-note">
          Har bir qator: <strong>matn</strong> so‘rovlari (botdan boshlab jami), oxirgi <strong>30 kun</strong>da screenshot va Reels,
          shuningdek shu davrda berilgan <strong>Ha</strong> / <strong>Yo‘q</strong> feedbacklari.
        </p>
        <div class="user-activity-scroll" id="userActivityList">
          <p class="panel-note" style="margin:0">Yuklanmoqda…</p>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header" style="flex-wrap:wrap;gap:12px">
          <h2>So‘nggi: nima so‘raldi / nima chiqdi</h2>
          <a href="/dashboard/feedback" class="btn btn-outline" style="font-size:0.8rem;padding:8px 14px">Barchasini ochish →</a>
        </div>
        <p class="panel-note">
          Oxirgi identifikatsiya javoblari: foydalanuvchi matni (agar bo‘lsa), bot qaytargan qisqa natija va film nomi.
        </p>
        <div class="fb-preview-scroll" id="recentFeedbackList">
          <p class="panel-note" style="margin:0">Yuklanmoqda…</p>
        </div>
      </div>
    </div>

    <div class="section-title">Tizim holati</div>
    <div class="kpi-grid">
       <div class="kpi-card" style="--accent: var(--secondary)">
          <div class="kpi-label">WAU / MAU</div>
          <div class="kpi-value" id="valRetention">...</div>
          <div class="kpi-hint">Haftalik va oylik faollik</div>
       </div>
       <div class="kpi-card" style="--accent: var(--accent)">
          <div class="kpi-label">Matn oynasi (limit)</div>
          <div class="kpi-value" id="valPgEvents">...</div>
          <div class="kpi-hint">users.request_count yig‘indisi (12 soat oynasi)</div>
       </div>
       <div class="kpi-card" style="--accent: var(--warning)">
          <div class="kpi-label">O'rtacha feedback</div>
          <div class="kpi-value" id="valAvgFb">...</div>
          <div class="kpi-hint">Har bir foydalanuvchiga</div>
       </div>
    </div>

  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script src="/dashboard-app.js"></script>
</body>
</html>`;
}


export function startDashboard(): void {
  const user = process.env.DASHBOARD_USER?.trim();
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) {
    console.warn('⚠️ Dashboard o‘chirilgan: DASHBOARD_USER va DASHBOARD_PASSWORD .env da yo‘q');
    return;
  }

  const secret =
    process.env.DASHBOARD_SESSION_SECRET || 'kinova-change-me-in-production-min-32-characters!!';
  if (secret.includes('change-me')) {
    console.warn('⚠️ DASHBOARD_SESSION_SECRET ni production uchun almashtiring');
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      name: 'kinova.sid',
      secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  const logosDir = path.join(process.cwd(), 'logos');
  if (fs.existsSync(logosDir)) {
    app.use('/logos', express.static(logosDir, { maxAge: '1d' }));
  }

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (req.session.kinovaAuth) return next();
    /** JSON API — redirect emas (fetch HTML olib `json()` xato bermasligi uchun) */
    if (req.path.startsWith('/api')) {
      res.status(401).json({ error: 'login_required' });
      return;
    }
    res.redirect('/login');
  };

  /** Alohida .js — inline skript TS template ichida emas (apostrof / qochirish xatolari) */
  app.get('/dashboard-app.js', requireAuth, (_req, res) => {
    res.type('application/javascript; charset=utf-8');
    res.sendFile(path.join(__dirname, 'dashboardClient.js'));
  });

  app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'kinova' }));

  app.get('/login', (req, res) => {
    if (req.session.kinovaAuth) return res.redirect('/dashboard');
    res.type('html').send(loginPage());
  });

  app.post('/login', (req, res) => {
    const u = String(req.body?.username ?? '').trim();
    const p = String(req.body?.password ?? '');
    if (timingSafeEqualStr(u, user) && timingSafeEqualStr(p, pass)) {
      req.session.kinovaAuth = true;
      return res.redirect('/dashboard');
    }
    res.type('html').send(loginPage('Login yoki parol noto‘g‘ri'));
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  app.get('/dashboard', requireAuth, (_req, res) => {
    res.type('html').send(dashboardPage(pickLogoHref()));
  });

  app.get('/dashboard/feedback', requireAuth, (_req, res) => {
    res.type('html').send(renderFeedbackListPage(pickLogoHref()));
  });

  app.get('/api/stats', requireAuth, async (_req, res) => {
    try {
      const data = await loadDashboardPayload();
      res.json(data);
    } catch {
      res.status(500).json({ error: 'stats' });
    }
  });

  app.get('/api/feedback-events', requireAuth, async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '40'), 10);
      const offset = parseInt(String(req.query.offset ?? '0'), 10);
      const days = parseInt(String(req.query.days ?? '30'), 10);
      const source = String(req.query.source ?? '').trim();
      const vote = String(req.query.vote ?? '').trim();
      const data = await loadFeedbackEventsPage(limit, offset, days, {
        ...(source ? { source } : {}),
        ...(vote ? { vote } : {}),
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: 'feedback-events' });
    }
  });

  app.get('/api/telegram-file', requireAuth, async (req, res) => {
    const raw = req.query.file_id;
    const fileId = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0] ?? '').trim() : '';
    if (!isPlausibleTelegramFileId(fileId)) {
      res.status(400).end();
      return;
    }
    const token = process.env.BOT_TOKEN?.trim();
    if (!token) {
      res.status(503).type('text/plain').send('BOT_TOKEN yoq');
      return;
    }
    try {
      const getFileRes = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const body = (await getFileRes.json()) as {
        ok?: boolean;
        result?: { file_path?: string };
        description?: string;
      };
      if (!getFileRes.ok || !body.ok || !body.result?.file_path) {
        if (body.description && process.env.DEBUG_TELEGRAM_FILE === '1') {
          console.warn('telegram getFile:', body.description);
        }
        res.status(404).end();
        return;
      }
      const fileUrl = `https://api.telegram.org/file/bot${token}/${body.result.file_path}`;
      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) {
        res.status(502).end();
        return;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      let ct = (imgRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ct || ct === 'application/octet-stream' || !ct.startsWith('image/')) {
        const sniff = sniffImageMime(buf);
        if (sniff) ct = sniff;
        else if (!ct) ct = 'image/jpeg';
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    } catch {
      res.status(500).end();
    }
  });

  app.get('/', (_req, res) => res.redirect('/dashboard'));

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => {
    console.log(`📊 Dashboard: http://0.0.0.0:${port}/dashboard  ·  Ha/Yo‘q: /dashboard/feedback`);
  });
}

declare module 'express-session' {
  interface SessionData {
    kinovaAuth?: boolean;
  }
}
