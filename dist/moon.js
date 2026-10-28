import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sampleDanuri } from './orbits.js';

export async function createMoon(container,label) {
  const response=await fetch('/textures/moon.jpg',{signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('달 표면 이미지 HTTP '+response.status);
  const imageURL=URL.createObjectURL(await response.blob());
  let texture;
  try { texture=await new THREE.TextureLoader().loadAsync(imageURL); }
  finally { URL.revokeObjectURL(imageURL); }
  const renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'moon-canvas';
  renderer.domElement.setAttribute('aria-label','달 표면과 다누리 궤적. 드래그로 회전하고 스크롤로 확대합니다.');
  container.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f8fafc');
  const camera = new THREE.PerspectiveCamera(42,1,0.01,100);
  camera.position.set(3.5,1.8,3.5);
  const controls = new OrbitControls(camera,renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 1.35;
  controls.maxDistance = 9;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4,renderer.capabilities.getMaxAnisotropy());
  // Image texture only: no bump, displacement or terrain geometry.
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1,96,48),new THREE.MeshBasicMaterial({map:texture}));
  scene.add(globe);
  const previous = new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:'#2859c5'}));
  const next = new THREE.Line(new THREE.BufferGeometry(),new THREE.LineDashedMaterial({color:'#5f82dd',dashSize:0.025,gapSize:0.018}));
  for (const line of [previous,next]) {
    line.geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(151*3),3));
    line.geometry.setDrawRange(0,0);
    line.frustumCulled=false;
  }
  next.geometry.setAttribute('lineDistance',new THREE.Float32BufferAttribute(new Float32Array(151),1));
  scene.add(previous,next);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1,16,12),new THREE.MeshBasicMaterial({color:'#2859c5'}));
  scene.add(marker);
  let data, time=Date.now(), showTrack=true, initial=true, trackSecond, renderWidth, renderHeight;
  const vector = p=>new THREE.Vector3(p.x,p.z,-p.y).divideScalar(data.radius);

  function render() {
    const width=container.clientWidth,height=container.clientHeight;
    if (!width || !height || container.closest('[hidden]')) return;
    if (width!==renderWidth || height!==renderHeight) {
      renderer.setSize(width,height,false);
      camera.aspect=width/height; camera.updateProjectionMatrix();
      renderWidth=width; renderHeight=height;
    }
    marker.scale.setScalar(camera.position.length()*0.006);
    renderer.render(scene,camera);
    if (!marker.visible) { label.hidden=true; return; }
    const delta=marker.position.clone().sub(camera.position), distance=delta.length(), direction=delta.divideScalar(distance);
    const b=camera.position.dot(direction), discriminant=b*b-camera.position.lengthSq()+1;
    const blocked=discriminant>=0 && -b-Math.sqrt(discriminant)>0 && -b-Math.sqrt(discriminant)<distance-0.01;
    const projected=marker.position.clone().project(camera);
    label.hidden=blocked || Math.abs(projected.x)>1 || Math.abs(projected.y)>1 || projected.z>1;
    label.style.left=((projected.x+1)*width/2)+'px';
    label.style.top=((1-projected.y)*height/2)+'px';
  }

  function reset() {
    const current=sampleDanuri(data,time), later=sampleDanuri(data,time+60000);
    if (current && later) {
      const radial=vector(current).normalize(), normal=vector(current).cross(vector(later)).normalize();
      camera.position.copy(normal.multiplyScalar(0.9).addScaledVector(radial,0.8).normalize().multiplyScalar(4.1));
    } else camera.position.set(3.5,1.8,3.5);
    controls.target.set(0,0,0); controls.update(); render();
  }

  function update(date,track=true) {
    time=Number(date); showTrack=track;
    const p=sampleDanuri(data,time);
    marker.visible=Boolean(p);
    previous.visible=next.visible=Boolean(p && showTrack);
    if (p) {
      marker.position.copy(vector(p));
      if (showTrack && trackSecond!==Math.floor(time/1000)) {
        for (const [line,sign] of [[previous,-1],[next,1]]) {
          const positions=line.geometry.getAttribute('position');
          const distances=line.geometry.getAttribute('lineDistance');
          let count=0, distance=0, last;
          for (let i=0;i<=150;i++) {
            const point=sampleDanuri(data,time+sign*i*30000);
            if (!point) continue;
            positions.setXYZ(count,point.x/data.radius,point.z/data.radius,-point.y/data.radius);
            if (distances) {
              if (last) distance+=Math.hypot(point.x-last.x,point.y-last.y,point.z-last.z)/data.radius;
              distances.setX(count,distance);
            }
            last=point; count++;
          }
          positions.needsUpdate=true;
          if (distances) distances.needsUpdate=true;
          line.geometry.setDrawRange(0,count);
        }
        trackSecond=Math.floor(time/1000);
      }
      if (initial) { initial=false; reset(); }
    }
    render();
  }
  controls.addEventListener('change',render);
  new ResizeObserver(render).observe(container);
  update(time);
  return {
    setData(value) { data=value; trackSecond=undefined; update(time,showTrack); }, update, reset,
    zoom(factor) { camera.position.multiplyScalar(1/factor).clampLength(controls.minDistance,controls.maxDistance); controls.update(); render(); }
  };
}
