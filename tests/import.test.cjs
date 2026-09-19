const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.TZ = 'Europe/Stockholm';
const FitImport = require('../js/fit-parser.js');
const ZipReader = require('../js/zip-reader.js');
require('../js/fitparser-bundle.min.js');

function activityData(overrides = {}) {
  const start = '2026-01-01T23:30:00.000Z';
  const records = [];
  for (let i = 0; i <= 10; i++) {
    records.push({
      timestamp: new Date(Date.parse(start) + i * 1000).toISOString(),
      elapsed_time: i,
      timer_time: i,
      distance: i * 200,
      heart_rate: 150,
      altitude: 100 + i,
      cadence: 85,
      speed: 12
    });
  }
  return {
    sessions: [{ start_time: start, sport: 'run', sub_sport: 'unknown', total_distance: 2000, total_elapsed_time: 10, total_timer_time: 10, ...overrides }],
    records,
    laps: []
  };
}

function write16(out, value) { out.push(value & 255, (value >>> 8) & 255); }
function write32(out, value) { out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }
function storedZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const bytes = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = ZipReader.crc32(bytes);
    const localStart = local.length;
    write32(local, 0x04034b50); write16(local, 20); write16(local, 0); write16(local, 0);
    write16(local, 0); write16(local, 0); write32(local, crc); write32(local, bytes.length); write32(local, bytes.length);
    write16(local, nameBytes.length); write16(local, 0); nameBytes.forEach(b => local.push(b)); bytes.forEach(b => local.push(b));
    write32(central, 0x02014b50); write16(central, 20); write16(central, 20); write16(central, 0); write16(central, 0);
    write16(central, 0); write16(central, 0); write32(central, crc); write32(central, bytes.length); write32(central, bytes.length);
    write16(central, nameBytes.length); write16(central, 0); write16(central, 0); write16(central, 0); write16(central, 0); write32(central, 0); write32(central, localStart);
    nameBytes.forEach(b => central.push(b));
    offset = local.length;
  }
  const result = local.concat(central);
  const centralOffset = local.length;
  write32(result, 0x06054b50); write16(result, 0); write16(result, 0); write16(result, entries.length); write16(result, entries.length);
  write32(result, central.length); write32(result, centralOffset); write16(result, 0);
  return Uint8Array.from(result);
}

function syntheticFit() {
  const data = [];
  const def = (local, globalNum, fields) => {
    data.push(0x40 | local, 0, 0, globalNum & 255, globalNum >>> 8, fields.length);
    fields.forEach(([num, size, base]) => data.push(num, size, base));
  };
  const put16 = value => { data.push(value & 255, value >>> 8); };
  const put32 = value => { data.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); };
  const fitTime = Math.floor(Date.parse('2026-01-01T23:30:00Z') / 1000) - 631065600;
  // file_id, session and record definitions
  def(2, 0, [[0, 1, 0x00], [1, 2, 0x84], [2, 2, 0x84], [3, 4, 0x86], [4, 4, 0x86], [5, 2, 0x84]]);
  data.push(2, 4); put16(1); put16(100); put32(123); put32(fitTime); put16(1);
  def(0, 18, [[2, 4, 0x86], [5, 1, 0x00], [6, 1, 0x00], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86], [11, 2, 0x84], [14, 2, 0x84], [16, 1, 0x02], [17, 1, 0x02]]);
  data.push(0); put32(fitTime); data.push(1, 0); put32(10000); put32(9000); put32(200000); put16(4000); put16(3000); data.push(150, 170);
  def(1, 20, [[253, 4, 0x86], [2, 2, 0x84], [3, 1, 0x02], [4, 1, 0x02], [5, 4, 0x86], [6, 2, 0x84]]);
  for (let i = 0; i <= 10; i++) { data.push(1); put32(fitTime + i); put16((i * 200) * 100); data.push(150, 85); put32((i * 1000)); put16(3000); }
  const header = [14, 0x10, 0, 0, data.length & 255, (data.length >>> 8) & 255, (data.length >>> 16) & 255, (data.length >>> 24) & 255, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const result = Uint8Array.from(header.concat(data, [0, 0]));
  const headerCrc = FitImport.fitCrc16(result, 0, 12);
  result[12] = headerCrc & 255; result[13] = headerCrc >>> 8;
  const fileCrc = FitImport.fitCrc16(result, 14, 14 + data.length);
  result[14 + data.length] = fileCrc & 255; result[15 + data.length] = fileCrc >>> 8;
  return result;
}

if (process.env.GENERATE_IMPORT_FIXTURE === '1') {
  const fit = syntheticFit();
  fs.writeFileSync('/private/tmp/training-dashboard-synthetic.fit', fit);
  fs.writeFileSync('/private/tmp/training-dashboard-synthetic.zip', storedZip([
    ['nested/activity-export.zip', storedZip([['Activities/synthetic-run.fit', fit]])]
  ]));
}

test('rejects malformed FIT headers before handing data to FitParser', () => {
  assert.throws(() => FitImport.validateFitBuffer(new Uint8Array(14)), /felaktig headerlängd|FIT-signaturen/);
  const bytes = new Uint8Array(14); bytes[0] = 12; bytes.set([0x2e, 0x46, 0x49, 0x54], 8);
  new DataView(bytes.buffer).setUint32(4, 100, true);
  assert.throws(() => FitImport.validateFitBuffer(bytes), /avklippt/);
  const shortHeader = Uint8Array.from([12, 0x10, 0, 0, 1, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0x01, 0x00, 0x00]);
  const shortCrc = FitImport.fitCrc16(shortHeader, 0, 13);
  shortHeader[13] = shortCrc & 255; shortHeader[14] = shortCrc >>> 8;
  assert.doesNotThrow(() => FitImport.validateFitBuffer(shortHeader));
});

test('decodes a synthetic binary FIT through the bundled FitParser', async () => {
  const parsed = await FitImport.parseFitBuffer(syntheticFit(), 'synthetic-run.fit', { FitParser: global.FitParser, speedUnit: 'km/h' });
  assert.equal(parsed.summary.activity_type, 'running');
  assert.equal(parsed.summary.distance_meters, 2000);
  assert.equal(parsed.summary.sport_raw, 'running');
  assert.match(parsed.summary.source_identity, /2026-01-01T23:30:00\.000Z/);
  assert.equal(parsed.records.length, 11);
  const corrupt = syntheticFit(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(() => FitImport.parseFitBuffer(corrupt, 'corrupt.fit', { FitParser: global.FitParser }), /CRC/);
});

test('uses local started date, preserves unknown sport and keeps distance', () => {
  const parsed = FitImport.processFitData(activityData({ sport: 'custom_sport', sub_sport: 'custom_subsport', total_distance: 1234 }));
  assert.equal(parsed.summary.activity_date, '2026-01-02');
  assert.equal(parsed.summary.started_at, '2026-01-01T23:30:00.000Z');
  assert.equal(parsed.summary.activity_type, 'other');
  assert.equal(parsed.summary.sport_raw, 'custom_sport');
  assert.equal(parsed.summary.subsport_raw, 'custom_subsport');
  assert.equal(parsed.summary.distance_meters, 1234);
});

test('keeps cycling and swimming as known activity types', () => {
  assert.equal(FitImport.processFitData(activityData({ sport: 'cycling' })).summary.activity_type, 'cycling');
  assert.equal(FitImport.processFitData(activityData({ sport: 'swimming' })).summary.activity_type, 'swimming');
});

test('interpolates kilometre boundaries and keeps elapsed/timer pace separate', () => {
  const parsed = FitImport.processFitData(activityData({ total_distance: 2000, total_elapsed_time: 10, total_timer_time: 5 }));
  assert.equal(parsed.kmSplits.length, 2);
  assert.equal(parsed.kmSplits[0].distance_meters, 1000);
  assert.equal(parsed.kmSplits[0].duration_seconds, 5);
  assert.equal(parsed.kmSplits[0].timer_duration_seconds, 5);
  assert.equal(parsed.kmSplits[0].pace_sec_per_km, 5);
});

test('weights HR zones by raw timestamps and excludes pause/gap intervals', () => {
  const data = activityData();
  data.records = [
    { elapsed_time: 0, timer_time: 0, distance: 0, heart_rate: 150 },
    { elapsed_time: 1, timer_time: 1, distance: 100, heart_rate: 150 },
    { elapsed_time: 2, timer_time: 1, distance: 100, heart_rate: 180 },
    { elapsed_time: 40, timer_time: 1, distance: 100, heart_rate: 180 },
    { elapsed_time: 41, timer_time: 2, distance: 200, heart_rate: 180 }
  ];
  const parsed = FitImport.processFitData(data);
  assert.equal(parsed.summary.hr_coverage_seconds, 2);
  assert.equal(parsed.summary.hr_zone_seconds['2'], 1);
  assert.equal(parsed.summary.hr_zone_seconds['5'], 1);
});

test('chart downsampling is exactly bounded and keeps endpoints', () => {
  const records = Array.from({ length: 1001 }, (_, i) => ({ elapsed_seconds: i, timer_seconds: i, distance: i, heart_rate: null, altitude: null, speed: null, cadence: null }));
  const points = FitImport.buildTimeSeries(records, 500);
  assert.equal(points.length, 500);
  assert.equal(points[0].t, 0);
  assert.equal(points.at(-1).t, 1000);
  assert.equal(FitImport.buildTimeSeries(records, 1).length, 1);
});

test('reads nested Garmin-style ZIPs and enforces entry limits', async () => {
  const inner = storedZip([['Activities/run.fit', Buffer.from('synthetic-fit')]]);
  const outer = storedZip([['nested/activity-export.zip', inner], ['README.txt', Buffer.from('ignore')]]);
  const files = await ZipReader.readFitFiles(outer, { maxEntryBytes: 1024, maxTotalBytes: 4096 });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'nested/activity-export/Activities/run.fit');
  assert.equal(Buffer.from(files[0].bytes).toString(), 'synthetic-fit');
  await assert.rejects(() => ZipReader.readFitFiles(outer, { maxEntryBytes: 4 }), /storleksgräns/);
  await assert.rejects(() => ZipReader.readFitFiles(new Uint8Array([1, 2, 3])), /slutpost/);
});
