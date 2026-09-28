# Contribuer à Radar Immo

Merci de ton intérêt ! Ce guide explique comment proposer une modification.

## Sommaire
- [Signaler un problème](#signaler-un-problème)
- [Mettre en place l'environnement](#mettre-en-place-lenvironnement)
- [Flux de travail](#flux-de-travail)
- [Conventions](#conventions)
- [Ajouter ou corriger un site](#ajouter-ou-corriger-un-site)
- [Tests](#tests)
- [Publier une version](#publier-une-version)

## Signaler un problème

- **Un champ est mal lu** (prix, DPE, surface…) : utilise le modèle *Site mal détecté*, avec l'URL de l'annonce, la valeur lue et la valeur réelle.
- **Un bug** : utilise le modèle *Signaler un bug*.
- **Une faille de sécurité** : ne l'ouvre pas en public, suis [SECURITY.md](SECURITY.md).

## Mettre en place l'environnement

```bash
git clone <url-du-depot> && cd radar-immo
npm run check && npm test            # aucune dépendance nécessaire
```

Charge ensuite `src/` comme extension non empaquetée :
- **Chrome** : ouvre `chrome://extensions`, active le *Mode développeur*, puis clique sur *Charger l'extension non empaquetée* et choisis `src/`.
- **Firefox** : ouvre `about:debugging#/runtime/this-firefox`, puis *Charger un module temporaire* et choisis `src/manifest.json`.

Après chaque modification, recharge l'extension (↻), puis la page de l'annonce.

Pour les tests de bout en bout :
```bash
npm install
npx playwright install chromium
npm run test:e2e
```

## Flux de travail

1. Crée une branche depuis `main` : `feat/nom-court`, `fix/nom-court` ou `docs/nom-court`.
2. Fais des commits petits et ciblés.
3. Vérifie que `npm run check`, `npm test` et `npm run test:e2e` passent.
4. Ajoute une ligne dans `CHANGELOG.md`, section **[Non publié]**.
5. Ouvre une pull request en remplissant le modèle.

## Conventions

- **Aucune dépendance d'exécution, aucune étape de build** pour l'extension : le code de `src/` est publié tel quel (seules les adresses du service peuvent être injectées au build). C'est ce qui rend la relecture par Mozilla simple et rapide. Ne pas introduire de bundler, de minifieur ni de framework.
- **JavaScript moderne sans module** dans `src/` : les scripts de page ne peuvent pas être des modules ES. La logique partagée va dans `lib/radar.js`, qui expose `globalThis.RadarImmo`.
- **Compatible Chrome et Firefox** : passe par `ext` (`browser` ou `chrome`), jamais directement par `chrome.*`. Vérifie qu'une API existe sur Firefox Android avant de l'utiliser, sinon protège l'appel.
- **Sécurité de l'affichage** : tout texte venant d'une page d'annonce doit passer par `esc()` avant d'être inséré dans du HTML.
- **Style de code** : 2 espaces, point-virgules, apostrophes simples (voir `.editorconfig`).
- **Commits** au format [Conventional Commits](https://www.conventionalcommits.org/fr/) : `feat: …`, `fix: …`, `docs: …`, `test: …`, `refactor: …`, `chore: …`.
- **Interface en français**, sur un ton simple et direct, en tutoyant l'utilisateur.

## Ajouter ou corriger un site

1. **Déclarer le site** dans `SITES` (`src/lib/radar.js`) : un `id`, un `name`, une regex `host` et une regex `listing` qui reconnaît les URL d'annonce, et **pas** les pages de résultats.
2. **Autoriser le site** dans `src/manifest.json`, à la fois dans `content_scripts[0].matches` et dans `host_permissions`.
3. **Vérifier l'extraction.** Le texte générique (`extractFromText`) suffit souvent. Si le site expose des données structurées (JSON-LD, JSON embarqué), ajoute un adaptateur sur le modèle de `extractFromLeboncoin` et branche-le dans `collect()` (`src/content/content.js`).
4. **Ajouter des tests** : un test unitaire avec un extrait anonymisé du texte ou du JSON du site, et si possible une page simulée dans `tests/e2e/fixtures.mjs`.
5. **Mettre à jour** la liste des sites dans le README.

> Les pages simulées et les extraits de tests doivent être **fictifs ou anonymisés** : pas de nom, de téléphone ni d'adresse exacte de vendeur.

## Tests

| Commande | Contenu |
|---|---|
| `npm run check` | Syntaxe de tous les fichiers JS, validité du manifest, cohérence des versions (package, manifest, CHANGELOG) |
| `npm test` | Tests unitaires de `lib/radar.js` : extraction, score, finance, doublons, URLs |
| `npm run test:e2e` | Extension chargée dans Chromium (ordinateur et mobile), sur des pages simulées, sans accès réseau |
| `npm run screenshots` | Idem, et régénère `docs/screenshots/` |
| `cd server && npm test` | Tests de l'API. Avec `TEST_DATABASE_URL`, tests complets sur un vrai PostgreSQL (schéma temporaire) |

## Publier une version

1. Mets à jour la version dans `package.json` **et** `src/manifest.json` (le build refuse si elles diffèrent).
2. Dans `CHANGELOG.md`, déplace le contenu de **[Non publié]** dans une nouvelle section `## [x.y.z] - AAAA-MM-JJ` et mets à jour les liens en bas de fichier.
3. Lance `npm run build`, puis teste les zips de `dist/`.
4. Commite, crée un tag et pousse :
   ```bash
   git commit -am "chore: version x.y.z"
   git tag vx.y.z && git push --follow-tags
   ```
   La CI construit les paquets et crée la Release GitHub avec les notes du CHANGELOG.
5. **Firefox** : envoie `radar-immo-x.y.z-firefox.zip` sur le Developer Hub (même extension, *Nouvelle version*) pour obtenir le `.xpi` signé, puis ajoute-le à la Release.
