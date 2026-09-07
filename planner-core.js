/*
 * planner-core.js — pure helpers shared by the browser app (app.js) and the
 * node tests (test/core.test.js). No DOM, no fetch, no globals besides the
 * UMD export below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PlannerCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MS_PER_HOUR = 3600000;
  var EPS = 1e-9;

  // ---------------------------------------------------------------- dates --
  // All date math is done in the browser's local time on "date only" values
  // (local midnight). Planning is stored as YYYY-MM-DD strings, which sort
  // correctly as plain strings.

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseISODate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Reject impossible dates such as 2026-99-99 (Date would silently roll over).
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  // Monday (local midnight) of the week containing d.
  function startOfWeek(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var offset = (x.getDay() + 6) % 7; // Mon=0 .. Sun=6
    return addDays(x, -offset);
  }

  // ISO-8601 week number: { year, week }.
  function isoWeek(d) {
    var date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dayNum = (date.getDay() + 6) % 7;
    date = addDays(date, 3 - dayNum); // Thursday of this ISO week
    var firstThursday = new Date(date.getFullYear(), 0, 4);
    var diffDays = Math.round((date - firstThursday) / 86400000);
    var week = 1 + Math.round((diffDays - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
    return { year: date.getFullYear(), week: week };
  }

  // ISO dates of the given workdays (1=Mon .. 7=Sun) in the week starting at
  // `monday`, in weekday order.
  function weekDates(monday, workdays) {
    var days = (workdays || []).slice().sort(function (a, b) { return a - b; });
    return days.map(function (wd) { return toISODate(addDays(monday, wd - 1)); });
  }

  // ---------------------------------------------------------- planning text --
  // The plan lives in a ClickUp text custom field per task, in a format that
  // is readable inside ClickUp itself:  "2026-09-08: 2.5h, 2026-09-09: 1h"
  // A legacy JSON object ({"2026-09-08": 2.5}) is accepted when reading.

  function roundHours(h) {
    return Math.round(h * 100) / 100;
  }

  function parsePlanning(text) {
    var map = {};
    var s = String(text == null ? '' : text).trim();
    if (!s) return map;
    if (s.charAt(0) === '{') {
      try {
        var obj = JSON.parse(s);
        Object.keys(obj).forEach(function (k) {
          var v = Number(obj[k]);
          if (parseISODate(k) && isFinite(v) && v > 0) map[k] = roundHours(v);
        });
        return map;
      } catch (e) { /* fall through to the text format */ }
    }
    var re = /(\d{4}-\d{2}-\d{2})\s*[:=]\s*(\d+(?:[.,]\d+)?)\s*h?/gi;
    var m;
    while ((m = re.exec(s)) !== null) {
      var v = Number(m[2].replace(',', '.'));
      if (parseISODate(m[1]) && isFinite(v) && v > 0) map[m[1]] = roundHours(v);
    }
    return map;
  }

  function formatNumber(h) {
    var r = roundHours(h);
    return String(r); // JS drops trailing zeros: 2.5, 7, 0.25
  }

  function formatPlanning(map) {
    return Object.keys(map || {})
      .filter(function (k) { return map[k] > 0; })
      .sort()
      .map(function (k) { return k + ': ' + formatNumber(map[k]) + 'h'; })
      .join(', ');
  }

  // Drop entries strictly before `cutoffISO` (keeps the field short).
  function prunePlanning(map, cutoffISO) {
    var out = {};
    Object.keys(map || {}).forEach(function (k) {
      if (k >= cutoffISO && map[k] > 0) out[k] = map[k];
    });
    return out;
  }

  // ------------------------------------------------------------------- auth --
  // Personal API tokens (pk_...) are sent as-is. OAuth access tokens use the
  // documented "Bearer" form unless the worker found that ClickUp only accepts
  // the bare token for it (scheme === 'plain').

  function authHeader(token, scheme) {
    var t = String(token || '').trim();
    if (!t) return '';
    if (/^pk_/i.test(t) || scheme === 'plain') return t;
    return 'Bearer ' + t;
  }

  // Parse the query string ClickUp redirects back with after "Log in with
  // ClickUp": returns { code, state } or null when there is no code.
  function parseOAuthCallback(search) {
    var s = String(search || '');
    if (s.charAt(0) === '?') s = s.slice(1);
    var out = {};
    s.split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
      var v = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    });
    if (!out.code) return null;
    return { code: out.code, state: out.state || '' };
  }

  // Redirect URI used for OAuth: the page URL without query/hash and without
  // a trailing index.html, so it matches the URL registered in the ClickUp app.
  function oauthRedirectUri(origin, pathname) {
    var p = String(pathname || '/').replace(/index\.html?$/i, '');
    return String(origin || '') + p;
  }

  // ------------------------------------------------------------------ hours --

  function msToHours(ms) {
    return roundHours((Number(ms) || 0) / MS_PER_HOUR);
  }

  function hoursToMs(h) {
    return Math.round((Number(h) || 0) * MS_PER_HOUR);
  }

  function formatHours(h) {
    if (h == null || !isFinite(h)) return '—';
    return formatNumber(h) + 'h';
  }

  // -------------------------------------------------------------- task tree --

  function isDoneTask(task) {
    var t = task && task.status && task.status.type;
    return t === 'done' || t === 'closed';
  }

  // tasks: flat array of normalised tasks {id, parent, orderindex, name,
  // spentHours, estimateHours, ...}. Returns roots; every node gets
  // `children` and `rollup` ({spent, estimate}) including descendants.
  function buildTaskTree(tasks) {
    var byId = {};
    tasks.forEach(function (t) {
      byId[t.id] = t;
      t.children = [];
    });
    var roots = [];
    tasks.forEach(function (t) {
      if (t.parent && byId[t.parent]) byId[t.parent].children.push(t);
      else roots.push(t);
    });
    function sortNodes(list) {
      list.sort(function (a, b) {
        var oa = parseFloat(a.orderindex), ob = parseFloat(b.orderindex);
        if (isFinite(oa) && isFinite(ob) && oa !== ob) return oa - ob;
        return String(a.name).localeCompare(String(b.name));
      });
      list.forEach(function (n) { sortNodes(n.children); });
    }
    sortNodes(roots);
    function rollup(node) {
      var spent = node.spentHours || 0;
      var estimate = node.estimateHours || 0;
      node.children.forEach(function (c) {
        var r = rollup(c);
        spent += r.spent;
        estimate += r.estimate;
      });
      node.rollup = { spent: roundHours(spent), estimate: roundHours(estimate) };
      return node.rollup;
    }
    roots.forEach(rollup);
    return roots;
  }

  // Sum planned hours per date across all tasks: { 'YYYY-MM-DD': hours }.
  function plannedByDate(tasks) {
    var out = {};
    tasks.forEach(function (t) {
      var p = t.planning || {};
      Object.keys(p).forEach(function (k) {
        out[k] = roundHours((out[k] || 0) + p[k]);
      });
    });
    return out;
  }

  // ----------------------------------------------------------------- checks --
  // settings: { normScope: 'day'|'week', hoursPerUnit, minHoursPerUnit }
  //   scope 'day'  -> every remaining workday needs >= minHoursPerUnit planned
  //                   out of hoursPerUnit capacity.
  //   scope 'week' -> the week as a whole needs >= minHoursPerUnit planned out
  //                   of hoursPerUnit capacity; per-day figures are derived.
  // Days before today are never checked ("past"): the check only looks at
  // today and later, and the required hours shrink accordingly.

  function weekSummary(opts) {
    var dates = opts.dates || [];
    var todayISO = opts.todayISO;
    var planned = opts.plannedByDate || {};
    var s = opts.settings || {};
    var scopeDay = s.normScope !== 'week';
    var n = dates.length;
    var hours = Number(s.hoursPerUnit) || 0;
    var min = Number(s.minHoursPerUnit) || 0;

    var dayCapacity = scopeDay ? hours : (n ? hours / n : 0);
    var dayRequired = scopeDay ? min : (n ? min / n : 0);

    var days = dates.map(function (iso) {
      var p = planned[iso] || 0;
      var past = iso < todayISO;
      var state;
      if (past) state = 'past';
      else if (!scopeDay) state = 'ok'; // week scope: days are informational only
      else if (p > dayCapacity + EPS) state = 'over';
      else if (p + EPS >= dayRequired) state = 'ok';
      else state = 'short';
      return {
        date: iso, planned: roundHours(p), capacity: roundHours(dayCapacity),
        required: roundHours(dayRequired), past: past, isToday: iso === todayISO,
        state: state, missing: past ? 0 : roundHours(Math.max(0, dayRequired - p))
      };
    });

    var remaining = days.filter(function (d) { return !d.past; });
    var plannedTotal = 0, plannedRemaining = 0;
    days.forEach(function (d) {
      plannedTotal += d.planned;
      if (!d.past) plannedRemaining += d.planned;
    });
    var capacity = scopeDay ? hours * n : hours;
    var capacityRemaining = scopeDay ? hours * remaining.length : (n ? hours * remaining.length / n : 0);
    var required = scopeDay ? min * remaining.length : (n ? min * remaining.length / n : 0);

    var state;
    if (remaining.length === 0) state = 'past';
    else if (scopeDay) {
      if (remaining.some(function (d) { return d.state === 'short'; })) state = 'short';
      else if (remaining.some(function (d) { return d.state === 'over'; })) state = 'over';
      else state = 'ok';
    } else {
      if (plannedRemaining > capacityRemaining + EPS) state = 'over';
      else if (plannedRemaining + EPS >= required) state = 'ok';
      else state = 'short';
    }

    return {
      scope: scopeDay ? 'day' : 'week',
      days: days,
      plannedTotal: roundHours(plannedTotal),
      plannedRemaining: roundHours(plannedRemaining),
      capacity: roundHours(capacity),
      capacityRemaining: roundHours(capacityRemaining),
      required: roundHours(required),
      missing: roundHours(Math.max(0, required - plannedRemaining)),
      remainingDays: remaining.length,
      state: state
    };
  }

  return {
    MS_PER_HOUR: MS_PER_HOUR,
    toISODate: toISODate,
    parseISODate: parseISODate,
    addDays: addDays,
    startOfWeek: startOfWeek,
    isoWeek: isoWeek,
    weekDates: weekDates,
    parsePlanning: parsePlanning,
    formatPlanning: formatPlanning,
    prunePlanning: prunePlanning,
    authHeader: authHeader,
    parseOAuthCallback: parseOAuthCallback,
    oauthRedirectUri: oauthRedirectUri,
    roundHours: roundHours,
    msToHours: msToHours,
    hoursToMs: hoursToMs,
    formatHours: formatHours,
    formatNumber: formatNumber,
    isDoneTask: isDoneTask,
    buildTaskTree: buildTaskTree,
    plannedByDate: plannedByDate,
    weekSummary: weekSummary
  };
});
