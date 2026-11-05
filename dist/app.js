import { CATALOG, STATUS_LABELS, parseElements, position, sampleDanuri, LUNAR_ORBIT_INSERTION } from './orbits.js';
import { createMap2D } from './map2d.js';

const STATUS_ICONS = {
  active: '<path d="M16.364 3.636a.75.75 0 0 0-1.06 1.06 7.5 7.5 0 0 1 0 10.607.75.75 0 0 0 1.06 1.061 9 9 0 0 0 0-12.728ZM4.697 4.697a.75.75 0 0 0-1.061-1.061 9 9 0 0 0 0 12.728.75.75 0 1 0 1.06-1.06 7.5 7.5 0 0 1 0-10.607Z"/><path d="M12.475 6.464a.75.75 0 0 1 1.06 0 5 5 0 0 1 0 7.072.75.75 0 0 1-1.06-1.061 3.5 3.5 0 0 0 0-4.95.75.75 0 0 1 0-1.06ZM7.525 6.464a.75.75 0 0 1 0 1.061 3.5 3.5 0 0 0 0 4.95.75.75 0 0 1-1.06 1.06 5 5 0 0 1 0-7.07.75.75 0 0 1 1.06 0ZM11 10a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>',
  retired: '<path d="M2.22 2.22a.75.75 0 0 1 1.06 0l6.783 6.782a1 1 0 0 1 .935.935l6.782 6.783a.75.75 0 1 1-1.06 1.06l-6.783-6.782a1 1 0 0 1-.935-.935L2.22 3.28a.75.75 0 0 1 0-1.06ZM3.636 16.364a9.004 9.004 0 0 1-1.39-10.936L3.349 6.53a7.503 7.503 0 0 0 1.348 8.773.75.75 0 0 1-1.061 1.061ZM6.464 13.536a5 5 0 0 1-1.213-5.103l1.262 1.262a3.493 3.493 0 0 0 1.012 2.78.75.75 0 0 1-1.06 1.06ZM16.364 3.636a9.004 9.004 0 0 1 1.39 10.937l-1.103-1.104a7.503 7.503 0 0 0-1.348-8.772.75.75 0 1 1 1.061-1.061ZM13.536 6.464a5 5 0 0 1 1.213 5.103l-1.262-1.262a3.493 3.493 0 0 0-1.012-2.78.75.75 0 0 1 1.06-1.06Z"/>',
  unknown: '<path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM8.94 6.94a.75.75 0 1 1-1.061-1.061 3 3 0 1 1 2.871 5.026v.345a.75.75 0 0 1-1.5 0v-.5c0-.72.57-1.172 1.081-1.287A1.5 1.5 0 1 0 8.94 6.94ZM10 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/>'
};

const $ = selector => document.querySelector(selector);
const detail = Object.fromEntries([...$('#detail').querySelectorAll('[data-detail]')].map(element => [element.dataset.detail, element]));
const DANURI = {
  id:'danuri', name:'다누리', english:'Korea Pathfinder Lunar Orbiter · KPLO', group:'달 궤도', agency:'한국항공우주연구원',
  launched:'2022-08-04', vehicle:'팰컨 9 (스페이스X)', site:'미국 케이프커내버럴 우주군기지', description:'우리나라 최초의 달 궤도선.'
};
const state = {
  satellites: CATALOG.map((s,index) => ({ ...s, number:String(index+1).padStart(2,'0'), elements:null })), selected: 22077,
  filter: 'ALL', status: 'ALL', query: '', view: 'earth', earthMode:'2d', moonMode:'3d', earthStyle:'satellite'
};
let viewport, drawRequest, announcedSelection, currentTime=new Date();
const compact=matchMedia('(max-width:1000px)'), panels=$('.panel-layer');
panels.dataset.expanded=String(!compact.matches);
const shell=$('.shell'), catalog=$('#satellite-catalog'), catalogToggle=$('#catalog-toggle');
shell.dataset.listOpen=String(!compact.matches);
let moonView, moonData, moonPromise, moonError='', moonRetryAfter=0, moonSurfaceReady=false;
let earthView, earthPromise, earthRetryAfter=0;
const positions = new Map();
const timeFormatter = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const koreanTime = date => timeFormatter.format(date);
const clockFormatter=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const activeSats = () => state.satellites.filter(s => (state.filter === 'ALL' || s.group === state.filter) && (state.status === 'ALL' || s.status === state.status) && `${s.name} ${s.english} ${s.id} ${s.agency} ${s.description}`.toLowerCase().includes(state.query));
const mapMode=()=>state[state.view+'Mode'];
const selectedSat = () => state.satellites.find(s => s.id === state.selected);
const flatMap=createMap2D({onSelect:select,onChange:draw,positionAt:currentPosition,isActive:()=>mapMode()==='2d'});

function currentPosition(sat,time) {
  if (!sat?.elements) return null;
  const second=Math.floor(Number(time)/1000), cached=positions.get(sat.id);
  if (cached?.second===second && cached.elements===sat.elements) return cached.point;
  const point=position(sat,time);
  positions.set(sat.id,{second,elements:sat.elements,point});
  return point;
}

function getViewport() {
  return viewport || {x:0,y:0,width:Math.max(1,$('#map-wrap').clientWidth),height:Math.max(1,$('#map-wrap').clientHeight)};
}

function updateLayout() {
  const box=$('#map-wrap').getBoundingClientRect();
  if (!box.width || !box.height) return;
  viewport={x:0,y:0,width:box.width,height:box.height};
  $('.workspace').style.setProperty('--map-center-x',(viewport.x+viewport.width/2)+'px');
  $('.workspace').style.setProperty('--map-center-y',(viewport.y+viewport.height/2)+'px');
  flatMap.clamp(); draw();
}

function syncPanels() {
  const expanded=panels.dataset.expanded==='true';
  $('#panel-expand').setAttribute('aria-expanded',String(expanded));
  $('#panel-expand').setAttribute('aria-label',expanded ? '위성 정보 접기' : '위성 정보 펼치기');
  $('#panel-content').inert=!expanded;
  const listVisible=state.view==='earth' && shell.dataset.listOpen==='true';
  catalog.hidden=false;
  catalog.inert=!listVisible;
  catalog.setAttribute('aria-hidden',String(!listVisible));
  catalogToggle.disabled=state.view!=='earth';
  catalogToggle.setAttribute('aria-expanded',String(listVisible));
  const label=state.view==='earth' ? (listVisible ? '위성 목록 접기' : '위성 목록 열기') : '지구 화면에서 위성 목록을 사용할 수 있습니다';
  catalogToggle.setAttribute('aria-label',label);
  catalogToggle.title=label;
  shell.classList.toggle('catalog-open',listVisible);
  $('.workspace').inert=compact.matches && listVisible;
  const fullscreen=compact.matches && expanded;
  panels.classList.toggle('is-fullscreen',fullscreen);
  $('.workspace').classList.toggle('panel-open',fullscreen);
  updateLayout();
}

function select(id) {
  state.selected = id;
  flatMap.follow();
  $('#detail').scrollTop=0;
  panels.dataset.expanded=String(!compact.matches);
  if (compact.matches) {
    const fromList=$('.sidebar').contains(document.activeElement);
    shell.dataset.listOpen='false'; panels.dataset.expanded='false'; syncPanels();
    if (fromList) $('#catalog-toggle').focus();
  }
  else syncPanels();
  $('#sat-list').querySelectorAll('[data-id]').forEach(button => {
    button.setAttribute('aria-pressed',String(Number(button.dataset.id)===id));
  });
  updateUI();
}
function renderList() {
  const scrollTop = $('#sat-list').scrollTop;
  const matches = activeSats();
  $('#mission-count').textContent=matches.length;
  if (!matches.some(s => s.id === state.selected)) { state.selected=matches[0]?.id ?? null; flatMap.follow(); }
  $('#sat-list').innerHTML = matches.length ? matches.map(s => {
    return `<button class="sat-item" type="button" data-id="${s.id}" aria-pressed="${s.id === state.selected}">
      <span class="sat-number">${s.number}</span><span class="sat-summary"><strong>${escapeHTML(s.name)}</strong><small>${escapeHTML(s.english)} · ${s.group}</small></span>
      <span class="sat-state sat-status-icon ${s.status}" role="img" aria-label="${STATUS_LABELS[s.status]}" title="${STATUS_LABELS[s.status]}"><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">${STATUS_ICONS[s.status]}</svg></span></button>`;
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
  const selection=state.view+':'+(s?.id ?? '');
  if (selection!==announcedSelection) {
    $('#selection-status').textContent=s ? s.name+' 선택됨' : '선택한 위성이 없습니다.';
    announcedSelection=selection;
  }
  detail.empty.hidden=Boolean(s);
  detail.content.hidden=!s;
  if (!s) return;

  fillDetail({name:s.name,english:s.english,group:s.group,agency:s.agency,launched:s.launched,vehicle:s.vehicle,site:s.site,description:s.description});
  detail.status.hidden=moon;
  if (!moon && detail.status.dataset.status!==s.status) {
    detail.status.className='sat-state detail-state '+s.status;
    detail.status.innerHTML=`<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">${STATUS_ICONS[s.status]}</svg><span>${STATUS_LABELS[s.status]}</span>`;
    detail.status.dataset.status=s.status;
  }
  detail.agencyRow.hidden=!s.agency?.trim();
  detail.agencyRow.title=s.agency || '';
  detail.launched.dateTime=s.launched;
  for (const key of ['vehicle','site']) {
    detail[key].hidden=detail[key].previousElementSibling.hidden=!s[key]?.trim();
  }

  const p=moon ? sampleDanuri(moonData,time) : currentPosition(s,time);
  fillDetail({
    metric1:p ? Math.round(p.altitude).toLocaleString('ko-KR')+' km' : '—',
    metric2:Number.isFinite(p?.speed) ? p.speed.toFixed(2)+' km/s' : '—',
    metric3:'D+'+Math.max(0,Math.floor((Number(time)-Date.parse(s.launched+'T00:00:00Z'))/86400000)),
    moonSpeed:Number.isFinite(p?.speed) ? p.speed.toFixed(2)+' km/s' : '—',
    moonLaunchElapsed:'D+'+Math.max(0,Math.floor((Number(time)-Date.parse(s.launched+'T00:00:00Z'))/86400000))
  });
  detail.speedLabel.title='지구 중심 관성 좌표계에서의 속도';
  detail.orbitHeading.hidden=!p;
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
      lunarElapsed:'D+'+Math.floor(elapsedDays).toLocaleString('ko-KR')
    });
  } else {
    fillDetail({
      period:p.period.toFixed(1)+' min',
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
  flatMap.render({
    time:currentTime,moon,moonData,moonError,moonSurfaceReady,earthStyle:state.earthStyle,
    satellites:moon ? [DANURI] : activeSats(),selected:moon ? DANURI : selectedSat()
  });
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
  if (state.view!==view) flatMap.reset();
  state.view=view;
  const globe=mapMode()==='3d', moon=view==='moon';
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  document.querySelectorAll('[data-map-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mapMode===mapMode())));
  document.querySelectorAll('[data-surface]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.surface===state.earthStyle)));
  $('#moon-panel').hidden=!(moon && globe);
  $('#earth-panel').hidden=moon || !globe;
  $('.workspace').classList.toggle('moon-active',moon);
  $('.workspace').classList.toggle('globe-active',globe);
  syncPanels(); updateUI();
}

function updateSource(message,data) {
  $('#data-route').textContent=message;
  $('#data-route').hidden=Boolean(data?.done);
  if (data?.done && data.fetchedAt) {
    $('#source-time').hidden=false;
    $('#source-time').textContent='갱신 '+koreanTime(new Date(data.fetchedAt))+' KST · '+data.elements.length+'기';
  }
  if (data?.done) {
    const notes=[...(data.warnings || [])];
    if (data.unavailable?.length) notes.push('자료 없음 '+data.unavailable.length+'기');
    $('#warning-details').textContent=notes.join(' · ');
    $('#warning-summary').textContent=data.unavailable?.length ? data.unavailable.length+'기 자료 없음' : '자료 연결 안내';
    $('#data-warning').hidden=!notes.length;
  }
  updateUI();
}

function applyElements(rows,{replace=false}={}) {
  const valid = parseElements(rows);
  if (!valid.size) throw new Error('최근 7일 이내의 유효한 궤도 자료가 없습니다');
  state.satellites = state.satellites.map(s => valid.has(s.id) ? { ...s,elements:valid.get(s.id),record:null } : replace ? {...s,elements:null,record:null} : s);
}

async function connectPublic(force=false) {
  const button=$('#fetch-data'); button.disabled=true; button.textContent=force ? '조회 중' : '확인 중';
  $('#data-warning').hidden=true;
  updateSource(force ? '외부 API 조회 중' : '서버 저장 자료 확인 중');
  let finalData;
  const receive=data=>{
    if (data.error) throw new Error(data.error);
    if (data.elements?.length) {
      try { applyElements(data.elements,{replace:data.done===true}); }
      catch { if (data.done) throw new Error('유효한 궤도 자료가 없습니다'); }
    }
    if (!data.done) {
      button.textContent='조회 중';
      updateSource('외부 API 조회 중. 받은 자료부터 표시합니다.',data);
    } else finalData=data;
  };
  try {
    const response=await fetch('/api/catalog?stream=1'+(force ? '&refresh=1' : ''),{cache:'no-store',signal:AbortSignal.timeout(35000)});
    if (!response.ok) throw new Error('자료 서버 HTTP '+response.status);
    let buffer='';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines=(buffer+chunk).split('\n');
      buffer=lines.pop();
      for (const line of lines) if (line.trim()) receive(JSON.parse(line));
    }
    if (buffer.trim()) receive(JSON.parse(buffer));
    if (!finalData) throw new Error('자료 불러오기가 완료되지 않았습니다');

    const cached=finalData.delivery==='vercel-cache' || finalData.delivery==='local-cache';
    updateSource(cached ? '저장된 자료 사용' : '자료 갱신 완료',finalData);
  } catch (error) { updateSource('자료 불러오기 실패 · '+(error.name==='TimeoutError' ? '응답 시간 초과' : error.message)+(state.satellites.some(s=>s.elements) ? ' · 표시 중인 자료 유지' : '')); }
  finally { button.disabled=false; button.textContent='새로고침'; }
}

function zoom(factor) {
  if (mapMode()==='3d') (state.view==='moon' ? moonView : earthView)?.zoom(factor);
  else flatMap.zoom(factor);
}
$('#zoom-in').addEventListener('click',() => zoom(1.5));
$('#zoom-out').addEventListener('click',() => zoom(1/1.5));
$('#zoom-reset').addEventListener('click',() => {
  if (mapMode()==='3d') (state.view==='moon' ? moonView : earthView)?.reset();
  else flatMap.reset();
});
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
compact.addEventListener('change',()=>{
  panels.dataset.expanded=String(!compact.matches);
  syncPanels();
});
$('#catalog-close').addEventListener('click',()=>{
  shell.dataset.listOpen='false'; syncPanels(); $('#catalog-toggle').focus();
});
$('#catalog-toggle').addEventListener('click',()=>{
  const open=shell.dataset.listOpen!=='true';
  shell.dataset.listOpen=String(open);
  syncPanels();
});
$('#panel-expand').addEventListener('click',()=>{
  const open=panels.dataset.expanded!=='true';
  panels.dataset.expanded=String(open);
  if (open) { if (compact.matches) shell.dataset.listOpen='false'; $('#panel-content').scrollTop=0; }
  syncPanels();
});
window.addEventListener('keydown',event=>{
  if (event.key==='Escape' && (panels.dataset.expanded==='true' || (state.view==='earth' && shell.dataset.listOpen==='true'))) {
    const expanded=panels.dataset.expanded==='true';
    if (expanded) panels.dataset.expanded='false';
    else shell.dataset.listOpen='false';
    syncPanels(); $(expanded ? '#panel-expand' : '#catalog-toggle').focus();
  }
  if (state.view==='earth' && event.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault(); panels.dataset.expanded='false'; shell.dataset.listOpen='true'; syncPanels(); $('.sidebar').scrollTop=0; $('#search').focus();
  }
});
setInterval(()=>{ if (!document.hidden) updateUI(); },1000);
document.addEventListener('visibilitychange',()=>{ updateClock(); if (!document.hidden) updateUI(); });
$('#catalog-summary').textContent = Object.entries(STATUS_LABELS).map(([key,label]) => `${label} ${CATALOG.filter(s => s.status === key).length}`).join(' · ');
updateClock(); setView('earth'); renderList(); connectPublic();
document.fonts.ready.then(draw);
