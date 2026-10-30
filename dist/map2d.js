import { position, sampleDanuri } from './orbits.js';
import { sunDirection, LAUNCH_SITES, createLaunchMarker, positionLaunchMarker } from './map.js';

const $=selector=>document.querySelector(selector);

const intersects = (a,b) => a.x < b.x+b.width+4 && a.x+a.width+4 > b.x && a.y < b.y+b.height+4 && a.y+a.height+4 > b.y;

function project(lon, lat, view) {
  return {x:view.cx+lon/360*view.width*view.zoom+view.x,y:view.cy-lat/180*view.height*view.zoom+view.y};
}


// Only selected, hovered and focused labels need placement, usually at most three.
function layoutMarkers(points, width, height, obstacles=[]) {
  const occupied=[...obstacles];
  return [...points].sort((a,b)=>Number(b.selected)-Number(a.selected)).map(point=>{
    const w=Math.min(point.labelWidth,width-16), h=point.selected ? 24 : 18;
    let best, bestScore=Infinity;
    for (let ring=0;ring<4;ring++) {
      const gap=12+ring*24;
      const offsets=[[gap,-h/2],[-gap-w,-h/2],[-w/2,-gap-h],[-w/2,gap],[gap,-gap-h],[-gap-w,-gap-h],[gap,gap],[-gap-w,gap]];
      for (const [dx,dy] of offsets) {
        const box={x:Math.max(8,Math.min(width-w-8,point.x+dx)),y:Math.max(8,Math.min(height-h-8,point.y+dy)),width:w,height:h};
        const overlaps=occupied.reduce((sum,p)=>sum+(intersects(box,p) ? (p.weight ?? 100) : 0),0);
        const score=overlaps*100000+Math.hypot(Math.max(box.x,Math.min(box.x+w,point.x))-point.x,box.y+h/2-point.y);
        if (score<bestScore) { best=box; bestScore=score; }
      }
      if (bestScore<100000) break;
    }
    occupied.push(best);
    return {...point,label:best};
  });
}

// Split a ground track at the map seam, extending both halves to the map edges.
function wrapTrack(points, width) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (!point) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    const previous = current.at(-1);
    if (previous && Math.abs(point.x - previous.x) > width / 2) {
      const rightward = point.x < previous.x;
      const unwrappedX = point.x + (rightward ? width : -width);
      const boundaryX = rightward ? width : 0;
      const fraction = (boundaryX - previous.x) / (unwrappedX - previous.x);
      const boundaryY = previous.y + fraction * (point.y - previous.y);
      current.push({ x: boundaryX, y: boundaryY });
      segments.push(current);
      current = [{ x: rightward ? 0 : width, y: boundaryY }];
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}


// Reuse the longitude terms across rows; avoid trigonometry for every pixel.
function nightMask(time,width=720,height=360) {
  const sun=sunDirection(time);
  const length=Math.hypot(sun.x,sun.y,sun.z), twilight=Math.sin(12*Math.PI/180);
  const longitude=Array.from({length:width},(_,x)=>{
    const angle=((x+.5)*360/width-180)*Math.PI/180;
    return (Math.cos(angle)*sun.x+Math.sin(angle)*sun.y)/length;
  });
  const pixels=new Uint8ClampedArray(width*height*4), shade=new Uint8ClampedArray(width*height*4);
  for (let y=0;y<height;y++) {
    const lat=(90-(y+.5)*180/height)*Math.PI/180;
    const vertical=Math.sin(lat)*sun.z/length, horizontal=Math.cos(lat);
    for (let x=0;x<width;x++) {
      const index=(y*width+x)*4;
      const sunlight=vertical+horizontal*longitude[x];
      const amount=Math.max(0,Math.min(1,-sunlight/twilight));
      shade[index+3]=Math.round(255*.5*(1-Math.sqrt(Math.max(0,sunlight))));
      pixels[index]=0; pixels[index+1]=0; pixels[index+2]=0;
      pixels[index+3]=Math.round(255*amount*amount*(3-2*amount));
    }
  }
  return {pixels,shade,width,height};
}


export function createMap2D({onSelect,onChange,positionAt,isActive}) {
  const canvas = $('#map'), ctx = canvas.getContext('2d');
  function readPalette() {
    const styles=getComputedStyle(document.documentElement);
    return Object.fromEntries(['main','main-bright','muted','line-soft','marker-outline'].map(key=>[key,styles.getPropertyValue(`--${key}`).trim()]));
  }
  const palette=readPalette();
  const color=sat=>sat.status==='retired' ? palette.muted : palette.main;
  const state={map:{zoom:1,x:0,y:0},followSelected:true,hovered:null,focused:null};
  let drag, surfaceImage;
  let earthTextureError='';
  const markerButtons=new Map(), launchButtons=new Map();
  const nightCanvas=document.createElement('canvas'), nightContext=nightCanvas.getContext('2d');
  const maskCanvas=document.createElement('canvas'), maskContext=maskCanvas.getContext('2d');
  maskCanvas.width=720; maskCanvas.height=360;
  const shadeCanvas=document.createElement('canvas'), shadeContext=shadeCanvas.getContext('2d');
  shadeCanvas.width=720; shadeCanvas.height=360;
  const cloudCanvas=document.createElement('canvas'), cloudContext=cloudCanvas.getContext('2d');
  cloudCanvas.width=2048; cloudCanvas.height=1024;
  let nightImage, maskKey, nightKey, trackCache;

  function flatView() {
    const box=$('#map-wrap').getBoundingClientRect();
    return {...state.map,width:box.height*2,height:box.height,cx:box.width/2,cy:box.height/2};
  }

  function sizeCanvas() {
    const box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (!box.width || !box.height) return null;
    const width = Math.round(box.width * dpr), height = Math.round(box.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(canvas.width / box.width, 0, 0, canvas.height / box.height, 0, 0);
    return { w: box.width, h: box.height };
  }

  async function loadEarthTextures() {
    try {
      const images=await Promise.all(['earth_day_4096.jpg','earth_night_4096.jpg'].map(async name=>{
        const image=new Image(); image.src='/textures/'+name;
        await image.decode(); return image;
      }));
      nightImage=images[1];
      nightCanvas.width=nightImage.naturalWidth; nightCanvas.height=nightImage.naturalHeight;
      $('#map-message').hidden=true;
      onChange();
    } catch { earthTextureError='지구 이미지를 불러오지 못했습니다. 새로고침해 주세요.'; onChange(); return; }
    // Clouds are optional; the day/night map is already usable while they load.
    try {
      const clouds=new Image(); clouds.src='/textures/earth_bump_roughness_clouds_4096.jpg';
      await clouds.decode();
      cloudContext.drawImage(clouds,0,0,cloudCanvas.width,cloudCanvas.height);
      const image=cloudContext.getImageData(0,0,cloudCanvas.width,cloudCanvas.height), pixels=image.data;
      for (let i=0;i<pixels.length;i+=4) {
        const strength=Math.max(0,Math.min(1,(pixels[i+2]/255-.2)/.8));
        pixels[i]=pixels[i+1]=pixels[i+2]=255;
        pixels[i+3]=Math.round(255*.38*strength*strength*(3-2*strength));
      }
      cloudContext.putImageData(image,0,0);
      onChange();
    } catch {}
  }

  function renderLaunchSites(w,h,view) {
    const visible=new Set(), width=view.width*view.zoom;
    for (const site of LAUNCH_SITES) {
      const point=project(site.lon,site.lat,view);
      if (point.y<0 || point.y>h) continue;
      for (let copy=-Math.floor(point.x/width);point.x+copy*width<w;copy++) {
        const x=point.x+copy*width;
        if (x<0) continue;
        const key=site.id+':'+copy;
        visible.add(key);
        let button=launchButtons.get(key);
        if (!button) {
          button=createLaunchMarker(site); launchButtons.set(key,button); $('#launch-sites').append(button);
        }
        positionLaunchMarker(button,site,x,point.y,w);
      }
    }
    for (const [key,button] of launchButtons) if (!visible.has(key)) { button.remove(); launchButtons.delete(key); }
  }

  function worldTiles(view,screenWidth) {
    const width=view.width*view.zoom, start=project(-180,90,view), tiles=[];
    const first=start.x-Math.ceil(start.x/width)*width;
    for (let x=first;x<screenWidth;x+=width) tiles.push({x,y:start.y});
    return tiles;
  }

  function drawGrid(w,h,view) {
    const start=project(-180,90,view), end=project(180,-90,view), width=view.width*view.zoom;
    ctx.save();
    ctx.globalAlpha=.35;
    ctx.strokeStyle=palette['line-soft']; ctx.lineWidth=.7;
    const step=view.zoom<2 ? 30 : view.zoom<4 ? 10 : 5;
    for (const tile of worldTiles(view,w)) {
      for (let lon=-180;lon<180;lon+=step) {
        const x=tile.x+(lon+180)/360*width;
        if (x<0 || x>w) continue;
        ctx.beginPath(); ctx.moveTo(x,start.y); ctx.lineTo(x,end.y); ctx.stroke();
      }
    }
    for (let lat=-90;lat<=90;lat+=step) {
      const {y}=project(0,lat,view);
      if (y<0 || y>h) continue;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    }
    ctx.restore();
  }

  function updateSolarMasks(time) {
    const key=Math.floor(Number(time)/15000);
    if (maskKey!==key) {
      const {pixels,shade,width,height}=nightMask(time);
      maskContext.putImageData(new ImageData(pixels,width,height),0,0);
      shadeContext.putImageData(new ImageData(shade,width,height),0,0);
      maskKey=key;
    }
    return key;
  }

  function drawNight(w,time,view) {
    if (!nightImage) return;
    const key=updateSolarMasks(time);
    if (nightKey!==key) {
      nightContext.clearRect(0,0,nightCanvas.width,nightCanvas.height);
      nightContext.drawImage(nightImage,0,0);
      nightContext.globalCompositeOperation='destination-in';
      nightContext.drawImage(maskCanvas,0,0,nightCanvas.width,nightCanvas.height);
      nightContext.globalCompositeOperation='source-over';
      nightKey=key;
    }
    for (const {x,y} of worldTiles(view,w)) {
      const width=view.width*view.zoom, height=view.height*view.zoom;
      ctx.drawImage(cloudCanvas,x,y,width,height);
      ctx.drawImage(shadeCanvas,x,y,width,height);
      ctx.drawImage(nightCanvas,x,y,width,height);
    }
  }

  function drawTrack(sat, time, w, h, view, moonData) {
    const lunar=sat.id==='danuri', source=lunar ? moonData : sat.elements;
    if (!source) return;
    const second=Math.floor(Number(time)/1000);
    if (trackCache?.second!==second || trackCache.source!==source) {
      const span=lunar ? 75 : Math.min(1440/sat.elements.MEAN_MOTION*.75,180);
      const tracks=[-1,1].map(sign=>Array.from({length:161},(_,i)=>{
        const date=new Date(Number(time)+sign*i/160*span*60000);
        return lunar ? sampleDanuri(moonData,date) : position(sat,date);
      }));
      trackCache={second,source,tracks};
    }
    const width=view.width*view.zoom, tiles=worldTiles(view,w);
    for (const [index,track] of trackCache.tracks.entries()) {
      const future=index===1;
      const samples=track.map(p=>p ? {x:(p.lon+180)/360*width,y:(90-p.lat)/180*view.height*view.zoom} : null);
      const segments=wrapTrack(samples,width);
      for (const tile of tiles) {
        ctx.save(); ctx.translate(tile.x,tile.y);
        ctx.strokeStyle=future ? palette['main-bright'] : palette.main; ctx.lineWidth=2; ctx.setLineDash(future ? [5,4] : []);
        for (const segment of segments) {
          if (segment.length<2) continue;
          ctx.beginPath(); ctx.moveTo(segment[0].x,segment[0].y);
          for (const p of segment.slice(1)) ctx.lineTo(p.x,p.y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  function render({time,moon,moonData,moonError,moonSurfaceReady,earthStyle,satellites:visible,selected:chosen}) {
    const size=sizeCanvas();
    if (!size) return;
    const {w,h}=size;
    const image=moon ? '/textures/moon.jpg' : earthStyle==='map' ? '/world.svg' : '/textures/earth_day_4096.jpg';
    if (surfaceImage!==image) {
      $('#world-map').style.backgroundImage='url("'+image+'")';
      surfaceImage=image;
    }
    const message=$('#map-message');
    message.hidden=moon ? Boolean(moonData && moonSurfaceReady) : earthStyle==='map' || Boolean(nightImage);
    message.textContent=moon ? moonError || (moonSurfaceReady ? '다누리 궤적을 불러오는 중' : '달 이미지를 불러오는 중') : earthTextureError || '지구 이미지를 불러오는 중';
    let view=flatView();
    const target=state.followSelected ? moon ? sampleDanuri(moonData,time) : positionAt(chosen,time) : null;
    if (target) {
      state.map.x=-target.lon/360*view.width*view.zoom;
      clampMap(); view=flatView();
    }
    ctx.clearRect(0,0,w,h);
    const start=project(-180,90,view);
    Object.assign($('#world-map').style,{backgroundPosition:`${start.x}px ${start.y}px`,backgroundSize:`${view.width*view.zoom}px ${view.height*view.zoom}px`});
    if (!moon) {
      if (earthStyle==='satellite') drawNight(w,time,view);
      else {
        updateSolarMasks(time);
        ctx.save(); ctx.globalAlpha=.68;
        for (const {x,y} of worldTiles(view,w)) ctx.drawImage(maskCanvas,x,y,view.width*view.zoom,view.height*view.zoom);
        ctx.restore();
      }
    }
    drawGrid(w,h,view);
    if (!moon) renderLaunchSites(w,h,view);
    if (chosen) drawTrack(chosen,time,w,h,view,moonData);
    const points = visible.flatMap(sat => {
      const p=moon ? sampleDanuri(moonData,time) : positionAt(sat,time);
      if (!p) return [];
      const selected=moon || sat.id===chosen?.id, point=project(p.lon,p.lat,view), width=view.width*view.zoom;
      const copies=[], first=-Math.floor(point.x/width);
      for (let copy=first;point.x+copy*width<w;copy++) {
        const x=point.x+copy*width;
        if (x>=0) copies.push({...point,x,sat,selected,key:sat.id+':'+copy});
      }
      return copies;
    });
    const markers = points.filter(p => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h);
    const named=markers.filter(p=>(p.selected && Math.abs(p.x-w/2)<=view.width*view.zoom/2) || p.key===state.hovered || p.key===state.focused);
    for (const point of named) {
      ctx.font=point.selected ? '500 12px Pretendard' : '500 10px Pretendard';
      point.labelWidth=Math.ceil(ctx.measureText(point.sat.name).width)+12;
    }
    const dots = markers.map(p => ({x:p.x-4,y:p.y-4,width:8,height:8,weight:1}));
    const labels = new Map(layoutMarkers(named,w,h,dots).map(p => [p.key,p.label]));
    const markerIds = new Set();
    for (const { x,y,sat,selected,key } of [...markers].sort((a,b) => Number(a.selected)-Number(b.selected))) {
      const label = labels.get(key);
      if (label) {
        const edgeX = Math.max(label.x,Math.min(label.x+label.width,x));
        const edgeY = Math.max(label.y,Math.min(label.y+label.height,y));
        ctx.strokeStyle = selected ? palette.main : color(sat); ctx.lineWidth = selected ? 1.2 : .7;
        ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(edgeX,edgeY); ctx.stroke();
      }
      ctx.fillStyle = selected ? palette.main : color(sat);
      ctx.beginPath(); ctx.arc(x,y,selected ? 3.5 : 2.2,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = palette['marker-outline']; ctx.lineWidth = 1; ctx.stroke();
      markerIds.add(key);
      let button = markerButtons.get(key);
      if (!button) {
        button = document.createElement('button'); button.type = 'button';
        const name = document.createElement('span'); name.className = 'map-marker-label'; name.setAttribute('aria-hidden','true');
        name.textContent = sat.name;
        button.setAttribute('aria-label',sat.name);
        button.append(name);
        button.addEventListener('click',()=>{ if (sat.id==='danuri') { state.followSelected=true; onChange(); } else onSelect(sat.id); });
        button.addEventListener('pointerenter',event => { if (event.pointerType !== 'touch') { state.hovered = key; onChange(); } });
        button.addEventListener('pointerleave',() => { if (state.hovered === key) { state.hovered = null; onChange(); } });
        button.addEventListener('focus',() => { state.focused = key; onChange(); });
        button.addEventListener('blur',() => { if (state.focused === key) { state.focused = null; onChange(); } });
        $('#map-markers').append(button); markerButtons.set(key,button);
      }
      button.className = 'map-marker' + (label ? ' named' : '');
      button.setAttribute('aria-pressed',String(selected));
      button.style.left = (x-8) + 'px'; button.style.top = (y-8) + 'px';
      button.style.setProperty('--marker-color',selected ? palette.main : color(sat));
      const name = button.firstElementChild;
      if (label) {
        name.style.left = (label.x-x+8) + 'px'; name.style.top = (label.y-y+8) + 'px'; name.style.width = label.width + 'px';
      }
    }
    for (const [id,button] of markerButtons) if (!markerIds.has(id)) {
      if (state.hovered === id) state.hovered = null;
      if (state.focused === id) state.focused = null;
      button.remove(); markerButtons.delete(id);
    }
    const names=[...new Set(points.map(p=>p.sat.name))];
    const coverage=`위치 ${new Set(points.map(p=>p.sat.id)).size}/${visible.length}기`;
    canvas.setAttribute('aria-label',`위성 위치 지도. ${names.join(', ')}. ${coverage}`);
  }

  function clampMap() {
    const view=flatView(), width=view.width*view.zoom;
    if (width) state.map.x=((state.map.x+width/2)%width+width)%width-width/2;
    const limitY=view.height*(view.zoom-1)/2;
    state.map.y=Math.max(-limitY,Math.min(limitY,state.map.y));
  }
  function zoom(factor,clientX,clientY) {
    const old=state.map.zoom, next=Math.max(1,Math.min(8,old*factor));
    if (next===old) return;
    state.map.zoom=next;
    if (clientX!==undefined) {
      const box=canvas.getBoundingClientRect(), offsetX=clientX-box.left-box.width/2, offsetY=clientY-box.top-box.height/2;
      state.map.x=offsetX+(state.map.x-offsetX)*next/old;
      state.map.y=offsetY+(state.map.y-offsetY)*next/old;
      state.followSelected=false;
    } else { state.map.x*=next/old; state.map.y*=next/old; }
    clampMap(); onChange();
  }
  $('#map-wrap').addEventListener('wheel',event=>{
    if (!isActive() || !event.deltaY || event.target.closest('.panel-layer')) return;
    event.preventDefault();
    const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? canvas.clientHeight : 1;
    const delta=Math.max(-200,Math.min(200,event.deltaY*unit));
    zoom(Math.exp(-delta*.002),event.clientX,event.clientY);
  },{passive:false});
  canvas.addEventListener('pointerdown',event => {
    if (event.button !== 0) return;
    drag = { pointer:event.pointerId,x:event.clientX,y:event.clientY,startX:state.map.x,startY:state.map.y,moved:false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove',event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
    if (Math.hypot(dx,state.map.zoom>1 ? dy : 0)>4) drag.moved=true;
    if (drag.moved) { state.followSelected=false; state.map.x=drag.startX+dx; state.map.y=drag.startY+dy; clampMap(); onChange(); }
  });
  canvas.addEventListener('pointerup',event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
  });
  canvas.addEventListener('pointercancel',() => { drag = null; });

  loadEarthTextures();
  return {
    render, zoom, clamp:clampMap,
    follow() { state.followSelected=true; },
    reset() { state.map={zoom:1,x:0,y:0}; state.followSelected=true; onChange(); }
  };
}
