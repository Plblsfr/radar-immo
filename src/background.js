/* Radar Immo — arrière-plan (service worker sous Chrome, page d'événements sous Firefox) */
if (typeof importScripts === 'function' && !self.RadarImmo) importScripts('lib/radar.js', 'lib/cloud.js');
const ext = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;
const TONE = { great: '#c8607f', good: '#1f7a45', meh: '#8f5f00', bad: '#a1a1aa' };
const safe = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* API absente (Firefox Android) */ } };

ext.runtime.onInstalled.addListener((details) => {
  if (ext.contextMenus) {
    safe(() => ext.contextMenus.removeAll());
    safe(() => ext.contextMenus.create({ id: 'radar-analyze', title: 'Analyser cette annonce avec Radar Immo', contexts: ['page'] }));
    safe(() => ext.contextMenus.create({ id: 'radar-dashboard', title: 'Ouvrir le tableau de bord Radar Immo', contexts: ['action'] }));
  }
  if (details.reason === 'install') ext.tabs.create({ url: ext.runtime.getURL('dashboard/dashboard.html#criteres') });
  scheduleSync();
});

async function injectAndAnalyze(tabId) {
  await ext.scripting.executeScript({ target: { tabId }, func: () => { window.__radarImmoForce = true; } });
  await ext.scripting.executeScript({ target: { tabId }, files: ['lib/radar.js', 'content/content.js'] });
}

if (ext.contextMenus && ext.contextMenus.onClicked) {
  ext.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'radar-analyze' && tab && tab.id != null) injectAndAnalyze(tab.id).catch(console.warn);
    if (info.menuItemId === 'radar-dashboard') ext.tabs.create({ url: ext.runtime.getURL('dashboard/dashboard.html') });
  });
}

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'badge' && tabId != null && ext.action && ext.action.setBadgeText) {
    if (msg.clear) safe(() => ext.action.setBadgeText({ tabId, text: '' }));
    else {
      safe(() => ext.action.setBadgeText({ tabId, text: msg.eliminated ? '✕' : String(msg.score) }));
      safe(() => ext.action.setBadgeBackgroundColor({ tabId, color: TONE[msg.tone] || '#71717a' }));
    }
  }
  if (msg.type === 'openDashboard') {
    ext.tabs.create({ url: ext.runtime.getURL('dashboard/dashboard.html') + (msg.id ? '#annonce=' + encodeURIComponent(msg.id) : '') });
  }
  if (msg.type === 'cloudSync') {
    runSync().then((r) => reply({ ok: true, result: r })).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'injectAnalyze') {
    injectAndAnalyze(msg.tabId).then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

// ─────────────────────────────── Synchronisation avec le compte (lib/cloud.js)
const Cloud = globalThis.RadarCloud;
const SYNC_ALARM = 'radar-sync';
const runSync = (opts) => (Cloud ? Cloud.sync(opts) : Promise.resolve({ skipped: true }));
const quiet = (p) => p.catch((e) => console.warn('Radar Immo : synchro impossible —', e.message));

function scheduleSync() {
  if (ext.alarms) safe(() => ext.alarms.create(SYNC_ALARM, { periodInMinutes: 15 }));
}
if (ext.alarms && ext.alarms.onAlarm) ext.alarms.onAlarm.addListener((a) => { if (a.name === SYNC_ALARM) quiet(runSync()); });
if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(() => { scheduleSync(); quiet(runSync()); });

// Pousse les modifications locales quelques secondes après la dernière écriture.
let pushTimer = null;
ext.storage.onChanged.addListener((ch, area) => {
  if (area && area !== 'local') return;
  if (!ch.listings && !ch.settings && !ch.deleted) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => quiet(runSync({ onlyIfChanges: true })), 3000);
});
