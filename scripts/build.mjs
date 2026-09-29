#!/usr/bin/env node
/**
 * Construit les paquets de l'extension dans dist/ — sans aucune dépendance.
 *   dist/radar-immo-<version>-chrome.zip   → Chrome / Edge / Brave (chrome://extensions)
 *   dist/radar-immo-<version>-firefox.zip  → à envoyer sur addons.mozilla.org pour signature
 * Les archives sont reproductibles (fichiers triés, dates fixes).
 *
 * Variables d'environnement facultatives (compte et synchronisation, voir lib/cloud.js) :
 *   RADAR_API_URL    adresse de l'API Radar Immo, ex. https://api.exemple.fr
 *   RADAR_LOGIN_URL  page de connexion du front-end, ex. https://app.exemple.fr/connexion-extension
 *   RADAR_REFRESH_URL route de renouvellement du jeton (reconnexion automatique), ex. https://api.exemple.fr/api/auth/extension/refresh
 *                    (restreint aussi la page de retour de connexion à cette origine)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
if (pkg.version !== manifest.version) {
  console.error(`✗ Version incohérente : package.json ${pkg.version} ≠ src/manifest.json ${manifest.version}`);
  process.exit(1);
}

const IGNORE = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /\.map$/];
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(src)
  .map((p) => relative(src, p).split(sep).join('/'))
  .filter((p) => !IGNORE.some((re) => re.test(p)))
  .sort();

// ── Écriture ZIP minimale (deflate) ──────────────────────────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00

function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── URL du service injectées au build
const service = { api: process.env.RADAR_API_URL || '', login: process.env.RADAR_LOGIN_URL || '', refresh: process.env.RADAR_REFRESH_URL || '' };
for (const [k, v] of Object.entries(service)) {
  if (v && !/^https:\/\/[^\s'"]+$/.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s'"]*)?$/.test(v)) {
    console.error(`✗ URL invalide pour ${k} : ${v} (https:// obligatoire, sauf localhost)`);
    process.exit(1);
  }
}
function transform(name, data) {
  if (name === 'lib/cloud.js') {
    let txt = data.toString('utf8');
    if (service.api) txt = txt.replace("const DEFAULT_API_URL = '';", `const DEFAULT_API_URL = ${JSON.stringify(service.api)};`);
    if (service.login) txt = txt.replace("const DEFAULT_LOGIN_URL = '';", `const DEFAULT_LOGIN_URL = ${JSON.stringify(service.login)};`);
    if (service.refresh) txt = txt.replace("const DEFAULT_REFRESH_URL = '';", `const DEFAULT_REFRESH_URL = ${JSON.stringify(service.refresh)};`);
    return Buffer.from(txt, 'utf8');
  }
  if (name === 'manifest.json' && service.login) {
    const m = JSON.parse(data.toString('utf8'));
    (m.web_accessible_resources || []).forEach((w) => { w.matches = [new URL(service.login).origin + '/*']; });
    return Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
  }
  return data;
}
if (service.api || service.login || service.refresh) console.log(`• API : ${service.api || '(non définie)'} · connexion : ${service.login || '(non définie)'} · renouvellement : ${service.refresh || '(non défini)'}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const entries = files.map((name) => ({ name, data: transform(name, readFileSync(join(src, name))) }));
const archive = zip(entries);
for (const target of ['chrome', 'firefox']) {
  const out = join(dist, `radar-immo-${pkg.version}-${target}.zip`);
  writeFileSync(out, archive);
  console.log(`✓ ${relative(root, out)}  (${files.length} fichiers, ${(archive.length / 1024).toFixed(1)} Ko)`);
}
