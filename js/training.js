/* Shared, dependency-free training analysis helpers.
 * Browser global: Training. CommonJS: require('./training.js').
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Training = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const MIN_RUNS = 6;
  const MS_PER_KM = 1000;

  function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function localDate(value) {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return '';
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof value === 'number') return localDate(new Date(value));
    const raw = String(value || '');
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? '' : localDate(date);
  }

  function dateObject(iso) {
    const date = new Date(`${iso}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addDays(iso, days) {
    const date = dateObject(localDate(iso));
    if (!date) return '';
    date.setDate(date.getDate() + Number(days || 0));
    return localDate(date);
  }

  function monday(iso) {
    const date = dateObject(localDate(iso));
    if (!date) return '';
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return localDate(date);
  }

  function activityDistanceKm(activity) {
    const meters = finite(activity && (activity.distance_meters ?? activity.distanceMeters));
    return meters && meters > 0 ? meters / MS_PER_KM : null;
  }

  /**
   * Return pace and provenance. `seconds` is seconds/km.
   * Source order is timer/moving time, speed-derived time, then elapsed time.
   */
  function paceSeconds(activity) {
    const a = activity || {};
    const km = activityDistanceKm(a);
    if (!km) return { seconds: null, source: 'none', label: 'saknar distans' };
    const moving = finite(a.moving_time_seconds);
    if (moving && moving > 0) return { seconds: moving / km, source: 'moving_time_seconds', label: 'timer tid' };
    const speed = finite(a.avg_speed_ms);
    if (speed && speed > 0) return { seconds: MS_PER_KM / speed, source: 'avg_speed_ms', label: 'hastighet' };
    const elapsed = finite(a.duration_seconds);
    if (elapsed && elapsed > 0) return { seconds: elapsed / km, source: 'duration_seconds', label: 'förfluten tid' };
    return { seconds: null, source: 'none', label: 'saknar tid' };
  }

  function sortedActivities(activities) {
    return (Array.isArray(activities) ? activities : [])
      .filter(a => localDate(a && a.activity_date))
      .slice()
      .sort((a, b) => {
        const byDate = localDate(a.activity_date).localeCompare(localDate(b.activity_date));
        if (byDate) return byDate;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
  }

  function isRunning(activity) {
    const type = String(activity && (activity.activity_type || activity.sport_raw) || '').toLowerCase();
    return type === 'running' || type.includes('run') || type.includes('löp');
  }

  function resolveRange(activities, from, to) {
    const sorted = sortedActivities(activities);
    const first = localDate(from) || localDate(sorted[0] && sorted[0].activity_date);
    const last = localDate(to) || localDate(sorted[sorted.length - 1] && sorted[sorted.length - 1].activity_date);
    return { from: first, to: last };
  }

  function coverageMeta(activities) {
    const source = activities && (activities.coverage || activities.meta || activities.__coverage);
    if (source && typeof source === 'object') {
      return {
        start: localDate(source.start || source.coverageStart),
        through: localDate(source.through || source.coverageThrough),
        confirmed: source.confirmed !== false
      };
    }
    return {
      start: localDate(activities && activities.coverageStart),
      through: localDate(activities && activities.coverageThrough),
      confirmed: true
    };
  }

  /**
   * Return every intersecting Monday–Sunday week in the requested range,
   * including zero weeks. Attach `activities.coverage = { start, through,
   * confirmed }` when a continuous import range is known; otherwise zero
   * weeks remain `unknown` and `confirmedRest` is false.
   */
  function calendarWeeks(activities, from, to) {
    const list = sortedActivities(activities);
    const range = resolveRange(list, from, to);
    if (!range.from || !range.to || range.from > range.to) return [];
    const firstMonday = monday(range.from);
    const lastMonday = monday(range.to);
    const meta = coverageMeta(activities);
    const knownStart = meta.start;
    const knownThrough = meta.through;
    const weeks = [];
    for (let date = firstMonday; date <= lastMonday; date = addDays(date, 7)) {
      const endDate = addDays(date, 6);
      const inRange = list.filter(a => {
        const day = localDate(a.activity_date);
        return day >= date && day <= endDate && day >= range.from && day <= range.to;
      });
      let km = 0;
      let minutes = 0;
      let runs = 0;
      inRange.forEach(a => {
        if (!isRunning(a)) return;
        const dist = activityDistanceKm(a);
        if (dist) km += dist;
        const pace = paceSeconds(a);
        const duration = pace.seconds && dist ? pace.seconds * dist : null;
        const rawMinutes = duration || finite(a.duration_seconds) || finite(a.moving_time_seconds);
        if (rawMinutes && rawMinutes > 0) minutes += rawMinutes / 60;
        runs += 1;
      });
      const known = meta.confirmed && knownStart && knownThrough && date >= knownStart && endDate <= knownThrough;
      const hasActivity = inRange.length > 0;
      weeks.push({
        date,
        endDate,
        km: +km.toFixed(3),
        minutes: +minutes.toFixed(2),
        runs,
        activityCount: inRange.length,
        coverage: known ? 'confirmed' : 'unknown',
        confirmedRest: Boolean(known && !hasActivity),
        zero: km === 0 && minutes === 0
      });
    }
    return weeks;
  }

  function summarizeWeeks(weeks) {
    const known = weeks.filter(w => w.coverage === 'confirmed');
    return {
      from: weeks[0] ? weeks[0].date : '',
      to: weeks.length ? weeks[weeks.length - 1].endDate : '',
      km: +weeks.reduce((sum, w) => sum + w.km, 0).toFixed(3),
      minutes: +weeks.reduce((sum, w) => sum + w.minutes, 0).toFixed(2),
      runs: weeks.reduce((sum, w) => sum + w.runs, 0),
      weeks: weeks.length,
      knownWeeks: known.length,
      unknownWeeks: weeks.length - known.length,
      coverage: weeks.length && known.length === weeks.length ? 'confirmed' : (known.length ? 'partial' : 'unknown')
    };
  }

  /**
   * Compare the last four completed calendar weeks with the four before them.
   * Returns `{ today, current, previous, delta, weeks, source, limitations }`.
   */
  function comparePeriods(activities, today) {
    const todayDate = localDate(today) || localDate(new Date());
    const lastComplete = addDays(monday(todayDate), -1);
    const currentFrom = addDays(monday(lastComplete), -21);
    const previousFrom = addDays(currentFrom, -28);
    const weeks = calendarWeeks(activities, previousFrom, lastComplete);
    const previousWeeks = weeks.filter(w => w.date < currentFrom);
    const currentWeeks = weeks.filter(w => w.date >= currentFrom);
    const current = summarizeWeeks(currentWeeks);
    const previous = summarizeWeeks(previousWeeks);
    return {
      today: todayDate,
      current,
      previous,
      delta: {
        km: +(current.km - previous.km).toFixed(3),
        minutes: +(current.minutes - previous.minutes).toFixed(2),
        runs: current.runs - previous.runs
      },
      weeks,
      source: 'activities.activity_date; complete Monday–Sunday calendar weeks',
      limitations: current.unknownWeeks || previous.unknownWeeks
        ? 'Nollveckor med okänd datatäckning ska inte tolkas som bekräftad vila.'
        : 'Alla jämförda veckor har bekräftad datatäckning.'
    };
  }

  function tagFor(profile, activity) {
    const value = profile && profile.activityTags && activity && activity.id && profile.activityTags[activity.id];
    return value && typeof value === 'object' ? value : {};
  }

  function easyBand(profile) {
    const rest = finite(profile && profile.hrRest);
    const max = finite(profile && profile.hrMax);
    if (rest == null || max == null || max <= rest) return null;
    const reserve = max - rest;
    return { min: rest + reserve * 0.60, max: rest + reserve * 0.70 };
  }

  function classifyEasy(activity, profile, tag) {
    if (tag.kind && tag.kind !== 'other') return tag.kind === 'easy';
    const hr = finite(activity.avg_hr);
    const band = easyBand(profile);
    return Boolean(hr != null && band && hr >= band.min - 5 && hr <= band.max + 5);
  }

  /**
   * Find raw, like-for-like easy runs. Returns `{ status, runs, groups,
   * candidateCount, criteria, sourcePassLinks, limitations }`. No pace or
   * duration normalization is performed; all groups remain inspectable.
   */
  function comparableRuns(activities, profile) {
    const today = localDate(profile && profile.today) || localDate(new Date());
    const candidates = sortedActivities(activities).filter(isRunning).map(activity => {
      const tag = tagFor(profile || {}, activity);
      const pace = paceSeconds(activity);
      const duration = finite(activity.moving_time_seconds) || finite(activity.duration_seconds);
      const surface = ['road', 'trail', 'treadmill', 'unknown'].includes(tag.surface) ? tag.surface : 'unknown';
      const route = String(tag.route || '').trim();
      const band = easyBand(profile || {});
      const hr = finite(activity.avg_hr);
      const hrBand = hr == null || !band ? 'unknown' : hr < band.min ? 'below' : hr <= band.max ? 'easy' : 'above';
      return { activity, id: activity.id || '', date: localDate(activity.activity_date), duration, hr, hrBand, surface, route,
        distanceKm: activityDistanceKm(activity), paceSeconds: pace.seconds, paceSource: pace.source, paceLabel: pace.label,
        kind: tag.kind && tag.kind !== 'other' ? tag.kind : (classifyEasy(activity, profile || {}, tag) ? 'easy-inferred' : 'other') };
    }).filter(row => row.date <= today && row.paceSeconds && row.hrBand === 'easy' && (row.kind === 'easy' || row.kind === 'easy-inferred'));

    const groupsMap = new Map();
    candidates.forEach(row => {
      const key = `${row.hrBand}|${row.surface}|${row.route || 'unknown-route'}`;
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(row);
    });
    const groups = [...groupsMap.entries()].map(([key, rows]) => {
      const durations = rows.map(r => r.duration).filter(v => v > 0).sort((a, b) => a - b);
      const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
      const selected = median ? rows.filter(r => r.duration == null || Math.abs(r.duration - median) / median <= 0.25) : rows;
      return { key, hrBand: rows[0].hrBand, surface: rows[0].surface, route: rows[0].route || '', medianDurationSeconds: median, rows, selected,
        minSample: 3, sufficient: selected.length >= 3 };
    }).sort((a, b) => b.selected.length - a.selected.length || a.key.localeCompare(b.key));
    const best = groups[0] || { selected: [] };
    const runs = best.selected.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const latestDate = runs.at(-1)?.date || '';
    const stale = !!latestDate && latestDate < addDays(today, -42);
    return {
      latestDate,
      status: stale ? 'stale' : runs.length >= 3 ? 'ok' : 'thin',
      runs,
      groups,
      candidateCount: candidates.length,
      criteria: {
        kind: 'easy tag preferred; HR-inferred only when profile HR bounds exist',
        hrBand: 'same HR band when known',
        duration: 'within ±25% of matching-group median when duration is known',
        terrain: 'same tagged surface; unknown is kept separate',
        route: 'same tagged route when supplied; unknown routes are kept separate from tagged routes',
        normalization: 'none; raw pace values retain their source'
      },
      sourcePassLinks: runs.map(r => ({ id: r.id, href: r.id ? `activity.html?id=${encodeURIComponent(r.id)}` : '' })),
      limitations: (stale ? 'De senaste matchande passen är äldre än sex veckor och beskriver inte säkert nuläget. ' : '') + (runs.length < 3 ? 'För få matchande lugna pass för en jämförelse.' : 'Jämförelsen visar matchade pass utan justering för exempelvis väder eller dagsform.')
    };
  }

  function linearRegression(points) {
    if (points.length < 2) return null;
    const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const my = points.reduce((s, p) => s + p.y, 0) / points.length;
    const denom = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    if (!denom) return { slope: 0, intercept: my };
    const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / denom;
    return { slope, intercept: my - slope * mx };
  }

  /**
   * Return `{ status, method, observations, target, scenarios, sensitivity,
   * ageDays, minRuns, sourcePassLinks, limitations }`. Scenarios are a simple
   * historical linear extrapolation and are only populated for fresh data
   * with at least six usable pace + average-HR observations.
   */
  function projection(activities, goal, hrMax, today) {
    const sortedRuns = sortedActivities(activities).filter(isRunning);
    const todayDate = localDate(today) || localDate(new Date());
    const observations = sortedRuns.map((activity, index) => {
      const pace = paceSeconds(activity);
      const hr = finite(activity.avg_hr);
      const speed = pace.seconds ? MS_PER_KM / pace.seconds : null;
      const mPerBeat = speed && hr ? speed * 60 / hr : null;
      const tag = activity.activityTag || (activities && activities.activityTags && activities.activityTags[activity.id]) || {};
      return { id: activity.id || '', date: localDate(activity.activity_date), index,
        paceSeconds: pace.seconds, paceSource: pace.source, paceLabel: pace.label,
        speedMps: speed, avgHr: hr, metersPerBeat: mPerBeat, kind: tag.kind || 'other', surface: tag.surface || 'unknown', route: tag.route || '' };
    }).filter(o => o.paceSeconds && o.date && o.date <= todayDate && o.metersPerBeat != null);
    const requestedGoal = goal || {};
    const distanceKm = finite(requestedGoal.distanceKm);
    const targetSeconds = finite(requestedGoal.targetSeconds);
    const targetSpeedMps = finite(requestedGoal.targetSpeedMps || requestedGoal.speedMps) || (distanceKm && targetSeconds ? distanceKm * MS_PER_KM / targetSeconds : null);
    const raceHrFraction = 0.91;
    const max = finite(hrMax);
    const targetHr = max && max > 0 ? max * raceHrFraction : null;
    const targetMetersPerBeat = targetSpeedMps && targetHr ? targetSpeedMps * 60 / targetHr : null;
    const lastDate = observations.length ? observations[observations.length - 1].date : '';
    const ageDays = lastDate ? Math.round((dateObject(todayDate) - dateObject(lastDate)) / DAY) : null;
    const status = !observations.length ? 'no_data' : observations.length < MIN_RUNS ? 'thin' : (ageDays > 42 ? 'stale' : 'ok');
    const scenarios = [];
    const makeScenario = (label, rows) => {
      const points = rows.map((o, i) => ({ x: i, y: o.metersPerBeat })).filter(p => p.y != null);
      const regression = linearRegression(points);
      const firstDate = rows[0] && rows[0].date;
      const lastScenarioDate = rows[rows.length - 1] && rows[rows.length - 1].date;
      let estimate = null;
      if (regression && targetMetersPerBeat && regression.slope > 0) {
        const targetIndex = (targetMetersPerBeat - regression.intercept) / regression.slope;
        const runsRemaining = targetIndex - (points.length - 1);
        const spanDays = firstDate && lastScenarioDate && rows.length > 1
          ? Math.max(1, (dateObject(lastScenarioDate) - dateObject(firstDate)) / DAY)
          : null;
        estimate = { targetIndex, runsRemaining, dateRange: { from: firstDate || '', through: lastScenarioDate || '' },
          projectedDate: runsRemaining >= 0 && spanDays != null ? addDays(lastScenarioDate, Math.round(runsRemaining * spanDays / Math.max(1, rows.length - 1))) : null };
      }
      return { label, nRuns: rows.length, dateRange: { from: firstDate || '', through: lastScenarioDate || '' }, regression, estimate };
    };
    if (status === 'ok' && observations.length >= MIN_RUNS) {
      scenarios.push(makeScenario('alla tillgängliga pass', observations));
      scenarios.push(makeScenario('senaste 6 pass', observations.slice(-6)));
      if (observations.length >= 12) scenarios.push(makeScenario('senaste 12 pass', observations.slice(-12)));
    }
    return {
      status,
      method: 'extrapolated_linear_meter_per_heartbeat',
      observations,
      target: { distanceKm, targetSeconds, targetSpeedMps, targetHr, targetMetersPerBeat, assumedRaceHrFraction: raceHrFraction },
      scenarios,
      sensitivity: scenarios.map(s => ({ label: s.label, nRuns: s.nRuns, dateRange: s.dateRange, projectedDate: s.estimate && s.estimate.projectedDate })),
      ageDays,
      minRuns: MIN_RUNS,
      sourcePassLinks: observations.map(o => ({ id: o.id, href: o.id ? `activity.html?id=${encodeURIComponent(o.id)}` : '' })),
      limitations: status === 'ok'
        ? 'Hypotetisk extrapolering av historisk trend; visar inte sannolikhet, skaderisk eller hjärtats slagvolym.'
        : 'Kallstart, tunt eller gammalt underlag används inte som prognos.'
    };
  }

  return {
    localDate,
    addDays,
    monday,
    paceSeconds,
    calendarWeeks,
    comparePeriods,
    comparableRuns,
    projection
  };
}));
