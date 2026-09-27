/* Radar Immo — script injecté dans les sites d'annonces.
 * - Page d'annonce : panneau flottant (score, critères, financement, doublons, historique de prix, notes).
 * - Page de résultats : pastille de score sur chaque annonce, annonces éliminées estompées. */
(() => {
  if (window.__radarImmoLoaded) { if (window.__radarImmoForce && window.__radarImmoRoute) window.__radarImmoRoute(true); return; }
  window.__radarImmoLoaded = true;
  const R = globalThis.RadarImmo;
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  if (!R) return;

  let settings = null;
  let current = null;       // annonce analysée sur la page courante
  let lastUrl = location.href;
  let host = null, shadow = null;
  const isMobile = () => window.matchMedia('(max-width: 640px)').matches || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900);
  let collapsed = isMobile(); // sur téléphone, on commence réduit pour ne pas masquer l'annonce
  let resultsStats = { total: 0, eliminated: 0 };
  let hideEliminated = false;

  const PREFIX = 'radar-immo';

  const safeSend = (msg) => { try { ext.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* extension rechargée */ } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const firstText = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.trim().length > 2) return el; } return null; };

  // ─────────────────────────────── Collecte des données de la page
  function collect() {
    const url = R.cleanUrl(location.href);
    const site = R.siteFor(url);
    const parts = [];

    // Leboncoin : __NEXT_DATA__ (seulement s'il correspond à l'annonce affichée — navigation SPA)
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd && site && site.id === 'leboncoin') {
      try {
        const data = JSON.parse(nd.textContent);
        const ad = data && data.props && data.props.pageProps && data.props.pageProps.ad;
        if (ad && url.includes(String(ad.list_id))) parts.push(R.extractFromLeboncoin(data));
      } catch (e) { /* ignore */ }
    }
    // JSON-LD
    const ld = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { ld.push(JSON.parse(s.textContent)); } catch (e) { /* ignore */ } });
    if (ld.length) parts.push(R.extractFromJsonLd(ld));

    // Texte
    const h1 = document.querySelector('h1');
    const title = [(h1 && h1.innerText) || '', document.title].join(' — ');
    const descEl = firstText(['[data-qa-id="adview_description_container"]', '[data-testid*="description" i]', '[class*="Description" i]',
      '[id*="description" i]', '[class*="description" i]', 'article']);
    const locEl = firstText(['[data-qa-id="adview_location_informations"]', '[data-testid*="location" i]', '[data-testid*="address" i]',
      '[class*="Localisation" i]', '[class*="location" i]', '[class*="address" i]', '[class*="adresse" i]', '[itemprop="address"]']);
    const main = document.querySelector('main') || document.body;
    const bodyText = (main.innerText || '').slice(0, 60000);
    const description = descEl ? descEl.innerText.slice(0, 6000) : '';
    parts.push({ description, locationText: locEl ? locEl.innerText.slice(0, 300) : '' });
    parts.push(R.extractFromText(title, bodyText));
    const img = document.querySelector('meta[property="og:image"]');
    parts.push({ title: (h1 && h1.innerText.trim()) || document.title, image: img && img.content, description: description || bodyText.slice(0, 3000) });

    const raw = R.merge(...parts);
    raw.id = R.listingId(url);
    raw.url = url;
    raw.site = site ? site.id : location.hostname;
    raw.siteName = site ? site.name : location.hostname.replace(/^www\./, '');
    raw._descEl = descEl;
    return raw;
  }

  async function analyzePage() {
    settings = await R.getSettings();
    const raw = collect();
    const all = await R.getListings();
    const prev = all[raw.id];
    if (prev && prev.overrides) Object.assign(raw, prev.overrides);
    let l = R.analyze(raw, settings);
    const { rec, all: all2 } = await R.upsertListing(l);
    current = Object.assign(l, { rec, dups: R.findDuplicates(rec, all2) });
    safeSend({ type: 'badge', score: l.analysis.score, tone: l.analysis.tone, eliminated: l.analysis.eliminated });
    renderPanel();
    highlightKeywords(raw._descEl);
  }

  // ─────────────────────────────── Surlignage des mots-clés dans la description
  function highlightKeywords(el) {
    if (!el || el.dataset.radarMarked || !settings) return;
    const kws = [...(settings.keywordsGood || []).map((k) => [k, 'good']), ...(settings.keywordsBad || []).map((k) => [k, 'bad'])]
      .concat((settings.zones || []).filter((z) => z.status !== 'neutral').flatMap((z) => (z.keywords || [z.name]).map((k) => [k, z.status === 'banned' ? 'bad' : 'good'])))
      .filter(([k]) => k && k.length > 2).sort((a, b) => b[0].length - a[0].length);
    if (!kws.length) return;
    const map = new Map(kws.map(([k, t]) => [R.norm(k), t]));
    // Recherche insensible aux accents : on travaille sur le texte normalisé caractère par caractère (même longueur)
    const flat = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + kws.map(([k]) => flat(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s']+/g, '[-\\s\']+')).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      const text = n.nodeValue; const f = flat(text);
      if (f.length !== text.length) return; // sécurité : caractères composés
      let m, last = 0, frag = null; re.lastIndex = 0;
      while ((m = re.exec(f))) {
        const start = m.index + m[1].length, end = start + m[2].length;
        frag = frag || document.createDocumentFragment();
        frag.appendChild(document.createTextNode(text.slice(last, start)));
        const mark = document.createElement('mark');
        const tone = map.get(R.norm(m[2])) || 'bad';
        mark.className = `${PREFIX}-mark ${PREFIX}-mark-${tone}`;
        mark.textContent = text.slice(start, end);
        frag.appendChild(mark); last = end;
      }
      if (frag) { frag.appendChild(document.createTextNode(text.slice(last))); n.parentNode.replaceChild(frag, n); }
    });
    el.dataset.radarMarked = '1';
  }

  // ─────────────────────────────── Panneau flottant (Shadow DOM)
  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = `${PREFIX}-host`;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:16px;bottom:16px;';
    shadow = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);
  }
  // Position du panneau : carte en bas à droite (ordinateur), feuille en bas d'écran (téléphone)
  function placeHost(mode) {
    if (!host) return;
    const base = 'all:initial;position:fixed;z-index:2147483646;';
    const sab = 'env(safe-area-inset-bottom, 0px)';
    if (!isMobile()) { host.style.cssText = base + 'right:16px;bottom:16px;'; return; }
    if (mode === 'panel') host.style.cssText = base + 'left:0;right:0;bottom:0;';
    else if (mode === 'bar') host.style.cssText = base + `left:8px;right:8px;bottom:calc(8px + ${sab});`;
    else host.style.cssText = base + `right:12px;bottom:calc(12px + ${sab});`;
  }
  function removePanel() { if (host) { host.remove(); host = null; shadow = null; } }

  const PANEL_CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .panel,.pill{--bg:#ffffff;--subtle:#f4f4f6;--hover:#ececef;--text:#18181b;--muted:#71717a;--faint:#a1a1aa;--border:#e6e6ea;
    --accent:#c8607f;--accent-hover:#b5536f;--accent-soft:#fbeaf0;--accent-text:#a83355;
    --ok:#1f7a45;--ok-soft:#e8f5ed;--warn:#8f5f00;--warn-soft:#fdf3da;--bad:#b42318;--bad-soft:#fdecea;
    --font:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
    font:13.5px/1.5 var(--font);color:var(--text);-webkit-font-smoothing:antialiased}
  @media (prefers-color-scheme:dark){.panel,.pill{--bg:#1a1a1d;--subtle:#232327;--hover:#2b2b30;--text:#ededef;--muted:#a1a1aa;--faint:#71717a;--border:#2e2e33;
    --accent:#e0819d;--accent-hover:#ea93ad;--accent-soft:rgba(224,129,157,.15);--accent-text:#f0a3ba;
    --ok:#5fcf8f;--ok-soft:rgba(95,207,143,.13);--warn:#e7b54a;--warn-soft:rgba(231,181,74,.13);--bad:#f47a6e;--bad-soft:rgba(244,122,110,.13)}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
  .panel{width:368px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:16px;
    box-shadow:0 2px 6px rgba(16,16,24,.06),0 18px 48px rgba(16,16,24,.16);overflow:hidden}
  .head{display:flex;align-items:center;gap:12px;padding:14px 12px 14px 16px;cursor:pointer;user-select:none}
  .brand{font-size:11.5px;font-weight:600;color:var(--muted);letter-spacing:.01em}
  .brand span{color:var(--accent)}
  .ht{flex:1;min-width:0}
  .sub{color:var(--faint);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .score{flex:none;display:grid;place-items:center;min-width:44px;height:44px;padding:0 6px;border-radius:12px;font:650 17px/1 var(--font);font-variant-numeric:tabular-nums;background:var(--subtle);color:var(--text)}
  .score.great{background:var(--accent-soft);color:var(--accent-text)}
  .score.good{background:var(--ok-soft);color:var(--ok)}
  .score.meh{background:var(--warn-soft);color:var(--warn)}
  .score.bad{color:var(--faint);text-decoration:line-through}
  .verdict{display:flex;align-items:center;gap:6px;font-size:14.5px;font-weight:600;margin:1px 0}
  .verdict::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}
  .verdict.great{color:var(--accent-text)}.verdict.great::before{background:var(--accent)}
  .verdict.good{color:var(--ok)}.verdict.good::before{background:var(--ok)}
  .verdict.meh{color:var(--warn)}.verdict.meh::before{background:var(--warn)}
  .verdict.bad{color:var(--bad)}.verdict.bad::before{background:var(--bad)}
  .icon{border:0;background:transparent;color:var(--muted);font:500 12.5px/1 var(--font);cursor:pointer;height:28px;min-width:28px;padding:0 8px;border-radius:8px;transition:background .15s,color .15s}
  .icon:hover{background:var(--subtle);color:var(--text)}
  .body{overflow:auto;padding:0 16px 16px;border-top:1px solid var(--border)}
  h4{margin:18px 0 8px;font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);display:flex;align-items:baseline;gap:6px}
  h4 small{font-size:11.5px;font-weight:400;letter-spacing:0;text-transform:none}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  .f{background:var(--subtle);border:1px solid transparent;border-radius:10px;padding:6px 9px;min-width:0;transition:border-color .15s,background .15s}
  .f:hover{background:var(--hover)}
  .f:focus-within{background:var(--bg);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .f label{display:block;font-size:11px;color:var(--muted)}
  .f input,.f select{width:100%;border:0;background:transparent;color:var(--text);font:500 13.5px var(--font);padding:0;outline:none}
  .f.ov{border-color:var(--accent-soft)}
  .f.ov label::after{content:" · corrigé";color:var(--accent-text)}
  .meta{font-size:12px;color:var(--muted);margin-top:8px}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;gap:10px;padding:4px 0;align-items:flex-start;font-size:13px;line-height:1.45}
  li b{font-weight:600}
  .ck{flex:none;display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;font:700 10px/1 var(--font);margin-top:1px}
  .ck.ok{background:var(--ok-soft);color:var(--ok)}
  .ck.warn{background:var(--warn-soft);color:var(--warn)}
  .ck.bad{background:var(--bad-soft);color:var(--bad)}
  .ck.info{background:var(--subtle);color:var(--muted)}
  .fin{display:grid;grid-template-columns:1fr auto;gap:3px 12px;background:var(--subtle);border-radius:12px;padding:10px 12px;font-size:13px}
  .fin .v{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
  .fin .big{font-size:17px;font-weight:650}
  .fin .tot{border-top:1px solid var(--border);padding-top:6px;margin-top:3px}
  .note{font-size:11.5px;color:var(--muted);margin-top:6px}
  .alert{background:var(--subtle);padding:8px 11px;margin-top:12px;font-size:12.5px;border-radius:10px;color:var(--muted)}
  .alert b{color:var(--text)}
  .alert.drop{background:var(--ok-soft);color:var(--ok)}.alert.drop b{color:inherit}
  .alert.up{background:var(--bad-soft);color:var(--bad)}.alert.up b{color:inherit}
  a{color:var(--text);text-decoration:none;border-bottom:1px solid var(--border);transition:color .15s,border-color .15s}
  a:hover{color:var(--accent-text);border-color:var(--accent)}
  .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .b{display:inline-flex;align-items:center;justify-content:center;height:32px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:0 12px;
    font:500 13px/1 var(--font);cursor:pointer;box-shadow:0 1px 2px rgba(16,16,24,.04);transition:background .15s,border-color .15s}
  .b:hover{background:var(--subtle)}
  .b.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .b.primary:hover{background:var(--accent-hover)}
  .b.saved{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
  select.b{padding-right:8px}
  textarea{width:100%;min-height:58px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);padding:8px 10px;font:13px/1.45 var(--font);resize:vertical;margin-top:8px;transition:border-color .15s,box-shadow .15s}
  textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .links{display:flex;flex-wrap:wrap;gap:6px}
  .links a{border:0;background:var(--subtle);padding:4px 10px;border-radius:999px;font-size:12px}
  .links a:hover{background:var(--accent-soft)}
  .pill{display:flex;align-items:center;gap:10px;padding:6px 14px 6px 6px;border-radius:999px;background:var(--bg);border:1px solid var(--border);
    box-shadow:0 2px 6px rgba(16,16,24,.06),0 10px 30px rgba(16,16,24,.14);cursor:pointer}
  .pill .score{min-width:34px;height:34px;font-size:14px;border-radius:999px}
  .pill .verdict{font-size:13.5px;margin:0}
  .pill.bar{cursor:default;padding:6px 6px 6px 16px}
  .pill.bar .brand{font-size:13px;color:var(--text)}
  .dpe{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 4px;border-radius:5px;font:650 11.5px/1 var(--font);color:#18181b}
  .dpe-A{background:#009c6d;color:#fff}.dpe-B{background:#52b153;color:#fff}.dpe-C{background:#a5cc74}.dpe-D{background:#f4e70f}.dpe-E{background:#f0b50f}.dpe-F{background:#eb8235}.dpe-G{background:#d7221f;color:#fff}
  .grab{display:none}
  /* Téléphone : feuille qui monte du bas */
  @media (max-width:640px), (pointer:coarse) and (max-width:899px){
    .panel{width:100vw;max-height:82vh;border-radius:20px 20px 0 0;border-width:1px 0 0;box-shadow:0 -8px 40px rgba(16,16,24,.22);
      padding-bottom:env(safe-area-inset-bottom,0px);animation:up .22s ease-out}
    @keyframes up{from{transform:translateY(24px);opacity:.4}to{transform:none;opacity:1}}
    .grab{display:block;width:40px;height:4px;border-radius:4px;background:var(--border);margin:8px auto 0}
    .head{padding:10px 12px 12px 16px}
    .icon{height:36px;min-width:36px;font-size:13.5px}
    .body{padding:0 16px 20px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
    .grid{gap:8px}
    .f{padding:7px 10px}
    .f input,.f select{font-size:16px}
    li{font-size:14px}
    .b{height:40px;font-size:14px}
    textarea{font-size:16px}
    .links a{padding:7px 12px;font-size:13px}
    .pill{padding:6px 16px 6px 6px}
    .pill .score{min-width:40px;height:40px;font-size:15px}
    .pill.bar{padding:6px 6px 6px 12px;justify-content:space-between;border-radius:16px;gap:8px}
    .pill.bar .brand{display:none}
    .pill.bar .b{height:36px;font-size:13px;padding:0 10px}
  }
  `;

  function fieldHtml(key, label, value, type = 'number', opts) {
    const ov = current.rec && current.rec.overrides && current.rec.overrides[key] != null;
    if (type === 'select') {
      return `<div class="f${ov ? ' ov' : ''}"><label>${label}</label><select data-k="${key}">${opts.map((o) =>
        `<option value="${esc(o[0])}"${String(value ?? '') === String(o[0]) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>`;
    }
    return `<div class="f${ov ? ' ov' : ''}"><label>${label}</label><input data-k="${key}" type="${type}" value="${value == null ? '' : esc(value)}" placeholder="?"></div>`;
  }

  function renderPanel() {
    if (!current || !settings || settings.showPanel === false) { removePanel(); return; }
    ensureHost();
    placeHost(collapsed ? 'pill' : 'panel');
    const l = current, a = l.analysis, rec = l.rec || {};
        if (collapsed) {
      shadow.innerHTML = `<style>${PANEL_CSS}</style><div>
        <div class="pill" id="expand" role="button" tabindex="0" title="Ouvrir Radar Immo"><div class="score ${a.tone}">${a.score}</div><span class="verdict ${a.tone}"><span class="v">${esc(a.verdict)}</span></span></div></div>`;
      const ex = shadow.getElementById('expand');
      ex.onclick = () => { collapsed = false; renderPanel(); };
      ex.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); collapsed = false; renderPanel(); } };
      return;
    }
    const f = l.price ? R.financing(l.price, settings) : null;
    const hist = rec.priceHistory || [];
    let priceAlert = '';
    if (hist.length > 1) {
      const first = hist[0].price, lastP = hist[hist.length - 1].price, diff = lastP - first;
      if (diff) priceAlert = `<div class="alert ${diff < 0 ? 'drop' : 'up'}">${diff < 0 ? '↘ Baisse' : '↗ Hausse'} de <b>${R.fmtEur(Math.abs(diff))}</b> depuis le ${new Date(hist[0].date).toLocaleDateString('fr-FR')} (${R.fmtEur(first)} → ${R.fmtEur(lastP)})</div>`;
    }
    const seen = rec.firstSeen && Date.now() - rec.firstSeen > 3600e3 ? `Vue pour la 1re fois le ${new Date(rec.firstSeen).toLocaleDateString('fr-FR')}` : 'Nouvelle annonce pour toi';
    const dups = (l.dups || []).map((d) => {
      const delta = d.price - l.price;
      return `<div class="alert dup">Probablement le même bien sur <a href="${esc(d.url)}" target="_blank">${esc(d.siteName || d.site)}</a> à <b>${R.fmtEur(d.price)}</b>${delta ? ` (${delta > 0 ? '+' : '−'}${R.fmtEur(Math.abs(delta))})` : ''}</div>`;
    }).join('');
    const zoneOpts = [['', '(auto) ' + ((l.zonesStrong || []).map((z) => z.name).join(', ') || '—')]].concat((settings.zones || []).map((z) =>
      [z.name, z.name + (z.status === 'banned' ? ' ⛔' : z.status === 'preferred' ? ' ★' : '')]));
    const dpeOpts = [['', '?']].concat(R.DPE_ORDER.map((d) => [d, d]));

    shadow.innerHTML = `<style>${PANEL_CSS}</style>
    <div class="panel">
      <div class="grab" aria-hidden="true"></div>
      <div class="head" id="toggle" title="Réduire">
        <div class="score ${a.tone}" title="Score sur 100">${a.score}</div>
        <div class="ht"><div class="brand">Radar <span>Immo</span></div>
          <div class="verdict ${a.tone}"><span class="v">${esc(a.verdict)}</span></div>
          <div class="sub">${esc(l.siteName)} · ${esc(seen)}</div></div>
        <button class="icon" id="dash" title="Ouvrir le tableau de bord">Suivi</button>
        <button class="icon" id="min" title="Réduire" aria-label="Réduire">–</button>
      </div>
      <div class="body">
        ${priceAlert}${dups}
        <h4>Le bien <small>corrige si besoin</small></h4>
        <div class="grid">
          ${fieldHtml('price', 'Prix (€)', l.price)}
          ${fieldHtml('surface', 'Surface (m²)', l.surface)}
          ${fieldHtml('rooms', 'Pièces', l.rooms)}
          ${fieldHtml('dpe', 'DPE', l.dpe, 'select', dpeOpts)}
          ${fieldHtml('chargesMonthly', 'Charges/mois', l.chargesMonthly)}
          ${fieldHtml('taxeFonciere', 'Taxe fonc./an', l.taxeFonciere)}
        </div>
        <div class="grid" style="grid-template-columns:1fr;margin-top:6px">${fieldHtml('zoneOverride', 'Quartier', l.zoneOverride || '', 'select', zoneOpts)}</div>
        <div class="meta">${[l.priceM2 ? R.fmtEur(l.priceM2) + '/m²' : '', l.floor != null ? (l.floor === 0 ? 'RDC' : l.floor + 'e étage') : '', l.elevator === true ? 'ascenseur' : l.elevator === false ? 'sans ascenseur' : '',
          l.lots ? l.lots + ' lots' : '', l.yearBuilt ? 'construit ' + l.yearBuilt : '', l.ges ? 'GES ' + l.ges : '',
          l.energyCost ? `énergie ${R.fmtEur(l.energyCost[0])}–${R.fmtEur(l.energyCost[1])}/an` : ''].filter(Boolean).join(' · ')}</div>

        <h4>Critères</h4>
        <ul>${a.checks.map((c) => `<li><span class="ck ${c.level}" aria-hidden="true">${c.level === 'ok' ? '✓' : c.level === 'bad' ? '✕' : c.level === 'warn' ? '!' : 'i'}</span><span><b>${esc(c.label)}</b> — ${esc(c.detail)}</span></li>`).join('')}</ul>

        ${f ? `<h4>Financement estimé</h4>
        <div class="fin">
          <span>Prix affiché</span><span class="v">${R.fmtEur(l.price)}</span>
          <span>Frais de notaire (~${settings.loan.notaryPct}%)</span><span class="v">${R.fmtEur(Math.round(f.notary))}</span>
          <span>Apport</span><span class="v">−${R.fmtEur(settings.loan.apport || 0)}</span>
          <span>À emprunter</span><span class="v">${R.fmtEur(Math.round(f.principal))}</span>
          <span>Mensualité · ${settings.loan.years} ans à ${settings.loan.ratePct} %</span><span class="v big">${R.fmtEur(Math.round(f.monthly))}</span>
          <span>Coût total du crédit</span><span class="v">${R.fmtEur(Math.round(f.totalInterest))}</span>
          ${l.chargesMonthly || l.taxeFonciere ? `<span class="tot">Coût logement / mois<br><small class="note">prêt + charges + taxe foncière</small></span><span class="v tot">${R.fmtEur(Math.round(f.monthly + (l.chargesMonthly || 0) + (l.taxeFonciere || 0) / 12))}</span>` : ''}
        </div>
        <div class="note">Avec ${R.fmtEur(settings.loan.maxMonthly)}/mois max, tu peux viser jusqu'à ≈ ${R.fmtEur(Math.round(R.maxPriceForMonthly(settings) / 500) * 500)}. Hypothèses modifiables dans Suivi → Critères.</div>` : ''}

        <h4>Suivi</h4>
        <div class="row">
          <button class="b ${rec.saved ? 'saved' : 'primary'}" id="save">${rec.saved ? '★ Sauvegardée' : 'Sauvegarder'}</button>
          <select class="b" id="status" aria-label="Statut">${R.STATUSES.map((s) => `<option value="${s.id}"${rec.status === s.id ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
        </div>
        <textarea id="notes" placeholder="Notes perso (contact agence, impressions de visite…)" >${esc(rec.notes || '')}</textarea>

        <h4>Vérifier</h4>
        <div class="links">${R.toolLinks(l).map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>`).join('')}</div>
      </div>
    </div>`;

    const $ = (id) => shadow.getElementById(id);
    $('toggle').onclick = (e) => { if (e.target.closest('button')) return; collapsed = true; renderPanel(); };
    $('min').onclick = () => { collapsed = true; renderPanel(); };
    $('dash').onclick = () => safeSend({ type: 'openDashboard', id: l.id });
    $('save').onclick = async () => { await patchRec({ saved: !rec.saved }); };
    $('status').onchange = async (e) => { await patchRec({ status: e.target.value, saved: true }); };
    $('notes').onchange = async (e) => { await patchRec({ notes: e.target.value, saved: true }); };
    shadow.querySelectorAll('[data-k]').forEach((inp) => {
      inp.onchange = async () => {
        const k = inp.dataset.k; let v = inp.value.trim();
        const all = await R.getListings(); const r = all[l.id]; if (!r) return;
        r.overrides = r.overrides || {};
        if (v === '') { delete r.overrides[k]; } else { r.overrides[k] = ['dpe', 'zoneOverride'].includes(k) ? v : R.toNum(v); }
        await R.saveListings(all);
        await analyzePage();
      };
    });
  }

  async function patchRec(patch) {
    const all = await R.getListings();
    const r = all[current.id]; if (!r) return;
    Object.assign(r, patch);
    await R.saveListings(all);
    current.rec = r;
    renderPanel();
  }

  // ─────────────────────────────── Pages de résultats
  const cardSig = new WeakMap();
  function findCard(a) {
    let el = a, best = null;
    for (let i = 0; i < 9 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      const txt = el.innerText || '';
      if (txt.length > 2500) break;
      const ids = new Set([...el.querySelectorAll('a[href]')].filter((x) => R.isListingUrl(x.href)).map((x) => R.listingId(x.href)));
      if (ids.size > 1) break;
      if (/€/.test(txt) && /m²|m2|pi[eè]ce/i.test(txt)) { best = el; if (el.offsetHeight > 120) break; }
    }
    return best;
  }

  async function scanResults() {
    if (!settings || settings.highlightResults === false) return;
    const all = await R.getListings();
    const seen = new Set();
    let total = 0, elim = 0;
    document.querySelectorAll('a[href]').forEach((a) => {
      if (!R.isListingUrl(a.href) || a.closest(`#${PREFIX}-host`)) return;
      const id = R.listingId(a.href);
      if (seen.has(id)) return; seen.add(id);
      const card = findCard(a); if (!card) return;
      total++;
      const text = card.innerText || '';
      const sig = text.length + '|' + id;
      if (cardSig.get(card) === sig && card.querySelector(`.${PREFIX}-badge`)) { if (card.dataset.radarElim === '1') elim++; applyHide(card); return; }
      cardSig.set(card, sig);
      const firstLines = text.split('\n').slice(0, 12).join(' ');
      const raw = Object.assign(R.extractFromText(firstLines, text), { id, url: a.href, locationText: text, description: '' });
      const stored = all[id];
      if (stored && stored.overrides) Object.assign(raw, stored.overrides);
      const l = R.analyze(raw, settings);
      decorate(card, l, stored);
      if (l.analysis.eliminated || (stored && stored.status === 'rejected')) elim++;
    });
    resultsStats = { total, eliminated: elim };
    renderResultsBar();
  }

  function applyHide(card) { card.style.display = hideEliminated && card.dataset.radarElim === '1' ? 'none' : ''; }

  function decorate(card, l, stored) {
    card.querySelectorAll(`.${PREFIX}-badge`).forEach((b) => b.remove());
    const a = l.analysis;
    const rejected = stored && stored.status === 'rejected';
    const elim = a.eliminated || rejected;
    card.dataset.radarElim = elim ? '1' : '0';
    card.classList.add(`${PREFIX}-card`);
    card.classList.toggle(`${PREFIX}-elim`, elim);
    card.dataset.radarTone = elim ? 'bad' : a.tone;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const reason = rejected ? 'Écartée par toi' : (a.checks.find((c) => c.level === 'bad') || {}).detail;
    const extras = [];
    if (stored && stored.saved) extras.push('★');
    else if (stored) extras.push('vue');
    if (stored && stored.priceHistory && stored.priceHistory.length && l.price) {
      const d = l.price - stored.priceHistory[0].price;
      if (d < 0) extras.push(`↘ ${Math.round(d / 1000)}k€`);
    }
    const b = document.createElement('div');
    b.className = `${PREFIX}-badge`;
    b.title = a.checks.map((c) => `${c.level === 'ok' ? '✓' : c.level === 'bad' ? '✕' : '•'} ${c.label} : ${c.detail}`).join('\n');
    b.innerHTML = `<span class="${PREFIX}-score">${a.score}</span><span class="${PREFIX}-txt">${elim ? esc(reason || a.verdict) : esc(a.verdict)}</span>${extras.map((x) => `<span class="${PREFIX}-x">${esc(x)}</span>`).join('')}`;
    card.appendChild(b);
    applyHide(card);
  }

  function renderResultsBar() {
    if (!resultsStats.total || !settings || settings.showPanel === false) { removePanel(); return; }
    ensureHost();
    placeHost('bar');
    shadow.innerHTML = `<style>${PANEL_CSS}</style>
      <div class="pill bar">
        <span class="brand">Radar <span>Immo</span></span>
        <span style="color:var(--muted);font-size:13px">${resultsStats.total} annonces · ${resultsStats.eliminated} hors critères</span>
        <button class="b" id="hide">${hideEliminated ? 'Tout afficher' : 'Masquer hors critères'}</button>
        <button class="icon" id="dash" title="Ouvrir le tableau de bord">Suivi</button>
      </div>`;
    shadow.getElementById('hide').onclick = () => {
      hideEliminated = !hideEliminated;
      document.querySelectorAll(`.${PREFIX}-card`).forEach(applyHide);
      renderResultsBar();
    };
    shadow.getElementById('dash').onclick = () => safeSend({ type: 'openDashboard' });
  }

  function injectPageCss() {
    if (document.getElementById(`${PREFIX}-css`)) return;
    const st = document.createElement('style');
    st.id = `${PREFIX}-css`;
    st.textContent = `
      .${PREFIX}-elim{opacity:.4!important;filter:grayscale(.8)!important;transition:opacity .15s,filter .15s}
      .${PREFIX}-elim:hover{opacity:1!important;filter:none!important}
      .${PREFIX}-badge{position:absolute;top:10px;left:10px;z-index:50;display:flex;gap:6px;align-items:center;max-width:calc(100% - 20px);
        background:#fff;color:#18181b;font:500 12px/1 'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:3px 10px 3px 3px;
        border-radius:999px;box-shadow:0 1px 2px rgba(16,16,24,.08),0 4px 14px rgba(16,16,24,.14);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        pointer-events:auto;letter-spacing:0;text-transform:none;-webkit-font-smoothing:antialiased}
      .${PREFIX}-score{display:inline-grid;place-items:center;min-width:26px;height:22px;padding:0 6px;border-radius:999px;font-weight:650;font-size:12px;
        font-variant-numeric:tabular-nums;background:#f4f4f6;color:#18181b}
      .${PREFIX}-card[data-radar-tone="great"] .${PREFIX}-score{background:#fbeaf0;color:#a83355}
      .${PREFIX}-card[data-radar-tone="good"] .${PREFIX}-score{background:#e8f5ed;color:#1f7a45}
      .${PREFIX}-card[data-radar-tone="meh"] .${PREFIX}-score{background:#fdf3da;color:#8f5f00}
      .${PREFIX}-card[data-radar-tone="bad"] .${PREFIX}-score{background:#f4f4f6;color:#a1a1aa;text-decoration:line-through}
      .${PREFIX}-card[data-radar-tone="great"] .${PREFIX}-txt{color:#a83355}
      .${PREFIX}-card[data-radar-tone="bad"] .${PREFIX}-txt{color:#b42318}
      .${PREFIX}-x{background:#f4f4f6;border-radius:999px;padding:3px 7px;color:#71717a}
      mark.${PREFIX}-mark{color:inherit;border-radius:4px;padding:0 3px;margin:0 -1px}
      mark.${PREFIX}-mark-good{background:#fbeaf0;box-shadow:inset 0 -2px 0 #efb8c9}
      mark.${PREFIX}-mark-bad{background:#fdf3da;box-shadow:inset 0 -2px 0 #efd48f}`;
    document.documentElement.appendChild(st);
  }

  // ─────────────────────────────── Routage (SPA inclus)
  const scanDebounced = debounce(scanResults, 700);
  let observer = null;
  async function route(force) {
    settings = await R.getSettings();
    injectPageCss();
    const listing = R.isListingUrl(location.href) || force || window.__radarImmoForce;
    if (listing) {
      if (observer) { observer.disconnect(); observer = null; }
      // Laisse le temps aux SPA d'afficher le contenu
      await new Promise((r) => setTimeout(r, document.readyState === 'complete' ? 400 : 1200));
      await analyzePage();
    } else if (R.siteFor(location.href)) {
      current = null;
      safeSend({ type: 'badge', clear: true });
      await scanResults();
      if (!observer) {
        observer = new MutationObserver((muts) => {
          const ours = muts.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType !== 1 || (n.className && String(n.className).includes(PREFIX)) || n.id === `${PREFIX}-host`));
          if (!ours) scanDebounced();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }
  window.__radarImmoRoute = route;

  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; removePanel(); route(); } }, 1000);
  try {
    ext.storage.onChanged.addListener((ch) => { if (ch.settings) { document.querySelectorAll(`.${PREFIX}-card`).forEach((c) => cardSig.delete(c)); route(); } });
    ext.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg.type === 'getAnalysis') { reply(current ? { listing: Object.assign({}, current, { _descEl: undefined }), results: null } : { listing: null, results: resultsStats }); }
      if (msg.type === 'reanalyze') { collapsed = false; route(true).then(() => reply({ ok: true })); return true; }
      if (msg.type === 'togglePanel') { collapsed = !collapsed; renderPanel(); reply({ ok: true }); }
      return false;
    });
  } catch (e) { /* hors extension (tests) */ }

  route();
})();
