# Changelog

Toutes les évolutions notables de Radar Immo sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

## [1.3.1] - 2026-09-29

### Modifié
- Extension : la route de renouvellement du jeton est **configurable**, car elle appartient au backend d'authentification, externe à Radar Immo. Le champ *Renouvellement du jeton* (et `RADAR_AUTH_URL` au build) accepte un domaine, qui donne le chemin par défaut `/auth/extension/refresh`, ou une URL complète. L'adresse réellement appelée s'affiche sous le champ.

### Corrigé
- Extension : le chemin par défaut de la route de renouvellement est `/auth/extension/refresh`, sans `/api`.

## [1.3.0] - 2026-09-29

### Ajouté
- **Partage public d'une annonce** : dans le détail d'une annonce du tableau de bord, *Partager* crée un lien secret (`/s/<jeton>`) que l'on peut envoyer à un proche sans compte ni extension. La page publique affiche le prix à jour, la baisse de prix, les caractéristiques, le DPE, le score et un message facultatif, avec un aperçu dans les messageries. Les notes sont incluses seulement si on le choisit. Le lien est désactivable et peut expirer (7 jours, 30 jours ou jamais).
- API : routes `/v1/shares`, `/public/shares/:token` et `/s/:token`, table `shares` (migration `002_shares.sql`), variable `SHARE_URL_PREFIX`.
- **Session expirée visible** : pastille « ! » sur l'icône de l'extension, bandeau avec *Se reconnecter* dans le popup et sur tous les onglets du tableau de bord.
- **Reconnexion automatique** : si la connexion fournit un jeton de renouvellement (`refresh_token`, `expires_in`), l'extension renouvelle son jeton avant qu'il expire, et une fois de plus quand un appel est refusé (401), puis rejoue l'appel. Route fixe : `<serveur d'authentification>/api/auth/extension/refresh`.

### Modifié
- Extension : les réglages ne demandent plus que des **domaines** (API Radar Immo, application web, serveur d'authentification). Les chemins sont fixes : `/connexion-extension` et `/api/auth/extension/refresh`. Variables de build : `RADAR_API_URL`, `RADAR_APP_URL`, `RADAR_AUTH_URL` (`RADAR_LOGIN_URL` disparaît). Un ancien réglage d'URL complète est repris pour son domaine.
- API : journaux détaillés de l'authentification déléguée (configuration au démarrage, statut, durée, redirection et extrait de réponse du backend d'authentification ; jamais le jeton).
- API : une route de vérification introuvable (404, 405) ou une redirection renvoie désormais `503 auth_unavailable` (mauvaise configuration) au lieu de `401 invalid_token`.
- API : la connexion à PostgreSQL échoue au bout de 10 s au lieu d'attendre indéfiniment.
- Extension : un jeton collé avec son préfixe `Bearer ` est accepté.
- Extension : un refus 403 de l'API n'est plus traité comme une session expirée.

## [1.2.0] - 2026-09-28

### Ajouté
- **API Radar Immo** (`server/`) : backend Node.js (Fastify) qui synchronise les critères et les annonces de chaque utilisateur. Il utilise la base PostgreSQL du backend principal, dans un schéma dédié (`radar_immo`), et délègue l'authentification au backend existant (route GET, jeton transmis en en-tête).
- **Compte et synchronisation facultatifs** dans l'extension : panneau *Données → Compte et synchronisation*, connexion via l'application web (`auth/callback.html`) ou par jeton, synchronisation en arrière-plan (après modification, toutes les 15 minutes et à la demande), où la dernière écriture gagne.
- Build : `RADAR_API_URL` et `RADAR_LOGIN_URL` intègrent les adresses du service au paquet.
- Déploiement de l'API : `server/docker-compose.yml` (labels Traefik, réseaux `web` et `db-network`) et workflow manuel *Image API*, qui pousse l'image sur ghcr.io.
- Cahier des charges de l'application web : `docs/CDC-front-end.md`.

### Modifié
- Les annonces et les critères sont datés à chaque modification, et les suppressions sont mémorisées, pour permettre la synchronisation.
- L'export JSON n'inclut plus que les critères, les annonces et la sélection du comparateur, jamais le jeton du compte.
- Nouvelle permission `alarms`, pour la synchronisation périodique.

## [1.1.0] - 2026-09-27

### Ajouté
- Prise en charge de **Firefox**, sur ordinateur et **sur Android** : un manifest unique compatible Chrome et Firefox (`background.scripts` + `service_worker`, `browser_specific_settings`).
- **Interface mobile** : le panneau d'annonce devient une feuille qui monte du bas de l'écran (réduite par défaut), la barre de résultats est compacte et le tableau de bord passe sur une colonne, avec un détail d'annonce en plein écran.
- Structure de dépôt : `src/`, tests unitaires (`node:test`), tests de bout en bout (Playwright), script de build reproductible sans dépendance, CI GitHub avec publication des paquets sur tag.
- Documentation : README, CONTRIBUTING, CONTRIBUTORS, CODE_OF_CONDUCT, SECURITY, PRIVACY.

### Modifié
- Les critères par défaut sont désormais un **exemple fictif (Rennes)** à personnaliser.
- Le lien Ouest-France Immo utilise le département du code postal saisi. Le lien Géorisques ne dépend plus d'une commune précise.
- Les appels à l'API passent par `browser` (Firefox) ou `chrome`, détecté à l'exécution.

### Corrigé
- Les fonctions absentes sur Firefox Android (menus contextuels, badge de l'icône) ne provoquent plus d'erreur.
- Le formulaire de critères ne déborde plus horizontalement sur petit écran.

## [1.0.0] - 2026-09-25

### Ajouté
- Première version de l'extension Chrome (Manifest V3).
- Analyse des pages d'annonce : extraction (données Leboncoin, JSON-LD, texte), score sur 100, critères éliminatoires, financement estimé, prix au m² comparé à une référence, liens de vérification (DVF, Géorisques, ADEME, registre des copropriétés).
- Pages de résultats : pastille de score par annonce, grisage des annonces hors critères, bouton pour les masquer.
- Détection du même bien sur plusieurs sites et historique des prix.
- Surlignage des atouts et des points de vigilance dans les descriptions.
- Tableau de bord : suivi par statut, notes, checklist de visite, comparateur, recherches enregistrées, critères, quartiers bannis ou préférés, export et import JSON / CSV.
- Prise en charge de 19 sites d'annonces.
- Interface épurée avec thème clair et sombre automatique.

[Non publié]: ../../compare/v1.3.1...HEAD
[1.3.1]: ../../compare/v1.3.0...v1.3.1
[1.3.0]: ../../compare/v1.2.0...v1.3.0
[1.2.0]: ../../compare/v1.1.0...v1.2.0
[1.1.0]: ../../compare/v1.0.0...v1.1.0
[1.0.0]: ../../releases/tag/v1.0.0
