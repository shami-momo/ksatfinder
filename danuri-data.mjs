import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheFile = process.env.DANURI_CACHE_FILE || (process.env.VERCEL ? join(tmpdir(),'ksatfinder-danuri.json') : fileURLToPath(new URL('./data/danuri.json',import.meta.url)));
const day = 86400000;
let pending;

function timestamp(value) {
  const date=value.match(/^(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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

export async function getDanuri() {
  if (pending) return pending;
  pending = (async () => {
    const now = Date.now();
    try {
      const saved = JSON.parse(await readFile(cacheFile,'utf8'));
      if (now-Date.parse(saved.fetchedAt)>=0 && now-Date.parse(saved.fetchedAt)<day && saved.points?.length>1 && saved.points[0].t<=now-90*60000 && saved.points.at(-1).t>=now+90*60000) {
        if (saved.points.every(point=>Number.isFinite(point.earthDistance) && point.earthDistance>0)) return saved;
      }
    } catch (error) { if (error.code!=='ENOENT' && !(error instanceof SyntaxError)) console.warn('다누리 일일 자료를 읽지 못했습니다.'); }
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
    try {
      const temporary = cacheFile+'.'+process.pid+'.tmp';
      await writeFile(temporary,JSON.stringify(data)+'\n');
      await rename(temporary,cacheFile);
    } catch { console.warn('다누리 일일 자료 파일 저장 실패'); }
    return data;
  })().finally(()=>{pending=null;});
  return pending;
}
