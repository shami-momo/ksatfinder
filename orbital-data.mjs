import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, parseElements } from './dist/orbits.js';

const cacheFile = process.env.ORBIT_CACHE_FILE || (process.env.VERCEL ? join(tmpdir(),'ksatfinder-orbits.json') : fileURLToPath(new URL('./data/orbits.json', import.meta.url)));
const day = 86400000;
const ids = CATALOG.map(s => s.id);
const wanted = new Set(ids);
const listeners = new Set();
let cached;
let pending;
try {
  const data = JSON.parse(await readFile(cacheFile, 'utf8'));
  if (Number.isFinite(Date.parse(data.fetchedAt)) && Array.isArray(data.elements)) cached = data;
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('일일 궤도자료 파일을 읽지 못했습니다.');
}

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

export async function catalog(onProgress, {force=false} = {}) {
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  if (!force && !pending && age >= 0 && age < day) {
    const valid = parseElements(cached.elements);
    const elements = [...valid.values()];
    const available = new Set(elements.map(row => Number(row.NORAD_CAT_ID)));
    const data = {...cached,elements,unavailable:ids.filter(id => !available.has(id)),done:true,dailyCache:true};
    onProgress?.(data);
    return data;
  }
  if (onProgress) listeners.add(onProgress);
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
    const publish = done => {
      const data = snapshot(done);
      for (const listener of listeners) listener(data);
      return data;
    };
    try {
      accept(orbitalWikiRows(await getJSON('https://www.orbitalwiki.com/api/v1/elements','OrbitalWiki',signal)));
      publish(false);
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
      publish(false);
    }
    if (!elements.size) throw new Error(errors[0] || '최근 7일 이내의 궤도자료가 없습니다.');
    const data = snapshot(true);
    const temporary = cacheFile + '.' + process.pid + '.tmp';
    try {
      await writeFile(temporary,JSON.stringify(data,null,2) + '\n','utf8');
      await rename(temporary,cacheFile);
    } catch {
      data.warnings = [...(data.warnings || []),'일일 궤도자료 파일 저장 실패'];
      console.warn('일일 궤도자료 파일 저장 실패');
    }
    cached = data;
    for (const listener of listeners) listener(data);
    return data;
  })().finally(() => { pending = null; });
  try { return await pending; }
  finally { if (onProgress) listeners.delete(onProgress); }
}

export function stopProgress(listener) { listeners.delete(listener); }
