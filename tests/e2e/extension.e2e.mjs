#!/usr/bin/env node
/**
 * Test de bout en bout : charge l'extension dans Chromium et la fait tourner sur des pages
 * d'annonces simulées (les vrais sites sont interceptés, aucune requête ne part sur Internet).
 *
 *   npm run test:e2e                 → vérifications seules
 *   npm run test:e2e -- --screenshots → + captures dans docs/screenshots/
 *   CHROMIUM_PATH=/chemin/chrome npm run test:e2e   → pour utiliser un Chromium précis
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listingPage, leboncoinAd, resultsPage } from './fixtures.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ext = join(root, 'src');
const shotsDir = join(root, 'docs/screenshots');
const SHOTS = process.argv.includes('--screenshots');
if (SHOTS) mkdirSync(shotsDir, { recursive: true });

const html = (body) => ({ contentType: 'text/html; charset=utf-8', body });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ mobile }) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    // Les extensions exigent le vrai Chromium (pas le « headless shell ») : channel 'chromium'.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
    ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 860 } })
  });
  const shot = async (page, name, opts = {}) => { if (SHOTS) await page.screenshot({ path: join(shotsDir, `${mobile ? 'mobile' : 'desktop'}-${name}.png`), ...opts }); };
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = sw.url().split('/')[2];
    await wait(500);

    // Critères de démo : Villejean banni, Thabor préféré
    await sw.evaluate(async () => {
      const S = await RadarImmo.getSettings();
      S.zones.find((z) => z.name === 'Villejean').status = 'banned';
      S.zones.find((z) => z.name === 'Thabor').status = 'preferred';
      S.loan.apport = 15000;
      await RadarImmo.saveSettings(S);
    });

    await ctx.route('https://www.seloger.com/**', (r) => r.fulfill(html(listingPage)));
    await ctx.route('https://www.leboncoin.fr/**', (r) => {
      const u = r.request().url();
      if (u.includes('3011111111')) return r.fulfill(html(leboncoinAd(3011111111, 176000, 64, 3, 'c', 'Sud-Gare')));
      if (u.includes('/ad/')) return r.fulfill(html(leboncoinAd(3099999999, 172000, 55, 3, 'c', 'Thabor')));
      return r.fulfill(html(resultsPage));
    });
    for (const p of ctx.pages()) await p.close().catch(() => {});
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 1. Page d'annonce SeLoger
    await page.goto('https://www.seloger.com/annonces/achat/appartement/rennes-35/thabor/212345678.htm');
    await wait(2200);
    const scoreText = await page.evaluate(() => {
      const h = document.getElementById('radar-immo-host');
      return h && h.shadowRoot.querySelector('.score') && h.shadowRoot.querySelector('.score').textContent.trim();
    });
    assert.ok(Number(scoreText) >= 80, `score attendu ≥ 80, obtenu ${scoreText}`);
    if (mobile) {
      await shot(page, 'annonce-reduite');
      await page.evaluate(() => document.getElementById('radar-immo-host').shadowRoot.getElementById('expand').click());
      await wait(400);
    }
    await shot(page, 'annonce');

    // 2. Même bien sur Leboncoin → doublon détecté
    await page.goto('https://www.leboncoin.fr/ad/ventes_immobilieres/3099999999');
    await wait(2200);
    await page.goto('https://www.leboncoin.fr/ad/ventes_immobilieres/3011111111');
    await wait(1800);

    // 3. Page de résultats
    await page.goto('https://www.leboncoin.fr/recherche?category=9');
    await wait(2200);
    const badges = await page.$$eval('.radar-immo-badge', (b) => b.map((x) => x.textContent));
    assert.equal(badges.length, 4, 'une pastille par annonce');
    assert.ok(badges.some((t) => /Zone bannie/.test(t)), 'zone bannie signalée');
    await shot(page, 'resultats');

    // 4. Tableau de bord
    const listings = await sw.evaluate(async () => {
      const a = await RadarImmo.getListings();
      Object.values(a).forEach((l) => { l.saved = true; });
      a['seloger:212345678'].notes = 'Visite samedi 10 h avec l’agence';
      a['seloger:212345678'].status = 'visit';
      await RadarImmo.saveListings(a);
      await chrome.storage.local.set({ compare: Object.keys(a) });
      return Object.values(a);
    });
    assert.equal(listings.length, 3);
    const dup = listings.find((l) => l.id === 'seloger:212345678');
    assert.ok(RadarImmoDupCheck(dup, listings), 'doublon SeLoger / Leboncoin détecté');

    await page.goto(`chrome-extension://${extId}/dashboard/dashboard.html`);
    await wait(900);
    assert.equal(await page.$$eval('#list .card', (c) => c.length), 3);
    await shot(page, 'tableau-de-bord');
    await page.goto(`chrome-extension://${extId}/dashboard/dashboard.html#comparer`);
    await wait(600);
    await shot(page, 'comparateur', { fullPage: !mobile });
    await page.goto(`chrome-extension://${extId}/dashboard/dashboard.html#criteres`);
    await wait(600);
    await shot(page, 'criteres', { fullPage: !mobile });

    assert.deepEqual(errors, [], 'aucune erreur JavaScript dans les pages');
    console.log(`✓ e2e ${mobile ? 'mobile' : 'ordinateur'} OK`);
  } finally {
    await ctx.close();
  }
}

// Deux annonces sont-elles détectées comme le même bien ? (même logique que l'extension)
function RadarImmoDupCheck(l, all) {
  return all.some((o) => o.id !== l.id && Math.abs(o.surface - l.surface) <= 1.5 && Math.abs(o.price - l.price) / Math.min(o.price, l.price) <= 0.08);
}

await run({ mobile: false });
await run({ mobile: true });
