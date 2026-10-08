# Rapport d'essai TestApiAsCode : recréer le backend Radar Immo

Date : 2026-10-08. Compte de test : `ClaudeAssistant` (rôles viewer, author, publisher, rule-maintainer).

**Objectif :** recréer le backend existant (`server/src/app.js` + `store.js`, Fastify + PostgreSQL) sous forme de routes TestApiAsCode, sur les tables de `server/sql/schema.sql` (schéma `radar_immo` : `users`, `settings`, `listings`, `shares`, séquence `change_seq`).

**Méthode :** `get_v1_format_schema`, `post_v1_format_validate`, brouillons + `post_v1_drafts_by_id_test` (simulation annulée). Les capacités de `ctx.db` ont été sondées par des étapes `code` qui capturent chaque erreur. Rien n'a été publié.

## Verdict

L'outil fonctionne bien pour du CRUD simple sur une table (validation, trace, tests contre la vraie base, rejeu des exemples). Le backend actuel repose sur des mécanismes qu'il ne sait pas exprimer : **un numéro de version issu d'une séquence, l'upsert conditionnel, la fusion JSON en base, la pagination et les verrous**. Sans ceux-ci, `/v1/sync`, `/v1/settings` et `/v1/listings` ne peuvent pas être reproduits de façon fiable. Seules les routes de lecture simple, ainsi que `/v1/me` et `/health`, le sont.

## Bloquants (ce qui empêche de faire les routes)

### B1. Pas de valeur générée par le serveur (séquence)
`listings.version` et `settings.version` sont `NOT NULL` sans défaut et alimentés par `nextval('radar_immo.change_seq')`. Cette valeur est le curseur de la synchronisation incrémentale.
- Avec `target` + `map`, la colonne doit venir du client (`missing_required_column` sinon), et `map` rejette `nextval(...)` (`Champ d'entrée inconnu : « nextval »`).
- Avec `ctx.db.insert`, passer `"nextval('radar_immo.change_seq')"` en chaîne ou en objet `{ raw: ... }` donne `db_error` (la chaîne est traitée comme une valeur).
- Contournement possible : lire le max (`select(..., { orderBy: '-version', limit: 1 })`) puis ajouter 1. Ce n'est pas sûr en concurrence (B3), et le compteur n'est plus global.
- **Demande :** exprimer une valeur serveur (`nextval`, `now()`, `{ $sql }` ou équivalent) dans `map` et dans `ctx.db.insert/update`.

### B2. Pas d'upsert, et les erreurs SQL sont opaques
- Aucun `ON CONFLICT … DO UPDATE … WHERE`. La règle « la dernière écriture gagne » (`WHERE updated_at < EXCLUDED.updated_at`) n'est pas exprimable en une instruction.
- Toute erreur SQL (doublon de clé, clé étrangère, NOT NULL, colonne inconnue, colonne générée) remonte sous la même forme : message « Erreur de la base », `{ code: 'db_error' }`. Impossible de distinguer un doublon d'une clé étrangère pour répondre 409 ou autre.
- Hors étapes `code`, `target` convertit la clé étrangère en `409 reference_not_found`. Dans un `code`, cette information est perdue.
- **Demande :** option `onConflict` / `upsert`, et des erreurs typées (`unique_violation`, `foreign_key_violation`, `not_null_violation`) avec la colonne concernée.

### B3. Une erreur SQL attrapée empoisonne toute la transaction
Après un `try/catch` autour d'un `ctx.db.insert` en doublon, **toutes les requêtes suivantes** de la même exécution échouent avec « Erreur de la base » (transaction PostgreSQL « aborted », sans savepoint). Le code utilisateur ne peut donc pas gérer l'erreur et continuer.
- Plus généralement : pas de contrôle de transaction (`transaction`, savepoint) ni de verrou consultatif (`pg_advisory_xact_lock`). Le backend actuel sérialise les écritures d'un utilisateur par verrou pour garantir l'ordre des versions. Reproduire cela en `select` puis `insert/update` expose à des conditions de concurrence.
- **Demande :** un savepoint implicite par appel `ctx.db.*`, ou une API `ctx.db.transaction`, ou un verrou par clé.

### B4. Mises à jour par expression impossibles
`ctx.db.update(table, where, values)` n'accepte que des valeurs littérales.
- `data = data || $patch` (fusion JSONB du `PATCH /v1/listings/{id}`) : un `update` avec `data` **remplace** le JSON entier (testé : `{x:1}` a écrasé l'ancien contenu). Il faut lire, fusionner en JS, réécrire, avec le risque de concurrence.
- `updated_at = GREATEST($now, updated_at + 1)`, `views = views + 1`, `version = nextval(...)` : non exprimables.
- `update` et `delete` renvoient seulement un nombre de lignes (pas de `RETURNING`) ; pas non plus de `max()` ni de `JOIN` (utilisé par `viewShare` et `sync`).
- **Demande :** expressions dans `update` (`{ inc: 1 }`, `{ $merge: {...} }`, ou SQL paramétré), ou un `ctx.db.sql` en lecture/écriture paramétré.

### B5. Pagination et tri incomplets, avec des options ignorées en silence
Testé sur `ctx.db.select(table, where, options)` :
| Option | Résultat |
|---|---|
| `limit` | fonctionne |
| `offset`, `skip` | **ignorés sans erreur** (le résultat est inchangé) |
| `orderBy: 'col'` | fonctionne (ascendant) |
| `orderBy: '-col'` | fonctionne en décroissant (**non documenté**, découvert par essai) |
| `direction`, `dir`, `order`, `desc`, `sort`, `fields`… | **ignorés sans erreur** |
| `orderBy: [..]`, objet, `'a,b'` | erreur `Colonne invalide` |
| `columns: ['id','version']` | fonctionne |
| clé JSON (`'data->>status'`) | `Colonne invalide` |

Conséquences : `GET /v1/listings` (`limit`, `offset`, tri `updated_at DESC, id`, total) ne peut pas être reproduit. Une option inconnue silencieusement ignorée est dangereuse : le code semble marcher et renvoie un mauvais résultat.
Filtres disponibles : `eq, ne, gt, gte, lt, lte, in, like, isNull` (liste donnée par l'erreur « Opérateur inconnu »), pas de `or`/`not`.
- **Demande :** `offset`, tri multi-colonnes avec direction explicite, rejet des options inconnues, `or`.

### B6. Authentification : pas de moyen de vérifier un jeton externe
Le backend valide chaque requête en appelant `AUTH_VERIFY_URL` avec le jeton du client, puis lit l'identifiant utilisateur dans la réponse.
- Le bac à sable `code` n'a **ni `fetch`, ni `process`, ni `setTimeout`, ni `URL`, ni import dynamique** (`Not supported`). Aucun appel réseau n'est possible.
- `access` ne propose que `public`, `authenticated` ou une liste de rôles ; rien n'indique comment `authenticated` est défini ni comment `user.id` est alimenté à partir d'un jeton tiers.
- **Demande :** documenter le mécanisme d'authentification de l'outil et le raccorder à un fournisseur externe (URL de vérification, ou JWT/JWKS).

### B7. Réponse 204 impossible sur une route sans `target`
Une route sans `target` doit définir `respond.body` (`missing_body`), mais un corps avec statut 204 est refusé (`body_with_204`, y compris `body: null`). Les routes `DELETE /v1/listings/{id}`, `DELETE /v1/shares/{token}` et `DELETE /v1/data` du backend actuel répondent 204.
- **Demande :** autoriser `respond: { status: 204 }` sans corps.

## Contraintes qui forcent à changer le contrat de l'API

### C1. Clé de chemin obligatoire avec `target`
- `PUT /v1/settings` : refusé (`missing_identifier`, un PUT désigne une ligne et exige un paramètre de chemin qui en est la clé).
- `GET`/`DELETE /v1/listings/{id}` avec `target` : refusé (`not_unique`). Les paramètres de chemin doivent former toute la clé primaire `(user_id, id)`.
- La seule forme acceptée est `GET /v1/listings/{userId}/{id}` : l'identifiant utilisateur passerait dans l'URL, donc risque d'accès aux données d'un autre utilisateur si le contrôle n'est pas refait à la main.
- Contournement qui valide : route **sans `target`**, `ctx.db.select(..., { user_id: ctx.user.id, id: ctx.params.id })` dans un `code`, et `ctx.reject(404, ...)`. Cela marche, mais perd les avantages du mode déclaratif.
- **Demande :** pouvoir filtrer automatiquement sur la colonne propriétaire (`owner: user_id`) pour qu'une route par id n'expose que les lignes de l'utilisateur authentifié.

### C2. Une route `POST` avec `target` insère les colonnes que le client fournit
Sans `map`, `user_id` et `version` doivent figurer dans le corps de la requête. `$user.id` est accepté dans `map` (la validation passe), mais ce n'est écrit nulle part dans le schéma de format ; je l'ai trouvé par essai.

## Incohérences et manques de documentation

1. **Schéma de format contre validateur :** `get_v1_format_schema` impose `target` en `^[a-z_][a-z0-9_]*$` (sans point), alors que le validateur **exige** le nom qualifié `schema.table` pour tout schéma autre que `public` (sinon `La table « settings » n'existe pas dans le schéma « public »`). Le schéma publié contredit l'usage réel.
2. **Mini-langage de types non documenté :** `object` et `any` sont refusés (`unknown_type`). Le bon type, `json`, n'est connu que grâce à la suggestion d'une erreur sur `jsonb`. Aucune liste des types dans `get_v1_format_schema`.
3. **Noms de champs :** `input` impose du camelCase (`updated_at` refusé), alors que les colonnes sont en snake_case. `map` fait le lien, mais les erreurs ne l'expliquent pas.
4. **Syntaxe des expressions :** `map` (`$user.id`, noms de champs sans préfixe `input.`) et `respond.headers` (une chaîne doit être écrite `"'text/html'"` : `text/html` est lu comme une expression et donne `unknown_field`) ne sont documentés nulle part.
5. **`get_v1_data_tables`** liste bien les 4 tables et les colonnes générées (`writable: false`) mais **pas la séquence** `change_seq`, donc aucun moyen de la référencer.
6. **Avertissement trompeur :** `unused_field` est affiché pour un champ d'entrée lu uniquement dans une étape `code` (`input.scenario`, `input.since`).
7. **`ctx` :** `ctx.params`, `ctx.record` et `ctx.vars` sont des objets vides dans mes tests. La doc ne dit pas quand ils sont remplis.
8. **`get_v1_data_tables` après création des tables :** il a fallu deux appels à `post_v1_data_schema_refresh` pour voir `radar_immo` (le premier est revenu `changed: false` avec le schéma encore vide).

## Ce qui fonctionne

- Découverte des tables, clés primaires et uniques, colonnes, défauts, colonnes générées.
- `format_validate` : erreurs avec ligne, colonne, chemin et suggestion.
- Brouillons, validation, test en simulation (transaction annulée) avec trace par étape, exemples rejoués.
- Étapes `code` : `export default async function (input, ctx)`, `ctx.user` (`id`, `roles`), `ctx.params`, `ctx.db` (`select`, `count`, `insert`, `update`, `delete`), `ctx.rule`, `ctx.log`, `ctx.reject(status, code, message)`, `Date.now()`.
- Droits base déclarés par étape (`db.read` / `db.write`) et vérifiés (`La table … n'est pas accordée en lecture à cette étape`).
- Garde-fous : `update` et `delete` sans `where` refusés (`invalid_db_call`).
- Clés étrangères transformées en `409 reference_not_found` pour les routes avec `target`.
- Routes sans `target` avec `respond.body` calculé, statuts et en-têtes personnalisés (par exemple `content-type`).

## Couverture du backend actuel

| Route actuelle | Faisable ? | Remarque |
|---|---|---|
| `GET /health`, `GET /v1/me` | Oui | trivial |
| `GET /v1/export` | Oui, en `code` | sans pagination |
| `GET /v1/listings/{id}` | Oui, en `code` | pas en déclaratif (C1) |
| `GET /v1/listings` (filtre, tri, `offset`, total) | Non | B5 |
| `DELETE /v1/listings/{id}` (suppression logique avec version) | Non | B1, B4, B7 |
| `PATCH /v1/listings/{id}` (fusion JSON) | Non fiable | B1, B4 |
| `PUT /v1/settings`, `GET /v1/settings` | Non pour `PUT` | B1, B2, C1 |
| `POST /v1/sync` | Non | B1, B2, B3, B4, B5 |
| `POST/GET/DELETE /v1/shares` | Partiel | pas de `crypto` pour les jetons (B6), 204 (B7) |
| `GET /public/shares/{token}`, `GET /s/{token}` | Partiel | mise à jour atomique `views = views + 1` (B4) |
| `DELETE /v1/data` | Non | B4, B7 |
| Authentification par `AUTH_VERIFY_URL` | Non | B6 |

## Générateur de jetons : pas de source aléatoire

Les liens de partage utilisent un secret de 128 bits (`newShareToken` dans `server/src/share.js`). Le bac à sable n'a pas de `crypto`, donc seul `Math.random()` serait disponible, ce qui ne convient pas pour un secret. Alternative côté base : `DEFAULT encode(gen_random_bytes(16), 'base64')` sur `shares.token` (pgcrypto), ce qui évite l'appel en code mais impose de changer le schéma.

## Contournements côté base de données (si l'outil ne change pas)

- Un trigger `BEFORE INSERT OR UPDATE` sur `listings` et `settings` qui fait `NEW.version := nextval('radar_immo.change_seq')` règle B1 sans toucher à l'outil, puis `version` redevient facultatif côté route.
- Une fonction SQL `radar_immo.sync(...)` ou une vue qui porte la logique d'upsert/merge, appelée depuis la route. À condition que l'outil sache appeler une fonction, ce que je n'ai pas pu confirmer.

## État des essais

Deux brouillons de test existent dans l'outil : n°1 (`POST /v1/settings`) et n°2 (`POST /v1/probe`, sondes). Aucun n'est publié.
