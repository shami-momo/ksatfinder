import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getCache } from '@vercel/functions';

const day=86400000;
// Retry incomplete catalogs sooner, including caches written by older deployments.
const lifetime=(name,data)=>name==='orbits' && data?.unavailable?.length ? 5*60000 : day;
const shared=process.env.VERCEL ? getCache({namespace:process.env.VERCEL_PROJECT_ID || 'ksatfinder'}) : null;
const key=name=>'ksatfinder-'+name+'-v1';
const file=name=>process.env[name==='orbits' ? 'ORBIT_CACHE_FILE' : 'DANURI_CACHE_FILE'] || fileURLToPath(new URL('./data/'+name+'.json',import.meta.url));

export async function readDailyCache(name) {
  try {
    const data=shared ? await shared.get(key(name)) : JSON.parse(await readFile(file(name),'utf8'));
    const age=Date.now()-Date.parse(data?.fetchedAt);
    return age>=0 && age<lifetime(name,data) ? data : null;
  } catch (error) {
    if (error.code!=='ENOENT') console.warn(name+' 캐시 읽기 실패:',error.message);
    return null;
  }
}

export async function writeDailyCache(name,data) {
  try {
    if (shared) {
      const ttl=Math.max(1,Math.floor((Date.parse(data.fetchedAt)+lifetime(name,data)-Date.now())/1000));
      await shared.set(key(name),data,{ttl});
    } else {
      const target=file(name);
      const temporary=target+'.'+process.pid+'.tmp';
      await writeFile(temporary,JSON.stringify(data)+'\n','utf8');
      await rename(temporary,target);
    }
  } catch (error) { console.warn(name+' 캐시 저장 실패:',error.message); }
}
