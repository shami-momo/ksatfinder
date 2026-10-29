import { gstime, eciToEcf } from 'satellite.js';

const intersects = (a,b) => a.x < b.x+b.width+4 && a.x+a.width+4 > b.x && a.y < b.y+b.height+4 && a.y+a.height+4 > b.y;

export function project(lon, lat, view) {
  return {x:view.cx+lon/360*view.width*view.zoom+view.x,y:view.cy-lat/180*view.height*view.zoom+view.y};
}

// Use the full map by default; optionally fit an area clear of floating panels.
export function frameCamera(camera,width,height,area={x:0,y:0,width,height}) {
  camera.setViewOffset(width,height,width/2-area.x-area.width/2,height/2-area.y-area.height/2,width,height);
  return Math.atan(Math.tan(camera.fov*Math.PI/360)*Math.min(area.width,area.height)/height);
}

// Only selected, hovered and focused labels need placement, usually at most three.
export function layoutMarkers(points, width, height, obstacles=[]) {
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
export function wrapTrack(points, width) {
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

// Reuse the longitude terms across rows; avoid trigonometry for every pixel.
export function nightMask(time,width=720,height=360) {
  const sun=sunDirection(time);
  const length=Math.hypot(sun.x,sun.y,sun.z), twilight=Math.sin(12*Math.PI/180);
  const longitude=Array.from({length:width},(_,x)=>{
    const angle=((x+.5)*360/width-180)*Math.PI/180;
    return (Math.cos(angle)*sun.x+Math.sin(angle)*sun.y)/length;
  });
  const pixels=new Uint8ClampedArray(width*height*4);
  for (let y=0;y<height;y++) {
    const lat=(90-(y+.5)*180/height)*Math.PI/180;
    const vertical=Math.sin(lat)*sun.z/length, horizontal=Math.cos(lat);
    for (let x=0;x<width;x++) {
      const index=(y*width+x)*4;
      const amount=Math.max(0,Math.min(1,-(vertical+horizontal*longitude[x])/twilight));
      pixels[index]=0; pixels[index+1]=0; pixels[index+2]=0;
      pixels[index+3]=Math.round(255*.68*amount*amount*(3-2*amount));
    }
  }
  return {pixels,width,height};
}
