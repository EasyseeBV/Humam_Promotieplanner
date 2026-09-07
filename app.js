/*
 * app.js — Humam Promotieplanner (browser side).
 *
 * No login: the page talks to a small Cloudflare Worker (see worker/) that
 * relays read-only ClickUp calls for the Promotions list with a token that
 * only the worker knows, and that stores the plan in its own database.
 * Nothing about the plan is written to ClickUp.
 */
(function () {
  'use strict';

  var C = window.PlannerCore;
  var LS_SETTINGS = 'clickupPlanner.settings';
  var LS_COLLAPSED = 'clickupPlanner.collapsed';

  var DEFAULT_SETTINGS = {
    listId: '901523821635',        // ClickUp list "Promotions"
    workerUrl: 'https://humam-promotieplanner-auth.humam-promotieplanner-auth.workers.dev',
    workdays: [1, 2, 3],           // Mon, Tue, Wed  (1=Mon .. 7=Sun)
    normScope: 'day',              // 'day' or 'week'
    hoursPerUnit: 7.5,             // capacity per day (or per week)
    minHoursPerUnit: 7,            // must be planned per day (or per week)
    refreshSeconds: 60,            // auto refresh interval
    keepWeeks: 8                   // planning older than this is pruned on save
  };

  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ------------------------------------------------------------------ state --

  var state = {
    settings: loadSettings(),
    listName: '',
    tasks: [],
    plan: {},               // taskId -> { 'YYYY-MM-DD': hours }, as stored by the worker
    monthStart: C.startOfMonth(new Date()),
    loading: false,
    error: null,
    lastUpdated: null,
    editing: null,          // { taskId, date, origDate, hours, isNew }
    filter: '',
    showDone: false,
    collapsed: loadCollapsed(),
    saving: {},
    dragTaskId: null,
    dragFromDate: null      // set when a planned block (not a task row) is being dragged
  };

  var refreshTimer = null;
  var toastTimer = null;

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      out[k] = s[k] !== undefined && s[k] !== null && s[k] !== '' ? s[k] : DEFAULT_SETTINGS[k];
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

  function workerBase() {
    return String(state.settings.workerUrl || '').replace(/\/+$/, '');
  }

  // Call the worker: `path` is e.g. '/api/v2/list/…' (relayed to ClickUp) or '/plan'.
  function api(path, opts) {
    opts = opts || {};
    if (!workerBase()) return Promise.reject(new ApiError('No worker URL configured (see Settings).', 0));
    var headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(workerBase() + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
        if (!res.ok) {
          var msg = (json && (json.err || json.error)) || res.statusText || ('HTTP ' + res.status);
          throw new ApiError('Error ' + res.status + ': ' + msg, res.status);
        }
        return json;
      });
    }, function () {
      throw new ApiError('Could not reach the planner service (offline, or the worker is down).', 0);
    });
  }

  function fetchAllTasks(listId) {
    var all = [];
    function page(n) {
      return api('/api/v2/list/' + encodeURIComponent(listId) + '/task?page=' + n + '&subtasks=true&include_closed=true')
        .then(function (data) {
          var tasks = (data && data.tasks) || [];
          all = all.concat(tasks);
          if (data && data.last_page === false && tasks.length && n < 50) return page(n + 1);
          return all;
        });
    }
    return page(0);
  }

  function fetchPlan() {
    return api('/plan').then(function (data) { return (data && data.tasks) || {}; });
  }

  function normalizeTask(raw, plan) {
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
      planning: Object.assign({}, plan[raw.id] || {})
    };
  }

  function refresh() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    render();
    var s = state.settings;
    var jobs = [
      fetchAllTasks(s.listId),
      fetchPlan(),
      state.listName ? Promise.resolve(null) : api('/api/v2/list/' + encodeURIComponent(s.listId))
    ];
    return Promise.all(jobs).then(function (r) {
      var rawTasks = r[0], plan = r[1], list = r[2];
      state.plan = plan;
      state.tasks = rawTasks.map(function (t) { return normalizeTask(t, plan); });
      if (list && list.name) state.listName = list.name;
      state.lastUpdated = new Date();
      state.error = null;
    }).catch(function (e) {
      state.error = (e && e.message) || String(e);
    }).then(function () {
      state.loading = false;
      render();
    });
  }

  function savePlanning(task, newMap) {
    var cutoff = C.toISODate(C.addDays(C.startOfWeek(new Date()), -7 * (Number(state.settings.keepWeeks) || 8)));
    var pruned = C.prunePlanning(newMap, cutoff);
    var prev = task.planning;
    task.planning = pruned;
    state.plan[task.id] = pruned;
    state.saving[task.id] = true;
    render();
    return api('/plan/' + encodeURIComponent(task.id), { method: 'PUT', body: { planning: pruned } })
      .then(function () {
        toast('Planning saved');
      }).catch(function (e) {
        task.planning = prev;
        state.plan[task.id] = prev;
        toast(e.message || 'Saving failed', 'error');
      }).then(function () {
        delete state.saving[task.id];
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

  function monthWeeks() {
    return C.monthWeeks(state.monthStart, state.settings.workdays);
  }

  function monthPrefix() {
    return C.toISODate(state.monthStart).slice(0, 7); // 'YYYY-MM'
  }

  function monthSummary() {
    return C.monthSummary({
      weeks: monthWeeks(), todayISO: todayISO(), settings: state.settings,
      plannedByDate: C.plannedByDate(state.tasks)
    });
  }

  function fmtDateLong(iso) {
    var d = C.parseISODate(iso);
    if (!d) return iso;
    return DAY_LONG[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtDayCell(iso, inMonth) {
    var d = C.parseISODate(iso);
    if (!d) return iso;
    return DAY_SHORT[d.getDay()] + ' ' + d.getDate() + (inMonth ? '' : ' ' + MONTH_SHORT[d.getMonth()]);
  }

  function fmtMonth(d) {
    return MONTH_LONG[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtTime(d) {
    if (!d) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // Hours a task has planned inside the shown month.
  function plannedInMonth(task) {
    var prefix = monthPrefix(), sum = 0;
    Object.keys(task.planning).forEach(function (d) { if (d.slice(0, 7) === prefix) sum += task.planning[d]; });
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

  // Where a "+ Plan" click lands: the first workday of the shown month that is
  // today or later, otherwise the month's first workday.
  function defaultEditDate() {
    var t = todayISO(), first = null;
    var weeks = monthWeeks();
    for (var i = 0; i < weeks.length; i++) {
      for (var j = 0; j < weeks[i].days.length; j++) {
        var d = weeks[i].days[j];
        if (!d.inMonth) continue;
        if (!first) first = d.date;
        if (d.date >= t) return d.date;
      }
    }
    return first || t;
  }

  function suggestHours(task, date) {
    var monday = C.startOfWeek(C.parseISODate(date) || new Date());
    var summary = C.weekSummary({
      dates: C.weekDates(monday, state.settings.workdays), todayISO: todayISO(), settings: state.settings,
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
    document.title = (state.listName ? state.listName + ' – ' : '') + 'Planner';
    var active = document.activeElement;
    var filterFocus = active && active.id === 'task-filter' ? { start: active.selectionStart, end: active.selectionEnd } : null;
    root.innerHTML =
      renderHeader() +
      renderBanners() +
      '<main class="layout' + (state.settings.workdays.length > 4 ? ' stacked' : '') + '">' +
      renderMonthPanel() + renderTasksPanel() + '</main>';
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
  }

  function renderHeader() {
    return '' +
      '<header class="topbar">' +
      '  <div class="brand">' +
      '    <h1>' + esc(state.listName || 'ClickUp') + ' Planner</h1>' +
      '    <span class="sub">Tasks live from ClickUp · plan stored on this site</span>' +
      '  </div>' +
      '  <div class="actions">' +
      '    <span class="muted small" id="last-updated">' +
      (state.loading ? 'Refreshing…' : (state.lastUpdated ? 'Updated ' + fmtTime(state.lastUpdated) : '')) +
      '    </span>' +
      '    <button class="btn" data-action="refresh" title="Reload from ClickUp"' + (state.loading ? ' disabled' : '') + '>' +
      '      <span class="icon' + (state.loading ? ' spin' : '') + '">&#x21bb;</span> Refresh</button>' +
      '    <button class="btn" data-action="open-settings" title="Settings">&#x2699; Settings</button>' +
      '  </div>' +
      '</header>';
  }

  function renderBanners() {
    var html = '';
    if (state.error) {
      html += '<div class="banner error"><span>' + esc(state.error) + '</span>' +
        '<button class="btn small" data-action="refresh">Retry</button></div>';
    }
    return html;
  }

  function stateBadge(st, extra) {
    if (st === 'past') return 'past';
    if (st === 'ok') return 'OK';
    if (st === 'over') return 'over';
    return extra || 'short';
  }

  function renderMonthPanel() {
    var s = state.settings;
    var summary = monthSummary();
    var scopeDay = s.normScope !== 'week';
    var isCurrent = C.toISODate(C.startOfMonth(new Date())) === C.toISODate(state.monthStart);

    var ruleText = scopeDay
      ? 'Rule: at least ' + C.formatHours(Number(s.minHoursPerUnit)) + ' of ' + C.formatHours(Number(s.hoursPerUnit)) + ' must be planned on every workday.'
      : 'Rule: at least ' + C.formatHours(Number(s.minHoursPerUnit)) + ' of ' + C.formatHours(Number(s.hoursPerUnit)) + ' must be planned in every week.';

    var verdict;
    if (summary.state === 'past') verdict = 'This month is in the past – nothing to check.';
    else if (summary.state === 'ok') verdict = scopeDay
      ? 'All good: every remaining workday this month meets the minimum.'
      : 'All good: every remaining week this month meets the minimum.';
    else if (summary.state === 'short') verdict = scopeDay
      ? summary.shortDays + ' workday' + (summary.shortDays === 1 ? '' : 's') + ' below the minimum.'
      : summary.weeks.filter(function (w) { return w.state === 'short'; }).length + ' week(s) below the minimum (' + C.formatHours(summary.missing) + ' missing).';
    else verdict = 'More hours planned than capacity somewhere – double-check the plan.';

    var pct = summary.capacityRemaining > 0 ? Math.min(100, Math.round(summary.plannedRemaining / summary.capacityRemaining * 100)) : 0;
    var reqPct = summary.capacityRemaining > 0 ? Math.min(100, Math.round(summary.required / summary.capacityRemaining * 100)) : 0;

    var html = '<section class="card week-panel month-panel">';
    html += '<div class="week-nav">' +
      '<button class="btn icon-btn" data-action="prev-month" title="Previous month">&#x2039;</button>' +
      '<div class="week-title"><strong>' + esc(fmtMonth(state.monthStart)) + '</strong></div>' +
      '<button class="btn icon-btn" data-action="next-month" title="Next month">&#x203a;</button>' +
      (isCurrent ? '' : '<button class="btn small" data-action="this-month">This month</button>') +
      '</div>';

    html += '<div class="week-summary state-' + summary.state + '">' +
      '<div class="verdict"><span class="dot"></span>' + esc(verdict) + '</div>' +
      '<div class="meter"><div class="meter-fill" style="width:' + pct + '%"></div>' +
      (summary.state !== 'past' ? '<div class="meter-mark" style="left:' + reqPct + '%" title="minimum"></div>' : '') + '</div>' +
      '<div class="totals">' +
      '<span><strong>' + C.formatHours(summary.plannedRemaining) + '</strong> planned (today onwards)</span>' +
      '<span><strong>' + C.formatHours(summary.required) + '</strong> minimum</span>' +
      '<span><strong>' + C.formatHours(summary.capacityRemaining) + '</strong> capacity</span>' +
      (summary.plannedTotal !== summary.plannedRemaining ? '<span class="muted">' + C.formatHours(summary.plannedTotal) + ' incl. past days</span>' : '') +
      '</div>' +
      '<div class="muted small">' + esc(ruleText) + ' Days before today are never checked.</div>' +
      '</div>';

    var workdays = s.workdays.slice().sort(function (a, b) { return a - b; });
    html += '<div class="month-grid" style="--cols:' + workdays.length + '">';
    html += '<div class="month-head"></div>';
    workdays.forEach(function (wd) { html += '<div class="month-head">' + DAY_SHORT[wd % 7] + '</div>'; });
    if (!workdays.length) html += '<div class="muted">Choose at least one workday in Settings.</div>';
    summary.weeks.forEach(function (w) {
      html += renderWeekCell(w, scopeDay);
      w.days.forEach(function (day) { html += renderDay(day); });
    });
    html += '</div>';
    html += '<p class="muted small hint">Drag a task onto a day, or use <em>Plan</em> on a task. Click a planned block to change its hours or remove it; drag it to another day to move it.</p>';
    html += '</section>';
    return html;
  }

  function renderWeekCell(w, scopeDay) {
    var shortDays = w.days.filter(function (d) { return d.state === 'short'; }).length;
    var badge = w.state === 'past' ? 'past'
      : !scopeDay ? C.formatHours(w.plannedRemaining) + ' planned'
      : stateBadge(w.state, shortDays + ' day' + (shortDays === 1 ? '' : 's') + ' short');
    return '<div class="week-cell state-' + w.state + '">' +
      '<strong>Week ' + w.week.week + '</strong>' +
      '<span class="badge">' + esc(badge) + '</span>' +
      (w.state === 'past' ? '' : '<span class="muted small">' + C.formatHours(w.plannedRemaining) + ' / ' + C.formatHours(w.required) + ' min</span>') +
      '</div>';
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
    var badge = day.past ? 'past'
      : weekScope ? C.formatHours(day.planned)
      : day.state === 'ok' ? 'OK'
      : day.state === 'short' ? C.formatHours(day.missing) + ' short'
      : 'over';

    var html = '<div class="day state-' + day.state + (day.isToday ? ' today' : '') + (day.inMonth === false ? ' other-month' : '') +
      '" data-drop-date="' + esc(day.date) + '">';
    html += '<div class="day-head">' +
      '<div><div class="day-name" title="' + esc(fmtDateLong(day.date)) + '">' + esc(fmtDayCell(day.date, day.inMonth !== false)) + (day.isToday ? ' <span class="pill">today</span>' : '') + '</div>' +
      '<div class="muted small">' + C.formatHours(day.planned) + ' / ' + C.formatHours(day.capacity) + '</div></div>' +
      '<span class="badge">' + esc(badge) + '</span></div>';
    html += '<div class="meter small"><div class="meter-fill" style="width:' + pct + '%"></div></div>';

    html += '<div class="plan-items">';
    var editingHere = state.editing && state.editing.date === day.date;
    if (!items.length && !editingHere) html += '<div class="empty">Nothing planned</div>';
    items.forEach(function (it) {
      var chain = parentChain(it.task);
      if (editingHere && state.editing.taskId === it.task.id && state.editing.origDate === day.date) return; // shown as the form
      html += '<button type="button" class="plan-item' + (state.saving[it.task.id] ? ' saving' : '') + '" draggable="true" ' +
        'data-action="edit-plan" data-task-id="' + esc(it.task.id) + '" data-date="' + esc(day.date) + '" title="Click to change or remove · drag to move">' +
        '<span class="plan-item-name">' + (chain.length ? '<span class="crumb">' + esc(chain.join(' › ')) + ' › </span>' : '') + esc(it.task.name) + '</span>' +
        '<span class="plan-item-hours">' + C.formatHours(it.hours) + '</span></button>';
    });
    if (editingHere) html += renderPlanForm();
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderPlanForm() {
    var e = state.editing;
    var task = taskById(e.taskId);
    if (!task) return '';
    var chain = parentChain(task);
    var left = task.estimateHours != null ? C.roundHours(task.estimateHours - task.spentHours) : null;
    return '' +
      '<form class="plan-form" data-form="plan">' +
      '  <div class="plan-form-task">' + (chain.length ? '<span class="crumb">' + esc(chain.join(' › ')) + ' › </span>' : '') + esc(task.name) + '</div>' +
      '  <div class="muted small">Spent ' + C.formatHours(task.spentHours) + ' · estimate ' + C.formatHours(task.estimateHours) +
      (left != null ? ' · left ' + C.formatHours(left) : '') + '</div>' +
      '  <div class="plan-form-row">' +
      '    <label>Hours on ' + esc(fmtDayCell(e.date, e.date.slice(0, 7) === monthPrefix())) + ' <input name="hours" type="number" step="0.25" min="0" max="24" value="' + esc(e.hours) + '" required></label>' +
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
      '<span class="col-num" title="Time estimate set on the task in ClickUp">Estimate</span>' +
      '<span class="col-num" title="Estimate minus spent">Left</span>' +
      '<span class="col-num" title="Planned in the shown month">Planned</span>' +
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
    if (!state.tasks.length) return '<div class="empty">' + (state.error ? 'Tasks could not be loaded.' : 'No tasks found in this list.') + '</div>';
    var visible = visibleTaskIds();
    var filtering = !!state.filter.trim();
    var roots = C.buildTaskTree(state.tasks);
    var html = '';
    function walk(node, depth) {
      if (!visible[node.id]) return;
      html += renderTaskRow(node, depth);
      if (!filtering && state.collapsed[node.id]) return;
      node.children.forEach(function (c) { walk(c, depth + 1); });
    }
    roots.forEach(function (r) { walk(r, 0); });
    return html || '<div class="empty">No tasks match the filter.</div>';
  }

  function renderTaskRow(t, depth) {
    var hasKids = t.children && t.children.length > 0;
    var collapsed = !!state.collapsed[t.id] && !state.filter.trim();
    var done = C.isDoneTask(t);
    var month = plannedInMonth(t);
    var left = t.estimateHours != null ? C.roundHours(t.estimateHours - t.spentHours) : null;
    var color = (t.status && t.status.color) || '#888';
    var rollupSpent = hasKids && t.rollup.spent !== t.spentHours;
    var rollupEst = hasKids && t.rollup.estimate > 0 && t.rollup.estimate !== (t.estimateHours || 0);
    var linkTitle = 'Open in ClickUp' + (t.assignees.length ? ' · ' + t.assignees.join(', ') : '');
    var estCell = t.estimateHours != null
      ? C.formatHours(t.estimateHours)
      : '<span class="muted" title="No time estimate on this task in ClickUp yet">—</span>';

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
      '  <span class="col-num' + (month > 0 ? ' planned' : '') + '">' + (month > 0 ? C.formatHours(month) : '—') + '</span>' +
      '  <span class="col-actions"><button type="button" class="btn small" data-action="plan" data-task-id="' + esc(t.id) + '">+ Plan</button></span>' +
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
    f.workerUrl.value = s.workerUrl;
    f.querySelectorAll('input[name="workdays"]').forEach(function (cb) { cb.checked = s.workdays.indexOf(Number(cb.value)) !== -1; });
    f.querySelectorAll('input[name="normScope"]').forEach(function (r) { r.checked = r.value === s.normScope; });
    f.hoursPerUnit.value = s.hoursPerUnit;
    f.minHoursPerUnit.value = s.minHoursPerUnit;
    f.refreshSeconds.value = s.refreshSeconds;
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
      workerUrl: form.workerUrl.value.trim() || DEFAULT_SETTINGS.workerUrl,
      workdays: workdays.sort(function (a, b) { return a - b; }),
      normScope: form.querySelector('input[name="normScope"]:checked').value,
      hoursPerUnit: hours,
      minHoursPerUnit: min,
      refreshSeconds: Math.max(15, Number(form.refreshSeconds.value) || DEFAULT_SETTINGS.refreshSeconds),
      keepWeeks: state.settings.keepWeeks
    };
    saveSettings();
    if (listChanged) { state.listName = ''; state.tasks = []; }
    state.editing = null;
    scheduleAutoRefresh();
    refresh();
    return true;
  }

  // ---------------------------------------------------------------- events --

  function startEdit(taskId, date) {
    var task = taskById(taskId);
    if (!task) return;
    if (!date) date = defaultEditDate();
    var isNew = !(task.planning[date] > 0);
    state.editing = {
      taskId: taskId,
      date: date,
      origDate: isNew ? null : date,
      hours: isNew ? suggestHours(task, date) : task.planning[date],
      isNew: isNew
    };
    render();
  }

  function submitPlanForm(form) {
    var e = state.editing;
    if (!e) return;
    var task = taskById(e.taskId);
    var hours = Number(form.hours.value);
    if (!task || !isFinite(hours) || hours < 0) { toast('Enter a valid number of hours.', 'error'); return; }
    var map = Object.assign({}, task.planning);
    if (hours > 0) map[e.date] = C.roundHours(hours); else delete map[e.date];
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
    delete map[e.date];
    savePlanning(task, map);
  }

  // Drag a planned block to another day: its hours move (and merge with hours
  // the task may already have on the target day).
  function movePlan(taskId, fromDate, toDate) {
    var task = taskById(taskId);
    if (!task || fromDate === toDate || !(task.planning[fromDate] > 0)) return;
    var map = Object.assign({}, task.planning);
    var hours = map[fromDate];
    delete map[fromDate];
    map[toDate] = C.roundHours((map[toDate] || 0) + hours);
    state.editing = null;
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
      case 'prev-month': state.monthStart = C.addMonths(state.monthStart, -1); state.editing = null; render(); break;
      case 'next-month': state.monthStart = C.addMonths(state.monthStart, 1); state.editing = null; render(); break;
      case 'this-month': state.monthStart = C.startOfMonth(new Date()); state.editing = null; render(); break;
      case 'plan': startEdit(taskId, null); break;
      case 'edit-plan': startEdit(taskId, btn.getAttribute('data-date')); break;
      case 'cancel-edit': state.editing = null; render(); break;
      case 'remove-plan': removePlan(); break;
      case 'toggle':
        if (state.collapsed[taskId]) delete state.collapsed[taskId]; else state.collapsed[taskId] = true;
        saveCollapsed(); rerenderTaskRows(); break;
      default: break;
    }
  }

  function onSubmit(ev) {
    var form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    var kind = form.getAttribute('data-form');
    if (kind === 'plan') {
      submitPlanForm(form);
    } else if (kind === 'settings') {
      if (applySettings(form)) document.getElementById('settings-dialog').close();
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.id === 'task-filter') { state.filter = t.value; rerenderTaskRows(); }
    else if (t.name === 'hours' && t.closest('.plan-form') && state.editing) state.editing.hours = t.value;
  }

  function onChange(ev) {
    if (ev.target.id === 'show-done') { state.showDone = ev.target.checked; rerenderTaskRows(); }
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape' && state.editing) { state.editing = null; render(); }
  }

  function onDragStart(ev) {
    var block = ev.target.closest('.plan-item[data-task-id]');
    var row = block ? null : ev.target.closest('.task-row[data-task-id]');
    var el = block || row;
    if (!el) { ev.preventDefault(); return; }
    state.dragTaskId = el.getAttribute('data-task-id');
    state.dragFromDate = block ? block.getAttribute('data-date') : null;
    ev.dataTransfer.setData('text/plain', state.dragTaskId);
    ev.dataTransfer.effectAllowed = block ? 'move' : 'copy';
    el.classList.add('dragging');
  }

  function onDragEnd(ev) {
    var el = ev.target.closest && ev.target.closest('.task-row, .plan-item');
    if (el) el.classList.remove('dragging');
    document.querySelectorAll('.day.drop-target').forEach(function (d) { d.classList.remove('drop-target'); });
    state.dragTaskId = null;
    state.dragFromDate = null;
  }

  function onDragOver(ev) {
    var day = ev.target.closest('.day[data-drop-date]');
    if (!day || !state.dragTaskId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = state.dragFromDate ? 'move' : 'copy';
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
    var taskId = state.dragTaskId || ev.dataTransfer.getData('text/plain');
    var fromDate = state.dragFromDate;
    var date = day.getAttribute('data-drop-date');
    state.dragTaskId = null;
    state.dragFromDate = null;
    if (!taskId) return;
    if (fromDate) movePlan(taskId, fromDate, date);
    else startEdit(taskId, date);
  }

  // ----------------------------------------------------------- auto refresh --

  function scheduleAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (document.hidden || state.editing || state.loading) return;
      refresh();
    }, Math.max(15, Number(state.settings.refreshSeconds) || 60) * 1000);
  }

  function onVisibility() {
    if (document.hidden || state.editing) return;
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

    render();
    refresh();
    scheduleAutoRefresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
