import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { CATALOG, parseElements, position, sampleDanuri } from '../dist/orbits.js';

const cacheSource=await readFile(new URL('../daily-cache.mjs',import.meta.url),'utf8');
const catalogSource=await readFile(new URL('../api/catalog.js',import.meta.url),'utf8');
const appSource=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const failure=async()=>{ throw new Error('CACHE_DOWN'); };
const satellites=CATALOG.slice(0,2);
const rows=satellites.map(s=>({
  NORAD_CAT_ID:s.id,EPOCH:new Date().toISOString(),MEAN_MOTION:15,ECCENTRICITY:.001,
  INCLINATION:45,RA_OF_ASC_NODE:0,ARG_OF_PERICENTER:0,MEAN_ANOMALY:0,
  BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0
}));

test('orbital speed matches position change',()=>{
  const elements=parseElements(rows).get(satellites[0].id);
  const sat={elements}, epoch=new Date(elements.EPOCH);
  const point=position(sat,epoch);
  const next=position(sat,new Date(+epoch+1000));
  const distance=Math.hypot(...['x','y','z'].map(key=>next.eci[key]-point.eci[key]));
  assert.ok(Math.abs(distance-point.speed)<.02);
});

test('lunar interpolation speed uses kilometres per second',()=>{
  const data={radius:1,points:[{t:0,x:10,y:0,z:0},{t:1000,x:13,y:4,z:0}]};
  assert.equal(sampleDanuri(data,500).speed,5);
});

async function load(source,imports,globals={}) {
  const context=createContext({
    URL,URLSearchParams,Date,AbortSignal,
    process:{env:{VERCEL:'1'},pid:1},console:{warn(){}},...globals
  });
  const module=new SourceTextModule(source,{
    context,initializeImportMeta(meta){meta.url=new URL('../daily-cache.mjs',import.meta.url).href;}
  });
  await module.link(name=>{
    assert.ok(imports[name],'Unexpected import: '+name);
    const values=imports[name];
    return new SyntheticModule(Object.keys(values),function(){
      for(const [key,value] of Object.entries(values)) this.setExport(key,value);
    },{context});
  });
  await module.evaluate();
  return module.namespace;
}

function loadCache(shared,fs={},local=false) {
  return load(cacheSource,{
    'node:fs/promises':{readFile:failure,writeFile:failure,rename:failure,...fs},
    'node:url':{fileURLToPath:url=>url.pathname},
    '@vercel/functions':{getCache:()=>shared}
  },local?{process:{env:{},pid:1}}:{});
}

test('shared cache read and write failures remain optional',async()=>{
  const cache=await loadCache({get:failure,set:failure});
  assert.equal(await cache.readDailyCache('orbits'),null);
  await assert.doesNotReject(cache.writeDailyCache('orbits',{fetchedAt:new Date().toISOString()}));
});

test('incomplete catalogs expire after five minutes in both storage modes',async()=>{
  const saved={fetchedAt:new Date(Date.now()-6*60000).toISOString(),unavailable:[satellites[1].id]};
  const shared=await loadCache({get:async()=>saved,set:async()=>{}});
  const local=await loadCache(null,{readFile:async()=>JSON.stringify(saved)},true);
  assert.equal(await shared.readDailyCache('orbits'),null);
  assert.equal(await local.readDailyCache('orbits'),null);
});

test('complete catalogs and Danuri keep the daily cache lifetime',async()=>{
  const saved={fetchedAt:new Date(Date.now()-6*60000).toISOString(),unavailable:[]};
  const cache=await loadCache({get:async()=>saved});
  assert.equal(await cache.readDailyCache('orbits'),saved);
  assert.equal(await cache.readDailyCache('danuri'),saved);
});

test('shared partial cache TTL matches the five-minute read lifetime',async()=>{
  let ttl;
  const cache=await loadCache({set:async(key,data,options)=>{ttl=options.ttl;}});
  await cache.writeDailyCache('orbits',{fetchedAt:new Date().toISOString(),unavailable:[1]});
  assert.ok(ttl>=298 && ttl<=300);
});

for (const operation of ['read','write']) test('catalog responds successfully during cache '+operation+' failure',async()=>{
  let calls=0;
  const cache=await loadCache({get:operation==='read'?failure:async()=>null,set:operation==='write'?failure:async()=>{}});
  const fields={id:'NORAD_CAT_ID',epoch:'EPOCH',n:'MEAN_MOTION',e:'ECCENTRICITY',i:'INCLINATION',raan:'RA_OF_ASC_NODE',argp:'ARG_OF_PERICENTER',m:'MEAN_ANOMALY',bstar:'BSTAR'};
  const provider=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,rows.map(row=>row[field])]));
  const {default:handler}=await load(catalogSource,{
    '../dist/orbits.js':{CATALOG:satellites,parseElements},
    '../daily-cache.mjs':{readDailyCache:cache.readDailyCache,writeDailyCache:cache.writeDailyCache}
  },{fetch:async()=>{calls++;return {ok:true,json:async()=>provider};}});
  const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await handler({method:'GET',url:'/api/catalog'},response);
  assert.equal(response.status,200);
  assert.equal(response.body.elements.length,2);
  assert.equal(calls,1);
});

async function refresh(fetch) {
  const state={satellites:satellites.map((sat,i)=>({...sat,elements:rows[i],record:{old:true}}))};
  const nodes=new Map(), snapshots=[];
  const $=key=>{
    if(!nodes.has(key)) nodes.set(key,{hidden:false});
    return nodes.get(key);
  };
  const source=appSource.slice(appSource.indexOf('function applyElements('),appSource.indexOf('\nfunction zoom('));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('state','$','updateSource','fetch','parseElements',source+'\nawait connectPublic(true);')(
    state,$,()=>snapshots.push(state.satellites.map(s=>s.elements)),fetch,parseElements
  );
  return {state,nodes,snapshots};
}

test('failed refresh preserves coordinates, propagation records, timestamp and retry button',async()=>{
  const {state,nodes}=await refresh(async()=>{throw Error('NETWORK_DOWN');});
  assert.equal(state.satellites[0].elements,rows[0]);
  assert.equal(state.satellites[0].record.old,true);
  assert.equal(nodes.get('#source-time')?.hidden ?? false,false);
  assert.equal(nodes.get('#fetch-data').disabled,false);
});

function stream(...messages) {
  return new Response(messages.map(message=>JSON.stringify(message)+'\n').join(''));
}

async function catalogResponse(saved,fetch) {
  const {default:handler}=await load(catalogSource,{
    '../dist/orbits.js':{CATALOG:satellites,parseElements},
    '../daily-cache.mjs':{readDailyCache:async()=>saved,writeDailyCache:async()=>{}}
  },{fetch});
  const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await handler({method:'GET',url:'/api/catalog'},response);
  return response;
}

for (const partial of [false,true]) test('provider timeout '+(partial?'remains visible for missing data':'is resolved by successful fallback'),async()=>{
  const response=await catalogResponse(null,async url=>{
    if (url.includes('orbitalwiki')) throw Object.assign(new Error('TIMEOUT'),{name:'TimeoutError'});
    const id=Number(new URL(url).searchParams.get('id'));
    const row=rows.find(row=>row.NORAD_CAT_ID===id);
    return {ok:true,json:async()=>({orbital_data:partial && id===satellites[1].id ? [] : [{orbital_elements:row}]})};
  });
  assert.equal(response.status,200);
  assert.equal(response.body.elements.length,partial?1:2);
  assert.equal(response.body.unavailable.length,partial?1:0);
  if (partial) assert.equal(response.body.warnings.length,1);
  else assert.equal(response.body.warnings,undefined);
});

test('complete cached catalog drops old resolved provider warnings',async()=>{
  const response=await catalogResponse({elements:rows,warnings:['old provider timeout']},async()=>assert.fail('Should use cache'));
  assert.equal(response.status,200);
  assert.equal(response.body.elements.length,2);
  assert.equal(response.body.warnings,undefined);
});

test('partial results preserve old coordinates until a successful final snapshot',async()=>{
  const {state,snapshots}=await refresh(async()=>stream(
    {done:false,elements:[rows[0]]},
    {done:true,elements:[rows[0]],unavailable:[satellites[1].id],delivery:'upstream'}
  ));
  assert.ok(snapshots.slice(0,-1).every(snapshot=>snapshot[1]===rows[1]));
  assert.equal(state.satellites[1].elements,null);
});

test('stream errors preserve the old satellites absent from partial results',async()=>{
  const {state}=await refresh(async()=>stream(
    {done:false,elements:[rows[0]]},
    {done:true,error:'UPSTREAM_DOWN'}
  ));
  assert.ok(state.satellites[0].elements);
  assert.equal(state.satellites[1].elements,rows[1]);
});
