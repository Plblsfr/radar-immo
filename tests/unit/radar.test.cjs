/* Tests unitaires de la logique partagée (src/lib/radar.js).
 * Lancer : npm test   (utilise le runner intégré de Node, aucune dépendance) */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../src/lib/radar.js');

/** Critères de test indépendants des valeurs par défaut. */
function fixtureSettings() {
  const S = JSON.parse(JSON.stringify(R.DEFAULT_SETTINGS));
  Object.assign(S, {
    city: 'Villetest', postalCodes: ['99000'], priceMin: 95000, priceMax: 115000, priceTolerancePct: 5,
    rooms: [2, 3], surfaceMin: 35, dpeMin: 'D', dpePref: 'C', chargesMaxMonthly: 150, refPriceM2: 2000
  });
  S.loan = { apport: 0, ratePct: 3.4, years: 25, insurancePct: 0.3, notaryPct: 7.5, maxMonthly: 800 };
  S.zones = [
    { name: 'Les Tilleuls', keywords: ['Les Tilleuls'], status: 'banned' },
    { name: 'Vieux Port', keywords: ['Vieux Port'], status: 'preferred' },
    { name: 'Gare', keywords: ['Gare'], status: 'neutral' }
  ];
  return S;
}

const TITLE = 'Vente appartement 3 pièces 62 m² Villetest (99000) - 105 000 €';
const BODY = `Appartement T3 de 62,5 m² situé quartier Vieux Port, au 2ème étage avec ascenseur. Balcon, cave.
Classe énergie : C  (165 kWh/m²/an) GES : B
Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre 780 € et 1 100 € par an.
Copropriété de 24 lots. Montant moyen annuel de la quote-part de charges courantes : 1 440 €. Taxe foncière : 890 €.
Immeuble construit en 1965. Honoraires inclus. Prix 105 000 €. Voir aussi nos biens à 230 000 €.`;

describe('extractFromText', () => {
  const t = R.extractFromText(TITLE, BODY);
  test('prix, surface, pièces', () => {
    assert.equal(t.price, 105000);
    assert.equal(t.surface, 62);
    assert.equal(t.rooms, 3);
  });
  test('DPE, GES et dépenses d\'énergie', () => {
    assert.equal(t.dpe, 'C');
    assert.equal(t.ges, 'B');
    assert.deepEqual(t.energyCost, [780, 1100]);
  });
  test('copropriété', () => {
    assert.equal(t.chargesMonthly, 120);
    assert.equal(t.taxeFonciere, 890);
    assert.equal(t.lots, 24);
  });
  test('étage, ascenseur, année, code postal', () => {
    assert.equal(t.floor, 2);
    assert.equal(t.elevator, true);
    assert.equal(t.yearBuilt, 1965);
    assert.equal(t.postalCode, '99000');
  });
  test('classe DPE déduite des kWh si la lettre manque', () => {
    assert.equal(R.extractFromText('T2 40 m² 90 000 €', 'Consommation 260 kWh/m²/an').dpe, 'E');
  });
});

describe('score', () => {
  test('annonce idéale : zone préférée, aucun critère éliminatoire', () => {
    const S = fixtureSettings();
    const a = R.analyze(Object.assign({ id: 't:1', title: TITLE, description: BODY, locationText: 'Villetest Vieux Port' }, R.extractFromText(TITLE, BODY)), S);
    assert.equal(a.analysis.eliminated, false);
    assert.ok(a.analysis.score >= 80, `score ${a.analysis.score}`);
    assert.equal(a.analysis.verdict, 'Coup de cœur');
  });
  test('zone bannie dans l\'adresse + DPE F => éliminée', () => {
    const S = fixtureSettings();
    const raw = R.extractFromText('Appartement 2 pièces 45 m² 98 000 €', 'DPE : F. Sans ascenseur. Viager occupé.');
    const a = R.analyze(Object.assign({ id: 't:2', locationText: 'Villetest Les Tilleuls', description: 'Sans ascenseur. Viager occupé.' }, raw), S);
    assert.equal(a.analysis.eliminated, true);
    assert.ok(!a.keywords.good.includes('ascenseur'), '« sans ascenseur » ne doit pas compter comme atout');
  });
  test('zone bannie seulement citée dans la description => simple avertissement', () => {
    const S = fixtureSettings();
    const a = R.analyze({ id: 't:3', price: 104000, surface: 50, rooms: 2, dpe: 'D', locationText: 'Villetest Gare', description: 'à 10 min des Tilleuls et de Les Tilleuls' }, S);
    assert.equal(a.analysis.eliminated, false);
    assert.ok(a.analysis.checks.some((c) => /mentionne/.test(c.detail || '')));
  });
  test('prix au-delà de max + tolérance => éliminée', () => {
    const a = R.analyze({ id: 't:4', price: 139000, surface: 80, rooms: 3, dpe: 'C' }, fixtureSettings());
    assert.equal(a.analysis.eliminated, true);
  });
});

describe('adaptateurs', () => {
  test('Leboncoin (__NEXT_DATA__)', () => {
    const r = R.extractFromLeboncoin({ props: { pageProps: { ad: { subject: 'T2 lumineux', price: [102000], body: 'x',
      location: { city: 'Villetest', zipcode: '99000', lat: 48.1, lng: -1.6, district: 'Gare' },
      attributes: [{ key: 'square', value: '48' }, { key: 'rooms', value: '2' }, { key: 'energy_rate', value: 'c' }, { key: 'real_estate_type', value: '2' }] } } } });
    assert.equal(r.price, 102000);
    assert.equal(r.surface, 48);
    assert.equal(r.dpe, 'C');
    assert.equal(r.propertyType, 'appartement');
  });
  test('JSON-LD schema.org', () => {
    const j = R.extractFromJsonLd([{ '@type': 'Product', name: 'Appartement 3 pièces', offers: { '@type': 'Offer', price: '108000' },
      itemOffered: { floorSize: { value: 63 }, numberOfRooms: 3, address: { postalCode: '99000', addressLocality: 'Villetest' } } }]);
    assert.equal(j.price, 108000);
    assert.equal(j.surface, 63);
    assert.equal(j.postalCode, '99000');
  });
});

describe('finance', () => {
  test('mensualité hors assurance', () => {
    assert.ok(Math.abs(R.monthlyPayment(100000, 3.4, 25, 0) - 495.1) < 1);
  });
  test('financement inclut les frais de notaire', () => {
    const f = R.financing(100000, fixtureSettings());
    assert.equal(Math.round(f.notary), 7500);
    assert.equal(Math.round(f.principal), 107500);
  });
  test('prix max cohérent avec la mensualité max', () => {
    const S = fixtureSettings();
    const pmax = R.maxPriceForMonthly(S);
    assert.ok(Math.abs(R.financing(pmax, S).monthly - S.loan.maxMonthly) < 1);
  });
});

describe('doublons et URLs', () => {
  test('même bien sur deux sites', () => {
    assert.ok(R.sameProperty({ id: 'a', price: 105000, surface: 62, rooms: 3, dpe: 'C' }, { id: 'b', price: 99000, surface: 62.4, rooms: 3, dpe: 'C' }));
    assert.ok(!R.sameProperty({ id: 'a', price: 105000, surface: 62, rooms: 3 }, { id: 'b', price: 105000, surface: 70, rooms: 3 }));
  });
  test('détection des pages d\'annonce', () => {
    assert.ok(R.isListingUrl('https://www.leboncoin.fr/ad/ventes_immobilieres/2987654321'));
    assert.ok(!R.isListingUrl('https://www.leboncoin.fr/recherche?category=9'));
    assert.equal(R.listingId('https://www.leboncoin.fr/ad/ventes_immobilieres/2987654321?utm=1'), 'leboncoin:2987654321');
  });
  test('recherche Leboncoin pré-remplie', () => {
    const url = new URL(R.searchLinks(fixtureSettings())[0].url);
    assert.equal(url.searchParams.get('locations'), 'Villetest_99000');
    assert.equal(url.searchParams.get('rooms'), '2-3');
    assert.equal(url.searchParams.get('energy_rate'), 'a,b,c,d');
  });
});
