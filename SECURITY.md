# Sécurité

## Versions maintenues

Seule la dernière version publiée reçoit des correctifs.

## Signaler une vulnérabilité

**N'ouvre pas d'issue publique** pour un problème de sécurité.

Utilise le signalement privé de GitHub : onglet **Security → Report a vulnerability** du dépôt. Indique :
- la version concernée et le navigateur ;
- une description du problème et de son impact ;
- les étapes pour le reproduire, si possible.

Tu recevras une première réponse sous 7 jours. Une fois le correctif publié, le signalement sera crédité dans le [CHANGELOG](CHANGELOG.md), si tu le souhaites.

## Périmètre

Sont particulièrement concernés :
- toute injection de contenu (HTML ou script) provenant d'une page d'annonce dans le panneau ou le tableau de bord ;
- toute fuite de données hors du stockage local ;
- toute permission demandée au-delà du nécessaire.
