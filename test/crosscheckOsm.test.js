/**
 * Recoupement OSM — BK-OSM-*.
 * On teste la géométrie, c'est elle qui décide si un terrain est « confirmé » :
 * un seuil trop large validerait des terrains voisins, un seuil trop étroit
 * renverrait tout le référentiel à la vérification manuelle.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { distanceM, tile, bbox, MATCH_RADIUS_M, TILE_DEG } = require('../scripts/crosscheck-osm');

// ── BK-OSM-01 : distance ────────────────────────────────────────────────────
test('BK-OSM-01 haversine : mêmes coordonnées = 0, ~111 m par millième de degré', () => {
  assert.equal(distanceM(45.17, 5.72, 45.17, 5.72), 0);

  // 0,001° de latitude ≈ 111 m partout sur le globe
  const dLat = distanceM(45.17, 5.72, 45.171, 5.72);
  assert.ok(dLat > 108 && dLat < 114, `attendu ~111 m, obtenu ${dLat}`);

  // 0,001° de longitude à 45° de latitude ≈ 79 m (cos(45°) ≈ 0,71)
  const dLng = distanceM(45.17, 5.72, 45.17, 5.721);
  assert.ok(dLng > 75 && dLng < 83, `attendu ~79 m, obtenu ${dLng}`);
});

test('BK-OSM-02 le rayon de 50 m sépare un terrain du terrain voisin', () => {
  const place = { lat: 45.17, lng: 5.72 };
  // ~33 m au nord : même équipement cartographié avec un léger décalage
  assert.ok(distanceM(place.lat, place.lng, 45.1703, 5.72) <= MATCH_RADIUS_M);
  // ~220 m : autre terrain, ne doit pas confirmer
  assert.ok(distanceM(place.lat, place.lng, 45.172, 5.72) > MATCH_RADIUS_M);
});

// ── BK-OSM-03 : tuilage et bbox ─────────────────────────────────────────────
test('BK-OSM-03 tuilage : les lieux proches partagent une requête, les lointains non', () => {
  const grenoble = [
    { id: 1, lat: 45.170, lng: 5.720 },
    { id: 2, lat: 45.185, lng: 5.735 },
  ];
  const lyon = [{ id: 3, lat: 45.760, lng: 4.840 }];

  const tiles = tile([...grenoble, ...lyon]);
  assert.equal(tiles.length, 2, 'deux agglomérations = deux requêtes Overpass');
  const sizes = tiles.map(t => t.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('BK-OSM-04 bbox englobe tous les lieux avec une marge', () => {
  const [s, w, n, e] = bbox([
    { lat: 45.10, lng: 5.70 },
    { lat: 45.20, lng: 5.80 },
  ]);
  assert.ok(s < 45.10 && n > 45.20, 'la latitude est encadrée');
  assert.ok(w < 5.70 && e > 5.80, 'la longitude est encadrée');
  // Une tuile reste bornée : Overpass tombe en timeout sur une bbox trop large.
  assert.ok((n - s) < TILE_DEG * 2 && (e - w) < TILE_DEG * 2);
});
