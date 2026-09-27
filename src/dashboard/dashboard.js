const R = globalThis.RadarImmo;
const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
const CK = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
const checksHtml = (checks) => `<ul class="checks">${checks.map((c) => `<li><span class="ck ${c.level}" aria-hidden="true">${CK[c.level]}</span><span><b>${esc(c.label)}</b> — ${esc(c.detail)}</span></li>`).join('')}</ul>`;
const verdictHtml = (a) => `<span class="verdict ${a.tone}"><span class="v">${esc(a.verdict)}</span></span>`;
const dpeHtml = (d) => `<span class="dpe dpe-${d || 'x'}" title="DPE ${d || 'inconnu'}">${d || '?'}</span>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

let S = null, ALL = {}, compare = [];

async function load() {
  S = await R.getSettings();
  ALL = await R.getListings();
  const st = await ext.storage.local.get('compare');
  compare = (st.compare || []).filter((id) => ALL[id]);
}
const saveCompare = () => ext.storage.local.set({ compare });

// Re-score chaque annonce avec les critères actuels
function analyzed(rec) {
  const raw = Object.assign({}, rec, rec.overrides || {});
  return Object.assign(R.analyze(raw, S), { rec });
}

// ───────────────────────────── Onglets
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'comparer') renderCompare();
  if (name === 'recherches') renderSearches();
}
$$('#tabs button').forEach((b) => (b.onclick = () => { location.hash = b.dataset.tab; }));
$$('[data-goto]').forEach((b) => (b.onclick = () => { location.hash = b.dataset.goto; }));
window.addEventListener('hashchange', route);
function route() {
  const h = location.hash.slice(1);
  if (!h.startsWith('annonce=') && dlg.open) dlg.close();
  if (h.startsWith('annonce=')) { showTab('annonces'); openDetail(decodeURIComponent(h.slice(8))); return; }
  showTab(['annonces', 'comparer', 'recherches', 'criteres', 'donnees'].includes(h) ? h : 'annonces');
}

function renderSummary() {
  const list = Object.values(ALL);
  $('#summary').textContent = ` ${S.city} · ${(S.rooms || []).map((r) => 'T' + r).join('/')} · ${R.fmtEur(S.priceMin)} – ${R.fmtEur(S.priceMax)} · DPE ${S.dpePref}–${S.dpeMin} · ${list.filter((l) => l.saved).length} sauvegardées / ${list.length} vues`;
  $('#cmpCount').textContent = compare.length || '';
}

// ───────────────────────────── Annonces
$('#fStatus').innerHTML += R.STATUSES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
['#q', '#fScope', '#fStatus', '#fSort', '#fHideElim'].forEach((s) => $(s).addEventListener('input', renderList));

function priceDelta(rec) {
  const h = rec.priceHistory || [];
  return h.length > 1 ? h[h.length - 1].price - h[0].price : 0;
}

function renderList() {
  const q = R.norm($('#q').value);
  const scope = $('#fScope').value, status = $('#fStatus').value, sort = $('#fSort').value, hideElim = $('#fHideElim').checked;
  let items = Object.values(ALL).map(analyzed).filter((l) => {
    if (scope === 'saved' && !l.rec.saved) return false;
    if (status && l.rec.status !== status) return false;
    if (hideElim && !status && (l.analysis.eliminated || l.rec.status === 'rejected')) return false;
    if (q && !R.norm([l.title, l.locationText, l.address, l.rec.notes, l.rec.siteName, (l.zonesStrong || []).map((z) => z.name).join(' ')].join(' ')).includes(q)) return false;
    return true;
  });
  const by = {
    score: (a, b) => b.analysis.score - a.analysis.score,
    recent: (a, b) => b.rec.firstSeen - a.rec.firstSeen,
    price: (a, b) => (a.price || 1e9) - (b.price || 1e9),
    pm2: (a, b) => (a.priceM2 || 1e9) - (b.priceM2 || 1e9),
    drop: (a, b) => priceDelta(a.rec) - priceDelta(b.rec)
  };
  items.sort(by[sort]);
  const total = Object.keys(ALL).length;
  $('#empty').hidden = total > 0;
  $('#list').innerHTML = items.map(cardHtml).join('') ||
    (total ? `<p class="m">Aucune annonce ne correspond à ces filtres${scope === 'saved' ? ' — essaie « Toutes les annonces vues »' : ''}.</p>` : '');
  bindCards();
  renderSummary();
}

function cardHtml(l) {
  const a = l.analysis, rec = l.rec;
  const d = priceDelta(rec);
  const dups = R.findDuplicates(Object.assign({}, rec, rec.overrides), ALL);
  const bad = a.checks.filter((c) => c.level === 'bad');
  const warn = a.checks.filter((c) => c.level === 'warn' && !/non d[ée]tect|incalculable/.test(c.detail)).slice(0, 2);
  const f = l.price ? R.financing(l.price, S) : null;
  const zones = (l.zoneOverride ? [l.zoneOverride] : (l.zonesStrong || []).map((z) => z.name)).join(', ');
  const specs = [l.rooms ? `T${l.rooms}` : '', l.surface ? `${l.surface} m²` : '', `DPE ${dpeHtml(l.dpe)}`,
    f ? `${R.fmtEur(Math.round(f.monthly))}/mois` : ''].filter(Boolean);
  const elim = a.eliminated || rec.status === 'rejected';
  return `<article class="card${elim ? ' elim' : ''}" data-id="${esc(rec.id)}">
    <div class="img" style="${rec.image ? `background-image:url('${esc(rec.image)}')` : ''}">${rec.image ? '' : '<span class="noimg">Pas de photo</span>'}
      <span class="score ${a.tone}" title="Score sur 100">${a.score}</span>
      <span class="badge">${esc(rec.siteName || rec.site)}</span></div>
    <div class="c">
      ${verdictHtml(a)}
      <div class="price">${R.fmtEur(l.price)}${l.priceM2 ? `<small>${R.fmtEur(l.priceM2)}/m²</small>` : ''}
        ${d < 0 ? `<span class="delta down">↘ ${R.fmtEur(-d)}</span>` : d > 0 ? `<span class="delta up">↗ ${R.fmtEur(d)}</span>` : ''}</div>
      <button class="title linkish" data-act="detail" title="Voir le détail">${esc(l.title || rec.url)}</button>
      <div class="specs">${specs.join('<span class="sep">/</span>')}</div>
      ${zones ? `<div class="zone">${esc(zones)}</div>` : ''}
      ${bad.length ? `<div class="alertline bad">${bad.map((c) => esc(c.detail)).join(' · ')}</div>` : warn.length ? `<div class="alertline">${warn.map((c) => esc(c.label + ' : ' + c.detail)).join(' · ')}</div>` : ''}
      ${dups.map((o) => `<div class="dup">Même bien sur <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.siteName || o.site)}</a> à ${R.fmtEur(o.price)}</div>`).join('')}
      ${rec.notes ? `<div class="note">« ${esc(rec.notes.slice(0, 140))}${rec.notes.length > 140 ? '…' : ''} »</div>` : ''}
    </div>
    <div class="foot">
      <select data-act="status" aria-label="Statut">${R.STATUSES.map((s) => `<option value="${s.id}"${rec.status === s.id ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
      <label class="chk small"><input type="checkbox" data-act="cmp"${compare.includes(rec.id) ? ' checked' : ''}> Comparer</label>
      <span class="sp"></span>
      <button class="btn sm ghost star${rec.saved ? ' on' : ''}" data-act="save" title="${rec.saved ? 'Retirer des sauvegardées' : 'Sauvegarder'}" aria-pressed="${!!rec.saved}">${rec.saved ? '★' : '☆'}</button>
      <a class="btn sm" href="${esc(rec.url)}" target="_blank" rel="noopener" title="Ouvrir l'annonce">↗</a>
    </div>
  </article>`;
}

async function patch(id, p) {
  ALL = await R.getListings();
  if (!ALL[id]) return;
  Object.assign(ALL[id], p);
  await R.saveListings(ALL);
}

function bindCards() {
  $$('#list .card').forEach((card) => {
    const id = card.dataset.id;
    $('[data-act=status]', card).onchange = async (e) => { await patch(id, { status: e.target.value, saved: true }); renderList(); };
    $('[data-act=save]', card).onclick = async () => { await patch(id, { saved: !ALL[id].saved }); renderList(); };
    $('[data-act=detail]', card).onclick = () => { location.hash = 'annonce=' + encodeURIComponent(id); };
    $('[data-act=cmp]', card).onchange = (e) => {
      compare = compare.filter((x) => x !== id);
      if (e.target.checked) { compare.push(id); if (compare.length > 4) compare.shift(); }
      saveCompare(); renderList();
    };
  });
}

// ───────────────────────────── Détail
const dlg = $('#detail');
dlg.addEventListener('close', () => { if (location.hash.startsWith('#annonce=')) history.replaceState(null, '', '#annonces'); renderList(); });
function openDetail(id) {
  const rec = ALL[id];
  if (!rec) return;
  const l = analyzed(rec), a = l.analysis;
  const f = l.price ? R.financing(l.price, S) : null;
  const h = rec.priceHistory || [];
  dlg.innerHTML = `<div class="dl">
    <div class="dl-head"><span class="score ${a.tone}">${a.score}</span>
      <div style="flex:1;min-width:0"><h3>${esc(l.title || 'Annonce')}</h3>
      <div class="m small">${esc(rec.siteName)} · vue le ${fmtDate(rec.firstSeen)} · <a href="${esc(rec.url)}" target="_blank" rel="noopener">ouvrir l'annonce</a></div></div>
      <button class="btn sm" id="dClose">Fermer</button></div>
    <p style="margin:var(--espace-2) 0 var(--espace-4)">${verdictHtml(a)}</p>
    ${checksHtml(a.checks)}
    ${f ? `<h2 class="section-title">Financement</h2><div class="fin">
      <span>Frais de notaire</span><span class="v">${R.fmtEur(Math.round(f.notary))}</span>
      <span>À emprunter</span><span class="v">${R.fmtEur(Math.round(f.principal))}</span>
      <span>Mensualité (${S.loan.years} ans)</span><span class="v big">${R.fmtEur(Math.round(f.monthly))}</span>
      ${l.chargesMonthly || l.taxeFonciere ? `<span>Coût logement / mois (prêt, charges, taxe foncière)</span><span class="v">${R.fmtEur(Math.round(f.monthly + (l.chargesMonthly || 0) + (l.taxeFonciere || 0) / 12))}</span>` : ''}
      <span>Coût total du crédit</span><span class="v">${R.fmtEur(Math.round(f.totalInterest))}</span></div>` : ''}
    ${h.length ? `<h2 class="section-title">Historique de prix</h2><ul class="hist">${h.map((x) => `<li>${fmtDate(x.date)} — ${R.fmtEur(x.price)}</li>`).join('')}</ul>` : ''}
    <h2 class="section-title">Notes</h2><textarea id="dNotes" placeholder="Contact, impressions, questions à poser…">${esc(rec.notes || '')}</textarea>
    <h2 class="section-title">Checklist de visite</h2>
    <div class="checklist">${R.VISIT_CHECKLIST.map((q, i) => `<label><input type="checkbox" data-i="${i}"${rec.checklist && rec.checklist[i] ? ' checked' : ''}> ${esc(q)}</label>`).join('')}</div>
    <h2 class="section-title">Vérifier</h2>
    <div class="row">${R.toolLinks(l).map((t) => `<a class="btn sm" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>`).join('')}</div>
    <div style="margin-top:var(--espace-8)"><button class="btn danger sm" id="dDel">Supprimer cette annonce</button></div>
  </div>`;
  $('#dClose').onclick = () => dlg.close();
  $('#dNotes').onchange = (e) => patch(id, { notes: e.target.value, saved: true });
  $$('.checklist input', dlg).forEach((c) => (c.onchange = async () => {
    const cl = Object.assign({}, ALL[id].checklist || {}); cl[c.dataset.i] = c.checked; await patch(id, { checklist: cl });
  }));
  $('#dDel').onclick = async () => {
    if (!confirm('Supprimer cette annonce de Radar Immo ?')) return;
    ALL = await R.getListings(); delete ALL[id]; await R.saveListings(ALL);
    compare = compare.filter((x) => x !== id); saveCompare(); dlg.close();
  };
  if (!dlg.open) dlg.showModal();
}

// ───────────────────────────── Comparateur
function renderCompare() {
  const items = compare.map((id) => ALL[id]).filter(Boolean).map(analyzed);
  if (items.length < 2) { $('#compareWrap').innerHTML = `<p class="m">${items.length} annonce sélectionnée. Il en faut au moins 2.</p>`; return; }
  const fin = (l) => (l.price ? R.financing(l.price, S) : null);
  const rows = [
    ['Score', (l) => l.analysis.score, 'max', (v, l) => `${v} · ${esc(l.analysis.verdict)}`],
    ['Prix', (l) => l.price, 'min', (v) => R.fmtEur(v)],
    ['Prix/m²', (l) => l.priceM2, 'min', (v) => R.fmtEur(v)],
    ['Surface', (l) => l.surface, 'max', (v) => v ? v + ' m²' : '—'],
    ['Pièces', (l) => l.rooms, 'max', (v) => v ? 'T' + v : '—'],
    ['DPE', (l) => (l.dpe ? -R.dpeRank(l.dpe) : null), 'max', (v, l) => dpeHtml(l.dpe)],
    ['Charges / mois', (l) => l.chargesMonthly, 'min', (v) => v != null ? R.fmtEur(v) : '—'],
    ['Taxe foncière', (l) => l.taxeFonciere, 'min', (v) => v != null ? R.fmtEur(v) : '—'],
    ['Mensualité prêt', (l) => (fin(l) ? Math.round(fin(l).monthly) : null), 'min', (v) => R.fmtEur(v)],
    ['Coût logement / mois', (l) => (fin(l) ? Math.round(fin(l).monthly + (l.chargesMonthly || 0) + (l.taxeFonciere || 0) / 12) : null), 'min', (v) => R.fmtEur(v)],
    ['Étage', (l) => l.floor, null, (v, l) => (v == null ? '—' : v === 0 ? 'RDC' : v + 'e') + (l.elevator === true ? ' · ascenseur' : l.elevator === false ? ' · sans ascenseur' : '')],
    ['Quartier', () => null, null, (v, l) => esc(l.zoneOverride || (l.zonesStrong || []).map((z) => z.name).join(', ') || '—')],
    ['Atouts', () => null, null, (v, l) => esc(l.keywords.good.join(', ') || '—')],
    ['Vigilance', () => null, null, (v, l) => esc(l.keywords.bad.join(', ') || '—')],
    ['Statut', () => null, null, (v, l) => esc((R.STATUSES.find((s) => s.id === l.rec.status) || {}).label)],
    ['Notes', () => null, null, (v, l) => esc(l.rec.notes || '')]
  ];
  $('#compareWrap').innerHTML = `<div class="tablewrap"><table><thead><tr><th></th>${items.map((l) => `<th><a href="${esc(l.rec.url)}" target="_blank">${esc((l.title || l.rec.siteName).slice(0, 50))}</a><div class="row" style="margin-top:4px"><span class="m small">${esc(l.rec.siteName)}</span><button class="btn sm ghost" data-rm="${esc(l.rec.id)}">Retirer</button></div></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, get, best, fmt]) => {
      const vals = items.map(get);
      const nums = vals.filter((v) => v != null);
      const allSame = nums.length > 1 && nums.every((v) => v === nums[0]);
      const target = best && nums.length > 1 && !allSame ? (best === 'max' ? Math.max(...nums) : Math.min(...nums)) : null;
      return `<tr><th>${label}</th>${items.map((l, i) => `<td class="${target != null && vals[i] === target ? 'best' : ''}"><span>${fmt(vals[i], l)}</span></td>`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
  $$('[data-rm]').forEach((b) => (b.onclick = () => { compare = compare.filter((x) => x !== b.dataset.rm); saveCompare(); renderCompare(); renderSummary(); }));
}

// ───────────────────────────── Recherches
function renderSearches() {
  $('#searches').innerHTML = (S.searches || []).map((s, i) => `<div class="srch"><div class="grow"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a><div class="url">${esc(s.url)}</div></div><button class="btn sm ghost" data-del="${i}" aria-label="Supprimer">Supprimer</button></div>`).join('')
    || '<p class="m" style="margin:0">Aucune recherche enregistrée. « Tout ouvrir » lancera la recherche Leboncoin pré-remplie.</p>';
  $$('[data-del]').forEach((b) => (b.onclick = async () => { S.searches.splice(+b.dataset.del, 1); await R.saveSettings(S); renderSearches(); }));
  $('#starts').innerHTML = R.searchLinks(S).map((s) => `<div class="srch"><div class="grow"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
    <button class="btn sm" data-add="${esc(s.url)}" data-name="${esc(s.name)}">Enregistrer</button></div>`).join('');
  $$('[data-add]').forEach((b) => (b.onclick = async () => { S.searches.push({ name: b.dataset.name.replace(/ \(.*\)/, ''), url: b.dataset.add }); await R.saveSettings(S); renderSearches(); }));
}
$('#addSearch').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#sUrl').value.trim(); if (!url) return;
  let name = $('#sName').value.trim();
  if (!name) { const s = R.siteFor(url); name = s ? s.name : new URL(url).hostname; }
  S.searches.push({ name, url }); await R.saveSettings(S);
  $('#sUrl').value = ''; $('#sName').value = ''; renderSearches();
};
$('#openAll').onclick = () => {
  const urls = (S.searches.length ? S.searches : R.searchLinks(S).filter((s) => s.prefilled)).map((s) => s.url);
  urls.forEach((u, i) => ext.tabs.create({ url: u, active: i === 0 }));
};

// ───────────────────────────── Critères
const form = $('#crit');
const dpeOpts = R.DPE_ORDER.map((d) => `<option value="${d}">${d}</option>`).join('');
form.dpeMin.innerHTML = dpeOpts; form.dpePref.innerHTML = dpeOpts;
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; };

function fillForm() {
  $$('[name]', form).forEach((el) => {
    const v = getPath(S, el.name);
    if (el.type === 'checkbox') el.checked = v !== false;
    else if (Array.isArray(v)) el.value = v.join(el.tagName === 'TEXTAREA' ? ', ' : ', ');
    else el.value = v == null ? '' : v;
  });
  $('#roomsBox').innerHTML = [1, 2, 3, 4, 5].map((n) => `<label><input type="checkbox" value="${n}"${S.rooms.includes(n) ? ' checked' : ''}> ${n === 1 ? 'Studio/T1' : n === 5 ? 'T5+' : 'T' + n}</label>`).join('');
  $$('#roomsBox input').forEach((c) => (c.onchange = () => { S.rooms = $$('#roomsBox input:checked').map((x) => +x.value); persist(); }));
  renderZones();
  renderBudget();
}
function renderBudget() {
  const pmax = R.maxPriceForMonthly(S);
  const f = R.financing(S.priceMax, S);
  $('#budgetInfo').innerHTML = `Avec ${R.fmtEur(S.loan.apport || 0)} d'apport, ${S.loan.ratePct}% sur ${S.loan.years} ans : un bien à <b>${R.fmtEur(S.priceMax)}</b> coûte ≈ <b>${R.fmtEur(Math.round(f.monthly))}/mois</b> (notaire inclus).
    Ta mensualité max de ${R.fmtEur(S.loan.maxMonthly)} permet un prix jusqu'à ≈ <b>${R.fmtEur(Math.round(pmax / 500) * 500)}</b>.
    <br><span class="m small">Estimation indicative : le taux, l'assurance et les frais réels dépendent de ta banque. Les frais de notaire dans l'ancien tournent autour de 7 à 8 % du prix.</span>`;
}
function renderZones() {
  $('#zones').innerHTML = S.zones.map((z, i) => `<span class="z ${z.status}" data-i="${i}" title="Mots-clés : ${esc((z.keywords || [z.name]).join(', '))}">${esc(z.name)}<span class="x" data-rmz="${i}" title="Retirer de la liste">✕</span></span>`).join('');
  $$('#zones .z').forEach((el) => (el.onclick = (e) => {
    const i = +el.dataset.i;
    if (e.target.dataset.rmz != null) { S.zones.splice(i, 1); }
    else { const order = ['neutral', 'banned', 'preferred']; S.zones[i].status = order[(order.indexOf(S.zones[i].status) + 1) % 3]; }
    renderZones(); persist();
  }));
}
$('#zAdd').onclick = () => {
  const name = $('#zName').value.trim(); if (!name) return;
  const kws = [name].concat($('#zKw').value.split(',').map((x) => x.trim()).filter(Boolean));
  S.zones.push({ name, keywords: kws, status: 'banned' });
  $('#zName').value = ''; $('#zKw').value = '';
  renderZones(); persist();
};

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await R.saveSettings(S);
    renderBudget(); renderSummary();
    const m = $('#savedMsg'); m.classList.add('show'); setTimeout(() => m.classList.remove('show'), 1200);
  }, 250);
}
form.addEventListener('input', (e) => {
  const el = e.target; if (!el.name) return;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'number') v = el.value === '' ? 0 : +el.value;
  else if (el.name === 'postalCodes' || el.name.startsWith('keywords')) v = el.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  else v = el.value;
  setPath(S, el.name, v);
  persist();
});
form.addEventListener('submit', (e) => e.preventDefault());

// ───────────────────────────── Données
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#expJson').onclick = async () => {
  const data = await ext.storage.local.get(null);
  download(`radar-immo-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
};
$('#expCsv').onclick = () => {
  const cols = ['site', 'url', 'title', 'price', 'surface', 'rooms', 'dpe', 'chargesMonthly', 'taxeFonciere', 'priceM2', 'zones', 'score', 'verdict', 'status', 'saved', 'notes', 'firstSeen'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = Object.values(ALL).map((rec) => {
    const l = analyzed(rec);
    const row = Object.assign({}, rec, rec.overrides, { priceM2: l.priceM2, zones: (l.zonesStrong || []).map((z) => z.name).join(' / '), score: l.analysis.score, verdict: l.analysis.verdict, firstSeen: new Date(rec.firstSeen).toISOString().slice(0, 10) });
    return cols.map((c) => q(row[c])).join(';');
  });
  download('radar-immo-annonces.csv', '﻿' + cols.join(';') + '\n' + lines.join('\n'), 'text/csv');
};
$('#impJson').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.settings && !data.listings) throw new Error('format');
    const cur = await R.getListings();
    await ext.storage.local.set({ settings: data.settings || S, listings: Object.assign(cur, data.listings || {}) });
    alert('Import terminé.'); location.reload();
  } catch (err) { alert('Fichier invalide.'); }
};
$('#purgeSeen').onclick = async () => {
  if (!confirm('Supprimer toutes les annonces vues mais non sauvegardées ?')) return;
  ALL = await R.getListings();
  Object.keys(ALL).forEach((k) => { if (!ALL[k].saved) delete ALL[k]; });
  await R.saveListings(ALL); renderList();
};
$('#resetAll').onclick = async () => {
  if (!confirm('Effacer TOUTES les données (critères et annonces) ?')) return;
  await ext.storage.local.clear(); location.reload();
};

// Rafraîchit quand une annonce est vue/modifiée dans un autre onglet
ext.storage.onChanged.addListener(async (ch) => {
  if (ch.listings) { ALL = ch.listings.newValue || {}; if (!dlg.open) renderList(); }
});

(async () => {
  await load();
  fillForm();
  renderList();
  route();
})();
