/**
 * Filtres Data ES (couche 1) — BK-PP-10 à 13.
 * Chaque cas correspond à un défaut mesuré sur le référentiel réel (oct. 2026) :
 * 88 terrains « hors service » laissés passer, un filtre d'ancienneté inopérant
 * (date d'export commune à 93 % des fiches) et des gymnases fermés à clé.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { bool, rejectReason, TYPES_AUTORISES } = require('../src/services/dataEs');

/** Fiche qui passe tous les filtres. */
const record = (over = {}) => ({
  equip_numero: 'E001I381500002',
  equip_nom: 'City stade',
  equip_type_name: 'Multisports/City-stades',
  equip_utilisateur: ['Individuel(s),famille(s)'],
  aps_name: ['Football / Football en salle (Futsal)'],
  equip_coordonnees: { lat: 45.2, lon: 5.83 },
  inst_adresse: '1 rue du Stade',
  new_name: 'Domène',
  inst_hs_bool: 'Non',
  equip_maj_date: '2025-03-31',
  ...over,
});

test('BK-PP-10 bool() lit les « Oui » / « Non » de Data ES comme les true / false', () => {
  assert.equal(bool('Oui'), true);
  assert.equal(bool('oui '), true);
  assert.equal(bool('Non'), false);
  assert.equal(bool('true'), true);
  assert.equal(bool('false'), false);
  assert.equal(bool(true), true);
  assert.equal(bool(0), false);
  assert.equal(bool(null), null);
  assert.equal(bool('peut-être'), null);
});

test('BK-PP-11 inst_hs_bool « Oui » → rejeté hors service ; « Non » → retenu', () => {
  assert.equal(rejectReason(record({ inst_hs_bool: 'Oui' })), 'hors_service');
  assert.equal(rejectReason(record({ inst_hs_bool: 'Non' })), null);
});

test('BK-PP-12 aucune règle sur equip_maj_date (date d’export, pas de mise à jour)', () => {
  assert.equal(rejectReason(record({ equip_maj_date: '2010-01-01' })), null);
  assert.equal(rejectReason(record({ equip_maj_date: null })), null);
});

test('BK-PP-13 gymnase écarté : une salle est fermée à clé hors créneaux', () => {
  assert.equal(TYPES_AUTORISES.has('Salle multisports (gymnase)'), false);
  assert.equal(rejectReason(record({ equip_type_name: 'Salle multisports (gymnase)' })), 'type_hors_liste_blanche');
});
