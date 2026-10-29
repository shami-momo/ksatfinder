import { readDailyCache, writeDailyCache } from '../daily-cache.mjs';

let pending;
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function timestamp(value) {
  const date=value.match(/^(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!date || !months.includes(date[2])) throw new Error('다누리 궤적 시각 형식이 올바르지 않습니다.');
  return Date.UTC(Number(date[1]),months.indexOf(date[2]),Number(date[3]),Number(date[4]),Number(date[5]),Number(date[6]||0),Number((date[7]||'').padEnd(3,'0').slice(0,3)));
}

function parseHorizons(result) {
  if (!result.includes('Center body name: Danuri') || !result.includes('Target pole/equ : MOON_ME')) throw new Error('다누리 좌표계를 확인할 수 없습니다.');
  const body = result.match(/\$\$SOE([\s\S]*?)\$\$EOE/)?.[1];
  if (!body) throw new Error('다누리 궤적 자료가 없습니다.');
  const points = [];
  for (const line of body.trim().split('\n')) {
    const columns = line.split(',').map(value=>value.trim());
    if (![3,4,5].every(index=>columns[index] && Number.isFinite(Number(columns[index])))) throw new Error('다누리 궤적 응답 형식이 올바르지 않습니다.');
    const t = timestamp(columns[0]);
    const lon = Number(columns[3])*Math.PI/180, lat = Number(columns[4])*Math.PI/180, r = Number(columns[5]);
    if (!Number.isFinite(t) || Math.abs(lat)>Math.PI/2 || r<=1737.4 || (points.length && t<=points.at(-1).t)) throw new Error('유효하지 않은 다누리 궤적입니다.');
    points.push({t,x:r*Math.cos(lat)*Math.cos(lon),y:r*Math.cos(lat)*Math.sin(lon),z:r*Math.sin(lat)});
  }
  if (points.length<2) throw new Error('다누리 궤적 구간이 부족합니다.');
  return points;
}

function parseEarthDistances(result) {
  if (!result.includes('Center body name: Danuri') || !/Target body name:\s+Earth \(399\)/.test(result)) throw new Error('지구 거리 자료의 대상을 확인할 수 없습니다.');
  const body=result.match(/\$\$SOE([\s\S]*?)\$\$EOE/)?.[1];
  if (!body) throw new Error('지구 거리 자료가 없습니다.');
  const distances=new Map();
  for (const line of body.trim().split('\n')) {
    const columns=line.split(',').map(value=>value.trim());
    const distance=Number(columns[3]);
    if (!columns[3] || !Number.isFinite(distance) || distance<=0) throw new Error('지구 거리 자료가 올바르지 않습니다.');
    distances.set(timestamp(columns[0]),distance);
  }
  return distances;
}

async function requestHorizons(params) {
  let response;
  try { response=await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?'+params,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}}); }
  catch { throw new Error('NASA/JPL Horizons 연결에 실패했습니다.'); }
  if (!response.ok) throw new Error('NASA/JPL Horizons HTTP '+response.status);
  const body=await response.json();
  if (body.error || typeof body.result!=='string') throw new Error('NASA/JPL에서 다누리 궤적을 제공하지 못했습니다.');
  return body.result;
}

async function getDanuri() {
  if (pending) return pending;
  pending = (async () => {
    const now = Date.now();
    const saved=await readDailyCache('danuri');
    if (saved?.points?.length>1 && saved.points[0].t<=now-90*60000 && saved.points.at(-1).t>=now+90*60000) {
      if (saved.points.every(point=>Number.isFinite(point.earthDistance) && point.earthDistance>0)) return saved;
    }
    const start = Math.floor(now/60000)*60000-3*3600000;
    const end = start+30*3600000;
    const format = time=>new Date(time).toISOString().slice(0,19).replace('T',' ');
    const params = new URLSearchParams({format:'json',COMMAND:"'301'",EPHEM_TYPE:"'OBSERVER'",CENTER:"'500@-155'",START_TIME:"'"+format(start)+"'",STOP_TIME:"'"+format(end)+"'",STEP_SIZE:"'1 m'",QUANTITIES:"'14,20'",RANGE_UNITS:"'KM'",ANG_FORMAT:"'DEG'",CSV_FORMAT:"'YES'",TIME_DIGITS:"'FRACSEC'",OBJ_DATA:"'NO'",EXTRA_PREC:"'YES'"});
    const earthParams=new URLSearchParams(params);
    earthParams.set('COMMAND',"'399'"); earthParams.set('QUANTITIES',"'20'");
    const [positions,distances]=await Promise.all([
      requestHorizons(params).then(parseHorizons),
      requestHorizons(earthParams).then(parseEarthDistances)
    ]);
    const points=positions.map(point=>({...point,earthDistance:distances.get(point.t)}));
    if (!points.every(point=>Number.isFinite(point.earthDistance))) throw new Error('일치하는 시각의 지구 거리 자료가 없습니다.');
    const data = {fetchedAt:new Date().toISOString(),frame:'MOON_ME',radius:1737.4,points};
    await writeDailyCache('danuri',data);
    return data;
  })().finally(()=>{pending=null;});
  return pending;
}

export default async function handler(req,res) {
  if (req.method!=='GET') { res.writeHead(405,{Allow:'GET'}); res.end(); return; }
  try {
    const data=await getDanuri();
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store'
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:error.message}));
  }
}
