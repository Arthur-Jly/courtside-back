/**
 * Géométrie légère pour le recoupement des terrains (BD TOPO, OSM).
 * Les distances en jeu sont de quelques dizaines de mètres : la haversine et un
 * centroïde par moyenne des sommets suffisent largement.
 * Les anneaux sont au format GeoJSON : [[lng, lat], …].
 */

/** Distance haversine en mètres. */
function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180;
  const la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Boîte englobante d'un cercle : { south, west, north, east }. */
function bboxAround(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { south: lat - latDelta, west: lng - lngDelta, north: lat + latDelta, east: lng + lngDelta };
}

/** Boîte englobante d'un ensemble de points, élargie de `marginDeg`. */
function bboxOf(points, marginDeg = 0) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lng); east = Math.max(east, p.lng);
  }
  return { south: south - marginDeg, west: west - marginDeg, north: north + marginDeg, east: east + marginDeg };
}

/** Centroïde d'un anneau (moyenne des sommets, sommet de fermeture exclu). */
function ringCentroid(ring) {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;
  let lat = 0, lng = 0;
  for (const [x, y] of pts) { lng += x; lat += y; }
  return { lat: lat / pts.length, lng: lng / pts.length };
}

/** Le point est-il dans l'anneau ? (lancer de rayon) */
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

module.exports = { distanceM, bboxAround, bboxOf, ringCentroid, pointInRing };
