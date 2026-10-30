import { CATALOG, STATUS_LABELS, parseElements, position, sampleDanuri, LUNAR_ORBIT_INSERTION } from './orbits.js';
import { project, layoutMarkers, wrapTrack, nightMask, LAUNCH_SITES, createLaunchMarker, positionLaunchMarker } from './map.js';

const $ = selector => document.querySelector(selector);
const detail = Object.fromEntries([...$('#detail').querySelectorAll('[data-detail]')].map(element => [element.dataset.detail, element]));
const DANURI = {
  id:'danuri', name:'다누리', english:'Korea Pathfinder Lunar Orbiter · KPLO', group:'달 궤도', agency:'한국항공우주연구원',
  launched:'2022-08-04', vehicle:'팰컨 9 (스페이스X)', site:'미국 케이프커내버럴 우주군기지', description:'우리나라 최초의 달 궤도선.'
};
const canvas = $('#map'), ctx = canvas.getContext('2d');
const longitudeAxis = $('#longitude-axis'), axisCtx = longitudeAxis.getContext('2d');
const latitudeAxis = $('#latitude-axis'), latCtx = latitudeAxis.getContext('2d');
function readPalette() {
  const styles=getComputedStyle(document.documentElement);
  return Object.fromEntries(['main','main-bright','muted','line-soft','marker-outline'].map(key=>[key,styles.getPropertyValue(`--${key}`).trim()]));
}
const palette=readPalette();
const state = {
  satellites: CATALOG.map((s,index) => ({ ...s, number:String(index+1).padStart(2,'0'), elements:null })), selected: 22077,
  hovered: null, focused: null, filter: 'ALL', status: 'ALL', query: '', view: 'earth', earthMode:'2d', moonMode:'3d', earthStyle:'satellite', followSelected:true,
  map: { zoom: 1, x: 0, y: 0 }
};
let drag, viewport, currentTime=new Date();
const compact=matchMedia('(max-width:1000px)'), panels=$('.panel-layer');
let moonView, moonData, moonPromise, moonError='', moonRetryAfter=0, moonSurfaceReady=false;
let earthTextureError='';
let earthView, earthPromise, earthRetryAfter=0;
const markerButtons = new Map(), launchButtons=new Map();
const positions = new Map();
const nightCanvas=document.createElement('canvas'), nightContext=nightCanvas.getContext('2d');
const maskCanvas=document.createElement('canvas'), maskContext=maskCanvas.getContext('2d');
maskCanvas.width=720; maskCanvas.height=360;
const shadeCanvas=document.createElement('canvas'), shadeContext=shadeCanvas.getContext('2d');
shadeCanvas.width=720; shadeCanvas.height=360;
const cloudCanvas=document.createElement('canvas'), cloudContext=cloudCanvas.getContext('2d');
cloudCanvas.width=2048; cloudCanvas.height=1024;
let nightImage, maskKey, nightKey, trackCache, drawRequest;
const timeFormatter = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const koreanTime = date => timeFormatter.format(date);
const clockFormatter=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const activeSats = () => state.satellites.filter(s => (state.filter === 'ALL' || s.group === state.filter) && (state.status === 'ALL' || s.status === state.status) && `${s.name} ${s.english} ${s.id} ${s.agency} ${s.description}`.toLowerCase().includes(state.query));
const mapMode=()=>state[state.view+'Mode'];
const selectedSat = () => state.satellites.find(s => s.id === state.selected);
const color = sat => sat.status === 'retired' ? palette.muted : palette.main;

function currentPosition(sat,time) {
  if (!sat?.elements) return null;
  const second=Math.floor(Number(time)/1000), cached=positions.get(sat.id);
  if (cached?.second===second && cached.elements===sat.elements) return cached.point;
  const point=position(sat,time);
  positions.set(sat.id,{second,elements:sat.elements,point});
  return point;
}

function getViewport() {
  return viewport || {x:16,y:16,width:Math.max(1,$('#map-wrap').clientWidth-32),height:Math.max(1,$('#map-wrap').clientHeight-32)};
}

function flatView() {
  const box=$('#map-wrap').getBoundingClientRect();
  return {...state.map,width:box.height*2,height:box.height,cx:box.width/2,cy:box.height/2};
}

function updateLayout() {
  const box=$('#map-wrap').getBoundingClientRect();
  if (!box.width || !box.height) return;
  let left=16, right=box.width-16;
  if (!compact.matches) {
    right=$('.detail-dock').getBoundingClientRect().left-box.left-16;
    if (state.view==='earth') left=$('.sidebar').getBoundingClientRect().right-box.left+16;
  }
  const top=16, bottom=box.height-16;
  viewport={x:left,y:top,width:Math.max(80,right-left),height:Math.max(80,bottom-top)};
  $('.workspace').style.setProperty('--map-center-x',(viewport.x+viewport.width/2)+'px');
  $('.workspace').style.setProperty('--map-center-y',(viewport.y+viewport.height/2)+'px');
  clampMap(); draw();
}

function syncPanels() {
  const expanded=panels.dataset.expanded==='true';
  $('#panel-expand').setAttribute('aria-expanded',String(expanded));
  $('#panel-expand').setAttribute('aria-label',expanded ? '위성 정보 접기' : '위성 정보 펼치기');
  $('#panel-content').inert=compact.matches && !expanded;
  const listVisible=state.view==='earth' && (!compact.matches || panels.dataset.listOpen==='true');
  $('.sidebar').inert=!listVisible;
  $('#catalog-toggle').setAttribute('aria-expanded',String(listVisible));
  const fullscreen=compact.matches && (expanded || listVisible);
  panels.classList.toggle('is-fullscreen',fullscreen);
  $('.workspace').classList.toggle('panel-open',fullscreen);
  updateLayout();
}

function select(id) {
  state.selected = id;
  state.followSelected=true;
  $('#detail').scrollTop=0;
  if (compact.matches) {
    const fromList=$('.sidebar').contains(document.activeElement);
    panels.dataset.listOpen='false'; panels.dataset.expanded='false'; syncPanels();
    if (fromList) $('#catalog-toggle').focus();
  }
  $('#sat-list').querySelectorAll('[data-id]').forEach(button => {
    button.setAttribute('aria-pressed',String(Number(button.dataset.id)===id));
  });
  updateUI();
}
function renderList() {
  const scrollTop = $('#sat-list').scrollTop;
  const matches = activeSats();
  $('#mission-count').textContent=matches.length;
  if (!matches.some(s => s.id === state.selected)) { state.selected=matches[0]?.id ?? null; state.followSelected=true; }
  $('#sat-list').innerHTML = matches.length ? matches.map(s => {
    return `<button class="sat-item" type="button" data-id="${s.id}" aria-pressed="${s.id === state.selected}">
      <span class="sat-number">${s.number}</span><span class="sat-summary"><strong>${escapeHTML(s.name)}</strong><small>${escapeHTML(s.english)} · ${s.group}</small></span>
      <span class="sat-state ${s.status}">${STATUS_LABELS[s.status]}</span></button>`;
  }).join('') : '<p class="empty">검색 결과가 없습니다.</p>';
  $('#sat-list').scrollTop = scrollTop;
}

function fillDetail(values) {
  for (const [key,value] of Object.entries(values)) {
    const text=String(value ?? '');
    if (detail[key].textContent!==text) detail[key].textContent=text;
  }
}

function renderDetail() {
  const moon=state.view==='moon', s=moon ? DANURI : selectedSat(), time=currentTime;
  detail.empty.hidden=Boolean(s);
  detail.content.hidden=!s;
  if (!s) return;

  fillDetail({name:s.name,english:s.english,group:s.group,agency:s.agency,launched:s.launched,vehicle:s.vehicle,site:s.site,description:s.description,status:STATUS_LABELS[s.status]});
  detail.status.hidden=moon;
  const statusClass='sat-state '+(s.status==='active' ? 'active' : 'unknown');
  for (const key of ['status','group','agency']) if (detail[key].className!==statusClass) detail[key].className=statusClass;
  detail.agency.hidden=!s.agency?.trim();
  detail.launched.dateTime=s.launched;
  for (const key of ['vehicle','site']) {
    detail[key].hidden=detail[key].previousElementSibling.hidden=!s[key]?.trim();
  }

  const p=moon ? sampleDanuri(moonData,time) : currentPosition(s,time);
  detail.earthGrid.hidden=moon || !p;
  detail.moonGrid.hidden=!moon || !p;
  detail.noData.hidden=Boolean(p);
  if (!p) {
    fillDetail({noData:moon ? moonError || (moonData ? '선택한 시각의 궤적 자료가 없습니다.' : '다누리 궤적을 불러오는 중입니다.') : '사용할 수 있는 궤도 자료가 없습니다.'});
    return;
  }

  const coordinate=(value,positive,negative)=>`${Math.abs(value).toFixed(2)}° ${value>=0 ? positive : negative}`;
  if (moon) {
    const elapsedDays=Math.max(0,(Number(time)-LUNAR_ORBIT_INSERTION)/86400000);
    fillDetail({
      moonAltitude:p.altitude.toFixed(1)+' km',moonDistance:p.distance.toFixed(1)+' km',
      moonLatitude:coordinate(p.lat,'N','S'),moonLongitude:coordinate(p.lon,'E','W'),
      earthDistance:p.earthDistance===null ? '—' : Math.round(p.earthDistance).toLocaleString('ko-KR')+' km',
      lunarElapsed:'D+'+elapsedDays.toFixed(4)
    });
  } else {
    fillDetail({
      altitude:Math.round(p.altitude).toLocaleString('ko-KR')+' km',period:p.period.toFixed(1)+' min',
      inclination:s.elements.INCLINATION.toFixed(2)+'°',eccentricity:s.elements.ECCENTRICITY.toFixed(5),
      latitude:coordinate(p.lat,'N','S'),longitude:coordinate(p.lon,'E','W')
    });
  }
}

async function loadEarth() {
  if (earthView || earthPromise || Date.now()<earthRetryAfter) return earthPromise;
  const message=$('#earth-message');
  message.hidden=false; message.textContent='3D 지구를 불러오는 중';
  earthPromise=(async()=>{
    try {
      const {createEarth}=await import('./earth.js');
      earthView=await createEarth($('#earth-scene'),$('#earth-label'),$('#earth-hover'),select,getViewport);
      message.hidden=true;
    } catch (error) {
      message.textContent='3D 지구 불러오기 실패 · '+(error.name==='TimeoutError' ? '이미지 응답 시간 초과' : error.message);
      earthRetryAfter=Date.now()+60000;
    } finally { earthPromise=null; draw(); }
  })();
  return earthPromise;
}

async function loadMoon() {
  if (moonPromise || Date.now()<moonRetryAfter) return moonPromise;
  moonError='';
  $('#moon-message').hidden=false;
  $('#moon-message').textContent='다누리 궤적을 불러오는 중';
  moonPromise=(async()=>{
    let loadingTimer;
    try {
      const flat=state.moonMode==='2d';
      const scene=flat ? Promise.resolve(null) : moonView ? Promise.resolve(moonView) : import('./moon.js').then(({createMoon})=>createMoon($('#moon-scene'),$('#moon-label'))).then(view=>{moonView=view;return view;});
      const surface=flat && !moonSurfaceReady ? (async()=>{ const image=new Image(); image.src='/textures/moon.jpg'; await image.decode(); moonSurfaceReady=true; })() : Promise.resolve();
      const trajectory=moonData && Date.now()-Date.parse(moonData.fetchedAt)<86400000 ? Promise.resolve(moonData) : fetch('/api/danuri',{cache:'no-store',signal:AbortSignal.timeout(25000)}).then(async response=>{
        const data=await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '다누리 자료 서버 HTTP '+response.status);
        if (data.frame!=='MOON_ME' || !Array.isArray(data.points) || data.points.length<2) throw new Error('다누리 궤적 형식이 올바르지 않습니다.');
        moonData=data;
        renderDetail();
        if (!moonView) $('#moon-message').textContent='달 화면을 불러오는 중';
        return data;
      });
      const [,data]=await Promise.race([
        Promise.all([scene,trajectory,surface]),
        new Promise((_,reject)=>{loadingTimer=setTimeout(()=>reject(new Error('달 화면 로딩 시간이 초과되었습니다. 잠시 후 다시 시도합니다.')),30000);})
      ]);
      moonData=data; moonView?.setData(data);
      $('#moon-message').hidden=true;
    } catch (error) {
      moonError=error.name==='TimeoutError' ? '다누리 자료 또는 달 이미지 응답 시간이 초과되었습니다.' : error.message || '달 화면을 불러오지 못했습니다.';
      moonRetryAfter=Date.now()+60000;
      $('#moon-message').hidden=false;
      $('#moon-message').textContent=moonError;
    } finally { clearTimeout(loadingTimer); moonPromise=null; updateUI(); }
  })();
  return moonPromise;
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
    draw();
  } catch { earthTextureError='지구 이미지를 불러오지 못했습니다. 새로고침해 주세요.'; draw(); return; }
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
    draw();
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
  ctx.strokeStyle=palette['line-soft']; ctx.lineWidth=.7;
  const step=view.zoom<2 ? 30 : view.zoom<4 ? 10 : 5;
  for (const tile of worldTiles(view,w)) {
    for (let lon=-180;lon<180;lon+=step) {
      const x=tile.x+(lon+180)/360*width;
      if (x<0 || x>w) continue;
      ctx.beginPath(); ctx.moveTo(x,start.y); ctx.lineTo(x,end.y); ctx.stroke();
      if (x>25 && x<w-25) {
        axisCtx.beginPath(); axisCtx.moveTo(x,0); axisCtx.lineTo(x,5); axisCtx.stroke();
        axisCtx.fillText(`${Math.abs(lon)}°${lon>0 ? 'E' : lon<0 ? 'W' : ''}`,x,20);
      }
    }
  }
  for (let lat=-90;lat<=90;lat+=step) {
    const {y}=project(0,lat,view);
    if (y<0 || y>h) continue;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    latCtx.beginPath(); latCtx.moveTo(23,y); latCtx.lineTo(28,y); latCtx.stroke();
    if (y>25 && y<h-25) {
      latCtx.save(); latCtx.translate(20,y); latCtx.rotate(-Math.PI/2);
      latCtx.fillText(`${Math.abs(lat)}°${lat>0 ? 'N' : lat<0 ? 'S' : ''}`,0,0);
      latCtx.restore();
    }
  }
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

function drawTrack(sat, time, w, h, view) {
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

function draw() {
  if (drawRequest) return;
  drawRequest=requestAnimationFrame(()=>{drawRequest=null; renderMap();});
}

function renderMap() {
  const moon=state.view==='moon', mode=mapMode();
  if (moon && (!moonData || Date.now()-Date.parse(moonData.fetchedAt)>=86400000 || (mode==='3d' ? !moonView : !moonSurfaceReady))) loadMoon();
  if (panels.classList.contains('is-fullscreen')) return;
  if (mode==='3d') {
    if (moon) moonView?.update(currentTime);
    else if (!earthView) loadEarth();
    else {
      const time=currentTime, points=activeSats().flatMap(sat=>{
        const point=currentPosition(sat,time);
        return point ? [{sat,point}] : [];
      });
      earthView.update(points,time,state.selected);
    }
    return;
  }
  const size=sizeCanvas();
  if (!size) return;
  const {w,h}=size, time=currentTime, visible=moon ? [DANURI] : activeSats(), chosen=moon ? DANURI : selectedSat();
  const message=$('#map-message');
  message.hidden=moon ? Boolean(moonData && moonSurfaceReady) : state.earthStyle==='map' || Boolean(nightImage);
  message.textContent=moon ? moonError || (moonSurfaceReady ? '다누리 궤적을 불러오는 중' : '달 이미지를 불러오는 중') : earthTextureError || '지구 이미지를 불러오는 중';
  let view=flatView();
  const target=state.followSelected ? moon ? sampleDanuri(moonData,time) : currentPosition(chosen,time) : null;
  if (target) {
    state.map.x=-target.lon/360*view.width*view.zoom;
    clampMap(); view=flatView();
  }
  ctx.clearRect(0,0,w,h);
  const axisScale = canvas.width/w;
  if (longitudeAxis.width!==canvas.width) longitudeAxis.width=canvas.width;
  if (longitudeAxis.height!==Math.round(28*axisScale)) longitudeAxis.height=Math.round(28*axisScale);
  axisCtx.setTransform(axisScale,0,0,axisScale,0,0);
  axisCtx.clearRect(0,0,w,28);
  axisCtx.font = '11px Pretendard'; axisCtx.textAlign = 'center'; axisCtx.fillStyle = palette.muted; axisCtx.strokeStyle = palette['line-soft'];
  if (latitudeAxis.width!==Math.round(28*axisScale)) latitudeAxis.width=Math.round(28*axisScale);
  if (latitudeAxis.height!==canvas.height) latitudeAxis.height=canvas.height;
  latCtx.setTransform(axisScale,0,0,axisScale,0,0);
  latCtx.clearRect(0,0,28,h);
  latCtx.font = '11px Pretendard'; latCtx.textAlign = 'center'; latCtx.textBaseline = 'alphabetic'; latCtx.fillStyle = palette.muted; latCtx.strokeStyle = palette['line-soft'];
  const start=project(-180,90,view);
  Object.assign($('#world-map').style,{backgroundPosition:`${start.x}px ${start.y}px`,backgroundSize:`${view.width*view.zoom}px ${view.height*view.zoom}px`});
  if (!moon) {
    if (state.earthStyle==='satellite') drawNight(w,time,view);
    else {
      updateSolarMasks(time);
      ctx.save(); ctx.globalAlpha=.68;
      for (const {x,y} of worldTiles(view,w)) ctx.drawImage(maskCanvas,x,y,view.width*view.zoom,view.height*view.zoom);
      ctx.restore();
    }
  }
  drawGrid(w,h,view);
  if (!moon) renderLaunchSites(w,h,view);
  if (chosen) drawTrack(chosen,time,w,h,view);
  const points = visible.flatMap(sat => {
    const p=moon ? sampleDanuri(moonData,time) : currentPosition(sat,time);
    if (!p) return [];
    const selected=moon || sat.id===state.selected, point=project(p.lon,p.lat,view), width=view.width*view.zoom;
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
      button.addEventListener('click',()=>{ if (sat.id==='danuri') { state.followSelected=true; draw(); } else select(sat.id); });
      button.addEventListener('pointerenter',event => { if (event.pointerType !== 'touch') { state.hovered = key; draw(); } });
      button.addEventListener('pointerleave',() => { if (state.hovered === key) { state.hovered = null; draw(); } });
      button.addEventListener('focus',() => { state.focused = key; draw(); });
      button.addEventListener('blur',() => { if (state.focused === key) { state.focused = null; draw(); } });
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

let clockTimer;
function updateClock() {
  clearTimeout(clockTimer);
  if (document.hidden) return;
  const now=new Date();
  $('#clock').textContent=clockFormatter.format(now);
  $('#clock').dateTime=now.toISOString();
  clockTimer=setTimeout(updateClock,1000-Date.now()%1000);
}

function updateUI() {
  currentTime=new Date();
  renderDetail(); draw();
}

function setView(view) {
  if (state.view!==view) { state.map={zoom:1,x:0,y:0}; state.followSelected=true; }
  state.view=view;
  if (view==='moon') panels.dataset.listOpen='false';
  const globe=mapMode()==='3d', moon=view==='moon';
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  document.querySelectorAll('[data-map-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mapMode===mapMode())));
  document.querySelectorAll('[data-surface]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.surface===state.earthStyle)));
  $('#moon-panel').hidden=!(moon && globe);
  $('#earth-panel').hidden=moon || !globe;
  $('.map-frame').classList.toggle('axes-hidden',globe);
  $('.workspace').classList.toggle('moon-active',moon);
  $('.workspace').classList.toggle('globe-active',globe);
  const image=moon ? '/textures/moon.jpg' : state.earthStyle==='map' ? '/world.svg' : '/textures/earth_day_4096.jpg';
  $('#world-map').style.backgroundImage='url("'+image+'")';
  syncPanels(); updateUI();
}

function updateSource(message) {
  $('#freshness').textContent = message;
  updateUI();
}

function applyElements(rows) {
  const valid = parseElements(rows);
  if (!valid.size) throw new Error('최근 7일 이내의 유효한 궤도 자료가 없습니다');
  state.satellites = state.satellites.map(s => valid.has(s.id) ? { ...s,elements:valid.get(s.id),record:null } : s);
}

async function connectPublic(force=false) {
  const button = $('#fetch-data'); button.disabled = true; button.textContent = '불러오는 중';
  state.satellites = state.satellites.map(s => ({...s,elements:null,record:null}));
  updateSource('궤도 자료 불러오는 중');
  let finalData;
  const receive = data => {
    if (data.error) throw new Error(data.error);
    if (data.elements?.length) {
      try { applyElements(data.elements); }
      catch { if (data.done) throw new Error('유효한 궤도 자료가 없습니다'); }
    }
    if (!data.done) updateSource('궤도 자료 갱신 중 · 받은 자료부터 표시합니다.');
    else finalData = data;
  };
  try {
    const response = await fetch('/api/catalog'+(force ? '?stream=1&refresh=1' : ''),{cache:'no-store',signal:AbortSignal.timeout(35000)});
    if (!response.ok) throw new Error('자료 서버 HTTP ' + response.status);
    if (force) {
      let buffer='';
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        const lines=(buffer+chunk).split('\n');
        buffer=lines.pop();
        for (const line of lines) if (line.trim()) receive(JSON.parse(line));
      }
      if (buffer.trim()) receive(JSON.parse(buffer));
    } else receive(await response.json());
    if (!finalData) throw new Error('자료 갱신이 완료되지 않았습니다');

    const message = finalData.warnings?.join(' · ');
    updateSource(message || ('갱신 : ' + koreanTime(new Date(finalData.fetchedAt)) + ' KST' + (finalData.unavailable?.length ? ' · 자료 없음 ' + finalData.unavailable.length + '기' : '')));
  } catch (error) { updateSource('자료 갱신 실패 · ' + (error.name === 'TimeoutError' ? '응답 시간 초과' : error.message)); }
  finally { button.disabled = false; button.textContent = '새로고침'; }
}

function clampMap() {
  const view=flatView(), width=view.width*view.zoom;
  if (width) state.map.x=((state.map.x+width/2)%width+width)%width-width/2;
  const limitY=view.height*(view.zoom-1)/2;
  state.map.y=Math.max(-limitY,Math.min(limitY,state.map.y));
}
function zoom(factor,clientX,clientY) {
  if (mapMode()==='3d') { (state.view==='moon' ? moonView : earthView)?.zoom(factor); return; }
  const old=state.map.zoom, next=Math.max(1,Math.min(8,old*factor));
  if (next===old) return;
  state.map.zoom=next;
  if (clientX!==undefined) {
    const box=canvas.getBoundingClientRect(), offsetX=clientX-box.left-box.width/2, offsetY=clientY-box.top-box.height/2;
    state.map.x=offsetX+(state.map.x-offsetX)*next/old;
    state.map.y=offsetY+(state.map.y-offsetY)*next/old;
    state.followSelected=false;
  } else { state.map.x*=next/old; state.map.y*=next/old; }
  clampMap(); draw();
}
$('#map-wrap').addEventListener('wheel',event=>{
  if (mapMode()!=='2d' || !event.deltaY || event.target.closest('.panel-layer')) return;
  event.preventDefault();
  const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? canvas.clientHeight : 1;
  const delta=Math.max(-200,Math.min(200,event.deltaY*unit));
  zoom(Math.exp(-delta*.002),event.clientX,event.clientY);
},{passive:false});
$('#zoom-in').addEventListener('click',() => zoom(1.5));
$('#zoom-out').addEventListener('click',() => zoom(1/1.5));
$('#zoom-reset').addEventListener('click',() => {
  if (mapMode()==='3d') (state.view==='moon' ? moonView : earthView)?.reset();
  else { state.map={zoom:1,x:0,y:0}; state.followSelected=true; draw(); }
});
canvas.addEventListener('pointerdown',event => {
  if (event.button !== 0) return;
  drag = { pointer:event.pointerId,x:event.clientX,y:event.clientY,startX:state.map.x,startY:state.map.y,moved:false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove',event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
  if (Math.hypot(dx,state.map.zoom>1 ? dy : 0)>4) drag.moved=true;
  if (drag.moved) { state.followSelected=false; state.map.x=drag.startX+dx; state.map.y=drag.startY+dy; clampMap(); draw(); }
});
canvas.addEventListener('pointerup',event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  drag = null;
});
canvas.addEventListener('pointercancel',() => { drag = null; });
$('#search').addEventListener('input',event => { state.query = event.target.value.trim().toLowerCase(); renderList(); updateUI(); });
$('#sat-list').addEventListener('click',event => {
  const button=event.target.closest('[data-id]');
  if (button) select(Number(button.dataset.id));
});
$('#status-filter').addEventListener('change',event => { state.status = event.target.value; renderList(); updateUI(); });
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click',() => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(x => x.setAttribute('aria-pressed',String(x === b)));
  renderList(); updateUI();
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click',() => setView(b.dataset.view)));
document.querySelectorAll('[data-map-mode]').forEach(button=>button.addEventListener('click',()=>{
  state[state.view+'Mode']=button.dataset.mapMode;
  if (state.view==='moon') { moonRetryAfter=0; moonError=''; }
  setView(state.view);
}));
document.querySelectorAll('[data-surface]').forEach(button=>button.addEventListener('click',()=>{
  state.earthStyle=button.dataset.surface;
  setView(state.view);
}));
$('#fetch-data').addEventListener('click',() => connectPublic(true));
const layoutObserver=new ResizeObserver(updateLayout);
for (const element of [$('#map-wrap'),panels,$('#detail'),$('.sidebar'),$('.detail-dock'),$('.control-panel')]) layoutObserver.observe(element);
compact.addEventListener('change',syncPanels);
$('#catalog-close').addEventListener('click',()=>{
  panels.dataset.listOpen='false'; syncPanels(); $('#catalog-toggle').focus();
});
$('#catalog-toggle').addEventListener('click',()=>{
  const open=panels.dataset.listOpen!=='true';
  panels.dataset.listOpen=String(open);
  if (open) panels.dataset.expanded='false';
  syncPanels();
});
$('#panel-expand').addEventListener('click',()=>{
  const open=panels.dataset.expanded!=='true';
  panels.dataset.expanded=String(open);
  if (open) { panels.dataset.listOpen='false'; $('#panel-content').scrollTop=0; }
  syncPanels();
});
window.addEventListener('keydown',event=>{
  if (event.key==='Escape' && compact.matches && (panels.dataset.expanded==='true' || panels.dataset.listOpen==='true')) {
    const target=panels.dataset.listOpen==='true' ? '#catalog-toggle' : '#panel-expand';
    panels.dataset.listOpen='false'; panels.dataset.expanded='false'; syncPanels(); $(target).focus();
  }
  if (state.view==='earth' && event.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault(); panels.dataset.expanded='false'; panels.dataset.listOpen='true'; syncPanels(); $('.sidebar').scrollTop=0; $('#search').focus();
  }
});
setInterval(()=>{ if (!document.hidden) updateUI(); },1000);
document.addEventListener('visibilitychange',()=>{ updateClock(); if (!document.hidden) updateUI(); });
$('#catalog-summary').textContent = Object.entries(STATUS_LABELS).map(([key,label]) => `${label} ${CATALOG.filter(s => s.status === key).length}`).join(' · ');
updateClock(); setView('earth'); renderList(); loadEarthTextures(); connectPublic();
document.fonts.ready.then(draw);
