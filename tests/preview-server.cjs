// Local-only UI fixture server. Never proxies requests to a real account.
// node tests/preview-server.cjs [port]; open http://127.0.0.1:PORT
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Training = require('../js/training.js');
const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 8903);
const origin = `http://127.0.0.1:${port}`;
const user = '10000000-0000-4000-8000-000000000001';
const syntheticSession = {
  access_token: 'synthetic-only',
  expires_at: Date.now() + 86400000,
  user: { id: user, email: 'synthetic@example.invalid' }
};
const today = Training.localDate(new Date());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tables = {activities:[],laps:[],km_splits:[],time_series:[],training_plan_logs:[]};
const tags = {};
let profile = { revision: 1, settings: { goal:{ distanceKm:10,targetSeconds:2400,targetDate:Training.addDays(today,60),label:'Milen under 40 minuter' }, hrRest:55,hrMax:190,
  availableDays:[1,3,5,6],daysPerWeek:4,weeklyMinutes:180,coverageStart:Training.addDays(today,-100),coverageThrough:today,activityTags:tags } };
for (let i=0; i<40; i++) {
  const date=Training.addDays(today,-i*2), timer=2700+i*7, activityId=id(i+1);
  const strength=i%7===6;
  const activity={id:activityId,activity_date:date,activity_type:strength?'strength':'running',distance_meters:strength?null:8000,duration_seconds:timer+30,moving_time_seconds:timer,avg_hr:strength?110:143+i%3,max_hr:165,avg_speed_ms:strength?null:8000/timer,elevation_gain_meters:25,filename:`synthetic-${i}.fit`,notes:'Syntetiskt testpass',user_id:user};
  if(i===3) {activity.distance_meters=10000;activity.duration_seconds=2530;activity.moving_time_seconds=2530;tags[activityId]={kind:'test',surface:'road'};}
  else if (!strength) tags[activityId]={kind:'easy',surface:'road',route:'Syntetisk flack runda'};
  else tags[activityId]={strength:{exercise:'Knäböj',weightKg:50+(40-i)/2,reps:8}};
  activity.hr_zone_seconds={'1':100,'2':timer-200,'3':100,'4':0,'5':0};activity.hr_coverage_seconds=timer;
  activity.hr_zone_config={method:'karvonen',rest:55,max:190,zones:[{num:1,name:'Z1 Återhämtning',min:55,max:136},{num:2,name:'Z2 Lugn',min:136,max:150},{num:3,name:'Z3 Tempo',min:150,max:163},{num:4,name:'Z4 Hårt',min:163,max:177},{num:5,name:'Z5 Max',min:177,max:null}]};
  tables.activities.push(activity);
  if (!strength && process.argv.includes('--large-export')) for (let point=0; point<3000; point++) {
    tables.time_series.push({id:id(3000000+i*3000+point),activity_id:activityId,t:point*timer/2999,hr:activity.avg_hr,speed:activity.avg_speed_ms});
  }
  if(!strength)for(let k=1;k<=8;k++) {
    tables.laps.push({id:id(1000+i*10+k),activity_id:activityId,lap_index:k,distance_meters:1000,duration_seconds:timer/8,moving_duration_seconds:timer/8,avg_pace_sec_per_km:timer/8,avg_hr:143+i%3});
    tables.km_splits.push({id:id(2000+i*10+k),activity_id:activityId,km:k,distance_meters:1000,duration_seconds:timer/8,timer_duration_seconds:timer/8,pace_sec_per_km:timer/8,avg_hr:143+i%3});
  }
}

function respond(res, status, data, type='application/json') {
  res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store'});
  res.end(type==='application/json'?JSON.stringify(data):data);
}
function filterRows(rows,q) {
  let out=rows.filter(row => [...q.entries()].every(([k,v]) => !v.startsWith('eq.') || String(row[k])===v.slice(3)));
  const orders=(q.get('order')||'').split(',').filter(Boolean);
  out=out.slice().sort((a,b)=>{for(const order of orders){const [key,dir]=order.split('.');const x=a[key],y=b[key];const n=typeof x==='number'?x-y:String(x??'').localeCompare(String(y??''));if(n)return dir==='desc'?-n:n;}return 0;});
  const offset=Number(q.get('offset')||0),limit=Number(q.get('limit')||500);
  return out.slice(offset,offset+limit);
}
function nextUpdatedAt(existing) {
  const previous = Date.parse(existing?.updated_at || '');
  const next = Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0);
  return new Date(next).toISOString();
}
async function api(req,res,url) {
  let raw=''; for await (const chunk of req) raw+=chunk;
  const body=raw?JSON.parse(raw):{};
  const target=url.pathname.replace('/api/rest/v1/','');
  if(target==='training_profiles') return respond(res,200,[profile]);
  if(target==='rpc/save_training_profile') {
    if(body.p_revision!==profile.revision)return respond(res,409,{message:'PROFILE_CONFLICT'});
    const next={...profile.settings,...body.p_patch};
    for(const key of ['goal','activityTags','activityOverrides','planPreferences'])if(body.p_patch[key])next[key]={...profile.settings[key],...body.p_patch[key]};
    profile={settings:next,revision:profile.revision+1}; return respond(res,200,profile);
  }
  if(target==='rpc/import_activity_atomic') {
    const existing=tables.activities.find(a=>a.source_hash===body.p_activity.source_hash);
    if(existing)return respond(res,200,{status:'duplicate',inserted:false,activity_id:existing.id});
    const row={...body.p_activity,id:id(90000+tables.activities.length),user_id:user};tables.activities.push(row);
    for(const [table,key] of [['laps','p_laps'],['km_splits','p_km_splits'],['time_series','p_time_series']])for(const item of body[key]||[])tables[table].push({...item,activity_id:row.id,id:id(100000+tables[table].length)});
    return respond(res,200,{status:'inserted',inserted:true,activity_id:row.id});
  }
  if(!tables[target])return respond(res,404,{message:'Fixture endpoint missing: '+target});
  if(req.method==='GET')return respond(res,200,filterRows(tables[target],url.searchParams));
  if(req.method==='PATCH') {
    const matched=filterRows(tables[target],url.searchParams);
    for(const row of matched) {
      const previousUpdatedAt = row.updated_at;
      Object.assign(row,body);
      if(target==='training_plan_logs') row.updated_at=nextUpdatedAt({updated_at:previousUpdatedAt});
    }
    return respond(res,200,matched);
  }
  if(req.method==='POST') {
    const changed=[];
    for(const row of Array.isArray(body)?body:[body]) {
      const existing=target==='training_plan_logs'&&tables[target].find(v=>v.plan_block_id===row.plan_block_id&&v.plan_day_id===row.plan_day_id);
      if(existing&&!url.searchParams.has('on_conflict'))return respond(res,409,{message:'duplicate key value violates unique constraint'});
      if(existing) {
        const previousUpdatedAt = existing.updated_at;
        Object.assign(existing,row);
        if(target==='training_plan_logs') existing.updated_at=nextUpdatedAt({updated_at:previousUpdatedAt});
        changed.push(existing);
      }
      else {
        const inserted={...row,id:id(50000+tables[target].length),user_id:user};
        if(target==='training_plan_logs') inserted.updated_at=nextUpdatedAt();
        tables[target].push(inserted); changed.push(inserted);
      }
    }
    return respond(res,200,changed);
  }
  if(req.method==='DELETE') {const deleting=new Set(filterRows(tables[target],url.searchParams));tables[target]=tables[target].filter(r=>!deleting.has(r));return respond(res,200,[]);}
  return respond(res,405,{});
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/rest/v1/'))return await api(req,res,url);
    if(url.pathname.startsWith('/api/auth/'))return respond(res,200,{});
    const requested=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!requested.startsWith(root+path.sep)&&requested!==root)return respond(res,403,{});
    if(path.relative(root,requested).split(path.sep).some(part=>part.startsWith('.')))return respond(res,403,{});
    const file=fs.existsSync(requested)&&fs.statSync(requested).isDirectory()?path.join(requested,'index.html'):requested;
    if(!fs.existsSync(file))return respond(res,404,{});
    let data=fs.readFileSync(file);
    const ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.fit':'application/octet-stream','.zip':'application/zip'};
    if(file===path.join(root,'js/db.js'))data=data.toString()
      .replace(/const SUPA_URL = .*?;/,`const SUPA_URL = '${origin}/api';`)
      .replace('let authSession = loadAuthSession();',`sessionStorage.setItem(AUTH_STORAGE_KEY, ${JSON.stringify(JSON.stringify(syntheticSession))});\nlet authSession = loadAuthSession();`);
    if(ext==='.html') {
      let html=data.toString();
      if(!/src=["'][^"']*js\/security\.js["']/i.test(html)) html=html.replace('</head>','<script src="/js/security.js"></script></head>');
      html=html.replace(/connect-src\s+[^;]+(?=;)/i,`connect-src 'self' ${origin}`);
      data=html.replace('<body>','<body><div style="background:#f4e8bb;color:#493900;padding:7px 20px;text-align:center;font:13px system-ui">Lokal förhandsvisning · enbart syntetiska testdata</div>');
    }
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  }catch(error){respond(res,500,{message:error.message});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic preview: ${origin}`));
