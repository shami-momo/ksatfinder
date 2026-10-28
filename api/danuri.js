import { getDanuri } from '../danuri-data.mjs';

export default async function handler(req,res) {
  if (req.method!=='GET') { res.writeHead(405,{Allow:'GET'}); res.end(); return; }
  try {
    const data=await getDanuri();
    const ttl=Math.max(0,Math.floor((Date.parse(data.fetchedAt)+86400000-Date.now())/1000));
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'Vercel-CDN-Cache-Control':'public, s-maxage='+ttl
    });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:error.message}));
  }
}
