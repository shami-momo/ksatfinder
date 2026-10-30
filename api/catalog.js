import { CATALOG, parseElements } from '../dist/orbits.js';
import { readDailyCache, writeDailyCache } from '../daily-cache.mjs';

const day = 86400000;
const ids = CATALOG.map(s => s.id);
const wanted = new Set(ids);
const listeners = new Set();
let pending;

function orbitalWikiRows(data) {
  const fields = { NORAD_CAT_ID:'id', EPOCH:'epoch', MEAN_MOTION:'n', ECCENTRICITY:'e', INCLINATION:'i', RA_OF_ASC_NODE:'raan', ARG_OF_PERICENTER:'argp', MEAN_ANOMALY:'m', BSTAR:'bstar' };
  if (!Array.isArray(data?.id) || !Object.values(fields).every(key => Array.isArray(data[key]) && data[key].length === data.id.length)) {
    throw new Error('OrbitalWiki 응답 형식이 올바르지 않습니다.');
  }
  return data.id.flatMap((id,index) => wanted.has(Number(id)) ? [{
    ...Object.fromEntries(Object.entries(fields).map(([field,key]) => [field,data[key][index]])),
    // OrbitalWiki omits these derivatives; satellite.js SGP4 does not use them.
    MEAN_MOTION_DOT:0, MEAN_MOTION_DDOT:0
  }] : []);
}

function satCheckerRows(data, id) {
  const groups = Array.isArray(data) ? data : [data];
  return groups.flatMap(group => group?.orbital_data || []).map(row => row.orbital_elements)
    .filter(row => row && Number(row.NORAD_CAT_ID) === id);
}

async function getJSON(url, provider, signal) {
  try {
    const response = await fetch(url, { headers:{Accept:'application/json'}, signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]) });
    if (!response.ok) throw Object.assign(new Error(provider + ' HTTP ' + response.status), {status:response.status});
    return await response.json();
  } catch (error) {
    if (error.status) throw error;
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause?.code?.includes('TIMEOUT');
    throw new Error(provider + (timeout ? ' 연결 시간 초과' : ' 자료 연결 또는 응답 처리 실패'));
  }
}

async function catalog(onProgress, {force=false} = {}) {
  if (!force && !pending) {
    const saved=await readDailyCache('orbits');
    if (!pending && Array.isArray(saved?.elements)) {
      const elements=[...parseElements(saved.elements).values()];
      if (elements.length) {
        const available=new Set(elements.map(row=>Number(row.NORAD_CAT_ID)));
        const data={...saved,elements,unavailable:ids.filter(id=>!available.has(id)),done:true,delivery:process.env.VERCEL ? 'vercel-cache' : 'local-cache'};
        onProgress?.(data);
        return data;
      }
    }
  }
  if (onProgress) {
    listeners.add(onProgress);
    onProgress({delivery:'upstream',done:false});
  }
  if (!pending) pending = (async () => {
    const signal = AbortSignal.timeout(30000);
    const elements = new Map();
    const errors = [];
    const fetchedAt = new Date().toISOString();
    const accept = rows => {
      const valid = parseElements(rows);
      for (const [id,row] of valid) {
        const previous = elements.get(id);
        if (!previous || row.EPOCH > previous.EPOCH) elements.set(id,row);
      }
    };
    const snapshot = done => ({fetchedAt,elements:[...elements.values()],unavailable:ids.filter(id => !elements.has(id)),done,
      ...(errors.length ? {warnings:[...new Set(errors)]} : {})});
    const publish = () => {
      if (!listeners.size) return;
      const data = {...snapshot(false),delivery:'upstream'};
      for (const listener of listeners) listener(data);
    };
    try {
      accept(orbitalWikiRows(await getJSON('https://www.orbitalwiki.com/api/v1/elements','OrbitalWiki',signal)));
      publish();
    } catch (error) { errors.push(error.message); }
    const missing = ids.filter(id => !elements.has(id));
    const epoch = Date.now() / day + 2440587.5;
    let blocked = false;
    for (let index = 0; index < missing.length && !blocked && !signal.aborted; index += 3) {
      const results = await Promise.allSettled(missing.slice(index,index+3).map(async id => {
        const url = 'https://satchecker.cps.iau.org/tools/get-nearest-omm/?id=' + id + '&id_type=catalog&epoch=' + epoch;
        return satCheckerRows(await getJSON(url,'SatChecker',signal),id);
      }));
      for (const result of results) {
        if (result.status === 'fulfilled') accept(result.value);
        else {
          errors.push(result.reason.message);
          if (result.reason.status === 403 || result.reason.status === 429) blocked = true;
        }
      }
      publish();
    }
    if (!elements.size) throw new Error(errors[0] || '최근 7일 이내의 궤도자료가 없습니다.');
    const data = snapshot(true);
    await writeDailyCache('orbits',data);
    const result={...data,delivery:'upstream'};
    for (const listener of listeners) listener(result);
    return result;
  })().finally(() => { pending = null; });
  try { return await pending; }
  finally { if (onProgress) listeners.delete(onProgress); }
}

export default async function handler(req,res) {
  if (req.method!=='GET') { res.writeHead(405,{Allow:'GET'}); res.end(); return; }
  const params=new URL(req.url,'http://localhost').searchParams;
  const force=params.get('refresh')==='1';
  if (params.get('stream')==='1') {
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send=data=>{if (!res.destroyed) res.write(JSON.stringify(data)+'\n');};
    res.on('close',()=>listeners.delete(send));
    try { await catalog(send,{force}); }
    catch (error) { send({error:error.message,done:true}); }
    res.end();
    return;
  }
  try {
    const data=await catalog(undefined,{force});
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8',
      // Daily data is shared in Runtime Cache; response caches can hide a manual refresh.
      'Cache-Control':'no-store'
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:error.message}));
  }
}
