/* Pages d'annonces simulées pour les tests (contenu fictif). */
const head = (title, extra = '') =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${extra}</head>`;
const style = 'font-family:system-ui,sans-serif;padding:24px;max-width:720px;line-height:1.5;color:#222';

export const listingPage = `${head('Appartement 3 pièces 55 m² Rennes - 174 000 €',
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Appartement 3 pièces', offers: { '@type': 'Offer', price: '174000' },
    itemOffered: { floorSize: { value: 55 }, numberOfRooms: 3, address: { postalCode: '35000', addressLocality: 'Rennes' } }
  })}</script>`)}
<body style="${style}"><main>
  <h1>Appartement 3 pièces 55 m² — 174 000 €</h1>
  <div class="location">Rennes (35000) — quartier Thabor</div>
  <div class="description">
    <p>Proche du Thabor, appartement T3 lumineux et traversant au 3ème étage avec ascenseur. Séjour avec balcon, deux chambres, cave. Double vitrage. Proche métro.</p>
    <p>Classe énergie : C (160 kWh/m²/an) — GES : B. Montant estimé des dépenses annuelles d'énergie : entre 720 € et 1 000 €.</p>
    <p>Copropriété de 30 lots. Montant moyen annuel de la quote-part de charges courantes : 1 560 €. Taxe foncière : 980 €. Immeuble construit en 1972. Petits travaux de rafraîchissement, humidité à surveiller dans la salle de bain.</p>
  </div>
</main></body></html>`;

export const leboncoinAd = (id, price, surface, rooms, dpe, district) => `${head(`T${rooms} ${district}`,
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ad: {
    list_id: id, subject: `Appartement T${rooms} ${district}`, price: [price], body: `Bel appartement quartier ${district}, balcon, cave.`,
    location: { city: 'Rennes', zipcode: '35000', district, lat: 48.11, lng: -1.68 },
    attributes: [{ key: 'square', value: String(surface) }, { key: 'rooms', value: String(rooms) },
      { key: 'energy_rate', value: dpe }, { key: 'real_estate_type', value: '2' }]
  } } } })}</script>`)}
<body style="${style}"><main><h1>Appartement T${rooms} ${district}</h1><p>${price} €</p>
<div data-qa-id="adview_description_container">Bel appartement quartier ${district}, balcon, cave.</div></main></body></html>`;

const card = (id, title, price, specs, district) =>
  `<li style="position:relative;border:1px solid #ddd;border-radius:10px;padding:44px 16px 16px;margin:0 0 12px;list-style:none">
    <a href="/ad/ventes_immobilieres/${id}" style="font-weight:600">${title}</a><p style="margin:6px 0">${price} €</p>
    <p style="margin:0;color:#555">${specs} · Rennes 35000 ${district}</p></li>`;

export const resultsPage = `${head('Ventes immobilières Rennes')}
<body style="${style}"><h2>Ventes immobilières — Rennes</h2><ul style="padding:0">
${card(3011111111, 'Appartement 3 pièces 64 m²', '176 000', '64 m² · 3 pièces · DPE C', 'Sud-Gare')}
${card(3022222222, 'Appartement 2 pièces 45 m²', '152 000', '45 m² · 2 pièces · DPE F', 'Cleunay')}
${card(3033333333, 'Appartement 3 pièces 58 m²', '168 000', '58 m² · 3 pièces · DPE D', 'Villejean')}
${card(3044444444, 'Appartement 4 pièces 80 m²', '245 000', '80 m² · 4 pièces · DPE C', 'Centre')}
</ul></body></html>`;
