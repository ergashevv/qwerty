export function renderFeedbackListPage(logoHref: string | null): string {
  const logoBlock = logoHref
    ? `<div class="logo-brand"><img src="${logoHref}" alt="Kinova"/></div>`
    : `<div class="logo-fallback" aria-hidden="true"></div>`;

  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Kinova — Ha / Yo‘q</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg: #05070a;
      --surface: rgba(13, 17, 23, 0.7);
      --surface-border: rgba(255, 255, 255, 0.08);
      --accent: #2dd4bf;
      --secondary: #6366f1;
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
      background-image: radial-gradient(circle at 0% 0%, rgba(45, 212, 191, 0.05) 0%, transparent 40%), linear-gradient(180deg, #05070a 0%, #080a0f 100%);
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 40px 24px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      gap: 24px;
      flex-wrap: wrap;
    }

    .brand-wrap { display: flex; align-items: center; gap: 16px; }
    
    .logo-brand {
      height: 56px; padding: 10px 18px;
      background: linear-gradient(145deg, #112a24, #0a1a16);
      border: 1px solid rgba(45, 212, 191, 0.2);
      border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
    }
    .logo-brand img { height: 100%; width: auto; max-width: 140px; }

    .btn {
      padding: 10px 20px; border-radius: 12px; font-weight: 600; font-size: 0.9rem;
      text-decoration: none; transition: all 0.2s; display: flex; align-items: center;
      gap: 8px; font-family: var(--font-ui);
      border: 1px solid var(--surface-border); background: var(--surface); color: var(--text); backdrop-filter: blur(10px);
    }
    .btn:hover { background: rgba(255,255,255,0.05); transform: translateY(-1px); }

    .panel {
      background: var(--surface); border: 1px solid var(--surface-border);
      border-radius: 24px; padding: 32px; backdrop-filter: blur(16px);
    }

    .panel-header { margin-bottom: 24px; }
    .panel-header h1 { margin: 0 0 8px; font-size: 1.5rem; font-weight: 700; }
    .panel-header p { margin: 0; color: var(--text-muted); font-size: 0.9rem; line-height: 1.5; }

    .filters {
      display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
      padding-bottom: 24px; border-bottom: 1px solid var(--surface-border);
    }
    .filter-group { display: flex; flex-direction: column; gap: 6px; }
    .filter-group label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .filter-group select {
      background: rgba(0,0,0,0.3); border: 1px solid var(--surface-border);
      color: var(--text); padding: 10px 14px; border-radius: 10px; font-family: var(--font-ui); min-width: 160px;
    }

    .table-container { 
      overflow-x: auto; border-radius: 16px; border: 1px solid var(--surface-border);
      background: rgba(0,0,0,0.2);
    }
    table { width: 100%; border-collapse: collapse; min-width: 1100px; }
    th { text-align: left; padding: 16px; font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.1em; border-bottom: 1px solid var(--surface-border); }
    td { padding: 16px; border-bottom: 1px solid var(--surface-border); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }

    .badge { padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 0.75rem; display: inline-block; }
    .badge-yes { background: rgba(45, 212, 191, 0.15); color: var(--accent); }
    .badge-no { background: rgba(244, 63, 94, 0.15); color: var(--error); }

    .user-info { display: flex; flex-direction: column; gap: 4px; }
    .user-name { font-weight: 600; font-size: 0.95rem; }
    .user-id { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-ui); }

    .film-info { display: flex; flex-direction: column; gap: 4px; max-width: 300px; }
    .film-title { font-weight: 600; line-height: 1.4; color: var(--text); }
    .film-uz { font-size: 0.8rem; color: var(--text-muted); }

    .query-box {
      font-size: 0.8rem; line-height: 1.5; background: rgba(0,0,0,0.3);
      padding: 10px; border-radius: 8px; border: 1px solid var(--surface-border);
      max-width: 350px; overflow-wrap: break-word; font-family: var(--font-ui);
    }
    .query-label { font-size: 0.65rem; color: var(--text-muted); margin-bottom: 4px; font-weight: 700; }

    .thumb-wrap { width: 80px; height: 80px; border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.05); }
    .thumb-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .thumb-empty { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 1.5rem; color: var(--surface-border); }

    .pagination { display: flex; align-items: center; gap: 16px; margin-top: 24px; }
    .pagination-hint { font-size: 0.85rem; color: var(--text-muted); }

    #status { font-size: 0.85rem; padding: 12px 0; color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand-wrap">
        ${logoBlock}
        <div class="user-info">
          <span style="font-weight:700; font-size:1.2rem; letter-spacing:-0.02em">Feedback Tahlili</span>
        </div>
      </div>
      <a href="/dashboard" class="btn">← Dashboard</a>
    </header>

    <div class="panel">
      <div class="panel-header">
        <h1>Ha / Yo‘q — batafsil</h1>
        <p>Foydalanuvchilarning film topildimi degan savolga bergan javoblari va qidiruv tafsilotlari.</p>
      </div>

      <div class="filters">
        <div class="filter-group">
          <label for="fbDays">Davr (kun)</label>
          <select id="fbDays">
            <option value="7">So'nggi 7 kun</option>
            <option value="30" selected>So'nggi 30 kun</option>
            <option value="90">So'nggi 90 kun</option>
            <option value="365">Barcha vaqt</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="fbSource">Manba</label>
          <select id="fbSource">
            <option value="">Barcha manbalar</option>
            <option value="photo">Screenshot (Rasm)</option>
            <option value="text">Matn qidiruv</option>
            <option value="reels">Instagram Reels</option>
          </select>
        </div>
        <div class="filter-group">
          <label for="fbVote">Natija</label>
          <select id="fbVote">
            <option value="">Barcha natijalar</option>
            <option value="yes">Faqat "Ha"</option>
            <option value="no">Faqat "Yo'q"</option>
          </select>
        </div>
      </div>

      <div id="status"></div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 140px">Vaqt (Tashkent)</th>
              <th>Foydalanuvchi</th>
              <th style="width: 80px">Natija</th>
              <th>Yo'nalish</th>
              <th>Topilgan film</th>
              <th>So'rov / Javob</th>
              <th style="width: 100px">Rasm</th>
            </tr>
          </thead>
          <tbody id="fbRows"></tbody>
        </table>
      </div>

      <div class="pagination">
        <button class="btn" id="fbPrev">Oldingi</button>
        <button class="btn" id="fbNext">Keyingi</button>
        <span class="pagination-hint" id="fbPageHint"></span>
      </div>
    </div>
  </div>

  <script>
    (function () {
      var limit = 40;
      var offset = 0;
      var days = 30;
      var loading = false;
      
      var selDays = document.getElementById('fbDays');
      var selSrc = document.getElementById('fbSource');
      var selVote = document.getElementById('fbVote');
      var btnPrev = document.getElementById('fbPrev');
      var btnNext = document.getElementById('fbNext');
      var tbody = document.getElementById('fbRows');
      var hint = document.getElementById('fbPageHint');
      var statusEl = document.getElementById('status');
      
      function fmt(n) { return new Intl.NumberFormat('uz-UZ').format(n); }
      function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

      function load() {
        if (loading) return;
        loading = true;
        statusEl.textContent = 'Yuklanmoqda...';
        
        var query = 'limit=' + limit + '&offset=' + offset + '&days=' + days;
        if (selSrc.value) query += '&source=' + encodeURIComponent(selSrc.value);
        if (selVote.value) query += '&vote=' + encodeURIComponent(selVote.value);

        fetch('/api/feedback-events?' + query)
          .then(r => r.json())
          .then(data => {
            loading = false;
            statusEl.textContent = '';
            
            btnPrev.disabled = offset <= 0;
            btnNext.disabled = (offset + data.items.length) >= data.total;
            
            hint.textContent = data.total ? (fmt(offset + 1) + '–' + fmt(offset + data.items.length) + ' / jami ' + fmt(data.total)) : 'Ma\\'lumot yo\\'q';
            
            tbody.innerHTML = data.items.map(it => {
              var date = new Date(it.createdAt).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
              var userHtml = '<div class="user-info"><div class="user-name">' + esc(it.userFirstName || 'Anonim') + (it.userUsername ? ' <span style="color:var(--accent)">@' + esc(it.userUsername) + '</span>' : '') + '</div><div class="user-id">ID: ' + it.telegramUserId + '</div></div>';
              var voteHtml = '<td><span class="badge ' + (it.correct ? 'badge-yes' : 'badge-no') + '">' + (it.correct ? 'Ha' : 'Yo\\'q') + '</span></td>';
              
              var srcMap = { photo: 'Screenshot', text: 'Matn', reels: 'Reels' };
              var src = srcMap[it.source] || it.source;

              var filmHtml = '<div class="film-info"><div class="film-title">' + esc(it.predictedTitle) + '</div>' + (it.predictedUzTitle ? '<div class="film-uz">' + esc(it.predictedUzTitle) + '</div>' : '') + '</div>';
              
              var queryHtml = '<td>';
              if (it.source === 'text') {
                if (it.userQueryText) queryHtml += '<div class="query-box"><div class="query-label">Siz:</div>' + esc(it.userQueryText) + '</div>';
                if (it.botReplyPreview) queryHtml += '<div class="query-box" style="margin-top:8px"><div class="query-label">Bot:</div>' + esc(it.botReplyPreview) + '</div>';
              } else {
                queryHtml += '<span style="color:var(--text-muted)">—</span>';
              }
              queryHtml += '</td>';

              var thumbHtml = '<td><div class="thumb-wrap">';
              if (it.dashboardThumbB64) {
                thumbHtml += '<img src="data:image/jpeg;base64,' + it.dashboardThumbB64 + '" alt=""/>';
              } else if (it.photoFileId) {
                thumbHtml += '<div class="thumb-loading" data-fid="' + it.photoFileId + '">...</div>';
              } else {
                thumbHtml += '<div class="thumb-empty">?</div>';
              }
              thumbHtml += '</div></td>';

              return '<tr><td>' + date + '</td><td>' + userHtml + '</td>' + voteHtml + '<td>' + esc(src) + '</td><td>' + filmHtml + '</td>' + queryHtml + thumbHtml + '</tr>';
            }).join('');
            
            loadImages();
          })
          .catch(err => {
            loading = false;
            statusEl.textContent = 'Yuklashda xato yuz berdi.';
            console.error(err);
          });
      }

      function loadImages() {
        var wraps = document.querySelectorAll('.thumb-loading');
        wraps.forEach(wrap => {
          var fid = wrap.getAttribute('data-fid');
          fetch('/api/telegram-file?file_id=' + encodeURIComponent(fid))
            .then(r => r.ok ? r.blob() : Promise.reject())
            .then(blob => {
              var url = URL.createObjectURL(blob);
              var img = new Image();
              img.src = url;
              wrap.parentNode.innerHTML = '<img src="' + url + '" alt=""/>';
            })
            .catch(() => {
              wrap.parentNode.innerHTML = '<div class="thumb-empty">!</div>';
            });
        });
      }

      [selDays, selSrc, selVote].forEach(el => el.addEventListener('change', () => { offset = 0; if (el === selDays) days = el.value; load(); }));
      btnPrev.addEventListener('click', () => { offset = Math.max(0, offset - limit); load(); });
      btnNext.addEventListener('click', () => { offset += limit; load(); });

      load();
    })();
  </script>
</body>
</html>`;
}

