const R = globalThis.RadarImmo;
const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
const CK = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = (hash = '') => ext.tabs.create({ url: ext.runtime.getURL('dashboard/dashboard.html') + hash });

(async () => {
  const S = await R.getSettings();
  const all = await R.getListings();
  const list = Object.values(all);
  document.getElementById('crit').textContent =
    `${S.city} · ${(S.rooms || []).map((r) => 'T' + r).join('/')} · ${Math.round(S.priceMin / 1000)}–${Math.round(S.priceMax / 1000)} k€ · DPE ${S.dpePref} visé, ${S.dpeMin} max`;
  document.getElementById('nSaved').textContent = list.filter((l) => l.saved).length;
  document.getElementById('nSeen').textContent = list.length;
  document.getElementById('nDrop').textContent = list.filter((l) => l.priceHistory && l.priceHistory.length > 1 &&
    l.priceHistory[l.priceHistory.length - 1].price < l.priceHistory[0].price).length;

  const C = globalThis.RadarCloud;
  if (C) {
    const c = await C.getState();
    const el = document.getElementById('cloud');
    el.textContent = c.token ? (c.status === 'error' ? 'Synchronisation en échec, nouvel essai bientôt' : 'Compte connecté · synchronisé')
      : c.status === 'expired' ? 'Session expirée : reconnecte-toi dans Données' : '';
    if (c.token) ext.runtime.sendMessage({ type: 'cloudSync' }).catch(() => {});
  }

  document.getElementById('dash').onclick = () => dash();
  document.getElementById('crits').onclick = () => dash('#criteres');
  document.getElementById('compare').onclick = () => dash('#comparer');
  document.getElementById('openSearches').onclick = () => {
    const urls = (S.searches && S.searches.length ? S.searches : R.searchLinks(S).filter((s) => s.prefilled)).map((s) => s.url);
    urls.forEach((u, i) => ext.tabs.create({ url: u, active: i === 0 }));
  };

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const box = document.getElementById('page');
  const showUnknown = (txt) => {
    box.innerHTML = `<div class="m" style="margin-bottom:10px">${txt}</div><button class="btn sm" id="force">Analyser cette page quand même</button>`;
    document.getElementById('force').onclick = async () => {
      const res = await ext.runtime.sendMessage({ type: 'injectAnalyze', tabId: tab.id });
      box.innerHTML = res && res.ok ? '<div class="m">Analyse lancée : regarde le panneau en bas à droite de la page.</div>'
        : '<div class="m">Impossible d\'analyser cette page (page Chrome ou site protégé).</div>';
    };
  };
  if (!tab || !/^https?:/.test(tab.url || '')) { box.innerHTML = '<div class="m">Ouvre une annonce immobilière pour voir son analyse.</div>'; return; }
  let res = null;
  try { res = await ext.tabs.sendMessage(tab.id, { type: 'getAnalysis' }); } catch (e) { res = null; }
  if (!res) return showUnknown('Ce site n\'est pas suivi automatiquement (agence locale, etc.).');
  if (res.listing) {
    const l = res.listing, a = l.analysis;
    const issues = a.checks.filter((c) => c.level !== 'ok').slice(0, 5);
    box.innerHTML = `<div class="top"><span class="score ${a.tone}">${a.score}</span>
      <div><span class="verdict ${a.tone}"><span class="v">${esc(a.verdict)}</span></span>
      <div class="facts">${esc(R.fmtEur(l.price))} · ${l.surface || '?'} m² · T${l.rooms || '?'} · <span class="dpe dpe-${l.dpe || 'x'}">${l.dpe || '?'}</span></div></div></div>
      <ul class="checks">${issues.map((c) => `<li><span class="ck ${c.level}" aria-hidden="true">${CK[c.level]}</span><span><b>${esc(c.label)}</b> — ${esc(c.detail)}</span></li>`).join('') || '<li><span class="ck ok">✓</span><span>Tous les critères sont remplis</span></li>'}</ul>
      <div class="acts"><button class="btn sm" id="re">Ré-analyser</button><button class="btn sm ghost" id="tg">Afficher / réduire le panneau</button></div>`;
    document.getElementById('re').onclick = () => ext.tabs.sendMessage(tab.id, { type: 'reanalyze' }).then(() => window.close());
    document.getElementById('tg').onclick = () => ext.tabs.sendMessage(tab.id, { type: 'togglePanel' }).then(() => window.close());
  } else if (res.results && res.results.total) {
    box.innerHTML = `<h2 style="font-size:17px">Page de résultats</h2><div class="m">${res.results.total} annonces repérées, dont ${res.results.eliminated} hors critères (grisées).</div>`;
  } else {
    showUnknown('Aucune annonce détectée sur cette page.');
  }
})();
