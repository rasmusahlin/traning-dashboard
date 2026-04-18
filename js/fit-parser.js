// FIT file parser using fit-file-parser library
// Extracts: records (per-second), laps, session summary

async function parseFitFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target.result;
        const parser = new FitParser({
          force: true,
          speedUnit: 'km/h',
          lengthUnit: 'm',
          temperatureUnit: 'celsius',
          elapsedRecordField: true,
          mode: 'list'
        });

        parser.parse(buffer, (error, data) => {
          if (error) { reject(error); return; }
          resolve(processFitData(data, file.name));
        });
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function processFitData(data, filename) {
  const session = data.sessions?.[0] || {};
  const laps = data.laps || [];
  const records = data.records || [];

  // Determine activity type
  const sport = (session.sport || '').toLowerCase();
  const actType = sport.includes('run') ? 'running' : sport.includes('strength') ? 'strength' : 'hiking';

  // Session summary
  const startTime = session.start_time ? new Date(session.start_time) : new Date();
  const summary = {
    activity_date: startTime.toISOString().slice(0, 10),
    activity_type: actType,
    sport_raw: session.sport || '',
    distance_meters: session.total_distance || 0,
    duration_seconds: session.total_elapsed_time || 0,
    moving_time_seconds: session.total_timer_time || 0,
    avg_hr: session.avg_heart_rate || null,
    max_hr: session.max_heart_rate || null,
    avg_cadence: actType === 'running' ? (session.avg_running_cadence ? session.avg_running_cadence * 2 : null) : null,
    avg_speed_ms: session.avg_speed || null,
    max_speed_ms: session.max_speed || null,
    elevation_gain_meters: session.total_ascent || null,
    elevation_loss_meters: session.total_descent || null,
    calories: session.total_calories || null,
    avg_power: session.avg_power || null,
    training_stress_score: session.training_stress_score || null,
    filename: filename,
    notes: null
  };

  // Process laps
  const processedLaps = laps.map((lap, i) => ({
    lap_index: i + 1,
    start_time: lap.start_time ? new Date(lap.start_time).toISOString() : null,
    distance_meters: lap.total_distance || 0,
    duration_seconds: lap.total_elapsed_time || 0,
    avg_hr: lap.avg_heart_rate || null,
    max_hr: lap.max_heart_rate || null,
    avg_pace_sec_per_km: lap.avg_speed ? 1000 / lap.avg_speed : null,
    avg_cadence: lap.avg_running_cadence ? lap.avg_running_cadence * 2 : null,
    elevation_gain: lap.total_ascent || null,
    calories: lap.total_calories || null,
    lap_trigger: lap.lap_trigger || 'manual'
  }));

  // Build km-splits from records
  const kmSplits = buildKmSplits(records);

  // HR zone distribution from records
  const hrZones = buildHRZones(records);

  // Time series for charts (downsample to ~300 points max)
  const timeSeries = buildTimeSeries(records);

  return { summary, laps: processedLaps, kmSplits, hrZones, timeSeries, raw: { session, laps, records } };
}

function buildKmSplits(records) {
  if (!records.length) return [];
  const splits = [];
  let splitStart = 0;
  let splitStartDist = 0;
  let splitStartTime = null;
  let hrVals = [], cadVals = [], altVals = [];

  records.forEach((r, i) => {
    const dist = r.distance || 0;
    const time = r.elapsed_time || 0;
    if (!splitStartTime && r.timestamp) splitStartTime = new Date(r.timestamp);

    if (r.heart_rate) hrVals.push(r.heart_rate);
    if (r.cadence) cadVals.push(r.cadence * 2);
    if (r.altitude) altVals.push(r.altitude);

    const kmCrossed = Math.floor(dist / 1000);
    const prevKmCrossed = Math.floor(splitStartDist / 1000);

    if (kmCrossed > prevKmCrossed && dist > 0) {
      const splitDist = dist - splitStartDist;
      const splitTime = time - splitStart;
      const paceSecPerKm = splitTime / (splitDist / 1000);

      splits.push({
        km: kmCrossed,
        distance_meters: splitDist,
        duration_seconds: splitTime,
        pace_sec_per_km: paceSecPerKm,
        avg_hr: hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b) / hrVals.length) : null,
        avg_cadence: cadVals.length ? Math.round(cadVals.reduce((a, b) => a + b) / cadVals.length) : null,
        elevation_gain: altVals.length > 1 ? Math.max(0, altVals[altVals.length - 1] - altVals[0]) : null
      });

      splitStart = time;
      splitStartDist = dist;
      hrVals = []; cadVals = []; altVals = [];
    }
  });

  // Last partial km
  const lastDist = records[records.length - 1]?.distance || 0;
  const lastTime = records[records.length - 1]?.elapsed_time || 0;
  const remainDist = lastDist - splitStartDist;
  if (remainDist > 100) {
    const splitTime = lastTime - splitStart;
    splits.push({
      km: Math.ceil(lastDist / 1000),
      distance_meters: remainDist,
      duration_seconds: splitTime,
      pace_sec_per_km: splitTime / (remainDist / 1000),
      avg_hr: hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b) / hrVals.length) : null,
      avg_cadence: cadVals.length ? Math.round(cadVals.reduce((a, b) => a + b) / cadVals.length) : null,
      elevation_gain: null,
      partial: true
    });
  }

  return splits;
}

function buildHRZones(records) {
  const { zones } = getHRConfig();
  const hrRecs = records.filter(r => r.heart_rate);
  if (!hrRecs.length) return [];

  const counts = zones.map(() => 0);
  hrRecs.forEach(r => {
    const zi = zones.findIndex(z => r.heart_rate >= z.min && r.heart_rate < z.max);
    if (zi >= 0) counts[zi]++;
  });

  const total = hrRecs.length;
  return zones.map((z, i) => ({
    zone: z.num,
    name: z.name,
    color: z.color,
    seconds: counts[i],
    pct: total > 0 ? Math.round((counts[i] / total) * 100) : 0
  }));
}

function buildTimeSeries(records) {
  if (!records.length) return [];
  const step = Math.max(1, Math.floor(records.length / 300));
  return records.filter((_, i) => i % step === 0).map(r => ({
    t: r.elapsed_time || 0,
    d: r.distance || 0,
    hr: r.heart_rate || null,
    alt: r.altitude || null,
    speed: r.speed || null, // m/s
    cadence: r.cadence ? r.cadence * 2 : null
  }));
}
