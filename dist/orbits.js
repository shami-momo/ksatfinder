import { json2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';

import satellites from '../data/satellites.json' with { type:'json' };
export const CATALOG = satellites;
export const STATUS_LABELS = {active:'운용 중',retired:'운용 종료',unknown:'운용 미확인'};
const catalogIds = new Set(CATALOG.map(s => s.id));

export function parseElements(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('JSON 배열이 필요합니다');
  const valid = new Map();
  const fields = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
  for (const row of rows) {
    if (!row || typeof row.EPOCH !== 'string') continue;
    if (!catalogIds.has(Number(row.NORAD_CAT_ID))) continue;
    // CelesTrak's timezone-free OMM epochs are UTC, including on a Korean computer.
    const epoch = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(row.EPOCH) ? row.EPOCH : `${row.EPOCH}Z`);
    if (!Number.isFinite(epoch) || Math.abs(now - epoch) > 7 * 86400000) continue;
    if (!fields.every(f => row[f] !== null && row[f] !== undefined && row[f] !== '' && Number.isFinite(Number(row[f])))) continue;
    const elements = Object.fromEntries(fields.map(f => [f, Number(row[f])]));
    if (elements.MEAN_MOTION <= 0 || elements.ECCENTRICITY < 0 || elements.ECCENTRICITY >= 1 || elements.INCLINATION < 0 || elements.INCLINATION > 180) continue;
    Object.assign(elements, { NORAD_CAT_ID: Number(row.NORAD_CAT_ID), EPOCH: new Date(epoch).toISOString() });
    if (position({ elements }, new Date(now))) valid.set(elements.NORAD_CAT_ID, elements);
  }
  return valid;
}

export function position(sat, date) {
  if (!sat?.elements) return null;
  try {
    sat.record ||= json2satrec(sat.elements);
    const result = propagate(sat.record, date);
    if (!result?.position || !Object.values(result.position).every(Number.isFinite)) return null;
    const geo = eciToGeodetic(result.position, gstime(date));
    const lat = degreesLat(geo.latitude), lon = degreesLong(geo.longitude);
    if (![lat, lon, geo.height].every(Number.isFinite) || geo.height < 0) return null;
    return { lat, lon, altitude: geo.height, period: 1440 / sat.elements.MEAN_MOTION };
  } catch { return null; }
}

// First lunar-orbit insertion manoeuvre, as announced by KARI (KST).
export const LUNAR_ORBIT_INSERTION=Date.parse('2022-12-17T02:45:00+09:00');

// Positions are in the Moon's fixed MOON_ME frame, in kilometres.
export function sampleDanuri(data,time) {
  const points = data?.points;
  const t = Number(time);
  if (!points?.length || t<points[0].t || t>points.at(-1).t) return null;
  let low=0, high=points.length-1;
  while (high-low>1) { const mid=(low+high)>>1; if (points[mid].t<=t) low=mid; else high=mid; }
  const a=points[low], b=points[high], before=points[Math.max(0,low-1)], after=points[Math.min(points.length-1,high+1)];
  const dt=b.t-a.t, u=(t-a.t)/dt;
  const h00=2*u*u*u-3*u*u+1, h10=u*u*u-2*u*u+u, h01=-2*u*u*u+3*u*u, h11=u*u*u-u*u;
  const p={};
  for (const key of ['x','y','z']) {
    const va=(b[key]-before[key])/(b.t-before.t), vb=(after[key]-a[key])/(after.t-a.t);
    p[key]=h00*a[key]+h10*dt*va+h01*b[key]+h11*dt*vb;
  }
  const distance=Math.hypot(p.x,p.y,p.z);
  const earthDistance=Number.isFinite(a.earthDistance) && Number.isFinite(b.earthDistance) ? a.earthDistance+(b.earthDistance-a.earthDistance)*u : null;
  return {...p,distance,earthDistance,altitude:distance-data.radius,lat:Math.asin(p.z/distance)*180/Math.PI,lon:Math.atan2(p.y,p.x)*180/Math.PI};
}
