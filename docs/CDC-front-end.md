# Cahier des charges : front-end · branchement sur l'API Radar Immo

| | |
|---|---|
| **Destinataires** | Équipe front-end |
| **Version** | 1.0 · 28 septembre 2026 |
| **Documents liés** | [README de l'API](../server/README.md) · [Code de l'extension](../src/) |

---

## 1. Contexte

Radar Immo est une extension de navigateur qui analyse les annonces immobilières (Leboncoin, SeLoger, PAP…) et les note selon les critères de l'utilisateur. Jusqu'ici, tout restait dans le navigateur.

Un **nouveau backend, l'API Radar Immo**, synchronise désormais les critères et les annonces suivies de chaque utilisateur. L'objectif est de les rendre disponibles **sur tous ses navigateurs et dans l'application web**.

> **Point clé pour le front-end.** L'application est déjà branchée sur un backend, le **backend principal**, qui gère notamment l'authentification. **Il ne change pas et reste branché tel quel.** L'API Radar Immo est un **second backend, distinct**, avec sa propre URL. Le front-end doit donc **ajouter un deuxième client HTTP** vers ce nouveau backend, en réutilisant le jeton de session qu'il obtient déjà.

## 2. Architecture

```
                          ┌──────────────────────────────┐
  Front-end ── jeton ───► │ Backend principal (existant) │ ◄─── GET vérification du jeton ───┐
      │                   │ connexion, comptes…          │                                    │
      │                   └──────────────┬───────────────┘                                    │
      │                                  │ schéma « public » (inchangé)                       │
      │                          ┌───────┴────────┐                                           │
      │                          │   PostgreSQL   │                                           │
      │                          └───────┬────────┘                                           │
      │                                  │ schéma « radar_immo » (dédié)                      │
      │   Authorization: Bearer <jeton>  │                                                    │
      └────────────────────────────► ┌───┴───────────────────┐ ───────────────────────────────┘
  Extension ── Bearer <jeton> ──────►│ API Radar Immo (neuve) │
                                     └────────────────────────┘
```

- Le front-end **ne parle jamais directement à PostgreSQL**. Il passe par l'API Radar Immo pour tout ce qui concerne Radar Immo.
- L'API Radar Immo **n'a pas de page de connexion ni de gestion de comptes**. Pour chaque requête, elle demande au backend principal si le jeton est valide.

## 3. Périmètre

**Inclus**
1. Configuration du nouveau backend (URL par environnement) et d'un client HTTP dédié.
2. Page **« Mes annonces »** : liste, filtres, tri.
3. Page **détail d'une annonce** : informations, suivi (statut, notes, checklist), suppression.
4. Page **« Mes critères »**, en lecture seule au minimum (l'édition est facultative, voir 6.3).
5. Page **« Connecter l'extension »** (`/connexion-extension`), qui transmet le jeton à l'extension.
6. **Export** et **suppression** des données Radar Immo de l'utilisateur.

**Exclus**
- Toute modification du backend principal côté front-end (connexion, inscription et profil restent inchangés).
- L'analyse des pages d'annonces, qui reste le rôle de l'extension.

## 4. Configuration et client HTTP

### 4.1 Variable d'environnement

Ajouter l'URL de l'API, sans `/` final. Préfixer selon le framework (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`…) :

| Variable | Développement | Recette | Production |
|---|---|---|---|
| `RADAR_API_URL` | `http://localhost:3000` | *à fournir par l'équipe backend* | *à fournir par l'équipe backend* |

L'URL existante du backend principal ne change pas.

### 4.2 Client HTTP

Créer un client **distinct** de celui du backend principal (instance Axios, wrapper `fetch`, service Angular…) :

- **URL de base** : `RADAR_API_URL`.
- **En-tête sur chaque requête** : `Authorization: Bearer <jeton>`, avec **le même jeton** que celui envoyé au backend principal. Aucune nouvelle connexion n'est nécessaire.
- **`Content-Type: application/json`** sur les requêtes avec corps.
- **Pas de cookies** : l'API n'en utilise pas. Ne pas activer `credentials: 'include'` / `withCredentials`.
- **Délai d'attente** conseillé : 10 s.

> ⚠️ **Prérequis à vérifier.** Si le jeton du backend principal est stocké dans un cookie `HttpOnly` illisible en JavaScript, le front-end ne peut pas l'envoyer en en-tête. Signalez-le à l'équipe backend avant de commencer : il faudra une route du backend principal qui fournit un jeton utilisable en `Bearer`.

### 4.3 CORS

Communiquez à l'équipe backend **les origines exactes** du front-end pour chaque environnement (ex. `https://app.exemple.fr`, `http://localhost:5173`). Elles sont ajoutées à `CORS_ORIGINS`. Sans cela, le navigateur bloque les appels.

## 5. Gestion des erreurs

Toutes les erreurs ont la forme :

```json
{ "error": "invalid_token", "message": "Jeton invalide ou expiré" }
```

| Statut | `error` | Signification | Comportement attendu |
|---|---|---|---|
| 400 | `invalid_request` | Corps ou paramètres invalides | Bug front-end : journaliser, message générique. |
| 401 | `missing_token`, `invalid_token` | Jeton absent, expiré ou refusé par le backend principal | **Même traitement que pour un 401 du backend principal** : rafraîchir le jeton s'il existe un mécanisme de rafraîchissement, rejouer la requête **une seule fois**, sinon renvoyer vers la connexion. |
| 403 | `forbidden` | Le backend principal refuse l'accès | « Tu n'as pas accès à cette fonctionnalité. » |
| 404 | `not_found` | Annonce supprimée (éventuellement depuis un autre appareil) | La retirer de l'affichage, puis revenir à la liste. |
| 409 | `conflict` | `PUT /v1/settings` avec un `updatedAt` plus ancien que la version stockée (voir 6.3) | Recharger les critères, prévenir l'utilisateur. |
| 413 | `too_large` | Données trop volumineuses | « Ces données sont trop volumineuses. » |
| 502 | `auth_no_user_id` | Erreur de configuration côté serveurs | Message générique, remonter à l'équipe backend. |
| 503 | `auth_unavailable` | Le backend principal ne répond pas | « Service momentanément indisponible », bouton « Réessayer ». **Ne pas déconnecter l'utilisateur.** |
| 5xx | `internal_error` | Erreur serveur | Message générique, bouton « Réessayer ». |
| — | (réseau) | API injoignable | Idem 503. |

## 6. Fonctionnalités

### 6.1 Page « Mes annonces »

**Données** : `GET /v1/listings?saved=true&limit=50&offset=0`

```json
{
  "items": [
    {
      "id": "leboncoin:2890012345",
      "url": "https://www.leboncoin.fr/ad/ventes_immobilieres/2890012345",
      "siteName": "Leboncoin",
      "title": "Appartement 3 pièces 62 m²",
      "image": "https://img.leboncoin.fr/…jpg",
      "price": 150000, "surface": 62, "rooms": 3, "dpe": "C", "priceM2": 2419,
      "city": "Rennes", "postalCode": "35000", "zones": ["Thabor"],
      "score": 84, "verdict": "Coup de cœur", "eliminated": false,
      "status": "visit", "saved": true, "notes": "Visite samedi 10 h",
      "priceHistory": [{ "price": 155000, "date": 1790000000000 }, { "price": 150000, "date": 1790500000000 }],
      "firstSeen": 1790000000000, "lastSeen": 1790500000000, "updatedAt": 1790590084168
    }
  ],
  "total": 37
}
```

| Paramètre | Valeurs | Défaut |
|---|---|---|
| `saved` | `true` : sauvegardées · `false` : vues seulement · absent : toutes | toutes |
| `status` | `new`, `contact`, `visit`, `visited`, `offer`, `rejected` | tous |
| `limit` | 1 à 200 | 50 |
| `offset` | ≥ 0 | 0 |

L'API trie par dernière modification, de la plus récente à la plus ancienne. Les autres tris (score, prix, prix au m², baisse de prix) se font côté front sur la page chargée, ou sur la liste complète si `total` ≤ 200.

**À afficher sur chaque carte** : photo (ou « Pas de photo »), score sur 100 et verdict, prix et prix au m², baisse de prix (dernier moins premier de `priceHistory`), pièces (`T3`), surface, DPE, quartier (`zones`), site d'origine, statut, bouton ★ (sauvegarder), lien vers l'annonce d'origine.

**Filtres** : sauvegardées ou toutes, statut, recherche texte (titre, ville, notes) côté front, masquer les annonces écartées ou hors critères (`eliminated: true` ou `status: "rejected"`).

**Correspondance des statuts** (identique à l'extension) :

| `status` | Libellé |
|---|---|
| `new` | À étudier |
| `contact` | Contacté |
| `visit` | Visite prévue |
| `visited` | Visité |
| `offer` | Offre faite |
| `rejected` | Écarté |

**Correspondance des verdicts** (`verdict`, pour la couleur) : *Coup de cœur* (≥ 80), *Intéressant* (≥ 62), *Mitigé* (≥ 45), *Peu adapté*, *Éliminé* (`eliminated: true`).

**État vide** : « Aucune annonce pour l'instant. Installe l'extension Radar Immo et connecte-la à ton compte pour retrouver ici les annonces que tu sauvegardes. », avec un lien vers la page 6.4.

### 6.2 Page détail d'une annonce

**Données** : `GET /v1/listings/{id}`. L'identifiant contient un `:` et **doit être encodé** avec `encodeURIComponent`, ce qui donne `leboncoin%3A2890012345`.

**Afficher** : toutes les caractéristiques disponibles (voir le modèle en section 7), l'historique de prix, la description et les liens de vérification. Tout champ peut être absent : afficher « — » ou masquer la ligne.

**Actions**, toutes avec `PATCH /v1/listings/{id}` et **seulement les champs modifiés** :

| Action | Corps envoyé |
|---|---|
| Changer le statut | `{ "status": "visit", "saved": true }` |
| Modifier les notes (à l'enregistrement ou à la perte du focus) | `{ "notes": "…", "saved": true }` (20 000 caractères max) |
| Sauvegarder / retirer | `{ "saved": true }` / `{ "saved": false }` |
| Cocher un point de la checklist | `{ "checklist": { "0": true, "3": true } }` : envoyer **l'objet complet**, il remplace le précédent |

La réponse contient l'annonce complète à jour : remplacer l'état local par cette réponse. Les autres champs (prix, surface…) **ne sont pas modifiables** par l'API et renvoient `400`.

**Checklist de visite** : les clés sont les indices `"0"` à `"11"` de cette liste, dans cet ordre, identique à l'extension :

0. PV des 3 dernières AG (travaux votés, impayés, procédures)
1. Montant du fonds de travaux (loi ALUR) et du prochain appel
2. Charges réelles annuelles + ce qu'elles incluent (chauffage ? eau ?)
3. Taxe foncière exacte
4. Mode de chauffage et facture annuelle
5. Traces d'humidité / condensation (angles, salle de bain, fenêtres)
6. État des fenêtres (double vitrage ?) et de l'électricité (tableau)
7. Exposition / luminosité à différentes heures
8. Bruit (rue, voisins, bars) — revenir un soir
9. Stationnement / cave / local vélo
10. Distance tram / bus, commerces
11. Pourquoi le vendeur vend ? Depuis quand en vente ?

**Supprimer** : `DELETE /v1/listings/{id}` renvoie `204`. Demander confirmation : « Supprimer cette annonce de Radar Immo ? Elle disparaîtra aussi de l'extension. »

**Liens de vérification** (à ouvrir dans un nouvel onglet) : [DVF](https://explore.data.gouv.fr/fr/immobilier?onglet=carte&filtre=tous) (ajouter `&lat=…&lng=…&zoom=16` si connus), [Géorisques](https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi), [DPE ADEME](https://observatoire-dpe-audit.ademe.fr/trouver-dpe), [Registre des copropriétés](https://www.registre-coproprietes.gouv.fr/annuaire), OpenStreetMap.

### 6.3 Page « Mes critères »

**Lecture** : `GET /v1/settings` renvoie `{ "data": { … }, "updatedAt": 1790590084168 }`, ou `{ "data": null, "updatedAt": null }` si l'utilisateur n'a encore rien synchronisé.

**V1 (obligatoire) : lecture seule.** Afficher un résumé : ville, codes postaux, type de bien, budget min-max et tolérance, pièces, surface min, DPE visé et DPE minimum, charges max, prix de référence au m², financement (apport, taux, durée, mensualité max), quartiers bannis et préférés, mots-clés. Ajouter un message : « Modifie tes critères dans l'extension Radar Immo. »

**V2 (facultatif) : édition.** `PUT /v1/settings` avec `{ "data": <objet complet> }`, sans `updatedAt` :
- `data` **remplace entièrement** les critères. Toujours partir de l'objet lu et le renvoyer complet, sans supprimer les champs inconnus du front.
- L'API date elle-même l'enregistrement, qui devient la version la plus récente. L'extension la récupère à sa prochaine synchronisation.
- La dernière écriture gagne : recharger les critères (`GET`) à l'ouverture du formulaire, pour ne pas écraser une modification faite entre-temps dans l'extension.
- Le champ `updatedAt` facultatif sert aux clients qui synchronisent (l'extension) : s'il est plus ancien que la version stockée, l'API refuse avec `409` et renvoie `current`.

Modèle des critères (champs principaux) :

```jsonc
{
  "city": "Rennes", "postalCodes": ["35000"], "propertyType": "appartement",   // ou "maison", ""
  "priceMin": 150000, "priceMax": 190000, "priceTolerancePct": 5,
  "rooms": [2, 3], "surfaceMin": 40, "dpeMin": "D", "dpePref": "C",
  "chargesMaxMonthly": 150, "refPriceM2": 3500,
  "loan": { "apport": 0, "ratePct": 3.4, "years": 25, "insurancePct": 0.3, "notaryPct": 7.5, "maxMonthly": 900 },
  "zones": [ { "name": "Thabor", "keywords": ["Thabor"], "status": "preferred" } ],   // neutral | banned | preferred
  "keywordsGood": ["balcon", "cave"], "keywordsBad": ["viager"],
  "searches": [ { "name": "Leboncoin", "url": "https://…" } ],
  "highlightResults": true, "showPanel": true
}
```

### 6.4 Page « Connecter l'extension » (`/connexion-extension`)

C'est par cette page que l'extension obtient le jeton de l'utilisateur. Le déroulé :

1. Dans l'extension, l'utilisateur clique sur **« Se connecter »**. L'extension ouvre un onglet sur :
   ```
   https://app.exemple.fr/connexion-extension?redirect_uri=chrome-extension%3A%2F%2F<id>%2Fauth%2Fcallback.html&state=<aléa>&client=radar-immo-extension
   ```
2. **Si l'utilisateur n'est pas connecté**, le front-end affiche sa page de connexion habituelle, puis revient sur `/connexion-extension` avec les mêmes paramètres.
3. Le front-end affiche un **écran de consentement** : logo, « L'extension Radar Immo demande l'accès à ton compte pour synchroniser tes critères et tes annonces. », avec les boutons **Autoriser** et **Annuler**.
4. **Autoriser** : redirection (`window.location.replace`) vers
   ```
   <redirect_uri>#token=<jeton>&state=<state reçu>
   ```
   **Annuler** : redirection vers `<redirect_uri>#error=access_denied&state=<state reçu>`.
5. L'extension vérifie le `state`, valide le jeton auprès de l'API, puis affiche « Tu es connecté ».

**Exigences de sécurité (obligatoires)**

- **Contrôler `redirect_uri`** avant toute redirection. N'accepter que :
  - `chrome-extension://<ID>/auth/callback.html`, avec `<ID>` dans une liste blanche : les identifiants publiés de l'extension, fournis par l'équipe extension pour chaque navigateur (Chrome, Edge) ;
  - `moz-extension://<uuid>/auth/callback.html` (Firefox, où l'identifiant est aléatoire par installation et ne peut pas être listé) : format UUID strict, chemin exact.
  - Tout autre schéma (`https:`, `javascript:`, `data:`…), tout autre chemin ou un `redirect_uri` absent : **refuser** et afficher « Lien de connexion invalide ».
- **Le jeton va dans le fragment (`#`)**, jamais dans la query string (`?`), pour qu'il n'apparaisse ni dans les journaux serveur ni dans l'en-tête `Referer`.
- **Renvoyer `state` à l'identique.** Ne pas l'interpréter.
- **Toujours demander le consentement explicite** (étape 3), même si l'utilisateur est déjà connecté. Pas de redirection automatique.
- **Durée de vie du jeton** : l'extension le réutilise pour se synchroniser toutes les 15 minutes. Un jeton de quelques minutes obligera l'utilisateur à se reconnecter souvent. **À décider avec l'équipe backend** : l'idéal est un jeton dédié à l'extension, de longue durée et révocable. À défaut, le jeton de session courant.
- Ajouter `<meta name="referrer" content="no-referrer">` sur cette page.

**Lien d'entrée** : ajouter dans l'application (menu du compte ou page « Mes annonces ») un encart « Extension Radar Immo » avec un lien d'installation et le texte « Dans l'extension, ouvre le tableau de bord → Données → Se connecter ».

### 6.5 Données du compte

- **Exporter** : `GET /v1/export` renvoie `{ "settings": {…} | null, "settingsUpdatedAt": …, "listings": { "<id>": {…} } }`. Proposer le téléchargement du fichier `radar-immo-AAAA-MM-JJ.json`. Ce format est compatible avec l'import de l'extension.
- **Tout effacer** : `DELETE /v1/data` renvoie `204`. Double confirmation : « Effacer toutes tes données Radar Immo (critères et annonces) ? Elles seront aussi effacées de l'extension sur tous tes navigateurs. Cette action est définitive. »

## 7. Modèle d'une annonce

Tous les champs sont **facultatifs**, sauf `id` et `updatedAt`. Les montants sont en euros et les dates en millisecondes depuis 1970 (`new Date(ms)`).

| Champ | Type | Description |
|---|---|---|
| `id` | string | Identifiant unique, `<site>:<numéro>` |
| `url` | string | Annonce d'origine |
| `site` / `siteName` | string | `leboncoin` / `Leboncoin` |
| `title` | string | Titre de l'annonce |
| `image` | string | URL de la photo principale, hébergée par le site d'origine |
| `description` | string | Extrait de la description (4 000 caractères max) |
| `price` | number | Prix |
| `priceM2` | number | Prix au m² |
| `priceHistory` | `{price, date}[]` | Prix constatés, du plus ancien au plus récent |
| `surface` | number | m² |
| `rooms` / `bedrooms` | number | Pièces / chambres |
| `propertyType` | string | `appartement` ou `maison` |
| `dpe` / `ges` | string | `A` à `G` |
| `dpeNote` | string | Ex. « DPE vierge / non communiqué » |
| `energyCost` | `[min, max]` | Dépenses d'énergie annuelles estimées |
| `chargesMonthly` | number | Charges de copropriété par mois |
| `taxeFonciere` | number | Taxe foncière par an |
| `floor` | number | Étage (0 = RDC) |
| `elevator` | boolean | Ascenseur |
| `lots` | number | Lots de la copropriété |
| `yearBuilt` | number | Année de construction |
| `address`, `locationText`, `city`, `postalCode` | string | Localisation |
| `lat`, `lng` | number | Coordonnées |
| `zones` | string[] | Quartiers reconnus |
| `score` | number | Score sur 100 **au moment de la dernière analyse** |
| `verdict` | string | Voir 6.1 |
| `eliminated` | boolean | Touche un critère éliminatoire |
| `status` | string | Voir 6.1 |
| `saved` | boolean | Sauvegardée par l'utilisateur |
| `notes` | string | Notes libres |
| `checklist` | `{ "0": true, … }` | Voir 6.2 |
| `overrides` | object | Corrections faites par l'utilisateur dans l'extension (déjà appliquées aux champs ci-dessus) |
| `firstSeen` / `lastSeen` | number | Première et dernière consultation |
| `updatedAt` | number | Dernière modification (sert à la synchronisation) |

> **Score à jour (facultatif).** `score`, `verdict` et `eliminated` datent de la dernière consultation de l'annonce dans l'extension. Si l'utilisateur a changé ses critères depuis, ils peuvent être périmés. Pour les recalculer, le front-end peut réutiliser la logique de l'extension, [`src/lib/radar.js`](../src/lib/radar.js) : un fichier sans dépendance, chargeable comme script (il expose `globalThis.RadarImmo`) ou via `require`. On l'appelle ainsi : `RadarImmo.analyze(annonce, criteres).analysis` renvoie `{ score, verdict, tone, eliminated, checks }`.

## 8. Sécurité et affichage

- **Tout le texte d'une annonce vient de sites tiers** (titre, description, notes, adresse). Il doit être **échappé** : pas de `innerHTML`, `v-html` ni `dangerouslySetInnerHTML` sur ces champs.
- **Liens** (`url`, liens de recherche) : n'accepter que `http:` et `https:`, et ouvrir avec `target="_blank" rel="noopener noreferrer"`.
- **Images** : elles viennent des domaines des sites d'annonces. Adapter la CSP (`img-src https:`) et prévoir un repli si l'image ne charge pas.
- **Jeton** : ne jamais le journaliser ni l'envoyer à un outil de suivi (Sentry, analytics…).

## 9. Critères d'acceptation

- [ ] `RADAR_API_URL` est configurable par environnement, et le backend principal est toujours appelé comme avant.
- [ ] Chaque appel à l'API Radar Immo porte `Authorization: Bearer <jeton du backend principal>`.
- [ ] Un 401 déclenche le même parcours que pour le backend principal, sans boucle de requêtes.
- [ ] Un 503 affiche un message temporaire et ne déconnecte pas l'utilisateur.
- [ ] Une annonce sauvegardée dans l'extension apparaît dans « Mes annonces » après la synchronisation de l'extension (au plus 15 minutes, ou tout de suite via *Synchroniser maintenant*).
- [ ] Un statut, une note ou une case de checklist modifiés dans le front apparaissent dans l'extension après sa prochaine synchronisation, et inversement.
- [ ] Une annonce supprimée dans le front disparaît de l'extension, et inversement.
- [ ] Les identifiants d'annonce contenant `:` fonctionnent dans les URL (encodage).
- [ ] `/connexion-extension` refuse tout `redirect_uri` hors liste blanche, demande le consentement et place le jeton dans le fragment.
- [ ] Parcours complet validé : extension non connectée → *Se connecter* → connexion sur le front → *Autoriser* → l'extension affiche « Connecté ».
- [ ] Export JSON téléchargeable, suppression complète avec double confirmation.
- [ ] Aucun contenu d'annonce n'est injecté en HTML brut.
- [ ] Pages utilisables sur mobile (360 px de large).

## 10. Points à valider avant de démarrer

| # | Question | Avec qui |
|---|---|---|
| 1 | Le jeton du backend principal est-il lisible en JavaScript, pour pouvoir être envoyé en `Bearer` ? (voir 4.2) | Backend principal |
| 2 | Quelle durée de vie et quel type de jeton pour l'extension ? (voir 6.4) | Backend principal |
| 3 | Quelles URL d'API pour la recette et la production ? | Équipe backend Radar Immo |
| 4 | Quelles origines du front-end ajouter au CORS ? | Front-end → backend |
| 5 | Quels identifiants d'extension Chrome et Edge mettre en liste blanche ? | Équipe extension |
| 6 | Critères en lecture seule (V1) ou éditables (V2) ? | Produit |

## Annexe : essayer l'API en local

```bash
# 1. Lancer l'API (voir server/README.md), avec AUTH_VERIFY_URL pointant sur le backend principal
# 2. Récupérer un jeton valide depuis le front-end (outils de développement), puis :
TOKEN=…
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/me
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/v1/listings?saved=true"
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"visit"}' "http://localhost:3000/v1/listings/leboncoin%3A2890012345"
```
