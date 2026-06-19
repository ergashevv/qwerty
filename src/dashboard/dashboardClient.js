(function () {
  // ─── Constants ────────────────────────────────────────────────────────────
  var REFRESH_INTERVAL_MS = 30000; // 30 seconds
  var COUNTDOWN_TICK_MS   = 1000;  // 1 second tick

  // ─── State ────────────────────────────────────────────────────────────────
  var refreshTimer     = null;  // setInterval handle for auto-refresh
  var countdownTimer   = null;  // setInterval handle for countdown display
  var countdownSeconds = 30;    // current countdown value
  var isFetching       = false; // guard against concurrent fetches
  var chartInstances   = {};    // keyed chart instances for destroy/re-create

  // ─── Connection-status states ─────────────────────────────────────────────
  // 'idle'       – never fetched yet (startup)
  // 'loading'    – fetch in flight
  // 'connected'  – last fetch succeeded
  // 'error'      – last fetch failed
  // 'paused'     – tab hidden, refresh paused
  var connState = 'idle';

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function showDashErr(msg) {
    var el = document.getElementById('dashErr');
    if (el) { el.style.display = 'block'; el.textContent = msg; }
  }

  function hideDashErr() {
    var el = document.getElementById('dashErr');
    if (el) el.style.display = 'none';
  }

  function fmt(n) {
    if (n == null) return '0';
    return new Intl.NumberFormat('uz-UZ').format(n);
  }

  var COLORS = {
    accent:    '#2dd4bf',
    secondary: '#6366f1',
    warning:   '#f59e0b',
    error:     '#f43f5e',
    textMuted: '#94a3b8',
    grid:      'rgba(255, 255, 255, 0.05)',
  };

  // ─── Connection-status indicator ──────────────────────────────────────────
  function setConnState(state) {
    connState = state;
    var bar = document.getElementById('connStatusBar');
    if (!bar) return;

    var dot   = bar.querySelector('.conn-dot');
    var label = bar.querySelector('.conn-label');
    var cd    = bar.querySelector('.conn-countdown');

    switch (state) {
      case 'loading':
        bar.className  = 'conn-status-bar loading';
        if (dot)   dot.className   = 'conn-dot';
        if (label) label.textContent = 'Yangilanmoqda…';
        if (cd)    cd.style.display  = 'none';
        break;
      case 'connected':
        bar.className  = 'conn-status-bar connected';
        if (dot)   dot.className   = 'conn-dot pulse';
        if (label) label.textContent = 'Ulangan';
        if (cd)    cd.style.display  = 'inline';
        break;
      case 'error':
        bar.className  = 'conn-status-bar error';
        if (dot)   dot.className   = 'conn-dot';
        if (label) label.textContent = 'Xato';
        if (cd)    cd.style.display  = 'none';
        break;
      case 'paused':
        bar.className  = 'conn-status-bar paused';
        if (dot)   dot.className   = 'conn-dot';
        if (label) label.textContent = 'To\'xtatildi';
        if (cd)    cd.style.display  = 'none';
        break;
      default: // 'idle'
        bar.className  = 'conn-status-bar';
        if (dot)   dot.className   = 'conn-dot';
        if (label) label.textContent = '—';
        if (cd)    cd.style.display  = 'none';
    }
  }

  function updateCountdownDisplay() {
    var el = document.querySelector('#connStatusBar .conn-countdown');
    if (el) el.textContent = countdownSeconds + 's';
  }

  function setRefreshBtnState(loading) {
    var btn = document.getElementById('btnManualRefresh');
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.setAttribute('data-original', btn.textContent);
      btn.innerHTML = '<span class="spin-icon">↻</span> Yangilanmoqda…';
      btn.style.opacity = '0.7';
    } else {
      btn.disabled = false;
      btn.innerHTML = '<span>↻</span> Yangilash';
      btn.style.opacity = '1';
    }
  }

  // ─── Auto-refresh timers ──────────────────────────────────────────────────
  function startCountdown() {
    stopCountdown();
    countdownSeconds = Math.round(REFRESH_INTERVAL_MS / 1000);
    updateCountdownDisplay();
    countdownTimer = setInterval(function () {
      countdownSeconds = Math.max(0, countdownSeconds - 1);
      updateCountdownDisplay();
    }, COUNTDOWN_TICK_MS);
  }

  function stopCountdown() {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdownSeconds = Math.round(REFRESH_INTERVAL_MS / 1000);
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    startCountdown();
    refreshTimer = setInterval(function () {
      fetchStats();
    }, REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    stopCountdown();
  }

  // ─── Page Visibility API ──────────────────────────────────────────────────
  function handleVisibilityChange() {
    if (document.hidden) {
      // Tab went background — pause timers
      stopAutoRefresh();
      setConnState('paused');
    } else {
      // Tab came back — refresh immediately then restart auto-refresh
      fetchStats();
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  // ─── Chart management ─────────────────────────────────────────────────────
  function destroyChart(id) {
    if (chartInstances[id]) {
      chartInstances[id].destroy();
      delete chartInstances[id];
    }
  }

  function destroyAllCharts() {
    Object.keys(chartInstances).forEach(destroyChart);
  }

  // ─── Fetch & render ───────────────────────────────────────────────────────
  function fetchStats() {
    if (isFetching) return;
    isFetching = true;

    // Reset countdown so it doesn't tick below 0 while fetch is in flight
    stopCountdown();
    setConnState('loading');
    setRefreshBtnState(true);
    hideDashErr();

    fetch('/api/stats', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        isFetching = false;
        destroyAllCharts();
        renderDashboard(data);
        setConnState('connected');
        setRefreshBtnState(false);
        updateLastRefreshedAt();
        // Restart auto-refresh only when tab is visible
        if (!document.hidden) startAutoRefresh();
      })
      .catch(function (e) {
        isFetching = false;
        showDashErr('Statistika yuklanmadi: ' + (e.message || String(e)));
        console.error(e);
        setConnState('error');
        setRefreshBtnState(false);
        // Still schedule retry
        if (!document.hidden) startAutoRefresh();
      });
  }

  function updateLastRefreshedAt() {
    var el = document.getElementById('lastRefreshedAt');
    if (!el) return;
    var now = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = 'Oxirgi yangilanish: ' + now;
  }

  // ─── Manual refresh button ────────────────────────────────────────────────
  function initManualRefreshBtn() {
    var btn = document.getElementById('btnManualRefresh');
    if (!btn) return;
    btn.addEventListener('click', function () {
      stopAutoRefresh(); // cancel current cycle; fetchStats will restart it
      fetchStats();
    });
  }

  // ─── Dashboard render ─────────────────────────────────────────────────────
  function renderDashboard(data) {
    try {
      // 1. Status & KPIs
      var pgStatus = document.getElementById('pgStatus');
      if (pgStatus) {
        pgStatus.className = 'pg-status ' + (data.postgresOk ? 'ok' : 'bad');
        pgStatus.innerHTML = '<span class="status-dot"></span> Postgres ' + (data.postgresOk ? 'ulangan' : 'muammo');
      }

      document.getElementById('valUsers').textContent       = fmt(data.users);
      document.getElementById('valUsersStarted').textContent = fmt(data.usersStarted) + ' ta start bosgan';

      var sr  = data.searchRequests || { h24: {}, d7: {}, d30: {} };
      var h24 = sr.h24 || {};
      var d7  = sr.d7  || {};
      var d30 = sr.d30 || {};

      var elTxt    = document.getElementById('valSrText');
      var elHintTxt = document.getElementById('hintSrText');
      if (elTxt)     elTxt.textContent    = fmt(h24.text);
      if (elHintTxt) elHintTxt.textContent = '7 kun: ' + fmt(d7.text) + ' · 30 kun: ' + fmt(d30.text);

      var elPh     = document.getElementById('valSrPhoto');
      var elHintPh = document.getElementById('hintSrPhoto');
      if (elPh)     elPh.textContent    = fmt(h24.photo);
      if (elHintPh) elHintPh.textContent = '7 kun: ' + fmt(d7.photo) + ' · 30 kun: ' + fmt(d30.photo);

      var elRl     = document.getElementById('valSrReels');
      var elHintRl = document.getElementById('hintSrReels');
      if (elRl)     elRl.textContent    = fmt(h24.reels);
      if (elHintRl) elHintRl.textContent = '7 kun: ' + fmt(d7.reels) + ' · 30 kun: ' + fmt(d30.reels);

      document.getElementById('valDau').textContent    = fmt(data.dau);
      document.getElementById('valPhotos').textContent = fmt(data.photoTotal);

      var avgTxt = data.avgTextRequestsPerUser || 0;
      document.getElementById('valAvg').textContent = avgTxt.toFixed(1);

      document.getElementById('valRetention').textContent = fmt(data.wau) + ' / ' + fmt(data.mau);
      document.getElementById('valPgEvents').textContent  = fmt(data.textSum);

      var fbUsers = data.distinctFeedbackUsers30d || 0;
      var total30 = data.feedbackTotal || 0;
      var avgFb   = fbUsers > 0 ? (total30 / fbUsers).toFixed(2) : '0';
      document.getElementById('valAvgFb').textContent = avgFb;

      // 2. Charts (always re-created; old instances destroyed in fetchStats)
      if (typeof Chart !== 'undefined') {
        renderActivityChart(data);
        renderAccuracyChart(data);
        renderSourceChart(data);
      }

      // 3. Lists
      renderFilmList(data.topFilms || []);
      renderUserActivity(data.userActivityTop || []);
      renderRecentFeedback(data.recentFeedbackPreview || []);
      renderGeminiUsage(data.geminiUsage || null);

    } catch (e) {
      showDashErr('Chizish xatosi: ' + (e.message || String(e)));
      console.error(e);
    }
  }

  // ─── Charts ───────────────────────────────────────────────────────────────
  function renderActivityChart(data) {
    var ctx = document.getElementById('chartActivity');
    if (!ctx) return;

    var byDay     = data.searchRequestsByDay14 || [];
    var labels    = byDay.length ? byDay.map(function (d) { return d.label; })      : ['—'];
    var textVals  = byDay.length ? byDay.map(function (d) { return d.text  || 0; }) : [0];
    var photoVals = byDay.length ? byDay.map(function (d) { return d.photo || 0; }) : [0];
    var reelsVals = byDay.length ? byDay.map(function (d) { return d.reels || 0; }) : [0];

    chartInstances['chartActivity'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Matn',
            data: textVals,
            borderColor: COLORS.secondary,
            backgroundColor: 'rgba(99, 102, 241, 0.08)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: COLORS.secondary,
          },
          {
            label: 'Screenshot',
            data: photoVals,
            borderColor: COLORS.accent,
            backgroundColor: 'rgba(45, 212, 191, 0.1)',
            fill: true,
            tension: 0.35,
            borderWidth: 3,
            pointRadius: 3,
            pointBackgroundColor: COLORS.accent,
          },
          {
            label: 'Reels',
            data: reelsVals,
            borderColor: COLORS.warning,
            backgroundColor: 'rgba(245, 158, 11, 0.08)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: COLORS.warning,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { color: COLORS.textMuted, font: { family: 'Inter', size: 11 }, boxWidth: 12 }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(13, 17, 23, 0.9)',
            titleFont: { size: 13, weight: '600' },
            padding: 12,
            borderColor: COLORS.grid,
            borderWidth: 1
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: COLORS.textMuted, font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            grid: { color: COLORS.grid },
            ticks: { color: COLORS.textMuted, font: { size: 10 } }
          }
        }
      }
    });
  }

  function renderAccuracyChart(data) {
    var ctx = document.getElementById('chartAccuracy');
    if (!ctx) return;

    var ok    = data.feedbackCorrect || 0;
    var bad   = data.feedbackWrong   || 0;
    var total = ok + bad;
    var pct   = total > 0 ? Math.round((ok / total) * 100) : 0;

    chartInstances['chartAccuracy'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['To\'g\'ri', 'Noto\'g\'ri'],
        datasets: [{
          data: [ok, bad],
          backgroundColor: [COLORS.accent, COLORS.error],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '80%',
        circumference: 180,
        rotation: 270,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true }
        }
      }
    });

    var metricsEl = document.getElementById('accuracyMetrics');
    if (metricsEl) {
      metricsEl.innerHTML =
        '<div class="acc-stat">' +
          '<div class="acc-val" style="color:var(--accent)">' + pct + '%</div>' +
          '<div class="acc-label">Aniqroqlik</div>' +
        '</div>' +
        '<div class="acc-stat">' +
          '<div class="acc-val">' + fmt(total) + '</div>' +
          '<div class="acc-label">Jami feedbacklar</div>' +
        '</div>';
    }
  }

  function renderSourceChart(data) {
    var ctx = document.getElementById('chartSources');
    if (!ctx) return;

    var sr30  = (data.searchRequests && data.searchRequests.d30) ? data.searchRequests.d30 : {};
    var photo = Number(sr30.photo || 0);
    var text  = Number(sr30.text  || 0);
    var reels = Number(sr30.reels || 0);

    if (photo + text + reels === 0) {
      var split = data.feedbackSourceSplit30d || { ha: { photo: 0, text: 0, reels: 0 }, yoq: {} };
      photo = (split.ha.photo || 0) + (split.yoq && split.yoq.photo ? split.yoq.photo : 0);
      text  = (split.ha.text  || 0) + (split.yoq && split.yoq.text  ? split.yoq.text  : 0);
      reels = (split.ha.reels || 0) + (split.yoq && split.yoq.reels ? split.yoq.reels : 0);
    }

    chartInstances['chartSources'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Screenshot', 'Matn', 'Reels'],
        datasets: [{
          label: 'Qidiruv urinishlari (30 kun)',
          data: [photo, text, reels],
          backgroundColor: [COLORS.accent, COLORS.secondary, COLORS.warning],
          borderRadius: 8,
          barThickness: 32,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: COLORS.grid }, ticks: { color: COLORS.textMuted } },
          y: { grid: { display: false },     ticks: { color: COLORS.textMuted } }
        }
      }
    });
  }

  // ─── List renderers (unchanged logic) ────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  function renderGeminiUsage(gu) {
    var elTot = document.getElementById('geminiTotals');
    var elOp = document.getElementById('geminiByOp');
    var elU = document.getElementById('geminiTopUsers');
    if (!elTot || !elOp || !elU) return;

    if (!gu || !gu.h24) {
      elTot.innerHTML = '<p style="margin:0;color:var(--text-muted)">Ma’lumot yo‘q — bot yangi versiyasini ishga tushiring va bir necha so‘rov qiling.</p>';
      elOp.innerHTML = '';
      elU.innerHTML = '<p class="panel-note" style="margin:0">—</p>';
      return;
    }

    function row(t) {
      return (
        '<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
        '<span style="color:var(--text-muted)">' + esc(t.label) + '</span>' +
        '<span style="font-weight:600">' + fmt(t.val) + ' tok · ' + fmt(t.calls) + ' chaq</span>' +
        '</div>'
      );
    }

    elTot.innerHTML =
      row({ label: '24 soat', val: gu.h24.totalTokens, calls: gu.h24.calls }) +
      row({ label: '7 kun', val: gu.d7.totalTokens, calls: gu.d7.calls }) +
      row({ label: '30 kun', val: gu.d30.totalTokens, calls: gu.d30.calls });

    var ops = gu.byOperation7d || [];
    if (ops.length === 0) {
      elOp.innerHTML = '<p class="panel-note" style="margin:0">Hozircha yozuv yo‘q.</p>';
    } else {
      elOp.innerHTML = ops
        .map(function (o) {
          return (
            '<div class="film-row">' +
            '<span class="film-title">' + esc(o.operation) + '</span>' +
            '<span class="film-hits">' + fmt(o.totalTokens) + ' tok · ' + fmt(o.calls) + '</span>' +
            '</div>'
          );
        })
        .join('');
    }

    var users = gu.topUsers7d || [];
    if (users.length === 0) {
      elU.innerHTML = '<p class="panel-note" style="margin:0">User ID bilan bog‘langan chaqiruvlar hali yo‘q.</p>';
    } else {
      elU.innerHTML = users
        .map(function (u) {
          var name = initialFromUser(u) + ' <code style="font-size:0.75em;opacity:.85">' + u.telegramUserId + '</code>';
          return (
            '<div class="user-activity-row">' +
            '<div class="ua-name">' + name + '</div>' +
            '<div class="ua-stats"><span>' + fmt(u.totalTokens) + ' tok</span> · <span>' + fmt(u.calls) + ' chaq</span></div>' +
            '</div>'
          );
        })
        .join('');
    }
  }

  function initialFromUser(u) {
    var n = (u && u.userFirstName) ? String(u.userFirstName).trim() : '';
    if (n.length) return n.charAt(0).toUpperCase();
    var x = (u && u.userUsername) ? String(u.userUsername).trim() : '';
    if (x.length) return x.charAt(0).toUpperCase();
    return '?';
  }

  function renderUserActivity(rows) {
    var el = document.getElementById('userActivityList');
    if (!el) return;
    if (!rows || rows.length === 0) {
      el.innerHTML = '<p class="panel-note" style="margin:0">Hali faol foydalanuvchi yo\u2019q yoki ma\u2019lumotlar hali to\u2018planmagan.</p>';
      return;
    }
    el.innerHTML = rows.map(function (u) {
      var name = u.userFirstName || 'Anonim';
      var un   = u.userUsername ? (' @' + u.userUsername) : '';
      var id   = u.telegramUserId;
      var txt  = u.textRequestsTotal   || 0;
      var ph   = u.photoRequests30d    || 0;
      var rl   = u.reelsRequests30d    || 0;
      var ha   = u.feedbackHa30d       || 0;
      var yoq  = u.feedbackYoq30d      || 0;
      var fbt  = u.feedbackTotal30d    || 0;
      var ini  = esc(initialFromUser(u));
      return (
        '<div class="ua-row">' +
          '<div class="ua-avatar">' + ini + '</div>' +
          '<div>' +
            '<div class="ua-head">' +
              '<div class="ua-name">' + esc(name) + (u.userUsername ? ' <span style="color:var(--accent)">' + esc(un) + '</span>' : '') + '</div>' +
              '<div class="ua-meta">Telegram ID: ' + esc(String(id)) + '</div>' +
            '</div>' +
            '<div class="ua-stats">' +
              '<span class="ua-chip">Matn (jami): <strong>' + fmt(txt) + '</strong></span>' +
              '<span class="ua-chip">Screenshot (30 kun): <strong>' + fmt(ph) + '</strong></span>' +
              '<span class="ua-chip">Reels (30 kun): <strong>' + fmt(rl) + '</strong></span>' +
              '<span class="ua-chip ha">Ha: <strong>' + fmt(ha) + '</strong></span>' +
              '<span class="ua-chip yoq">Yo\u2018q: <strong>' + fmt(yoq) + '</strong></span>' +
              '<span class="ua-chip">Feedback jami: <strong>' + fmt(fbt) + '</strong></span>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function srcLabel(s) {
    if (s === 'photo') return 'Screenshot';
    if (s === 'text')  return 'Matn qidiruv';
    if (s === 'reels') return 'Instagram Reels';
    return s || '—';
  }

  function renderRecentFeedback(items) {
    var el = document.getElementById('recentFeedbackList');
    if (!el) return;
    if (!items || items.length === 0) {
      el.innerHTML = '<p class="panel-note" style="margin:0">Oxirgi 30 kunda feedback yozuvlari yo\u2018q.</p>';
      return;
    }
    el.innerHTML = items.map(function (it) {
      var date     = new Date(it.createdAt).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
      var userLine = esc(it.userFirstName || 'Anonim') + (it.userUsername ? ' <span style="color:var(--accent)">@' + esc(it.userUsername) + '</span>' : '');
      var vote     = it.correct ? 'ha'  : 'yoq';
      var voteText = it.correct ? 'Ha'  : 'Yo\u2018q';
      var film     = esc(it.predictedTitle || '—');
      var uz       = it.predictedUzTitle ? '<span class="uz">' + esc(it.predictedUzTitle) + '</span>' : '';
      var src      = srcLabel(it.source);
      var qHtml    = '';
      if (it.source === 'text' && (it.userQueryText || it.botReplyPreview)) {
        qHtml = '<div class="fb-qgrid">';
        if (it.userQueryText)   qHtml += '<div class="fb-qbox"><div class="lbl">Foydalanuvchi yozdi</div>'     + esc(it.userQueryText)   + '</div>';
        if (it.botReplyPreview) qHtml += '<div class="fb-qbox"><div class="lbl">Bot javobi (qisqa)</div>' + esc(it.botReplyPreview) + '</div>';
        qHtml += '</div>';
      } else if (it.source !== 'text') {
        qHtml = '<p class="panel-note" style="margin:0;font-size:0.8rem">Rasm yoki video orqali qidiruv \u2014 matn yo\u2018q.</p>';
      }
      var media = '';
      if (it.dashboardThumbB64) {
        media = '<div class="fb-preview-media"><div class="fb-thumb"><img src="data:image/jpeg;base64,' + it.dashboardThumbB64 + '" alt=""/></div></div>';
      } else if (it.photoFileId) {
        media = '<div class="fb-preview-media"><div class="fb-thumb"><div class="thumb-load" data-fid="' + esc(it.photoFileId) + '" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:0.75rem;color:var(--text-muted)">\u2026</div></div></div>';
      }
      return (
        '<div class="fb-preview-card ' + (it.correct ? '' : 'bad') + '">' +
          '<div class="fb-preview-top">' +
            '<div><div class="fb-preview-user">' + userLine + '</div><div class="fb-preview-when">' + esc(date) + '</div></div>' +
            '<span class="fb-badge ' + vote + '">' + voteText + '</span>' +
          '</div>' +
          '<div class="fb-preview-src">' + esc(src) + '</div>' +
          '<div class="fb-preview-film">' + film + uz + '</div>' +
          qHtml +
          media +
        '</div>'
      );
    }).join('');
    loadThumbPlaceholders(el);
  }

  function loadThumbPlaceholders(container) {
    if (!container) return;
    container.querySelectorAll('.thumb-load').forEach(function (wrap) {
      var fid = wrap.getAttribute('data-fid');
      if (!fid) return;
      fetch('/api/telegram-file?file_id=' + encodeURIComponent(fid))
        .then(function (r) { return r.ok ? r.blob() : Promise.reject(); })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          wrap.parentNode.innerHTML = '<img src="' + url + '" alt=""/>';
        })
        .catch(function () {
          wrap.parentNode.innerHTML = '<span style="font-size:1.2rem;opacity:.4">?</span>';
        });
    });
  }

  function renderFilmList(films) {
    var el = document.getElementById('filmList');
    if (!el) return;
    if (!films || films.length === 0) {
      el.innerHTML = '<div class="panel-note">Hali ma\'lumot yo\'q</div>';
      return;
    }
    var maxHits = Math.max.apply(null, [1].concat(films.map(function (f) { return f.hits; })));
    el.innerHTML = films.map(function (f) {
      var pct   = Math.round((f.hits / maxHits) * 100);
      var title = String(f.title || '—').replace(/</g, '&lt;');
      return (
        '<div class="film-item">' +
          '<div class="film-info">' +
            '<div class="film-title" title="' + title + '">' + title + '</div>' +
            '<div class="film-bar-wrap">' +
              '<div class="film-bar" style="width: ' + pct + '%"></div>' +
            '</div>' +
          '</div>' +
          '<div class="film-hits">' + fmt(f.hits) + '</div>' +
        '</div>'
      );
    }).join('');
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  initManualRefreshBtn();
  fetchStats(); // initial load
})();
