(function initAppData(root, factory) {
  const security = typeof module === 'object' && module.exports
    ? require('./security.js')
    : root.AppSecurity;
  const api = factory(security);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAppData(AppSecurity) {
  'use strict';

  const ACTIVITY_TYPES = new Set(['running', 'strength', 'hiking']);

  function parseDuration(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    let seconds;
    if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
      seconds = Number(raw.replace(',', '.')) * 60;
    } else {
      const parts = raw.split(':');
      if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) {
        throw new Error('Tid ska anges som minuter, mm:ss eller hh:mm:ss.');
      }
      const numbers = parts.map(Number);
      if (numbers[numbers.length - 1] > 59 || (parts.length === 3 && numbers[1] > 59)) {
        throw new Error('Sekunder och minuter efter kolon ska vara 0–59.');
      }
      seconds = parts.length === 3
        ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
        : numbers[0] * 60 + numbers[1];
    }

    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 24 * 3600) {
      throw new Error('Tiden ska vara större än 0 och högst 7 dygn.');
    }
    return Math.round(seconds);
  }

  function normalizeManualActivity(input) {
    const activityDate = String(input?.activityDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate) ||
        new Date(`${activityDate}T00:00:00Z`).toISOString().slice(0, 10) !== activityDate) {
      throw new Error('Ange ett giltigt datum.');
    }

    const activityType = String(input?.activityType || '');
    if (!ACTIVITY_TYPES.has(activityType)) throw new Error('Välj en giltig aktivitetstyp.');

    const avgHr = optionalNumber(input.avgHr, 30, 240, 'snittpuls');
    const maxHr = optionalNumber(input.maxHr, 30, 240, 'maxpuls');
    if (avgHr !== null && maxHr !== null && avgHr > maxHr) {
      throw new Error('Snittpulsen kan inte vara högre än maxpulsen.');
    }

    const notes = String(input.notes ?? '').trim();
    if (notes.length > 2000) throw new Error('Anteckningen får vara högst 2 000 tecken.');

    const distanceKm = optionalNumber(input.distanceKm, 0, 1000, 'distans');
    return {
      activity_date: activityDate,
      activity_type: activityType,
      distance_meters: distanceKm === null ? null : distanceKm * 1000,
      duration_seconds: parseDuration(input.duration),
      avg_hr: avgHr,
      max_hr: maxHr,
      avg_cadence: optionalNumber(input.avgCadence, 1, 300, 'kadens'),
      elevation_gain_meters: optionalNumber(input.elevationGain, 0, 20000, 'höjdmeter'),
      notes: notes || null
    };
  }

  function mergePlanLogs(localLogs, remoteLogs, allowedDayIds) {
    const local = AppSecurity.normalizePlanLogs(localLogs || {}, allowedDayIds);
    const remote = AppSecurity.normalizePlanLogs(remoteLogs || {}, allowedDayIds);
    const merged = {};
    const dayIds = new Set([...Object.keys(remote), ...Object.keys(local)]);

    dayIds.forEach(dayId => {
      const localLog = local[dayId];
      const remoteLog = remote[dayId];
      if (!localLog) merged[dayId] = remoteLog;
      else if (!remoteLog) merged[dayId] = localLog;
      else merged[dayId] = timestamp(remoteLog.updatedAt) > timestamp(localLog.updatedAt)
        ? remoteLog
        : localLog;
    });
    return merged;
  }

  function buildHrZones(activity, laps, splits, timeSeries, zones) {
    const buckets = zones.map(zone => ({ ...zone, seconds: 0, percent: 0 }));
    const duration = finite(activity?.duration_seconds);
    let source = 'none';
    let confidence = 'low';
    let coveredSeconds = 0;

    const samples = (timeSeries || [])
      .map(point => ({ t: finite(point.t), hr: finite(point.hr) }))
      .filter(point => point.t !== null && point.hr !== null)
      .sort((a, b) => a.t - b.t);

    if (samples.length >= 2) {
      for (let index = 0; index < samples.length - 1; index++) {
        const delta = samples[index + 1].t - samples[index].t;
        if (delta > 0 && delta <= 600 && addSeconds(buckets, samples[index].hr, delta)) {
          coveredSeconds += delta;
        }
      }
      if (coveredSeconds > 0) {
        source = 'time_series';
        confidence = duration && coveredSeconds / duration < 0.7 ? 'medium' : 'high';
      }
    }

    if (source === 'none') {
      const lapSegments = validSegments(laps);
      const splitSegments = validSegments(splits);
      const segments = lapSegments.length ? lapSegments : splitSegments;
      segments.forEach(segment => {
        if (addSeconds(buckets, segment.avg_hr, segment.duration_seconds)) {
          coveredSeconds += Number(segment.duration_seconds);
        }
      });
      if (coveredSeconds > 0) {
        source = lapSegments.length ? 'laps' : 'km_splits';
        confidence = 'medium';
      }
    }

    if (source === 'none' && finite(activity?.avg_hr) !== null && duration) {
      addSeconds(buckets, activity.avg_hr, duration);
      coveredSeconds = duration;
      source = 'activity_average';
      confidence = 'low';
    }

    const total = buckets.reduce((sum, bucket) => sum + bucket.seconds, 0);
    buckets.forEach(bucket => {
      bucket.seconds = round(bucket.seconds, 1);
      bucket.percent = total ? round(bucket.seconds / total * 100, 1) : 0;
    });

    return {
      source,
      confidence,
      coveredSeconds: round(coveredSeconds, 1),
      coveragePercent: duration ? round(Math.min(100, coveredSeconds / duration * 100), 1) : null,
      totalSeconds: round(total, 1),
      buckets
    };
  }

  function filterAnalysisRuns(runs, options) {
    const periodDays = finite(options?.periodDays);
    const comparison = String(options?.comparison || 'all');
    const validRuns = (runs || [])
      .filter(run => Number.isFinite(Date.parse(run?.activity_date)))
      .slice()
      .sort((a, b) => Date.parse(a.activity_date) - Date.parse(b.activity_date));
    if (!validRuns.length) return [];

    const latestTime = Date.parse(validRuns[validRuns.length - 1].activity_date);
    const cutoff = periodDays && periodDays > 0 ? latestTime - periodDays * 86400000 : null;
    return validRuns.filter(run => {
      if (cutoff !== null && Date.parse(run.activity_date) < cutoff) return false;
      const distanceKm = finite(run.distance_meters) / 1000;
      if (comparison === '5to15km' && !(distanceKm >= 5 && distanceKm <= 15)) return false;
      return true;
    });
  }

  function summarizeAnalysisCoverage(scopeRuns, comparisonRuns) {
    const scope = filterAnalysisRuns(scopeRuns, {});
    const comparison = filterAnalysisRuns(comparisonRuns, {});
    const eligible = comparison.filter(run => finite(run.duration_seconds) > 0 && finite(run.distance_meters) > 2000);
    const hrCount = eligible.filter(run => finite(run.avg_hr) > 0).length;
    const elevationCount = eligible.filter(run => finite(run.elevation_gain_meters) !== null).length;
    return {
      runCount: scope.length,
      comparisonCount: comparison.length,
      startDate: scope[0]?.activity_date || null,
      endDate: scope[scope.length - 1]?.activity_date || null,
      hrCount,
      hrPercent: eligible.length ? Math.round(hrCount / eligible.length * 100) : 0,
      elevationPercent: eligible.length ? Math.round(elevationCount / eligible.length * 100) : 0
    };
  }

  function summarizeRunEvidence(runs) {
    const values = filterAnalysisRuns(runs, {});
    if (!values.length) {
      return { activeWeeks:0, totalWeeks:0, averageWeeklyKm:null, recentBestPace:null, recentBestDate:null };
    }

    const latestTime = Date.parse(values[values.length - 1].activity_date);
    const earliestTime = Date.parse(values[0].activity_date);
    const weekStart = time => {
      const date = new Date(time);
      const day = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - day);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    };
    const latestWeek = weekStart(latestTime);
    const earliestWeek = weekStart(earliestTime);
    const totalWeeks = Math.min(8, Math.max(1, Math.round((latestWeek - earliestWeek) / (7 * 86400000)) + 1));
    const eightWeekStart = latestWeek - (totalWeeks - 1) * 7 * 86400000;
    const recentStart = latestTime - 89 * 86400000;
    const trailing = values.filter(run => Date.parse(run.activity_date) >= eightWeekStart);
    const activeWeeks = new Set(trailing.map(run => weekStart(Date.parse(run.activity_date)))).size;
    const totalKm = trailing.reduce((sum, run) => sum + Math.max(0, finite(run.distance_meters) || 0) / 1000, 0);
    const recentCandidates = values
      .filter(run => Date.parse(run.activity_date) >= recentStart && finite(run.distance_meters) >= 5000 && finite(run.duration_seconds) > 0)
      .map(run => ({
        date: run.activity_date,
        pace: finite(run.duration_seconds) / (finite(run.distance_meters) / 1000)
      }))
      .sort((a, b) => a.pace - b.pace);

    return {
      activeWeeks,
      totalWeeks,
      averageWeeklyKm: round(totalKm / totalWeeks, 1),
      recentBestPace: recentCandidates[0] ? round(recentCandidates[0].pace, 1) : null,
      recentBestDate: recentCandidates[0]?.date || null
    };
  }

  function summarizeDateTrend(points) {
    const regression = dateRegression(points);
    if (!regression) return { count: validDatePoints(points).length, spanDays: 0, slopePer30Days: null, rSquared: null };

    return {
      count: regression.values.length,
      spanDays: Math.round(regression.spanDays),
      slopePer30Days: round(regression.slope * 30, 4),
      rSquared: regression.rSquared
    };
  }

  function estimateDateTarget(points, targetValue) {
    const regression = dateRegression(points);
    const target = finite(targetValue);
    if (!regression || target === null) return { status:'insufficient', targetDate:null, daysAfterLast:null };
    if (regression.slope <= 0) return { status:'no_upward_trend', targetDate:null, daysAfterLast:null };

    const targetDay = (target - regression.intercept) / regression.slope;
    if (!Number.isFinite(targetDay)) return { status:'insufficient', targetDate:null, daysAfterLast:null };
    const targetTime = regression.start + targetDay * 86400000;
    if (!Number.isFinite(targetTime) || Math.abs(targetTime) > 8640000000000000) {
      return { status:'insufficient', targetDate:null, daysAfterLast:null };
    }
    const daysAfterLast = Math.round((targetTime - regression.lastTime) / 86400000);
    return {
      status: daysAfterLast <= 0 ? 'trend_at_target' : 'projected',
      targetDate: new Date(targetTime).toISOString().slice(0, 10),
      daysAfterLast
    };
  }

  function estimateTargetStability(points, targetValue) {
    const values = validDatePoints(points);
    if (values.length < 12) return { status:'insufficient', earliestDate:null, latestDate:null, validEstimates:0, totalEstimates:values.length };

    const estimates = [];
    for (let index = 0; index < values.length; index++) {
      const sample = values
        .filter((_, sampleIndex) => sampleIndex !== index)
        .map(point => ({ date:new Date(point.time).toISOString().slice(0, 10), value:point.value }));
      const estimate = estimateDateTarget(sample, targetValue);
      if (estimate.status === 'projected' && estimate.targetDate) estimates.push(estimate.targetDate);
    }
    estimates.sort();
    if (estimates.length < Math.ceil(values.length * 0.7)) {
      return { status:'unstable', earliestDate:null, latestDate:null, validEstimates:estimates.length, totalEstimates:values.length };
    }

    const percentile = fraction => estimates[Math.min(estimates.length - 1, Math.max(0, Math.round((estimates.length - 1) * fraction)))];
    return {
      status:'range',
      earliestDate:percentile(0.1),
      latestDate:percentile(0.9),
      validEstimates:estimates.length,
      totalEstimates:values.length
    };
  }

  function dateTrendValues(points) {
    const regression = dateRegression(points);
    if (!regression) return (points || []).map(() => null);
    return validDatePoints(points).map(point => round(
      regression.intercept + regression.slope * ((point.time - regression.start) / 86400000),
      4
    ));
  }

  function dateRegression(points) {
    const values = validDatePoints(points);
    if (values.length < 2) return null;
    const start = values[0].time;
    const xs = values.map(point => (point.time - start) / 86400000);
    const ys = values.map(point => point.value);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const denominator = xs.reduce((sum, value) => sum + Math.pow(value - meanX, 2), 0);
    const slope = denominator
      ? xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0) / denominator
      : 0;
    const intercept = meanY - slope * meanX;
    const total = ys.reduce((sum, value) => sum + Math.pow(value - meanY, 2), 0);
    const residual = ys.reduce((sum, value, index) => sum + Math.pow(value - (intercept + slope * xs[index]), 2), 0);
    return {
      values,
      start,
      lastTime: values[values.length - 1].time,
      spanDays: xs[xs.length - 1],
      slope,
      intercept,
      rSquared: total ? round(Math.max(0, 1 - residual / total), 3) : 0
    };
  }

  function validDatePoints(points) {
    return (points || [])
      .map(point => ({ time: Date.parse(point.date), value: finite(point.value) }))
      .filter(point => Number.isFinite(point.time) && point.value !== null)
      .sort((a, b) => a.time - b.time);
  }

  function optionalNumber(value, min, max, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${capitalize(label)} ska vara mellan ${min} och ${max}.`);
    }
    return number;
  }

  function validSegments(rows) {
    return (rows || []).filter(row => finite(row.avg_hr) !== null && finite(row.duration_seconds) > 0);
  }

  function addSeconds(buckets, hr, seconds) {
    const bpm = finite(hr);
    const amount = finite(seconds);
    if (bpm === null || amount === null || amount <= 0) return false;
    const bucket = buckets.find(zone => bpm >= zone.min && bpm < zone.max) || buckets[buckets.length - 1];
    if (!bucket) return false;
    bucket.seconds += amount;
    return true;
  }

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timestamp(value) {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  return {
    parseDuration,
    normalizeManualActivity,
    mergePlanLogs,
    buildHrZones,
    filterAnalysisRuns,
    summarizeAnalysisCoverage,
    summarizeRunEvidence,
    summarizeDateTrend,
    estimateDateTarget,
    estimateTargetStability,
    dateTrendValues
  };
});
