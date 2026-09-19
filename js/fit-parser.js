/*
 * Canonical Garmin FIT import pipeline.
 *
 * FitParser decodes the binary FIT payload. All unit conversions and derived
 * values live here so the upload page and tests use one implementation.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(root);
  else root.FitImport = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MAX_HR_INTERVAL_SECONDS = 30;
  var DEFAULT_CHART_POINTS = 500;
  var FIT_SIGNATURE = [0x2e, 0x46, 0x49, 0x54];

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function integer(value) {
    var n = finite(value);
    return n === null ? null : Math.round(n);
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function identityText(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '';
    return text(value).trim();
  }

  function finiteOr(value, fallback) {
    var n = finite(value);
    return n === null ? fallback : n;
  }

  function validDate(value) {
    if (!value) return null;
    var d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function localDateString(date) {
    var d = validDate(date);
    if (!d) return null;
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function bytesOf(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('FIT-data måste vara en ArrayBuffer eller Uint8Array.');
  }

  function readLe32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function fitCrc16(bytes, start, end) {
    var table = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
    var crc = 0;
    for (var i = start; i < end; i++) {
      var byteValue = bytes[i];
      var tmp = table[crc & 0xF];
      crc = (crc >>> 4) & 0x0FFF;
      crc = crc ^ tmp ^ table[byteValue & 0xF];
      tmp = table[crc & 0xF];
      crc = (crc >>> 4) & 0x0FFF;
      crc = crc ^ tmp ^ table[(byteValue >>> 4) & 0xF];
    }
    return crc & 0xFFFF;
  }

  function validateFitBuffer(input) {
    var bytes = bytesOf(input);
    if (bytes.byteLength < 14) throw new Error('Ogiltig FIT-fil: filhuvudet är för kort.');
    var headerSize = bytes[0];
    if (headerSize < 12 || headerSize > bytes.byteLength) throw new Error('Ogiltig FIT-fil: felaktig headerlängd.');
    for (var i = 0; i < FIT_SIGNATURE.length; i++) {
      if (bytes[8 + i] !== FIT_SIGNATURE[i]) throw new Error('Ogiltig FIT-fil: FIT-signaturen saknas.');
    }
    var dataSize = readLe32(bytes, 4);
    var crcStart = headerSize + dataSize;
    if (dataSize > bytes.byteLength - headerSize || crcStart + 2 > bytes.byteLength) throw new Error('Ogiltig FIT-fil: datadelen är avklippt.');
    if (bytes.byteLength !== crcStart + 2) throw new Error('Ogiltig FIT-fil: oväntade extra bytes efter CRC.');
    if (headerSize === 14) {
      var headerCrc = bytes[12] | (bytes[13] << 8);
      if (headerCrc !== fitCrc16(bytes, 0, 12)) throw new Error('Ogiltig FIT-fil: header-CRC stämmer inte.');
    }
    var fileCrc = bytes[crcStart] | (bytes[crcStart + 1] << 8);
    var fileCrcStart = headerSize === 12 ? 0 : headerSize;
    if (fileCrc !== fitCrc16(bytes, fileCrcStart, crcStart)) throw new Error('Ogiltig FIT-fil: fil-CRC stämmer inte.');
    return bytes;
  }

  function normalizeSpeedMs(value, unit) {
    var n = finite(value);
    if (n === null || n < 0) return null;
    var u = text(unit || 'km/h').toLowerCase();
    return u.indexOf('km') >= 0 || u === 'kph' ? n / 3.6 : n;
  }

  function normalizeCadence(value) {
    var n = finite(value);
    if (n === null || n < 0) return null;
    return n * 2;
  }

  function detectActivityType(session, data) {
    session = session || {};
    data = data || {};
    var sport = text(session.sport).toLowerCase();
    var sub = text(session.sub_sport || session.subsport).toLowerCase();
    if (sport.indexOf('strength') >= 0 || sport.indexOf('training') >= 0 || sport.indexOf('gym') >= 0 ||
        sport.indexOf('cardio') >= 0 || sub.indexOf('strength') >= 0 || sub.indexOf('gym') >= 0 ||
        (Array.isArray(data.sets) && data.sets.length)) return 'strength';
    if (sport.indexOf('run') >= 0) return 'running';
    if (sport.indexOf('cycl') >= 0 || sport.indexOf('bike') >= 0 || sport.indexOf('ride') >= 0) return 'cycling';
    if (sport.indexOf('swim') >= 0 || sport.indexOf('pool') >= 0) return 'swimming';
    if (sport.indexOf('walk') >= 0 || sport.indexOf('hik') >= 0 || sport.indexOf('trail') >= 0) return 'hiking';
    return 'other';
  }

  function firstStartTime(session, records) {
    var start = validDate(session && (session.start_time || session.startTime));
    if (start) return start;
    for (var i = 0; i < (records || []).length; i++) {
      var recordDate = validDate(records[i] && records[i].timestamp);
      if (recordDate) return recordDate;
    }
    return null;
  }

  function sourceIdentity(session, data, startTime) {
    session = session || {};
    data = data || {};
    var id = data.file_id || data.fileId || (Array.isArray(data.file_ids) ? data.file_ids[0] : null) || session.file_id || session.fileId || {};
    if (typeof id !== 'object' || id === null) id = { id: id };
    var fields = [id.type, id.manufacturer, id.product, id.serial_number || id.serialNumber,
      id.number, id.time_created || id.timeCreated, session.activity_id || session.activityId];
    fields = fields.map(identityText).filter(Boolean);
    if (!fields.length) {
      fields = [startTime && startTime.toISOString(), session.total_distance, session.total_elapsed_time,
        session.sport, session.sub_sport || session.subsport].map(identityText).filter(Boolean);
    }
    return fields.length ? 'fit:' + fields.join('|') : null;
  }

  function normalizeRecords(records, startTime, speedUnit) {
    var startMs = startTime ? startTime.getTime() : null;
    var hasDeviceTimer = (records || []).some(function (r) {
      return finite(r && (r.timer_time !== undefined ? r.timer_time : r.timer_seconds)) !== null;
    });
    var normalized = (records || []).map(function (r, index) {
      r = r || {};
      var timestamp = validDate(r.timestamp);
      var timestampElapsed = timestamp && startMs !== null ? Math.max(0, (timestamp.getTime() - startMs) / 1000) : null;
      var elapsed = finite(r.elapsed_time !== undefined ? r.elapsed_time : r.elapsed_seconds);
      if (elapsed === null) elapsed = timestampElapsed;
      elapsed = Math.max(0, finiteOr(elapsed, index));
      var timer = finite(r.timer_time !== undefined ? r.timer_time : r.timer_seconds);
      if (timer === null) timer = elapsed;
      timer = Math.max(0, timer);
      return {
        source: r,
        timestamp: timestamp,
        elapsed_seconds: elapsed,
        timer_seconds: timer,
        distance: Math.max(0, finiteOr(r.distance, 0)),
        heart_rate: integer(r.heart_rate),
        altitude: finite(r.altitude),
        speed: normalizeSpeedMs(r.speed, speedUnit),
        cadence: normalizeCadence(r.cadence)
      };
    });
    normalized.sort(function (a, b) { return a.elapsed_seconds - b.elapsed_seconds; });
    var previousElapsed = 0;
    var previousTimer = 0;
    normalized.forEach(function (r) {
      r.elapsed_seconds = Math.max(previousElapsed, r.elapsed_seconds);
      r.timer_seconds = Math.max(previousTimer, r.timer_seconds);
      previousElapsed = r.elapsed_seconds;
      previousTimer = r.timer_seconds;
    });
    return { records: normalized, hasDeviceTimer: hasDeviceTimer };
  }

  function intervalSeconds(a, b, hasDeviceTimer) {
    if (!a || !b) return 0;
    var elapsed = Math.max(0, finiteOr(b.elapsed_seconds, 0) - finiteOr(a.elapsed_seconds, 0));
    var timer = Math.max(0, finiteOr(b.timer_seconds, 0) - finiteOr(a.timer_seconds, 0));
    // A large timestamp gap is missing data even when the device timer also
    // advanced; do not manufacture HR coverage over that gap.
    if (elapsed > MAX_HR_INTERVAL_SECONDS) return 0;
    if (hasDeviceTimer) return Math.min(timer, elapsed);
    return elapsed;
  }

  function makeHrConfig(options) {
    options = options || {};
    var max = finiteOr(options.max, 190);
    var rest = finiteOr(options.rest, 60);
    if (max < 100 || max > 240) max = 190;
    if (rest < 30 || rest >= max) rest = Math.min(60, max - 1);
    var reserve = max - rest;
    var defs = options.zones || [
      { num: 1, name: 'Z1 Återhämtning', minPct: 0, maxPct: 0.60, color: '#1d9e75' },
      { num: 2, name: 'Z2 Aerob bas', minPct: 0.60, maxPct: 0.70, color: '#185FA5' },
      { num: 3, name: 'Z3 Tempo', minPct: 0.70, maxPct: 0.80, color: '#ba7517' },
      { num: 4, name: 'Z4 Tröskel', minPct: 0.80, maxPct: 0.90, color: '#d85a30' },
      { num: 5, name: 'Z5 Max', minPct: 0.90, maxPct: 1, color: '#e24b4a' }
    ];
    return {
      max: max,
      rest: rest,
      zones: defs.map(function (z) {
        return {
          num: z.num,
          name: z.name,
          color: z.color,
          min: rest + reserve * finiteOr(z.minPct, 0),
          max: z.num === 5 ? Infinity : rest + reserve * finiteOr(z.maxPct, 1)
        };
      })
    };
  }

  function buildHRZones(records, options) {
    var config = makeHrConfig(options);
    var seconds = config.zones.map(function () { return 0; });
    var covered = 0;
    var hasDeviceTimer = !!(options && options.hasDeviceTimer);
    for (var i = 0; i < records.length - 1; i++) {
      var r = records[i];
      var duration = intervalSeconds(r, records[i + 1], hasDeviceTimer);
      if (!duration || r.heart_rate === null) continue;
      var zoneIndex = config.zones.findIndex(function (z) { return r.heart_rate >= z.min && r.heart_rate < z.max; });
      if (zoneIndex >= 0) {
        seconds[zoneIndex] += duration;
        covered += duration;
      }
    }
    var zones = config.zones.map(function (z, i) {
      return {
        zone: z.num,
        name: z.name,
        color: z.color,
        seconds: Number(seconds[i].toFixed(3)),
        pct: covered ? Math.round(seconds[i] * 100 / covered) : 0
      };
    });
    return {
      zones: zones,
      covered_seconds: Number(covered.toFixed(3)),
      total_seconds: records.length > 1 ? Math.max(0, records[records.length - 1].elapsed_seconds - records[0].elapsed_seconds) : 0,
      config: config
    };
  }

  function interpolatedPoint(a, b, ratio) {
    function mix(name) {
      var av = finite(a[name]);
      var bv = finite(b[name]);
      if (av === null && bv === null) return null;
      if (av === null) return bv;
      if (bv === null) return av;
      return av + (bv - av) * ratio;
    }
    return {
      distance: a.distance + (b.distance - a.distance) * ratio,
      elapsed_seconds: a.elapsed_seconds + (b.elapsed_seconds - a.elapsed_seconds) * ratio,
      timer_seconds: a.timer_seconds + (b.timer_seconds - a.timer_seconds) * ratio,
      heart_rate: mix('heart_rate'),
      cadence: mix('cadence'),
      altitude: mix('altitude')
    };
  }

  function newSplitAccumulator() {
    return { distance: 0, elapsed: 0, timer: 0, hrSum: 0, hrWeight: 0, cadenceSum: 0, cadenceWeight: 0, elevationGain: 0 };
  }

  function addSplitSlice(acc, from, to) {
    var distance = Math.max(0, finiteOr(to.distance, 0) - finiteOr(from.distance, 0));
    var elapsed = Math.max(0, finiteOr(to.elapsed_seconds, 0) - finiteOr(from.elapsed_seconds, 0));
    var timer = Math.max(0, finiteOr(to.timer_seconds, 0) - finiteOr(from.timer_seconds, 0));
    var weight = timer > 0 ? timer : elapsed;
    acc.distance += distance;
    acc.elapsed += elapsed;
    acc.timer += timer;
    if (finite(from.heart_rate) !== null && weight > 0) { acc.hrSum += from.heart_rate * weight; acc.hrWeight += weight; }
    if (finite(from.cadence) !== null && weight > 0) { acc.cadenceSum += from.cadence * weight; acc.cadenceWeight += weight; }
    var altFrom = finite(from.altitude), altTo = finite(to.altitude);
    if (altFrom !== null && altTo !== null) acc.elevationGain += Math.max(0, altTo - altFrom);
  }

  function finishSplit(acc, km, partial) {
    var distance = acc.distance;
    var timer = acc.timer;
    var elapsed = acc.elapsed;
    return {
      km: km,
      distance_meters: Number(distance.toFixed(3)),
      duration_seconds: Number(elapsed.toFixed(3)),
      elapsed_duration_seconds: Number(elapsed.toFixed(3)),
      timer_duration_seconds: Number(timer.toFixed(3)),
      pace_sec_per_km: distance > 0 ? Number((timer / (distance / 1000)).toFixed(3)) : null,
      elapsed_pace_sec_per_km: distance > 0 ? Number((elapsed / (distance / 1000)).toFixed(3)) : null,
      avg_hr: acc.hrWeight > 0 ? Math.round(acc.hrSum / acc.hrWeight) : null,
      avg_cadence: acc.cadenceWeight > 0 ? Math.round(acc.cadenceSum / acc.cadenceWeight) : null,
      elevation_gain: Number(acc.elevationGain.toFixed(3)) || null,
      partial: !!partial
    };
  }

  function buildKmSplits(records) {
    if (!records.length) return [];
    var splits = [];
    var first = records[0];
    var previous = { distance: 0, elapsed_seconds: 0, timer_seconds: 0, heart_rate: first.heart_rate, cadence: first.cadence, altitude: first.altitude };
    var accumulator = newSplitAccumulator();
    var nextBoundary = 1000;
    for (var i = 0; i < records.length; i++) {
      var current = records[i];
      if (current.distance < previous.distance) current = Object.assign({}, current, { distance: previous.distance });
      while (current.distance >= nextBoundary && current.distance > previous.distance) {
        var ratio = (nextBoundary - previous.distance) / (current.distance - previous.distance);
        var boundary = interpolatedPoint(previous, current, ratio);
        addSplitSlice(accumulator, previous, boundary);
        splits.push(finishSplit(accumulator, nextBoundary / 1000, false));
        accumulator = newSplitAccumulator();
        previous = boundary;
        nextBoundary += 1000;
      }
      addSplitSlice(accumulator, previous, current);
      previous = current;
    }
    if (accumulator.distance > 0) splits.push(finishSplit(accumulator, Math.ceil(previous.distance / 1000), previous.distance < nextBoundary));
    return splits;
  }

  function downsampleRecords(records, maxPoints) {
    var max = Math.max(1, Math.floor(finiteOr(maxPoints, DEFAULT_CHART_POINTS)));
    if (records.length <= max) return records.slice();
    if (max === 1) return records.length ? [records[0]] : [];
    var out = [];
    for (var i = 0; i < max; i++) {
      var index = Math.round(i * (records.length - 1) / (max - 1));
      if (!out.length || out[out.length - 1] !== records[index]) out.push(records[index]);
    }
    return out;
  }

  function buildTimeSeries(records, maxPoints) {
    return downsampleRecords(records, maxPoints).map(function (r) {
      return {
        t: Number(r.elapsed_seconds.toFixed(3)),
        elapsed_seconds: Number(r.elapsed_seconds.toFixed(3)),
        timer_seconds: Number(r.timer_seconds.toFixed(3)),
        d: Number(r.distance.toFixed(3)),
        hr: r.heart_rate,
        alt: r.altitude,
        speed: r.speed,
        cadence: r.cadence === null ? null : Math.round(r.cadence)
      };
    });
  }

  function processFitData(data, filename, options) {
    options = options || {};
    data = data || {};
    var session = (data.sessions && data.sessions[0]) || data.session || {};
    var laps = Array.isArray(data.laps) ? data.laps : [];
    var rawRecords = Array.isArray(data.records) ? data.records : [];
    var startTime = firstStartTime(session, rawRecords);
    if (!startTime) throw new Error('FIT-filen saknar giltig starttid.');
    var normalizedResult = normalizeRecords(rawRecords, startTime, options.speedUnit || 'km/h');
    var records = normalizedResult.records;
    var actType = detectActivityType(session, data);
    var elapsed = finite(session.total_elapsed_time);
    var timer = finite(session.total_timer_time);
    if (elapsed === null && records.length) elapsed = records[records.length - 1].elapsed_seconds;
    if (timer === null && records.length) timer = records[records.length - 1].timer_seconds;
    var hrResult = buildHRZones(records, Object.assign({}, options.hrConfig || {}, { hasDeviceTimer: normalizedResult.hasDeviceTimer }));
    var hrZoneSeconds = {};
    hrResult.zones.forEach(function (z) { hrZoneSeconds[z.zone] = z.seconds; });
    var speedUnit = options.speedUnit || 'km/h';
    var summary = {
      activity_date: localDateString(startTime),
      started_at: startTime.toISOString(),
      activity_type: actType,
      sport_raw: text(session.sport),
      subsport_raw: text(session.sub_sport || session.subsport),
      distance_meters: finite(session.total_distance),
      duration_seconds: elapsed,
      elapsed_duration_seconds: elapsed,
      moving_time_seconds: timer,
      timer_duration_seconds: timer,
      timer_time_source: normalizedResult.hasDeviceTimer || finite(session.total_timer_time) !== null ? 'device' : 'elapsed_fallback',
      avg_hr: integer(session.avg_heart_rate),
      max_hr: integer(session.max_heart_rate),
      avg_cadence: normalizeCadence(session.avg_running_cadence),
      avg_speed_ms: normalizeSpeedMs(session.avg_speed, speedUnit),
      max_speed_ms: normalizeSpeedMs(session.max_speed, speedUnit),
      elevation_gain_meters: finite(session.total_ascent),
      elevation_loss_meters: finite(session.total_descent),
      calories: integer(session.total_calories),
      avg_power: integer(session.avg_power),
      training_stress_score: finite(session.training_stress_score),
      hr_zone_seconds: hrZoneSeconds,
      hr_coverage_seconds: hrResult.covered_seconds,
      hr_zone_config: {
        method: 'karvonen',
        max: hrResult.config.max,
        rest: hrResult.config.rest,
        zones: hrResult.config.zones.map(function (z) {
          return { num: z.num, name: z.name, min: z.min, max: Number.isFinite(z.max) ? z.max : null, color: z.color };
        })
      },
      source_identity: sourceIdentity(session, data, startTime),
      filename: text(filename),
      notes: null
    };
    var processedLaps = laps.map(function (lap, i) {
      var lapElapsed = finite(lap.total_elapsed_time);
      var lapTimer = finite(lap.total_timer_time);
      var lapStart = validDate(lap.start_time);
      var lapDistance = finite(lap.total_distance);
      return {
        lap_index: i + 1,
        start_time: lapStart ? lapStart.toISOString() : null,
        distance_meters: lapDistance,
        duration_seconds: lapElapsed,
        elapsed_duration_seconds: lapElapsed,
        moving_duration_seconds: lapTimer,
        avg_hr: integer(lap.avg_heart_rate),
        max_hr: integer(lap.max_heart_rate),
        avg_pace_sec_per_km: lapDistance > 0 && lapTimer !== null ? lapTimer / (lapDistance / 1000) : null,
        elapsed_pace_sec_per_km: lapDistance > 0 && lapElapsed !== null ? lapElapsed / (lapDistance / 1000) : null,
        avg_cadence: normalizeCadence(lap.avg_running_cadence),
        elevation_gain: finite(lap.total_ascent),
        calories: integer(lap.total_calories),
        lap_trigger: text(lap.lap_trigger || 'manual')
      };
    });
    return {
      summary: summary,
      laps: processedLaps,
      kmSplits: actType === 'running' ? buildKmSplits(records) : [],
      hrZones: hrResult.zones,
      hrZoneSummary: hrResult,
      timeSeries: buildTimeSeries(records, options.maxChartPoints || DEFAULT_CHART_POINTS),
      raw: { session: session, laps: laps, records: rawRecords },
      records: records
    };
  }

  function parseFitBuffer(input, filename, options) {
    options = options || {};
    var bytes;
    try {
      bytes = validateFitBuffer(input);
    } catch (validationError) {
      return Promise.reject(validationError);
    }
    var Parser = options.FitParser || root.FitParser;
    if (typeof Parser !== 'function') return Promise.reject(new Error('FitParser saknas – kontrollera att FIT-biblioteket laddats.'));
    return new Promise(function (resolve, reject) {
      try {
        var parser = new Parser({ force: false, speedUnit: options.speedUnit || 'km/h', lengthUnit: 'm', temperatureUnit: 'celsius', elapsedRecordField: true, mode: 'list' });
        parser.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), function (error, data) {
          if (error) { reject(new Error('FIT-parsningsfel: ' + (error.message || error))); return; }
          try { resolve(processFitData(data, filename, options)); } catch (e) { reject(e); }
        });
      } catch (e) { reject(e); }
    });
  }

  function parseFitFile(file, options) {
    options = options || {};
    if (!file) return Promise.reject(new Error('Ingen FIT-fil vald.'));
    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer().then(function (buffer) { return parseFitBuffer(buffer, file.name || options.filename || 'activity.fit', options); });
    }
    if (typeof FileReader === 'undefined') return Promise.reject(new Error('Kan inte läsa filen i den här miljön.'));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Kunde inte läsa FIT-filen.')); };
      reader.onload = function () { parseFitBuffer(reader.result, file.name || options.filename || 'activity.fit', options).then(resolve, reject); };
      reader.readAsArrayBuffer(file);
    });
  }

  return {
    validateFitBuffer: validateFitBuffer,
    parseFitBuffer: parseFitBuffer,
    parseFitFile: parseFitFile,
    processFitData: processFitData,
    detectActivityType: detectActivityType,
    buildKmSplits: buildKmSplits,
    buildHRZones: buildHRZones,
    buildTimeSeries: buildTimeSeries,
    downsampleRecords: downsampleRecords,
    localDateString: localDateString,
    normalizeRecords: normalizeRecords,
    sourceIdentity: sourceIdentity,
    makeHrConfig: makeHrConfig,
    fitCrc16: fitCrc16
  };
});
