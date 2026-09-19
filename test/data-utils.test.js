const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../js/data-utils.js');

test('manual activity validation accepts supported formats and normalizes units', () => {
  assert.deepEqual(data.normalizeManualActivity({
    activityDate: '2026-08-11',
    activityType: 'running',
    distanceKm: '10,25',
    duration: '45:30',
    avgHr: '150',
    maxHr: '175',
    avgCadence: '170',
    elevationGain: '80',
    notes: 'Lugnt pass'
  }), {
    activity_date: '2026-08-11',
    activity_type: 'running',
    distance_meters: 10250,
    duration_seconds: 2730,
    avg_hr: 150,
    max_hr: 175,
    avg_cadence: 170,
    elevation_gain_meters: 80,
    notes: 'Lugnt pass'
  });
});

test('manual activity validation rejects malformed and implausible values', () => {
  assert.throws(() => data.parseDuration('12:99'), /0–59/);
  assert.throws(() => data.normalizeManualActivity({ activityDate:'2026-02-30', activityType:'running' }), /giltigt datum/);
  assert.throws(() => data.normalizeManualActivity({ activityDate:'2026-08-11', activityType:'cycling' }), /aktivitetstyp/);
  assert.throws(() => data.normalizeManualActivity({ activityDate:'2026-08-11', activityType:'running', distanceKm:-1 }), /Distans/);
  assert.throws(() => data.normalizeManualActivity({ activityDate:'2026-08-11', activityType:'running', avgHr:180, maxHr:170 }), /Snittpulsen/);
});

test('plan merge keeps the newest valid value and preserves unsynced local logs', () => {
  const merged = data.mergePlanLogs({
    day_1: { status:'completed', updatedAt:'2026-08-11T10:00:00Z' },
    day_2: { status:'scaled_down', updatedAt:'2026-08-11T12:00:00Z' }
  }, {
    day_1: { status:'skipped', updatedAt:'2026-08-11T11:00:00Z' }
  }, ['day_1', 'day_2']);
  assert.equal(merged.day_1.status, 'skipped');
  assert.equal(merged.day_2.status, 'scaled_down');
});

test('HR zones prefer time-series data and report coverage', () => {
  const zones = [
    { num:1, name:'Z1', min:0, max:140, color:'#1' },
    { num:2, name:'Z2', min:140, max:160, color:'#2' },
    { num:3, name:'Z3', min:160, max:Infinity, color:'#3' }
  ];
  const result = data.buildHrZones(
    { avg_hr:150, duration_seconds:120 },
    [{ avg_hr:170, duration_seconds:120 }],
    [],
    [{ t:0, hr:145 }, { t:60, hr:165 }, { t:120, hr:165 }],
    zones
  );
  assert.equal(result.source, 'time_series');
  assert.equal(result.confidence, 'high');
  assert.equal(result.coveragePercent, 100);
  assert.equal(result.buckets[1].seconds, 60);
  assert.equal(result.buckets[2].seconds, 60);
});

test('date trend uses elapsed time and reports explanatory strength', () => {
  const result = data.summarizeDateTrend([
    { date:'2026-01-01', value:1.00 },
    { date:'2026-01-31', value:1.10 },
    { date:'2026-03-02', value:1.20 }
  ]);
  assert.deepEqual(result, { count:3, spanDays:60, slopePer30Days:0.1, rSquared:1 });
});

test('theoretical target date extrapolates the same date-based trend', () => {
  const result = data.estimateDateTarget([
    { date:'2026-01-01', value:1.00 },
    { date:'2026-01-31', value:1.10 },
    { date:'2026-03-02', value:1.20 }
  ], 1.30);
  assert.deepEqual(result, { status:'projected', targetDate:'2026-04-01', daysAfterLast:30 });
  assert.equal(data.estimateDateTarget([
    { date:'2026-01-01', value:1.2 },
    { date:'2026-02-01', value:1.1 }
  ], 1.3).status, 'no_upward_trend');
});

test('analysis filters anchor periods to the latest activity and isolate comparable distances', () => {
  const runs = [
    { activity_date:'2024-01-01', distance_meters:10000 },
    { activity_date:'2025-06-01', distance_meters:3000 },
    { activity_date:'2026-01-01', distance_meters:8000 }
  ];
  assert.deepEqual(
    data.filterAnalysisRuns(runs, { periodDays:365, comparison:'all' }).map(run => run.activity_date),
    ['2025-06-01', '2026-01-01']
  );
  assert.deepEqual(
    data.filterAnalysisRuns(runs, { comparison:'5to15km' }).map(run => run.activity_date),
    ['2024-01-01', '2026-01-01']
  );
});

test('analysis coverage and sub-40 evidence describe available data without inventing context', () => {
  const runs = [
    { activity_date:'2026-01-01', distance_meters:6000, duration_seconds:1800, avg_hr:145, elevation_gain_meters:40 },
    { activity_date:'2026-01-08', distance_meters:8000, duration_seconds:2320, avg_hr:null, elevation_gain_meters:null },
    { activity_date:'2026-02-20', distance_meters:10000, duration_seconds:2700, avg_hr:150, elevation_gain_meters:80 }
  ];
  assert.deepEqual(data.summarizeAnalysisCoverage(runs, runs), {
    runCount:3, comparisonCount:3, startDate:'2026-01-01', endDate:'2026-02-20',
    hrCount:2, hrPercent:67, elevationPercent:67
  });
  const evidence = data.summarizeRunEvidence(runs);
  assert.equal(evidence.activeWeeks, 3);
  assert.equal(evidence.averageWeeklyKm, 3);
  assert.equal(evidence.recentBestPace, 270);
  assert.equal(evidence.recentBestDate, '2026-02-20');
});

test('target stability reports a leave-one-pass-out sensitivity range', () => {
  const points = Array.from({ length:12 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index * 14)).toISOString().slice(0, 10),
    value: 1 + index * 0.01
  }));
  const stability = data.estimateTargetStability(points, 1.2);
  assert.equal(stability.status, 'range');
  assert.equal(stability.validEstimates, 12);
  assert.ok(stability.earliestDate <= stability.latestDate);
  assert.deepEqual(data.dateTrendValues(points).slice(0, 2), [1, 1.01]);
});
