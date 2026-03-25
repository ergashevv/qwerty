import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { loadDashboardPayload } from './statsService';

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

function dashboardPage(data: Awaited<ReturnType<typeof loadDashboardPayload>>, logoHref: string | null): string {
  const payloadJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const logoBlock = logoHref
    ? `<div class="logo-brand"><img src="${logoHref}" alt="Kinova"/></div>`
    : `<div class="logo-fallback" aria-hidden="true"></div>`;

  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kinova — statistika</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root{
      --bg:#0a0c10;
      --surface:#12151c;
      --surface2:#0f0f0f;
      --line:rgba(255,255,255,.08);
      --text:#e9ecf1;
      --muted:#8b95a8;
      --accent:#3dd4c4;
      --accent-soft:rgba(61,212,196,.14);
      --amber:#e8b84a;
      --amber-soft:rgba(232,184,74,.12);
    }
    *,*::before,*::after{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{
      margin:0;font-family:'DM Sans',system-ui,sans-serif;font-size:16px;background:var(--bg);color:var(--text);
      min-height:100vh;-webkit-font-smoothing:antialiased;
      overflow-x:hidden;overflow-y:auto;
      background-image:
        radial-gradient(ellipse 90% 80% at 0% -10%, rgba(61,212,196,.09), transparent 55%),
        radial-gradient(ellipse 70% 50% at 100% 0%, rgba(232,184,74,.05), transparent 50%),
        linear-gradient(180deg, #0a0c10 0%, #08090d 100%);
    }
    .wrap{max-width:1040px;margin:0 auto;padding:32px 20px 72px}
    .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px}
    .title{display:flex;align-items:center;gap:20px;flex:1;min-width:0}
    .logo-brand{
      flex-shrink:0;padding:14px 22px;min-height:72px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(160deg,#1a3d30 0%,#142a22 100%);border-radius:16px;border:1px solid rgba(255,255,255,.1);
      box-shadow:0 8px 32px rgba(0,0,0,.4)}
    .logo-brand img{height:46px;width:auto;max-width:200px;object-fit:contain;display:block}
    .logo-fallback{width:120px;height:72px;border-radius:16px;background:linear-gradient(135deg,var(--accent),#14a89a);opacity:.9;flex-shrink:0}
    .title-text{min-width:0}
    h1{margin:0;font-size:1.5rem;font-weight:700;letter-spacing:-.03em;line-height:1.2}
    .sub{margin:8px 0 0;font-size:.9375rem;color:var(--muted);font-weight:400;line-height:1.5;max-width:min(52ch,100%)}
    .topbar-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
    .badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
      padding:.28rem .55rem;border-radius:6px;background:var(--accent-soft);color:var(--accent);margin-left:6px;vertical-align:2px}
    .pg-pill{font-size:.8125rem;font-weight:500;padding:.45rem .85rem;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
    .pg-pill.ok{border-color:rgba(61,212,196,.35);color:#a8e8df;background:rgba(61,212,196,.08)}
    .pg-pill.bad{border-color:rgba(255,100,120,.25);color:#f0a8b0}
    .out{color:var(--text);text-decoration:none;font-size:.875rem;font-weight:600;padding:.55rem 1.1rem;border-radius:10px;
      border:1px solid var(--line);background:var(--surface);transition:background .15s,border-color .15s}
    .out:hover{background:#181c26;border-color:rgba(61,212,196,.35)}
    .section{margin-bottom:28px}
    .section-label{font-size:.6875rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
    .metric-row{display:grid;gap:12px}
    .metric-row--3{grid-template-columns:repeat(3,minmax(0,1fr))}
    .metric-row--2{grid-template-columns:repeat(2,minmax(0,1fr))}
    @media(max-width:820px){.metric-row--3{grid-template-columns:1fr}}
    @media(max-width:560px){.metric-row--2{grid-template-columns:1fr}}
    .kpi{
      background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;
      border-left:3px solid var(--accent)}
    .kpi .lbl{font-size:.8125rem;font-weight:500;color:var(--muted);line-height:1.35}
    .kpi .val{font-size:1.65rem;font-weight:700;margin-top:6px;letter-spacing:-.03em}
    .kpi .hint{font-size:.75rem;color:var(--muted);margin-top:8px;line-height:1.45;opacity:.92}
    .feedback-hero{margin-bottom:28px}
    .feedback-card{
      background:linear-gradient(165deg,rgba(61,212,196,.07),rgba(232,184,74,.04));border:1px solid rgba(61,212,196,.2);
      border-radius:16px;padding:22px 24px}
    .feedback-card h2{margin:0 0 8px;font-size:1.1rem;font-weight:700;letter-spacing:-.02em}
    .feedback-card p.note{margin:0 0 16px;font-size:.875rem;color:var(--muted);line-height:1.55}
    .fb-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:520px){.fb-row{grid-template-columns:1fr}}
    .fb-stat{text-align:center;padding:14px 10px;background:rgba(0,0,0,.22);border-radius:12px;border:1px solid var(--line)}
    .fb-stat .fb-big{font-size:1.85rem;font-weight:700;letter-spacing:-.03em}
    .fb-stat .fb-cap{font-size:.8125rem;color:var(--muted);margin-top:8px;line-height:1.4}
    .fb-pill{display:inline-block;margin-top:12px;font-size:.8125rem;padding:.4rem .85rem;border-radius:99px;background:rgba(255,255,255,.06);color:var(--muted)}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media(max-width:900px){.grid2{grid-template-columns:1fr}}
    .panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px 20px}
    .panel h2{margin:0 0 8px;font-size:1rem;font-weight:700;letter-spacing:-.02em}
    .panel p.note{margin:0 0 12px;font-size:.8125rem;color:var(--muted);line-height:1.5}
    .chart-box{height:240px;position:relative;margin-top:4px}
    .bar-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
    .bar-row span:first-child{flex:1;font-size:.875rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .bar-row span.num{font-size:.875rem;font-weight:700;color:var(--amber);min-width:40px;text-align:right}
    .bar-bg{flex:2;height:7px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden}
    .bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--amber));transition:width .4s ease}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <div class="title">
        ${logoBlock}
        <div class="title-text">
          <h1>Kinova <span class="badge">live</span></h1>
          <p class="sub">Screenshot va matn orqali film qidiruv — faollik va foydalanuvchi javoblari.</p>
        </div>
      </div>
      <div class="topbar-actions">
        <span class="pg-pill" id="pgStatus"></span>
        <a class="out" href="/logout">Chiqish</a>
      </div>
    </header>

    <div class="feedback-hero" id="feedbackHero"></div>

    <section class="section">
      <h2 class="section-label">Faollik (UTC)</h2>
      <div class="metric-row metric-row--3" id="metricsAct"></div>
    </section>

    <section class="section">
      <h2 class="section-label">Foydalanuvchilar</h2>
      <div class="metric-row metric-row--2" id="metricsUsers"></div>
    </section>

    <section class="section">
      <h2 class="section-label">Qidiruvlar</h2>
      <div class="metric-row metric-row--2" id="metricsUsage"></div>
    </section>

    <section class="section">
      <h2 class="section-label">Grafiklar</h2>
      <div class="grid2">
        <div class="panel">
          <h2>Rasm so‘rovlari</h2>
          <p class="note">So‘nggi 14 kun — har bir kun uchun nechta screenshot yuborilgan.</p>
          <div class="chart-box"><canvas id="chartPhotos"></canvas></div>
        </div>
        <div class="panel">
          <h2>Neon: analytics_events</h2>
          <p class="note">So‘nggi 14 kun — Postgresga yozilgan eventlar.</p>
          <div class="chart-box"><canvas id="chartPg"></canvas></div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-label">Eng ko‘p ko‘rilgan filmlar (cache)</h2>
      <div class="panel">
        <p class="note">TMDB cache bo‘yicha hit_count.</p>
        <div id="bars"></div>
      </div>
    </section>
  </div>
  <script id="payload" type="application/json">${payloadJson}</script>
  <script>
    const data = JSON.parse(document.getElementById('payload').textContent);
    const fmt = (n) => new Intl.NumberFormat('uz-UZ').format(n);
    function kpi(lbl, val, hint) {
      const v = typeof val === 'number' ? fmt(val) : val;
      return '<div class="kpi"><div class="lbl">' + lbl + '</div><div class="val">' + v + '</div><div class="hint">' + hint + '</div></div>';
    }
    (function pg() {
      var el = document.getElementById('pgStatus');
      if (!el) return;
      if (data.postgresOk) {
        el.className = 'pg-pill ok';
        el.textContent = 'Postgres · ulanilgan';
      } else {
        el.className = 'pg-pill bad';
        el.textContent = 'Postgres · yo‘q';
      }
    })();
    (function renderFeedback() {
      const ok = data.feedbackCorrect ?? 0;
      const bad = data.feedbackWrong ?? 0;
      const total = data.feedbackTotal != null ? data.feedbackTotal : (ok + bad);
      const pct = total > 0 ? Math.round((100 * ok) / total) : null;
      const pill = pct != null
        ? '<span class="fb-pill">“Ha, shu film”: ' + pct + '%</span>'
        : '<span class="fb-pill">Hali tugma bosilmagan</span>';
      document.getElementById('feedbackHero').innerHTML =
        '<div class="feedback-card">' +
        '<h2>Topilgan film to‘g‘rimi?</h2>' +
        '<p class="note">Foydalanuvchi javobdan keyin tanlaydi. Oxirgi <b>30 kun</b>.</p>' +
        '<div class="fb-row">' +
        '<div class="fb-stat"><div class="fb-big">' + fmt(ok) + '</div><div class="fb-cap">Ha, shu film</div></div>' +
        '<div class="fb-stat"><div class="fb-big">' + fmt(bad) + '</div><div class="fb-cap">Yo‘q, bu emas</div></div>' +
        '</div>' + pill + '</div>';
    })();
    document.getElementById('metricsAct').innerHTML = [
      ['DAU — bugun', data.dau ?? 0, 'Bugun UTC bo‘yicha kamida bitta faollik'],
      ['WAU — 7 kun', data.wau ?? 0, 'So‘nggi 7 kun ichida faol foydalanuvchilar'],
      ['MAU — 30 kun', data.mau ?? 0, 'So‘nggi 30 kun ichida faol'],
    ].map(function (x) { return kpi(x[0], x[1], x[2]); }).join('');
    document.getElementById('metricsUsers').innerHTML = [
      ['Jami (SQLite)', data.users, 'start / matn / rasm — alohida odam'],
      ['/start bosgan', data.usersStarted ?? 0, 'bir marta ham /start'],
    ].map(function (x) { return kpi(x[0], x[1], x[2]); }).join('');
    document.getElementById('metricsUsage').innerHTML = [
      ['Screenshotlar (jami)', data.photoTotal, 'photo_requests'],
      ['Matn so‘rovlari (yig‘indi)', data.textSum, 'request_count yig‘indisi'],
    ].map(function (x) { return kpi(x[0], x[1], x[2]); }).join('');

    const tickColor = 'rgba(200,210,225,.75)';
    const gridColor = 'rgba(255,255,255,.06)';
    const ChartCfg = {
      type: 'line',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: tickColor, maxRotation: 0, font: { size: 11, weight: '500' } },
            grid: { color: gridColor }
          },
          y: {
            beginAtZero: true,
            ticks: { color: tickColor, font: { size: 11, weight: '500' } },
            grid: { color: gridColor }
          }
        }
      }
    };
    const labelsP = (data.photoByDay || []).map(d => d.label);
    const valsP = (data.photoByDay || []).map(d => d.value);
    new Chart(document.getElementById('chartPhotos'), {
      ...ChartCfg,
      data: {
        labels: labelsP.length ? labelsP : ['—'],
        datasets: [{
          label: 'Rasm',
          data: valsP.length ? valsP : [0],
          borderColor: '#3dd4c4',
          backgroundColor: 'rgba(61,212,196,.12)',
          fill: true,
          tension: .35,
          borderWidth: 2,
        }]
      }
    });
    const labelsA = (data.analyticsByDay || []).map(d => d.label);
    const valsA = (data.analyticsByDay || []).map(d => d.value);
    new Chart(document.getElementById('chartPg'), {
      ...ChartCfg,
      data: {
        labels: labelsA.length ? labelsA : ['—'],
        datasets: [{
          label: 'Events',
          data: valsA.length ? valsA : [0],
          borderColor: '#e8b84a',
          backgroundColor: 'rgba(232,184,74,.1)',
          fill: true,
          tension: .35,
          borderWidth: 2,
        }]
      }
    });

    const films = data.topFilms || [];
    const maxH = Math.max(1, ...films.map(f => f.hits));
    document.getElementById('bars').innerHTML = films.length ? films.map(f => {
      const pct = Math.round((f.hits / maxH) * 100);
      return '<div class="bar-row"><span title="' + f.title.replace(/"/g,'&quot;') + '">' + f.title + '</span><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%"></div></div><span class="num">' + fmt(f.hits) + '</span></div>';
    }).join('') : '<p class="note">Hali ma’lumot yo‘q.</p>';
  </script>
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
    res.redirect('/login');
  };

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

  app.get('/dashboard', requireAuth, async (_req, res) => {
    try {
      const data = await loadDashboardPayload();
      res.type('html').send(dashboardPage(data, pickLogoHref()));
    } catch (e) {
      res.status(500).send('Statistika yuklanmadi');
    }
  });

  app.get('/api/stats', requireAuth, async (_req, res) => {
    try {
      const data = await loadDashboardPayload();
      res.json(data);
    } catch {
      res.status(500).json({ error: 'stats' });
    }
  });

  app.get('/', (_req, res) => res.redirect('/dashboard'));

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => {
    console.log(`📊 Dashboard: http://0.0.0.0:${port}/dashboard`);
  });
}

declare module 'express-session' {
  interface SessionData {
    kinovaAuth?: boolean;
  }
}
