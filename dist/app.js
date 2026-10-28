import { CATALOG, STATUS_LABELS, parseElements, position, sampleDanuri, LUNAR_ORBIT_INSERTION } from './orbits.js';
import { project, layoutMarkers, wrapTrack, nightMask } from './map.js';

const $ = selector => document.querySelector(selector);
const detail = Object.fromEntries([...$('#detail').querySelectorAll('[data-detail]')].map(element => [element.dataset.detail, element]));
const DANURI = {
  name:'다누리', english:'Korea Pathfinder Lunar Orbiter · KPLO', group:'달 궤도', agency:'한국항공우주연구원',
  launched:'2022-08-04', vehicle:'팰컨 9 (스페이스X)', site:'미국 케이프커내버럴 우주군기지', description:'우리나라 최초의 달 궤도선.'
};
const canvas = $('#map'), ctx = canvas.getContext('2d');
const longitudeAxis = $('#longitude-axis'), axisCtx = longitudeAxis.getContext('2d');
const latitudeAxis = $('#latitude-axis'), latCtx = latitudeAxis.getContext('2d');
const styles = getComputedStyle(document.documentElement);
const palette = Object.fromEntries(['main','main-bright','text','muted','line-soft'].map(key => [key,styles.getPropertyValue(`--${key}`).trim()]));
const state = {
  satellites: CATALOG.map(s => ({ ...s, elements: null })), selected: 22077,
  hovered: null, focused: null, filter: 'ALL', status: 'ALL', query: '', view: 'earth', showGrid: false, showTrack: true,
  playing: false, offset: 0, anchor: Date.now(), fetchedAt: null,
  map: { zoom: 1, x: 0, y: 0 }
};
let drag;
let moonView, moonData, moonPromise, moonError='', moonRetryAfter=0;
const markerButtons = new Map();
const positions = new Map();
const nightCanvas=document.createElement('canvas'), nightContext=nightCanvas.getContext('2d');
nightCanvas.width=720; nightCanvas.height=360;
let nightKey, trackCache, drawRequest;
const timeFormatter = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const atTime = () => new Date(state.anchor + state.offset * 60000);
const koreanTime = date => timeFormatter.format(date);
const activeSats = () => state.satellites.filter(s => (state.filter === 'ALL' || s.group === state.filter) && (state.status === 'ALL' || s.status === state.status) && `${s.name} ${s.english} ${s.id} ${s.agency} ${s.description}`.toLowerCase().includes(state.query));
const selectedSat = () => state.satellites.find(s => s.id === state.selected);
const number = id => String(CATALOG.findIndex(s => s.id === id) + 1).padStart(2, '0');
const color = sat => sat.status === 'retired' ? palette.muted : palette.main;

function currentPosition(sat,time) {
  if (!sat?.elements) return null;
  const second=Math.floor(Number(time)/1000), cached=positions.get(sat.id);
  if (cached?.second===second && cached.elements===sat.elements) return cached.point;
  const point=position(sat,time);
  positions.set(sat.id,{second,elements:sat.elements,point});
  return point;
}

function select(id) {
  state.selected = id;
  $('#sat-list').querySelectorAll('[data-id]').forEach(button => {
    const selected=Number(button.dataset.id)===id;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  updateTime();
}
function renderList() {
  const scrollTop = $('#sat-list').scrollTop;
  const matches = activeSats();
  $('#mission-count').textContent = CATALOG.length;
  $('#catalog-summary').textContent = Object.entries(STATUS_LABELS).map(([key,label]) => `${label} ${CATALOG.filter(s => s.status === key).length}기`).join(' · ');
  if (!matches.some(s => s.id === state.selected)) state.selected = matches[0]?.id ?? null;
  $('#sat-list').innerHTML = matches.length ? matches.map(s => {
    return `<button class="sat-item ${s.id === state.selected ? 'selected' : ''}" type="button" data-id="${s.id}" aria-pressed="${s.id === state.selected}">
      <span class="sat-number">${number(s.id)}</span><span class="sat-summary"><strong>${escapeHTML(s.name)}</strong><small>${escapeHTML(s.english)} · ${s.group}</small></span>
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
  const moon=state.view==='moon', s=moon ? DANURI : selectedSat(), time=atTime();
  detail.empty.hidden=Boolean(s);
  detail.content.hidden=!s;
  if (!s) return;

  fillDetail({name:s.name,english:s.english,group:s.group,agency:s.agency,launched:s.launched,vehicle:s.vehicle,site:s.site,description:s.description,status:STATUS_LABELS[s.status]});
  detail.status.hidden=moon;
  const statusClass='sat-state '+(s.status || '');
  if (detail.status.className!==statusClass) detail.status.className=statusClass;
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

async function loadMoon() {
  if (moonPromise || Date.now()<moonRetryAfter) return moonPromise;
  moonError='';
  $('#moon-message').hidden=false;
  $('#moon-message').textContent='다누리 궤적을 불러오는 중';
  moonPromise=(async()=>{
    let loadingTimer;
    try {
      const scene=moonView ? Promise.resolve(moonView) : import('./moon.js').then(({createMoon})=>createMoon($('#moon-scene'),$('#moon-label'))).then(view=>{moonView=view;return view;});
      const trajectory=fetch('/api/danuri',{signal:AbortSignal.timeout(25000)}).then(async response=>{
        const data=await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '다누리 자료 서버 HTTP '+response.status);
        if (data.frame!=='MOON_ME' || !Array.isArray(data.points) || data.points.length<2) throw new Error('다누리 궤적 형식이 올바르지 않습니다.');
        moonData=data;
        renderDetail();
        if (!moonView) $('#moon-message').textContent='달 화면을 불러오는 중';
        return data;
      });
      const [view,data]=await Promise.race([
        Promise.all([scene,trajectory]),
        new Promise((_,reject)=>{loadingTimer=setTimeout(()=>reject(new Error('달 화면 로딩 시간이 초과되었습니다. 잠시 후 다시 시도합니다.')),30000);})
      ]);
      moonData=data; view.setData(data);
      $('#moon-message').hidden=true;
    } catch (error) {
      moonError=error.name==='TimeoutError' ? '다누리 자료 또는 달 이미지 응답 시간이 초과되었습니다.' : error.message || '달 화면을 불러오지 못했습니다.';
      moonRetryAfter=Date.now()+60000;
      $('#moon-message').hidden=false;
      $('#moon-message').textContent=moonError;
    } finally { clearTimeout(loadingTimer); moonPromise=null; updateTime(); }
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

async function loadWorld() {
  try {
    await $('#world-map').decode();
    $('#map-message').hidden = true;
    draw();
  } catch { $('#map-message').textContent = '지도 파일을 불러오지 못했습니다. 새로고침해 주세요.'; }
}

function drawGrid(w, h) {
  ctx.strokeStyle = palette['line-soft']; ctx.lineWidth = .7;
  ctx.font = '12px Pretendard'; ctx.fillStyle = palette.muted;
  const step = state.map.zoom < 2 ? 30 : state.map.zoom < 4 ? 10 : 5;
  for (let lon = -180; lon <= 180; lon += step) {
    const { x } = project(lon, 0, w, h, state.map);
    if (x < 0 || x > w) continue;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
    if (x > 25 && x < w - 25) {
      axisCtx.beginPath(); axisCtx.moveTo(x,0); axisCtx.lineTo(x,5); axisCtx.stroke();
      axisCtx.fillText(`${Math.abs(lon)}°${lon > 0 ? 'E' : lon < 0 ? 'W' : ''}`, x,20);
    }
  }
  for (let lat = -90; lat <= 90; lat += step) {
    const { y } = project(0,lat,w,h,state.map);
    if (y < 10 || y > h - 10) continue;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    latCtx.beginPath(); latCtx.moveTo(37,y); latCtx.lineTo(42,y); latCtx.stroke();
    latCtx.fillText(`${Math.abs(lat)}°${lat > 0 ? 'N' : lat < 0 ? 'S' : ''}`, 34,y);
  }
}

function drawNight(w,h,time) {
  const key=Math.floor(Number(time)/15000);
  if (nightKey!==key) {
    const {pixels,width,height}=nightMask(time);
    nightContext.putImageData(new ImageData(pixels,width,height),0,0);
    nightKey=key;
  }
  const {zoom,x,y}=state.map;
  ctx.drawImage(nightCanvas,x-(zoom-1)*w/2,y-(zoom-1)*h/2,w*zoom,h*zoom);
}

function drawTrack(sat, time, w, h) {
  if (!sat.elements) return;
  const second=Math.floor(Number(time)/1000);
  if (trackCache?.second!==second || trackCache.elements!==sat.elements) {
    const span=Math.min(1440/sat.elements.MEAN_MOTION*.75,180);
    const tracks=[-1,1].map(sign=>Array.from({length:161},(_,i)=>position(sat,new Date(Number(time)+sign*i/160*span*60000))));
    trackCache={second,elements:sat.elements,tracks};
  }
  const width = w * state.map.zoom;
  ctx.save(); ctx.translate(state.map.x - (state.map.zoom - 1) * w / 2, state.map.y - (state.map.zoom - 1) * h / 2);
  for (const [index,track] of trackCache.tracks.entries()) {
    const future=index===1;
    const samples=track.map(p=>p ? {x:(p.lon+180)/360*width,y:(90-p.lat)/180*h*state.map.zoom} : null);
    ctx.strokeStyle = future ? palette['main-bright'] : palette.main; ctx.lineWidth = 2; ctx.setLineDash(future ? [5,4] : []);
    for (const segment of wrapTrack(samples,width)) {
      if (segment.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(segment[0].x,segment[0].y);
      for (const p of segment.slice(1)) ctx.lineTo(p.x,p.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function draw() {
  if (drawRequest) return;
  drawRequest=requestAnimationFrame(()=>{drawRequest=null; renderMap();});
}

function renderMap() {
  if (state.view === 'moon') {
    moonView?.update(atTime(),state.showTrack);
    if (!moonView || !moonData || Date.now()-Date.parse(moonData.fetchedAt)>=86400000) loadMoon();
    return;
  }
  const size=sizeCanvas();
  if (!size) return;
  const {w,h}=size, time=atTime(), visible=activeSats();
  ctx.clearRect(0,0,w,h);
  const axisScale = canvas.width/w;
  if (longitudeAxis.width!==canvas.width) longitudeAxis.width=canvas.width;
  if (longitudeAxis.height!==Math.round(28*axisScale)) longitudeAxis.height=Math.round(28*axisScale);
  axisCtx.setTransform(axisScale,0,0,axisScale,0,0);
  axisCtx.clearRect(0,0,w,28);
  axisCtx.font = '11px Pretendard'; axisCtx.textAlign = 'center'; axisCtx.fillStyle = palette.muted; axisCtx.strokeStyle = palette['line-soft'];
  if (latitudeAxis.width!==Math.round(42*axisScale)) latitudeAxis.width=Math.round(42*axisScale);
  if (latitudeAxis.height!==canvas.height) latitudeAxis.height=canvas.height;
  latCtx.setTransform(axisScale,0,0,axisScale,0,0);
  latCtx.clearRect(0,0,42,h);
  latCtx.font = '11px Pretendard'; latCtx.textAlign = 'right'; latCtx.textBaseline = 'middle'; latCtx.fillStyle = palette.muted; latCtx.strokeStyle = palette['line-soft'];
  $('#world-map').style.transform = `translate(${state.map.x}px,${state.map.y}px) scale(${state.map.zoom})`;
  drawNight(w,h,time);
  if (state.showGrid) drawGrid(w,h);
  const chosen = selectedSat();
  if (chosen && state.showTrack) drawTrack(chosen,time,w,h);
  const points = visible.flatMap(sat => {
    const p = currentPosition(sat,time);
    if (!p) return [];
    const selected = sat.id===state.selected;
    return [{ ...project(p.lon,p.lat,w,h,state.map), sat, selected }];
  });
  const markers = points.filter(p => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h);
  const named = markers.filter(p => p.selected || p.sat.id === state.hovered || p.sat.id === state.focused);
  for (const point of named) {
    ctx.font=point.selected ? '500 12px Pretendard' : '500 10px Pretendard';
    point.labelWidth=Math.ceil(ctx.measureText(point.sat.name).width)+12;
  }
  const dots = markers.map(p => ({x:p.x-4,y:p.y-4,width:8,height:8,weight:1}));
  const labels = new Map(layoutMarkers(named,w,h,dots).map(p => [p.sat.id,p.label]));
  const markerIds = new Set();
  for (const { x,y,sat,selected } of [...markers].sort((a,b) => Number(a.selected)-Number(b.selected))) {
    const label = labels.get(sat.id);
    if (label) {
      const edgeX = Math.max(label.x,Math.min(label.x+label.width,x));
      const edgeY = Math.max(label.y,Math.min(label.y+label.height,y));
      ctx.strokeStyle = selected ? palette.main : color(sat); ctx.lineWidth = selected ? 1.2 : .7;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(edgeX,edgeY); ctx.stroke();
    }
    ctx.fillStyle = selected ? palette.main : color(sat);
    ctx.beginPath(); ctx.arc(x,y,selected ? 3.5 : 2.2,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    markerIds.add(sat.id);
    let button = markerButtons.get(sat.id);
    if (!button) {
      button = document.createElement('button'); button.type = 'button';
      const name = document.createElement('span'); name.className = 'map-marker-label'; name.setAttribute('aria-hidden','true');
      button.append(name);
      button.addEventListener('click',() => select(sat.id));
      button.addEventListener('pointerenter',event => { if (event.pointerType !== 'touch') { state.hovered = sat.id; draw(); } });
      button.addEventListener('pointerleave',() => { if (state.hovered === sat.id) { state.hovered = null; draw(); } });
      button.addEventListener('focus',() => { state.focused = sat.id; draw(); });
      button.addEventListener('blur',() => { if (state.focused === sat.id) { state.focused = null; draw(); } });
      $('#map-markers').append(button); markerButtons.set(sat.id,button);
    }
    button.className = 'map-marker' + (selected ? ' selected' : '') + (label ? ' named' : '');
    button.setAttribute('aria-label',sat.name);
    button.setAttribute('aria-pressed',String(selected));
    button.style.left = (x-8) + 'px'; button.style.top = (y-8) + 'px';
    button.style.setProperty('--marker-color',selected ? palette.main : color(sat));
    const name = button.firstElementChild;
    name.textContent = sat.name;
    if (label) {
      name.style.left = (label.x-x+8) + 'px'; name.style.top = (label.y-y+8) + 'px'; name.style.width = label.width + 'px';
    }
  }
  for (const [id,button] of markerButtons) if (!markerIds.has(id)) {
    if (state.hovered === id) state.hovered = null;
    if (state.focused === id) state.focused = null;
    button.remove(); markerButtons.delete(id);
  }
  const coverage = `위치 ${points.length}/${visible.length}기`;
  canvas.setAttribute('aria-label',`위성 위치 지도. ${points.map(p => p.sat.name).join(', ')}. ${coverage}`);
}

function updateTime() {
  const time = atTime();
  $('#time-label').textContent = `${koreanTime(time)} KST${state.offset ? ` · ${state.offset > 0 ? '+' : ''}${state.offset}분` : ' · 현재'}`;
  $('#play-button').setAttribute('aria-pressed',String(state.playing));
  $('#play-button').setAttribute('aria-label',state.playing ? '시간 일시정지' : '시간 재생');
  renderDetail(); draw();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active',b.dataset.view === view); b.setAttribute('aria-pressed',String(b.dataset.view === view)); });
  $('#moon-panel').hidden = view !== 'moon';
  $('.map-frame').classList.toggle('axes-hidden',view !== 'earth' || !state.showGrid);
  $('.workspace').classList.toggle('moon-active',view === 'moon');
  if (view === 'moon' && !moonData) loadMoon();
  updateTime();
}

function updateSource(message) {
  const count = state.satellites.filter(s => s.elements).length;
  $('#freshness').textContent = message || (count ? `자료 수신 ${koreanTime(new Date(state.fetchedAt))} KST` : '궤도 자료가 있는 위성만 지도에 표시합니다.');
  updateTime();
}

function applyElements(rows,fetchedAt) {
  const valid = parseElements(rows);
  if (!valid.size) throw new Error('최근 7일 이내의 유효한 궤도 자료가 없습니다');
  state.satellites = state.satellites.map(s => valid.has(s.id) ? { ...s,elements:valid.get(s.id),record:null } : s);
  state.fetchedAt = Number.isFinite(Date.parse(fetchedAt)) ? fetchedAt : new Date().toISOString();
}

async function connectPublic(force=false) {
  const button = $('#fetch-data'); button.disabled = true; button.textContent = '불러오는 중';
  state.satellites = state.satellites.map(s => ({...s,elements:null,record:null}));
  state.fetchedAt = null;
  updateSource('궤도 자료 불러오는 중');
  let finalData;
  const receive = data => {
    if (data.error) throw new Error(data.error);
    if (data.elements?.length) {
      try { applyElements(data.elements,data.fetchedAt); }
      catch { if (data.done) throw new Error('유효한 궤도 자료가 없습니다'); }
    }
    if (!data.done) updateSource('궤도 자료 갱신 중 · 받은 자료부터 표시합니다.');
    else { finalData = data; updateTime(); }
  };
  try {
    const response = await fetch('/api/catalog'+(force ? '?stream=1&refresh=1' : ''),{signal:AbortSignal.timeout(35000)});
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
    updateSource(message || ('자료 수신 ' + koreanTime(new Date(finalData.fetchedAt)) + ' KST · 24시간마다 갱신' + (finalData.unavailable?.length ? ' · 자료 없음 ' + finalData.unavailable.length + '기' : '')));
  } catch (error) { updateSource('자료 갱신 실패 · ' + (error.name === 'TimeoutError' ? '응답 시간 초과' : error.message)); }
  finally { button.disabled = false; button.textContent = '새로고침'; }
}

function clampMap() {
  const { width,height } = canvas.getBoundingClientRect();
  state.map.x = Math.max(-width*(state.map.zoom-1)/2,Math.min(width*(state.map.zoom-1)/2,state.map.x));
  state.map.y = Math.max(-height*(state.map.zoom-1)/2,Math.min(height*(state.map.zoom-1)/2,state.map.y));
}
function zoom(factor) {
  if (state.view === 'moon') { moonView?.zoom(factor); return; }
  const old = state.map.zoom;
  state.map.zoom = Math.max(1,Math.min(8,old*factor));
  state.map.x *= state.map.zoom/old; state.map.y *= state.map.zoom/old;
  clampMap(); draw();
}
$('#zoom-in').addEventListener('click',() => zoom(1.5));
$('#zoom-out').addEventListener('click',() => zoom(1/1.5));
$('#zoom-reset').addEventListener('click',() => { if (state.view === 'moon') moonView?.reset(); else { state.map = { zoom:1,x:0,y:0 }; draw(); } });
canvas.addEventListener('pointerdown',event => {
  if (event.button !== 0) return;
  drag = { pointer:event.pointerId,x:event.clientX,y:event.clientY,startX:state.map.x,startY:state.map.y,moved:false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove',event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  const dx = event.clientX-drag.x, dy = event.clientY-drag.y;
  if (Math.hypot(dx,dy) > 4) drag.moved = true;
  if (drag.moved) { state.map.x = drag.startX+dx; state.map.y = drag.startY+dy; clampMap(); draw(); }
});
canvas.addEventListener('pointerup',event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  drag = null;
});
canvas.addEventListener('pointercancel',() => { drag = null; });
$('#search').addEventListener('input',event => { state.query = event.target.value.trim().toLowerCase(); renderList(); updateTime(); });
$('#sat-list').addEventListener('click',event => {
  const button=event.target.closest('[data-id]');
  if (button) select(Number(button.dataset.id));
});
$('#status-filter').addEventListener('change',event => { state.status = event.target.value; renderList(); updateTime(); });
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click',() => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(x => { x.classList.toggle('active',x === b); x.setAttribute('aria-pressed',String(x === b)); });
  renderList(); updateTime();
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click',() => setView(b.dataset.view)));
for (const [id,key] of [['grid-toggle','showGrid'],['track-toggle','showTrack']]) {
  $(`#${id}`).addEventListener('click',event => { state[key] = !state[key]; event.currentTarget.classList.toggle('active',state[key]); event.currentTarget.setAttribute('aria-pressed',String(state[key])); $('.map-frame').classList.toggle('axes-hidden',state.view === 'moon' || !state.showGrid); clampMap(); draw(); });
}
$('#time-range').addEventListener('input',event => { state.offset = Number(event.target.value); state.playing = false; updateTime(); });
$('#now-button').addEventListener('click',() => { state.anchor = Date.now(); state.offset = 0; state.playing = false; $('#time-range').value = 0; updateTime(); });
$('#play-button').addEventListener('click',() => { state.playing = !state.playing; updateTime(); });
$('#fetch-data').addEventListener('click',() => connectPublic(true));
new ResizeObserver(()=>{clampMap(); draw();}).observe($('#map-wrap'));
window.addEventListener('keydown',event => { if (state.view === 'earth' && event.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); } });
setInterval(() => {
  if (document.hidden) return;
  if (state.playing) { state.offset = state.offset >= 90 ? -90 : state.offset+1; $('#time-range').value = state.offset; }
  if (!state.offset && !state.playing) state.anchor = Date.now();
  updateTime();
},1000);
document.addEventListener('visibilitychange',()=>{
  if (!document.hidden) { if (!state.offset && !state.playing) state.anchor=Date.now(); updateTime(); }
});
renderList(); updateSource(); loadWorld(); connectPublic();
document.fonts.ready.then(draw);
