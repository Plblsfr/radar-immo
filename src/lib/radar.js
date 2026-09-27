/* Radar Immo — logique partagée (content script, popup, dashboard, service worker, tests Node).
 * Aucune dépendance. Expose globalThis.RadarImmo (et module.exports sous Node). */
(function (root) {
  'use strict';

  const DPE_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  // Seuils DPE (kWh énergie primaire / m² / an) — barème 2021
  const DPE_KWH = [[70, 'A'], [110, 'B'], [180, 'C'], [250, 'D'], [330, 'E'], [420, 'F'], [Infinity, 'G']];
  // Calendrier loi Climat & Résilience : interdiction de mise en location
  const RENT_BAN = { G: 2025, F: 2028, E: 2034 };

  // Configuration d'EXEMPLE (Rennes) : à remplacer par ta ville et tes quartiers dans l'onglet « Critères ».
  // Tous les quartiers sont « neutres » par défaut : c'est l'utilisateur qui bannit ou préfère.
  const EXAMPLE_ZONES = [
    'Centre', 'Thabor', 'Saint-Hélier', "Bourg-l'Évêque", 'Saint-Martin', 'Maurepas', "Jeanne d'Arc", 'Beaulieu',
    'Poterie', 'Sud-Gare', 'Cleunay', 'La Courrouze', 'Villejean', 'Beauregard', 'Le Blosne', 'Bréquigny'
  ].map((name) => ({ name, keywords: [name], status: 'neutral' }));

  const DEFAULT_SETTINGS = {
    city: 'Rennes',
    postalCodes: ['35000'],
    propertyType: 'appartement',
    priceMin: 150000,
    priceMax: 190000,
    priceTolerancePct: 5,       // au-delà de max + tolérance => éliminé
    rooms: [2, 3],
    surfaceMin: 40,
    dpeMin: 'D',                // pire classe acceptée
    dpePref: 'C',               // classe visée
    chargesMaxMonthly: 150,
    refPriceM2: 3500,           // valeur d'exemple : mets la médiane DVF de ton secteur
    zones: EXAMPLE_ZONES,
    loan: { apport: 0, ratePct: 3.4, years: 25, insurancePct: 0.30, notaryPct: 7.5, maxMonthly: 900 },
    keywordsBad: ['viager', 'nue-propriété', 'nue propriété', 'travaux à prévoir', 'gros travaux', 'à rénover entièrement',
      'procédure', 'plan de sauvegarde', 'copropriété en difficulté', 'ravalement voté', 'sous-sol', 'vis-à-vis',
      'sans ascenseur', 'mérule', 'humidité', 'occupé', 'loué', 'bail en cours', 'rez-de-chaussée sur rue'],
    keywordsGood: ['balcon', 'terrasse', 'cave', 'parking', 'garage', 'double vitrage', 'vue mer', 'vue sur mer',
      'lumineux', 'traversant', 'rénové', 'refait à neuf', 'ascenseur', 'calme', 'dernier étage', 'tram', 'exposé sud'],
    searches: [],
    highlightResults: true,
    showPanel: true
  };

  const SITES = [
    { id: 'leboncoin', name: 'Leboncoin', host: /(^|\.)leboncoin\.fr$/, listing: /\/(ad\/)?ventes_immobilieres\/\d+/ },
    { id: 'seloger', name: 'SeLoger', host: /(^|\.)seloger\.com$/, listing: /\/annonces\/achat[^?#]*\/\d+\.htm|\/annonces\/achat\/[^?#]*\d{6,}/ },
    { id: 'pap', name: 'PAP', host: /(^|\.)pap\.fr$/, listing: /\/annonces\/[^?#]*-r\d{6,}/ },
    { id: 'bienici', name: "Bien'ici", host: /(^|\.)bienici\.com$/, listing: /\/annonce\/(vente|achat)\// },
    { id: 'logicimmo', name: 'Logic-Immo', host: /(^|\.)logic-immo\.com$/, listing: /detail-vente-|\/annonces\/[^?#]*\d{6,}/ },
    { id: 'ouestfrance', name: 'Ouest-France Immo', host: /(^|\.)ouestfrance-immo\.com$/, listing: /\/immobilier\/vente\/[^?#]*\d{6,}/ },
    { id: 'figaro', name: 'Figaro Immobilier', host: /(^|\.)immobilier\.lefigaro\.fr$/, listing: /\/annonces\/annonce-\d+/ },
    { id: 'paruvendu', name: 'ParuVendu', host: /(^|\.)paruvendu\.fr$/, listing: /\/immobilier\/vente\/[^?#]*\d{6,}/ },
    { id: 'notaires', name: 'Immobilier.notaires', host: /(^|\.)immobilier\.notaires\.fr$/, listing: /\/fr\/annonce-immo-/ },
    { id: 'orpi', name: 'Orpi', host: /(^|\.)orpi\.com$/, listing: /\/annonce-vente-/ },
    { id: 'century21', name: 'Century 21', host: /(^|\.)century21\.fr$/, listing: /\/trouver_logement\/detail\// },
    { id: 'laforet', name: 'Laforêt', host: /(^|\.)laforet\.com$/, listing: /\/agence-immobiliere\/[^?#]*\/acheter\/[^?#]*\d+/ },
    { id: 'guyhoquet', name: 'Guy Hoquet', host: /(^|\.)guy-hoquet\.com$/, listing: /\/biens\/result\/\d+|\/annonce\// },
    { id: 'iad', name: 'IAD', host: /(^|\.)iadfrance\.fr$/, listing: /\/annonce\// },
    { id: 'safti', name: 'Safti', host: /(^|\.)safti\.fr$/, listing: /\/annonces\/achat\/[^?#]*\d+/ },
    { id: 'capifrance', name: 'Capifrance', host: /(^|\.)capifrance\.fr$/, listing: /\/vente\/[^?#]*\d+/ },
    { id: 'avendrealouer', name: 'AVendreALouer', host: /(^|\.)avendrealouer\.fr$/, listing: /\/vente\/[^?#]*\d{6,}\.html/ },
    { id: 'superimmo', name: 'Superimmo', host: /(^|\.)superimmo\.com$/, listing: /\/annonces\/[^?#]*\d{5,}/ },
    { id: 'entreparticuliers', name: 'Entreparticuliers', host: /(^|\.)entreparticuliers\.com$/, listing: /\/annonces-immobilieres\/[^?#]*\d{5,}/ }
  ];

  // ───────────────────────── Utilitaires
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’']/g, ' ').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const toNum = (s) => {
    if (s == null) return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    const t = String(s).replace(/[\s  ]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = (kw) => new RegExp('(^|[^a-z0-9])' + escRe(norm(kw)) + '($|[^a-z0-9])');
  const fmtEur = (n, dec = 0) => n == null || !isFinite(n) ? '—' :
    n.toLocaleString('fr-FR', { maximumFractionDigits: dec, minimumFractionDigits: dec }) + ' €';
  const dpeRank = (l) => (l ? DPE_ORDER.indexOf(String(l).toUpperCase()) : -1);
  const dpeFromKwh = (k) => { for (const [max, l] of DPE_KWH) if (k <= max) return l; return null; };

  function siteFor(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return null; }
    return SITES.find((s) => s.host.test(host)) || null;
  }
  function isListingUrl(url) {
    const s = siteFor(url);
    if (!s) return false;
    try { const u = new URL(url); return s.listing.test(u.pathname + u.search); } catch (e) { return false; }
  }
  function listingId(url) {
    try {
      const u = new URL(url);
      const s = siteFor(url);
      const nums = (u.pathname.match(/\d{5,}/g) || []);
      const tail = nums.length ? nums[nums.length - 1] : u.pathname.replace(/\/+$/, '');
      return (s ? s.id : u.hostname.replace(/^www\./, '')) + ':' + tail;
    } catch (e) { return 'url:' + url; }
  }
  function cleanUrl(url) {
    try { const u = new URL(url); u.hash = ''; ['utm_source', 'utm_medium', 'utm_campaign', 'xtor', 'at_medium'].forEach((p) => u.searchParams.delete(p)); return u.toString(); } catch (e) { return url; }
  }

  // ───────────────────────── Extraction depuis du texte libre
  const PRICE_RE = /(\d{1,3}(?:[\s  .]\d{3})+|\d{5,7})\s*(?:€|eur\b|euros?\b)/gi;

  function pricesIn(text) {
    const out = [];
    let m; PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(text))) { const n = toNum(m[1]); if (n >= 15000 && n <= 5000000) out.push(n); }
    return out;
  }

  function extractFromText(title, body) {
    const t = String(title || '');
    const b = String(body || '');
    const all = t + '\n' + b;
    const r = {};

    // Prix : d'abord le titre, sinon la valeur la plus fréquente dans la page
    const tp = pricesIn(t);
    if (tp.length) r.price = tp[0];
    else {
      const bp = pricesIn(b.slice(0, 20000));
      if (bp.length) {
        const freq = {}; bp.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
        r.price = +Object.keys(freq).sort((a, c) => freq[c] - freq[a] || bp.indexOf(+a) - bp.indexOf(+c))[0];
      }
    }

    // Surface
    const surfRe = /(\d{1,3}(?:[.,]\d{1,2})?)\s*m(?:²|2|²|etres? carr)/i;
    let m = t.match(surfRe) ||
      b.match(/surface(?:\s*habitable|\s*carrez|\s*loi carrez)?\s*(?:de|:)?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*m/i) ||
      b.match(surfRe);
    if (m) { const s = toNum(m[1]); if (s >= 8 && s <= 400) r.surface = s; }

    // Pièces / chambres
    m = t.match(/(\d{1,2})\s*pi[eè]ces?/i) || t.match(/\b[TF](\d)\b/) || b.match(/(\d{1,2})\s*pi[eè]ces?/i) ||
      b.match(/\b(?:type|appartement)\s*[TF]?(\d)\b/i) || b.match(/\b[TF](\d)\b/);
    if (m) r.rooms = +m[1];
    else if (/\bstudio\b/i.test(t)) r.rooms = 1;
    m = all.match(/(\d{1,2})\s*chambres?/i);
    if (m) r.bedrooms = +m[1];

    // Type de bien
    const tn = norm(t + ' ' + b.slice(0, 800));
    if (/\b(maison|pavillon|longere|villa)\b/.test(norm(t))) r.propertyType = 'maison';
    else if (/\b(appartement|studio|duplex|loft|t\d|f\d)\b/.test(tn)) r.propertyType = 'appartement';

    // DPE / GES
    m = b.match(/(?:DPE|diagnostic de performance [ée]nerg[ée]tique|classe [ée]nergie|consommation [ée]nerg[ée]tique|performance [ée]nerg[ée]tique|[ée]tiquette [ée]nergie)\s*(?:\(?[a-zé ]*\)?)?\s*[:\-–]?\s*(?:classe\s*)?\b([A-G])\b(?![a-z])/i);
    if (m) r.dpe = m[1].toUpperCase();
    if (/dpe\s*(?:vierge|non (?:soumis|communiqu|r[ée]alis))/i.test(b)) r.dpeNote = 'DPE vierge / non communiqué';
    m = b.match(/(\d{2,3})\s*kwh\s*(?:ep)?\s*\/\s*m/i);
    if (m) { r.dpeKwh = +m[1]; if (!r.dpe) r.dpe = dpeFromKwh(r.dpeKwh); }
    m = b.match(/(?:GES|gaz [àa] effet de serre|[ée]missions?(?: de)? (?:gaz|GES))\s*[:\-–]?\s*(?:classe\s*)?\b([A-G])\b(?![a-z])/i);
    if (m) r.ges = m[1].toUpperCase();

    // Dépenses d'énergie estimées (mention obligatoire)
    m = b.match(/(?:d[ée]penses?|co[uû]ts?)[^.\n]{0,80}?[ée]nergie[^.\n]{0,80}?entre\s*(\d[\d\s  ]*)\s*(?:€|euros?)?\s*et\s*(\d[\d\s  ]*)\s*(?:€|euros?)/i);
    if (m) r.energyCost = [toNum(m[1]), toNum(m[2])];

    // Charges de copropriété
    m = b.match(/(?:quote[\s-]part|charges?)[^.\n]{0,70}?(?:annuel(?:le)?s?|par an|\/\s*an)[^.\n\d]{0,30}(\d[\d\s  ]*(?:[.,]\d+)?)\s*(?:€|euros?)/i);
    if (m) r.chargesMonthly = Math.round(toNum(m[1]) / 12);
    else {
      m = b.match(/charges?(?:\s*de\s*copropri[ée]t[ée]|\s*courantes|\s*mensuelles)?\s*[:\-–]?\s*(?:de\s*)?(\d[\d\s  ]*(?:[.,]\d+)?)\s*(?:€|euros?)\s*(?:\/|par)?\s*(mois|an|ann[ée]e)?/i);
      if (m) {
        const v = toNum(m[1]);
        const annual = (m[2] && /an/i.test(m[2])) || (!m[2] && v > 450);
        if (v > 0 && v < 20000) r.chargesMonthly = Math.round(annual ? v / 12 : v);
      }
    }
    m = b.match(/(\d{1,4})\s*lots/i);
    if (m) r.lots = +m[1];

    // Taxe foncière
    m = b.match(/taxe fonci[èe]re[^\d\n]{0,40}(\d[\d\s  ]*)\s*(?:€|euros?)/i);
    if (m) { const v = toNum(m[1]); if (v > 50 && v < 10000) r.taxeFonciere = v; }

    // Étage / ascenseur
    if (/rez[\s-]de[\s-]chauss[ée]e|\brdc\b/i.test(all)) r.floor = 0;
    m = all.match(/(\d{1,2})\s*(?:er|e|è|ème|eme|ieme|ième)\s*(?:et dernier\s*)?[ée]tage/i) || all.match(/[ée]tage\s*[:\-–]?\s*(\d{1,2})\b/i);
    if (m) r.floor = +m[1];
    if (/sans ascenseur|pas d.ascenseur|ascenseur\s*:\s*non/i.test(all)) r.elevator = false;
    else if (/ascenseur/i.test(all)) r.elevator = true;

    // Année de construction
    m = all.match(/(?:construit|construction|b[âa]ti|immeuble|r[ée]sidence)\D{0,25}((?:18|19|20)\d{2})\b/i);
    if (m) r.yearBuilt = +m[1];

    // Code postal / ville
    m = all.match(/\((\d{5})\)/) || all.match(/\b(\d{5})\b(?=[\s,)]*[A-Za-zÀ-ÿ-]{3,})/);
    if (m) r.postalCode = m[1];

    return r;
  }

  // ───────────────────────── Extraction depuis JSON-LD (schema.org)
  function extractFromJsonLd(objs) {
    const r = {};
    const visit = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(visit);
      if (o['@graph']) visit(o['@graph']);
      const offers = o.offers || (o['@type'] === 'Offer' ? o : null);
      const off = Array.isArray(offers) ? offers[0] : offers;
      if (off && off.price != null && !r.price) { const p = toNum(off.price); if (p > 15000) r.price = p; }
      if (o.floorSize && !r.surface) r.surface = toNum(o.floorSize.value != null ? o.floorSize.value : o.floorSize);
      if (o.numberOfRooms && !r.rooms) r.rooms = toNum(o.numberOfRooms.value != null ? o.numberOfRooms.value : o.numberOfRooms);
      if (o.numberOfBedrooms && !r.bedrooms) r.bedrooms = toNum(o.numberOfBedrooms);
      const addr = o.address || (o.itemOffered && o.itemOffered.address) || (o.geo && null);
      if (addr && typeof addr === 'object' && !r.address) {
        r.address = [addr.streetAddress, addr.postalCode, addr.addressLocality].filter(Boolean).join(' ');
        if (addr.postalCode) r.postalCode = String(addr.postalCode);
        if (addr.addressLocality) r.city = addr.addressLocality;
      }
      if (o.geo && o.geo.latitude && !r.lat) { r.lat = toNum(o.geo.latitude); r.lng = toNum(o.geo.longitude); }
      if (o.image && !r.image) r.image = Array.isArray(o.image) ? (o.image[0].url || o.image[0]) : (o.image.url || o.image);
      if ((o.name || o.headline) && !r.title && /appartement|maison|studio|pi[eè]ce|vente|t\d/i.test(o.name || o.headline)) r.title = o.name || o.headline;
      ['itemOffered', 'mainEntity', 'about'].forEach((k) => o[k] && visit(o[k]));
    };
    visit(objs);
    return r;
  }

  // ───────────────────────── Adaptateur Leboncoin (__NEXT_DATA__)
  function extractFromLeboncoin(nextData) {
    const ad = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.ad;
    if (!ad) return {};
    const r = { title: ad.subject };
    if (ad.price && ad.price.length) r.price = ad.price[0];
    if (ad.body) r.description = ad.body;
    if (ad.location) {
      r.city = ad.location.city; r.postalCode = ad.location.zipcode;
      r.lat = ad.location.lat; r.lng = ad.location.lng;
      r.locationText = [ad.location.city_label, ad.location.district, ad.location.address].filter(Boolean).join(' ');
    }
    if (ad.images && ad.images.urls && ad.images.urls.length) r.image = ad.images.urls[0];
    (ad.attributes || []).forEach((a) => {
      const k = a.key, v = a.value, lbl = a.value_label;
      if (k === 'square') r.surface = toNum(v);
      else if (k === 'rooms') r.rooms = toNum(v);
      else if (k === 'bedrooms') r.bedrooms = toNum(v);
      else if (k === 'energy_rate' && /^[a-g]$/i.test(v)) r.dpe = v.toUpperCase();
      else if (k === 'ges' && /^[a-g]$/i.test(v)) r.ges = v.toUpperCase();
      else if (k === 'real_estate_type') r.propertyType = v === '2' ? 'appartement' : v === '1' ? 'maison' : undefined;
      else if (k === 'floor_number') r.floor = toNum(v);
      else if (k === 'elevator') r.elevator = v === '1';
      else if (/charges/.test(k) && toNum(v)) { const n = toNum(v); r.chargesMonthly = Math.round(/annual|year/.test(k) || n > 450 ? n / 12 : n); }
      else if (/nb_lots|lots/.test(k)) r.lots = toNum(v);
      else if (k === 'building_year') r.yearBuilt = toNum(v);
      void lbl;
    });
    return r;
  }

  // Fusion : les sources structurées gagnent, le texte complète
  function merge(...parts) {
    const out = {};
    parts.forEach((p) => Object.keys(p || {}).forEach((k) => {
      if (p[k] != null && p[k] !== '' && !(typeof p[k] === 'number' && !isFinite(p[k])) && out[k] == null) out[k] = p[k];
    }));
    return out;
  }

  // ───────────────────────── Zones & mots-clés
  function detectZones(settings, strongText, weakText) {
    const s = norm(strongText), w = norm(weakText);
    const strong = [], weak = [];
    (settings.zones || []).forEach((z) => {
      if (z.status === 'neutral' && !z.always) { /* on détecte quand même pour info */ }
      const hit = (txt) => (z.keywords && z.keywords.length ? z.keywords : [z.name]).some((k) => k && wordRe(k).test(txt));
      if (hit(s)) strong.push(z); else if (hit(w)) weak.push(z);
    });
    return { strong, weak };
  }
  function detectKeywords(settings, text) {
    const t = norm(text);
    const good = (settings.keywordsGood || []).filter((k) => k && wordRe(k).test(t));
    let bad = (settings.keywordsBad || []).filter((k) => k && wordRe(k).test(t));
    // « sans ascenseur » ne doit pas faire compter « ascenseur » en positif
    if (bad.some((k) => /ascenseur/.test(norm(k)))) { const i = good.findIndex((k) => norm(k) === 'ascenseur'); if (i >= 0) good.splice(i, 1); }
    return { good, bad };
  }

  // ───────────────────────── Finance
  function monthlyPayment(principal, ratePct, years, insurancePct) {
    if (!(principal > 0)) return 0;
    const n = years * 12, r = ratePct / 100 / 12;
    const base = r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n));
    return base + (principal * (insurancePct || 0) / 100) / 12;
  }
  function maxPriceForMonthly(settings) {
    const L = settings.loan, n = L.years * 12, r = L.ratePct / 100 / 12;
    const perEuro = (r === 0 ? 1 / n : r / (1 - Math.pow(1 + r, -n))) + (L.insurancePct / 100) / 12;
    const principal = L.maxMonthly / perEuro;
    return (principal + (L.apport || 0)) / (1 + L.notaryPct / 100);
  }
  function financing(price, settings, extra = {}) {
    const L = settings.loan;
    const notary = price * (L.notaryPct / 100);
    const works = extra.works || 0;
    const total = price + notary + works;
    const principal = Math.max(0, total - (L.apport || 0));
    const monthly = monthlyPayment(principal, L.ratePct, L.years, L.insurancePct);
    const totalCost = monthly * L.years * 12 - principal;
    return { notary, works, total, principal, monthly, totalInterest: totalCost };
  }

  // ───────────────────────── Scoring
  function score(listing, settings) {
    const S = settings;
    const checks = []; // {level: ok|warn|bad|info, label, detail, pts, max}
    let pts = 0, max = 0, eliminated = false;
    const add = (level, label, detail, p, m, elim) => {
      checks.push({ level, label, detail, pts: p, max: m });
      pts += p; max += m;
      if (elim) eliminated = true;
    };

    // Prix
    const price = listing.price;
    const hardMax = S.priceMax * (1 + (S.priceTolerancePct || 0) / 100);
    if (price == null) add('warn', 'Prix', 'non détecté — corrige-le dans le panneau', 0, 25);
    else if (price > hardMax) add('bad', 'Prix', `${fmtEur(price)} > ${fmtEur(S.priceMax)} (+${S.priceTolerancePct}% max)`, 0, 25, true);
    else if (price > S.priceMax) add('warn', 'Prix', `${fmtEur(price)} : au-dessus du budget, négociable ?`, 12, 25);
    else if (price < S.priceMin) add('ok', 'Prix', `${fmtEur(price)} : sous le budget`, 23, 25);
    else add('ok', 'Prix', `${fmtEur(price)} : dans la fourchette`, 25, 25);

    // Type
    if (S.propertyType && listing.propertyType && listing.propertyType !== S.propertyType)
      add('bad', 'Type', `${listing.propertyType} (recherché : ${S.propertyType})`, 0, 0, true);

    // DPE
    const d = dpeRank(listing.dpe), dMin = dpeRank(S.dpeMin), dPref = dpeRank(S.dpePref);
    if (d < 0) add('warn', 'DPE', listing.dpeNote || 'non détecté', 6, 20);
    else if (d > dMin) add('bad', 'DPE', `${listing.dpe} : pire que ${S.dpeMin}`, 0, 20, true);
    else if (d <= dPref) add('ok', 'DPE', `${listing.dpe} : objectif ${S.dpePref} atteint`, 20, 20);
    else add('warn', 'DPE', `${listing.dpe} : acceptable (objectif ${S.dpePref})`, 11, 20);
    if (listing.dpe && RENT_BAN[listing.dpe])
      checks.push({ level: 'info', label: 'Loi Climat', detail: `DPE ${listing.dpe} interdit à la location dès ${RENT_BAN[listing.dpe]} (impacte la revente / mise en location)` });

    // Pièces
    if (listing.rooms == null) add('warn', 'Pièces', 'non détecté', 5, 10);
    else if ((S.rooms || []).includes(listing.rooms)) add('ok', 'Pièces', `T${listing.rooms}`, 10, 10);
    else add('warn', 'Pièces', `T${listing.rooms} (recherché : ${(S.rooms || []).map((r) => 'T' + r).join(', ')})`, 0, 10);

    // Surface
    if (listing.surface == null) add('warn', 'Surface', 'non détectée', 4, 10);
    else if (listing.surface >= S.surfaceMin) add('ok', 'Surface', `${listing.surface} m²`, 10, 10);
    else add('warn', 'Surface', `${listing.surface} m² < ${S.surfaceMin} m²`, Math.max(0, Math.round(10 * listing.surface / S.surfaceMin) - 3), 10);

    // Prix au m²
    if (price && listing.surface) {
      const pm2 = price / listing.surface;
      const ratio = pm2 / S.refPriceM2;
      const pct = Math.round((ratio - 1) * 100);
      const txt = `${fmtEur(Math.round(pm2))}/m² (${pct > 0 ? '+' : ''}${pct}% vs réf. ${fmtEur(S.refPriceM2)})`;
      if (ratio <= 0.85) add('ok', 'Prix/m²', txt + ' — bonne affaire ou bien à rénover', 15, 15);
      else if (ratio <= 1) add('ok', 'Prix/m²', txt, 11, 15);
      else if (ratio <= 1.15) add('warn', 'Prix/m²', txt, 5, 15);
      else add('warn', 'Prix/m²', txt + ' — cher pour le secteur', 0, 15);
    } else add('warn', 'Prix/m²', 'incalculable', 5, 15);

    // Mensualité
    if (price) {
      const f = financing(price, S);
      const mx = S.loan.maxMonthly;
      if (!mx) add('info', 'Mensualité', fmtEur(Math.round(f.monthly)) + '/mois', 5, 10);
      else if (f.monthly <= mx) add('ok', 'Mensualité', `${fmtEur(Math.round(f.monthly))}/mois ≤ ${fmtEur(mx)}`, 10, 10);
      else if (f.monthly <= mx * 1.1) add('warn', 'Mensualité', `${fmtEur(Math.round(f.monthly))}/mois > ${fmtEur(mx)}`, 4, 10);
      else add('warn', 'Mensualité', `${fmtEur(Math.round(f.monthly))}/mois ≫ ${fmtEur(mx)}`, 0, 10);
    }

    // Charges
    if (listing.chargesMonthly == null) add('warn', 'Charges', 'non détectées — à demander', 3, 5);
    else if (listing.chargesMonthly <= S.chargesMaxMonthly) add('ok', 'Charges', `${fmtEur(listing.chargesMonthly)}/mois`, 5, 5);
    else add('warn', 'Charges', `${fmtEur(listing.chargesMonthly)}/mois > ${fmtEur(S.chargesMaxMonthly)}`, 0, 5);

    // Zone
    const strongZones = listing.zonesStrong || [], weakZones = listing.zonesWeak || [];
    const zoneOverride = listing.zoneOverride && (S.zones || []).find((z) => z.name === listing.zoneOverride);
    const zs = zoneOverride ? [zoneOverride] : strongZones;
    const bannedStrong = zs.filter((z) => z.status === 'banned');
    const preferred = zs.filter((z) => z.status === 'preferred');
    const bannedWeak = zoneOverride ? [] : weakZones.filter((z) => z.status === 'banned');
    if (bannedStrong.length) add('bad', 'Quartier', `Zone bannie : ${bannedStrong.map((z) => z.name).join(', ')}`, 0, 5, true);
    else if (preferred.length) add('ok', 'Quartier', `Zone préférée : ${preferred.map((z) => z.name).join(', ')}`, 5, 5);
    else if (bannedWeak.length) add('warn', 'Quartier', `L'annonce mentionne ${bannedWeak.map((z) => z.name).join(', ')} (zone bannie) — vérifie l'adresse`, 1, 5);
    else if (zs.length) add('info', 'Quartier', zs.map((z) => z.name).join(', '), 3, 5);
    else add('warn', 'Quartier', 'non identifié — précise-le dans le panneau', 2, 5);

    let total = max ? Math.round((pts / max) * 100) : 0;
    const kw = listing.keywords || { good: [], bad: [] };
    const bonus = Math.min(6, kw.good.length * 2) - Math.min(15, kw.bad.length * 5);
    if (kw.good.length) checks.push({ level: 'ok', label: 'Atouts', detail: kw.good.join(', ') });
    if (kw.bad.length) checks.push({ level: 'warn', label: 'Points de vigilance', detail: kw.bad.join(', ') });
    total = Math.max(0, Math.min(100, total + bonus));

    let verdict, tone;
    if (eliminated) { verdict = 'Éliminé'; tone = 'bad'; }
    else if (total >= 80) { verdict = 'Coup de cœur'; tone = 'great'; }
    else if (total >= 62) { verdict = 'Intéressant'; tone = 'good'; }
    else if (total >= 45) { verdict = 'Mitigé'; tone = 'meh'; }
    else { verdict = 'Peu adapté'; tone = 'bad'; }
    return { score: total, verdict, tone, eliminated, checks };
  }

  // Analyse complète d'un objet « listing » brut
  function analyze(raw, settings) {
    const l = Object.assign({}, raw);
    const strongText = [l.locationText, l.address, l.city, l.title].filter(Boolean).join(' ');
    const weakText = l.description || '';
    const z = detectZones(settings, strongText, weakText);
    l.zonesStrong = z.strong; l.zonesWeak = z.weak;
    l.keywords = detectKeywords(settings, [l.title, l.description].join(' '));
    if (l.price && l.surface) l.priceM2 = Math.round(l.price / l.surface);
    l.analysis = score(l, settings);
    return l;
  }

  // ───────────────────────── Doublons inter-sites
  function sameProperty(a, b) {
    if (!a || !b || a.id === b.id) return false;
    if (!a.surface || !b.surface || !a.price || !b.price) return false;
    if (Math.abs(a.surface - b.surface) > 1.5) return false;
    if (a.rooms && b.rooms && a.rooms !== b.rooms) return false;
    if (a.dpe && b.dpe && a.dpe !== b.dpe) return false;
    if (a.postalCode && b.postalCode && a.postalCode !== b.postalCode) return false;
    return Math.abs(a.price - b.price) / Math.min(a.price, b.price) <= 0.08;
  }
  function findDuplicates(l, all) { return Object.values(all || {}).filter((o) => sameProperty(l, o)); }

  // ───────────────────────── Recherches pré-remplies
  function searchLinks(S) {
    const rooms = (S.rooms || []).slice().sort();
    const rMin = rooms[0] || 1, rMax = rooms[rooms.length - 1] || 5;
    const city = S.city || '', cp = (S.postalCodes || [])[0] || '';
    const dept = cp ? cp.slice(0, 2) : '';
    const dpeOk = DPE_ORDER.slice(0, dpeRank(S.dpeMin) + 1).map((x) => x.toLowerCase()).join(',');
    const slug = norm(city).replace(/\s+/g, '-');
    const lbc = new URL('https://www.leboncoin.fr/recherche');
    lbc.searchParams.set('category', '9');
    lbc.searchParams.set('locations', `${city}_${cp}`);
    lbc.searchParams.set('real_estate_type', S.propertyType === 'maison' ? '1' : '2');
    lbc.searchParams.set('price', `${S.priceMin}-${Math.round(S.priceMax * (1 + (S.priceTolerancePct || 0) / 100))}`);
    lbc.searchParams.set('rooms', `${rMin}-${rMax}`);
    if (dpeOk) lbc.searchParams.set('energy_rate', dpeOk);
    return [
      { name: 'Leboncoin (filtres pré-remplis)', url: lbc.toString(), prefilled: true },
      { name: "Bien'ici", url: `https://www.bienici.com/recherche/achat/${slug}-${cp}/${S.propertyType === 'maison' ? 'maison' : 'appartement'}?prix-max=${S.priceMax}&prix-min=${S.priceMin}` },
      { name: 'SeLoger', url: 'https://www.seloger.com/' },
      { name: 'PAP (particuliers)', url: 'https://www.pap.fr/annonce/vente-appartements' },
      { name: 'Ouest-France Immo', url: `https://www.ouestfrance-immo.com/acheter/appartement/${slug}-${dept}-${cp}/` },
      { name: 'Immobilier.notaires', url: 'https://www.immobilier.notaires.fr/fr/annonces-immobilieres-liste' },
      { name: 'Logic-Immo', url: 'https://www.logic-immo.com/' },
      { name: 'Figaro Immobilier', url: 'https://immobilier.lefigaro.fr/' }
    ];
  }
  function toolLinks(l) {
    const addr = encodeURIComponent([l.address || l.locationText || '', l.postalCode || '', l.city || ''].join(' ').trim());
    const ll = l.lat && l.lng ? `&lat=${l.lat}&lng=${l.lng}&zoom=16` : '';
    return [
      { name: 'Prix de vente réels (DVF)', url: `https://explore.data.gouv.fr/fr/immobilier?onglet=carte&filtre=tous${ll}` },
      { name: 'Risques (Géorisques)', url: 'https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi' },
      { name: 'Vérifier le DPE (ADEME)', url: 'https://observatoire-dpe-audit.ademe.fr/trouver-dpe' },
      { name: 'Registre des copropriétés', url: 'https://www.registre-coproprietes.gouv.fr/annuaire' },
      { name: 'Voir sur la carte', url: l.lat ? `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}` : `https://www.openstreetmap.org/search?query=${addr}` }
    ];
  }

  const VISIT_CHECKLIST = [
    'PV des 3 dernières AG (travaux votés, impayés, procédures)',
    'Montant du fonds de travaux (loi ALUR) et du prochain appel',
    'Charges réelles annuelles + ce qu’elles incluent (chauffage ? eau ?)',
    'Taxe foncière exacte',
    'Mode de chauffage et facture annuelle',
    'Traces d’humidité / condensation (angles, salle de bain, fenêtres)',
    'État des fenêtres (double vitrage ?) et de l’électricité (tableau)',
    'Exposition / luminosité à différentes heures',
    'Bruit (rue, voisins, bars) — revenir un soir',
    'Stationnement / cave / local vélo',
    'Distance tram / bus, commerces',
    'Pourquoi le vendeur vend ? Depuis quand en vente ?'
  ];
  const STATUSES = [
    { id: 'new', label: 'À étudier' }, { id: 'contact', label: 'Contacté' }, { id: 'visit', label: 'Visite prévue' },
    { id: 'visited', label: 'Visité' }, { id: 'offer', label: 'Offre faite' }, { id: 'rejected', label: 'Écarté' }
  ];

  // ───────────────────────── Stockage (ext.storage.local)
  const ext = (typeof globalThis.browser !== 'undefined' && globalThis.browser.storage) ? globalThis.browser : (typeof globalThis.chrome !== 'undefined' ? globalThis.chrome : null);
  const hasChrome = !!(ext && ext.storage && ext.storage.local);
  function deepMerge(base, over) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
    const out = Object.assign({}, base);
    Object.keys(over || {}).forEach((k) => { out[k] = (k in base) ? deepMerge(base[k], over[k]) : over[k]; });
    return out;
  }
  async function getSettings() {
    if (!hasChrome) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const { settings } = await ext.storage.local.get('settings');
    return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), settings || {});
  }
  async function saveSettings(s) { if (hasChrome) await ext.storage.local.set({ settings: s }); }
  async function getListings() {
    if (!hasChrome) return {};
    const { listings } = await ext.storage.local.get('listings');
    return listings || {};
  }
  async function saveListings(all) { if (hasChrome) await ext.storage.local.set({ listings: all }); }

  // Enregistre / met à jour une annonce vue (historique de prix inclus)
  async function upsertListing(l, { save } = {}) {
    const all = await getListings();
    const now = Date.now();
    const prev = all[l.id];
    const keep = ['price', 'surface', 'rooms', 'bedrooms', 'dpe', 'ges', 'chargesMonthly', 'taxeFonciere', 'floor', 'elevator',
      'lots', 'yearBuilt', 'postalCode', 'city', 'address', 'locationText', 'lat', 'lng', 'title', 'image', 'propertyType',
      'energyCost', 'dpeNote', 'priceM2'];
    const data = {}; keep.forEach((k) => { if (l[k] != null) data[k] = l[k]; });
    const rec = Object.assign({
      id: l.id, url: l.url, site: l.site, siteName: l.siteName, firstSeen: now, status: 'new', notes: '', saved: false,
      priceHistory: [], checklist: {}, overrides: {}
    }, prev || {}, data, { lastSeen: now, description: (l.description || '').slice(0, 4000) });
    if (prev && prev.overrides) Object.assign(rec, prev.overrides);
    if (l.price && (!rec.priceHistory.length || rec.priceHistory[rec.priceHistory.length - 1].price !== l.price) && !(prev && prev.overrides && prev.overrides.price))
      rec.priceHistory.push({ price: l.price, date: now });
    if (save) rec.saved = true;
    rec.score = l.analysis ? l.analysis.score : rec.score;
    rec.verdict = l.analysis ? l.analysis.verdict : rec.verdict;
    rec.eliminated = l.analysis ? l.analysis.eliminated : rec.eliminated;
    rec.zones = (l.zonesStrong || []).map((z) => z.name);
    all[l.id] = rec;
    await saveListings(all);
    return { rec, all, isNew: !prev };
  }

  const api = {
    DPE_ORDER, RENT_BAN, DEFAULT_SETTINGS, SITES, STATUSES, VISIT_CHECKLIST,
    norm, toNum, fmtEur, dpeRank, dpeFromKwh, siteFor, isListingUrl, listingId, cleanUrl,
    pricesIn, extractFromText, extractFromJsonLd, extractFromLeboncoin, merge,
    detectZones, detectKeywords, monthlyPayment, maxPriceForMonthly, financing, score, analyze,
    sameProperty, findDuplicates, searchLinks, toolLinks, deepMerge,
    getSettings, saveSettings, getListings, saveListings, upsertListing
  };
  root.RadarImmo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
