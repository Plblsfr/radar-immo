# Politique de confidentialité

_Dernière mise à jour : 28 septembre 2026_

Radar Immo est conçu pour fonctionner **entièrement sur ton appareil**. La connexion à un compte, qui synchronise tes données, est **facultative** et désactivée tant que tu ne l'as pas activée.

## Ce que l'extension ne fait pas
- Elle ne contient **aucun traceur**, aucune statistique d'usage et aucune publicité.
- **Sans compte**, elle n'envoie **aucune donnée** à un serveur, qu'il appartienne au projet ou à un tiers, et n'effectue **aucune requête réseau de son propre chef**. Seule exception : le tableau de bord affiche la photo des annonces sauvegardées, chargée depuis le site d'origine de l'annonce, comme lors de ta visite.

## Si tu te connectes à un compte
- Tes **critères** et **les annonces enregistrées dans l'extension** (voir ci-dessous) sont envoyés à l'API Radar Immo, pour être synchronisés entre tes navigateurs et l'application web. Rien d'autre n'est envoyé : ni ton historique de navigation, ni le contenu des autres sites.
- L'extension garde un **jeton d'accès** dans son stockage local. Il n'est jamais inclus dans les exports.
- Le serveur n'associe tes données qu'à l'identifiant de ton compte. Le jeton est transmis au service d'authentification pour être vérifié, mais il n'est ni stocké ni journalisé.
- **Partage** : quand tu crées un lien de partage, l'annonce (prix, caractéristiques, photo, score, et tes notes seulement si tu le demandes) devient visible par **toute personne qui a le lien**. Les pages partagées ne sont pas indexées par les moteurs de recherche. Tu peux désactiver un lien à tout moment. Il est aussi désactivé si tu supprimes l'annonce ou si tu effaces tes données.
- *Se déconnecter* arrête la synchronisation et conserve tes données locales. *Tout effacer* supprime aussi tes données du serveur.

## Ce qui est stocké, et où
L'extension enregistre dans le stockage local de ton navigateur (`storage.local`) :
- **tes critères de recherche** : ville, budget, pièces, DPE, financement, quartiers, mots-clés ;
- **les annonces que tu consultes** sur les sites pris en charge : URL, prix, surface, caractéristiques, extrait de description, historique de prix, ainsi que tes notes, ton statut et ta checklist.

Sans compte, ces données **ne quittent jamais ton navigateur**, sauf si tu les exportes toi-même (*Données → Exporter*).

## Accès aux pages
L'extension lit le contenu des pages des sites d'annonces listés dans le manifest, uniquement pour en extraire les caractéristiques du bien. Sur un autre site, elle ne lit la page que si tu le demandes explicitement (clic droit ou popup).

## Liens externes
Les liens de vérification (DVF, Géorisques, ADEME, registre des copropriétés, OpenStreetMap) s'ouvrent seulement quand tu cliques dessus. Ces sites ont leurs propres politiques de confidentialité.

## Supprimer tes données
Dans le tableau de bord : *Données → Tout effacer*. Si tu es connecté, cela efface aussi tes données du serveur. Désinstaller l'extension supprime toutes ses données locales, mais pas celles du compte : efface-les d'abord, ou depuis l'application web.
