import { catalog, stopProgress } from '../orbital-data.mjs';

export default async function handler(req,res) {
  if (req.method!=='GET') { res.writeHead(405,{Allow:'GET'}); res.end(); return; }
  const params=new URL(req.url,'http://localhost').searchParams;
  const force=params.get('refresh')==='1';
  if (params.get('stream')==='1') {
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send=data=>{if (!res.destroyed) res.write(JSON.stringify(data)+'\n');};
    res.on('close',()=>stopProgress(send));
    try { await catalog(send,{force}); }
    catch (error) { send({error:error.message,done:true}); }
    res.end();
    return;
  }
  try {
    const data=await catalog(undefined,{force});
    const ttl=Math.max(0,Math.floor((Date.parse(data.fetchedAt)+86400000-Date.now())/1000));
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'Vercel-CDN-Cache-Control':force ? 'no-store' : 'public, s-maxage='+ttl
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:error.message}));
  }
}
