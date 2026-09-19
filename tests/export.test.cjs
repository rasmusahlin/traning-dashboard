const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../settings.html'),'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const context = vm.createContext({console,Number,Set,Date,JSON,window:{addEventListener(){}},
 document:{getElementById:()=>({addEventListener(){}})},localStorage:{getItem:()=>null},startApp(){}});
vm.runInContext(script,context);
test('coach export never invents a zone distribution from session or lap averages',()=>{
 const result=context.buildHrZones({avg_hr:145,duration_seconds:3600},[{avg_hr:150,duration_seconds:3600}],[],[{t:0,hr:150},{t:3600,hr:150}],[]);
 assert.equal(result.source,'unavailable');assert.equal(result.total_seconds,0);
});
test('coach export uses the imported zone snapshot and reports partial coverage',()=>{
 const result=context.buildHrZones({moving_time_seconds:1000,hr_coverage_seconds:400,hr_zone_seconds:{1:100,2:300},hr_zone_config:{rest:55,max:190,zones:[{num:1,name:'Z1',min:55,max:135},{num:2,name:'Z2',min:135,max:150}]}},[],[],[],[]);
 assert.equal(result.total_seconds,400);assert.equal(result.source,'original_fit_weighted_timer');
 assert.equal(result.zone_config_at_import.rest,55);assert.ok(result.missing_data.includes('partial_hr_coverage'));
});
