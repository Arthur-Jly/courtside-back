/**
 * Chargement à la demande des terrains publics — BK-PC-*.
 * Règle testée en priorité : une zone inconnue est chargée UNE fois, l'API n'est
 * jamais sollicitée sans raison, et un échec ne casse pas la recherche.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const { createPlaceCoverage, HOURLY_BUDGET } = require('../src/services/placeCoverage');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');

const TODAY = new Date().toISOString().slice(0, 10);

/** Un équipement Data ES qui passe tous les filtres. */
const record = (n, over = {}) => ({
  equip_numero: `A${n}`,
  equip_nom: `Terrain ${n}`,
  equip_type_name: 'Multisports/City-stades',
  equip_utilisateur: ['Individuel'],
  aps_name: ['Football / Futsal'],
  equip_coordonnees: { lat: 48.85, lon: 2.35 },
  inst_adresse: '1 rue de la Paix',
  inst_cp: '75001',
  new_name: 'Paris',
  dep_nom: 'Paris',
  equip_maj_date: TODAY,
  ...over,
});

/** Base factice : zone couverte ou non, nombre de terrains déjà présents, lignes existantes. */
function makeDb({ covered = false, local = 0, existing = [] } = {}) {
  return fakeDb([
    [/FROM place_coverage/, () => (covered ? [{ ok: 1 }] : [])],
    [/COUNT\(\*\).*FROM public_places/s, () => [{ n: local }]],
    [/SELECT id, external_ref, verification_status.* FROM public_places/, () => existing],
    [/INSERT INTO public_places/, () => ({ insertId: 1 })],
    [/UPDATE public_places/, () => ({ affectedRows: 1 })],
    [/INSERT INTO place_coverage/, () => ({ affectedRows: 1 })],
  ]);
}

const callsTo = (db, re) => db.calls.filter(c => re.test(c.sql));

test('BK-PC-01 zone inconnue : appelle Data ES, garde les terrains valides, mémorise la zone', async () => {
  const db = makeDb();
  const wheres = [];
  const coverage = createPlaceCoverage(db, {
    fetchPage: async (where) => {
      wheres.push(where);
      return {
        total_count: 2,
        results: [record(1), record(2, { equip_type_name: 'Piscine' })], // 2e : type hors liste blanche
      };
    },
  });

  assert.equal(await coverage.ensure(48.85, 2.35), 'fetched');

  assert.equal(wheres.length, 1);
  assert.match(wheres[0], /within_distance\(equip_coordonnees, geom'POINT\(2\.35 48\.85\)', 25km\)/);
  assert.match(wheres[0], /equip_acc_libre="true"/);

  const inserts = callsTo(db, /INSERT INTO public_places/);
  assert.equal(inserts.length, 1, 'seul le terrain valide est enregistré');
  assert.equal(inserts[0].params[0], 'A1');

  const cov = callsTo(db, /INSERT INTO place_coverage/);
  assert.equal(cov.length, 1);
  assert.deepEqual(cov[0].params, [488, 23, 1]); // cellule 0,1° + nombre retenu
});

test('BK-PC-02 zone déjà couverte : aucun appel à l’API', async () => {
  const db = makeDb({ covered: true });
  let fetched = 0;
  const coverage = createPlaceCoverage(db, { fetchPage: async () => { fetched++; return { total_count: 0, results: [] }; } });

  assert.equal(await coverage.ensure(48.85, 2.35), 'covered');
  assert.equal(fetched, 0);
});

test('BK-PC-03 zone déjà bien fournie en base : aucun appel à l’API', async () => {
  const db = makeDb({ local: 12 });
  let fetched = 0;
  const coverage = createPlaceCoverage(db, { fetchPage: async () => { fetched++; return { total_count: 0, results: [] }; } });

  assert.equal(await coverage.ensure(45.18, 5.72), 'enough');
  assert.equal(fetched, 0);
});

test('BK-PC-04 hors de France ou coordonnées invalides : on n’appelle pas l’API', async () => {
  const db = makeDb();
  let fetched = 0;
  const coverage = createPlaceCoverage(db, { fetchPage: async () => { fetched++; return { total_count: 0, results: [] }; } });

  assert.equal(await coverage.ensure(40.71, -74.0), 'outside');   // New York
  assert.equal(await coverage.ensure('abc', 2.35), 'invalid');
  assert.equal(fetched, 0);
  assert.equal(db.calls.length, 0);
});

test('BK-PC-05 échec de l’API : ne lève pas, ne mémorise pas la zone (retentée ensuite)', async () => {
  const db = makeDb();
  const coverage = createPlaceCoverage(db, { fetchPage: async () => { throw new Error('API Data ES 503'); } });

  assert.equal(await coverage.ensure(48.85, 2.35), 'failed');
  assert.equal(callsTo(db, /INSERT INTO place_coverage/).length, 0);
  assert.equal(callsTo(db, /INSERT INTO public_places/).length, 0);
});

test('BK-PC-06 recherches simultanées sur la même zone : un seul appel', async () => {
  const db = makeDb();
  let fetched = 0;
  const coverage = createPlaceCoverage(db, {
    fetchPage: async () => { fetched++; await new Promise(r => setTimeout(r, 20)); return { total_count: 1, results: [record(1)] }; },
  });

  const out = await Promise.all([coverage.ensure(48.85, 2.35), coverage.ensure(48.851, 2.351), coverage.ensure(48.86, 2.36)]);
  assert.deepEqual(out, ['fetched', 'fetched', 'fetched']);
  assert.equal(fetched, 1);
});

test('BK-PC-07 budget horaire : au-delà, plus d’appel sortant jusqu’à la fenêtre suivante', async () => {
  const db = makeDb();
  let clock = 1_000_000;
  let fetched = 0;
  const coverage = createPlaceCoverage(db, {
    now: () => clock,
    fetchPage: async () => { fetched++; return { total_count: 0, results: [] }; },
  });

  for (let i = 0; i < HOURLY_BUDGET; i++) {
    assert.equal(await coverage.ensure(42 + i * 0.1, 2.0), 'fetched');
  }
  assert.equal(await coverage.ensure(49.5, 2.0), 'budget');
  assert.equal(fetched, HOURLY_BUDGET);

  clock += 3601 * 1000;
  assert.equal(await coverage.ensure(49.5, 2.0), 'fetched');
});

test('BK-PC-08 zone dense : les pages suivantes sont lues', async () => {
  const db = makeDb();
  const offsets = [];
  const coverage = createPlaceCoverage(db, {
    fetchPage: async (_where, offset) => {
      offsets.push(offset);
      return { total_count: 250, results: [record(offset + 1)] };
    },
  });

  assert.equal(await coverage.ensure(48.85, 2.35), 'fetched');
  assert.deepEqual([...offsets].sort((a, b) => a - b), [0, 100, 200]);
});

test('BK-PC-09 un terrain vérifié à la main n’est jamais réécrit par le chargement', async () => {
  const db = makeDb({ existing: [{ id: 5, external_ref: 'A1', verification_status: 'manually_curated' }] });
  const coverage = createPlaceCoverage(db, { fetchPage: async () => ({ total_count: 1, results: [record(1)] }) });

  assert.equal(await coverage.ensure(48.85, 2.35), 'fetched');
  assert.equal(callsTo(db, /INSERT INTO public_places/).length, 0);
  assert.equal(callsTo(db, /UPDATE public_places SET name/).length, 0);
  // Le masquage des absents exclut lui aussi les terrains curés à la main.
  for (const c of callsTo(db, /SET source_missing_at = NOW\(\)/)) assert.match(c.sql, /NOT IN \('manually_curated'/);
});

// ── Câblage sur la recherche ────────────────────────────────────────────────
function makeApp(db, coverage) {
  const app = express();
  app.use(express.json());
  app.use('/api', publicPlacesRouter(db, { coverage }));
  app.use(errorHandler);
  return app;
}

test('BK-PC-10 GET /public-places?lat&lng charge la zone avant de répondre ; sans coordonnées, non', async () => {
  const db = fakeDb([[/FROM public_places p/, () => []]]);
  const seen = [];
  const coverage = { ensure: async (lat, lng, radius) => { seen.push([lat, lng, radius]); return 'fetched'; } };
  const { server, url } = await listen(makeApp(db, coverage));
  try {
    const geo = await fetch(`${url}/api/public-places?lat=48.85&lng=2.35&radius=5`);
    assert.equal(geo.status, 200);
    assert.deepEqual(seen, [[48.85, 2.35, 5]]);

    await fetch(`${url}/api/public-places?city=Paris`);
    assert.equal(seen.length, 1, 'recherche par ville : pas de chargement');
  } finally { server.close(); }
});

test('BK-PP-35 rafraîchissement : les terrains absents de Data ES sont masqués (source_missing_at), pas supprimés', async () => {
  const db = makeDb();
  const coverage = createPlaceCoverage(db, {
    fetchPage: async () => ({ total_count: 2, results: [record(1), record(2)] }),
  });
  assert.equal(await coverage.ensure(48.85, 2.35), 'fetched');
  const mark = callsTo(db, /SET source_missing_at = NOW\(\)/);
  assert.equal(mark.length, 1);
  assert.match(mark[0].sql, /source = 'data_es'/);
  assert.match(mark[0].sql, /NOT IN \('manually_curated', 'community_verified'\)/);
  assert.match(mark[0].sql, /external_ref NOT IN \(\?\)/);
  assert.deepEqual(mark[0].params.at(-1), ['A1', 'A2'], 'les terrains retenus restent visibles');
  assert.equal(callsTo(db, /DELETE FROM public_places/).length, 0);
});

test('BK-PP-36 lecture Data ES tronquée (zone trop dense) : on ne masque rien', async () => {
  const db = makeDb();
  const coverage = createPlaceCoverage(db, {
    fetchPage: async () => ({ total_count: 99999, results: [record(1)] }),
  });
  assert.equal(await coverage.ensure(48.85, 2.35), 'fetched');
  assert.equal(callsTo(db, /SET source_missing_at = NOW\(\)/).length, 0);
});

test('BK-PC-11 GET /public-places?city= sans coordonnées : zone de la commune chargée, vérifiée et mise en file OSM ; filtre ville conservé', async () => {
  const db = fakeDb([[/FROM public_places p/, () => []]]);
  const seen = { ensure: [], verify: [], osm: [], located: [] };
  const deps = {
    coverage: { ensure: async (...a) => { seen.ensure.push(a); return 'fetched'; } },
    verification: { verifyArea: async (...a) => { seen.verify.push(a); return 'verified'; } },
    osmQueue: { enqueueArea: (...a) => { seen.osm.push(a); } },
    cityLocator: { locate: async (c) => { seen.located.push(c); return c === 'Grenoble' ? { lat: 45.18, lng: 5.72, radiusKm: 6 } : null; } },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', publicPlacesRouter(db, deps));
  app.use(errorHandler);
  const { server, url } = await listen(app);
  try {
    const res = await fetch(`${url}/api/public-places?city=Grenoble`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen.ensure, [[45.18, 5.72, 6]]);
    assert.deepEqual(seen.verify, [[45.18, 5.72, 6]]);
    assert.deepEqual(seen.osm, [[45.18, 5.72, 6]]);
    const search = db.calls.find(c => /FROM public_places p/.test(c.sql) && /LIMIT \?/.test(c.sql));
    assert.match(search.sql, /LOWER\(p\.city\) = LOWER\(\?\)/);
    assert.doesNotMatch(search.sql, /distance_km/, 'la recherche reste une recherche par ville');

    await fetch(`${url}/api/public-places?city=Nullepart`);
    assert.equal(seen.ensure.length, 1, 'ville introuvable : rien de chargé, la base répond');

    await fetch(`${url}/api/public-places?lat=48.85&lng=2.35&radius=5&city=Paris`);
    assert.ok(!seen.located.includes('Paris'), 'avec coordonnées, la ville n’est pas résolue');
  } finally { server.close(); }
});
