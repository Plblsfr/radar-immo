-- À exécuter une fois par un administrateur de la base partagée avec le backend principal.
-- Crée un rôle dédié, propriétaire de son seul schéma. Il n'a aucun droit sur les tables du backend principal.
-- Remplace le mot de passe et le nom de la base (« app ») par les vôtres.

CREATE ROLE radar_immo LOGIN PASSWORD 'change-moi';
GRANT CONNECT ON DATABASE app TO radar_immo;
CREATE SCHEMA IF NOT EXISTS radar_immo AUTHORIZATION radar_immo;

-- Variante : si tu préfères laisser le backend créer son schéma lui-même au premier démarrage,
-- remplace la ligne CREATE SCHEMA par : GRANT CREATE ON DATABASE app TO radar_immo;
