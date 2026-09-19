const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../settings.html'),'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const localStore = new Map();
const localStorage = {
  get length() { return localStore.size; },
  key(index) { return [...localStore.keys()][index] ?? null; },
  getItem(key) { return localStore.get(key) || null; },
  setItem(key, value) { localStore.set(key, String(value)); },
  clear() { localStore.clear(); }
};
const context = vm.createContext({console,Number,Set,Date,JSON,window:{addEventListener(){}},
 document:{getElementById:()=>({addEventListener(){}})},localStorage,startApp(){}});
vm.runInContext(script,context);

function exportFixture({ fault } = {}) {
  const elements = new Map();
  const ids = [1, 2, 3].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const counts = [34000, 34000, 34001];
  let downloaded = null;
  const ctx = vm.createContext({URLSearchParams,console:{error(){}},Number,Set,Date,JSON,
    AppSecurity:require('../js/security.js'),
    window:{addEventListener(){}}, localStorage,
    sessionStorage:{getItem:()=>null}, startApp(){},
    document:{getElementById:id=>{
      if(!elements.has(id))elements.set(id,{addEventListener(){},textContent:'',disabled:false});
      return elements.get(id);
    }} });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/db.js'),'utf8'),ctx);
  ctx.startApp=()=>{};
  vm.runInContext(script,ctx);
  ctx.getValidSession=async()=>({user:{id:ids[0]}});
  ctx.dbQuery=async request=>{
    const [table,query='']=request.split('?'), q=new URLSearchParams(query);
    const offset=Number(q.get('offset')||0), limit=Number(q.get('limit')||500);
    if(table==='activities')return ids.map(id=>({id})).slice(offset,offset+limit);
    if(table!=='time_series')return [];
    const id=q.get('activity_id')?.replace(/^eq\./,'');
    assert.ok(ids.includes(id),'every sensor query must be scoped to one known activity');
    if(fault==='network' && id===ids[1])throw new Error('Syntetiskt nätfel');
    const start=fault==='repeat'?0:offset;
    return Array.from({length:Math.max(0,Math.min(limit,127,counts[ids.indexOf(id)]-start))},(_,i)=>({
      id:`${id}-${start+i}`, activity_id:fault==='wrong_owner'?ids[(ids.indexOf(id)+1)%3]:id, t:start+i
    }));
  };
  ctx.downloadJson=data=>{downloaded=data;};
  // Transformation is covered separately; observe the complete loader input.
  ctx.buildCoachExportData=tables=>({activities:tables.activities,manifest:{table_counts:ctx.tableCounts(tables)},tables});
  ctx.toast=()=>{};
  return {ctx,ids,counts,elements,download:()=>downloaded};
}

test('coach export keeps all sensor rows above the global 100000 threshold',async()=>{
  const f=exportFixture();
  await f.ctx.exportCoachData();
  const data=f.download();
  assert.ok(data,'a complete coach export is downloaded');
  assert.equal(data.tables.time_series.length,102001);
  assert.equal(new Set(data.tables.time_series.map(row=>row.id)).size,102001);
  f.ids.forEach((id,i)=>assert.equal(data.tables.time_series.filter(row=>row.activity_id===id).length,f.counts[i]));
  assert.equal(f.elements.get('export-status').textContent,'Coach-export klar');
});

for(const fault of ['network','repeat','wrong_owner'])test(`coach export fails closed on ${fault}`,async()=>{
  const f=exportFixture({fault});
  await f.ctx.exportCoachData();
  assert.equal(f.download(),null,'no partial file is downloaded');
  assert.equal(f.elements.get('export-status').textContent,'Coach-export misslyckades');
  assert.equal(f.elements.get('export-coach-btn').disabled,false);
});
test('coach export never invents a zone distribution from session or lap averages',()=>{
 const result=context.buildHrZones({avg_hr:145,duration_seconds:3600},[{avg_hr:150,duration_seconds:3600}],[],[{t:0,hr:150},{t:3600,hr:150}],[]);
 assert.equal(result.source,'unavailable');assert.equal(result.total_seconds,0);
});
test('coach export uses the imported zone snapshot and reports partial coverage',()=>{
 const result=context.buildHrZones({moving_time_seconds:1000,hr_coverage_seconds:400,hr_zone_seconds:{1:100,2:300},hr_zone_config:{rest:55,max:190,zones:[{num:1,name:'Z1',min:55,max:135},{num:2,name:'Z2',min:135,max:150}]}},[],[],[],[]);
 assert.equal(result.total_seconds,400);assert.equal(result.source,'original_fit_weighted_timer');
 assert.equal(result.zone_config_at_import.rest,55);assert.ok(result.missing_data.includes('partial_hr_coverage'));
});

test('export reads only pending v2 plan logs for the authenticated owner',()=>{
 const owner='11111111-1111-4111-8111-111111111111';
 const other='22222222-2222-4222-8222-222222222222';
 const pending={status:'completed',_pending:true,updatedAt:'2026-09-19T10:00:00Z'};
 localStorage.setItem(`training_plan_logs_v2:${owner}:block-a`,JSON.stringify({day_1:pending,day_2:{status:'planned',_pending:false}}));
 localStorage.setItem(`training_plan_logs_v2:${other}:block-b`,JSON.stringify({day_9:{status:'completed',_pending:true}}));
 localStorage.setItem('training_plan_logs_v1:block-legacy',JSON.stringify({day_0:{status:'completed',_pending:true}}));
 const result=context.readPlanLogSettings(owner);
 assert.equal(result.source,'local_pending');
 assert.equal(result.storage_version,'training_plan_logs_v2');
 assert.equal(result.owner_bound,true);
 assert.deepEqual(JSON.parse(JSON.stringify(result.blocks)),{ 'block-a': { day_1: pending } });
 assert.deepEqual(JSON.parse(JSON.stringify(context.readPlanLogSettings(null).blocks)),{});
 localStorage.clear();
});
