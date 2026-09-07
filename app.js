/*
 * app.js — ClickUp Planner (browser side).
 *
 * Talks directly to the ClickUp v2 API from the browser (the API sends CORS
 * headers), using the visitor's own personal API token stored in
 * localStorage. Planning is stored per task in a text custom field so it is
 * shared with everyone who opens the page and visible inside ClickUp.
 */
(function () {
  'use strict';

  var C = window.PlannerCore;
  var API = 'https://api.clickup.com/api/v2';
  var LS_TOKEN = 'clickupPlanner.token';
  var LS_SETTINGS = 'clickupPlanner.settings';
  var LS_COLLAPSED = 'clickupPlanner.collapsed';

  var DEFAULT_SETTINGS = {
    listId: '901523821635',        // ClickUp list "Promotions"
    planningFieldName: 'Planning', // text custom field on that list
    workdays: [1, 2, 3],           // Mon, Tue, Wed  (1=Mon .. 7=Sun)
    normScope: 'day',              // 'day' or 'week'
    hoursPerUnit: 7.5,             // capacity per day (or per week)
    minHoursPerUnit: 7,            // must be planned per day (or per week)
    refreshSeconds: 60,            // auto refresh interval
    keepWeeks: 8,                  // planning older than this is pruned on save
    // "Log in with ClickUp" (OAuth). The client id is public. Exchanging the
    // login code for a token needs the client secret, so that step runs in a
    // tiny Cloudflare Worker (see worker/). Leave the URL empty to offer
    // personal-token login only.
    oauthClientId: '277AWTMT2UOVUFVED8DPY21W4HT4JQR5',
    oauthExchangeUrl: ''
  };
  var LS_OAUTH_STATE = 'clickupPlanner.oauthState';

  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ------------------------------------------------------------------ state --

  var state = {
    token: localStorage.getItem(LS_TOKEN) || '',
    user: null,
    settings: loadSettings(),
    listName: '',
    tasks: [],
    fieldId: null,
    fieldChecked: false,
    weekMonday: C.startOfWeek(new Date()),
    loading: false,
    error: null,
    lastUpdated: null,
    editing: null,          // { taskId, date, hours, isNew }
    estimateEditing: null,  // taskId
    filter: '',
    showDone: false,
    collapsed: loadCollapsed(),
    saving: {},
    dragTaskId: null,
    oauthBusy: false        // true while the ClickUp login code is being exchanged
  };

  var refreshTimer = null;
  var toastTimer = null;

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      out[k] = s[k] !== undefined && s[k] !== null ? s[k] : DEFAULT_SETTINGS[k];
      if (out[k] === '' && DEFAULT_SETTINGS[k] !== '') out[k] = DEFAULT_SETTINGS[k];
    });
    if (!Array.isArray(out.workdays) || !out.workdays.length) out.workdays = DEFAULT_SETTINGS.workdays.slice();
    return out;
  }

  function saveSettings() {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
  }

  function loadCollapsed() {
    try { return JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveCollapsed() {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(state.collapsed));
  }

  // -------------------------------------------------------------------- api --

  function ApiError(message, status) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: C.authHeader(state.token) };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 401) throw new ApiError('ClickUp rejected the API token (401). Sign in again with a valid token.', 401);
      return res.text().then(function (text) {
        var json = null;
        if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
        if (!res.ok) {
          var msg = (json && (json.err || json.error)) || res.statusText || ('HTTP ' + res.status);
          throw new ApiError('ClickUp API error ' + res.status + ': ' + msg, res.status);
        }
        return json;
      });
    }, function () {
      throw new ApiError('Could not reach the ClickUp API (network error or offline).', 0);
    });
  }

  function fetchAllTasks(listId) {
    var all = [];
    function page(n) {
      return api('/list/' + encodeURIComponent(listId) + '/task?page=' + n + '&subtasks=true&include_closed=true')
        .then(function (data) {
          var tasks = (data && data.tasks) || [];
          all = all.concat(tasks);
          if (data && data.last_page === false && tasks.length && n < 50) return page(n + 1);
          return all;
        });
    }
    return page(0);
  }

  function fetchPlanningField(listId, name) {
    return api('/list/' + encodeURIComponent(listId) + '/field').then(function (data) {
      var wanted = String(name || '').trim().toLowerCase();
      var fields = (data && data.fields) || [];
      var match = null;
      fields.forEach(function (f) {
        if (match) return;
        var fname = String(f.name || '').trim().toLowerCase();
        if (fname === wanted && /text/i.test(f.type || '')) match = f;
      });
      return match;
    });
  }

  function normalizeTask(raw, fieldId) {
    var cf = null;
    (raw.custom_fields || []).forEach(function (f) { if (fieldId && f.id === fieldId) cf = f; });
    var est = raw.time_estimate;
    return {
      id: raw.id,
      name: raw.name || '(untitled)',
      parent: raw.parent || null,
      orderindex: raw.orderindex,
      status: raw.status || {},
      url: raw.url || ('https://app.clickup.com/t/' + raw.id),
      spentHours: C.msToHours(raw.time_spent || 0),
      estimateHours: est != null && Number(est) > 0 ? C.msToHours(est) : null,
      assignees: (raw.assignees || []).map(function (a) { return a.username || a.email || ''; }),
      planning: C.parsePlanning(cf ? cf.value : '')
    };
  }

  function refresh() {
    if (!state.token || state.loading) return Promise.resolve();
    state.loading = true;
    render();
    var s = state.settings;
    var jobs = [
      fetchPlanningField(s.listId, s.planningFieldName),
      fetchAllTasks(s.listId),
      state.listName ? Promise.resolve(null) : api('/list/' + encodeURIComponent(s.listId)),
      state.user ? Promise.resolve(null) : api('/user')
    ];
    return Promise.all(jobs).then(function (r) {
      var field = r[0], rawTasks = r[1], list = r[2], user = r[3];
      state.fieldId = field ? field.id : null;
      state.fieldChecked = true;
      state.tasks = rawTasks.map(function (t) { return normalizeTask(t, state.fieldId); });
      if (list && list.name) state.listName = list.name;
      if (user && user.user) state.user = user.user.username || user.user.email || '';
      state.lastUpdated = new Date();
      state.error = null;
    }).catch(function (e) {
      if (e && e.status === 401) {
        signOut();
        state.error = e.message;
      } else {
        state.error = (e && e.message) || String(e);
      }
    }).then(function () {
      state.loading = false;
      render();
    });
  }

  function savePlanning(task, newMap) {
    if (!state.fieldId) {
      toast('Cannot save: the "' + state.settings.planningFieldName + '" text field does not exist on this list yet.', 'error');
      return Promise.resolve();
    }
    var cutoff = C.toISODate(C.addDays(C.startOfWeek(new Date()), -7 * (Number(state.settings.keepWeeks) || 8)));
    var pruned = C.prunePlanning(newMap, cutoff);
    var text = C.formatPlanning(pruned);
    var prev = task.planning;
    task.planning = pruned;
    state.saving[task.id] = true;
    render();
    var path = '/task/' + encodeURIComponent(task.id) + '/field/' + encodeURIComponent(state.fieldId);
    var req = text ? api(path, { method: 'POST', body: { value: text } }) : api(path, { method: 'DELETE' });
    return req.then(function () {
      toast('Planning saved');
    }).catch(function (e) {
      task.planning = prev;
      toast(e.message || 'Saving failed', 'error');
    }).then(function () {
      delete state.saving[task.id];
      render();
    });
  }

  function saveEstimate(task, hours) {
    var prev = task.estimateHours;
    task.estimateHours = hours > 0 ? C.roundHours(hours) : null;
    state.saving[task.id] = true;
    render();
    return api('/task/' + encodeURIComponent(task.id), {
      method: 'PUT',
      body: { time_estimate: hours > 0 ? C.hoursToMs(hours) : null }
    }).then(function () {
      toast('Estimate saved');
    }).catch(function (e) {
      task.estimateHours = prev;
      toast(e.message || 'Saving failed', 'error');
    }).then(function () {
      delete state.saving[task.id];
      render();
    });
  }

  function signOut() {
    state.token = '';
    state.user = null;
    state.tasks = [];
    state.fieldId = null;
    state.fieldChecked = false;
    state.lastUpdated = null;
    state.editing = null;
    state.estimateEditing = null;
    localStorage.removeItem(LS_TOKEN);
  }

  // ------------------------------------------------------------------ oauth --
  // Flow: startOAuth() sends the browser to ClickUp; ClickUp redirects back to
  // this page with ?code=…&state=…; finishOAuth() posts the code to the
  // exchange URL (Cloudflare Worker holding the client secret) and stores the
  // returned access token exactly like a personal token.

  function randomState() {
    var arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return Array.prototype.map.call(arr, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function oauthConfigured() {
    return !!(state.settings.oauthClientId && state.settings.oauthExchangeUrl);
  }

  function startOAuth() {
    if (!oauthConfigured()) { toast('ClickUp login is not configured (see Settings).', 'error'); return; }
    var st = randomState();
    try { sessionStorage.setItem(LS_OAUTH_STATE, st); } catch (e) { /* ignore */ }
    var redirect = C.oauthRedirectUri(location.origin, location.pathname);
    location.href = 'https://app.clickup.com/api?client_id=' + encodeURIComponent(state.settings.oauthClientId) +
      '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + encodeURIComponent(st);
  }

  function finishOAuth(cb) {
    var expected = '';
    try { expected = sessionStorage.getItem(LS_OAUTH_STATE) || ''; sessionStorage.removeItem(LS_OAUTH_STATE); } catch (e) { /* ignore */ }
    // Drop ?code=… from the address bar right away so a reload does not retry a used code.
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    if (!state.settings.oauthExchangeUrl) {
      state.error = 'Received a ClickUp login code, but no token exchange URL is configured.';
      render();
      return Promise.resolve();
    }
    if (expected && cb.state !== expected) {
      state.error = 'ClickUp login could not be verified (state mismatch). Please try again.';
      render();
      return Promise.resolve();
    }
    state.oauthBusy = true;
    state.error = null;
    render();
    return fetch(state.settings.oauthExchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cb.code, redirect_uri: C.oauthRedirectUri(location.origin, location.pathname) })
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (!res.ok || !json || !json.access_token) {
          throw new Error((json && json.error) || ('token exchange failed, HTTP ' + res.status));
        }
        return json.access_token;
      });
    }, function () {
      throw new Error('could not reach the token exchange service');
    }).then(function (token) {
      state.token = token;
      localStorage.setItem(LS_TOKEN, token);
      state.oauthBusy = false;
      render();
      scheduleAutoRefresh();
      return refresh();
    }).catch(function (e) {
      state.oauthBusy = false;
      state.error = 'ClickUp login failed: ' + (e && e.message ? e.message : e);
      render();
    });
  }

  // -------------------------------------------------------------- helpers --

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function taskById(id) {
    for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i];
    return null;
  }

  function todayISO() {
    return C.toISODate(new Date());
  }

  function currentWeekDates() {
    return C.weekDates(state.weekMonday, state.settings.workdays);
  }

  function fmtDateLong(iso) {
    var d = C.parseISODate(iso);
    if (!d) return iso;
    return DAY_LONG[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()];
  }

  function fmtDateShort(iso) {
    var d = C.parseISODate(iso);
    if (!d) return iso;
    return DAY_SHORT[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()];
  }

  function fmtRange(dates) {
    if (!dates.length) return 'no workdays configured';
    var a = C.parseISODate(dates[0]), b = C.parseISODate(dates[dates.length - 1]);
    var sameMonth = a.getMonth() === b.getMonth();
    return a.getDate() + (sameMonth ? '' : ' ' + MONTH_SHORT[a.getMonth()]) + ' – ' +
      b.getDate() + ' ' + MONTH_SHORT[b.getMonth()] + ' ' + b.getFullYear();
  }

  function fmtTime(d) {
    if (!d) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function plannedInWeek(task, dates) {
    var sum = 0;
    dates.forEach(function (d) { sum += task.planning[d] || 0; });
    return C.roundHours(sum);
  }

  function plannedFuture(task) {
    var t = todayISO(), sum = 0;
    Object.keys(task.planning).forEach(function (d) { if (d >= t) sum += task.planning[d]; });
    return C.roundHours(sum);
  }

  function parentChain(task) {
    var names = [], cur = task, guard = 0;
    while (cur && cur.parent && guard++ < 10) {
      cur = taskById(cur.parent);
      if (cur) names.unshift(cur.name);
    }
    return names;
  }

  function stateLabel(st) {
    return { ok: 'OK', short: 'Not enough planned', over: 'Over capacity', past: 'Past – not checked' }[st] || st;
  }

  function defaultEditDate(dates) {
    var t = todayISO();
    for (var i = 0; i < dates.length; i++) if (dates[i] >= t) return dates[i];
    return dates.length ? dates[0] : t;
  }

  function suggestHours(task, date) {
    var dates = currentWeekDates();
    var summary = C.weekSummary({
      dates: dates, todayISO: todayISO(), settings: state.settings,
      plannedByDate: C.plannedByDate(state.tasks)
    });
    var day = null;
    summary.days.forEach(function (d) { if (d.date === date) day = d; });
    var free = day ? Math.max(0, day.capacity - day.planned) : 1;
    var left = task.estimateHours != null ? Math.max(0, task.estimateHours - task.spentHours - plannedFuture(task)) : Infinity;
    var h = Math.min(free, left);
    if (!isFinite(h) || h <= 0) h = free > 0 ? free : 1;
    return Math.max(0.25, Math.round(h * 4) / 4);
  }

  // ------------------------------------------------------------- rendering --

  function render() {
    var root = document.getElementById('app');
    if (!state.token || state.oauthBusy) {
      root.innerHTML = renderTokenScreen();
      document.title = 'ClickUp Planner';
      return;
    }
    document.title = (state.listName ? state.listName + ' – ' : '') + 'ClickUp Planner';
    var active = document.activeElement;
    var filterFocus = active && active.id === 'task-filter' ? { start: active.selectionStart, end: active.selectionEnd } : null;
    root.innerHTML =
      renderHeader() +
      renderBanners() +
      '<main class="layout">' + renderWeekPanel() + renderTasksPanel() + '</main>';
    afterRender(filterFocus);
  }

  function afterRender(filterFocus) {
    if (filterFocus) {
      var f = document.getElementById('task-filter');
      if (f) { f.focus(); try { f.setSelectionRange(filterFocus.start, filterFocus.end); } catch (e) { /* ignore */ } }
      return;
    }
    var hours = document.querySelector('.plan-form input[name="hours"]');
    if (hours && document.activeElement !== hours) { hours.focus(); hours.select(); }
    var est = document.querySelector('.estimate-form input[name="hours"]');
    if (est && document.activeElement !== est) { est.focus(); est.select(); }
  }

  function renderTokenScreen() {
    if (state.oauthBusy) {
      return '' +
        '<div class="token-screen"><div class="card token-card">' +
        '  <h1>ClickUp Planner</h1>' +
        '  <p><span class="icon spin">&#x21bb;</span> Signing in with ClickUp…</p>' +
        '</div></div>';
    }
    var oauth = oauthConfigured();
    return '' +
      '<div class="token-screen">' +
      '  <div class="card token-card">' +
      '    <h1>ClickUp Planner</h1>' +
      '    <p>This page reads tasks straight from ClickUp and stores the weekly plan in a ' +
      '       ClickUp custom field. Your login is kept in this browser only.</p>' +
      (state.error ? '<div class="banner error">' + esc(state.error) + '</div>' : '') +
      (oauth
        ? '<button type="button" class="btn primary block" data-action="oauth-login">Log in with ClickUp</button>' +
          '<div class="or-divider"><span>or use a personal API token</span></div>'
        : '') +
      '    <form class="token-form" data-form="token">' +
      '      <label class="field"><span>Personal API token</span>' +
      '        <input name="token" type="password" autocomplete="off" placeholder="pk_…" required></label>' +
      '      <button type="submit" class="btn' + (oauth ? '' : ' primary') + '">Sign in with token</button>' +
      '    </form>' +
      '    <p class="muted small">Get a token in ClickUp: avatar → <em>Settings</em> → <em>Apps</em> → <em>API Token</em> ' +
      '       (<a href="https://app.clickup.com/settings/apps" target="_blank" rel="noopener">app.clickup.com/settings/apps</a>).</p>' +
      '  </div>' +
      '</div>';
  }

  function renderHeader() {
    return '' +
      '<header class="topbar">' +
      '  <div class="brand">' +
      '    <h1>' + esc(state.listName || 'ClickUp') + ' Planner</h1>' +
      '    <span class="sub">' + (state.user ? 'Signed in as ' + esc(state.user) : 'ClickUp planning') + '</span>' +
      '  </div>' +
      '  <div class="actions">' +
      '    <span class="muted small" id="last-updated">' +
      (state.loading ? 'Refreshing…' : (state.lastUpdated ? 'Updated ' + fmtTime(state.lastUpdated) : '')) +
      '    </span>' +
      '    <button class="btn" data-action="refresh" title="Reload from ClickUp"' + (state.loading ? ' disabled' : '') + '>' +
      '      <span class="icon' + (state.loading ? ' spin' : '') + '">&#x21bb;</span> Refresh</button>' +
      '    <button class="btn" data-action="open-settings" title="Settings">&#x2699; Settings</button>' +
      '    <button class="btn subtle" data-action="sign-out" title="Forget the token in this browser">Sign out</button>' +
      '  </div>' +
      '</header>';
  }

  function renderBanners() {
    var html = '';
    if (state.error) {
      html += '<div class="banner error"><span>' + esc(state.error) + '</span>' +
        '<button class="btn small" data-action="refresh">Retry</button></div>';
    }
    if (state.fieldChecked && !state.fieldId) {
      html += '<div class="banner warn"><span><strong>Planning cannot be saved yet.</strong> ' +
        'The list has no text custom field named <code>' + esc(state.settings.planningFieldName) + '</code>. ' +
        'In ClickUp open the list, click <em>+</em> at the end of the column headers → <em>Text</em>, name it <code>' +
        esc(state.settings.planningFieldName) + '</code>, then press Refresh here.</span></div>';
    }
    return html;
  }

  function renderWeekPanel() {
    var dates = currentWeekDates();
    var wk = C.isoWeek(state.weekMonday);
    var isCurrent = C.toISODate(C.startOfWeek(new Date())) === C.toISODate(state.weekMonday);
    var summary = C.weekSummary({
      dates: dates, todayISO: todayISO(), settings: state.settings,
      plannedByDate: C.plannedByDate(state.tasks)
    });
    var s = state.settings;
    var scopeDay = summary.scope === 'day';

    var ruleText = scopeDay
      ? 'Rule: at least ' + C.formatHours(Number(s.minHoursPerUnit)) + ' of ' + C.formatHours(Number(s.hoursPerUnit)) + ' must be planned on every workday.'
      : 'Rule: at least ' + C.formatHours(Number(s.minHoursPerUnit)) + ' of ' + C.formatHours(Number(s.hoursPerUnit)) + ' must be planned for the week.';

    var verdict;
    if (summary.state === 'past') verdict = 'This week is in the past – nothing to check.';
    else if (summary.state === 'ok') verdict = 'All good: the remaining ' + summary.remainingDays + ' workday' + (summary.remainingDays === 1 ? '' : 's') + ' meet the minimum.';
    else if (summary.state === 'short') verdict = (scopeDay
      ? summary.days.filter(function (d) { return d.state === 'short'; }).length + ' workday(s) below the minimum.'
      : C.formatHours(summary.missing) + ' still to plan this week.');
    else verdict = 'More hours planned than capacity – double-check the plan.';

    var pct = summary.capacityRemaining > 0 ? Math.min(100, Math.round(summary.plannedRemaining / summary.capacityRemaining * 100)) : 0;
    var reqPct = summary.capacityRemaining > 0 ? Math.min(100, Math.round(summary.required / summary.capacityRemaining * 100)) : 0;

    var html = '<section class="card week-panel">';
    html += '<div class="week-nav">' +
      '<button class="btn icon-btn" data-action="prev-week" title="Previous week">&#x2039;</button>' +
      '<div class="week-title"><strong>Week ' + wk.week + '</strong> <span class="muted">' + esc(fmtRange(dates)) + '</span></div>' +
      '<button class="btn icon-btn" data-action="next-week" title="Next week">&#x203a;</button>' +
      (isCurrent ? '' : '<button class="btn small" data-action="this-week">This week</button>') +
      '</div>';

    html += '<div class="week-summary state-' + summary.state + '">' +
      '<div class="verdict"><span class="dot"></span>' + esc(verdict) + '</div>' +
      '<div class="meter"><div class="meter-fill" style="width:' + pct + '%"></div>' +
      (summary.state !== 'past' ? '<div class="meter-mark" style="left:' + reqPct + '%" title="minimum"></div>' : '') + '</div>' +
      '<div class="totals">' +
      '<span><strong>' + C.formatHours(summary.plannedRemaining) + '</strong> planned' + (summary.remainingDays < dates.length ? ' (today onwards)' : '') + '</span>' +
      '<span><strong>' + C.formatHours(summary.required) + '</strong> minimum</span>' +
      '<span><strong>' + C.formatHours(summary.capacityRemaining) + '</strong> capacity</span>' +
      (summary.plannedTotal !== summary.plannedRemaining ? '<span class="muted">' + C.formatHours(summary.plannedTotal) + ' incl. past days</span>' : '') +
      '</div>' +
      '<div class="muted small">' + esc(ruleText) + ' Days before today are never checked.</div>' +
      '</div>';

    html += '<div class="days">';
    if (!dates.length) html += '<div class="muted">Choose at least one workday in Settings.</div>';
    summary.days.forEach(function (day) { html += renderDay(day); });
    html += '</div>';
    html += '<p class="muted small hint">Drag a task onto a day, or use <em>Plan</em> on a task. Click a planned block to change or remove it.</p>';
    html += '</section>';
    return html;
  }

  function renderDay(day) {
    var items = [];
    state.tasks.forEach(function (t) {
      var h = t.planning[day.date];
      if (h > 0) items.push({ task: t, hours: h });
    });
    items.sort(function (a, b) { return b.hours - a.hours || a.task.name.localeCompare(b.task.name); });

    var pct = day.capacity > 0 ? Math.min(100, Math.round(day.planned / day.capacity * 100)) : 0;
    var weekScope = state.settings.normScope === 'week';
    var badge = day.past ? 'not checked'
      : weekScope ? C.formatHours(day.planned) + ' planned'
      : day.state === 'ok' ? 'OK'
      : day.state === 'short' ? C.formatHours(day.missing) + ' short'
      : 'over';

    var html = '<div class="day state-' + day.state + (day.isToday ? ' today' : '') + '" data-drop-date="' + esc(day.date) + '">';
    html += '<div class="day-head">' +
      '<div><div class="day-name" title="' + esc(fmtDateLong(day.date)) + '">' + esc(fmtDateShort(day.date)) + (day.isToday ? ' <span class="pill">today</span>' : '') + '</div>' +
      '<div class="muted small">' + C.formatHours(day.planned) + ' / ' + C.formatHours(day.capacity) +
      (state.settings.normScope !== 'week' && !day.past ? ' · min ' + C.formatHours(day.required) : '') + '</div></div>' +
      '<span class="badge">' + esc(badge) + '</span></div>';
    html += '<div class="meter small"><div class="meter-fill" style="width:' + pct + '%"></div></div>';

    html += '<div class="plan-items">';
    if (!items.length && !(state.editing && state.editing.date === day.date)) {
      html += '<div class="empty">Nothing planned</div>';
    }
    items.forEach(function (it) {
      var chain = parentChain(it.task);
      var isEditing = state.editing && state.editing.taskId === it.task.id && state.editing.origDate === day.date;
      if (isEditing) return; // the block being edited is shown as the form instead
      html += '<button type="button" class="plan-item' + (state.saving[it.task.id] ? ' saving' : '') + '" data-action="edit-plan" data-task-id="' + esc(it.task.id) + '" data-date="' + esc(day.date) + '" title="Change or remove">' +
        '<span class="plan-item-name">' + (chain.length ? '<span class="crumb">' + esc(chain.join(' › ')) + ' › </span>' : '') + esc(it.task.name) + '</span>' +
        '<span class="plan-item-hours">' + C.formatHours(it.hours) + '</span></button>';
    });
    if (state.editing && state.editing.date === day.date) html += renderPlanForm();
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderPlanForm() {
    var e = state.editing;
    var task = taskById(e.taskId);
    if (!task) return '';
    var dates = currentWeekDates();
    var chain = parentChain(task);
    var left = task.estimateHours != null ? C.roundHours(task.estimateHours - task.spentHours) : null;
    var options = dates.map(function (d) {
      return '<option value="' + esc(d) + '"' + (d === e.date ? ' selected' : '') + '>' + esc(fmtDateShort(d)) + (d < todayISO() ? ' (past)' : '') + '</option>';
    }).join('');
    return '' +
      '<form class="plan-form" data-form="plan">' +
      '  <div class="plan-form-task">' + (chain.length ? '<span class="crumb">' + esc(chain.join(' › ')) + ' › </span>' : '') + esc(task.name) + '</div>' +
      '  <div class="muted small">Spent ' + C.formatHours(task.spentHours) + ' · estimate ' + C.formatHours(task.estimateHours) +
      (left != null ? ' · left ' + C.formatHours(left) : '') + '</div>' +
      '  <div class="plan-form-row">' +
      '    <label>Day <select name="date">' + options + '</select></label>' +
      '    <label>Hours <input name="hours" type="number" step="0.25" min="0" max="24" value="' + esc(e.hours) + '" required></label>' +
      '  </div>' +
      '  <div class="plan-form-actions">' +
      '    <button type="submit" class="btn primary small">Save</button>' +
      '    <button type="button" class="btn small" data-action="cancel-edit">Cancel</button>' +
      (e.isNew ? '' : '<button type="button" class="btn small danger" data-action="remove-plan">Remove</button>') +
      '  </div>' +
      '</form>';
  }

  function renderTasksPanel() {
    var html = '<section class="card tasks-panel">';
    html += '<div class="tasks-toolbar">' +
      '<h2>Tasks <span class="muted small">(' + state.tasks.length + ')</span></h2>' +
      '<input id="task-filter" type="search" placeholder="Filter tasks…" value="' + esc(state.filter) + '">' +
      '<label class="check"><input type="checkbox" id="show-done"' + (state.showDone ? ' checked' : '') + '> show completed</label>' +
      '</div>';
    html += '<div class="task-table">' +
      '<div class="task-row head">' +
      '<span class="col-name">Task</span><span class="col-status">Status</span>' +
      '<span class="col-num" title="Time tracked on this task in ClickUp">Spent</span>' +
      '<span class="col-num" title="Time estimate in ClickUp – click to edit">Estimate</span>' +
      '<span class="col-num" title="Estimate minus spent">Left</span>' +
      '<span class="col-num" title="Planned in the selected week">This week</span>' +
      '<span class="col-actions"></span></div>' +
      '<div id="task-rows">' + renderTaskRows() + '</div></div>';
    html += '</section>';
    return html;
  }

  function visibleTaskIds() {
    var filter = state.filter.trim().toLowerCase();
    var byId = {};
    state.tasks.forEach(function (t) { byId[t.id] = t; });
    var visible = {};
    state.tasks.forEach(function (t) {
      if (!state.showDone) {
        var cur = t, hidden = false, guard = 0;
        while (cur && guard++ < 10) { if (C.isDoneTask(cur)) { hidden = true; break; } cur = cur.parent ? byId[cur.parent] : null; }
        if (hidden) return;
      }
      if (filter && t.name.toLowerCase().indexOf(filter) === -1) return;
      visible[t.id] = true;
      var p = t.parent, g = 0;
      while (p && byId[p] && g++ < 10) { visible[p] = true; p = byId[p].parent; }
    });
    return visible;
  }

  function renderTaskRows() {
    if (state.loading && !state.tasks.length) return '<div class="empty">Loading tasks from ClickUp…</div>';
    if (!state.tasks.length) return '<div class="empty">No tasks found in this list.</div>';
    var dates = currentWeekDates();
    var visible = visibleTaskIds();
    var filtering = !!state.filter.trim();
    var roots = C.buildTaskTree(state.tasks);
    var html = '';
    function walk(node, depth) {
      if (!visible[node.id]) return;
      html += renderTaskRow(node, depth, dates);
      if (!filtering && state.collapsed[node.id]) return;
      node.children.forEach(function (c) { walk(c, depth + 1); });
    }
    roots.forEach(function (r) { walk(r, 0); });
    return html || '<div class="empty">No tasks match the filter.</div>';
  }

  function renderTaskRow(t, depth, dates) {
    var hasKids = t.children && t.children.length > 0;
    var collapsed = !!state.collapsed[t.id] && !state.filter.trim();
    var done = C.isDoneTask(t);
    var week = plannedInWeek(t, dates);
    var left = t.estimateHours != null ? C.roundHours(t.estimateHours - t.spentHours) : null;
    var color = (t.status && t.status.color) || '#888';
    var rollupSpent = hasKids && t.rollup.spent !== t.spentHours;
    var rollupEst = hasKids && t.rollup.estimate > 0 && t.rollup.estimate !== (t.estimateHours || 0);
    var linkTitle = 'Open in ClickUp' + (t.assignees.length ? ' · ' + t.assignees.join(', ') : '');

    var estCell;
    if (state.estimateEditing === t.id) {
      estCell = '<form class="estimate-form" data-form="estimate" data-task-id="' + esc(t.id) + '">' +
        '<input name="hours" type="number" step="0.25" min="0" max="999" value="' + esc(t.estimateHours != null ? t.estimateHours : '') + '" placeholder="h"></form>';
    } else {
      estCell = '<button type="button" class="linkish" data-action="edit-estimate" data-task-id="' + esc(t.id) + '" title="Set the time estimate in ClickUp">' +
        (t.estimateHours != null ? C.formatHours(t.estimateHours) : '<span class="muted">set…</span>') + '</button>';
    }

    return '' +
      '<div class="task-row depth-' + Math.min(depth, 4) + (done ? ' done' : '') + (state.saving[t.id] ? ' saving' : '') + '" draggable="true" data-task-id="' + esc(t.id) + '">' +
      '  <span class="col-name">' +
      (hasKids ? '<button type="button" class="toggle" data-action="toggle" data-task-id="' + esc(t.id) + '" title="' + (collapsed ? 'Expand' : 'Collapse') + '">' + (collapsed ? '&#x25B8;' : '&#x25BE;') + '</button>' : '<span class="toggle-spacer"></span>') +
      '    <a href="' + esc(t.url) + '" target="_blank" rel="noopener" title="' + esc(linkTitle) + '">' + esc(t.name) + '</a>' +
      '  </span>' +
      '  <span class="col-status"><span class="status" style="--c:' + esc(color) + '">' + esc((t.status && t.status.status) || '') + '</span></span>' +
      '  <span class="col-num">' + C.formatHours(t.spentHours) + (rollupSpent ? '<span class="rollup" title="Including subtasks">Σ ' + C.formatHours(t.rollup.spent) + '</span>' : '') + '</span>' +
      '  <span class="col-num">' + estCell + (rollupEst ? '<span class="rollup" title="Including subtasks">Σ ' + C.formatHours(t.rollup.estimate) + '</span>' : '') + '</span>' +
      '  <span class="col-num' + (left != null && left < 0 ? ' negative' : '') + '">' + (left != null ? C.formatHours(left) : '—') + '</span>' +
      '  <span class="col-num' + (week > 0 ? ' planned' : '') + '">' + (week > 0 ? C.formatHours(week) : '—') + '</span>' +
      '  <span class="col-actions"><button type="button" class="btn small" data-action="plan" data-task-id="' + esc(t.id) + '"' + (state.fieldId ? '' : ' disabled title="Create the Planning field first"') + '>+ Plan</button></span>' +
      '</div>';
  }

  function rerenderTaskRows() {
    var el = document.getElementById('task-rows');
    if (el) el.innerHTML = renderTaskRows();
  }

  // ----------------------------------------------------------------- toast --

  function toast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast ' + (kind || 'info');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, kind === 'error' ? 6000 : 2500);
  }

  // -------------------------------------------------------------- settings --

  function openSettings() {
    var dlg = document.getElementById('settings-dialog');
    var f = dlg.querySelector('form');
    var s = state.settings;
    f.listId.value = s.listId;
    f.planningFieldName.value = s.planningFieldName;
    f.querySelectorAll('input[name="workdays"]').forEach(function (cb) { cb.checked = s.workdays.indexOf(Number(cb.value)) !== -1; });
    f.querySelectorAll('input[name="normScope"]').forEach(function (r) { r.checked = r.value === s.normScope; });
    f.hoursPerUnit.value = s.hoursPerUnit;
    f.minHoursPerUnit.value = s.minHoursPerUnit;
    f.refreshSeconds.value = s.refreshSeconds;
    f.oauthClientId.value = s.oauthClientId || '';
    f.oauthExchangeUrl.value = s.oauthExchangeUrl || '';
    dlg.showModal();
  }

  function applySettings(form) {
    var workdays = [];
    form.querySelectorAll('input[name="workdays"]:checked').forEach(function (cb) { workdays.push(Number(cb.value)); });
    if (!workdays.length) { toast('Choose at least one workday.', 'error'); return false; }
    var hours = Number(form.hoursPerUnit.value), min = Number(form.minHoursPerUnit.value);
    if (!(hours > 0) || !(min >= 0) || min > hours) { toast('Minimum must be between 0 and the capacity.', 'error'); return false; }
    var listChanged = form.listId.value.trim() !== state.settings.listId;
    state.settings = {
      listId: form.listId.value.trim() || DEFAULT_SETTINGS.listId,
      planningFieldName: form.planningFieldName.value.trim() || DEFAULT_SETTINGS.planningFieldName,
      workdays: workdays.sort(function (a, b) { return a - b; }),
      normScope: form.querySelector('input[name="normScope"]:checked').value,
      hoursPerUnit: hours,
      minHoursPerUnit: min,
      refreshSeconds: Math.max(15, Number(form.refreshSeconds.value) || DEFAULT_SETTINGS.refreshSeconds),
      keepWeeks: state.settings.keepWeeks,
      oauthClientId: form.oauthClientId.value.trim() || DEFAULT_SETTINGS.oauthClientId,
      oauthExchangeUrl: form.oauthExchangeUrl.value.trim()
    };
    saveSettings();
    if (listChanged) { state.listName = ''; state.tasks = []; }
    state.editing = null;
    scheduleAutoRefresh();
    refresh();
    return true;
  }

  // ---------------------------------------------------------------- events --

  function startEdit(taskId, date, existingHours) {
    var task = taskById(taskId);
    if (!task) return;
    var dates = currentWeekDates();
    if (!date) date = defaultEditDate(dates);
    var isNew = !(task.planning[date] > 0);
    state.editing = {
      taskId: taskId,
      date: date,               // day currently selected in the form
      origDate: isNew ? null : date, // day the existing block came from
      hours: existingHours != null ? existingHours : (isNew ? suggestHours(task, date) : task.planning[date]),
      isNew: isNew
    };
    state.estimateEditing = null;
    render();
  }

  function submitPlanForm(form) {
    var e = state.editing;
    if (!e) return;
    var task = taskById(e.taskId);
    var date = form.date.value;
    var hours = Number(form.hours.value);
    if (!task || !C.parseISODate(date) || !isFinite(hours) || hours < 0) { toast('Enter a valid number of hours.', 'error'); return; }
    var map = Object.assign({}, task.planning);
    if (e.origDate && e.origDate !== date) delete map[e.origDate]; // moved to another day
    if (hours > 0) map[date] = C.roundHours(hours); else delete map[date];
    state.editing = null;
    savePlanning(task, map);
  }

  function removePlan() {
    var e = state.editing;
    if (!e) return;
    var task = taskById(e.taskId);
    state.editing = null;
    if (!task) { render(); return; }
    var map = Object.assign({}, task.planning);
    delete map[e.origDate || e.date];
    savePlanning(task, map);
  }

  function onClick(ev) {
    var btn = ev.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var taskId = btn.getAttribute('data-task-id');
    switch (action) {
      case 'refresh': refresh(); break;
      case 'open-settings': openSettings(); break;
      case 'sign-out': signOut(); state.error = null; render(); break;
      case 'oauth-login': startOAuth(); break;
      case 'prev-week': state.weekMonday = C.addDays(state.weekMonday, -7); state.editing = null; render(); break;
      case 'next-week': state.weekMonday = C.addDays(state.weekMonday, 7); state.editing = null; render(); break;
      case 'this-week': state.weekMonday = C.startOfWeek(new Date()); state.editing = null; render(); break;
      case 'plan': startEdit(taskId, null); break;
      case 'edit-plan': startEdit(taskId, btn.getAttribute('data-date')); break;
      case 'cancel-edit': state.editing = null; render(); break;
      case 'remove-plan': removePlan(); break;
      case 'toggle':
        if (state.collapsed[taskId]) delete state.collapsed[taskId]; else state.collapsed[taskId] = true;
        saveCollapsed(); rerenderTaskRows(); break;
      case 'edit-estimate': state.estimateEditing = taskId; state.editing = null; render(); break;
      default: break;
    }
  }

  function onSubmit(ev) {
    var form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    var kind = form.getAttribute('data-form');
    if (kind === 'token') {
      var token = form.token.value.trim();
      if (!token) return;
      state.token = token;
      localStorage.setItem(LS_TOKEN, token);
      state.error = null;
      render();
      refresh();
      scheduleAutoRefresh();
    } else if (kind === 'plan') {
      submitPlanForm(form);
    } else if (kind === 'estimate') {
      var task = taskById(form.getAttribute('data-task-id'));
      var val = form.hours.value.trim();
      state.estimateEditing = null;
      if (!task) { render(); return; }
      if (val === '') { render(); return; }
      var hours = Number(val);
      if (!isFinite(hours) || hours < 0) { toast('Enter a valid number of hours.', 'error'); render(); return; }
      if (hours === (task.estimateHours || 0)) { render(); return; }
      saveEstimate(task, hours);
    } else if (kind === 'settings') {
      if (applySettings(form)) document.getElementById('settings-dialog').close();
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.id === 'task-filter') { state.filter = t.value; rerenderTaskRows(); }
    else if (t.name === 'hours' && t.closest('.plan-form') && state.editing) state.editing.hours = t.value;
    else if (t.name === 'date' && t.closest('.plan-form') && state.editing) {
      // Move the inline form to the chosen day column.
      var hours = state.editing.hours;
      state.editing.date = t.value;
      state.editing.hours = hours;
      render();
    }
  }

  function onChange(ev) {
    if (ev.target.id === 'show-done') { state.showDone = ev.target.checked; rerenderTaskRows(); }
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      if (state.editing || state.estimateEditing) { state.editing = null; state.estimateEditing = null; render(); }
    }
  }

  function onFocusOut(ev) {
    var form = ev.target.closest && ev.target.closest('.estimate-form');
    if (form && state.estimateEditing) {
      // Commit on blur (same as pressing Enter).
      setTimeout(function () {
        if (state.estimateEditing && document.activeElement !== form.hours) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }, 0);
    }
  }

  function onDragStart(ev) {
    var row = ev.target.closest('.task-row[data-task-id]');
    if (!row || !state.fieldId) { ev.preventDefault(); return; }
    state.dragTaskId = row.getAttribute('data-task-id');
    ev.dataTransfer.setData('text/plain', state.dragTaskId);
    ev.dataTransfer.effectAllowed = 'copy';
    row.classList.add('dragging');
  }

  function onDragEnd(ev) {
    var row = ev.target.closest && ev.target.closest('.task-row');
    if (row) row.classList.remove('dragging');
    document.querySelectorAll('.day.drop-target').forEach(function (d) { d.classList.remove('drop-target'); });
    state.dragTaskId = null;
  }

  function onDragOver(ev) {
    var day = ev.target.closest('.day[data-drop-date]');
    if (!day || !state.dragTaskId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    document.querySelectorAll('.day.drop-target').forEach(function (d) { if (d !== day) d.classList.remove('drop-target'); });
    day.classList.add('drop-target');
  }

  function onDragLeave(ev) {
    var day = ev.target.closest && ev.target.closest('.day[data-drop-date]');
    if (day && !day.contains(ev.relatedTarget)) day.classList.remove('drop-target');
  }

  function onDrop(ev) {
    var day = ev.target.closest('.day[data-drop-date]');
    if (!day) return;
    ev.preventDefault();
    var taskId = ev.dataTransfer.getData('text/plain') || state.dragTaskId;
    var date = day.getAttribute('data-drop-date');
    state.dragTaskId = null;
    if (taskId) startEdit(taskId, date);
  }

  // ----------------------------------------------------------- auto refresh --

  function scheduleAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (!state.token || document.hidden || state.editing || state.estimateEditing || state.loading) return;
      refresh();
    }, Math.max(15, Number(state.settings.refreshSeconds) || 60) * 1000);
  }

  function onVisibility() {
    if (document.hidden || !state.token || state.editing || state.estimateEditing) return;
    var stale = !state.lastUpdated || (Date.now() - state.lastUpdated.getTime()) > 30000;
    if (stale) refresh();
  }

  // ------------------------------------------------------------------ init --

  function init() {
    var root = document.getElementById('app');
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);

    var dlg = document.getElementById('settings-dialog');
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('click', function (ev) {
      if (ev.target.getAttribute('data-action') === 'close-settings') dlg.close();
    });

    // Coming back from "Log in with ClickUp"? Exchange the code first.
    var cb = C.parseOAuthCallback(location.search);
    if (cb) { finishOAuth(cb); return; }

    render();
    if (state.token) {
      refresh();
      scheduleAutoRefresh();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
