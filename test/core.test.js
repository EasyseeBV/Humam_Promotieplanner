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

test('monthWeeks lists the Mon-based weeks touching the month, flagging days outside it', () => {
  const weeks = C.monthWeeks(new Date(2026, 8, 15), [1, 2, 3]); // September 2026
  assert.deepEqual(weeks.map(w => w.week.week), [36, 37, 38, 39, 40]);
  assert.equal(weeks[0].monday, '2026-08-31');
  assert.deepEqual(weeks[0].days, [
    { date: '2026-08-31', inMonth: false },
    { date: '2026-09-01', inMonth: true },
    { date: '2026-09-02', inMonth: true },
  ]);
  assert.deepEqual(weeks[4].days.map(d => d.date), ['2026-09-28', '2026-09-29', '2026-09-30']);
  // A week whose configured workdays all fall outside the month is skipped:
  const onlyWed = C.monthWeeks(new Date(2026, 9, 1), [3]); // October 2026, Wednesdays only
  assert.deepEqual(onlyWed.map(w => w.days[0].date), ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28']);
  assert.equal(C.toISODate(C.startOfMonth(new Date(2026, 8, 15))), '2026-09-01');
  assert.equal(C.toISODate(C.addMonths(new Date(2026, 11, 15), 1)), '2027-01-01');
});

test('monthSummary aggregates the week checks and ignores weeks that are over', () => {
  const weeks = C.monthWeeks(new Date(2026, 8, 1), [1, 2, 3]);
  const settings = { normScope: 'day', hoursPerUnit: 7.5, minHoursPerUnit: 7 };
  // Today is Tue 15 Sep: week 36 and 37 are in the past, week 38 partly.
  const s = C.monthSummary({
    weeks, todayISO: '2026-09-15', settings,
    plannedByDate: { '2026-09-15': 7, '2026-09-16': 7, '2026-09-21': 7, '2026-09-22': 7, '2026-09-23': 7.5, '2026-09-28': 7, '2026-09-29': 7, '2026-09-30': 6 },
  });
  assert.deepEqual(s.weeks.map(w => w.state), ['past', 'past', 'ok', 'ok', 'short']);
  assert.equal(s.state, 'short');
  assert.equal(s.remainingWeeks, 3);
  assert.equal(s.shortDays, 1);
  assert.equal(s.required, 7 * 8);          // 8 remaining workdays
  assert.equal(s.capacityRemaining, 7.5 * 8);
  assert.equal(s.plannedRemaining, 55.5);
  assert.equal(s.missing, 0.5);
  assert.equal(s.weeks[0].days[0].inMonth, false); // 31 Aug carried through
  const done = C.monthSummary({ weeks, todayISO: '2026-10-05', settings, plannedByDate: {} });
  assert.equal(done.state, 'past');
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
