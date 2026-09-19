const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.env.PGLITE_PATH;
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/008_coach_notes_server_only.sql'), 'utf8');

test('coach notes deny client reads and writes including column grants, preserve server and data', { skip: !runtime }, async () => {
  const { PGlite } = require(runtime);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.coach_notes(id integer primary key, content text);
      insert into public.coach_notes values (1,'synthetic only');
      grant all on public.coach_notes to public,anon,authenticated,service_role;
      grant select(content),update(content),insert(content),references(id) on public.coach_notes to anon,authenticated;`);
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from public.coach_notes')).rows, [{ id: 1, content: 'synthetic only' }]);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const sql of [
        'select * from public.coach_notes',
        'select content from public.coach_notes',
        "insert into public.coach_notes(id,content) values(2,'blocked')",
        "update public.coach_notes set content='blocked' where id=1",
        'delete from public.coach_notes where id=1',
        'truncate public.coach_notes'
      ]) await assert.rejects(db.exec(sql), error => error.code === '42501');
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await db.query('select count(*)::integer as n from public.coach_notes')).rows[0].n,1);
    await db.exec("insert into public.coach_notes values(2,'server'); update public.coach_notes set content='server update' where id=2; delete from public.coach_notes where id=2;");
    await db.exec('reset role; drop table public.coach_notes');
    await db.exec(migration); // Optional legacy table absent on a new install.
  } finally { await db.close(); }
});

test('missing server access aborts and rolls back client permission changes', { skip: !runtime }, async () => {
  const { PGlite } = require(runtime);
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role; create table public.coach_notes(id integer); grant all on public.coach_notes to anon,authenticated;');
    await assert.rejects(db.exec(migration), /Server privilege/);
    await db.exec('rollback');
    assert.equal((await db.query("select has_table_privilege('anon','public.coach_notes','SELECT') as allowed")).rows[0].allowed,true);
  } finally { await db.close(); }
});
