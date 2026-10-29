import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Share crawlers read static HTML, so resolve image/page URLs during deployment.
const domain=process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
if (domain) {
  const origin=new URL(domain.includes('://') ? domain : 'https://'+domain).origin;
  for (const page of ['index.html','license.html']) {
    const file=new URL('dist/'+page,import.meta.url);
    const absolute=value=>new URL(new URL(value,origin).pathname,origin).href;
    let html=await readFile(file,'utf8');
    html=html.replace(/(<meta (?:property="og:(?:url|image)"|name="twitter:image") content=")([^"]+)(")/g,(_,before,value,after)=>before+absolute(value)+after);
    html=html.replace(/(<link rel="canonical" href=")([^"]+)(")/g,(_,before,value,after)=>before+absolute(value)+after);
    await writeFile(file,html);
  }
}

// Copy only the dependency files actually requested by the browser.
const files={
  'node_modules/satellite.js/dist/satellite.es.js':'dist/vendor/satellite.es.js',
  'node_modules/three/build/three.module.js':'dist/vendor/three.module.js',
  'node_modules/three/build/three.webgpu.js':'dist/vendor/three.webgpu.js',
  'node_modules/three/build/three.tsl.js':'dist/vendor/three.tsl.js',
  'node_modules/three/build/three.core.js':'dist/vendor/three.core.js',
  'node_modules/three/examples/jsm/controls/OrbitControls.js':'dist/vendor/OrbitControls.js',
  'node_modules/satellite.js/LICENSE.md':'dist/licenses/satellite-LICENSE.txt',
  'node_modules/three/LICENSE':'dist/licenses/three-LICENSE.txt',
  'data/satellites.json':'dist/data/satellites.json'
};
for (const [source,target] of Object.entries(files)) {
  const destination=fileURLToPath(new URL(target,import.meta.url));
  await mkdir(dirname(destination),{recursive:true});
  await copyFile(new URL(source,import.meta.url),destination);
}
