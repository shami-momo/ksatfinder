import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root=fileURLToPath(new URL('./dist/',import.meta.url));
const path=name=>fileURLToPath(new URL(name,import.meta.url));
const assets={
  '/vendor/satellite.es.js':path('node_modules/satellite.js/dist/satellite.es.js'),
  '/vendor/three.module.js':path('node_modules/three/build/three.module.js'),
  '/vendor/three.core.js':path('node_modules/three/build/three.core.js'),
  '/vendor/OrbitControls.js':path('node_modules/three/examples/jsm/controls/OrbitControls.js'),
  '/licenses/satellite-LICENSE.txt':path('node_modules/satellite.js/LICENSE.md'),
  '/data/satellites.json':path('data/satellites.json')
};
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain','.md':'text/plain'};
let port=Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('PORT must be an integer between 0 and 65535.');
try { await readFile(assets['/vendor/satellite.es.js']); }
catch { console.error('Run "npm install" in the project folder before "npm run dev".'); process.exit(1); }
const {default:catalog}=await import('./api/catalog.js');
const {default:danuri}=await import('./api/danuri.js');
const handlers={'/api/catalog':catalog,'/api/danuri':danuri};
const server=createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (handlers[pathname]) { await handlers[pathname](req,res); return; }
    if (req.method!=='GET' && req.method!=='HEAD') { res.writeHead(405,{Allow:'GET, HEAD'}); res.end(); return; }
    const file=assets[pathname] || resolve(root,pathname==='/' ? 'index.html' : '.'+pathname);
    const type=types[extname(file)];
    if ((!assets[pathname] && !file.startsWith(root)) || !type) { res.writeHead(404); res.end('Not found'); return; }
    const bytes=await readFile(file);
    res.writeHead(200,{'Content-Type':type.startsWith('image/') || type.startsWith('font/') ? type : type+'; charset=utf-8','Cache-Control':pathname.startsWith('/vendor/') || type.startsWith('image/') || type.startsWith('font/') ? 'public, max-age=86400' : 'no-cache'});
    res.end(req.method==='HEAD' ? undefined : bytes);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 404);
    res.end('Not found');
  }
});
server.on('error',error=>{
  if (error.code==='EADDRINUSE' && !process.env.PORT && port<5183) { server.listen(++port,'127.0.0.1'); return; }
  console.error(error.code==='EADDRINUSE' ? 'Port is in use. Set a different PORT.' : error.message);
  process.exitCode=1;
});
server.on('listening',()=>console.log('KSATFiNDER: http://127.0.0.1:'+server.address().port));
server.listen(port,'127.0.0.1');
