import * as THREE from 'three/webgpu';
import { normalWorldGeometry, output, texture, vec3, vec4, normalize, positionWorld, cameraPosition, color, uniform, mix, uv, instancedBufferAttribute } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { eciToEcf, gstime } from 'satellite.js';
import { CATALOG, position } from './orbits.js';
import { sunDirection, frameCamera } from './map.js';

const radius=6378.137;
const vector=p=>new THREE.Vector3(p.x,p.z,-p.y).divideScalar(radius);

export async function createEarth(container,label,hoverLabel,onSelect,getViewport) {
  const textureLoader=new THREE.TextureLoader();
  const loadTexture=async name=>{
    const response=await fetch('/textures/'+name,{signal:AbortSignal.timeout(25000)});
    if (!response.ok) throw new Error('지구 이미지 HTTP '+response.status);
    const imageURL=URL.createObjectURL(await response.blob());
    try { return await textureLoader.loadAsync(imageURL); }
    finally { URL.revokeObjectURL(imageURL); }
  };
  const [dayTexture,nightTexture,detailTexture]=await Promise.all([
    loadTexture('earth_day_4096.jpg'),loadTexture('earth_night_4096.jpg'),loadTexture('earth_bump_roughness_clouds_4096.jpg')
  ]);

  const renderer=new THREE.WebGPURenderer({antialias:true,powerPreference:'low-power'});
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.domElement.className='space-canvas';
  renderer.domElement.setAttribute('role','img');
  renderer.domElement.setAttribute('aria-label','3D 지구와 대한민국 위성의 위치');
  container.prepend(renderer.domElement);
  const scene=new THREE.Scene(), styles=getComputedStyle(container);
  scene.background=new THREE.Color(styles.getPropertyValue('--space-bg').trim());
  const camera=new THREE.PerspectiveCamera(42,1,.01,300);
  camera.position.set(-10,10,-14);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enablePan=false;
  controls.minDistance=1.15;
  controls.maxDistance=100;
  controls.rotateSpeed=.7;
  controls.zoomSpeed=.8;
  dayTexture.colorSpace=nightTexture.colorSpace=THREE.SRGBColorSpace;
  dayTexture.anisotropy=detailTexture.anisotropy=Math.min(8,renderer.getMaxAnisotropy());
  const sunlight=new THREE.DirectionalLight('#ffffff',2);
  sunlight.position.set(0,0,3);
  scene.add(sunlight);

  // Rendering and maps from the Three.js r186 TSL Earth example (MIT).
  // https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_earth.html
  const atmosphereDayColor=uniform(color('#4db2ff'));
  const atmosphereTwilightColor=uniform(color('#bc490b'));
  const sunVector=uniform(new THREE.Vector3(0,0,1));
  const viewDirection=positionWorld.sub(cameraPosition).normalize();
  const fresnel=viewDirection.dot(normalWorldGeometry).abs().oneMinus().toVar();
  const sunOrientation=normalWorldGeometry.dot(normalize(sunVector)).toVar();
  const atmosphereColor=mix(atmosphereTwilightColor,atmosphereDayColor,sunOrientation.smoothstep(-.25,.75));
  const globeMaterial=new THREE.MeshLambertNodeMaterial();
  const cloudsStrength=texture(detailTexture,uv()).b.smoothstep(.2,1);
  globeMaterial.colorNode=mix(texture(dayTexture),vec3(1),cloudsStrength.mul(2));
  const night=texture(nightTexture);
  const dayStrength=sunOrientation.smoothstep(-.25,.5);
  const atmosphereDayStrength=sunOrientation.smoothstep(-.5,1);
  const atmosphereMix=atmosphereDayStrength.mul(fresnel.pow(2)).clamp(0,1);
  let finalOutput=mix(night.rgb,output.rgb,dayStrength);
  finalOutput=mix(finalOutput,atmosphereColor,atmosphereMix);
  globeMaterial.outputNode=vec4(finalOutput,output.a);
  const sphereGeometry=new THREE.SphereGeometry(1,64,64);
  scene.add(new THREE.Mesh(sphereGeometry,globeMaterial));
  const atmosphereMaterial=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,transparent:true,depthWrite:false});
  const alpha=fresnel.remap(.73,1,1,0).pow(3).mul(sunOrientation.smoothstep(-.5,1));
  atmosphereMaterial.outputNode=vec4(atmosphereColor,alpha);
  const atmosphere=new THREE.Mesh(sphereGeometry,atmosphereMaterial);
  atmosphere.scale.setScalar(1.04);
  scene.add(atmosphere);

  const dot=document.createElement('canvas'); dot.width=dot.height=32;
  const context=dot.getContext('2d');
  context.fillStyle='#ffffff'; context.beginPath(); context.arc(16,16,15,0,Math.PI*2); context.fill();
  const dotTexture=new THREE.CanvasTexture(dot);
  // Instanced sprites preserve pixel-sized markers on both WebGPU and WebGL2.
  const coordinates=new THREE.InstancedBufferAttribute(new Float32Array(CATALOG.length*3),3).setUsage(THREE.DynamicDrawUsage);
  const colors=new THREE.InstancedBufferAttribute(new Float32Array(CATALOG.length*3),3).setUsage(THREE.DynamicDrawUsage);
  const dots=new THREE.Sprite(new THREE.PointsNodeMaterial({
    positionNode:instancedBufferAttribute(coordinates),
    colorNode:vec4(instancedBufferAttribute(colors),texture(dotTexture).a),
    size:5,sizeAttenuation:false,alphaTest:.5
  }));
  dots.count=0;
  dots.frustumCulled=false;
  scene.add(dots);
  const activeColor=new THREE.Color(styles.getPropertyValue('--main').trim());
  const retiredColor=new THREE.Color(styles.getPropertyValue('--muted').trim());
  const futureColor=new THREE.Color(styles.getPropertyValue('--main-bright').trim());
  const selectedCoordinates=new THREE.InstancedBufferAttribute(new Float32Array(3),3).setUsage(THREE.DynamicDrawUsage);
  const selectedDot=new THREE.Sprite(new THREE.PointsNodeMaterial({
    positionNode:instancedBufferAttribute(selectedCoordinates),map:dotTexture,color:activeColor,size:9,sizeAttenuation:false,alphaTest:.5
  }));
  selectedDot.frustumCulled=false; selectedDot.visible=false;
  scene.add(selectedDot);

  const previous=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:activeColor}));
  const next=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineDashedMaterial({color:futureColor,dashSize:.06,gapSize:.04}));
  for (const line of [previous,next]) {
    line.geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(161*3),3));
    line.geometry.setDrawRange(0,0);
    line.frustumCulled=false;
  }
  next.geometry.setAttribute('lineDistance',new THREE.Float32BufferAttribute(new Float32Array(161),1));
  scene.add(previous,next);

  const gridVertices=[];
  const globePoint=(lon,lat)=>{
    const a=lon*Math.PI/180,b=lat*Math.PI/180;
    return [1.002*Math.cos(b)*Math.cos(a),1.002*Math.sin(b),-1.002*Math.cos(b)*Math.sin(a)];
  };
  for (let lat=-60;lat<=60;lat+=30) for (let lon=-180;lon<180;lon+=3) gridVertices.push(...globePoint(lon,lat),...globePoint(lon+3,lat));
  for (let lon=-180;lon<180;lon+=30) for (let lat=-90;lat<90;lat+=3) gridVertices.push(...globePoint(lon,lat),...globePoint(lon,lat+3));
  const gridGeometry=new THREE.BufferGeometry();
  gridGeometry.setAttribute('position',new THREE.Float32BufferAttribute(gridVertices,3));
  const grid=new THREE.LineSegments(gridGeometry,new THREE.LineBasicMaterial({color:retiredColor,transparent:true,opacity:.35}));
  grid.visible=false; scene.add(grid);

  let entries=[], selected, hovered, pointer, initial=true, trackSecond, trackElements, renderWidth, renderHeight;

  function screenPoint(entry) {
    if (!entry) return null;
    const delta=entry.vector.clone().sub(camera.position), distance=delta.length();
    if (distance<.000001) return null;
    const b=camera.position.dot(delta)/distance, discriminant=b*b-camera.position.lengthSq()+1;
    const near=-b-Math.sqrt(Math.max(0,discriminant));
    if (discriminant>=0 && near>0 && near<distance-.001) return null;
    const projected=entry.vector.clone().project(camera);
    const nearPlane=camera.coordinateSystem===THREE.WebGPUCoordinateSystem ? 0 : -1;
    if (Math.abs(projected.x)>1 || Math.abs(projected.y)>1 || projected.z<nearPlane || projected.z>1) return null;
    return {x:(projected.x+1)*container.clientWidth/2,y:(1-projected.y)*container.clientHeight/2};
  }

  function placeLabel(element,entry) {
    const point=screenPoint(entry);
    element.hidden=!point;
    if (!point) return;
    element.textContent=entry.sat.name;
    element.style.left=Math.max(0,Math.min(point.x,container.clientWidth-element.offsetWidth-16))+'px';
    element.style.top=Math.max(12,Math.min(point.y,container.clientHeight-12))+'px';
  }

  function render() {
    const width=container.clientWidth,height=container.clientHeight;
    if (!width || !height || container.closest('[hidden]')) return;
    if (width!==renderWidth || height!==renderHeight) {
      renderer.setSize(width,height,false);
      renderWidth=width; renderHeight=height;
    }
    frameCamera(camera,width,height,getViewport());
    renderer.render(scene,camera);
    placeLabel(label,entries.find(entry=>entry.sat.id===selected));
    placeLabel(hoverLabel,hovered===selected ? null : entries.find(entry=>entry.sat.id===hovered));
  }

  function reset() {
    const extent=Math.max(1.2,...entries.map(entry=>entry.vector.length()));
    const angle=frameCamera(camera,container.clientWidth,container.clientHeight,getViewport());
    const distance=Math.min(controls.maxDistance,extent/Math.sin(angle)*1.15);
    // Start above Korea, with the full GEO belt inside the view.
    camera.position.set(-.49,.57,-.66).normalize().multiplyScalar(distance);
    controls.target.set(0,0,0); controls.update(); render();
  }

  function update(rows,date,selectedId,showGrid) {
    const time=Number(date), second=Math.floor(time/1000);
    entries=rows.map(row=>({...row,vector:vector(row.point.ecf)}));
    selected=selectedId;
    entries.forEach((entry,index)=>{
      coordinates.setXYZ(index,entry.vector.x,entry.vector.y,entry.vector.z);
      const color=entry.sat.status==='retired' ? retiredColor : activeColor;
      colors.setXYZ(index,color.r,color.g,color.b);
    });
    coordinates.needsUpdate=colors.needsUpdate=true;
    dots.count=entries.length;
    const chosen=entries.find(entry=>entry.sat.id===selected);
    selectedDot.visible=Boolean(chosen);
    if (chosen) {
      selectedCoordinates.setXYZ(0,chosen.vector.x,chosen.vector.y,chosen.vector.z); selectedCoordinates.needsUpdate=true;
    }
    previous.visible=next.visible=Boolean(chosen);
    if (chosen && (trackSecond!==second || trackElements!==chosen.sat.elements)) {
      const sidereal=gstime(date), span=Math.min(chosen.point.period/2,720)*60000;
      // Freeze Earth's orientation for the orbit curve. Rotating each sample at
      // its own time would collapse a geostationary orbit into a stationary dot.
      for (const [line,sign] of [[previous,-1],[next,1]]) {
        const attribute=line.geometry.getAttribute('position'), distances=line.geometry.getAttribute('lineDistance');
        let count=0, distance=0, last;
        for (let i=0;i<=160;i++) {
          const point=position(chosen.sat,new Date(time+sign*i/160*span));
          if (!point) break;
          const current=vector(eciToEcf(point.eci,sidereal));
          attribute.setXYZ(count,current.x,current.y,current.z);
          if (distances) {
            if (last) distance+=current.distanceTo(last);
            distances.setX(count,distance);
          }
          last=current; count++;
        }
        attribute.needsUpdate=true;
        if (distances) distances.needsUpdate=true;
        line.geometry.setDrawRange(0,count);
      }
      trackSecond=second; trackElements=chosen.sat.elements;
    }
    grid.visible=showGrid;
    const sun=sunDirection(date);
    sunlight.position.set(sun.x,sun.z,-sun.y).multiplyScalar(30);
    sunVector.value.copy(sunlight.position).normalize();
    renderer.domElement.setAttribute('aria-label',`3D 지구와 위성 ${entries.length}기의 위치. 위성을 선택하거나 지구를 회전할 수 있습니다.`);
    if (initial && entries.length) { initial=false; reset(); }
    else render();
  }

  function pick(event) {
    const box=renderer.domElement.getBoundingClientRect(), x=event.clientX-box.left,y=event.clientY-box.top;
    let best, distance=12;
    for (const entry of entries) {
      const point=screenPoint(entry);
      if (!point) continue;
      const delta=Math.hypot(point.x-x,point.y-y);
      if (delta<distance) { best=entry.sat.id; distance=delta; }
    }
    return best;
  }
  renderer.domElement.addEventListener('pointerdown',event=>{
    if (!event.isPrimary) { pointer=undefined; return; }
    if (event.button===0) pointer={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
  });
  renderer.domElement.addEventListener('pointermove',event=>{
    if (pointer?.id===event.pointerId && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>4) pointer.moved=true;
    if (pointer?.moved || event.pointerType==='touch') {
      if (hovered!==undefined) { hovered=undefined; render(); }
      return;
    }
    const id=pick(event);
    renderer.domElement.style.cursor=id===undefined ? 'grab' : 'pointer';
    if (id!==hovered) { hovered=id; render(); }
  });
  renderer.domElement.addEventListener('pointerup',event=>{
    if (pointer?.id!==event.pointerId) return;
    const moved=pointer.moved; pointer=undefined;
    if (!moved) { const id=pick(event); if (id!==undefined) onSelect(id); }
  });
  renderer.domElement.addEventListener('pointercancel',()=>{pointer=undefined;});
  renderer.domElement.addEventListener('pointerleave',()=>{hovered=undefined; render();});
  controls.addEventListener('change',render);
  new ResizeObserver(render).observe(container);
  render();
  return {
    update, reset,
    zoom(factor) { camera.position.multiplyScalar(1/factor).clampLength(controls.minDistance,controls.maxDistance); controls.update(); render(); }
  };
}
