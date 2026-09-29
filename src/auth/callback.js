/* Retour de la page de connexion du front-end : …/auth/callback.html#token=<jeton>&state=<state>
 * Le jeton est lu dans le fragment (jamais envoyé à un serveur), puis retiré de l'URL. */
(async () => {
  const C = globalThis.RadarCloud;
  const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
  const $ = (id) => document.getElementById(id);
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  history.replaceState(null, '', location.pathname);
  const show = (title, msg, ok) => {
    $('title').textContent = title; $('msg').textContent = msg; $('dash').hidden = false;
    $('dash').onclick = () => { location.href = ext.runtime.getURL('dashboard/dashboard.html#donnees'); };
    document.title = title + ' · Radar Immo';
    if (ok) setTimeout(() => $('dash').click(), 2500);
  };
  if (p.get('error')) return show('Connexion annulée', p.get('error_description') || 'La connexion n\'a pas abouti.', false);
  try {
    const s = await C.completeLogin({
      token: p.get('token') || p.get('access_token'), state: p.get('state'),
      refreshToken: p.get('refresh_token'), expiresIn: p.get('expires_in')
    });
    show('Tu es connecté', `Compte ${s.userId}. Tes critères et tes annonces vont se synchroniser.`, true);
    ext.runtime.sendMessage({ type: 'cloudSync' }).catch(() => {});
  } catch (e) {
    show('Connexion impossible', e.message, false);
  }
})();
