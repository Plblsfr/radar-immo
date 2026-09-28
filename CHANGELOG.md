# Changelog

Toutes les évolutions notables de Radar Immo sont consignées ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté
- **API Radar Immo** (`server/`) : backend Node.js (Fastify) qui synchronise les critères et les annonces de chaque utilisateur. Il utilise la base PostgreSQL du backend principal, dans un schéma dédié (`radar_immo`), et délègue l'authentification au backend existant (route GET, jeton transmis en en-tête).
- **Compte et synchronisation facultatifs** dans l'extension : panneau *Données → Compte et synchronisation*, connexion via l'application web (`auth/callback.html`) ou par jeton, synchronisation en arrière-plan (après modification, toutes les 15 minutes et à la demande), où la dernière écriture gagne.
- Build : `RADAR_API_URL` et `RADAR_LOGIN_URL` intègrent les adresses du service au paquet.
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

[Non publié]: ../../compare/v1.1.0...HEAD
[1.1.0]: ../../compare/v1.0.0...v1.1.0
[1.0.0]: ../../releases/tag/v1.0.0
