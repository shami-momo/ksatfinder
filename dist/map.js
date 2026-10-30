import { gstime, eciToEcf } from 'satellite.js';
import LAUNCH_SITES from '../data/launch-sites.json' with {type:'json'};
export { LAUNCH_SITES };

// Use the full map by default; optionally fit an area clear of floating panels.
export function frameCamera(camera,width,height,area={x:0,y:0,width,height}) {
  camera.setViewOffset(width,height,width/2-area.x-area.width/2,height/2-area.y-area.height/2,width,height);
  return Math.atan(Math.tan(camera.fov*Math.PI/360)*Math.min(area.width,area.height)/height);
}

// The same latitude/longitude geometry is used for both textured globes.
export function sphereGridVertices() {
  const vertices=[], point=(lon,lat)=>{
    const a=lon*Math.PI/180,b=lat*Math.PI/180;
    return [1.002*Math.cos(b)*Math.cos(a),1.002*Math.sin(b),-1.002*Math.cos(b)*Math.sin(a)];
  };
  for (let lat=-60;lat<=60;lat+=30) for (let lon=-180;lon<180;lon+=3) vertices.push(...point(lon,lat),...point(lon+3,lat));
  for (let lon=-180;lon<180;lon+=30) for (let lat=-90;lat<90;lat+=3) vertices.push(...point(lon,lat),...point(lon,lat+3));
  return vertices;
}

// Earth-fixed solar direction shared by the flat map and the 3D globe.
export function sunDirection(time) {
  const jd=Number(time)/86400000+2440587.5;
  // satellite.js 6.0.1 sunPos converts only part of the mean anomaly to radians.
  // Use Vallado's original solar-direction formula with consistent angle units.
  const radians=Math.PI/180, centuries=(jd-2451545)/36525;
  const anomaly=((357.5277233+35999.05034*centuries)%360)*radians;
  const solarLongitude=((280.460+36000.77*centuries+1.914666471*Math.sin(anomaly)+.019994643*Math.sin(2*anomaly))%360)*radians;
  const obliquity=(23.439291-.0130042*centuries)*radians;
  return eciToEcf({x:Math.cos(solarLongitude),y:Math.cos(obliquity)*Math.sin(solarLongitude),z:Math.sin(obliquity)*Math.sin(solarLongitude)},gstime(jd));
}

export function createLaunchMarker(site) {
  const button=document.createElement('button');
  button.type='button'; button.className='launch-site';
  button.setAttribute('aria-label','발사장 '+site.name);
  const label=document.createElement('span');
  label.className='launch-site-label'; label.textContent=site.name; label.setAttribute('aria-hidden','true');
  button.append(label);
  button.addEventListener('click',()=>{
    const open=!button.classList.contains('is-open');
    document.querySelectorAll('.launch-site.is-open').forEach(other=>other.classList.remove('is-open'));
    button.classList.toggle('is-open',open);
  });
  button.addEventListener('blur',()=>button.classList.remove('is-open'));
  return button;
}

export function positionLaunchMarker(button,site,x,y,width) {
  button.style.left=(x-8)+'px'; button.style.top=(y-8)+'px';
  const labelWidth=Math.min(width-16,site.name.length*12+16);
  const left=Math.max(8,Math.min(width-labelWidth-8,x-labelWidth/2));
  Object.assign(button.firstElementChild.style,{width:labelWidth+'px',left:(left-x+8)+'px',top:(y>36 ? -28 : 20)+'px'});
}
