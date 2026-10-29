import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getCache } from '@vercel/functions';

const day=86400000;
const shared=process.env.VERCEL ? getCache({namespace:process.env.VERCEL_PROJECT_ID || 'ksatfinder'}) : null;
const key=name=>'ksatfinder-'+name+'-v1';
const file=name=>process.env[name==='orbits' ? 'ORBIT_CACHE_FILE' : 'DANURI_CACHE_FILE'] || fileURLToPath(new URL('./data/'+name+'.json',import.meta.url));

export async function readDailyCache(name) {
  let data;
  if (shared) data=await shared.get(key(name));
  else {
    try { data=JSON.parse(await readFile(file(name),'utf8')); }
    catch (error) {
      if (error.code!=='ENOENT') console.warn(name+' 일일 자료 파일을 읽지 못했습니다.');
      return null;
    }
  }
  const age=Date.now()-Date.parse(data?.fetchedAt);
  return age>=0 && age<day ? data : null;
}

export async function writeDailyCache(name,data) {
  if (shared) {
    const ttl=Math.max(1,Math.floor((Date.parse(data.fetchedAt)+day-Date.now())/1000));
    await shared.set(key(name),data,{ttl});
    return;
  }
  const target=file(name);
  const temporary=target+'.'+process.pid+'.tmp';
  try {
    await writeFile(temporary,JSON.stringify(data)+'\n','utf8');
    await rename(temporary,target);
  } catch { console.warn(name+' 일일 자료 파일 저장 실패'); }
}
