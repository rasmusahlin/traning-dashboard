// Optional PostgreSQL execution tests: PGLITE_PATH=/path/to/@electric-sql/pglite node --test tests/database.integration.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const runtime = process.env.PGLITE_PATH;

test('database migrations: authentication, owner isolation, atomic writes and concurrency guards', { skip: !runtime }, async t => {
  const { PGlite } = require(runtime);
  const db = new PGlite();
  const owner = '10000000-0000-4000-8000-000000000001';
  const other = '20000000-0000-4000-8000-000000000002';
  try {
    await db.exec(`
      create role authenticated; create role anon;
      create schema auth;
      create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon;
      insert into auth.users values ('${owner}', 'rasmus.ahlin@gmail.com'), ('${other}', 'synthetic@example.invalid');
    `);
    await db.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
    const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
    for (const migration of migrations) await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}';`);
    const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.result;
    const writeProfile = (patch, revision) => scalar('select public.save_training_profile($1::jsonb,$2::integer) as result', [JSON.stringify(patch), revision]);

    await t.test('profile conflicts leave the newer revision unchanged; edits do not cross users', async () => {
      const saved = await writeProfile({ hrRest: 55 }, 0);
      assert.equal(saved.revision, 1);
      await assert.rejects(writeProfile({ hrRest: 60 }, 0), /PROFILE_CONFLICT/);
      assert.equal((await db.query('select settings from training_profiles')).rows[0].settings.hrRest, 55);
      await db.exec(`set request.jwt.claim.sub='${other}';`);
      assert.equal((await db.query('select * from training_profiles')).rows.length, 0);
      await writeProfile({ hrRest: 62 }, 0);
      await db.exec(`set request.jwt.claim.sub='${owner}';`);
      assert.equal((await db.query('select settings from training_profiles')).rows[0].settings.hrRest, 55);
    });

    await t.test('profile RPC rejects invalid arrays, fractional days and dates atomically', async () => {
      const revision = (await db.query('select revision from training_profiles')).rows[0].revision;
      const invalidPatches = [
        { availableDays: [1, 1, 3, 5] },
        { availableDays: [1, 3, 5, 7] },
        { daysPerWeek: 2.5 },
        { goal: { targetDate: '2026-02-31' } },
        { coverageStart: '2026-09-17', coverageThrough: '2026-09-16' },
        { coverageStart: '2026-09-17', coverageThrough: '2099-01-01' }
      ];
      for (const patch of invalidPatches) {
        await assert.rejects(writeProfile(patch, revision));
      }
      const row = (await db.query('select settings, revision from training_profiles')).rows[0];
      assert.equal(row.revision, revision);
      assert.equal(row.settings.hrRest, 55);
      assert.equal(row.settings.availableDays, undefined);
    });

    let activityId;
    const payload = { activity_date:'2026-09-14', started_at:'2026-09-14T08:00:00Z', activity_type:'running', sport_raw:'running',
      distance_meters:5000, avg_speed_ms:2.875, elevation_gain_meters:23.5, duration_seconds:1800, moving_time_seconds:1750, elapsed_duration_seconds:1800, timer_duration_seconds:1750,
      timer_time_source:'device', avg_hr:145, max_hr:165, source_hash:'a'.repeat(64), source_identity:'synthetic-activity-1', filename:'synthetic.fit' };
    const importActivity = (activity, laps = [], splits = [], series = []) => scalar('select public.import_activity_atomic($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) as result', [activity,laps,splits,series].map(JSON.stringify));
    await t.test('identical imports produce one activity and one set of details', async () => {
      const laps = [{lap_index:1,distance_meters:5000,duration_seconds:1800,avg_hr:145}];
      const first = await importActivity(payload, laps);
      activityId = first.activity_id;
      const duplicate = await importActivity(payload, laps);
      assert.equal(first.inserted, true);
      assert.equal(duplicate.inserted, false);
      assert.equal(duplicate.activity_id, activityId);
      assert.equal((await db.query('select * from activities')).rows.length, 1);
      assert.equal((await db.query('select * from laps')).rows.length, 1);
    });
    await t.test('invalid child data rolls the entire activity back', async () => {
      const invalid = {...payload, source_hash:'b'.repeat(64), source_identity:'synthetic-invalid', started_at:'2026-09-15T08:00:00Z', activity_date:'2026-09-15'};
      await assert.rejects(importActivity(invalid,[{lap_index:'bad',duration_seconds:20}]));
      await assert.rejects(importActivity(invalid,[{lap_index:1,duration_seconds:-20}]));
      assert.equal((await db.query('select * from activities')).rows.length, 1);
    });
    await t.test('negative activity values cannot enter through the atomic import endpoint', async () => {
      await assert.rejects(importActivity({...payload, source_hash:'c'.repeat(64), source_identity:'negative', distance_meters:-1000}));
      assert.equal((await db.query('select * from activities')).rows.length, 1);
    });
    await t.test('a second user cannot read or link another user’s activity', async () => {
      await db.exec(`set request.jwt.claim.sub='${other}';`);
      assert.equal((await db.query('select * from activities')).rows.length, 0);
      await assert.rejects(db.query('insert into training_plan_logs(plan_block_id,plan_day_id,plan_date,activity_id) values ($1,$2,$3,$4)', ['synthetic','day-1','2026-09-14',activityId]));
      await db.exec(`set request.jwt.claim.sub='${owner}';`);
      await db.query('insert into training_plan_logs(plan_block_id,plan_day_id,plan_date,activity_id) values ($1,$2,$3,$4)', ['synthetic','day-1','2026-09-14',activityId]);
      await assert.rejects(db.query('insert into training_plan_logs(plan_block_id,plan_day_id,plan_date,activity_id) values ($1,$2,$3,$4)', ['synthetic','day-2','2026-09-15',activityId]));
    });
    await t.test('plan revisions are server generated and stale writes cannot reuse the same client timestamp', async () => {
      const clientStamp = '2000-01-01T00:00:00Z';
      const inserted = (await db.query("insert into training_plan_logs(plan_block_id,plan_day_id,plan_date,updated_at) values ('cas','day','2026-09-18',$1) returning id,updated_at::text as revision", [clientStamp])).rows[0];
      assert.ok(!inserted.revision.startsWith('2000-'));
      const write = (revision, note) => db.query('update training_plan_logs set notes=$1,updated_at=$2 where id=$3 and updated_at=$4::timestamptz returning updated_at::text as revision', [note,clientStamp,inserted.id,revision]);
      const first = (await write(inserted.revision,'first')).rows[0];
      assert.ok(first);
      assert.notEqual(first.revision,inserted.revision);
      assert.equal((await write(inserted.revision,'stale overwrite')).rows.length,0);
      const second = (await write(first.revision,'second')).rows[0];
      assert.notEqual(second.revision,first.revision);
      assert.equal((await db.query('select notes from training_plan_logs where id=$1',[inserted.id])).rows[0].notes,'second');
    });
    await t.test('legacy re-import complements one old activity and preserves its notes and children', async () => {
      const legacy = {...payload, filename:'legacy.fit', activity_date:'2026-07-01', started_at:'2026-07-01T08:00:00Z', source_hash:'d'.repeat(64), source_identity:'legacy-upgrade'};
      const row = (await db.query('insert into activities(activity_date,activity_type,sport_raw,filename,distance_meters,duration_seconds,notes) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [legacy.activity_date,legacy.activity_type,legacy.sport_raw,legacy.filename,legacy.distance_meters,legacy.duration_seconds,'Retain this note'])).rows[0];
      const laps=[{lap_index:1,distance_meters:5000,duration_seconds:1800}];
      const upgraded=await importActivity({...legacy,hr_zone_seconds:{1:100,2:1600}},laps);
      assert.equal(upgraded.activity_id,row.id);
      assert.equal(upgraded.status,'upgraded');
      const again=await importActivity(legacy,laps);
      assert.equal(again.activity_id,row.id);
      const saved=(await db.query('select * from activities where id=$1',[row.id])).rows[0];
      assert.equal(saved.notes,'Retain this note');
      assert.equal(saved.hr_zone_seconds['2'],1600);
      assert.equal((await db.query('select * from laps where activity_id=$1',[row.id])).rows.length,1);
    });
    await t.test('anonymous calls cannot import or write a profile', async () => {
      await db.exec("reset role; set role anon; set request.jwt.claim.sub='';");
      await assert.rejects(importActivity(payload));
      await assert.rejects(writeProfile({ hrRest: 60 }, 0));
    });
  } finally { await db.close(); }
});
