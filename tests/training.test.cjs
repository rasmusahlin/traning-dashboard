const assert = require('node:assert/strict');
const Training = require('../js/training.js');

const run = (date, id, extra = {}) => ({
  id, activity_date: date, activity_type: 'running', distance_meters: 10000,
  duration_seconds: 3000, avg_hr: 150, ...extra
});

assert.equal(Training.localDate('2026-06-01T23:30:00-04:00'), '2026-06-01');
assert.equal(Training.addDays('2026-06-01', 7), '2026-06-08');
assert.equal(Training.monday('2026-06-03'), '2026-06-01');

const timer = Training.paceSeconds({ distance_meters: 10000, moving_time_seconds: 2400, duration_seconds: 2500 });
assert.deepEqual(timer, { seconds: 240, source: 'moving_time_seconds', label: 'timer tid' });
assert.deepEqual(Training.paceSeconds({ distance_meters: 10000, avg_speed_ms: 4 }), { seconds: 250, source: 'avg_speed_ms', label: 'hastighet' });
assert.equal(Training.paceSeconds({ distance_meters: 10000, duration_seconds: 3000 }).source, 'duration_seconds');

const sparse = [run('2026-01-05', 'a'), run('2026-01-19', 'b')];
const weeks = Training.calendarWeeks(sparse, '2026-01-05', '2026-01-25');
assert.deepEqual(weeks.map(w => w.date), ['2026-01-05', '2026-01-12', '2026-01-19']);
assert.equal(weeks.find(w => w.date === '2026-01-12').zero, true);
assert.equal(weeks.find(w => w.date === '2026-01-12').confirmedRest, false);

const covered = [run('2026-01-05', 'a'), run('2026-01-19', 'b')];
covered.coverage = { start: '2026-01-01', through: '2026-01-31', confirmed: true };
const coveredWeeks = Training.calendarWeeks(covered, '2026-01-05', '2026-01-25');
assert.equal(coveredWeeks.find(w => w.date === '2026-01-12').coverage, 'confirmed');
assert.equal(coveredWeeks.find(w => w.date === '2026-01-12').confirmedRest, true);
covered.coverage = { start: '2026-01-14', through: '2026-01-31', confirmed: true };
const partialCoverage = Training.calendarWeeks(covered, '2026-01-05', '2026-01-25');
assert.equal(partialCoverage.find(w => w.date === '2026-01-12').coverage, 'unknown', 'a partial start week is not confirmed');
assert.equal(partialCoverage.find(w => w.date === '2026-01-19').coverage, 'confirmed');

const comparison = Training.comparePeriods(
  [run('2026-02-02', '1'), run('2026-02-09', '2'), run('2026-03-02', '3')],
  '2026-03-15'
);
assert.equal(comparison.current.weeks, 4);
assert.equal(comparison.previous.weeks, 4);
assert.equal(comparison.weeks.length, 8);
assert.ok(comparison.current.unknownWeeks > 0, 'sparse gaps must be visible as unknown coverage');

const profile = {
  today: '2026-01-10',
  hrRest: 60, hrMax: 190,
  activityTags: {
    e1: { kind: 'easy', surface: 'road', route: 'park' }, e2: { kind: 'easy', surface: 'road', route: 'park' },
    e3: { kind: 'easy', surface: 'road', route: 'park' }, e4: { kind: 'easy', surface: 'trail', route: 'hill' },
    race: { kind: 'race', surface: 'road' }
  }
};
const comparable = Training.comparableRuns([
  run('2026-01-01', 'e1', { avg_hr: 145, duration_seconds: 3000 }),
  run('2026-01-03', 'e2', { avg_hr: 146, duration_seconds: 3100 }),
  run('2026-01-05', 'e3', { avg_hr: 144, duration_seconds: 2950 }),
  run('2026-01-07', 'e4', { avg_hr: 145, duration_seconds: 3000 }),
  run('2026-01-09', 'race', { avg_hr: 180, duration_seconds: 2400 })
], profile);
assert.equal(comparable.status, 'ok');
assert.equal(comparable.runs.length, 3, 'largest group matches both HR band and surface');
assert.ok(comparable.runs.every(r => r.surface === 'road'));
assert.ok(comparable.runs.every(r => r.route === 'park'));
assert.equal(comparable.sourcePassLinks[0].href, 'activity.html?id=e1');
assert.equal(comparable.criteria.normalization, 'none; raw pace values retain their source');

const noData = Training.projection([], { distanceKm: 10, targetSeconds: 2400 }, 190, '2026-03-01');
assert.equal(noData.status, 'no_data');
assert.equal(noData.scenarios.length, 0);

const thin = Array.from({ length: 5 }, (_, i) => run(`2026-01-${String(i + 1).padStart(2, '0')}`, `t${i}`, { avg_hr: 145 }));
assert.equal(Training.projection(thin, { distanceKm: 10, targetSeconds: 2400 }, 190, '2026-01-10').status, 'thin');

const forecastRuns = Array.from({ length: 8 }, (_, i) => run(`2026-01-${String(i * 3 + 1).padStart(2, '0')}`, `p${i}`, {
  duration_seconds: 3000 - i * 25, avg_hr: 145, moving_time_seconds: 3000 - i * 25
}));
const forecast = Training.projection(forecastRuns, { distanceKm: 10, targetSeconds: 2400 }, 190, '2026-02-01');
assert.equal(forecast.status, 'ok');
assert.equal(forecast.target.assumedRaceHrFraction, 0.91);
assert.equal(forecast.scenarios.length, 2);
assert.ok(forecast.sensitivity.every(s => s.nRuns >= 6));
assert.match(forecast.limitations, /Hypotetisk/);

const futurePollution = Training.projection([...forecastRuns, run('2026-12-31', 'future', { avg_hr: 145 })], { distanceKm: 10, targetSeconds: 2400 }, 190, '2026-02-01');
assert.equal(futurePollution.observations.some(row => row.id === 'future'), false, 'future activities cannot enter historical projection');
const stale = Training.projection(forecastRuns, { distanceKm: 10, targetSeconds: 2400 }, 190, '2026-04-01');
assert.equal(stale.status, 'stale');

assert.equal(Training.comparableRuns([run('2026-01-01','old',{avg_hr:145})], {...profile,today:'2026-04-01'}).status, 'stale');
assert.equal(Training.comparableRuns([run('2026-01-01','unmarked',{avg_hr:145})], {...profile,activityTags:{unmarked:{kind:'other',surface:'road'}}}).runs.length,1, 'adding a surface to an unmarked run must retain HR-based eligibility');
console.log('training helpers: ok');
