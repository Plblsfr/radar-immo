#!/usr/bin/env node
/** Vérifications rapides : syntaxe JS, manifest valide, versions cohérentes (package, manifest, CHANGELOG). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let failed = false;
const fail = (msg) => { console.error('✗ ' + msg); failed = true; };
const ok = (msg) => console.log('✓ ' + msg);

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const jsFiles = [...walk(join(root, 'src')), ...walk(join(root, 'scripts')), ...walk(join(root, 'tests'))].filter((f) => /\.(m?js)$/.test(f));
if (!/const DEFAULT_API_URL = '';/.test(readFileSync(join(root, 'src/lib/cloud.js'), 'utf8')))
  fail('src/lib/cloud.js : DEFAULT_API_URL doit rester vide dans le dépôt (injecté au build par RADAR_API_URL)');
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(`Syntaxe : ${f}\n${e.stderr}`); }
}
ok(`${jsFiles.length} fichiers JS analysés`);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8')); ok('manifest.json valide'); } catch (e) { fail('manifest.json invalide : ' + e.message); }
if (manifest && manifest.version !== pkg.version) fail(`Version : package.json ${pkg.version} ≠ manifest ${manifest.version}`);
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${pkg.version}]`)) fail(`CHANGELOG.md n'a pas d'entrée pour ${pkg.version}`);
else ok(`Version ${pkg.version} cohérente (package, manifest, CHANGELOG)`);

for (const f of ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'popup/popup.html', 'dashboard/dashboard.html', 'lib/cloud.js', 'auth/callback.html']) {
  try { statSync(join(root, 'src', f)); } catch { fail(`Fichier manquant : src/${f}`); }
}
process.exit(failed ? 1 : 0);
