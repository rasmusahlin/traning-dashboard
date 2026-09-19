const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/db.js'), 'utf8');
const AppSecurity = require('../js/security.js');

test('history pagination respects a lower server cap and keeps requesting until empty', async () => {
  const data = Array.from({length: 1203}, (_,id) => ({id}));
  let requests = 0;
  const session = { access_token: 'synthetic', expires_at: Date.now()+3600000 };
  const context = vm.createContext({ URLSearchParams, URL, console, Date, JSON, Promise, AppSecurity,
    sessionStorage: { getItem: () => JSON.stringify(session), setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async url => {
      const q = new URL(url).searchParams;
      const offset = Number(q.get('offset')); requests++;
      return { ok: true, status: 200, json: async () => data.slice(offset, offset+127) };
    }
  });
  vm.runInContext(source + '\nthis.api = {dbQueryAll, fmtPace};', context);
  const rows = await context.api.dbQueryAll('activities?order=activity_date.asc,id.asc&limit=1000');
  assert.equal(rows.length, 1203);
  assert.equal(rows.at(-1).id, 1202);
  assert.equal(requests, 11);
  assert.equal(context.api.fmtPace(299.7), '5:00');
});

test('pagination rejects a repeated page instead of looping forever', async () => {
  const session = { access_token: 'synthetic', expires_at: Date.now()+3600000 };
  const context = vm.createContext({ URLSearchParams, URL, console, Date, JSON, Promise, AppSecurity,
    sessionStorage: { getItem: () => JSON.stringify(session), setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: 1 }] })
  });
  vm.runInContext(source + '\nthis.api = {dbQueryAll};', context);
  await assert.rejects(
    context.api.dbQueryAll('activities?order=activity_date.asc', 1),
    /Historiken kunde inte hämtas fullständigt/
  );
});

test('database errors retain status while bounding backend details', async () => {
  const session = { access_token: 'synthetic', expires_at: Date.now()+3600000 };
  const context = vm.createContext({ URLSearchParams, console, Date, JSON, Promise, AppSecurity,
    sessionStorage: { getItem: () => JSON.stringify(session), setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false, status: 502, text: async () => 'backend detail '.repeat(100) })
  });
  vm.runInContext(source + '\nthis.api = {dbFetch};', context);
  await assert.rejects(context.api.dbFetch('activities'), error => {
    assert.equal(error.status, 502);
    assert.equal(error.message.length, 500);
    return true;
  });
});


test('reauthentication reloads page state before exposing a different account', async () => {
  let reloaded=0, initialized=0;
  const oldSession = {access_token:'old',expires_at:Date.now()+3600000,user:{id:'10000000-0000-4000-8000-000000000001'}};
  const context=vm.createContext({console,Date,JSON,Promise,URLSearchParams,AppSecurity,
    sessionStorage:{getItem:()=>JSON.stringify(oldSession),setItem(){},removeItem(){}},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    document:{getElementById:()=>({})}, location:{reload(){reloaded++;}},
    fetch:async()=>({ok:true,status:200,json:async()=>({access_token:'new',expires_in:3600,user:{id:'20000000-0000-4000-8000-000000000002'}})})});
  vm.runInContext(source+'\nthis.api={startApp,clearAuthSession,signIn};',context);
  await context.api.startApp(async()=>{initialized++;});
  context.api.clearAuthSession();
  await context.api.signIn('synthetic@example.invalid','synthetic-test');
  assert.equal(reloaded,1);
  assert.equal(initialized,1,'old page callback must not expose old state under the new account');
});
