// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../planner-core.js');

test('toISODate / parseISODate round-trip (local dates)', () => {
  const d = new Date(2026, 8, 7); // 7 Sep 2026
  assert.equal(C.toISODate(d), '2026-09-07');
  assert.deepEqual(C.parseISODate('2026-09-07'), d);
  assert.equal(C.parseISODate('nonsense'), null);
  assert.equal(C.parseISODate('2026-99-99'), null);
});

test('startOfWeek returns the Monday, also across a month/year boundary', () => {
  assert.equal(C.toISODate(C.startOfWeek(new Date(2026, 8, 7))), '2026-09-07'); // Monday
  assert.equal(C.toISODate(C.startOfWeek(new Date(2026, 8, 9))), '2026-09-07'); // Wednesday
  assert.equal(C.toISODate(C.startOfWeek(new Date(2026, 8, 13))), '2026-09-07'); // Sunday
  assert.equal(C.toISODate(C.startOfWeek(new Date(2027, 0, 1))), '2026-12-28'); // Fri 1 Jan 2027
});

test('isoWeek matches the ISO-8601 calendar', () => {
  assert.deepEqual(C.isoWeek(new Date(2026, 8, 7)), { year: 2026, week: 37 });
  assert.deepEqual(C.isoWeek(new Date(2027, 0, 1)), { year: 2026, week: 53 });
  assert.deepEqual(C.isoWeek(new Date(2026, 0, 1)), { year: 2026, week: 1 });
  assert.deepEqual(C.isoWeek(new Date(2024, 11, 30)), { year: 2025, week: 1 });
});

test('weekDates lists the configured workdays of that week in order', () => {
  const monday = new Date(2026, 8, 7);
  assert.deepEqual(C.weekDates(monday, [1, 2, 3]), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepEqual(C.weekDates(monday, [3, 1]), ['2026-09-07', '2026-09-09']);
  assert.deepEqual(C.weekDates(monday, []), []);
});

test('parsePlanning reads the text format, tolerates commas/spaces, ignores junk', () => {
  assert.deepEqual(C.parsePlanning('2026-09-08: 2.5h, 2026-09-09: 1h'), { '2026-09-08': 2.5, '2026-09-09': 1 });
  assert.deepEqual(C.parsePlanning('2026-09-08=1,5 ; 2026-09-09 : 0.25'), { '2026-09-08': 1.5, '2026-09-09': 0.25 });
  assert.deepEqual(C.parsePlanning('2026-09-08: 0h, hello 2026-99-99: 2h'), {});
  assert.deepEqual(C.parsePlanning(''), {});
  assert.deepEqual(C.parsePlanning(null), {});
});

test('parsePlanning also accepts the legacy JSON object format', () => {
  assert.deepEqual(C.parsePlanning('{"2026-09-08": 2.5, "2026-09-09": "1"}'), { '2026-09-08': 2.5, '2026-09-09': 1 });
});

test('formatPlanning sorts by date, drops zero entries and round-trips', () => {
  const text = C.formatPlanning({ '2026-09-09': 1, '2026-09-08': 2.5, '2026-09-10': 0 });
  assert.equal(text, '2026-09-08: 2.5h, 2026-09-09: 1h');
  assert.deepEqual(C.parsePlanning(text), { '2026-09-08': 2.5, '2026-09-09': 1 });
  assert.equal(C.formatPlanning({}), '');
});

test('prunePlanning drops dates before the cutoff', () => {
  const pruned = C.prunePlanning({ '2026-07-01': 3, '2026-09-08': 2 }, '2026-08-01');
  assert.deepEqual(pruned, { '2026-09-08': 2 });
});

test('hour conversions', () => {
  assert.equal(C.msToHours(97620000), 27.12);
  assert.equal(C.hoursToMs(2.5), 9000000);
  assert.equal(C.formatHours(7.5), '7.5h');
  assert.equal(C.formatHours(7), '7h');
  assert.equal(C.formatHours(null), '—');
});

test('authHeader: personal tokens as-is, OAuth tokens as Bearer', () => {
  assert.equal(C.authHeader('pk_123_ABC'), 'pk_123_ABC');
  assert.equal(C.authHeader('  pk_123  '), 'pk_123');
  assert.equal(C.authHeader('a1b2c3oauth'), 'Bearer a1b2c3oauth');
  assert.equal(C.authHeader(''), '');
  assert.equal(C.authHeader(null), '');
});

test('parseOAuthCallback reads code and state from the redirect query', () => {
  assert.deepEqual(C.parseOAuthCallback('?code=ABC123&state=xyz'), { code: 'ABC123', state: 'xyz' });
  assert.deepEqual(C.parseOAuthCallback('code=ABC%2B1'), { code: 'ABC+1', state: '' });
  assert.equal(C.parseOAuthCallback('?state=only'), null);
  assert.equal(C.parseOAuthCallback(''), null);
});

test('oauthRedirectUri drops a trailing index.html so it matches the registered URL', () => {
  assert.equal(C.oauthRedirectUri('https://easyseebv.github.io', '/Humam_Promotieplanner/'), 'https://easyseebv.github.io/Humam_Promotieplanner/');
  assert.equal(C.oauthRedirectUri('https://easyseebv.github.io', '/Humam_Promotieplanner/index.html'), 'https://easyseebv.github.io/Humam_Promotieplanner/');
  assert.equal(C.oauthRedirectUri('http://localhost:8765', '/index.html'), 'http://localhost:8765/');
});

test('buildTaskTree nests subtasks, sorts by orderindex and rolls up hours', () => {
  const tasks = [
    { id: 'p', parent: null, orderindex: '2', name: 'Parent', spentHours: 1, estimateHours: 0 },
    { id: 'c2', parent: 'p', orderindex: '5', name: 'Child B', spentHours: 2, estimateHours: 4 },
    { id: 'c1', parent: 'p', orderindex: '1', name: 'Child A', spentHours: 0.5, estimateHours: 1 },
    { id: 'orphan', parent: 'missing', orderindex: '1', name: 'Orphan', spentHours: 0, estimateHours: 0 },
  ];
  const roots = C.buildTaskTree(tasks);
  assert.deepEqual(roots.map(r => r.id), ['orphan', 'p']);
  assert.deepEqual(roots[1].children.map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(roots[1].rollup, { spent: 3.5, estimate: 5 });
});

test('isDoneTask looks at the status type', () => {
  assert.equal(C.isDoneTask({ status: { type: 'done' } }), true);
  assert.equal(C.isDoneTask({ status: { type: 'closed' } }), true);
  assert.equal(C.isDoneTask({ status: { type: 'custom' } }), false);
  assert.equal(C.isDoneTask({}), false);
});

test('plannedByDate sums planning across tasks', () => {
  const tasks = [
    { planning: { '2026-09-08': 2.5, '2026-09-09': 1 } },
    { planning: { '2026-09-08': 4.5 } },
    { planning: {} },
  ];
  assert.deepEqual(C.plannedByDate(tasks), { '2026-09-08': 7, '2026-09-09': 1 });
});

const DAY = { normScope: 'day', hoursPerUnit: 7.5, minHoursPerUnit: 7 };
const WEEK = { normScope: 'week', hoursPerUnit: 7.5, minHoursPerUnit: 7 };
const DATES = ['2026-09-07', '2026-09-08', '2026-09-09'];

test('day scope: every remaining day needs its own minimum', () => {
  const s = C.weekSummary({
    dates: DATES, todayISO: '2026-09-07', settings: DAY,
    plannedByDate: { '2026-09-07': 7, '2026-09-08': 6.5, '2026-09-09': 7.5 },
  });
  assert.equal(s.state, 'short');
  assert.deepEqual(s.days.map(d => d.state), ['ok', 'short', 'ok']);
  assert.equal(s.days[1].missing, 0.5);
  assert.equal(s.capacity, 22.5);
  assert.equal(s.required, 21);
  assert.equal(s.plannedTotal, 21);
  assert.equal(s.missing, 0);
});

test('day scope: past days are not checked and shrink the requirement', () => {
  const s = C.weekSummary({
    dates: DATES, todayISO: '2026-09-09', settings: DAY,
    plannedByDate: { '2026-09-07': 0, '2026-09-08': 1, '2026-09-09': 7 },
  });
  assert.equal(s.state, 'ok');
  assert.deepEqual(s.days.map(d => d.state), ['past', 'past', 'ok']);
  assert.equal(s.remainingDays, 1);
  assert.equal(s.required, 7);
  assert.equal(s.capacityRemaining, 7.5);
  assert.equal(s.plannedRemaining, 7);
  assert.equal(s.plannedTotal, 8);
});

test('day scope: over capacity is flagged, but short wins over over', () => {
  const over = C.weekSummary({
    dates: DATES, todayISO: '2026-09-07', settings: DAY,
    plannedByDate: { '2026-09-07': 8, '2026-09-08': 7, '2026-09-09': 7 },
  });
  assert.equal(over.state, 'over');
  const mixed = C.weekSummary({
    dates: DATES, todayISO: '2026-09-07', settings: DAY,
    plannedByDate: { '2026-09-07': 8, '2026-09-08': 1, '2026-09-09': 7 },
  });
  assert.equal(mixed.state, 'short');
});

test('a week entirely in the past is "past"', () => {
  const s = C.weekSummary({ dates: DATES, todayISO: '2026-09-14', settings: DAY, plannedByDate: {} });
  assert.equal(s.state, 'past');
  assert.equal(s.required, 0);
});

test('week scope: the week total is checked, days are informational', () => {
  const s = C.weekSummary({
    dates: DATES, todayISO: '2026-09-07', settings: WEEK,
    plannedByDate: { '2026-09-07': 4, '2026-09-08': 0, '2026-09-09': 3 },
  });
  assert.equal(s.state, 'ok');
  assert.equal(s.capacity, 7.5);
  assert.equal(s.required, 7);
  assert.equal(s.days[0].capacity, 2.5);
  assert.deepEqual(s.days.map(d => d.state), ['ok', 'ok', 'ok']); // never flagged per day
  const short = C.weekSummary({
    dates: DATES, todayISO: '2026-09-07', settings: WEEK,
    plannedByDate: { '2026-09-07': 4 },
  });
  assert.equal(short.state, 'short');
  assert.equal(short.missing, 3);
});

test('week scope: requirement scales with the remaining days', () => {
  const s = C.weekSummary({
    dates: DATES, todayISO: '2026-09-09', settings: WEEK,
    plannedByDate: { '2026-09-07': 4, '2026-09-09': 2.5 },
  });
  assert.equal(s.remainingDays, 1);
  assert.equal(s.required, 2.33);
  assert.equal(s.capacityRemaining, 2.5);
  assert.equal(s.state, 'ok');
});
