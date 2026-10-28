import { mkdir, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy only the dependency files actually requested by the browser.
const files={
  'node_modules/satellite.js/dist/satellite.es.js':'dist/vendor/satellite.es.js',
  'node_modules/three/build/three.module.js':'dist/vendor/three.module.js',
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
