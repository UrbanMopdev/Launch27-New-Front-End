import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { CleanerRoute } from '../lib/routes';
import { fmtClock } from '../lib/dispatch';

// Map of cleaner routes: a house marker at home, numbered stops, and lines between them.
// Tiles are OpenStreetMap (free, attribution required). Lines are straight between stops —
// the drive follows roads.

const cleanName = (name = '') => name.replace(/^(\s*(\([^)]*\)|ON HOLD))+\s*/i, '') || name;
const has = (p: { latitude?: number | null; longitude?: number | null }) => p.latitude != null && p.longitude != null;

export function RouteMap({ routes, selectedId, onSelect, height = 460 }: { routes: CleanerRoute[]; selectedId: number | null; onSelect: (id: number | null) => void; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, scrollWheelZoom: false }).setView([45.4215, -75.6972], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    const shown = selectedId ? routes.filter((r) => r.team.id === selectedId) : routes;
    for (const r of shown) {
      const color = r.team.bg_color && r.team.bg_color !== '#ffffff' ? r.team.bg_color : '#1f6feb';
      const faded = selectedId !== null && r.team.id !== selectedId;
      const pts: L.LatLngExpression[] = [];
      const home = { latitude: r.team.latitude, longitude: r.team.longitude };
      if (has(home)) {
        const p: L.LatLngExpression = [home.latitude!, home.longitude!];
        pts.push(p);
        L.marker(p, { icon: L.divIcon({ className: 'map-home', html: '🏠', iconSize: [22, 22], iconAnchor: [11, 11] }) })
          .bindTooltip(`${cleanName(r.team.title)} — home`)
          .on('click', () => onSelect(r.team.id))
          .addTo(g);
      }
      r.stops.forEach((s, i) => {
        const a = s.booking.address || {};
        if (!has(a)) return;
        const p: L.LatLngExpression = [a.latitude!, a.longitude!];
        pts.push(p);
        L.marker(p, {
          icon: L.divIcon({
            className: 'map-stop',
            html: `<span style="background:${color};${s.tight ? 'outline:2px solid #c62828;' : ''}">${i + 1}</span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
          opacity: faded ? 0.4 : 1,
        })
          .bindTooltip(`${i + 1}. ${fmtClock(s.start)} · ${s.booking.user?.name || ''}<br>${cleanName(r.team.title)}`)
          .on('click', () => onSelect(r.team.id))
          .addTo(g);
      });
      if (has(home) && pts.length > 1) pts.push(pts[0]);
      if (pts.length > 1) L.polyline(pts, { color, weight: selectedId ? 4 : 2.5, opacity: faded ? 0.25 : 0.85, dashArray: selectedId ? undefined : '6 4' }).addTo(g);
      bounds.push(...pts);
    }
    // No animation: re-fitting mid-animation (e.g. tapping another cleaner) breaks Leaflet.
    if (bounds.length) m.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 14, animate: false });
  }, [routes, selectedId, onSelect]);

  return <div ref={el} className="route-map" style={{ height }} />;
}
