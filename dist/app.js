import { CATALOG, STATUS_LABELS, parseElements, position, sampleDanuri, LUNAR_ORBIT_INSERTION } from './orbits.js';
import { createMap2D } from './map2d.js';

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
let viewport, drawRequest, currentTime=new Date();
const compact=matchMedia('(max-width:1000px)'), panels=$('.panel-layer');
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
  return viewport || {x:16,y:16,width:Math.max(1,$('#map-wrap').clientWidth-32),height:Math.max(1,$('#map-wrap').clientHeight-32)};
}

function updateLayout() {
  const box=$('#map-wrap').getBoundingClientRect();
  if (!box.width || !box.height) return;
  let left=16, right=box.width-16;
  if (!compact.matches) {
    right=$('.detail-dock').getBoundingClientRect().left-box.left-16;
  }
  const top=16, bottom=box.height-16;
  viewport={x:left,y:top,width:Math.max(80,right-left),height:Math.max(80,bottom-top)};
  $('.workspace').style.setProperty('--map-center-x',(viewport.x+viewport.width/2)+'px');
  $('.workspace').style.setProperty('--map-center-y',(viewport.y+viewport.height/2)+'px');
  flatMap.clamp(); draw();
}

function syncPanels() {
  const expanded=panels.dataset.expanded==='true';
  $('#panel-expand').setAttribute('aria-expanded',String(expanded));
  $('#panel-expand').setAttribute('aria-label',expanded ? '위성 정보 접기' : '위성 정보 펼치기');
  $('#panel-content').inert=compact.matches && !expanded;
  const listVisible=state.view==='earth' && shell.dataset.listOpen==='true';
  catalog.hidden=!listVisible;
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
  if (compact.matches) {
    const fromList=$('.sidebar').contains(document.activeElement);
    shell.dataset.listOpen='false'; panels.dataset.expanded='false'; syncPanels();
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
  if (!matches.some(s => s.id === state.selected)) { state.selected=matches[0]?.id ?? null; flatMap.follow(); }
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

function draw() {
  if (drawRequest) return;
  drawRequest=requestAnimationFrame(()=>{drawRequest=null; renderMap();});
}

function renderMap() {
  const moon=state.view==='moon', mode=mapMode();
  if (moon && (!moonData || Date.now()-Date.parse(moonData.fetchedAt)>=86400000 || (mode==='3d' ? !moonView : !moonSurfaceReady))) loadMoon();
  if (panels.classList.contains('is-fullscreen') || (compact.matches && !catalog.hidden)) return;
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
  if (data?.fetchedAt) {
    $('#source-time').hidden=false;
    $('#source-time').textContent='데이터 갱신 : '+koreanTime(new Date(data.fetchedAt))+' KST';
  }
  if (data?.done) {
    const notes=[...(data.warnings || [])];
    if (data.unavailable?.length) notes.push('자료 없음 '+data.unavailable.length+'기');
    $('#data-warning').textContent=notes.join(' · ');
    $('#data-warning').hidden=!notes.length;
  }
  updateUI();
}

function applyElements(rows) {
  const valid = parseElements(rows);
  if (!valid.size) throw new Error('최근 7일 이내의 유효한 궤도 자료가 없습니다');
  state.satellites = state.satellites.map(s => valid.has(s.id) ? { ...s,elements:valid.get(s.id),record:null } : s);
}

async function connectPublic(force=false) {
  const button=$('#fetch-data'); button.disabled=true; button.textContent=force ? '조회 중' : '확인 중';
  $('#source-time').hidden=true; $('#data-warning').hidden=true;
  state.satellites=state.satellites.map(s=>({...s,elements:null,record:null}));
  updateSource(force ? '외부 API 조회 중' : '서버 저장 자료 확인 중');
  let finalData;
  const receive=data=>{
    if (data.error) throw new Error(data.error);
    if (data.elements?.length) {
      try { applyElements(data.elements); }
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
    const source=finalData.delivery==='vercel-cache' ? 'Vercel' : '로컬';
    updateSource(cached ? source+' 저장 데이터' : '데이터 갱신됨',finalData);
  } catch (error) { updateSource('자료 불러오기 실패 · '+(error.name==='TimeoutError' ? '응답 시간 초과' : error.message)); }
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
compact.addEventListener('change',syncPanels);
$('#catalog-close').addEventListener('click',()=>{
  shell.dataset.listOpen='false'; syncPanels(); $('#catalog-toggle').focus();
});
$('#catalog-toggle').addEventListener('click',()=>{
  const open=shell.dataset.listOpen!=='true';
  shell.dataset.listOpen=String(open);
  if (open) panels.dataset.expanded='false';
  syncPanels();
});
$('#panel-expand').addEventListener('click',()=>{
  const open=panels.dataset.expanded!=='true';
  panels.dataset.expanded=String(open);
  if (open) { shell.dataset.listOpen='false'; $('#panel-content').scrollTop=0; }
  syncPanels();
});
window.addEventListener('keydown',event=>{
  if (event.key==='Escape' && ((compact.matches && panels.dataset.expanded==='true') || (state.view==='earth' && shell.dataset.listOpen==='true'))) {
    const target=shell.dataset.listOpen==='true' ? '#catalog-toggle' : '#panel-expand';
    shell.dataset.listOpen='false'; panels.dataset.expanded='false'; syncPanels(); $(target).focus();
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
