/* Partage public d'une annonce : champs exposés et page HTML servie sur /s/:token.
 * La page est autonome (aucun script, CSS en ligne) : elle marche sans le front-end,
 * et ses balises Open Graph donnent un bel aperçu dans les messageries. */
import { randomBytes } from 'node:crypto';

export const newShareToken = () => randomBytes(16).toString('base64url'); // 128 bits
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Champs de l'annonce visibles publiquement. Pas de checklist, de corrections brutes ni de description
// (texte du site d'origine) : le lien renvoie vers l'annonce pour le détail.
const PUBLIC_FIELDS = ['url', 'site', 'siteName', 'title', 'image', 'price', 'priceM2', 'priceHistory', 'surface', 'rooms',
  'bedrooms', 'propertyType', 'dpe', 'ges', 'dpeNote', 'energyCost', 'chargesMonthly', 'taxeFonciere', 'floor', 'elevator',
  'lots', 'yearBuilt', 'city', 'postalCode', 'locationText', 'zones', 'score', 'verdict', 'eliminated', 'firstSeen'];

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/** Vue publique d'une annonce (données stockées + options du partage). */
export function publicView(data, share) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (data[k] != null) out[k] = data[k];
  out.url = safeUrl(out.url);
  out.image = safeUrl(out.image);
  if (!out.url) delete out.url;
  if (!out.image) delete out.image;
  if (share.includeNotes && data.notes) out.notes = String(data.notes).slice(0, 5000);
  if (share.message) out.message = share.message;
  out.sharedAt = share.createdAt;
  if (share.expiresAt) out.expiresAt = share.expiresAt;
  return out;
}

// ───────────── Page HTML
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('fr-FR') + ' €').replace(/ /g, ' ');
const date = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const DPE_COLORS = { A: '#009c6d', B: '#52b153', C: '#a5cc74', D: '#f4e70f', E: '#f0b40f', F: '#eb8235', G: '#d7221f' };
const TONES = { 'Coup de cœur': '#c8607f', 'Intéressant': '#1f7a45', 'Mitigé': '#8f5f00', 'Peu adapté': '#71717a', 'Éliminé': '#71717a' };

export function summary(v) {
  return [v.rooms ? `T${v.rooms}` : '', v.surface ? `${v.surface} m²` : '', v.price ? eur(v.price) : '', v.city || ''].filter(Boolean).join(' · ');
}

const CSS = `
:root{--bg:#f6f6f7;--surface:#fff;--text:#18181b;--muted:#6b6b76;--border:#e4e4e7;--accent:#c8607f}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1b1b1f;--text:#f4f4f5;--muted:#a1a1aa;--border:#2e2e33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.hero{aspect-ratio:16/9;background:var(--border) center/cover no-repeat}
.in{padding:20px}
.brand{color:var(--muted);font-size:13px;margin:4px 0 12px}
.brand b{color:var(--accent);white-space:nowrap}
h1{font-size:20px;line-height:1.3;margin:0 0 6px}
.price{font-size:28px;font-weight:700;margin:8px 0 2px}
.price small{font-size:15px;font-weight:500;color:var(--muted);margin-left:8px}
.drop{display:block;color:#1f7a45;font-weight:600;font-size:14px}
.loc{color:var(--muted)}
.verdict{display:inline-flex;align-items:center;gap:8px;margin:14px 0 4px;font-weight:600}
.verdict .s{display:inline-grid;place-items:center;min-width:38px;height:38px;border-radius:10px;color:#fff;font-size:16px}
.hint{color:var(--muted);font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:18px 0}
.grid div{border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.grid .k{display:block;color:var(--muted);font-size:12.5px}
.grid b{font-weight:600}
.dpe{display:inline-block;min-width:28px;text-align:center;border-radius:6px;color:#111;font-weight:700;padding:0 8px}
blockquote{margin:16px 0;padding:12px 14px;border-left:3px solid var(--accent);background:var(--bg);border-radius:8px;white-space:pre-wrap}
h2{font-size:15px;margin:20px 0 6px}
ul.hist{margin:0;padding-left:18px;color:var(--muted)}
.btn{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:10px;margin-top:20px}
footer{color:var(--muted);font-size:12.5px;text-align:center;padding:16px}
`;

function page({ title, description, image, url, body, status = 200 }) {
  const og = [
    ['og:type', 'website'], ['og:title', title], ['og:description', description], ['og:url', url], ['og:image', image],
    ['og:site_name', 'Radar Immo'], ['twitter:card', image ? 'summary_large_image' : 'summary']
  ].filter(([, v]) => v).map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join('\n');
  return {
    status,
    html: `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${og}
<style>${CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`
  };
}

export function renderNotFound() {
  return page({
    status: 404,
    title: 'Lien de partage indisponible · Radar Immo',
    description: 'Ce lien n\'existe pas, a expiré ou a été désactivé.',
    body: `<div class="card"><div class="in"><div class="brand"><b>Radar Immo</b></div>
      <h1>Ce lien n'est plus disponible</h1>
      <p class="loc">Il a peut-être expiré, été désactivé par la personne qui l'a partagé, ou l'annonce a été supprimée.</p></div></div>`
  });
}

export function renderSharePage(v, { url }) {
  const drop = (() => {
    const h = v.priceHistory || [];
    return h.length > 1 ? h[h.length - 1].price - h[0].price : 0;
  })();
  const rows = [
    ['Surface', v.surface && `${v.surface} m²`],
    ['Pièces', v.rooms && (v.rooms === 1 ? 'Studio / T1' : `T${v.rooms}`) + (v.bedrooms ? ` · ${v.bedrooms} ch.` : '')],
    ['Type', v.propertyType && v.propertyType[0].toUpperCase() + v.propertyType.slice(1)],
    ['DPE', v.dpe ? `<span class="dpe" style="background:${DPE_COLORS[v.dpe] || '#ccc'}">${esc(v.dpe)}</span>` : (v.dpeNote ? esc(v.dpeNote) : null), true],
    ['GES', v.ges ? `<span class="dpe" style="background:${DPE_COLORS[v.ges] || '#ccc'}">${esc(v.ges)}</span>` : null, true],
    ['Énergie / an', Array.isArray(v.energyCost) && v.energyCost.length === 2 && `${eur(v.energyCost[0])} à ${eur(v.energyCost[1])}`],
    ['Charges / mois', v.chargesMonthly != null && eur(v.chargesMonthly)],
    ['Taxe foncière', v.taxeFonciere != null && eur(v.taxeFonciere)],
    ['Étage', v.floor != null && (v.floor === 0 ? 'Rez-de-chaussée' : `${v.floor}e`) + (v.elevator === true ? ' · ascenseur' : v.elevator === false ? ' · sans ascenseur' : '')],
    ['Construction', v.yearBuilt],
    ['Copropriété', v.lots && `${v.lots} lots`]
  ].filter(([, val]) => val);
  const loc = [v.zones && v.zones.length ? v.zones.join(', ') : '', [v.postalCode, v.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const title = v.title || summary(v) || 'Annonce immobilière';
  const tone = TONES[v.verdict] || '#71717a';
  const body = `<article class="card">
  ${v.image ? `<div class="hero" style="background-image:url('${esc(v.image)}')" role="img" aria-label="Photo du bien"></div>` : ''}
  <div class="in">
    <div class="brand"><b>Radar Immo</b> · annonce partagée le ${esc(date(v.sharedAt))}</div>
    <h1>${esc(title)}</h1>
    ${loc ? `<div class="loc">${esc(loc)}</div>` : ''}
    <div class="price">${eur(v.price)}${v.priceM2 ? `<small>${eur(v.priceM2)}/m²</small>` : ''}</div>
    ${drop < 0 ? `<div class="drop">↘ En baisse de ${eur(-drop)} depuis le ${esc(date(v.priceHistory[0].date))}</div>` : ''}
    ${v.score != null && v.verdict ? `<div class="verdict"><span class="s" style="background:${tone}">${esc(v.score)}</span>${esc(v.verdict)}</div>
      <div class="hint">Score sur 100 selon les critères de la personne qui partage.</div>` : ''}
    ${v.message ? `<blockquote>${esc(v.message)}</blockquote>` : ''}
    ${rows.length ? `<div class="grid">${rows.map(([k, val, raw]) => `<div><span class="k">${k}</span><b>${raw ? val : esc(val)}</b></div>`).join('')}</div>` : ''}
    ${v.notes ? `<h2>Notes</h2><blockquote>${esc(v.notes)}</blockquote>` : ''}
    ${(v.priceHistory || []).length > 1 ? `<h2>Historique du prix</h2><ul class="hist">${v.priceHistory.map((h) => `<li>${esc(date(h.date))} : ${eur(h.price)}</li>`).join('')}</ul>` : ''}
    ${v.url ? `<a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">Voir l'annonce${v.siteName ? ` sur ${esc(v.siteName)}` : ''}</a>` : ''}
  </div>
</article>
<footer>Informations relevées sur l'annonce d'origine, elles ont pu changer depuis.${v.expiresAt ? ` Lien valable jusqu'au ${esc(date(v.expiresAt))}.` : ''}<br>Partagé avec Radar Immo.</footer>`;
  return page({ title: `${title} · Radar Immo`, description: [summary(v), v.verdict].filter(Boolean).join(' · '), image: v.image, url, body });
}
