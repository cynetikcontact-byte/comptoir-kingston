#!/usr/bin/env node
/**
 * Comptoir — Serveur API (prototype reel, executable)
 * =====================================================================
 * Le "vrai serveur" derriere la caisse, la borne et le site. Ecrit en
 * Node pur (aucune dependance a installer) pour qu'il tourne partout.
 *
 * Ce qu'il fait, pour de vrai :
 *   - catalogue produits + stock PAR BOUTIQUE (fleurs au gramme avec lots)
 *   - ventes : decrement du stock en FEFO (premier perime, premier sorti)
 *   - facturation : numerotation sequentielle + CHAINAGE PAR EMPREINTE
 *     (chaque facture porte l'empreinte de la precedente -> inalterabilite)
 *   - fidelite : credit/lecture des points via le connecteur myCred
 *   - multi-boutique : un franchise ne voit que SA boutique, l'admin voit tout
 *
 * LANCER :
 *     node comptoir-server.js
 *     (par defaut sur http://localhost:3000, mode fidelite = demo)
 *
 * MODE PRODUCTION (vrai myCred) : definir les variables d'environnement
 *     COMPTOIR_WP_URL=https://kingston-cbd.fr
 *     COMPTOIR_API_KEY=ta-cle-secrete           (la meme que dans wp-config.php)
 *     COMPTOIR_PTS_PER_EURO=1                    (ta regle de points)
 *     COMPTOIR_POINT_TYPE=mycred_default
 *
 * AUTH (prototype) : en-tete  x-comptoir-token  ->  admin-token | aix-token | marseille-token
 *
 * ENDPOINTS :
 *   GET  /api/health
 *   GET  /api/products[?boutique=aix]            (scope selon le role)
 *   GET  /api/customers/:ref                     (solde myCred)
 *   POST /api/sales   {items:[{productId,grams|qty}], customerRef?, payment}
 *   GET  /api/invoices[?boutique=aix]
 *   GET  /api/fiscal/verify                      (verifie la chaine d'empreintes)
 *   GET  /api/dashboard                          (admin = tout, franchise = sa boutique)
 *
 * PRODUCTION : remplacer le stockage en memoire par PostgreSQL + Row-Level
 * Security (isolation des boutiques au niveau base), et servir derriere HTTPS.
 * =====================================================================
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const pathmod = require('path');
const { ComptoirLoyalty } = require('./comptoir-loyalty-connector.js');
const efacture = require('./efacture.js');
const fiscal = require('./comptoir-fiscal.js'); // conformité loi anti-fraude TVA (NF525 : ISCA)

// Fichiers front-end servis par le serveur (une seule URL pour tout).
const STATIC = {
  '/': 'Comptoir-app.html', '/app': 'Comptoir-app.html', '/Comptoir-app.html': 'Comptoir-app.html',
  '/borne': 'borne-kingston.html', '/borne-kingston.html': 'borne-kingston.html',
  '/commande': 'centre-commande.html', '/centre-commande.html': 'centre-commande.html',
  '/appel': 'appel-kingston.html', '/appel-kingston.html': 'appel-kingston.html',
  '/jsqr.js': 'jsqr.js',
};
function serveStatic(res, file) {
  fs.readFile(pathmod.join(__dirname, file), function (err, data) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'content-type': (String(file).slice(-3) === '.js' ? 'application/javascript' : 'text/html') + '; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache', 'expires': '0' });
    res.end(data);
  });
}
// Photos produits enregistrees localement (dossier img/).
function serveImage(res, file) {
  file = String(file).replace(/[^a-zA-Z0-9._-]/g, '');
  fs.readFile(pathmod.join(IMG_DIR, file), function (err, data) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Image introuvable'); }
    const ext = (file.split('.').pop() || '').toLowerCase();
    const ct = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
    res.end(data);
  });
}

/* ----------------------------- Commandes (borne -> centre de commande) ---------------------------- */
let orders = [];
let orderSeq = 1;
const orderClients = []; // flux SSE connectes : { res, boutique }
function sseSend(client, event, data) {
  try { client.res.write('event: ' + event + '\n'); client.res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
}
function broadcastOrder(order, event) {
  for (const c of orderClients) { if (!c.boutique || c.boutique === order.boutiqueId) sseSend(c, event || 'order', order); }
}
// Persistance : si DATABASE_URL est defini -> PostgreSQL (db-postgres.js). Sinon -> memoire (demo).
const PG = process.env.DATABASE_URL ? require('./db-postgres.js') : null;

const PORT = Number(process.env.PORT || 3000);
// Taux de fidelite : modifiable a chaud via /api/loyalty/config et persiste sur disque (la valeur reglee dans l'app prime sur l'env).
let POINTS_PER_EURO = Number(process.env.COMPTOIR_PTS_PER_EURO || 5);

/* ----------------------------- Donnees (en memoire ; PostgreSQL en prod) ---------------------------- */
// (Le registre des boutiques/franchises est defini plus bas : objet `boutiques` indexe par id.)

// ---- Identite legale par defaut (reseau). Sert de modele pour une nouvelle boutique. ----
const SELLER_DEFAULT = {
  name: process.env.COMPTOIR_SELLER_NAME || 'KINGSTON SARL',
  siren: process.env.COMPTOIR_SELLER_SIREN || '000000000',
  vat: process.env.COMPTOIR_SELLER_VAT || 'FR00000000000',
  address: process.env.COMPTOIR_SELLER_ADDRESS || '1 cours Mirabeau',
  zip: process.env.COMPTOIR_SELLER_ZIP || '13290',
  city: process.env.COMPTOIR_SELLER_CITY || 'Aix-en-Provence',
  country: 'FR',
};

// ---- Boutiques / franchises : registre PERSISTANT. Chaque boutique est souvent une entite legale propre
//      (son SIREN, sa TVA) -> ses factures sont emises sous SA propre identite, avec sa propre numerotation.
//      Extensible a chaud via l'ecran « Franchises » (POST /api/boutiques). ----
let boutiques = {
  aix:       { id: 'aix',       label: 'KINGSTON Aix',       prefix: 'AIX',  seller: Object.assign({}, SELLER_DEFAULT) },
  marseille: { id: 'marseille', label: 'KINGSTON Marseille', prefix: 'MARS', seller: Object.assign({}, SELLER_DEFAULT, { name: 'KINGSTON Marseille', address: '', zip: '13001', city: 'Marseille' }) },
  avignon:   { id: 'avignon',   label: 'KINGSTON Avignon',   prefix: 'AVI',  seller: Object.assign({}, SELLER_DEFAULT, { name: 'KINGSTON Avignon', address: '', zip: '84000', city: 'Avignon' }) },
};
function boutiqueIds() { return Object.keys(boutiques); }

// ---- Comptes : admin reseau + UN manager par boutique. Reconstruits quand le registre change. ----
const PASS_SALT = crypto.randomBytes(16);                       // sel de process (mots de passe via variables d'env)
function hashPass(p) { return crypto.scryptSync(String(p == null ? '' : p), PASS_SALT, 32); }
// Mot de passe PERSISTE (defini depuis l'ecran Franchises) : sel propre stocke avec l'empreinte.
function makeStoredPass(p) { const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(String(p == null ? '' : p), salt, 32); return { salt: salt.toString('hex'), hash: hash.toString('hex') }; }
function verifyStoredPass(st, p) { try { const salt = Buffer.from(st.salt, 'hex'); const a = crypto.scryptSync(String(p == null ? '' : p), salt, 32); const h = Buffer.from(st.hash, 'hex'); return a.length === h.length && crypto.timingSafeEqual(a, h); } catch (e) { return false; } }
const DEFAULT_PASS = 'kingston';
let accounts = {};
const credentials = {};
let usingDefaultPass = false;
let adminCred = null;   // mot de passe admin PERSISTE (defini via /api/account/password) ; sinon COMPTOIR_PASS_ADMIN, sinon defaut
let adminEmail = '';    // e-mail de recuperation de l'admin reseau (optionnel, renseigne a la 1re connexion)
const resetCodes = {};  // { compte: { stored:{salt,hash}, exp, tries, email } } — codes de reinitialisation par e-mail (ephemeres, en memoire)
const recentSales = {}; // idempotence encaissement : { saleKey: { status, json, exp } } — evite les doublons (double-clic caisse, renvoi reseau)
function pruneRecentSales(){ const now = Date.now(); for (const k in recentSales) { if (recentSales[k].exp < now) delete recentSales[k]; } }
function genTempPass() {
  // Mot de passe temporaire lisible : sans caracteres ambigus (0/O, 1/l/I), 9 caracteres, garanti maj+min+2 chiffres.
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', ALL = U + L + D;
  const pk = (s) => s[crypto.randomInt(s.length)];
  const out = [pk(U), pk(L), pk(D), pk(D)];
  for (let i = 0; i < 5; i++) out.push(pk(ALL));
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
  return out.join('');
}
function rebuildAccounts() {
  for (const k of Object.keys(credentials)) delete credentials[k];
  accounts = { admin: { name: 'Lenny K.', role: 'admin', boutiqueId: null } };
  { const p = process.env.COMPTOIR_PASS_ADMIN;
    if (adminCred && adminCred.salt) credentials.admin = { stored: adminCred };   // mot de passe choisi dans « Mon compte » : prioritaire
    else if (p) credentials.admin = { hash: hashPass(p) };                        // sinon COMPTOIR_PASS_ADMIN (mot de passe initial d'amorçage)
    else { credentials.admin = { hash: hashPass(DEFAULT_PASS), isDefault: true }; usingDefaultPass = true; } }
  for (const id of boutiqueIds()) {
    const b = boutiques[id];
    accounts[id] = { name: 'Manager ' + (b.label || id), role: 'manager', boutiqueId: id };
    const envp = process.env['COMPTOIR_PASS_' + id.toUpperCase()];
    if (envp) credentials[id] = { hash: hashPass(envp) };
    else if (b.cred && b.cred.salt) credentials[id] = { stored: b.cred, isDefault: !!b.mustChangePw };
    else { credentials[id] = { hash: hashPass(DEFAULT_PASS), isDefault: true }; usingDefaultPass = true; }
  }
}
rebuildAccounts();
function checkPass(user, pass) {
  const c = credentials[user]; if (!c) return false;
  if (c.stored) return verifyStoredPass(c.stored, pass);
  const a = hashPass(pass); return a.length === c.hash.length && crypto.timingSafeEqual(a, c.hash);
}

// Sessions : jeton aléatoire -> { name, role, boutiqueId, exp }. Expiration 7 jours.
const sessions = {};
const SESSION_TTL = 60 * 24 * 3600 * 1000;        // 60 jours : la caisse reste connectee (renouvele a chaque usage)
// Jeton de service OPTIONNEL pour l'automatisation/intégrations (réglé par l'exploitant, jamais en dur).
const API_TOKEN = process.env.COMPTOIR_API_TOKEN || '';
function newSession(user) { const a = accounts[user]; const token = crypto.randomBytes(24).toString('hex'); sessions[token] = { name: a.name, role: a.role, boutiqueId: a.boutiqueId, exp: Date.now() + SESSION_TTL }; persist(); return token; }
function sessionUser(token) {
  if (!token) return null;
  if (API_TOKEN && token === API_TOKEN) return { name: 'Service', role: 'admin', boutiqueId: null };
  const s = sessions[token]; if (!s) return null;
  if (s.exp <= Date.now()) { delete sessions[token]; return null; }
  s.exp = Date.now() + SESSION_TTL;   // glissant : tant que la caisse sert, elle reste connectee (persiste via les ecritures normales)
  return s;
}

const catalog = [
  { id: 'p1', name: 'Super BOOF',      cat: 'Fleurs',     unit: 'g', tiers: [[2, 5], [5, 11], [10, 20], [25, 45]] },
  { id: 'p2', name: 'Super Skunk',     cat: 'Fleurs',     unit: 'g', tiers: [[2, 5], [5, 11], [10, 20], [25, 45]] },
  { id: 'p3', name: 'King #5.1',       cat: 'King',       unit: 'g', tiers: [[2, 12], [5, 28], [10, 52], [25, 120]] },
  { id: 'p4', name: 'Tyson Paper',     cat: 'Accessoire', unit: 'u', price: 2 },
  { id: 'p5', name: 'Feuille Cloudz',  cat: 'Accessoire', unit: 'u', price: 3.5 },
  { id: 'p7', name: 'Plateau Raw Gold',cat: 'Collector',  unit: 'u', price: 50 },
];

// Stock par boutique : fleurs en lots (grammes + peremption), accessoires en unites.
const stock = {
  aix: {
    p1: { lots: [{ lot: 'BOOF-2604', g: 70, exp: '2027-04' }, { lot: 'BOOF-2605', g: 50, exp: '2027-06' }] },
    p2: { lots: [{ lot: 'SKNK-2603', g: 80, exp: '2027-03' }] },
    p3: { lots: [{ lot: 'KING-2602', g: 45, exp: '2027-02' }] },
    p4: { units: 60 }, p5: { units: 40 }, p7: { units: 5 },
  },
  marseille: {
    p1: { lots: [{ lot: 'BOOF-M01', g: 120, exp: '2027-05' }] },
    p3: { lots: [{ lot: 'KING-M01', g: 90, exp: '2027-04' }] },
    p4: { units: 100 }, p7: { units: 8 },
  },
  avignon: {
    p1: { lots: [{ lot: 'BOOF-A01', g: 40, exp: '2027-03' }] },
    p4: { units: 25 },
  },
};

// Produits personnalises (ajoutes / edites / importes) : persistes et fusionnes au catalogue de base.
let customProducts = [];
// Quand true : on masque le catalogue de demonstration et on n'expose QUE les produits importes/ajoutes.
let hideBaseCatalog = false;
function allCatalog() { return hideBaseCatalog ? customProducts.slice() : catalog.concat(customProducts); }
function findProduct(id) { return allCatalog().find((p) => p.id === id); }
function ensureStock(p) {
  for (const id of boutiqueIds()) {
    if (p.boutiqueId && p.boutiqueId !== id) continue;   // produit propre a une boutique : stock seulement chez elle
    if (!stock[id]) stock[id] = {};
    if (!stock[id][p.id]) stock[id][p.id] = (p.unit === 'g') ? { lots: [] } : { units: 0 };
  }
}
const IMG_DIR = process.env.COMPTOIR_IMG_DIR || pathmod.join(__dirname, 'img');

// ---- Réassort pro (B2B) : les franchisés commandent leur stock au réseau. Prix de gros = prix public x proRate ----
let proRate = Number(process.env.COMPTOIR_PRO_RATE || 0.5);   // 0.5 = -50% du prix public (réglable par l'admin)
let stockMoves = [];        // mouvements de stock manuels (ajout/retrait) : motif OBLIGATOIRE, trace persistante
let supplyOrders = [];      // commandes de réassort (B2B)
let supplySeq = 1;

// ---- Réassort B2B branché sur le site GROSSISTE kingbase.fr : catalogue + prix de gros (tels quels) + commandes ----
const PRO_WP_URL = (process.env.COMPTOIR_PRO_URL || 'https://kingbase.fr').replace(/\/$/, '');
const PRO_WP_KEY = process.env.COMPTOIR_PRO_KEY || '';
let proProducts = [];                 // catalogue de gros importe de kingbase.fr (SEPARE du catalogue retail)
let proLots = {};                     // n0 de lot par produit de gros (defini par l'admin) -> apparait sur la facture kingbase du franchise
let lastProSync = 0, proSyncing = false;
// ---- STOCK GROSSISTE (Basecamp / kingbase.fr) : la reference est GEREE DANS KINGTOOLS par l'admin,
// visible par les franchises (quantites dispo), decrementee a chaque commande, poussee vers le site. ----
let proStock = {};        // { productId: quantite dispo chez le grossiste (u ou g selon le produit) }
let proBuyPrice = {};     // { productId: prix d'ACHAT grossiste en € } — CONFIDENTIEL : admin uniquement
let proSellPrice = {};    // { productId: prix de VENTE aux franchises en € } — override admin, prime sur le prix du site et survit aux synchros
let proStockPush = { lastOkAt: 0, lastAt: 0, lastError: '', lastCount: 0 };   // etat des envois vers kingbase (Woo REST)
const PRO_WC_KEY = process.env.COMPTOIR_PRO_WC_KEY || '';
const PRO_WC_SECRET = process.env.COMPTOIR_PRO_WC_SECRET || '';
function proPushConfigured() { return !!(PRO_WP_URL && PRO_WC_KEY && PRO_WC_SECRET); }
// Pousse les quantites ET les prix de vente KINGTOOLS (reference) vers WooCommerce kingbase.
// Produits a l'unite lies (wooId) uniquement : les produits au gramme restent suivis dans KINGTOOLS
// (Woo compte des unites, pas des grammes ; leurs prix sont geres par variations sur le site).
async function wooFetch(url, opts, ms) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms || 15000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts || {})); } finally { clearTimeout(tm); }
}
// Le prix de gros dans KINGTOOLS est le prix AFFICHE du site (Store API). Woo, lui, attend le prix
// tel que SAISI (HT ou TTC selon la config de la boutique). On mesure le rapport affiche/saisi sur le
// produit lui-meme juste avant l'envoi, pour pousser la bonne valeur quel que soit le reglage TVA.
async function wooDisplayRatio(p, auth) {
  try {
    const rs = await wooFetch(PRO_WP_URL + '/wp-json/wc/store/v1/products/' + p.wooId, null, 10000);
    if (!rs.ok) return null;
    const sj = await rs.json();
    const mu = (sj && sj.prices && sj.prices.currency_minor_unit) || 2;
    const disp = Number(sj && sj.prices && sj.prices.price) / Math.pow(10, mu);
    const rr = await wooFetch(PRO_WP_URL + '/wp-json/wc/v3/products/' + p.wooId, { headers: { 'Authorization': auth } }, 10000);
    if (!rr.ok) return null;
    const rj = await rr.json();
    const ent = Number((rj && (rj.price || rj.regular_price)) || 0);
    if (!(disp > 0) || !(ent > 0)) return null;
    const ratio = disp / ent;
    if (!(ratio > 0.5 && ratio < 2)) return null;          // valeur aberrante -> on ne pousse pas le prix
    return (Math.abs(ratio - 1) < 0.005) ? 1 : ratio;       // prix saisis TTC (cas courant) -> envoi tel quel
  } catch (e) { return null; }
}
async function pushProStockToWoo(ids) {
  proStockPush.lastAt = Date.now();
  if (!proPushConfigured()) { proStockPush.lastError = 'non configuré (ajouter COMPTOIR_PRO_WC_KEY et COMPTOIR_PRO_WC_SECRET dans Coolify)'; return { ok: false, code: 'NO_CREDS', error: proStockPush.lastError }; }
  const auth = 'Basic ' + Buffer.from(PRO_WC_KEY + ':' + PRO_WC_SECRET).toString('base64');
  const wanted = (Array.isArray(ids) && ids.length) ? ids : Object.keys(proStock).concat(Object.keys(proSellPrice));
  const seen = {};
  const targets = wanted
    .filter((id) => { if (seen[id]) return false; seen[id] = 1; return true; })
    .map((id) => proProducts.find((p) => p.id === id))
    .filter((p) => p && p.wooId != null && p.unit !== 'g' && (proStock[p.id] != null || proSellPrice[p.id] != null));
  let okCount = 0, lastErr = '';
  for (const p of targets) {
    try {
      const body = {};
      if (proStock[p.id] != null) { body.manage_stock = true; body.stock_quantity = Math.max(0, Math.floor(proStock[p.id])); }
      if (proSellPrice[p.id] != null) {
        const ratio = await wooDisplayRatio(p, auth);
        if (ratio != null) body.regular_price = String(Math.round((proSellPrice[p.id] / ratio) * 100) / 100);
      }
      if (!Object.keys(body).length) continue;
      const r = await wooFetch(PRO_WP_URL + '/wp-json/wc/v3/products/' + p.wooId, {
        method: 'PUT',
        headers: { 'Authorization': auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) okCount++;
      else { const t = await r.text().catch(() => ''); lastErr = 'HTTP ' + r.status + ' — ' + String(t).replace(/\s+/g, ' ').slice(0, 160); }
    } catch (e) { lastErr = 'réseau : ' + ((e && e.message) || e); }
  }
  proStockPush.lastCount = okCount;
  if (lastErr) proStockPush.lastError = lastErr; else { proStockPush.lastError = ''; if (targets.length) proStockPush.lastOkAt = Date.now(); }
  persist();
  return { ok: !lastErr, pushed: okCount, of: targets.length, error: lastErr || undefined };
}
function schedulePushProStock(ids) { setTimeout(() => { pushProStockToWoo(ids).catch(() => {}); }, 50); }
function findProProduct(id) { return proProducts.find((p) => p.id === id) || findProduct(id); }
async function syncProCatalog() {
  if (PG || !PRO_WP_URL) return { error: 'pas de site grossiste configure' };
  if (proSyncing) return { busy: true };
  if (typeof fetch === 'undefined') return { error: 'fetch indisponible (Node 18+ requis)' };
  proSyncing = true;
  try {
    const apiBase = PRO_WP_URL + '/wp-json/wc/store/v1/products';
    let list;
    try { const r = await fetch(apiBase + '?per_page=100'); list = await r.json(); } catch (e) { return { error: 'kingbase injoignable : ' + e.message }; }
    if (!Array.isArray(list)) return { error: 'Store API kingbase introuvable' };
    const next = [];
    for (const wp of list) {
      const name = (wp.name || '').trim(); if (!name) continue;
      try {
        const mu = (wp.prices && wp.prices.currency_minor_unit) || 2; const div = Math.pow(10, mu);
        const prod = { id: 'kb' + wp.id, wooId: wp.id, source: 'kingbase', custom: true, name: name,
          cat: (wp.categories && wp.categories[0] && wp.categories[0].name) || 'Gros',
          img: (wp.images && wp.images[0] && wp.images[0].src) || '' };
        if (wp.type === 'variable' && Array.isArray(wp.variations) && wp.variations.length) {
          // produit au gramme : prix de gros AU GRAMME, derive du plus gros conditionnement (meilleur tarif).
          let best = null;
          for (const v of wp.variations) {
            let vp; try { vp = await (await fetch(apiBase + '/' + v.id)).json(); } catch (e) { continue; }
            const grams = parseFloat(String((v.attributes || []).map((a) => a.value).join(' ')).replace(',', '.'));
            const pr = Number(vp.prices && vp.prices.price) / div;
            if (grams > 0 && isFinite(pr)) { const perG = pr / grams; if (!best || grams > best.grams) best = { grams: grams, perG: perG }; }
          }
          if (!best) continue;
          prod.unit = 'g'; prod.proPrice = Math.round(best.perG * 100) / 100;
        } else {
          prod.unit = 'u'; prod.proPrice = Math.round((Number(wp.prices && wp.prices.price) / div) * 100) / 100;
        }
        ensureStock(prod); next.push(prod);
      } catch (e) {}
    }
    if (next.length) { proProducts = next; lastProSync = Date.now(); persist(); console.log('Synchro kingbase (gros) : ' + next.length + ' produits.'); }
    return { count: next.length, at: lastProSync };
  } finally { proSyncing = false; }
}

// ---- Synchro catalogue WooCommerce (réassort « en direct ») : ajoute les nouveaux produits ET met à
// jour les prix des produits déjà liés au site. Ne touche PAS au nom, à la catégorie, ni au prix de
// gros (proPrice) fixé manuellement par l'admin. Tourne au démarrage puis toutes les heures. ----
let lastWooSync = 0, lastWooSyncInfo = null, wooSyncing = false;
async function syncWooCatalog(opts) {
  opts = opts || {};
  if (PG) return { error: 'mode PostgreSQL : synchro gérée ailleurs' };
  if (wooSyncing) return { busy: true };
  if (typeof fetch === 'undefined') return { error: 'fetch indisponible (Node 18+ requis)' };
  wooSyncing = true;
  try {
    const baseUrl = (opts.siteUrl || process.env.COMPTOIR_WP_URL || 'https://kingston-cbd.fr').replace(/\/$/, '');
    const apiBase = baseUrl + '/wp-json/wc/store/v1/products';
    const bId = opts.boutiqueId || 'aix';
    const defStock = opts.defaultStock != null ? Number(opts.defaultStock) : 200;
    let list;
    try { const r = await fetch(apiBase + '?per_page=100'); list = await r.json(); } catch (e) { return { error: 'Site injoignable : ' + e.message }; }
    if (!Array.isArray(list)) return { error: 'Réponse du site inattendue (Store API WooCommerce introuvable)' };
    const byWoo = {}, byName = {};
    customProducts.forEach((p) => { if (p.boutiqueId) return; /* les produits propres a une boutique ne sont JAMAIS fusionnes avec le site */ if (p.wooId != null) byWoo[p.wooId] = p; if (p.name) byName[p.name.toLowerCase()] = p; });
    let created = 0, updated = 0, errors = 0;
    for (const wp of list) {
      const name = (wp.name || '').trim();
      if (!name) continue;
      try {
        const mu = (wp.prices && wp.prices.currency_minor_unit) || 2;
        const div = Math.pow(10, mu);
        let unit = 'u', price = null, tiers = null;
        if (wp.type === 'variable' && Array.isArray(wp.variations) && wp.variations.length) {
          const t = [];
          for (const v of wp.variations) {
            let vp; try { vp = await (await fetch(apiBase + '/' + v.id)).json(); } catch (e) { continue; }
            const grams = parseFloat(String((v.attributes || []).map((a) => a.value).join(' ')).replace(',', '.'));
            const pr = Math.round((Number(vp.prices && vp.prices.price) / div) * 100) / 100;
            if (grams > 0 && isFinite(pr)) t.push([grams, pr]);
          }
          t.sort((a, b) => a[0] - b[0]);
          if (!t.length) continue;
          unit = 'g'; tiers = t;
        } else {
          unit = 'u'; price = Math.round((Number(wp.prices && wp.prices.price) / div) * 100) / 100;
        }
        const existing = byWoo[wp.id] || byName[name.toLowerCase()];
        if (existing) {
          existing.wooId = wp.id;                                   // lie le produit au site pour les synchros suivantes
          if (unit === 'g') { existing.unit = 'g'; existing.tiers = tiers; } else { existing.unit = 'u'; existing.price = price; }
          if (!existing.img && wp.images && wp.images[0]) existing.img = wp.images[0].src;
          updated++;
        } else {
          const prod = {
            id: 'cp' + Date.now().toString(36) + created, wooId: wp.id, source: 'woo', custom: true, name: name,
            cat: (wp.categories && wp.categories[0] && wp.categories[0].name) || 'Boutique',
            img: (wp.images && wp.images[0] && wp.images[0].src) || '',
            desc: (wp.short_description || wp.description || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
          };
          if (unit === 'g') { prod.unit = 'g'; prod.tiers = tiers; } else { prod.unit = 'u'; prod.price = price; }
          customProducts.push(prod); ensureStock(prod);
          if (defStock > 0) { if (prod.unit === 'g') stock[bId][prod.id] = { lots: [{ lot: 'SITE', g: defStock, exp: '2099-01' }] }; else stock[bId][prod.id] = { units: defStock }; }
          byName[name.toLowerCase()] = prod; byWoo[wp.id] = prod;
          created++;
        }
      } catch (e) { errors++; }
    }
    hideBaseCatalog = true;
    lastWooSync = Date.now();
    lastWooSyncInfo = { created: created, updated: updated, errors: errors, total: list.length, at: lastWooSync };
    persist();
    console.log('Synchro WooCommerce : ' + created + ' créés, ' + updated + ' mis à jour (' + list.length + ' produits site).');
    return lastWooSyncInfo;
  } finally { wooSyncing = false; }
}

// ---- Relais terminal de paiement (kingtools.fr <-> pont de la boutique <-> TPE) ----
const pontDevices = {};         // deviceId -> { code, boutiqueId, ip, tcpPort, lastSeen } (appairage initie par le pont)
const pontCmds = {};            // boutiqueId -> [ {id, amount, ref, status:'pending'|'sent'|'done', approved, ...} ]
let pontCmdSeq = 1;
function pontDeviceByCode(code) { code = String(code || '').trim().toUpperCase(); if (!code) return null; for (const k of Object.keys(pontDevices)) if (pontDevices[k].code === code) return pontDevices[k]; return null; }
function pontDeviceForBoutique(id) { let best = null; for (const k of Object.keys(pontDevices)) { const d = pontDevices[k]; if (d.boutiqueId === id && (!best || (d.lastSeen || 0) > (best.lastSeen || 0))) best = d; } return best; } // pont le plus recemment vu (= le pont vivant, pas une vieille inscription)
function pontOnline(id) { const d = pontDeviceForBoutique(id); return !!d && (Date.now() - (d.lastSeen || 0)) < 12000; }
function pontPaired(id) { return !!pontDeviceForBoutique(id); }
function genShortCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.randomBytes(6); for (let i = 0; i < 6; i++) s += a[r[i] % a.length]; return s; }
// Jeton d'installation STABLE par boutique : permet au pont de s'appairer TOUT SEUL (libre-service) sans code saisi par l'admin.
function pontTokenFor(id) { const b = boutiques[id]; if (!b) return null; if (!b.pontToken) { b.pontToken = crypto.randomBytes(18).toString('hex'); persist(); } return b.pontToken; }
function boutiqueByPontToken(tok) { tok = String(tok || '').trim(); if (!tok) return null; for (const id of boutiqueIds()) { if (boutiques[id] && boutiques[id].pontToken === tok) return id; } return null; }
// Code d'installation COURT et LISIBLE par boutique (ex: MARS-7K3). Stable (derive du jeton), sert a
// enregistrer un nouveau Raspberry sans SSH : on le tape dans l'outil Installe-Pont, le Pi le resout au demarrage.
function installCodeFor(id) {
  const b = boutiques[id]; if (!b) return null;
  const tok = pontTokenFor(id);
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I/L (confusion)
  // Prefixe = la VILLE (on saute KINGSTON/KING) pour un code parlant : MARS, AVIG, LAMB...
  const mots = String(b.label || id).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z]+/).filter(function (w) { return w && !/^king(ston)?$/i.test(w) && !/^sarl$/i.test(w); });
  let pre = (mots[0] || String(id).replace(/^kingston/i, '') || id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (pre.length < 2) pre = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PONT';
  const hex = crypto.createHash('sha256').update('kt-install|' + tok).digest('hex');
  let num = parseInt(hex.slice(0, 10), 16), suf = '';
  for (let i = 0; i < 3; i++) { suf += alpha[num % alpha.length]; num = Math.floor(num / alpha.length); }
  return pre + '-' + suf;
}
function boutiqueByInstallCode(code) {
  code = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return null;
  for (const id of boutiqueIds()) { if (installCodeFor(id) === code) return id; }
  return null;
}
// Generateur de ZIP minimal (pur Node) : sert a livrer le .command AVEC le droit "executable" (mode 0755),
// pour que macOS l'execute au double-clic apres decompression (un fichier telecharge seul n'a pas ce droit).
const CRC_TABLE = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipSingleFile(name, content, unixMode) {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
  lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const localHeader = Buffer.concat([lh, nameBuf, data]);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(((unixMode || 0o644) << 16) >>> 0, 38);   // attributs externes : permissions Unix (0755 = executable)
  ch.writeUInt32LE(0, 42);
  const central = Buffer.concat([ch, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(localHeader.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localHeader, central, eocd]);
}
// Installateur macOS PRE-REMPLI (jeton + serveur injectes) : la boutique double-clique, le pont s'installe, se lance au demarrage, detecte le terminal et s'appaire seul.
function pontInstallerScript(base, token) {
  return [
    '#!/bin/bash',
    '# KINGSTON - Installateur AUTOMATIQUE du pont de paiement (macOS).',
    '# Pre-configure pour ta boutique : il s\'appaire TOUT SEUL. Rien a saisir.',
    '# -> Double-clique ce fichier. (Si bloque : clic droit > Ouvrir.)',
    'DEST="$HOME/KINGSTON-Pont"',
    'PLIST="$HOME/Library/LaunchAgents/fr.kingtools.pont.plist"',
    'SERVER="' + base + '"',
    'TOKEN="' + token + '"',
    'echo "== KINGSTON - Installation automatique du pont de paiement =="',
    'NODE="$(command -v node || true)"',
    'if [ -z "$NODE" ]; then echo "Node.js manquant. Installe-le depuis https://nodejs.org (bouton LTS) puis relance ce fichier."; read -p "Entree pour fermer." </dev/tty 2>/dev/null || true; exit 1; fi',
    'mkdir -p "$DEST"',
    'echo "Telechargement du pont..."',
    'curl -fsSL "$SERVER/pont-paiement.js" -o "$DEST/pont-paiement.js" || { echo "Telechargement impossible (verifie internet)."; read -p "Entree pour fermer." </dev/tty 2>/dev/null || true; exit 1; }',
    'mkdir -p "$HOME/Library/LaunchAgents"',
    'cat > "$PLIST" <<PL',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>Label</key><string>fr.kingtools.pont</string>',
    '  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/pont-paiement.js</string></array>',
    '  <key>WorkingDirectory</key><string>$DEST</string>',
    '  <key>EnvironmentVariables</key><dict><key>KT_SERVER</key><string>$SERVER</string><key>KT_SETUP_TOKEN</key><string>$TOKEN</string></dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>StandardOutPath</key><string>$DEST/pont.log</string>',
    '  <key>StandardErrorPath</key><string>$DEST/pont.log</string>',
    '</dict></plist>',
    'PL',
    'launchctl unload "$PLIST" 2>/dev/null || true',
    'launchctl load -w "$PLIST" 2>/dev/null || true',
    'echo ""; echo "== TERMINE =="',
    'echo "Le pont est installe, lance, et redemarre tout seul a chaque allumage."',
    'echo "Il detecte le terminal sur le reseau et s\'appaire tout seul a ta boutique."',
    'echo "Rien d\'autre a faire. (Etat: http://localhost:3002)"',
    'sleep 2; open "http://localhost:3002" 2>/dev/null || true',
    'read -p "Appuie sur Entree pour fermer." </dev/tty 2>/dev/null || true',
    ''
  ].join('\n');
}
function proUnitInfo(p) {
  // Prix de gros : l'OVERRIDE admin (proSellPrice, regle depuis « Stock & prix grossiste ») prime sur le
  // prix synchronise depuis le site (p.proPrice). Tant que rien n'est defini -> price=null
  // (le franchise commande quand meme ses quantites ; le prix sera ajoute plus tard).
  const ov = proSellPrice[p.id];
  return { unit: p.unit === 'g' ? 'g' : 'u', step: p.unit === 'g' ? 25 : 10, price: (typeof ov === 'number' ? ov : (typeof p.proPrice === 'number' ? p.proPrice : null)) };
}

const invoices = [];
let invoiceSeq = 0;
let lastHash = 'GENESIS';

// ---- Conformité fiscale (loi anti-fraude TVA / NF525) ----
let fiscalEvents = [];               // journal des événements (JET) scellé : démarrages, clôtures, corrections...
let fiscalSeq = 0;                   // numérotation continue des événements
let lastFiscalSig = 'GENESIS';       // dernière signature -> chaînage
let clotureSeq = { Z: 0, M: 0, A: 0 }; // compteurs de clôtures (journalière / mensuelle / annuelle)
let gtPerpetuel = 0;                 // Grand Total perpétuel RESEAU : cumul TTC toutes boutiques (tableau de bord)
let gtPerpetuelAvoirs = 0;           // cumul perpétuel des avoirs RESEAU
let fiscalKey = '';                  // clé secrète de scellement HMAC, propre à l'installation

// ---- Etat fiscal PAR boutique (entites souvent distinctes : chacune son SIREN) ----
// Numerotation, Grand Total perpetuel et clotures sont INDEPENDANTS par boutique.
// La chaine d'empreintes (lastHash) reste UNIQUE pour l'installation -> inalterabilite globale prouvable.
let seqByB = {};            // { boutiqueId: dernier numero de facture de CETTE boutique }
let gtByB = {};
let royaltiesRates = {};
let royaltiesStatus = {};             // { boutiqueId: Grand Total perpetuel TTC de CETTE boutique }
let gtAvoirsByB = {};       // { boutiqueId: cumul des avoirs de CETTE boutique }
let clotureSeqByB = {};     // { boutiqueId: { Z, M, A } }
function fb(id) { if (seqByB[id] == null) seqByB[id] = 0; if (gtByB[id] == null) gtByB[id] = 0; if (gtAvoirsByB[id] == null) gtAvoirsByB[id] = 0; if (!clotureSeqByB[id]) clotureSeqByB[id] = { Z: 0, M: 0, A: 0 }; return id; }

/* ----------------------------- Identite vendeur (e-facture / e-reporting) ---------------------------- */
// Identite par defaut du reseau. CHAQUE boutique porte sa PROPRE identite (boutiques[id].seller, souvent
// un SIREN distinct) ; on retombe sur celle-ci tant qu'une boutique n'a pas renseigne la sienne.
const SELLER = SELLER_DEFAULT;
function sellerFor(boutiqueId) { const b = boutiques[boutiqueId]; return (b && b.seller) || SELLER_DEFAULT; }

// ---- Identite de l'entreprise (emetteur legal des factures) : editable depuis l'ecran Reglages. ----
let entreprise = { denomination: '', adresse: '', codePostal: '', ville: '', siret: '', tva: '', contactPrenom: '', contactNom: '', telephone: '', factureAuto: false };
function entrepriseSafe() { return { denomination: entreprise.denomination || '', adresse: entreprise.adresse || '', codePostal: entreprise.codePostal || '', ville: entreprise.ville || '', siret: entreprise.siret || '', tva: entreprise.tva || '', contactPrenom: entreprise.contactPrenom || '', contactNom: entreprise.contactNom || '', telephone: entreprise.telephone || '', factureAuto: !!entreprise.factureAuto }; }

/* ----------------------------- Persistance disque (mode memoire) ---------------------------- */
// En mode PostgreSQL la base fait foi. Sinon, factures + commandes sont conservees dans un
// fichier JSON afin de SURVIVRE au redemarrage / a l'extinction du Mac.
const DATA_FILE = process.env.COMPTOIR_DATA_FILE || pathmod.join(__dirname, 'comptoir-data.json');
// Robustesse : garantir que le dossier des données existe AU DEMARRAGE.
// Cas /app/data monté en volume (persistant) OU, si le volume n'est pas encore là,
// on le crée localement — ainsi l'écriture ne casse jamais (plus d'erreur ENOENT).
try { fs.mkdirSync(pathmod.dirname(DATA_FILE), { recursive: true }); } catch (e) { console.error('Création du dossier de données impossible :', e.message); }
let persistTimer = null;
// Sauvegarde quotidienne (rotation : on garde les 14 dernières) AVANT d'écraser le fichier.
function backupDaily() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const bdir = pathmod.join(pathmod.dirname(DATA_FILE), 'comptoir-backups');
    if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
    const bfile = pathmod.join(bdir, 'comptoir-data-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(bfile)) {
      fs.copyFileSync(DATA_FILE, bfile);
      const files = fs.readdirSync(bdir).filter((f) => /^comptoir-data-.*\.json$/.test(f)).sort();
      while (files.length > 14) { try { fs.unlinkSync(pathmod.join(bdir, files.shift())); } catch (e) {} }
    }
  } catch (e) { console.error('Sauvegarde quotidienne impossible :', e.message); }
}
function persist() {
  if (PG || persistTimer) return; // ecriture groupee (debounce ~200 ms)
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      backupDaily(); // copie de sécurité du jour avant remplacement
      // Écriture ATOMIQUE : fichier temporaire puis renommage -> jamais de fichier tronqué en cas de coupure.
      // NB : fiscalKey n'est PLUS écrite ici (stockée à part, fichier protégé).
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), pointsPerEuro: POINTS_PER_EURO, hideBaseCatalog, customProducts, stock, boutiques, invoiceSeq, lastHash, invoices, orderSeq, orders, fiscalEvents, fiscalSeq, lastFiscalSig, clotureSeq, gtPerpetuel, gtPerpetuelAvoirs, seqByB, gtByB, gtAvoirsByB, royaltiesRates, royaltiesStatus, clotureSeqByB, supplyOrders, supplySeq, stockMoves, proRate, pontDevices, sessions, proProducts, lastProSync, proLots, proStock, proBuyPrice, proSellPrice, proStockPush, entreprise, adminCred, adminEmail, backupState }), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Persistance impossible :', e.message); }
  }, 200);
}

// ---- Sauvegarde EXTERNALISEE (stockage compatible S3 : Scaleway, Cloudflare R2, Backblaze B2, AWS...) ----
// Chaque nuit (et a la demande), le fichier de donnees + la cle de scellement partent vers un stockage
// INDEPENDANT du serveur : si le VPS meurt, les ventes et factures (obligation legale) survivent.
// Configuration par variables d'environnement (Coolify) :
//   KT_BACKUP_S3_ENDPOINT  ex: s3.fr-par.scw.cloud   (http://... accepte pour les tests locaux)
//   KT_BACKUP_S3_REGION    ex: fr-par
//   KT_BACKUP_S3_BUCKET    ex: kingtools-sauvegardes
//   KT_BACKUP_S3_KEY       identifiant de la cle d'acces
//   KT_BACKUP_S3_SECRET    cle secrete
//   KT_BACKUP_S3_PREFIX    optionnel (defaut kingtools/)
const BK = {
  endpoint: (process.env.KT_BACKUP_S3_ENDPOINT || '').trim(),
  region: (process.env.KT_BACKUP_S3_REGION || 'fr-par').trim(),
  bucket: (process.env.KT_BACKUP_S3_BUCKET || '').trim(),
  key: (process.env.KT_BACKUP_S3_KEY || '').trim(),
  secret: (process.env.KT_BACKUP_S3_SECRET || '').trim(),
  prefix: (process.env.KT_BACKUP_S3_PREFIX || 'kingtools/').trim().replace(/^\/+/, '').replace(/\/?$/, '/'),
};
let backupState = { lastAt: 0, lastOkAt: 0, lastStatus: '', lastError: '', lastBytes: 0, lastKeys: [], lastTrigger: '' };
let bkRunning = false;
function bkConfigured() { return !!(BK.endpoint && BK.bucket && BK.key && BK.secret); }
function bkParseEndpoint() {
  let proto = 'https', host = BK.endpoint;
  const m = /^(https?):\/\//.exec(host); if (m) { proto = m[1]; host = host.slice(m[0].length); }
  host = host.replace(/\/+$/, '');
  let port = proto === 'https' ? 443 : 80;
  const pm = /^(.*):(\d+)$/.exec(host); if (pm) { host = pm[1]; port = Number(pm[2]); }
  return { proto, host, port, hostHeader: host + ((proto === 'https' && port !== 443) || (proto === 'http' && port !== 80) ? ':' + port : '') };
}
function bkUriEncode(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
// Signature AWS SigV4 (service s3) — implementation pure Node, en-tetes signes : host;x-amz-content-sha256;x-amz-date
function bkSign(method, encPath, hostHeader, payloadHash, now) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = 'host:' + hostHeader + '\n' + 'x-amz-content-sha256:' + payloadHash + '\n' + 'x-amz-date:' + amzDate + '\n';
  const canonicalRequest = method + '\n' + encPath + '\n' + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;
  const scope = date + '/' + BK.region + '/s3/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const hm = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
  const kSigning = hm(hm(hm(hm('AWS4' + BK.secret, date), BK.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return { amzDate, authorization: 'AWS4-HMAC-SHA256 Credential=' + BK.key + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature };
}
function bkPutObject(objectKey, body, contentType) {
  return new Promise((resolve) => {
    try {
      const ep = bkParseEndpoint();
      const encPath = ('/' + BK.bucket + '/' + objectKey).split('/').map(bkUriEncode).join('/');
      const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
      const sig = bkSign('PUT', encPath, ep.hostHeader, payloadHash, new Date());
      const mod = ep.proto === 'https' ? require('https') : require('http');
      const rq = mod.request({
        hostname: ep.host, port: ep.port, path: encPath, method: 'PUT',
        headers: {
          'Host': ep.hostHeader,
          'Content-Type': contentType,
          'Content-Length': body.length,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': sig.amzDate,
          'Authorization': sig.authorization,
        },
      }, (r) => {
        let d = ''; r.on('data', (c) => { d += c; });
        r.on('end', () => {
          if (r.statusCode >= 200 && r.statusCode < 300) resolve({ ok: true, key: objectKey });
          else resolve({ ok: false, status: r.statusCode, error: 'Stockage: HTTP ' + r.statusCode + ' — ' + String(d).replace(/\s+/g, ' ').slice(0, 240) });
        });
      });
      rq.setTimeout(25000, () => { try { rq.destroy(new Error('timeout')); } catch (e) {} });
      rq.on('error', (e) => resolve({ ok: false, error: 'Reseau stockage: ' + e.message }));
      rq.write(body); rq.end();
    } catch (e) { resolve({ ok: false, error: 'Envoi impossible: ' + e.message }); }
  });
}
// Enveloppe de sauvegarde : contenu COMPLET du fichier de donnees + cle de scellement fiscal (necessaire a une restauration).
function bkBuildEnvelope() {
  try {
    if (PG) return { ok: false, error: 'Mode PostgreSQL : la sauvegarde se gère au niveau de la base de données.' };
    if (!fs.existsSync(DATA_FILE)) return { ok: false, error: 'Aucun fichier de données à sauvegarder pour le moment.' };
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);   // valide le JSON : on ne sauvegarde jamais un fichier corrompu sans le savoir
    const env = { kingtools: 'sauvegarde', v: 1, exportedAt: new Date().toISOString(), dataFile: pathmod.basename(DATA_FILE), fiscalKey: fiscalKey || '', data: parsed };
    return { ok: true, json: JSON.stringify(env) };
  } catch (e) { return { ok: false, error: 'Lecture des données impossible : ' + e.message }; }
}
async function bkRun(trigger) {
  if (!bkConfigured()) return { ok: false, error: 'Sauvegarde externe non configurée (variables KT_BACKUP_S3_* absentes).' };
  if (bkRunning) return { ok: false, error: 'Une sauvegarde est déjà en cours.' };
  bkRunning = true;
  try {
    backupState.lastAt = Date.now(); backupState.lastTrigger = trigger;
    const env = bkBuildEnvelope();
    if (!env.ok) { backupState.lastStatus = 'erreur'; backupState.lastError = env.error; persist(); return { ok: false, error: env.error }; }
    const gz = require('zlib').gzipSync(Buffer.from(env.json, 'utf8'));
    const d = new Date();
    const keys = [BK.prefix + 'kingtools-derniere.json.gz', BK.prefix + 'kingtools-jour-' + String(d.getDate()).padStart(2, '0') + '.json.gz'];
    if (d.getDate() === 1) keys.push(BK.prefix + 'kingtools-mois-' + String(d.getMonth() + 1).padStart(2, '0') + '.json.gz');
    const done = [];
    for (const k of keys) {
      const r = await bkPutObject(k, gz, 'application/gzip');
      if (!r.ok) { backupState.lastStatus = 'erreur'; backupState.lastError = r.error; persist(); return { ok: false, error: r.error, key: k }; }
      done.push(k);
    }
    backupState.lastOkAt = Date.now(); backupState.lastStatus = 'ok'; backupState.lastError = ''; backupState.lastBytes = gz.length; backupState.lastKeys = done;
    persist();
    return { ok: true, bytes: gz.length, keys: done };
  } finally { bkRunning = false; }
}
function loadPersisted() {
  if (PG) return;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (d.adminCred && typeof d.adminCred === 'object') adminCred = d.adminCred;   // mot de passe admin persiste (avant rebuildAccounts)
    if (typeof d.adminEmail === 'string') adminEmail = d.adminEmail;               // e-mail de recuperation admin
    if (d.backupState && typeof d.backupState === 'object') backupState = Object.assign(backupState, d.backupState);   // etat de la sauvegarde externe
    if (d.proStock && typeof d.proStock === 'object') proStock = d.proStock;                 // stock grossiste (Basecamp/kingbase)
    if (d.proBuyPrice && typeof d.proBuyPrice === 'object') proBuyPrice = d.proBuyPrice;     // prix d'achat grossiste (admin)
    if (d.proSellPrice && typeof d.proSellPrice === 'object') proSellPrice = d.proSellPrice; // prix de vente aux franchises (override admin)
    if (d.proStockPush && typeof d.proStockPush === 'object') proStockPush = Object.assign(proStockPush, d.proStockPush);
    if (typeof d.pointsPerEuro === 'number') { POINTS_PER_EURO = d.pointsPerEuro; if (loyalty) loyalty.pointsPerEuro = POINTS_PER_EURO; }
    if (typeof d.hideBaseCatalog === 'boolean') hideBaseCatalog = d.hideBaseCatalog;
    if (Array.isArray(d.customProducts)) { customProducts = d.customProducts; customProducts.forEach(ensureStock); }
    if (d.stock && typeof d.stock === 'object') { for (const b in d.stock) { stock[b] = d.stock[b]; } }
    if (Array.isArray(d.invoices)) { invoices.length = 0; d.invoices.forEach((i) => invoices.push(i)); }
    if (typeof d.invoiceSeq === 'number') invoiceSeq = d.invoiceSeq;
    if (typeof d.lastHash === 'string') lastHash = d.lastHash;
    if (Array.isArray(d.orders)) orders = d.orders;
    if (typeof d.orderSeq === 'number') orderSeq = d.orderSeq;
    if (Array.isArray(d.fiscalEvents)) fiscalEvents = d.fiscalEvents;
    if (typeof d.fiscalSeq === 'number') fiscalSeq = d.fiscalSeq;
    if (typeof d.lastFiscalSig === 'string') lastFiscalSig = d.lastFiscalSig;
    if (d.clotureSeq && typeof d.clotureSeq === 'object') clotureSeq = Object.assign({ Z: 0, M: 0, A: 0 }, d.clotureSeq);
    if (typeof d.gtPerpetuel === 'number') gtPerpetuel = d.gtPerpetuel;
    if (typeof d.gtPerpetuelAvoirs === 'number') gtPerpetuelAvoirs = d.gtPerpetuelAvoirs;
    if (typeof d.fiscalKey === 'string') fiscalKey = d.fiscalKey;
    // Registre des boutiques (franchises) + identites legales + mots de passe managers.
    if (d.boutiques && typeof d.boutiques === 'object' && Object.keys(d.boutiques).length) { boutiques = d.boutiques; rebuildAccounts(); }
    for (const id of boutiqueIds()) { if (!stock[id]) stock[id] = {}; }
    // Etat fiscal PAR boutique : restaurer ; a defaut (ancien format) reconstituer depuis l'historique.
    if (d.seqByB && typeof d.seqByB === 'object') seqByB = d.seqByB;
    if (d.gtByB && typeof d.gtByB === 'object') gtByB = d.gtByB;
    if (d.gtAvoirsByB && typeof d.gtAvoirsByB === 'object') gtAvoirsByB = d.gtAvoirsByB;
    if (d.royaltiesRates && typeof d.royaltiesRates === 'object') royaltiesRates = d.royaltiesRates;
    if (d.royaltiesStatus && typeof d.royaltiesStatus === 'object') royaltiesStatus = d.royaltiesStatus;
    if (d.clotureSeqByB && typeof d.clotureSeqByB === 'object') clotureSeqByB = d.clotureSeqByB;
    if (Array.isArray(d.stockMoves)) stockMoves = d.stockMoves;
    if (Array.isArray(d.supplyOrders)) supplyOrders = d.supplyOrders;
    if (d.pontDevices && typeof d.pontDevices === 'object') Object.assign(pontDevices, d.pontDevices);
    if (d.sessions && typeof d.sessions === 'object') { const _now = Date.now(); for (const t in d.sessions) { const s = d.sessions[t]; if (s && s.exp > _now) sessions[t] = s; } } // garde les connexions actives apres un redemarrage
    if (Array.isArray(d.proProducts)) { proProducts = d.proProducts; proProducts.forEach(ensureStock); }
    if (d.proLots && typeof d.proLots === 'object') proLots = d.proLots;
    if (d.entreprise && typeof d.entreprise === 'object') Object.assign(entreprise, d.entreprise);
    if (typeof d.lastProSync === 'number') lastProSync = d.lastProSync;
    if (typeof d.supplySeq === 'number') supplySeq = d.supplySeq;
    if (typeof d.proRate === 'number') proRate = d.proRate;
    if (!d.seqByB || !d.gtByB) {                              // migration : numerotation continue + totaux par boutique
      for (const inv of invoices) {
        const id = inv.boutiqueId || 'aix'; fb(id);
        seqByB[id] += 1;
        if (inv.total >= 0) gtByB[id] = Math.round((gtByB[id] + inv.total) * 100) / 100;
        else gtAvoirsByB[id] = Math.round((gtAvoirsByB[id] + inv.total) * 100) / 100;
      }
    }
    console.log('Journal recharge depuis le disque : ' + invoices.length + ' facture(s), ' + orders.length + ' commande(s), ' + fiscalEvents.length + ' evenement(s) fiscaux.');
  } catch (e) { console.error('Lecture persistance impossible :', e.message); }
}

/* ----------------------------- Fidelite (demo ou production) ---------------------------- */
function makeDemoLoyalty() {
  const store = { 'lenny@kingston-cbd.fr': 240, 'sarah@kingston-cbd.fr': 90 };
  const seen = new Set();
  const fakeFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/balance')) {
      const user = u.searchParams.get('user');
      if (!(user in store)) return { ok: false, status: 404, json: async () => ({ message: 'Client introuvable' }) };
      return { ok: true, status: 200, json: async () => ({ user_id: 7, email: user, name: user, points: store[user], type: 'mycred_default' }) };
    }
    if (u.pathname.endsWith('/adjust')) {
      const b = JSON.parse(opts.body);
      if (b.ref && seen.has(b.ref)) return { ok: true, status: 200, json: async () => ({ points: store[b.user], duplicate: true }) };
      if (b.ref) seen.add(b.ref);
      store[b.user] = (store[b.user] || 0) + b.amount;
      return { ok: true, status: 200, json: async () => ({ points: store[b.user], adjusted: b.amount }) };
    }
    if (u.pathname.endsWith('/customers')) {
      const s = (u.searchParams.get('search') || '').toLowerCase();
      const names = { 'lenny@kingston-cbd.fr': 'Lenny K.', 'sarah@kingston-cbd.fr': 'Sarah M.' };
      let list = Object.keys(store).map((email, i) => ({ user_id: i + 1, name: names[email] || email, email, phone: '', points: store[email] }));
      if (s) list = list.filter((c) => c.email.toLowerCase().includes(s) || c.name.toLowerCase().includes(s));
      return { ok: true, status: 200, json: async () => ({ type: 'mycred_default', total: list.length, count: list.length, customers: list }) };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'route inconnue' }) };
  };
  return new ComptoirLoyalty({ baseUrl: 'https://demo.local', apiKey: 'demo', pointsPerEuro: POINTS_PER_EURO, fetchImpl: fakeFetch });
}

let loyalty, LOYALTY_MODE;
if (process.env.COMPTOIR_WP_URL && process.env.COMPTOIR_API_KEY) {
  loyalty = new ComptoirLoyalty({
    baseUrl: process.env.COMPTOIR_WP_URL,
    apiKey: process.env.COMPTOIR_API_KEY,
    pointType: process.env.COMPTOIR_POINT_TYPE || 'mycred_default',
    pointsPerEuro: POINTS_PER_EURO,
  });
  LOYALTY_MODE = 'production (myCred reel)';
} else {
  loyalty = makeDemoLoyalty();
  LOYALTY_MODE = 'demo (faux myCred local)';
}

// Connecteur GROSSISTE (kingbase.fr) : cree les commandes de reassort dans WooCommerce de kingbase.fr.
// Necessite COMPTOIR_PRO_KEY (cle du plugin connecteur installe sur kingbase.fr). Le catalogue, lui,
// se synchronise sans cle (Store API publique).
let proConnector = null;
if (PRO_WP_URL && PRO_WP_KEY && typeof fetch !== 'undefined') {
  try { proConnector = new ComptoirLoyalty({ baseUrl: PRO_WP_URL, apiKey: PRO_WP_KEY, fetchImpl: fetch }); } catch (e) { proConnector = null; }
}

/* ----------------------------- Helpers fiscaux ---------------------------- */
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function invoiceBody(f) { return JSON.stringify([f.seq, f.num, f.boutiqueId, f.total, f.lines, f.client, f.payment, f.date, f.prevHash]); }
// Sceau HMAC-SHA256 d'un ticket (clé secrète) : empêche de recalculer la chaîne après altération.
function sealInvoice(body, hash) { return fiscalKey ? crypto.createHmac('sha256', fiscalKey).update(body + '|' + hash).digest('hex') : null; }

function createInvoice(boutiqueId, total, lines, client, payment, source) {
  fb(boutiqueId);
  const seq = ++seqByB[boutiqueId];                         // numerotation PROPRE a la boutique (entite)
  const b = boutiques[boutiqueId];
  const prefix = (b && b.prefix) || String(boutiqueId || 'KING').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'KING';
  const num = prefix + '-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
  const date = new Date().toISOString();
  const fields = { seq, num, boutiqueId, total, lines, client, payment, date, prevHash: lastHash };
  const body = invoiceBody(fields);
  const hash = sha256(body);
  // Identite legale FIGEE sur la facture (entite emettrice). 'source'/'seal' = metadonnees hors empreinte.
  const sl = sellerFor(boutiqueId);
  const inv = Object.assign({}, fields, { hash, seal: sealInvoice(body, hash), source: source || 'caisse',
    seller: { name: sl.name, siren: sl.siren, vat: sl.vat, address: sl.address, zip: sl.zip, city: sl.city, country: sl.country },
    emetteur: entrepriseSafe() });   // identite legale de l'entreprise FIGEE a l'emission (pour les factures)
  invoices.push(inv);
  lastHash = hash;                                          // chaine d'empreintes UNIQUE (inalterabilite globale)
  // Grand Total perpetuel : PAR boutique (entite) ET reseau (tableau de bord). Jamais remis a zero.
  if (total >= 0) { gtByB[boutiqueId] = Math.round((gtByB[boutiqueId] + total) * 100) / 100; gtPerpetuel = Math.round((gtPerpetuel + total) * 100) / 100; }
  else { gtAvoirsByB[boutiqueId] = Math.round((gtAvoirsByB[boutiqueId] + total) * 100) / 100; gtPerpetuelAvoirs = Math.round((gtPerpetuelAvoirs + total) * 100) / 100; }
  persist();
  return inv;
}

/* ---------------------- Journal des événements (JET) ---------------------- */
// Enregistre un événement fiscal SCELLE et CHAINE (inaltérabilité + sécurisation).
function logFiscalEvent(type, boutiqueId, data) {
  const seq = ++fiscalSeq;
  const date = new Date().toISOString();
  const e = { seq: seq, type: type, boutiqueId: boutiqueId || null, date: date, data: data || {}, prevSig: lastFiscalSig };
  e.sig = fiscal.sealEvent(e, fiscalKey);
  fiscalEvents.push(e);
  lastFiscalSig = e.sig;
  persist();
  return e;
}

// Sélectionne les factures d'une période de clôture pour une boutique.
//  - Z : depuis la dernière clôture Z de la boutique (exclu) jusqu'à maintenant ;
//  - M : du 1er du mois courant à maintenant ; A : du 1er janvier à maintenant.
function facturesPourCloture(type, bId, nowIso) {
  const now = nowIso || new Date().toISOString();
  let depuis = null;
  if (type === 'Z') {
    const lastZ = fiscalEvents.filter((e) => e.type === 'CLOTURE_Z' && e.boutiqueId === bId).sort((a, b) => a.seq - b.seq).pop();
    depuis = lastZ ? lastZ.data.jusqua : null; // borne basse exclusive
  } else if (type === 'M') {
    depuis = now.slice(0, 7) + '-01T00:00:00.000Z';
  } else if (type === 'A') {
    depuis = now.slice(0, 4) + '-01-01T00:00:00.000Z';
  }
  const list = invoices.filter((i) => i.boutiqueId === bId)
    .filter((i) => (depuis ? i.date > depuis : true))
    .filter((i) => i.date <= now);
  return { factures: list, depuis: depuis, jusqua: now };
}

// Réalise une clôture (Z/M/A) : agrège, capture le GT perpétuel, scelle dans le JET.
function faireCloture(type, bId) {
  fb(bId);
  const sel = facturesPourCloture(type, bId);
  const agg = fiscal.aggregate(sel.factures);
  const numero = ++clotureSeqByB[bId][type];               // compteur de cloture PROPRE a la boutique
  const data = Object.assign({
    numero: numero,
    periode: type === 'Z' ? 'journalière' : (type === 'M' ? 'mensuelle' : 'annuelle'),
    depuis: sel.depuis, jusqua: sel.jusqua,
    grandTotalPerpetuel: gtByB[bId],                        // Grand Total perpetuel de CETTE boutique (entite)
    grandTotalAvoirsPerpetuel: gtAvoirsByB[bId],
  }, agg);
  return logFiscalEvent('CLOTURE_' + type, bId, data);
}

function verifyChain() {
  let prev = 'GENESIS', chainOk = true, brokenAt = null;
  // La chaine d'empreintes est UNIQUE pour l'installation : chaque facture est scellee
  // avec l'empreinte de la precedente, dans l'ordre de CREATION (lastHash global).
  // 'seq' est la numerotation PROPRE a chaque boutique (entite) -> il y a donc plusieurs
  // factures avec le meme seq (une par boutique). On NE doit PAS trier par seq : cela
  // melangerait l'ordre reel de la chaine. Le tableau 'invoices' est append-only et
  // conserve l'ordre de creation (persistance incluse) -> c'est l'ordre canonique.
  for (const inv of invoices) {
    const body = invoiceBody(inv);
    const recomputed = sha256(body);
    // Sceau HMAC : si présent, il doit correspondre (détecte une altération même si les empreintes ont été recalculées).
    let sealOk = true;
    if (inv.seal != null && fiscalKey) { sealOk = (crypto.createHmac('sha256', fiscalKey).update(body + '|' + inv.hash).digest('hex') === inv.seal); }
    if (inv.prevHash !== prev || recomputed !== inv.hash || !sealOk) { chainOk = false; brokenAt = inv.num; break; }
    prev = inv.hash;
  }
  return { chainOk, invoices: invoices.length, brokenAt };
}

/* ----------------------------- Helpers stock ---------------------------- */
function totalGrams(s) { return s && s.lots ? s.lots.reduce((a, l) => a + l.g, 0) : 0; }

function decrementFEFO(boutiqueId, productId, grams) {
  const s = (stock[boutiqueId] || {})[productId];
  if (!s || !s.lots) throw new Error('Produit non disponible dans cette boutique');
  if (totalGrams(s) < grams) throw new Error('Stock insuffisant pour ' + productId);
  s.lots.sort((a, b) => (a.exp > b.exp ? 1 : -1)); // FEFO : on ecoule d'abord le lot qui perime le plus tot
  let g = grams;
  for (const lot of s.lots) { const take = Math.min(lot.g, g); lot.g -= take; g -= take; }
  s.lots = s.lots.filter((l) => l.g > 0);
}

function decrementUnits(boutiqueId, productId, qty) {
  const s = (stock[boutiqueId] || {})[productId];
  if (!s || typeof s.units !== 'number') throw new Error('Produit non disponible dans cette boutique');
  if (s.units < qty) throw new Error('Stock insuffisant pour ' + productId);
  s.units -= qty;
}

/* ----------------------------- Serveur HTTP ---------------------------- */
// CORS restreint : on n'autorise que les origines locales (l'app et la borne sont servies
// par ce serveur, en localhost). Une origine externe ne reçoit AUCUN en-tête CORS -> bloquée.
const COMMON_CORS = {
  'access-control-allow-headers': 'content-type, x-comptoir-token',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};
function corsFor(req) {
  const o = (req && req.headers && req.headers.origin) || '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const extra = process.env.COMPTOIR_ALLOWED_ORIGIN || '';
  const h = Object.assign({}, COMMON_CORS);
  if (o && (local || (extra && o === extra))) h['access-control-allow-origin'] = o;
  else if (!o) h['access-control-allow-origin'] = '*'; // appel sans origine (curl, app native) -> toléré
  return h;
}
function send(res, status, obj) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, res._cors || COMMON_CORS));
  res.end(JSON.stringify(obj, null, 2));
}
/* --------------------------- Securite HTTP ---------------------------- */
// En-tetes de securite poses sur TOUTES les reponses.
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};
function applySecurityHeaders(req, res) {
  for (const k in SEC_HEADERS) res.setHeader(k, SEC_HEADERS[k]);
  // HSTS seulement derriere HTTPS (Coolify/Traefik pose x-forwarded-proto=https)
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// --- Anti-bruteforce sur /api/login (en memoire, par IP) ---
const loginAttempts = new Map();
const LOGIN_MAX = 8;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_BLOCK = 15 * 60 * 1000;
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function loginThrottle(req) {
  const ip = clientIp(req), now = Date.now();
  const e = loginAttempts.get(ip);
  if (e && e.blockedUntil > now) return { blocked: true, ip, retry: Math.ceil((e.blockedUntil - now) / 1000) };
  return { blocked: false, ip };
}
function loginFail(ip) {
  const now = Date.now();
  let e = loginAttempts.get(ip);
  if (!e || (now - e.first) > LOGIN_WINDOW) e = { count: 0, first: now, blockedUntil: 0 };
  e.count++;
  if (e.count >= LOGIN_MAX) e.blockedUntil = now + LOGIN_BLOCK;
  loginAttempts.set(ip, e);
}
function loginOk(ip) { loginAttempts.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) {
    if (e.blockedUntil < now && (now - e.first) > LOGIN_WINDOW) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

// TVA : taux par produit (defaut 20%). Les prix affiches sont TTC.
function vatRate(p) { return typeof p.vat === 'number' ? p.vat : 0.20; }
function computeTva(lines, brut, remise) {
  const byRate = {};
  lines.forEach((l) => { const share = brut > 0 ? l.prix / brut : 0; const ttc = l.prix - remise * share; byRate[l.vat] = (byRate[l.vat] || 0) + ttc; });
  const ventilation = Object.keys(byRate).map((r) => {
    const rate = Number(r); const ttc = Math.round(byRate[r] * 100) / 100;
    const ht = Math.round((ttc / (1 + rate)) * 100) / 100; const tva = Math.round((ttc - ht) * 100) / 100;
    return { taux: Math.round(rate * 100) + '%', baseHT: ht, tva: tva, ttc: ttc };
  });
  const totalHT = Math.round(ventilation.reduce((a, v) => a + v.baseHT, 0) * 100) / 100;
  const totalTVA = Math.round(ventilation.reduce((a, v) => a + v.tva, 0) * 100) / 100;
  return { ventilation: ventilation, totalHT: totalHT, totalTVA: totalTVA };
}

/* --------------------------- Email facture (Brevo) ---------------------------- */
const MAIL_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.COMPTOIR_MAIL_FROM || '';
const MAIL_FROM_NAME = process.env.COMPTOIR_MAIL_FROM_NAME || 'KINGSTON';
function ktValidEmail(e){ e = String(e||''); var at=e.indexOf('@'); var dot=e.lastIndexOf('.'); return at>0 && dot>at+1 && dot<e.length-1 && e.indexOf(' ')<0; }
function invoiceEmailHtml(inv) {
  var sl = inv.seller || sellerFor(inv.boutiqueId);
  var E = function(x){ return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var M = function(n){ return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €'; };
  var dt = new Date(inv.date);
  var rows = (inv.lines || []).map(function(l){ return '<tr><td style="padding:6px 0;border-bottom:1px solid #eee">' + E(l.produit || l.name || 'Article') + (l.detail ? '<br><span style="color:#888;font-size:12px">' + E(l.detail) + '</span>' : '') + '</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:center;color:#555">' + (l.grams ? E(l.grams) + ' g' : (l.qty || 1)) + '</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">' + M(l.prix != null ? l.prix : l.price) + '</td></tr>'; }).join('');
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">'
    + '<div style="background:#161310;color:#e6c884;padding:20px 24px;border-radius:14px 14px 0 0"><div style="font-size:22px;font-weight:800;letter-spacing:.12em">KINGSTON</div><div style="color:#cdbf9f;font-size:12px;margin-top:2px">' + E(sl.name || 'KINGSTON') + (sl.city ? ' · ' + E(sl.city) : '') + '</div></div>'
    + '<div style="border:1px solid #ece7df;border-top:none;border-radius:0 0 14px 14px;padding:22px 24px">'
    + '<p style="margin:0 0 4px;font-size:15px">Bonjour,</p><p style="margin:0 0 16px;color:#555;font-size:14px">Voici votre facture pour votre achat chez KINGSTON. Merci de votre visite !</p>'
    + '<div style="font-size:13px;color:#777;margin-bottom:6px">Facture <b style="color:#1a1a1a">' + E(inv.num) + '</b> · ' + dt.toLocaleDateString('fr-FR') + ' ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 4px">' + rows + '</table>'
    + (inv.remise ? '<div style="display:flex;justify-content:space-between;font-size:13px;color:#555;margin:6px 0"><span>Remise fidélité</span><span>-' + M(inv.remise) + '</span></div>' : '')
    + '<div style="display:flex;justify-content:space-between;font-weight:800;font-size:18px;margin-top:10px;padding-top:10px;border-top:2px solid #161310"><span>Total</span><span>' + M(inv.total) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;font-size:13px;color:#555;margin-top:4px"><span>Règlement</span><span>' + E(inv.payment || 'Carte') + '</span></div>'
    + '<div style="margin-top:18px;font-size:11px;color:#999">'
    + (sl.siren && sl.siren !== '000000000' ? 'SIREN ' + E(sl.siren) : '') + (sl.vat && sl.vat !== 'FR00000000000' ? ' · TVA ' + E(sl.vat) : '')
    + '<br>Caisse certifiée NF525 — données inaltérables.' + (inv.seal ? '<br>Sceau : ' + E(String(inv.seal).slice(0, 24)) + '…' : '') + '</div>'
    + '</div></div>';
}
function sendInvoiceEmail(toEmail, inv) {
  return new Promise(function (resolve) {
    if (!MAIL_KEY) return resolve({ ok: false, code: 'NO_KEY', error: 'Service email non configuré (BREVO_API_KEY manquante dans Coolify).' });
    if (!MAIL_FROM) return resolve({ ok: false, code: 'NO_FROM', error: 'Expediteur non configuré (COMPTOIR_MAIL_FROM manquant dans Coolify).' });
    var https = require('https');
    var payload = JSON.stringify({ sender: { name: MAIL_FROM_NAME, email: MAIL_FROM }, to: [{ email: toEmail }], subject: 'Votre facture KINGSTON ' + (inv.num || ''), htmlContent: invoiceEmailHtml(inv) });
    var rq = https.request({ hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST', headers: { 'api-key': MAIL_KEY, 'content-type': 'application/json', 'accept': 'application/json', 'content-length': Buffer.byteLength(payload) } }, function (r) {
      var d = ''; r.on('data', function(c){ d += c; }); r.on('end', function () { if (r.statusCode >= 200 && r.statusCode < 300) resolve({ ok: true }); else { var msg = ''; try { msg = JSON.parse(d).message || d; } catch (e) { msg = d; } resolve({ ok: false, code: 'PROVIDER', status: r.statusCode, error: 'Brevo: ' + String(msg).slice(0, 160) }); } });
    });
    rq.on('error', function (e) { resolve({ ok: false, code: 'NET', error: 'Erreur reseau email: ' + e.message }); });
    rq.write(payload); rq.end();
  });
}

/* ---- Reinitialisation de mot de passe par e-mail (reutilise Brevo) ---- */
function maskEmail(e){ e=String(e||''); var at=e.indexOf('@'); if(at<1) return '***'; var u=e.slice(0,at), d=e.slice(at+1); var mu=(u.length<=2)?(u[0]+'*'):(u.slice(0,2)+'***'); var dot=d.lastIndexOf('.'); var md=(dot>0)?(d[0]+'***'+d.slice(dot)):(d[0]+'***'); return mu+'@'+md; }
function resolveAccountByIdent(ident){
  ident = String(ident || '').trim().toLowerCase(); if (!ident) return null;
  if (ident === 'admin') return { uname: 'admin', email: adminEmail };
  if (boutiques[ident]) return { uname: ident, email: boutiques[ident].email || '' };
  for (const id of boutiqueIds()) { const b = boutiques[id]; if (b.email && String(b.email).toLowerCase() === ident) return { uname: id, email: b.email }; }
  if (adminEmail && adminEmail.toLowerCase() === ident) return { uname: 'admin', email: adminEmail };
  return null;
}
function sendMail(toEmail, subject, htmlContent) {
  return new Promise(function (resolve) {
    if (!MAIL_KEY) return resolve({ ok: false, code: 'NO_KEY', error: 'Service email non configuré (BREVO_API_KEY manquante dans Coolify).' });
    if (!MAIL_FROM) return resolve({ ok: false, code: 'NO_FROM', error: 'Expediteur non configuré (COMPTOIR_MAIL_FROM manquant dans Coolify).' });
    var https = require('https');
    var payload = JSON.stringify({ sender: { name: MAIL_FROM_NAME, email: MAIL_FROM }, to: [{ email: toEmail }], subject: subject, htmlContent: htmlContent });
    var rq = https.request({ hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST', headers: { 'api-key': MAIL_KEY, 'content-type': 'application/json', 'accept': 'application/json', 'content-length': Buffer.byteLength(payload) } }, function (r) {
      var d = ''; r.on('data', function (c) { d += c; }); r.on('end', function () { if (r.statusCode >= 200 && r.statusCode < 300) resolve({ ok: true }); else { var msg = ''; try { msg = JSON.parse(d).message || d; } catch (e) { msg = d; } resolve({ ok: false, code: 'PROVIDER', status: r.statusCode, error: 'Brevo: ' + String(msg).slice(0, 160) }); } });
    });
    rq.on('error', function (e) { resolve({ ok: false, code: 'NET', error: 'Erreur reseau email: ' + e.message }); });
    rq.write(payload); rq.end();
  });
}
function resetEmailHtml(code, who) {
  var E = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">'
    + '<div style="background:#161310;color:#e6c884;padding:20px 24px;border-radius:14px 14px 0 0"><div style="font-size:22px;font-weight:800;letter-spacing:.12em">KINGSTON</div><div style="color:#cdbf9f;font-size:12px;margin-top:2px">KINGTOOLS · Comptoir</div></div>'
    + '<div style="border:1px solid #ece7df;border-top:none;border-radius:0 0 14px 14px;padding:22px 24px">'
    + '<p style="margin:0 0 12px;font-size:15px">Bonjour,</p>'
    + '<p style="margin:0 0 8px;color:#555;font-size:14px">Voici le code pour réinitialiser le mot de passe de votre accès KINGTOOLS (' + E(who) + ') :</p>'
    + '<div style="text-align:center;margin:18px 0"><span style="display:inline-block;background:#f6f1e7;border:1px solid #e6c884;border-radius:12px;padding:14px 22px;font-size:30px;font-weight:800;letter-spacing:10px;color:#161310">' + E(code) + '</span></div>'
    + '<p style="margin:0 0 4px;color:#777;font-size:12.5px">Ce code est valable 15 minutes. Saisissez-le dans KINGTOOLS puis choisissez votre nouveau mot de passe.</p>'
    + '<p style="margin:8px 0 0;color:#999;font-size:12px">Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.</p>'
    + '</div></div>';
}
function royaltiesRateFor(boutiqueId){ var r=royaltiesRates[boutiqueId]; return (typeof r==='number')?r:6; }
function royaltiesRec(ym, boutiqueId){ var m=royaltiesStatus[ym]||{}; return m[boutiqueId]||{status:'a_payer',declaredAt:null,validatedAt:null}; }
function royaltiesSetStatus(ym, boutiqueId, patch){ if(!royaltiesStatus[ym]) royaltiesStatus[ym]={}; var cur=royaltiesStatus[ym][boutiqueId]||{status:'a_payer',declaredAt:null,validatedAt:null}; royaltiesStatus[ym][boutiqueId]=Object.assign({},cur,patch); persist(); }
function royaltiesCaHT(boutiqueId, ym){ var sum=0; invoices.forEach(function(inv){ if(inv.boutiqueId!==boutiqueId) return; if((inv.total||0)<0 || inv.avoirDe) return; var d=new Date(inv.date); var k=d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2); if(k!==ym) return; var ht=(inv.tva && typeof inv.tva.totalHT==='number')?inv.tva.totalHT:((inv.total||0)/1.2); sum+=ht; }); return Math.round(sum*100)/100; }

const server = http.createServer(async (req, res) => {
  res._cors = corsFor(req);
  applySecurityHeaders(req, res);
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, res._cors); return res.end(); }

  // Front-end (app + borne) servi en statique
  if (req.method === 'GET' && STATIC[path]) return serveStatic(res, STATIC[path]);
  // Photos produits
  if (req.method === 'GET' && path.indexOf('/img/') === 0) return serveImage(res, path.slice(5));

  if (path === '/api/health') {
    return send(res, 200, { ok: true, service: 'Comptoir API', fidelite: LOYALTY_MODE, factures: invoices.length });
  }

  // --- Commandes : routes publiques (borne + ecran centre de commande sur le reseau local).
  // En prod, proteger par un jeton de borne/ecran ; ici, scope par boutique.
  // Ticket / reçu client : page imprimable (rouleau 80 mm). Public — la borne l'affiche après la commande.
  if (req.method === 'GET' && path === '/api/receipt') {
    const num = u.searchParams.get('facture') || '';
    const inv = invoices.find((i) => i.num === num);
    if (!inv) { res.writeHead(404, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, res._cors || COMMON_CORS)); return res.end('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:20px">Ticket introuvable.</p>'); }
    const sl = inv.seller || sellerFor(inv.boutiqueId);
    const E = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const M = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';
    const dt = new Date(inv.date);
    const lignes = (inv.lines || []).map((l) => '<tr><td>' + E(l.produit || l.name || 'Article') + (l.detail ? '<br><span class="d">' + E(l.detail) + '</span>' : '') + '</td><td class="q">' + (l.qty || 1) + '</td><td class="p">' + M(l.prix != null ? l.prix : l.price) + '</td></tr>').join('');
    const tva = inv.tva || null;
    const ht = tva && typeof tva.totalHT === 'number' ? '<div class="rowt"><span>Total HT</span><span>' + M(tva.totalHT) + '</span></div>' : '';
    const tvaRows = tva && tva.parTaux ? Object.keys(tva.parTaux).map((t) => '<div class="rowt"><span>dont TVA ' + Math.round(Number(t) * 100) + '%</span><span>' + M(tva.parTaux[t].tva) + '</span></div>').join('') : '';
    const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket ' + E(inv.num) + '</title>'
      + '<style>@page{size:80mm auto;margin:0}body{font-family:ui-monospace,Menlo,Consolas,monospace;color:#111;margin:0 auto;padding:14px;max-width:330px}'
      + 'h1{font-family:Arial,sans-serif;font-size:21px;letter-spacing:.16em;text-align:center;margin:0 0 2px}.c{text-align:center}.muted{color:#555;font-size:11px}'
      + 'table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px}td{padding:3px 0;vertical-align:top}.q{text-align:center;width:30px}.p{text-align:right;white-space:nowrap}.d{color:#666;font-size:11px}'
      + 'hr{border:0;border-top:1px dashed #aaa;margin:8px 0}.rowt{display:flex;justify-content:space-between;font-size:12px;margin:2px 0}.tot{display:flex;justify-content:space-between;font-weight:bold;font-size:16px;margin-top:6px}'
      + '.seal{font-size:9px;color:#888;word-break:break-all;margin-top:8px}.btn{display:block;width:100%;margin:16px 0 0;padding:13px;font-size:14px;border:0;border-radius:9px;background:#111;color:#fff;font-family:Arial,sans-serif;cursor:pointer}@media print{.btn{display:none}}</style></head><body>'
      + '<h1>KINGSTON</h1><div class="c muted">' + E(sl.name || 'KINGSTON') + (sl.city ? ' · ' + E(sl.city) : '') + '</div>'
      + '<div class="c muted">' + (sl.siren && sl.siren !== '000000000' ? 'SIREN ' + E(sl.siren) : '') + (sl.vat && sl.vat !== 'FR00000000000' ? ' · TVA ' + E(sl.vat) : '') + '</div>'
      + '<hr><div class="muted">Ticket <b>' + E(inv.num) + '</b><br>' + dt.toLocaleDateString('fr-FR') + ' ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + (inv.source ? ' · ' + E(inv.source) : '') + '</div>'
      + '<table>' + lignes + '</table><hr>' + ht + tvaRows
      + (inv.remise ? '<div class="rowt"><span>Remise fidélité</span><span>-' + M(inv.remise) + '</span></div>' : '')
      + '<div class="tot"><span>TOTAL</span><span>' + M(inv.total) + '</span></div>'
      + '<div class="rowt"><span>Règlement</span><span>' + E(inv.payment || 'Carte') + '</span></div>'
      + '<hr><div class="c muted">Merci de ta visite ! Conserve ce ticket.</div>'
      + '<div class="muted" style="margin-top:6px;text-align:center">Caisse certifiée NF525 — données inaltérables.</div>'
      + (inv.seal ? '<div class="seal">Sceau : ' + E(String(inv.seal).slice(0, 32)) + '…</div>' : '')
      + '<button class="btn" onclick="window.print()">Imprimer le ticket</button>'
      + '</body></html>';
    res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, res._cors || COMMON_CORS));
    return res.end(html);
  }
  if (req.method === 'GET' && path === '/api/orders/stream') {
    const boutique = u.searchParams.get('boutique') || '';
    res.writeHead(200, Object.assign({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    }, res._cors));
    res.write('retry: 3000\n\n');
    const client = { res, boutique };
    orderClients.push(client);
    const open = orders.filter((o) => (!boutique || o.boutiqueId === boutique) && o.status !== 'servie');
    sseSend(client, 'snapshot', open);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ka); const i = orderClients.indexOf(client); if (i >= 0) orderClients.splice(i, 1); });
    return;
  }
  if (req.method === 'GET' && path === '/api/orders') {
    const boutique = u.searchParams.get('boutique') || '';
    return send(res, 200, { orders: orders.filter((o) => !boutique || o.boutiqueId === boutique) });
  }
  if (req.method === 'POST' && path === '/api/orders') {
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items : [];
    // Sous-total calcule a partir des lignes envoyees par la borne (prix * quantite).
    let brut = items.reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
    brut = Math.round(brut * 100) / 100;
    // Coupon fidelite : remise fixe en EUR contre un cout en points fixe (meme regle que la caisse).
    let remise = 0, pointsUtilises = 0;
    if (body.customerRef && body.couponEur && body.couponPoints) {
      remise = Math.round(Math.min(brut, Number(body.couponEur)) * 100) / 100;
      pointsUtilises = Math.max(0, Math.floor(Number(body.couponPoints)));
    }
    const total = Math.round((brut - remise) * 100) / 100;
    const boutiqueId = body.boutiqueId || 'aix';

    // Vente borne -> vraie facture comptable (chainee, avec TVA) : elle entre dans le Journal,
    // exactement comme une vente caisse. TVA 20% par defaut (modifiable par ligne via it.vat).
    let facture = null;
    if (items.length && brut > 0) {
      try {
        const invLines = items.map((it) => ({
          produit: it.name || 'Article',
          detail: it.detail || ((Number(it.qty) || 1) + ' x'),
          prix: Math.round((Number(it.price) || 0) * (Number(it.qty) || 1) * 100) / 100,
          qty: Number(it.qty) || 1,
          vat: typeof it.vat === 'number' ? it.vat : 0.20,
        }));
        const tvaB = computeTva(invLines, brut, remise);
        const inv = createInvoice(boutiqueId, total, invLines, body.customerRef || 'Client borne', body.payment || 'Carte (borne)', 'borne');
        inv.tva = tvaB; inv.remise = remise; inv.couponPoints = pointsUtilises;
        facture = inv.num;
      } catch (e) { console.error('Facture borne impossible :', e.message); }
    }

    const order = {
      id: orderSeq,
      numero: 'CMD-' + String(orderSeq).padStart(3, '0'),
      boutiqueId: boutiqueId,
      borneId: body.borneId || 'B1',
      items: items,
      brut: brut,
      remise: remise,
      couponPoints: pointsUtilises,
      total: total,
      customerRef: body.customerRef || null,
      customerName: body.customerName || null,
      payment: body.payment || 'Carte (borne)',
      facture: facture,
      status: 'nouveau',
      paid: true,
      ts: Date.now(),
      updatedAt: Date.now(),
    };
    orderSeq++;
    orders.push(order);
    persist();
    // Fidelite en best-effort : ne doit JAMAIS bloquer l'affichage cuisine si myCred est indisponible.
    let pointsGagnes = 0, nouveauSolde = null;
    if (body.customerRef) {
      const refB = (facture || order.numero) + '@' + new Date().toISOString().slice(0, 10);
      try {
        if (pointsUtilises > 0) await loyalty.redeem(body.customerRef, pointsUtilises, refB + '-R');
        const r = await loyalty.earnFromSale(body.customerRef, total, refB);
        pointsGagnes = Math.round(total * POINTS_PER_EURO);
        nouveauSolde = r && typeof r.points === 'number' ? r.points : null;
      } catch (e) { /* fidelite indisponible : on conserve la commande */ }
    }
    broadcastOrder(order, 'order');
    return send(res, 201, {
      id: order.id, numero: order.numero, status: order.status, facture: facture,
      montants: { brut: brut, remise: remise, total: total },
      fidelite: body.customerRef ? { membre: body.customerRef, pointsUtilises: pointsUtilises, pointsGagnes: pointsGagnes, nouveauSolde: nouveauSolde } : 'client borne',
    });
  }
  const mOStatus = path.match(/^\/api\/orders\/(\d+)\/status$/);
  if (req.method === 'POST' && mOStatus) {
    const body = await readJson(req);
    const order = orders.find((o) => o.id === parseInt(mOStatus[1], 10));
    if (!order) return send(res, 404, { error: 'Commande introuvable' });
    const allowed = ['nouveau', 'preparation', 'prete', 'servie', 'annulee'];
    if (allowed.indexOf(body.status) < 0) return send(res, 400, { error: 'Statut invalide' });
    order.status = body.status;
    order.updatedAt = Date.now();
    persist();
    broadcastOrder(order, 'update');
    return send(res, 200, order);
  }

  // Menu public (borne libre-service) : catalogue sans authentification ni stock.
  if (req.method === 'GET' && path === '/api/menu') {
    const bId = u.searchParams.get('boutique') || 'aix';        // stock affiche selon la boutique de la borne
    // « Populaire » : best-sellers calcules sur les VRAIES ventes (lignes de factures, hors avoirs).
    const sales = {};
    for (const inv of invoices) { if (inv.total < 0) continue; for (const ln of (inv.lines || [])) { const nm = String(ln.name || '').toLowerCase(); if (nm) sales[nm] = (sales[nm] || 0) + (ln.qty || 1); } }
    const ranked = Object.keys(sales).sort((a, b) => sales[b] - sales[a]).slice(0, 5);
    const list = allCatalog().filter((p) => !p.boutiqueId || p.boutiqueId === bId).map((p) => {
      const o = { id: p.id, name: p.name, cat: p.cat, unit: p.unit, img: p.img || '', desc: p.desc || '', custom: !!p.custom, new: !!p.new, popular: ranked.indexOf(String(p.name || '').toLowerCase()) >= 0 };
      const sk = (stock[bId] || {})[p.id];
      if (p.unit === 'g') { o.tiers = p.tiers; o.stockG = totalGrams(sk); }
      else { o.price = p.price; if (Array.isArray(p.packs) && p.packs.length) o.packs = p.packs; o.stockU = sk ? (sk.units || 0) : 0; }
      return o;
    });
    return send(res, 200, { boutique: bId, products: list });
  }

  // Identification client sur la borne via QR (route publique). Le QR peut contenir un e-mail,
  // un numero de membre, ou une URL ; on en extrait un identifiant et on lit le solde myCred.
  if (req.method === 'POST' && path === '/api/borne/identify') {
    const body = await readJson(req);
    let code = String((body && body.code) || '').trim();
    if (!code) return send(res, 400, { found: false, error: 'Code vide' });
    let ref = code;
    if (/^https?:\/\//i.test(code)) {
      try {
        const cu = new URL(code);
        ref = cu.searchParams.get('user') || cu.searchParams.get('email') || cu.searchParams.get('id') ||
              cu.searchParams.get('code') || cu.searchParams.get('token') || cu.searchParams.get('member') ||
              (cu.pathname.split('/').filter(Boolean).pop()) || code;
      } catch (e) { /* garde le code brut */ }
    }
    try { ref = decodeURIComponent(ref); } catch (e) {}
    ref = ref.trim();
    try {
      const bal = await loyalty.getBalance(ref);
      if (bal && bal.points != null) {
        return send(res, 200, {
          found: true,
          ref: bal.email || ref,
          email: bal.email || (ref.indexOf('@') >= 0 ? ref : null),
          name: bal.name || bal.email || ref,
          points: Math.round(bal.points),
        });
      }
      return send(res, 404, { found: false, error: 'Client introuvable' });
    } catch (e) { return send(res, 404, { found: false, error: 'Client introuvable' }); }
  }

  // Connexion : renvoie un jeton selon les identifiants (route publique)
  if (req.method === 'GET' && path === '/api/login-accounts') {
    const list = Object.keys(accounts).map((k) => {
      const a = accounts[k];
      const label = a.role === 'admin' ? (a.name + ' \u2014 Admin r\u00e9seau') : ('Manager \u2014 ' + ((boutiques[a.boutiqueId] && boutiques[a.boutiqueId].label) || a.boutiqueId));
      return { key: k, label: label };
    });
    return send(res, 200, { accounts: list });
  }
  if (req.method === 'POST' && path === '/api/login') {
    const gate = loginThrottle(req);
    if (gate.blocked) {
      res.setHeader('Retry-After', String(gate.retry));
      return send(res, 429, { error: 'Trop de tentatives de connexion. Reessaie dans ' + Math.ceil(gate.retry / 60) + ' min.' });
    }
    const body = await readJson(req);
    if (PG) {
      const r = await PG.authenticate(body && body.user, body && body.password);
      if (!r) { loginFail(gate.ip); return send(res, 401, { error: 'Identifiants invalides' }); }
      loginOk(gate.ip);
      return send(res, 200, r);
    }
    const uname = body && body.user;
    if (!accounts[uname] || !checkPass(uname, body && body.password)) { loginFail(gate.ip); return send(res, 401, { error: 'Identifiants invalides' }); }
    loginOk(gate.ip);
    const token = newSession(uname);
    const a = accounts[uname];
    const mustChangePassword = !!(credentials[uname] && credentials[uname].isDefault);
    return send(res, 200, { token: token, name: a.name, role: a.role, boutiqueId: a.boutiqueId, mustChangePassword: mustChangePassword });
  }

  // ---- Mot de passe oublie (PUBLIC) : demande d'un code a 6 chiffres envoye par e-mail ----
  if (req.method === 'POST' && path === '/api/account/forgot') {
    const gate = loginThrottle(req);
    if (gate.blocked) { res.setHeader('Retry-After', String(gate.retry)); return send(res, 429, { error: 'Trop de demandes. Réessaie dans ' + Math.ceil(gate.retry / 60) + ' min.' }); }
    const body = await readJson(req);
    const acc = resolveAccountByIdent(body && body.identifier);
    let hint = null;
    if (acc && acc.email && ktValidEmail(acc.email)) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      resetCodes[acc.uname] = { stored: makeStoredPass(code), exp: Date.now() + 15 * 60 * 1000, tries: 0, email: acc.email };
      const who = acc.uname === 'admin' ? 'Admin réseau' : ('Boutique ' + ((boutiques[acc.uname] && boutiques[acc.uname].label) || acc.uname));
      hint = maskEmail(acc.email);
      sendMail(acc.email, 'Code de réinitialisation KINGTOOLS', resetEmailHtml(code, who)).then(function (r) { if (!r.ok) console.error('Envoi code reinit echoue:', r.error || r.code); }, function () {});
    }
    loginOk(gate.ip);
    return send(res, 200, { ok: true, sentHint: hint });   // hint = e-mail masque si un compte correspond ; null sinon
  }

  // ---- Reinitialisation (PUBLIC) : code + nouveau mot de passe ----
  if (req.method === 'POST' && path === '/api/account/reset') {
    const gate = loginThrottle(req);
    if (gate.blocked) { res.setHeader('Retry-After', String(gate.retry)); return send(res, 429, { error: 'Trop de tentatives. Réessaie dans ' + Math.ceil(gate.retry / 60) + ' min.' }); }
    const body = await readJson(req);
    const acc = resolveAccountByIdent(body && body.identifier);
    const code = String((body && body.code) || '').trim();
    const nw = String((body && body.newPassword) || '');
    const rc = acc && resetCodes[acc.uname];
    if (!rc || rc.exp < Date.now()) { if (acc && resetCodes[acc.uname]) delete resetCodes[acc.uname]; loginFail(gate.ip); return send(res, 400, { error: 'Code expiré ou invalide. Redemande un nouveau code.' }); }
    if (rc.tries >= 5) { delete resetCodes[acc.uname]; loginFail(gate.ip); return send(res, 429, { error: 'Trop d\'essais sur ce code. Redemande un nouveau code.' }); }
    rc.tries++;
    if (!verifyStoredPass(rc.stored, code)) { loginFail(gate.ip); return send(res, 400, { error: 'Code incorrect.' }); }
    if (nw.length < 6) return send(res, 400, { error: 'Nouveau mot de passe : 6 caractères minimum.' });
    if (nw.toLowerCase() === DEFAULT_PASS) return send(res, 400, { error: 'Choisis un mot de passe différent de celui par défaut.' });
    if (acc.uname === 'admin') { adminCred = makeStoredPass(nw); }
    else { if (!boutiques[acc.uname]) return send(res, 404, { error: 'Compte inconnu' }); boutiques[acc.uname].cred = makeStoredPass(nw); boutiques[acc.uname].mustChangePw = false; }
    delete resetCodes[acc.uname];
    for (const t of Object.keys(sessions)) { const s = sessions[t]; if (s && ((acc.uname === 'admin' && s.role === 'admin' && !s.boutiqueId) || s.boutiqueId === acc.uname)) delete sessions[t]; }
    rebuildAccounts();
    persist();
    loginOk(gate.ip);
    return send(res, 200, { ok: true });
  }

  // ---- Installateur AUTO du pont (libre-service) : source du pont + installateur pre-rempli par jeton ----
  if (req.method === 'GET' && path === '/pont-paiement.js') {
    try {
      const src = fs.readFileSync(pathmod.join(__dirname, 'pont-paiement.js'), 'utf8');
      res.writeHead(200, Object.assign({ 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }, res._cors || COMMON_CORS));
      return res.end(src);
    } catch (e) { return send(res, 404, { error: 'pont indisponible' }); }
  }
  // Script de configuration d'un pont Raspberry clone pour une boutique (multi-boutique).
  if (req.method === 'GET' && path === '/boutique-setup.sh') {
    try {
      const sh = fs.readFileSync(pathmod.join(__dirname, 'boutique-setup.sh'), 'utf8');
      res.writeHead(200, Object.assign({ 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }, res._cors || COMMON_CORS));
      return res.end(sh);
    } catch (e) { return send(res, 404, { error: 'script indisponible' }); }
  }
  // Outil web "Installe-Pont" : page qui ecrit le code+wifi sur la cle USB d'un nouveau Raspberry.
  if (req.method === 'GET' && (path === '/installe-pont' || path === '/installe-pont.html')) {
    try {
      const h = fs.readFileSync(pathmod.join(__dirname, 'installe-pont.html'), 'utf8');
      res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, res._cors || COMMON_CORS));
      return res.end(h);
    } catch (e) { return send(res, 404, { error: 'outil indisponible' }); }
  }
  // Script d'onboarding a poser UNE FOIS sur le Raspberry maitre (lit kt-install.txt, resout le code, s'appaire).
  if (req.method === 'GET' && path === '/kt-onboard-install.sh') {
    try {
      const sh = fs.readFileSync(pathmod.join(__dirname, 'kt-onboard-install.sh'), 'utf8');
      res.writeHead(200, Object.assign({ 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }, res._cors || COMMON_CORS));
      return res.end(sh);
    } catch (e) { return send(res, 404, { error: 'script indisponible' }); }
  }
  if (req.method === 'GET' && path === '/pont/installer') {
    const tok = String(u.searchParams.get('token') || '').trim();
    if (!boutiqueByPontToken(tok)) return send(res, 404, { error: 'Jeton inconnu' });
    const base = 'https://' + (req.headers.host || 'kingtools.fr');
    const sh = pontInstallerScript(base, tok);
    if (u.searchParams.get('format') === 'zip') {
      // .zip contenant le .command en mode 0755 -> double-clic du .zip = fichier executable (le double-clic marche).
      const zip = zipSingleFile('Installer-Pont-KINGSTON.command', sh, 0o100755);
      res.writeHead(200, Object.assign({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="Installer-Pont-KINGSTON.zip"' }, res._cors || COMMON_CORS));
      return res.end(zip);
    }
    res.writeHead(200, Object.assign({ 'content-type': 'text/x-shellscript; charset=utf-8', 'content-disposition': 'attachment; filename="Installer-Pont-KINGSTON.command"' }, res._cors || COMMON_CORS));
    return res.end(sh);
  }

  // ---- Resolution d'un code d'installation (PUBLIC) : un nouveau Pi tape son code -> recoit le jeton de sa boutique.
  if (req.method === 'GET' && path === '/api/pont/resolve') {
    const code = String(u.searchParams.get('code') || '').trim().toUpperCase().replace(/\s+/g, '');
    const bId = boutiqueByInstallCode(code);
    if (!bId) return send(res, 404, { ok: false, error: 'Code inconnu' });
    return send(res, 200, { ok: true, boutiqueId: bId, label: (boutiques[bId].label || bId), token: pontTokenFor(bId) });
  }

  // ---- Pont de paiement : appairage initie par le pont (routes publiques) ----
  // Le pont s'annonce avec son deviceId ; le serveur lui donne un code court a saisir dans Kingtools.
  if (req.method === 'POST' && path === '/api/pont/hello') {
    let b = {}; try { b = await readJson(req); } catch (e) {}
    const id = String((b && b.deviceId) || '').trim();
    if (!id) return send(res, 400, { error: 'deviceId requis' });
    let dev = pontDevices[id];
    if (!dev) { dev = pontDevices[id] = { code: genShortCode(), boutiqueId: null, ip: '', tcpPort: 8888, lastSeen: Date.now() }; persist(); }
    dev.lastSeen = Date.now();
    // AUTO-APPAIRAGE LIBRE-SERVICE : si le pont porte un jeton de boutique valide, il s'appaire TOUT SEUL (zero action admin).
    const tokBoutique = boutiqueByPontToken(b && b.setupToken);
    if (tokBoutique && dev.boutiqueId !== tokBoutique) {
      dev.boutiqueId = tokBoutique;
      for (const k of Object.keys(pontDevices)) { if (pontDevices[k] !== dev && pontDevices[k].boutiqueId === tokBoutique) delete pontDevices[k]; } // un seul pont par boutique
    }
    if (dev.boutiqueId) { // le pont remonte l'IP du terminal qu'il a detecte tout seul -> on la memorise (auto-cicatrisant)
      if (typeof (b && b.terminalIp) === 'string' && b.terminalIp.trim()) dev.ip = b.terminalIp.trim();
      if (b && b.terminalPort) dev.tcpPort = parseInt(b.terminalPort, 10) || dev.tcpPort;
    }
    persist();
    return send(res, 200, { claimed: !!dev.boutiqueId, code: dev.code, boutique: dev.boutiqueId || null, terminalIp: dev.ip || '', terminalPort: dev.tcpPort || 8888 });
  }
  if (req.method === 'GET' && path === '/api/pont/poll') {
    const dev = pontDevices[req.headers['x-pont-device'] || ''];
    if (!dev || !dev.boutiqueId) return send(res, 401, { error: 'Pont non appaire' });
    dev.lastSeen = Date.now(); const bId = dev.boutiqueId;
    const q = pontCmds[bId] || (pontCmds[bId] = []);
    const cmd = q.find((c) => c.status === 'pending');
    if (cmd) { cmd.status = 'sent'; cmd.sentAt = Date.now(); return send(res, 200, { command: { id: cmd.id, amount: cmd.amount, ref: cmd.ref } }); }
    return send(res, 200, { command: null });
  }
  if (req.method === 'POST' && path === '/api/pont/result') {
    const dev = pontDevices[req.headers['x-pont-device'] || ''];
    if (!dev || !dev.boutiqueId) return send(res, 401, { error: 'Pont non appaire' });
    dev.lastSeen = Date.now(); const bId = dev.boutiqueId;
    let b = {}; try { b = await readJson(req); } catch (e) {}
    const cmd = (pontCmds[bId] || []).find((c) => c.id === (b && b.id));
    if (cmd) { cmd.status = 'done'; cmd.approved = !!(b && b.approved); cmd.codeReponse = (b && b.codeReponse) || null; cmd.echec = (b && b.echec) || null; cmd.doneAt = Date.now(); }
    return send(res, 200, { ok: true });
  }

  // ---- Borne (kiosque client, public) : paiement carte via le MEME relais que la caisse ----
  // La borne n'a pas de session : endpoints publics, mais on n'agit que si un pont est appaire
  // a la boutique (sinon rien). Cela ne fait qu'afficher un montant sur le TPE : aucun fonds ne
  // bouge sans une vraie carte presentee au terminal.
  if (req.method === 'POST' && path === '/api/borne/pay') {
    let b = {}; try { b = await readJson(req); } catch (e) {}
    const bId = String((b && b.boutiqueId) || 'aix');
    if (!boutiques[bId]) return send(res, 404, { error: 'Boutique inconnue' });
    const amount = Math.round(Number(b && b.amount) * 100) / 100;
    if (!(amount > 0)) return send(res, 400, { error: 'Montant invalide' });
    if (!pontPaired(bId)) return send(res, 200, { commandId: null, pontPaired: false, pontOnline: false });
    const q = pontCmds[bId] || (pontCmds[bId] = []);
    const cmd = { id: pontCmdSeq++, amount: amount, ref: String((b && b.ref) || 'BORNE-' + Date.now()), status: 'pending', ts: Date.now() };
    q.push(cmd);
    pontCmds[bId] = q.filter((c) => Date.now() - c.ts < 180000);
    return send(res, 200, { commandId: cmd.id, pontPaired: true, pontOnline: pontOnline(bId) });
  }
  const mBorneCmd = path.match(/^\/api\/borne\/cmd\/(\d+)$/);
  if (req.method === 'GET' && mBorneCmd) {
    const cid = parseInt(mBorneCmd[1], 10);
    let found = null;
    for (const id of Object.keys(pontCmds)) { const c = (pontCmds[id] || []).find((x) => x.id === cid); if (c) { found = c; break; } }
    if (!found) return send(res, 404, { error: 'Commande inconnue (expiree ?)' });
    return send(res, 200, { id: found.id, status: found.status, approved: !!found.approved, codeReponse: found.codeReponse || null, echec: found.echec || null });
  }

  if (req.method === 'POST' && path === '/api/borne/receipt-email') {
    var bb = await readJson(req);
    var fnum = (bb && bb.facture ? String(bb.facture) : '').trim();
    var bemail = (bb && bb.email ? String(bb.email) : '').trim();
    if (!ktValidEmail(bemail)) return send(res, 400, { error: 'Adresse email invalide.' });
    var binv = invoices.find(function (i) { return i.num === fnum; });
    if (!binv) return send(res, 404, { error: 'Facture introuvable.' });
    if (binv.source !== 'borne') return send(res, 403, { error: 'Non autorise.' });
    if (Date.now() - new Date(binv.date).getTime() > 30 * 60 * 1000) return send(res, 410, { error: 'Facture trop ancienne.' });
    if ((binv._mailCount || 0) >= 3) return send(res, 429, { error: 'Limite atteinte.' });
    binv._mailCount = (binv._mailCount || 0) + 1;
    var ber = await sendInvoiceEmail(bemail, binv);
    if (!ber.ok) return send(res, (ber.code === 'NO_KEY' || ber.code === 'NO_FROM') ? 503 : 502, { error: ber.error });
    return send(res, 200, { ok: true });
  }

  // Authentification (prototype : un jeton -> un utilisateur avec role + boutique)
  const user = PG ? await PG.contextFromToken(req.headers['x-comptoir-token']) : sessionUser(req.headers['x-comptoir-token']);
  if (!user) return send(res, 401, { error: 'Session expirée ou invalide — reconnecte-toi.' });

  try {
    if (req.method === 'POST' && path === '/api/facture/email') {
      var bMail = await readJson(req);
      var numMail = (bMail && bMail.num ? String(bMail.num) : '').trim();
      var emailMail = (bMail && bMail.email ? String(bMail.email) : '').trim();
      if (!ktValidEmail(emailMail)) return send(res, 400, { error: 'Adresse email invalide.' });
      var invMail = invoices.find(function (i) { return i.num === numMail; });
      if (!invMail) return send(res, 404, { error: 'Facture introuvable.' });
      if (user.role !== 'admin' && invMail.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Non autorisé.' });
      var erMail = await sendInvoiceEmail(emailMail, invMail);
      if (!erMail.ok) return send(res, (erMail.code === 'NO_KEY' || erMail.code === 'NO_FROM') ? 503 : 502, { error: erMail.error });
      return send(res, 200, { ok: true, sentTo: emailMail });
    }
    // ---- Supervision des ponts TPE (onglet « Ponts TPE ») : etat en direct par boutique ----
    if (req.method === 'GET' && path === '/api/ponts') {
      var pIds = boutiqueIds(); if (user.role !== 'admin') pIds = pIds.filter(function (id) { return id === user.boutiqueId; });
      var pList = pIds.map(function (id) {
        var pb = boutiques[id] || {};
        var pd = pontDeviceForBoutique(id);
        return { id: id, label: (pb.label || id), paired: !!pd, online: pontOnline(id), lastSeenMs: (pd && pd.lastSeen) ? (Date.now() - pd.lastSeen) : null, terminalIp: (pd && pd.ip) || '', terminalPort: (pd && pd.tcpPort) || null, code: (pd && pd.code) || null, installCode: installCodeFor(id) };
      });
      pList.sort(function (a, b) { var ra = a.online ? 2 : (a.paired ? 0 : 1); var rb = b.online ? 2 : (b.paired ? 0 : 1); return ra - rb; });
      return send(res, 200, { role: user.role, count: pList.length, online: pList.filter(function (x) { return x.online; }).length, ponts: pList });
    }

    if (req.method === 'GET' && path === '/api/royalties') {
      var rym = (u.searchParams.get('ym') || '').trim(); if(!rym){ var dN=new Date(); rym=dN.getFullYear()+'-'+('0'+(dN.getMonth()+1)).slice(-2); }
      var rids = boutiqueIds(); if (user.role !== 'admin') rids = rids.filter(function(id){ return id===user.boutiqueId; });
      var rlist = rids.map(function(id){ var b=boutiques[id]||{}; var rate=royaltiesRateFor(id); var caHT=royaltiesCaHT(id, rym); var rec=royaltiesRec(rym,id); return { id:id, label:(b.label||id), rate:rate, caHT:caHT, royalty: Math.round(caHT*rate)/100, status:rec.status, declaredAt:rec.declaredAt||null, validatedAt:rec.validatedAt||null }; });
      var rtot = rlist.reduce(function(a,x){ a.caHT+=x.caHT; a.royalties+=x.royalty; if(x.status==='valide')a.encaisse+=x.royalty; else a.attente+=x.royalty; return a; }, {caHT:0,royalties:0,encaisse:0,attente:0});
      Object.keys(rtot).forEach(function(k){ rtot[k]=Math.round(rtot[k]*100)/100; });
      return send(res, 200, { role:user.role, ym:rym, boutiques:rlist, totals:rtot });
    }
    if (req.method === 'POST' && path === '/api/royalties/rate') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Action reservee a l administrateur.' });
      var rrb = await readJson(req); var rrid=String((rrb&&rrb.boutiqueId)||''); var rrate=Math.max(0,Math.min(100,Number(rrb&&rrb.rate)||0));
      if(!boutiques[rrid]) return send(res, 404, { error: 'Boutique inconnue.' });
      royaltiesRates[rrid]=rrate; persist();
      return send(res, 200, { ok:true });
    }
    if (req.method === 'POST' && path === '/api/royalties/declare') {
      var rdb = await readJson(req); var rdym=String((rdb&&rdb.ym)||''); var rdid=String((rdb&&rdb.boutiqueId)||'');
      if (user.role !== 'admin' && rdid !== user.boutiqueId) return send(res, 403, { error: 'Non autorise.' });
      if(!boutiques[rdid]) return send(res, 404, { error: 'Boutique inconnue.' });
      royaltiesSetStatus(rdym, rdid, { status:'declare', declaredAt:new Date().toISOString() });
      return send(res, 200, { ok:true });
    }
    if (req.method === 'POST' && path === '/api/royalties/status') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Action reservee a l administrateur.' });
      var rsb = await readJson(req); var rsst=String((rsb&&rsb.status)||'a_payer'); if(['a_payer','declare','valide'].indexOf(rsst)<0) rsst='a_payer';
      var rpatch={status:rsst}; if(rsst==='a_payer'){rpatch.declaredAt=null;rpatch.validatedAt=null;} if(rsst==='valide'){rpatch.validatedAt=new Date().toISOString();} if(rsst==='declare'){rpatch.validatedAt=null;}
      royaltiesSetStatus(String((rsb&&rsb.ym)||''), String((rsb&&rsb.boutiqueId)||''), rpatch);
      return send(res, 200, { ok:true });
    }
    // ---- Terminal de paiement via le relais (caisse -> serveur -> pont -> TPE) ----
    if (req.method === 'POST' && path === '/api/terminal/pay') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Non autorise' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0)) return send(res, 400, { error: 'Montant invalide' });
      const q = pontCmds[bId] || (pontCmds[bId] = []);
      const cmd = { id: pontCmdSeq++, amount: amount, ref: (b.ref || 'CAISSE-' + Date.now()), status: 'pending', ts: Date.now() };
      q.push(cmd);
      pontCmds[bId] = q.filter((c) => Date.now() - c.ts < 180000);
      return send(res, 200, { commandId: cmd.id, pontOnline: pontOnline(bId) });
    }
    const mTermCmd = path.match(/^\/api\/terminal\/cmd\/(\d+)$/);
    if (req.method === 'GET' && mTermCmd) {
      const cid = parseInt(mTermCmd[1], 10);
      let found = null, foundB = null;
      for (const id of Object.keys(pontCmds)) { const c = (pontCmds[id] || []).find((x) => x.id === cid); if (c) { found = c; foundB = id; break; } }
      if (!found) return send(res, 404, { error: 'Commande inconnue (expiree ?)' });
      if (user.role !== 'admin' && foundB !== user.boutiqueId) return send(res, 403, { error: 'Non autorise' });
      return send(res, 200, { id: found.id, status: found.status, approved: !!found.approved, codeReponse: found.codeReponse || null, echec: found.echec || null });
    }
    if (req.method === 'POST' && path === '/api/terminal/claim-pont') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve a l administrateur' });
      const b = await readJson(req);
      if (!boutiques[b.boutiqueId]) return send(res, 404, { error: 'Boutique inconnue' });
      const code = String((b && b.code) || '').trim();
      const dev = code ? pontDeviceByCode(code) : pontDeviceForBoutique(b.boutiqueId);   // sans code : met a jour le pont deja connecte de cette boutique
      if (!dev) return send(res, 404, { error: code ? 'Code inconnu — le pont est-il allume et connecte a internet ?' : 'Aucun pont connecte pour cette boutique. Entre le code affiche par le pont.' });
      dev.boutiqueId = b.boutiqueId;
      if (typeof (b && b.ip) === 'string' && b.ip.trim()) dev.ip = b.ip.trim(); // ne pas effacer l'IP si non fournie
      dev.tcpPort = parseInt(b && b.tcpPort, 10) || dev.tcpPort || 8888;
      // un seul pont par boutique : on retire les anciennes inscriptions (ponts reinstalles) qui visaient la meme boutique
      for (const k of Object.keys(pontDevices)) { if (pontDevices[k] !== dev && pontDevices[k].boutiqueId === b.boutiqueId) delete pontDevices[k]; }
      persist();
      return send(res, 200, { ok: true, boutique: b.boutiqueId, online: pontOnline(b.boutiqueId) });
    }
    if (req.method === 'GET' && path === '/api/terminal/status') {
      const ids = user.role === 'admin' ? boutiqueIds() : [user.boutiqueId];
      const stt = {};
      ids.forEach((id) => { stt[id] = { online: pontOnline(id), paired: pontPaired(id) }; });
      return send(res, 200, { terminals: stt });
    }
    if (req.method === 'GET' && path === '/api/terminal/diag') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve admin' });
      const dids = boutiqueIds();
      const dout = {};
      dids.forEach((id) => {
        const dd = pontDeviceForBoutique(id);
        const cc = (pontCmds[id] || []).slice(-8).map((c) => ({ amount: c.amount, status: c.status, approved: !!c.approved, echec: c.echec || null, codeReponse: c.codeReponse || null, ageSec: Math.round((Date.now() - (c.ts||0)) / 1000), latencyMs: (c.doneAt && c.sentAt) ? (c.doneAt - c.sentAt) : null }));
        dout[id] = { paired: !!dd, online: !!dd && (Date.now() - (dd.lastSeen || 0)) < 12000, lastSeenSecAgo: dd ? Math.round((Date.now() - (dd.lastSeen || 0)) / 1000) : null, terminalIp: dd ? (dd.ip || '') : '', terminalPort: dd ? (dd.tcpPort || 8888) : null, recentCommands: cc };
      });
      return send(res, 200, { diag: dout });
    }
    // Jeton + lien d'installateur PRE-REMPLI pour une boutique (installation libre-service du pont).
    if (req.method === 'GET' && path === '/api/pont/setup-token') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve a l administrateur reseau' });
      const bId = u.searchParams.get('boutique') || '';
      if (!boutiques[bId]) return send(res, 404, { error: 'Boutique inconnue' });
      const token = pontTokenFor(bId);
      const base = 'https://' + (req.headers.host || 'kingtools.fr');
      return send(res, 200, { boutique: bId, token: token, installerUrl: base + '/pont/installer?token=' + encodeURIComponent(token), online: pontOnline(bId), paired: pontPaired(bId) });
    }
    if (req.method === 'POST' && path === '/api/pont/setup-token/rotate') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve a l administrateur reseau' });
      const b = await readJson(req);
      if (!boutiques[b.boutiqueId]) return send(res, 404, { error: 'Boutique inconnue' });
      boutiques[b.boutiqueId].pontToken = crypto.randomBytes(18).toString('hex'); persist();
      return send(res, 200, { ok: true, token: boutiques[b.boutiqueId].pontToken });
    }
    if (req.method === 'GET' && path === '/api/products') {
      if (PG) return send(res, 200, await PG.getProducts(user, u.searchParams.get('boutique')));
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || 'aix') : user.boutiqueId;
      // Catalogue = base KINGSTON (+ produits reseau) + catalogue SECONDAIRE propre a la boutique (p.boutiqueId).
      const products = allCatalog().filter((p) => !p.boutiqueId || p.boutiqueId === bId).map((p) => {
        const s = (stock[bId] || {})[p.id];
        const base = { id: p.id, name: p.name, cat: p.cat, unit: p.unit, img: p.img || '', desc: p.desc || '', custom: !!p.custom };
        if (p.boutiqueId) base.boutiqueId = p.boutiqueId;
        if (p.vat != null) base.vat = p.vat;
        if (p.new) base.new = true;
        if (p.unit === 'g') { base.tiers = p.tiers; base.stockG = totalGrams(s); }
        else { base.price = p.price; base.stockU = s ? s.units : 0; if (Array.isArray(p.packs) && p.packs.length) base.packs = p.packs; }
        return base;
      });
      return send(res, 200, { boutique: bId, products });
    }

    // ---------------- Produits : photo, ajout, edition, suppression (admin) ----------------
    // Upload d'une photo (data URL) -> enregistree dans img/ -> renvoie son URL servie par /img/.
    if (req.method === 'POST' && path === '/api/products/image') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/.exec(b.dataUrl || '');
      if (!m) return send(res, 400, { error: 'Image invalide (png, jpg, webp ou gif attendu)' });
      const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 4 * 1024 * 1024) return send(res, 400, { error: 'Image trop lourde (max 4 Mo)' });
      const fname = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.' + ext;
      try { if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(pathmod.join(IMG_DIR, fname), buf); }
      catch (e) { return send(res, 500, { error: 'Enregistrement image impossible : ' + e.message }); }
      return send(res, 201, { url: '/img/' + fname });
    }

    if (req.method === 'POST' && path === '/api/products') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const name = (b.name || '').trim();
      if (!name) return send(res, 400, { error: 'Nom du produit requis' });
      const unit = b.unit === 'g' ? 'g' : 'u';
      const p = { id: 'cp' + Date.now().toString(36), name: name, cat: (b.cat || 'Divers').trim(), unit: unit, custom: true, img: b.img || '', desc: (b.desc || '').trim() };
      // Portee : un MANAGER cree toujours un produit propre a SA boutique (catalogue secondaire, ex. cafe).
      // L'admin cree par defaut pour tout le reseau, ou pour une boutique precise via forBoutique.
      if (user.role === 'manager') p.boutiqueId = user.boutiqueId;
      else if (b.forBoutique) { const fb = String(b.forBoutique).trim().toLowerCase(); if (!boutiques[fb]) return send(res, 400, { error: 'Boutique inconnue : ' + fb }); p.boutiqueId = fb; }
      if (typeof b.proPrice === 'number' && user.role === 'admin') p.proPrice = Math.round(b.proPrice * 100) / 100;   // prix de gros (réassort) : admin uniquement
      if (typeof b.vat === 'number') p.vat = b.vat;
      if (b.new) p.new = true;
      if (unit === 'g') {
        const tiers = (Array.isArray(b.tiers) ? b.tiers : []).map((t) => [Number(t[0]), Number(t[1])]).filter((t) => t[0] > 0 && t[1] >= 0);
        if (!tiers.length) return send(res, 400, { error: 'Ajoute au moins un palier : poids (g) + prix (€)' });
        p.tiers = tiers;
      } else {
        p.price = Math.round((Number(b.price) || 0) * 100) / 100;
        const packs = (Array.isArray(b.packs) ? b.packs : []).map((k) => ({ qty: Math.floor(Number(k.qty)), price: Math.round((Number(k.price) || 0) * 100) / 100 })).filter((k) => k.qty > 1 && k.price >= 0);
        if (packs.length) p.packs = packs;
      }
      customProducts.push(p);
      ensureStock(p);
      const bId = user.role === 'admin' ? (p.boutiqueId || b.boutiqueId || 'aix') : user.boutiqueId;   // produit de boutique -> stock initial CHEZ ELLE
      const init = Number(b.initStock) || 0;
      if (init > 0) {
        if (unit === 'g') stock[bId][p.id] = { lots: [{ lot: name.replace(/\s/g, '').slice(0, 6).toUpperCase() + '-INIT', g: init, exp: '2099-01' }] };
        else stock[bId][p.id] = { units: init };
      }
      persist();
      return send(res, 201, { ok: true, product: p });
    }

    const mProd = path.match(/^\/api\/products\/([^/]+)$/);
    if (mProd && mProd[1] !== 'import-site' && mProd[1] !== 'image' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const id = decodeURIComponent(mProd[1]);
      const p = customProducts.find((x) => x.id === id);
      if (!p) return send(res, 404, { error: 'Seuls les produits ajoutés depuis l\'app sont modifiables ici.' });
      // Un manager ne peut modifier/supprimer QUE les produits de SA boutique (jamais le catalogue KINGSTON).
      if (user.role === 'manager' && p.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Ce produit appartient au catalogue KINGSTON (ou à une autre boutique) : seul l\'admin réseau peut le modifier.' });
      if (req.method === 'DELETE') {
        customProducts = customProducts.filter((x) => x.id !== id);
        persist();
        return send(res, 200, { ok: true, deleted: id });
      }
      const b = await readJson(req);
      if (b.name) p.name = b.name.trim();
      if (b.cat) p.cat = b.cat.trim();
      if (b.img != null) p.img = b.img;
      if (b.desc != null) p.desc = b.desc.trim();
      if (typeof b.vat === 'number') p.vat = b.vat;
      if ('new' in b) p.new = !!b.new;
      if (user.role === 'admin') { if (typeof b.proPrice === 'number') p.proPrice = Math.round(b.proPrice * 100) / 100; else if (b.proPrice === null) delete p.proPrice; } // prix de gros (réassort), réglé par l'admin
      if (p.unit === 'g' && Array.isArray(b.tiers)) {
        const t = b.tiers.map((x) => [Number(x[0]), Number(x[1])]).filter((x) => x[0] > 0 && x[1] >= 0);
        if (t.length) p.tiers = t;
      }
      if (p.unit === 'u') {
        if (b.price != null) p.price = Math.round((Number(b.price) || 0) * 100) / 100;
        if (Array.isArray(b.packs)) p.packs = b.packs.map((k) => ({ qty: Math.floor(Number(k.qty)), price: Math.round((Number(k.price) || 0) * 100) / 100 })).filter((k) => k.qty > 1 && k.price >= 0);
      }
      persist();
      return send(res, 200, { ok: true, product: p });
    }

    // Import du catalogue depuis le site WooCommerce (Store API publique). Remplace la démo.
    if (req.method === 'POST' && path === '/api/products/import-site') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const body = await readJson(req);
      const bId = user.role === 'admin' ? (body.boutiqueId || 'aix') : user.boutiqueId;
      const defStock = body.stock === 'zero' ? 0 : (Number(body.defaultStock) || 200);
      const r = await syncWooCatalog({ siteUrl: body.siteUrl, boutiqueId: bId, defaultStock: defStock });
      if (r && r.error) return send(res, 502, r);
      return send(res, 200, Object.assign({ ok: true, hideBase: true, lastSync: lastWooSync }, r));
    }

    // Réapprovisionner TOUT le catalogue avec un stock par défaut (boutique courante). Admin/manager.
    if (req.method === 'POST' && path === '/api/stock/restock-all') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const qty = Number(b.qty) > 0 ? Math.floor(Number(b.qty)) : 500;
      if (!stock[bId]) stock[bId] = {};
      let n = 0;
      const lot = 'RESTOCK-' + new Date().toISOString().slice(0, 10);
      for (const p of allCatalog()) {
        if (p.boutiqueId && p.boutiqueId !== bId) continue;   // ne restocke pas les produits des autres boutiques
        if (p.unit === 'g') stock[bId][p.id] = { lots: [{ lot: lot, g: qty, exp: '2099-01' }] };
        else stock[bId][p.id] = { units: qty };
        n++;
      }
      persist();
      return send(res, 200, { ok: true, restocked: n, boutique: bId, qty: qty });
    }

    const mC = path.match(/^\/api\/customers\/(.+)$/);
    if (req.method === 'GET' && mC) {
      const ref = decodeURIComponent(mC[1]);
      const bal = await loyalty.getBalance(ref);
      return send(res, 200, bal);
    }

    // Ajustement manuel des points d'un client : amount > 0 credite, < 0 debite. Ecrit dans myCred.
    if (req.method === 'POST' && path === '/api/loyalty/adjust') {
      const b = await readJson(req);
      const ref = (b.customerRef || '').trim();
      const amount = Math.round(Number(b.amount));
      if (!ref) return send(res, 400, { error: 'Client requis' });
      if (!amount) return send(res, 400, { error: 'Montant de points non nul requis' });
      try {
        const reason = b.reason || (amount > 0 ? 'Points ajoutés (Comptoir)' : 'Points retirés (Comptoir)');
        const r = await loyalty.adjust(ref, amount, reason, 'ADJ-' + Date.now());
        let soldeApres = null; try { const bal = await loyalty.getBalance(ref); soldeApres = bal && bal.points; } catch (e2) {}
        return send(res, 200, { ok: true, ref: ref, ajuste: amount, points: r && typeof r.points === 'number' ? r.points : null, soldeApres: soldeApres, reponse: r });
      } catch (e) { return send(res, 502, { ok: false, error: String(e.message || e) }); }
    }

    // État de la liaison fidélité (sans exposer la clé secrète)
    if (req.method === 'GET' && path === '/api/loyalty/status') {
      return send(res, 200, { mode: LOYALTY_MODE, wpUrl: process.env.COMPTOIR_WP_URL || null, pointsParEuro: POINTS_PER_EURO });
    }

    // Régler le taux de points par euro (réservé admin) — persisté, prioritaire sur l'env au redémarrage.
    if (req.method === 'POST' && path === '/api/loyalty/config') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const body = await readJson(req);
      const v = Number(body.pointsPerEuro);
      if (!isFinite(v) || v < 0) return send(res, 400, { error: 'Taux invalide (nombre positif attendu)' });
      POINTS_PER_EURO = Math.round(v * 100) / 100;
      if (loyalty) loyalty.pointsPerEuro = POINTS_PER_EURO;
      persist();
      return send(res, 200, { ok: true, pointsParEuro: POINTS_PER_EURO });
    }

    // Liste des clients du site (ecran Fidelite + recherche caisse)
    if (req.method === 'GET' && path === '/api/loyalty/customers') {
      const search = u.searchParams.get('search') || '';
      const page = parseInt(u.searchParams.get('page') || '1', 10) || 1;
      const list = await loyalty.listCustomers({ search: search, page: page, perPage: 50 });
      return send(res, 200, list);
    }

    if (req.method === 'POST' && path === '/api/sales') {
      const body = await readJson(req);
      // SECURITE anti-double-paiement : si cette vente (meme cle) a deja ete encaissee, on renvoie le MEME resultat sans creer de 2e vente.
      const _saleKey = body && body.saleKey ? String(body.saleKey).slice(0, 80) : '';
      if (_saleKey) { pruneRecentSales(); const _prev = recentSales[_saleKey]; if (_prev) return send(res, _prev.status, _prev.json); }
      const finish = (status, jsonObj) => { if (_saleKey) recentSales[_saleKey] = { status: status, json: jsonObj, exp: Date.now() + 2 * 60 * 1000 }; return send(res, status, jsonObj); };
      if (PG) {
        const out = await PG.recordSale(user, { items: body.items || [], customerEmail: body.customerRef, payment: body.payment || 'Carte Monetico', boutiqueId: body.boutiqueId });
        let fidelite = 'client au comptoir';
        if (body.customerRef) {
          const r = await loyalty.earnFromSale(body.customerRef, out.facture.total, out.facture.numero);
          fidelite = { membre: body.customerRef, pointsGagnes: Math.round(out.facture.total * POINTS_PER_EURO), nouveauSolde: r.points };
        }
        const lignes = out.lignes.map((l) => ({ produit: l.label, detail: l.grams ? l.grams + ' g' : (l.qty + ' x'), prix: l.price }));
        return finish(201, { facture: out.facture, lignes: lignes, fidelite: fidelite });
      }
      const bId = user.role === 'admin' ? (body.boutiqueId || 'aix') : user.boutiqueId;
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new Error('Aucun article dans la vente');

      const lines = [];
      let brut = 0;
      for (const it of items) {
        if (it.productId === 'libre') { const _p = Math.round(Number(it.price)*100)/100; if(!(_p>0)) throw new Error('Montant prix libre invalide'); brut += _p; lines.push({ produit: (it.name||'Article divers'), detail: 'Prix libre', prix: _p, productId: 'libre', qty: 1, vat: 0.20 }); continue; }
        const p = findProduct(it.productId);
        if (!p) throw new Error('Produit inconnu : ' + it.productId);
        const rate = vatRate(p);
        if (p.unit === 'g') {
          const grams = Number(it.grams);
          const tier = p.tiers.find((t) => t[0] === grams);
          if (!tier) throw new Error('Palier de grammes invalide pour ' + p.name);
          decrementFEFO(bId, p.id, grams);
          brut += tier[1];
          lines.push({ produit: p.name, detail: grams + ' g', prix: tier[1], productId: p.id, grams: grams, vat: rate });
        } else if (it.packQty && Array.isArray(p.packs)) {
          // Vente par PACK : prix du pack (autoritatif, lu sur le produit), stock = qty du pack x nombre de packs.
          const packQ = Math.floor(Number(it.packQty));
          const count = Math.max(1, Math.floor(Number(it.count) || 1));
          const pack = p.packs.find((k) => Number(k.qty) === packQ);
          if (!pack) throw new Error('Pack invalide pour ' + p.name);
          const unitsTotal = packQ * count;
          decrementUnits(bId, p.id, unitsTotal);
          const prix = Math.round(pack.price * count * 100) / 100;
          brut += prix;
          lines.push({ produit: p.name, detail: 'Pack de ' + packQ + (count > 1 ? ' ×' + count : ''), prix: prix, productId: p.id, qty: unitsTotal, vat: rate });
        } else {
          const qty = Number(it.qty || 1);
          decrementUnits(bId, p.id, qty);
          const prix = Math.round(p.price * qty * 100) / 100;
          brut += prix;
          lines.push({ produit: p.name, detail: qty + ' x', prix: prix, productId: p.id, qty: qty, vat: rate });
        }
      }
      brut = Math.round(brut * 100) / 100;

      // Remise fidelite : coupon (remise fixe en EUR pour un cout en points fixe) OU lineaire (100 pts = 1 EUR).
      let remise = 0, pointsUtilises = 0;
      if (body.customerRef && body.couponEur && body.couponPoints) {
        remise = Math.round(Math.min(brut, Number(body.couponEur)) * 100) / 100;
        pointsUtilises = Math.max(0, Math.floor(Number(body.couponPoints)));
      } else if (body.usePoints && body.customerRef) {
        pointsUtilises = Math.max(0, Math.floor(Number(body.usePoints)));
        remise = Math.round(Math.min(brut, pointsUtilises / 100) * 100) / 100;
      }
      const total = Math.round((brut - remise) * 100) / 100;
      const tva = computeTva(lines, brut, remise);

      const inv = createInvoice(bId, total, lines, body.customerRef || 'Comptoir', body.payment || 'Carte Monetico', 'caisse');
      inv.tva = tva; inv.remise = remise; inv.couponPoints = pointsUtilises;

      // Fidelite en BEST-EFFORT : une vente deja encaissee ne doit JAMAIS echouer a cause de myCred.
      // Le ref inclut la date -> jamais confondu avec une vente d'une session precedente (anti-faux-doublon).
      let pointsEarned = 0, newBalance = null, fidErreur = null;
      if (body.customerRef) {
        const refBase = inv.num + '@' + (inv.date || '').slice(0, 10);
        try {
          if (pointsUtilises > 0) { await loyalty.redeem(body.customerRef, pointsUtilises, refBase + '-R'); }
          const r = await loyalty.earnFromSale(body.customerRef, total, refBase);
          pointsEarned = Math.round(total * POINTS_PER_EURO);
          newBalance = r && typeof r.points === 'number' ? r.points : null;
        } catch (e) { fidErreur = String(e.message || e); console.error('Fidelite caisse :', fidErreur); }
      }

      return finish(201, {
        facture: { numero: inv.num, total: inv.total, date: inv.date, boutique: bId, empreinte: inv.hash.slice(0, 16) + '...' },
        lignes: lines.map((l) => ({ produit: l.produit, detail: l.detail, prix: l.prix })),
        montants: { brut: brut, remise: remise, totalTTC: total, totalHT: tva.totalHT, totalTVA: tva.totalTVA, ventilationTVA: tva.ventilation },
        fidelite: body.customerRef ? { membre: body.customerRef, pointsUtilises: pointsUtilises, pointsGagnes: pointsEarned, nouveauSolde: newBalance, taux: POINTS_PER_EURO, erreur: fidErreur } : 'client au comptoir',
      });
    }

    if (req.method === 'POST' && path === '/api/refund') {
      if (PG) return send(res, 501, { error: 'Remboursement non disponible en mode PostgreSQL (prototype)' });
      const body = await readJson(req);
      const orig = invoices.find((i) => i.num === body.invoice && i.total >= 0);
      if (!orig) return send(res, 404, { error: 'Facture introuvable' });
      if (user.role !== 'admin' && orig.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Hors de votre boutique' });
      if (orig.refunded) return send(res, 400, { error: 'Facture deja remboursee' });
      // Retours : les ACCESSOIRES (unités) reviennent en stock vendable ; les FLEURS (au gramme),
      // périssables, ne sont PAS remises en vente automatiquement (mises en quarantaine, hors stock vendable).
      // COMPTOIR_RESTOCK_FLEURS=1 pour réautoriser la remise en stock des fleurs.
      const restockFleurs = process.env.COMPTOIR_RESTOCK_FLEURS === '1';
      orig.lines.forEach((l) => {
        const s = (stock[orig.boutiqueId] || {})[l.productId];
        if (l.grams && s && s.lots) {
          if (restockFleurs) s.lots.push({ lot: 'RETOUR-' + orig.num, g: l.grams, exp: '2099-01' });
          else { s.quarantaine = (s.quarantaine || 0) + l.grams; } // tracé hors stock vendable
        } else if (l.qty && s && typeof s.units === 'number') s.units += l.qty;
      });
      orig.refunded = true;
      const avoirLines = orig.lines.map((l) => ({ produit: l.produit, detail: l.detail, prix: -l.prix, productId: l.productId, grams: l.grams, qty: l.qty, vat: l.vat }));
      const inv = createInvoice(orig.boutiqueId, -orig.total, avoirLines, orig.client, 'Avoir / remboursement', 'avoir');
      inv.avoirDe = orig.num;
      if (orig.tva) inv.tva = computeTva(avoirLines, -orig.total, 0);
      // Correction par nouvel enregistrement (jamais par suppression) -> tracée au journal des événements.
      logFiscalEvent('CORRECTION_AVOIR', orig.boutiqueId, { avoir: inv.num, factureOrigine: orig.num, montant: inv.total });
      return send(res, 201, { avoir: { numero: inv.num, total: inv.total, refDe: orig.num, empreinte: inv.hash.slice(0, 16) + '...' } });
    }

    if (req.method === 'GET' && path === '/api/invoices') {
      if (PG) return send(res, 200, await PG.listInvoices(user));
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const list = invoices
        .filter((i) => (bId ? i.boutiqueId === bId : true))
        .map((i) => ({ numero: i.num, date: i.date, boutique: i.boutiqueId, total: i.total, client: i.client, paiement: i.payment }));
      return send(res, 200, { count: list.length, factures: list });
    }

    // ---------------- FRANCHISES / BOUTIQUES (reseau) ----------------
    // Liste : identite + URLs pretes a partager. Un manager ne voit QUE sa boutique.
    if (req.method === 'GET' && path === '/api/boutiques') {
      const all = boutiqueIds().map((id) => {
        const b = boutiques[id];
        const hasPass = !!(process.env['COMPTOIR_PASS_' + id.toUpperCase()] || (b.cred && b.cred.salt));
        return { id: id, label: b.label || id, prefix: b.prefix || id.toUpperCase().slice(0, 4), seller: b.seller || SELLER_DEFAULT, motDePasseDefini: hasPass, email: b.email || '', pending: !!b.mustChangePw };
      });
      const list = user.role === 'admin' ? all : all.filter((b) => b.id === user.boutiqueId);
      return send(res, 200, { boutiques: list });
    }

    // Ajouter / mettre a jour une franchise (identite legale + mot de passe manager). Admin reseau uniquement.
    if (req.method === 'POST' && path === '/api/boutiques') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      let id = (b.id || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!id) id = (b.label || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
      if (!id) return send(res, 400, { error: 'Identifiant de boutique requis (ex. lyon)' });
      if (id === 'admin') return send(res, 400, { error: 'Identifiant réservé' });
      const ex = boutiques[id] || {};
      const exSeller = ex.seller || {};
      const seller = {
        name: (b.name != null ? String(b.name) : exSeller.name || ('KINGSTON ' + id)).trim(),
        siren: (b.siren != null ? String(b.siren) : exSeller.siren || '').replace(/\s/g, ''),
        vat: (b.vat != null ? String(b.vat) : exSeller.vat || '').replace(/\s/g, ''),
        address: b.address != null ? String(b.address) : (exSeller.address || ''),
        zip: b.zip != null ? String(b.zip) : (exSeller.zip || ''),
        city: b.city != null ? String(b.city) : (exSeller.city || ''),
        country: 'FR',
      };
      const rec = {
        id: id,
        label: (b.label != null ? String(b.label) : ex.label || ('KINGSTON ' + id)).trim(),
        prefix: (b.prefix || ex.prefix || id).toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || id.toUpperCase(),
        seller: seller,
      };
      if (ex.cred) rec.cred = ex.cred;                                   // conserver le mot de passe existant
      if (b.password) rec.cred = makeStoredPass(b.password);             // (re)definir le mot de passe manager
      if (ex.email) rec.email = ex.email;                                // conserver l'e-mail rattache
      if (ex.mustChangePw) rec.mustChangePw = true;                      // conserver l'etat « 1re connexion en attente »
      if (b.email != null) { const _em = String(b.email).trim(); if (_em && !ktValidEmail(_em)) return send(res, 400, { error: 'E-mail invalide.' }); rec.email = _em; }
      let tempPassword = null;
      if (b.password) { tempPassword = String(b.password); rec.mustChangePw = true; }                              // rec.cred deja defini ci-dessus : mot de passe temporaire a changer
      else if (b.regenPassword || (!boutiques[id] && !rec.cred)) { tempPassword = genTempPass(); rec.cred = makeStoredPass(tempPassword); rec.mustChangePw = true; }   // nouveau compte / reinitialisation : mot de passe temporaire genere
      boutiques[id] = rec;
      if (!stock[id]) stock[id] = {};                                    // stock de la boutique
      fb(id);                                                            // etat fiscal de la boutique
      rebuildAccounts();                                                 // compte manager cree/mis a jour
      persist();
      const resp = { ok: true, boutique: { id: id, label: rec.label, prefix: rec.prefix, seller: rec.seller, email: rec.email || '', motDePasseDefini: !!(rec.cred || process.env['COMPTOIR_PASS_' + id.toUpperCase()]), pending: !!rec.mustChangePw } };
      if (tempPassword) resp.tempPassword = tempPassword;   // affiche UNE seule fois a l'admin, a communiquer au franchise
      return send(res, 200, resp);
    }

    // Supprimer une franchise (OPERATION SENSIBLE) : admin reseau uniquement, avec confirmation explicite.
    // On retire l'acces manager, l'identite active et les compteurs OPERATIONNELS de la boutique.
    // Les factures et evenements fiscaux DEJA emis restent archives (obligation legale) : ils ne sont pas effaces.
    if (req.method === 'DELETE' && path.indexOf('/api/boutiques/') === 0) {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const id = decodeURIComponent(path.slice('/api/boutiques/'.length)).trim().toLowerCase();
      if (!id || !boutiques[id]) return send(res, 404, { error: 'Boutique inconnue' });
      if (boutiqueIds().length <= 1) return send(res, 400, { error: 'Impossible de supprimer la dernière boutique du réseau.' });
      // Double confirmation : le client doit renvoyer l'identifiant exact (corps JSON { confirm } ou ?confirm=).
      let confirm = '';
      try { const body = await readJson(req); if (body && body.confirm != null) confirm = String(body.confirm); } catch (e) {}
      if (!confirm) { const cu = u.searchParams.get('confirm'); if (cu) confirm = String(cu); }
      if (confirm.trim().toLowerCase() !== id) return send(res, 400, { error: 'Confirmation invalide : renvoie l\'identifiant exact de la boutique.' });
      const label = boutiques[id].label || id;
      delete boutiques[id];                                             // registre des franchises
      delete stock[id];                                                 // stock de la boutique
      delete seqByB[id]; delete gtByB[id]; delete gtAvoirsByB[id]; delete clotureSeqByB[id];   // compteurs fiscaux operationnels
      delete royaltiesRates[id]; delete royaltiesStatus[id];            // royalties
      for (const t of Object.keys(sessions)) { if (sessions[t] && sessions[t].boutiqueId === id) delete sessions[t]; }  // revoquer les sessions du manager
      rebuildAccounts();                                                // supprime le compte manager de la boutique
      persist();
      return send(res, 200, { ok: true, deleted: id, label: label });
    }

    // Ouvrir l'espace d'une franchise EN TANT QU'ADMIN, sans connaitre ni modifier le mot de passe du franchise.
    // Cree une session « manager » temporaire pour la boutique demandee. Admin reseau uniquement.
    // Le mot de passe et l'e-mail du franchise ne sont JAMAIS touches ; sa propre 1re connexion reste inchangee.
    if (req.method === 'POST' && path === '/api/admin/enter-boutique') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const body = await readJson(req);
      const id = String((body && body.id) || '').trim().toLowerCase();
      if (!id || !boutiques[id] || !accounts[id]) return send(res, 404, { error: 'Boutique inconnue' });
      const token = newSession(id);                          // session manager de la boutique (n'affecte pas le mot de passe)
      if (sessions[token]) sessions[token].viaAdmin = true;  // marqueur d'audit : espace ouvert par l'administrateur
      const a = accounts[id];
      return send(res, 200, { token: token, name: a.name, role: a.role, boutiqueId: a.boutiqueId, label: (boutiques[id].label || id), impersonating: true });
    }

    // Diagnostic e-mail : envoie un e-mail de test et renvoie le resultat EXACT de Brevo (pour comprendre pourquoi un envoi echoue). Admin uniquement.
    if (req.method === 'POST' && path === '/api/admin/test-email') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const body = await readJson(req);
      const to = String((body && body.to) || '').trim();
      if (!ktValidEmail(to)) return send(res, 400, { error: 'Indique une adresse e-mail valide.' });
      const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a"><div style="background:#161310;color:#e6c884;padding:20px 24px;border-radius:14px 14px 0 0"><div style="font-size:22px;font-weight:800;letter-spacing:.12em">KINGSTON</div></div><div style="border:1px solid #ece7df;border-top:none;border-radius:0 0 14px 14px;padding:22px 24px"><p style="font-size:15px">Test d\'envoi réussi ✓</p><p style="color:#555;font-size:14px">Si tu reçois cet e-mail, la configuration d\'envoi de KINGTOOLS fonctionne : tes franchisés pourront recevoir leur code de réinitialisation de mot de passe.</p></div></div>';
      const r = await sendMail(to, 'Test d\'envoi KINGTOOLS', html);
      if (r.ok) return send(res, 200, { ok: true, to: to, from: MAIL_FROM, fromName: MAIL_FROM_NAME });
      return send(res, 200, { ok: false, code: r.code || null, status: r.status || null, error: r.error || 'Échec inconnu', from: MAIL_FROM });
    }

    // Sauvegardes : etat, declenchement manuel vers le stockage externe, telechargement local. Admin uniquement.
    if (req.method === 'GET' && path === '/api/admin/backup') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      let localData = null;
      try { if (!PG && fs.existsSync(DATA_FILE)) { const st = fs.statSync(DATA_FILE); localData = { bytes: st.size, modifiedAt: st.mtime.toISOString() }; } } catch (e) {}
      return send(res, 200, { configured: bkConfigured(), pg: !!PG, endpoint: bkConfigured() ? BK.endpoint : '', bucket: bkConfigured() ? BK.bucket : '', prefix: BK.prefix, running: bkRunning, state: backupState, localData: localData });
    }
    if (req.method === 'POST' && path === '/api/admin/backup/run') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const r = await bkRun('manuel');
      return send(res, 200, r);
    }
    if (req.method === 'GET' && path === '/api/admin/backup/download') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const env = bkBuildEnvelope();
      if (!env.ok) return send(res, 400, { error: env.error });
      const name = 'kingtools-sauvegarde-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="' + name + '"', 'cache-control': 'no-store' }, res._cors || COMMON_CORS));
      return res.end(env.json);
    }

    // Changer SON PROPRE mot de passe (tout compte connecte). Sert au « mot de passe obligatoire a la 1re connexion ».
    if (req.method === 'POST' && path === '/api/account/password') {
      const body = await readJson(req);
      const uname = user.role === 'admin' ? 'admin' : user.boutiqueId;
      if (!uname || !credentials[uname]) return send(res, 400, { error: 'Compte inconnu' });
      if (!checkPass(uname, (body && body.currentPassword) || '')) return send(res, 403, { error: 'Mot de passe actuel incorrect' });
      const nw = String((body && body.newPassword) || '');
      if (nw.length < 6) return send(res, 400, { error: 'Nouveau mot de passe : 6 caractères minimum.' });
      if (nw.toLowerCase() === DEFAULT_PASS) return send(res, 400, { error: 'Choisis un mot de passe différent de celui par défaut.' });
      if (user.role === 'admin') {
        adminCred = makeStoredPass(nw);
        if (body && body.email != null) { const em = String(body.email).trim(); if (em) { if (!ktValidEmail(em)) return send(res, 400, { error: 'E-mail invalide.' }); adminEmail = em; } }
      } else {
        if (!boutiques[uname]) return send(res, 404, { error: 'Boutique inconnue' });
        const em = String((body && body.email) || boutiques[uname].email || '').trim();
        if (!ktValidEmail(em)) return send(res, 400, { error: 'E-mail valide requis (pour récupérer ton mot de passe en cas d\'oubli).' });
        boutiques[uname].cred = makeStoredPass(nw); boutiques[uname].email = em; boutiques[uname].mustChangePw = false;
      }
      rebuildAccounts();
      persist();
      return send(res, 200, { ok: true });
    }

    // « Mon compte » du compte connecte (surtout l'ADMIN reseau) : lire/modifier l'e-mail de recuperation et le mot de passe.
    // L'e-mail se change sans re-saisir le mot de passe ; le mot de passe exige le mot de passe actuel.
    if (path === '/api/account/me') {
      const uname = user.role === 'admin' ? 'admin' : user.boutiqueId;
      if (!uname || !credentials[uname]) return send(res, 400, { error: 'Compte inconnu' });
      const curEmail = () => user.role === 'admin' ? adminEmail : ((boutiques[uname] && boutiques[uname].email) || '');
      if (req.method === 'GET') {
        const label = user.role === 'admin' ? (accounts.admin ? accounts.admin.name : 'Admin réseau') : ((boutiques[uname] && boutiques[uname].label) || uname);
        return send(res, 200, { role: user.role, boutiqueId: user.boutiqueId || null, label: label, email: curEmail(), login: uname });
      }
      const body = await readJson(req);
      let passwordChanged = false;
      const wantsPw = body && body.newPassword != null && String(body.newPassword) !== '';
      if (wantsPw) {
        if (!checkPass(uname, (body && body.currentPassword) || '')) return send(res, 403, { error: 'Mot de passe actuel incorrect' });
        const nw = String(body.newPassword);
        if (nw.length < 6) return send(res, 400, { error: 'Nouveau mot de passe : 6 caractères minimum.' });
        if (nw.toLowerCase() === DEFAULT_PASS) return send(res, 400, { error: 'Choisis un mot de passe différent de celui par défaut.' });
        if (user.role === 'admin') { adminCred = makeStoredPass(nw); }
        else { if (!boutiques[uname]) return send(res, 404, { error: 'Compte inconnu' }); boutiques[uname].cred = makeStoredPass(nw); boutiques[uname].mustChangePw = false; }
        passwordChanged = true;
      }
      if (body && body.email != null) {
        const em = String(body.email).trim();
        if (em && !ktValidEmail(em)) return send(res, 400, { error: 'E-mail invalide.' });
        if (user.role === 'admin') adminEmail = em;
        else if (boutiques[uname]) boutiques[uname].email = em;
      }
      if (!wantsPw && !(body && body.email != null)) return send(res, 400, { error: 'Rien à modifier.' });
      rebuildAccounts();
      persist();
      return send(res, 200, { ok: true, email: curEmail(), passwordChanged: passwordChanged });
    }

    if ((req.method === 'GET' || req.method === 'POST') && path === '/api/my-boutique') {
      const bId = user.boutiqueId;
      if (!bId || !boutiques[bId]) return send(res, 403, { error: 'Reserve aux managers de boutique' });
      const b = boutiques[bId];
      if (req.method === 'GET') {
        const sg = b.seller || {};
        return send(res, 200, { boutiqueId: bId, label: b.label || bId, email: b.email || '', seller: { name: sg.name || '', siren: sg.siren || '', vat: sg.vat || '', address: sg.address || '', zip: sg.zip || '', city: sg.city || '', phone: sg.phone || '', contact: sg.contact || '' } });
      }
      const body = await readJson(req);
      if (body.newPassword) {
        if (!checkPass(bId, body.currentPassword || '')) return send(res, 403, { error: 'Mot de passe actuel incorrect' });
        if (String(body.newPassword).length < 6) return send(res, 400, { error: 'Nouveau mot de passe : 6 caractères minimum.' });
        if (String(body.newPassword).toLowerCase() === DEFAULT_PASS) return send(res, 400, { error: 'Choisis un mot de passe différent de celui par défaut.' });
        b.cred = makeStoredPass(body.newPassword); b.mustChangePw = false;
      }
      if (body.email !== undefined) {                                   // e-mail de recuperation, modifiable depuis « Mon compte »
        const em = String(body.email || '').trim();
        if (em && !ktValidEmail(em)) return send(res, 400, { error: 'E-mail invalide.' });
        b.email = em;
      }
      const s = b.seller || {};
      const setIf = (k, val) => { if (val !== undefined && val !== null) s[k] = String(val).trim(); };
      setIf('name', body.name); setIf('siren', body.siren); setIf('vat', body.vat);
      setIf('address', body.address); setIf('zip', body.zip); setIf('city', body.city);
      setIf('phone', body.phone); setIf('contact', body.contact);
      s.country = s.country || 'FR';
      b.seller = s;
      rebuildAccounts();
      persist();
      return send(res, 200, { ok: true, seller: b.seller, email: b.email || '', passwordChanged: !!body.newPassword });
    }


    if (req.method === 'GET' && path === '/api/fiscal/verify') {
      if (PG) return send(res, 200, await PG.verifyChain(user));
      const fact = verifyChain();
      const evts = fiscal.verifyEventChain(fiscalEvents, fiscalKey);
      return send(res, 200, {
        conforme: fact.chainOk && evts.ok,
        chaineFactures: fact,
        chaineEvenements: evts,
        grandTotalPerpetuel: gtPerpetuel,
        grandTotalAvoirsPerpetuel: gtPerpetuelAvoirs,
      });
    }

    // ------------------- CONFORMITE CAISSE (loi anti-fraude TVA / NF525) -------------------
    // Etat fiscal : Grand Total perpetuel + compteurs (admin = reseau, sinon sa boutique).
    if (req.method === 'GET' && path === '/api/fiscal/etat') {
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const inScope = invoices.filter((i) => (bId ? i.boutiqueId === bId : true));
      const ventes = inScope.filter((i) => i.total >= 0);
      const clotures = fiscalEvents.filter((e) => /^CLOTURE_/.test(e.type) && (bId ? e.boutiqueId === bId : true));
      return send(res, 200, {
        boutique: bId || 'reseau',
        grandTotalPerpetuel: bId ? (gtByB[bId] || 0) : gtPerpetuel,            // GT de l'entite si ciblee, sinon reseau
        grandTotalAvoirsPerpetuel: bId ? (gtAvoirsByB[bId] || 0) : gtPerpetuelAvoirs,
        nbTickets: ventes.length,
        nbAvoirs: inScope.length - ventes.length,
        nbClotures: clotures.length,
        nbEvenements: fiscalEvents.length,
        derniereCloture: clotures.length ? clotures[clotures.length - 1].date : null,
      });
    }

    // Effectuer une cloture Z (journaliere) / M (mensuelle) / A (annuelle). Admin ou manager.
    if (req.method === 'POST' && path === '/api/fiscal/cloture') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const type = ['Z', 'M', 'A'].indexOf(b.type) >= 0 ? b.type : 'Z';
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const e = faireCloture(type, bId);
      return send(res, 201, { ok: true, cloture: e });
    }

    // Liste des clotures (filtre type + boutique).
    if (req.method === 'GET' && path === '/api/fiscal/clotures') {
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const type = u.searchParams.get('type') || '';
      const list = fiscalEvents
        .filter((e) => /^CLOTURE_/.test(e.type))
        .filter((e) => (bId ? e.boutiqueId === bId : true))
        .filter((e) => (type ? e.type === 'CLOTURE_' + type : true))
        .slice().sort((a, b2) => b2.seq - a.seq)
        .map((e) => ({ seq: e.seq, type: e.type, boutique: e.boutiqueId, date: e.date, signature: (e.sig || '').slice(0, 16), data: e.data }));
      return send(res, 200, { count: list.length, clotures: list });
    }

    // Journal des evenements (JET) : tous les evenements scelles, du plus recent au plus ancien.
    if (req.method === 'GET' && path === '/api/fiscal/journal-evenements') {
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const list = fiscalEvents
        .filter((e) => (bId ? (e.boutiqueId === bId || e.boutiqueId === null) : true))
        .slice().sort((a, b2) => b2.seq - a.seq)
        .map((e) => ({ seq: e.seq, type: e.type, boutique: e.boutiqueId, date: e.date, signature: (e.sig || '').slice(0, 16), data: e.data }));
      return send(res, 200, { count: list.length, evenements: list });
    }

    // Archive scellee + export de controle d'une periode (conservation + archivage).
    if (req.method === 'GET' && path === '/api/fiscal/archive') {
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const from = u.searchParams.get('from') || '';
      const to = u.searchParams.get('to') || '';
      const inRange = (iso) => { const d = (iso || '').slice(0, 10); if (from && d < from) return false; if (to && d > to) return false; return true; };
      const fact = invoices.filter((i) => (bId ? i.boutiqueId === bId : true)).filter((i) => inRange(i.date));
      const evts = fiscalEvents.filter((e) => (bId ? (e.boutiqueId === bId || e.boutiqueId === null) : true)).filter((e) => inRange(e.date));
      const archive = {
        type: 'archive-fiscale-scellee',
        logiciel: 'Comptoir', editeur: SELLER.name, siren: SELLER.siren,
        genereLe: new Date().toISOString(),
        perimetre: { boutique: bId || 'toutes', du: from || 'origine', au: to || 'aujourd\'hui' },
        grandTotalPerpetuel: gtPerpetuel, grandTotalAvoirsPerpetuel: gtPerpetuelAvoirs,
        verifChaineFactures: verifyChain(),
        verifChaineEvenements: fiscal.verifyEventChain(fiscalEvents, fiscalKey),
        factures: fact, evenements: evts,
      };
      archive.signatureGlobale = fiscal.archiveSignature(fact, evts, fiscalKey);
      return send(res, 200, archive);
    }

    // ---- Analyse globale : snapshot JSON complet et structure (lecture seule). ----
    // GET /api/analytics — admin : tout le reseau ; manager : sa boutique uniquement.
    if (req.method === 'GET' && path === '/api/analytics') {
      if (PG) return send(res, 501, { error: 'Analytics indisponible en mode PostgreSQL pour le moment' });
      const r2a = (n) => Math.round(n * 100) / 100;
      const nowA = new Date();
      const todayA = nowA.toISOString().slice(0, 10);
      const monthA = nowA.toISOString().slice(0, 7);
      const scopeA = user.role === 'admin' ? boutiqueIds() : [user.boutiqueId];
      const invsA = invoices.filter((i) => scopeA.indexOf(i.boutiqueId) >= 0);
      let caJourA = 0, caMoisA = 0, tJourA = 0, tMoisA = 0, caTotalA = 0, nbAvoirsA = 0;
      const byDayA = {}, byPayA = {}, byBtqA = {}, byProdA = {}, byHourA = {};
      invsA.forEach((i) => {
        const d = (i.date || '').slice(0, 10);
        const h = (i.date || '').slice(11, 13);
        caTotalA += i.total; if (i.total < 0) nbAvoirsA++;
        if (d === todayA) { caJourA += i.total; if (i.total >= 0) tJourA++; }
        if ((i.date || '').slice(0, 7) === monthA) { caMoisA += i.total; if (i.total >= 0) tMoisA++; }
        if (d) byDayA[d] = (byDayA[d] || 0) + i.total;
        if (h) byHourA[h] = (byHourA[h] || 0) + i.total;
        const pmA = String(i.payment || 'Autre'); byPayA[pmA] = (byPayA[pmA] || 0) + i.total;
        const bA = byBtqA[i.boutiqueId] = byBtqA[i.boutiqueId] || { ca: 0, tickets: 0 };
        bA.ca += i.total; if (i.total >= 0) bA.tickets++;
        (Array.isArray(i.lines) ? i.lines : []).forEach((l) => {
          const kA = l.produit || l.productId || 'inconnu';
          const eA = byProdA[kA] = byProdA[kA] || { ca: 0, qte: 0 };
          eA.ca += Number(l.prix) || 0; eA.qte++;
        });
      });
      const topProduitsA = Object.keys(byProdA)
        .map((k) => ({ produit: k, ca: r2a(byProdA[k].ca), ventes: byProdA[k].qte }))
        .sort((a, b) => b.ca - a.ca).slice(0, 20);
      const catAn = (() => { try { return allCatalog(); } catch (e) { return []; } })();
      const stockParBoutiqueA = scopeA.map((bid) => {
        const sb = stock[bid] || {};
        const produits = Object.keys(sb).map((pid) => {
          const p = catAn.find((c) => c.id === pid) || { name: pid, unit: 'u' };
          const e = sb[pid] || {};
          const lots = Array.isArray(e.lots) ? e.lots : [];
          const grammes = lots.reduce((s, l) => s + (Number(l.g) || 0), 0);
          return {
            id: pid, nom: p.name, unite: p.unit === 'g' ? 'g' : 'unite',
            grammes: p.unit === 'g' ? r2a(grammes) : null,
            unites: p.unit === 'g' ? null : (Number(e.units) || 0),
            nbLots: lots.length,
            lots: lots.map((l) => ({ lot: l.lot, g: l.g, exp: l.exp })),
          };
        });
        return { boutique: bid, produits: produits };
      });
      const alertesStockA = [];
      stockParBoutiqueA.forEach((sb) => sb.produits.forEach((p) => {
        const niveau = p.unite === 'g' ? p.grammes : p.unites;
        const seuil = p.unite === 'g' ? 50 : 10;
        if (niveau !== null && niveau <= seuil) alertesStockA.push({ type: 'stock_bas', boutique: sb.boutique, produit: p.nom, niveau: niveau, unite: p.unite, seuil: seuil });
        p.lots.forEach((l) => { if (l.exp && String(l.exp).slice(0, 7) <= monthA) alertesStockA.push({ type: 'lot_perime', boutique: sb.boutique, produit: p.nom, lot: l.lot, exp: l.exp }); });
      }));
      let chaineFacturesA = null, chaineEvenementsA = null;
      try { chaineFacturesA = verifyChain(); } catch (e) { chaineFacturesA = { erreur: e.message }; }
      try { chaineEvenementsA = fiscal.verifyEventChain(fiscalEvents, fiscalKey); } catch (e) { chaineEvenementsA = { erreur: e.message }; }
      const alertesConfigA = [];
      if (user.role === 'admin') {
        if (usingDefaultPass) alertesConfigA.push('Mots de passe PAR DEFAUT actifs — definir COMPTOIR_PASS_* avant ouverture publique.');
        if (String(LOYALTY_MODE).indexOf('demo') === 0) alertesConfigA.push('Fidelite en mode DEMO (myCred non branche).');
        if (!(entreprise && entreprise.siret)) alertesConfigA.push('SIRET/identite legale non renseignes dans Reglages — factures non valables.');
        if (!PG) alertesConfigA.push('Persistance memoire+fichier (PostgreSQL non active) — normal en phase actuelle.');
      }
      return send(res, 200, {
        version: 'analytics-v1',
        genereLe: nowA.toISOString(),
        perimetre: { role: user.role, boutiques: scopeA },
        systeme: { mode: PG ? 'postgresql' : 'memoire+fichier', uptimeSec: Math.round(process.uptime()), fidelite: LOYALTY_MODE, node: process.version },
        fiscal: {
          grandTotalPerpetuel: r2a(gtPerpetuel),
          grandTotalAvoirs: r2a(gtPerpetuelAvoirs),
          nbFactures: invoices.length,
          nbEvenements: fiscalEvents.length,
          clotures: clotureSeq,
          chaineFactures: chaineFacturesA,
          chaineEvenements: chaineEvenementsA,
        },
        ventes: {
          caJour: r2a(caJourA), ticketsJour: tJourA, panierMoyenJour: tJourA ? r2a(caJourA / tJourA) : 0,
          caMois: r2a(caMoisA), ticketsMois: tMoisA, panierMoyenMois: tMoisA ? r2a(caMoisA / tMoisA) : 0,
          caTotal: r2a(caTotalA), nbAvoirs: nbAvoirsA,
          parJour: Object.keys(byDayA).sort().map((d) => ({ date: d, ttc: r2a(byDayA[d]) })),
          parHeure: Object.keys(byHourA).sort().map((h) => ({ heure: h + 'h', ttc: r2a(byHourA[h]) })),
          parPaiement: Object.keys(byPayA).sort().map((m) => ({ moyen: m, ttc: r2a(byPayA[m]) })),
          parBoutique: Object.keys(byBtqA).map((b) => ({ boutique: b, ca: r2a(byBtqA[b].ca), tickets: byBtqA[b].tickets })),
          topProduits: topProduitsA,
        },
        stock: { parBoutique: stockParBoutiqueA, alertes: alertesStockA },
        commandes: { total: orders.length },
        alertesConfig: alertesConfigA,
      });
    }

    if (req.method === 'GET' && path === '/api/dashboard') {
      if (PG) return send(res, 200, await PG.dashboard(user));
      const r2 = (n) => Math.round(n * 100) / 100;
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const month = now.toISOString().slice(0, 7);
      const scope = user.role === 'admin' ? boutiqueIds() : [user.boutiqueId];
      // Périmètre des KPIs/graphiques : réseau (admin) ou la boutique du manager. Optionnel ?boutique= pour l'admin.
      const sel = user.role === 'admin' ? (u.searchParams.get('boutique') || '') : user.boutiqueId;
      const kpiScope = sel ? [sel] : scope;
      const payNorm = (p) => { const s = String(p || '').toLowerCase(); if (/esp|cash|liquide/.test(s)) return 'Espèces'; if (/carte|cb|monetico|cic|bancaire|tpe/.test(s)) return 'Carte'; return p || 'Autre'; };
      const start = new Date(now); start.setDate(start.getDate() - 29); const startStr = start.toISOString().slice(0, 10);
      let caJour = 0, ticketsJour = 0, caMois = 0, ticketsMois = 0;
      const byDay = {}, byPay = {};
      invoices.filter((i) => kpiScope.indexOf(i.boutiqueId) >= 0).forEach((i) => {
        const d = (i.date || '').slice(0, 10);
        if (d === today) { caJour += i.total; if (i.total >= 0) ticketsJour++; }
        if ((i.date || '').slice(0, 7) === month) { caMois += i.total; if (i.total >= 0) ticketsMois++; }
        if (d >= startStr) { byDay[d] = (byDay[d] || 0) + i.total; const m = payNorm(i.payment); byPay[m] = (byPay[m] || 0) + i.total; }
      });
      const parJour = [];
      for (let k = 29; k >= 0; k--) { const dt = new Date(now); dt.setDate(dt.getDate() - k); const ds = dt.toISOString().slice(0, 10); parJour.push({ date: ds, ttc: r2(byDay[ds] || 0) }); }
      const parPaiement = Object.keys(byPay).sort().map((m) => ({ moyen: m, montant: r2(byPay[m]) }));
      const cat = (() => { try { return allCatalog(); } catch (e) { return []; } })();
      const perB = scope.map((id) => {
        let cj = 0, tj = 0, cm = 0;
        invoices.filter((i) => i.boutiqueId === id).forEach((i) => { const d = (i.date || '').slice(0, 10); if (d === today) { cj += i.total; if (i.total >= 0) tj++; } if ((i.date || '').slice(0, 7) === month) cm += i.total; });
        let alertes = 0; const stb = stock[id] || {};
        cat.forEach((p) => { const s = stb[p.id]; if (!s) return; if (p.unit === 'g') { if (totalGrams(s) < 25) alertes++; } else if ((s.units || 0) < 5) alertes++; });
        return { boutique: id, label: (boutiques[id] || {}).label || id, caJour: r2(cj), ticketsJour: tj, caMois: r2(cm), alertes: alertes, statut: 'Ouverte' };
      });
      return send(res, 200, {
        role: user.role, scope: scope, jour: today,
        kpis: { caJour: r2(caJour), ticketsJour: ticketsJour, panierMoyen: ticketsJour ? r2(caJour / ticketsJour) : 0, caMois: r2(caMois), ticketsMois: ticketsMois },
        parJour: parJour, parPaiement: parPaiement, boutiques: perB,
      });
    }

    // ---------------- Remise à zéro (mise en service réelle) ----------------
    // Efface ventes + chaîne fiscale + commandes (borne & réassort). GARDE catalogue, stock, identité, fidélité, pont.
    // Sauvegarde horodatée AVANT toute modification (les données test restent récupérables). Admin + phrase de confirmation.
    if (req.method === 'POST' && path === '/api/admin/reset') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve a l administrateur reseau' });
      if (PG) return send(res, 501, { error: 'Indisponible en mode PostgreSQL' });
      // CONFORMITE (art. 286, I-3° bis du CGI — inalterabilite) : la remise a zero est VERROUILLEE en production.
      // Elle ne sert qu'avant le lancement reel (donnees de test) et exige la variable d'environnement COMPTOIR_ALLOW_RESET=1.
      if (process.env.COMPTOIR_ALLOW_RESET !== '1') return send(res, 403, { error: 'Remise à zéro désactivée en production (inaltérabilité des données de caisse). Réservée à la phase de test via COMPTOIR_ALLOW_RESET=1.' });
      let body = {}; try { body = await readJson(req); } catch (e) {}
      if (!body || body.confirm !== 'REMISE-A-ZERO') return send(res, 400, { error: 'Confirmation requise', confirmAttendu: 'REMISE-A-ZERO' });
      // 1) Sauvegarde horodatée AVANT toute modification — si elle échoue, on n'efface RIEN.
      let backupName = null;
      try {
        const bdir = pathmod.join(pathmod.dirname(DATA_FILE), 'comptoir-backups');
        if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
        const bf = pathmod.join(bdir, 'comptoir-PRE-RESET-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
        if (fs.existsSync(DATA_FILE)) { fs.copyFileSync(DATA_FILE, bf); backupName = pathmod.basename(bf); }
      } catch (e) { return send(res, 500, { error: 'Sauvegarde pre-reset impossible (' + e.message + ') — remise a zero ANNULEE.' }); }
      const avant = { factures: invoices.length, commandesBorne: orders.length, reassort: supplyOrders.length, grandTotal: gtPerpetuel, evenementsFiscaux: fiscalEvents.length };
      // 2) Remise a zero des ventes + chaine fiscale + commandes (invoices est const -> on vide le tableau en place)
      invoices.length = 0; invoiceSeq = 0; lastHash = 'GENESIS';
      orders.length = 0; orderSeq = 1;
      supplyOrders.length = 0; supplySeq = 1;
      fiscalEvents.length = 0; fiscalSeq = 0; lastFiscalSig = 'GENESIS';
      clotureSeq = { Z: 0, M: 0, A: 0 };
      gtPerpetuel = 0; gtPerpetuelAvoirs = 0;
      seqByB = {}; gtByB = {}; gtAvoirsByB = {}; clotureSeqByB = {};
      // 3) Demarre la NOUVELLE chaine fiscale par un evenement de mise en service (documente le point de depart reel)
      logFiscalEvent('MISE_EN_SERVICE', null, { par: user.name || 'admin', motif: 'Remise a zero avant lancement reel', sauvegarde: backupName });
      persist();
      return send(res, 200, { ok: true, message: 'Systeme remis a zero, pret pour le lancement reel.', sauvegarde: backupName, avant: avant, apres: { factures: invoices.length, commandesBorne: orders.length, reassort: supplyOrders.length, grandTotal: gtPerpetuel, evenementsFiscaux: fiscalEvents.length } });
    }

    // ---------------- CHALLENGE / COMPÉTITION : classement des boutiques par CA (jour + mois) ----------------
    // Leaderboard "Mario Kart" : VISIBLE PAR TOUS les comptes (admin + managers) pour la compétition réseau.
    // Chaque boutique voit en direct où elle se situe vs les autres. #1 = plus gros CA.
    if (req.method === 'GET' && path === '/api/challenge') {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const month = now.toISOString().slice(0, 7);
      const r2 = (n) => Math.round(n * 100) / 100;
      function board(pred) {
        const rows = boutiqueIds().map((id) => {
          const b = boutiques[id];
          const inv = invoices.filter((i) => i.boutiqueId === id && pred(i.date || ''));
          const ca = inv.reduce((a, i) => a + i.total, 0);
          const tickets = inv.filter((i) => i.total >= 0).length;
          return { boutique: id, label: (b && b.label) || id, ca: r2(ca), tickets: tickets };
        });
        rows.sort((a, x) => (x.ca - a.ca) || (x.tickets - a.tickets) || a.label.localeCompare(x.label));
        rows.forEach((row, i) => { row.rang = i + 1; });
        return rows;
      }
      const jour = board((d) => d.slice(0, 10) === today);
      const mois = board((d) => d.slice(0, 7) === month);
      return send(res, 200, {
        generatedAt: now.toISOString(),
        jour: today,
        moisLabel: month,
        you: user.role === 'admin' ? null : user.boutiqueId,
        classementJour: jour,
        classementMois: mois,
      });
    }

    // ---------------- IDENTITÉ DE L'ENTREPRISE (émetteur légal des factures) ----------------
    if (req.method === 'GET' && path === '/api/company') {
      return send(res, 200, { entreprise: entrepriseSafe() });
    }
    if (req.method === 'POST' && path === '/api/company') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      const str = (v) => (v == null ? '' : String(v)).slice(0, 120);
      if ('denomination' in b) entreprise.denomination = str(b.denomination).trim();
      if ('adresse' in b) entreprise.adresse = str(b.adresse).trim();
      if ('codePostal' in b) entreprise.codePostal = str(b.codePostal).trim();
      if ('ville' in b) entreprise.ville = str(b.ville).trim();
      if ('siret' in b) entreprise.siret = str(b.siret).replace(/\s/g, '');
      if ('tva' in b) entreprise.tva = str(b.tva).replace(/\s/g, '').toUpperCase();
      if ('contactPrenom' in b) entreprise.contactPrenom = str(b.contactPrenom).trim();
      if ('contactNom' in b) entreprise.contactNom = str(b.contactNom).trim();
      if ('telephone' in b) entreprise.telephone = str(b.telephone).trim();
      if ('factureAuto' in b) entreprise.factureAuto = !!b.factureAuto;
      persist();
      return send(res, 200, { ok: true, entreprise: entrepriseSafe() });
    }

    // ---------------- FACTURE : données complètes d'une vente, prêtes pour impression ----------------
    if (req.method === 'GET' && path === '/api/facture') {
      const num = u.searchParams.get('num') || '';
      const inv = invoices.find((i) => i.num === num);
      if (!inv) return send(res, 404, { error: 'Facture introuvable' });
      if (user.role !== 'admin' && inv.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Hors de votre boutique' });
      const bq = boutiques[inv.boutiqueId] || {};
      const sl = inv.seller || sellerFor(inv.boutiqueId);
      const em = (inv.emetteur && (inv.emetteur.denomination || inv.emetteur.siret || inv.emetteur.tva)) ? inv.emetteur : entrepriseSafe();
      const lignes = (inv.lines || []).map((l) => {
        const ttc = l.prix;
        const rate = (typeof l.vat === 'number') ? l.vat : 0.2;
        const ht = Math.round((ttc / (1 + rate)) * 100) / 100;
        return { produit: l.produit, detail: l.detail || '', qty: l.qty || null, grams: l.grams || null, prixTTC: ttc, ht: ht, tva: rate };
      });
      const montants = inv.tva
        ? { ht: inv.tva.totalHT, tva: inv.tva.totalTVA, ttc: inv.total, ventilation: inv.tva.ventilation || [] }
        : { ht: Math.round((inv.total / 1.2) * 100) / 100, tva: Math.round((inv.total - inv.total / 1.2) * 100) / 100, ttc: inv.total, ventilation: [] };
      return send(res, 200, {
        numero: inv.num, date: inv.date, avoir: inv.total < 0, refDe: inv.avoirDe || null,
        boutique: inv.boutiqueId, boutiqueLabel: bq.label || inv.boutiqueId,
        vendeur: { name: sl.name, address: sl.address, zip: sl.zip, city: sl.city, country: sl.country || 'FR' },
        emetteur: em, client: inv.client || '', paiement: inv.payment, lignes: lignes, montants: montants,
      });
    }

    // Entrée de stock avec un NUMÉRO DE LOT choisi (produit entrant / arrivage). Admin ou manager (sa boutique).
    // ---- Ajustement manuel du stock : motif OBLIGATOIRE, mouvement trace (persiste + JET) ----
    if (req.method === 'POST' && path === '/api/stock/adjust') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Reserve au personnel' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const p = findProduct(b.productId); if (!p) return send(res, 404, { error: 'Produit introuvable' });
      const motif = String((b && b.motif) || '').trim();
      if (motif.length < 3) return send(res, 400, { error: 'Motif obligatoire (3 caracteres minimum)' });
      const qty = Math.round((Number(b.qty) || 0) * 100) / 100;
      if (!qty || qty <= 0) return send(res, 400, { error: 'Quantite invalide' });
      const sens = b.sens === 'retrait' ? 'retrait' : 'ajout';
      if (!stock[bId]) stock[bId] = {};
      const sk = stock[bId];
      try {
        if (p.unit === 'g') {
          if (!sk[p.id] || !Array.isArray(sk[p.id].lots)) sk[p.id] = { lots: [] };
          if (sens === 'ajout') {
            const lot = (b.lot && String(b.lot).trim()) || ('AJUST-' + new Date().toISOString().slice(2, 16).replace(/[-:T]/g, ''));
            const exp = (b.exp && String(b.exp).trim()) || (function () { const d2 = new Date(); d2.setMonth(d2.getMonth() + 18); return d2.toISOString().slice(0, 7); })();
            sk[p.id].lots.push({ lot: lot, g: qty, exp: exp, coa: (b.coa || '—') });
          } else {
            decrementFEFO(bId, p.id, qty);
          }
        } else {
          if (!sk[p.id] || typeof sk[p.id].units !== 'number') sk[p.id] = { units: 0 };
          if (sens === 'ajout') sk[p.id].units += Math.round(qty);
          else decrementUnits(bId, p.id, Math.round(qty));
        }
      } catch (e) { return send(res, 400, { error: e.message }); }
      const apres = p.unit === 'g' ? totalGrams(sk[p.id]) : sk[p.id].units;
      const move = {
        id: stockMoves.length + 1,
        date: new Date().toISOString(),
        par: user.name || user.role,
        role: user.role,
        boutiqueId: bId,
        productId: p.id, produit: p.name,
        sens: sens, quantite: qty, unite: p.unit === 'g' ? 'g' : 'u',
        motif: motif,
        stockApres: Math.round(apres * 100) / 100,
      };
      stockMoves.push(move);
      try { logFiscalEvent('AJUSTEMENT_STOCK', bId, { produit: p.name, sens: sens, quantite: qty, motif: motif }); } catch (e) {}
      persist();
      return send(res, 201, { ok: true, mouvement: move });
    }

    // ---- Historique des mouvements de stock manuels ----
    if (req.method === 'GET' && path === '/api/stock/moves') {
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const pid = u.searchParams.get('productId') || null;
      const list = stockMoves
        .filter(function (m) { return (!bId || m.boutiqueId === bId) && (!pid || m.productId === pid); })
        .slice(-200).reverse();
      return send(res, 200, { count: list.length, mouvements: list });
    }

    if (req.method === 'POST' && path === '/api/stock/lot') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const p = findProduct(b.productId); if (!p) return send(res, 404, { error: 'Produit introuvable' });
      if (!stock[bId]) stock[bId] = {};
      const sk = stock[bId];
      if (p.unit === 'g') {
        const g = Math.max(0, Number(b.g) || Number(b.qty) || 0); if (g <= 0) return send(res, 400, { error: 'Quantité (g) requise' });
        const lot = (b.lot && String(b.lot).trim()) || ('LOT-' + new Date().toISOString().slice(0, 10));
        const exp = (b.exp && String(b.exp).trim()) || (function () { const d = new Date(); d.setMonth(d.getMonth() + 18); return d.toISOString().slice(0, 7); })();
        if (!sk[p.id] || !Array.isArray(sk[p.id].lots)) sk[p.id] = { lots: [] };
        sk[p.id].lots.push({ lot: lot, g: g, exp: exp });
      } else {
        const units = Math.max(0, Math.floor(Number(b.units) || Number(b.qty) || 0)); if (units <= 0) return send(res, 400, { error: 'Quantité requise' });
        if (!sk[p.id] || typeof sk[p.id].units !== 'number') sk[p.id] = { units: 0 };
        sk[p.id].units += units;
      }
      persist();
      return send(res, 200, { ok: true });
    }

    // ---------------- VUE RÉSEAU (admin) : tous les franchisés d'un coup d'œil ----------------
    if (req.method === 'GET' && path === '/api/network/overview') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const cat = allCatalog();
      const rows = boutiqueIds().map((id) => {
        const bq = boutiques[id]; const sk = stock[id] || {};
        let inStock = 0, low = 0, out = 0;
        for (const p of cat) {
          if (p.boutiqueId && p.boutiqueId !== id) continue;   // produit propre a une autre boutique : hors compteurs
          const s = sk[p.id];
          const q = p.unit === 'g' ? totalGrams(s) : (s ? (s.units || 0) : 0);
          if (q > 0) inStock++;
          if (p.unit === 'g') { if (q > 0 && q <= 10) low++; else if (q <= 0) out++; } else { if (q > 0 && q <= 3) low++; else if (q <= 0) out++; }
        }
        const so = supplyOrders.filter((o) => o.boutiqueId === id);
        const ventes = invoices.filter((i) => i.boutiqueId === id && i.total >= 0);
        return { id: id, label: bq.label || id, siren: (bq.seller && bq.seller.siren) || '', pontOnline: pontOnline(id), pontPaired: pontPaired(id), produitsEnStock: inStock, stockBas: low, ruptures: out, aTraiter: so.filter((o) => o.status === 'envoyee').length, reassortEnCours: so.filter((o) => o.status !== 'recue' && o.status !== 'attente' && o.status !== 'annulee').length, reassortTotal: so.filter((o) => o.status !== 'annulee').length, ventes: ventes.length, ca: Math.round(ventes.reduce((a, i) => a + i.total, 0) * 100) / 100 };
      });
      return send(res, 200, { boutiques: rows, totalProduits: cat.length, totalATraiter: rows.reduce((a, r) => a + r.aTraiter, 0) });
    }

    // ---------------- RÉASSORT PRO (B2B) : les franchisés commandent leur stock au réseau ----------------
    if (req.method === 'GET' && path === '/api/pro/catalog') {
      const usePro = proProducts.length > 0;          // kingbase.fr branche -> le catalogue de gros = kingbase
      const src = usePro ? proProducts : allCatalog().filter((p) => !p.boutiqueId);   // le reassort reseau ignore les produits propres a une boutique
      const list = src.map((p) => {
        const pi = proUnitInfo(p);
        const retail = p.unit === 'g' ? ((p.tiers && p.tiers[0]) ? p.tiers[0][1] : 0) : (p.price || 0);
        const row = { id: p.id, name: p.name, cat: p.cat, img: p.img || '', unit: p.unit, pro: pi ? pi.price : null, proUnit: pi ? pi.unit : 'u', step: pi ? pi.step : 1, retail: usePro ? null : retail, lot: proLots[p.id] || '', stock: (proStock[p.id] != null ? proStock[p.id] : null) };
        if (user.role === 'admin' && proBuyPrice[p.id] != null) row.buyPrice = proBuyPrice[p.id];   // prix d'achat : ADMIN uniquement
        return row;
      });
      const wooOrdersUrl = PRO_WP_URL + '/wp-admin/edit.php?post_type=shop_order';
      return send(res, 200, { rate: usePro ? 1 : proRate, products: list, source: usePro ? 'kingbase' : 'retail', lastSync: usePro ? lastProSync : lastWooSync, autoSync: true, wooOrdersUrl: wooOrdersUrl, wooLive: !!proConnector });
    }
    if (req.method === 'POST' && path === '/api/pro/sync') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Reserve a l administrateur' });
      const r = await syncProCatalog();
      if (r && r.error) return send(res, 502, r);
      return send(res, 200, Object.assign({ ok: true, lastSync: lastProSync }, r));
    }
    // L'admin attribue un n0 de lot a un produit de gros : il sera repris sur chaque nouvelle commande de
    // reassort (ligne de la commande/facture WooCommerce kingbase). Vide => on retire le lot du produit.
    if (req.method === 'POST' && path === '/api/pro/lots') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      const pid = String(b.productId || '').slice(0, 80);
      if (!pid) return send(res, 400, { error: 'Produit manquant' });
      const lot = String(b.lot || '').trim().slice(0, 60);
      if (lot) proLots[pid] = lot; else delete proLots[pid];
      persist();
      return send(res, 200, { ok: true, productId: pid, lot: lot });
    }
    // ---- STOCK & PRIX GROSSISTE (Basecamp / kingbase.fr) : gestion ADMIN dans KINGTOOLS (reference) ----
    if (req.method === 'GET' && path === '/api/pro/stock') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      let vAchat = 0, vGros = 0;
      const rows = proProducts.map((p) => {
        const pi = proUnitInfo(p);
        const stq = proStock[p.id] != null ? proStock[p.id] : null;
        const bp = proBuyPrice[p.id] != null ? proBuyPrice[p.id] : null;
        if (stq != null && bp != null) vAchat += stq * bp;
        if (stq != null && pi.price != null) vGros += stq * pi.price;
        return { id: p.id, name: p.name, cat: p.cat, img: p.img || '', unit: p.unit, wooId: p.wooId || null, proPrice: pi.price, sitePrice: (typeof p.proPrice === 'number' ? p.proPrice : null), sellOverride: proSellPrice[p.id] != null, buyPrice: bp, stock: stq, lot: proLots[p.id] || '' };
      });
      return send(res, 200, { products: rows, valeurAchat: Math.round(vAchat * 100) / 100, valeurGros: Math.round(vGros * 100) / 100, push: { configured: proPushConfigured(), state: proStockPush }, site: PRO_WP_URL });
    }
    if (req.method === 'POST' && path === '/api/pro/stock') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      // Une ligne (productId + champs) ou un LOT de lignes (items:[...]) pour « Tout enregistrer ».
      const reqs = Array.isArray(b.items) ? b.items : [b];
      if (!reqs.length) return send(res, 400, { error: 'Rien à enregistrer.' });
      // 1) VALIDATION complete avant toute ecriture (un lot est applique en entier, ou pas du tout).
      const num = (v) => Math.round(Number(v) * 100) / 100;
      for (const it of reqs) {
        const pid = String((it && it.productId) || '').slice(0, 80);
        const p = proProducts.find((x) => x.id === pid);
        if (!p) return send(res, 404, { error: 'Produit de gros inconnu (' + (pid || '?') + ') — synchronise d\'abord le catalogue kingbase.' });
        if (it.stock !== undefined && it.stock !== null && it.stock !== '' && !(Math.floor(Number(it.stock)) >= 0)) return send(res, 400, { error: 'Quantité invalide (' + p.name + ').' });
        if (it.buyPrice !== undefined && it.buyPrice !== null && it.buyPrice !== '' && !(num(it.buyPrice) >= 0)) return send(res, 400, { error: 'Prix d\'achat invalide (' + p.name + ').' });
        if (it.sellPrice !== undefined && it.sellPrice !== null && it.sellPrice !== '' && !(num(it.sellPrice) >= 0)) return send(res, 400, { error: 'Prix de vente invalide (' + p.name + ').' });
      }
      // 2) APPLICATION
      const pushIds = []; const results = [];
      for (const it of reqs) {
        const pid = String(it.productId).slice(0, 80);
        let touched = false;
        if (it.stock !== undefined) {
          if (it.stock === null || it.stock === '') { if (proStock[pid] != null) { delete proStock[pid]; touched = true; } }
          else { proStock[pid] = Math.floor(Number(it.stock)); touched = true; }
        }
        if (it.delta !== undefined) { const dq = Math.floor(Number(it.delta) || 0); proStock[pid] = Math.max(0, (proStock[pid] || 0) + dq); touched = true; }
        if (it.buyPrice !== undefined) {
          if (it.buyPrice === null || it.buyPrice === '') delete proBuyPrice[pid];
          else proBuyPrice[pid] = num(it.buyPrice);
        }
        if (it.sellPrice !== undefined) {
          if (it.sellPrice === null || it.sellPrice === '') { if (proSellPrice[pid] != null) { delete proSellPrice[pid]; touched = true; } }
          else { const spv = num(it.sellPrice); if (proSellPrice[pid] !== spv) touched = true; proSellPrice[pid] = spv; }
        }
        if (touched && pushIds.indexOf(pid) < 0) pushIds.push(pid);
        results.push({ productId: pid, stock: proStock[pid] != null ? proStock[pid] : null, buyPrice: proBuyPrice[pid] != null ? proBuyPrice[pid] : null, sellPrice: proSellPrice[pid] != null ? proSellPrice[pid] : null });
      }
      persist();
      if (pushIds.length) schedulePushProStock(pushIds);
      const first = results[0] || {};
      return send(res, 200, Array.isArray(b.items) ? { ok: true, saved: results.length, results: results } : Object.assign({ ok: true }, first));
    }
    if (req.method === 'POST' && path === '/api/pro/stock/push') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const r = await pushProStockToWoo(null);
      return send(res, 200, Object.assign({ configured: proPushConfigured() }, r));
    }
    if (req.method === 'POST' && path === '/api/pro/orders') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const items = []; let total = 0;
      for (const it of (Array.isArray(b.items) ? b.items : [])) {
        const p = findProProduct(it.productId); if (!p) continue;
        const pi = proUnitInfo(p); if (!pi) continue;
        const qty = Math.max(0, Math.floor(Number(it.qty) || 0)); if (qty <= 0) continue;
        const up = (pi.price != null ? pi.price : 0);
        const lineTotal = Math.round(up * qty * 100) / 100; total += lineTotal;
        items.push({ productId: p.id, name: p.name, unit: pi.unit, qty: qty, unitPrice: pi.price, lineTotal: lineTotal, lot: proLots[p.id] || '' });
      }
      if (!items.length) return send(res, 400, { error: 'Commande de réassort vide' });
      // STOCK GROSSISTE : refuse la commande si les quantites depassent le disponible (produits suivis).
      const manque = [];
      for (const it of items) { const dispo = proStock[it.productId]; if (dispo != null && it.qty > dispo) manque.push(it.name + ' (' + dispo + ' ' + it.unit + ' dispo)'); }
      if (manque.length) return send(res, 409, { error: 'Stock grossiste insuffisant — ' + manque.join(' · ') });
      total = Math.round(total * 100) / 100;
      // Adresse de LIVRAISON saisie par le franchise (obligatoire cote app). Le grossiste (kingbase) en a besoin
      // pour expedier ; elle alimente l'adresse d'expedition de la commande WooCommerce.
      const ship = (b.ship && typeof b.ship === 'object') ? {
        name: String(b.ship.name || '').slice(0, 120),
        address: String(b.ship.address || '').slice(0, 200),
        zip: String(b.ship.zip || '').slice(0, 20),
        city: String(b.ship.city || '').slice(0, 100),
        phone: String(b.ship.phone || '').slice(0, 40),
      } : null;
      // Statut 'attente' : la commande N'EST PAS validee/transmise au reseau tant que le franchise n'a pas paye.
      // Elle bascule en 'envoyee' (validee) automatiquement quand le paiement Woo est detecte (voir GET ci-dessous).
      const o = { id: supplySeq, numero: 'PRO-' + String(supplySeq).padStart(4, '0'), boutiqueId: bId, items: items, total: total, status: 'attente', ts: Date.now(), by: user.name || null, ship: ship };
      supplySeq++; supplyOrders.push(o);
      // RESERVATION : decremente immediatement le stock grossiste (restaure si la commande est annulee).
      const touchedIds = [];
      for (const it of items) { if (proStock[it.productId] != null) { proStock[it.productId] = Math.max(0, proStock[it.productId] - it.qty); touchedIds.push(it.productId); } }
      if (touchedIds.length) o.stockDebited = true;
      persist();
      if (touchedIds.length) schedulePushProStock(touchedIds);
      // Reflet WooCommerce sur kingbase.fr (site grossiste) : creer une vraie commande (statut pending,
      // PAYABLE par le franchise) que l'admin gere dans Woo. NON bloquant : si kingbase est injoignable /
      // cle absente, la commande de reassort reste valide dans Comptoir.
      try {
        if (proConnector && typeof proConnector.createSupplyOrder === 'function') {
          const sl = sellerFor(bId);
          const shipAddr = o.ship ? { name: o.ship.name || sl.name, address: o.ship.address, zip: o.ship.zip, city: o.ship.city, country: 'FR', phone: o.ship.phone || '' } : null;
          const wr = await proConnector.createSupplyOrder({ items: o.items, boutique: (boutiques[bId] && (boutiques[bId].label || bId)) || bId, numero: o.numero, by: o.by, billing: { name: sl.name, address: sl.address, zip: sl.zip, city: sl.city, country: sl.country || 'FR' }, shipping: shipAddr });
          if (wr && wr.order_id) { o.wooOrderId = wr.order_id; o.wooUrl = wr.admin_url || null; o.payUrl = wr.pay_url || null; o.wooStatus = wr.status || null; persist(); }
        }
      } catch (e) { o.wooError = String((e && e.message) || e); }
      return send(res, 201, { ok: true, order: o });
    }
    if (req.method === 'GET' && path === '/api/pro/orders') {
      // Reflet du paiement : pour les commandes non encore payees ayant une commande Woo, on rafraichit
      // l'etat depuis kingbase (lazy, borne a 10, throttle 60s par commande) afin d'afficher "Paye ✓"
      // et de masquer le bouton "Payer" une fois reglee. Non bloquant en cas d'erreur/timeout.
      if (proConnector && typeof proConnector.getOrderStatus === 'function') {
        const now = Date.now();
        const toRefresh = supplyOrders
          .filter((o) => o.wooOrderId && !o.wooPaid && (now - (o.wooStatusAt || 0) > (o.status === 'attente' ? 12000 : 60000)))
          .filter((o) => user.role === 'admin' || o.boutiqueId === user.boutiqueId)
          .slice(-10);
        if (toRefresh.length) {
          await Promise.allSettled(toRefresh.map(async (o) => {
            try {
              const s = await proConnector.getOrderStatus(o.wooOrderId, { timeoutMs: 7000 });
              o.wooStatusAt = Date.now();
              if (s) { if (s.status) o.wooStatus = s.status; if (s.paid) { o.wooPaid = true; if (o.status === 'attente') { o.status = 'envoyee'; o.paidAt = Date.now(); } } if (s.pay_url) o.payUrl = s.pay_url; }
            } catch (e) { o.wooStatusAt = Date.now(); }
          }));
          persist();
          // Apres detection d'un paiement, re-pousse les quantites de reference vers kingbase :
          // Woo decremente aussi de son cote au paiement, l'envoi ABSOLU depuis KINGTOOLS realigne tout.
          const paidIds = [];
          toRefresh.forEach((o) => { if (o.wooPaid && o.status !== 'attente') (o.items || []).forEach((it) => { if (proStock[it.productId] != null && paidIds.indexOf(it.productId) < 0) paidIds.push(it.productId); }); });
          if (paidIds.length) schedulePushProStock(paidIds);
        }
      }
      const list = supplyOrders.filter((o) => user.role === 'admin' ? true : o.boutiqueId === user.boutiqueId).slice().sort((a, b) => b.id - a.id);
      return send(res, 200, { orders: list });
    }
    // Annuler une commande NON PAYEE (statut 'attente'). Le franchise (sa boutique) ou l'admin uniquement.
    const mProCancel = path.match(/^\/api\/pro\/orders\/(\d+)\/cancel$/);
    if (req.method === 'POST' && mProCancel) {
      const o = supplyOrders.find((x) => x.id === parseInt(mProCancel[1], 10));
      if (!o) return send(res, 404, { error: 'Commande introuvable' });
      if (user.role !== 'admin' && o.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Accès refusé' });
      if (o.status !== 'attente') return send(res, 400, { error: 'Seule une commande non payée peut être annulée' });
      o.status = 'annulee'; o.canceledAt = Date.now();
      // RESTAURATION : une commande annulee rend ses quantites au stock grossiste.
      if (o.stockDebited) {
        const backIds = [];
        for (const it of (o.items || [])) { if (proStock[it.productId] != null) { proStock[it.productId] += it.qty; backIds.push(it.productId); } }
        o.stockDebited = false;
        if (backIds.length) schedulePushProStock(backIds);
      }
      persist();
      return send(res, 200, { ok: true, order: o });
    }
    if (req.method === 'POST' && path === '/api/pro/config') {
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      const r = Number(b.rate);
      if (!(r > 0 && r <= 1)) return send(res, 400, { error: 'Taux invalide (entre 0 et 1, ex. 0.5 = -50%)' });
      proRate = Math.round(r * 100) / 100; persist();
      return send(res, 200, { ok: true, rate: proRate });
    }
    const mProStatus = path.match(/^\/api\/pro\/orders\/(\d+)\/status$/);
    if (req.method === 'POST' && mProStatus) {
      const o = supplyOrders.find((x) => x.id === parseInt(mProStatus[1], 10)); if (!o) return send(res, 404, { error: 'Commande introuvable' });
      const b = await readJson(req);
      const allowed = ['envoyee', 'preparee', 'expediee', 'recue'];
      if (allowed.indexOf(b.status) < 0) return send(res, 400, { error: 'Statut invalide' });
      const isOwnerManager = user.role === 'manager' && o.boutiqueId === user.boutiqueId;
      // « Reçue » = le FRANCHISÉ (ou l'admin) confirme la réception -> le stock entre dans SA boutique.
      // Les statuts intermédiaires (préparée/expédiée) restent gérés par l'admin réseau.
      if (b.status === 'recue') { if (!(user.role === 'admin' || isOwnerManager)) return send(res, 403, { error: 'Réservé au franchisé concerné ou à l\'admin' }); }
      else if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      o.status = b.status;
      if (b.lot != null && String(b.lot).trim()) o.lotRef = String(b.lot).trim();   // l'admin/franchisé peut choisir le n° de lot
      if (typeof b.note === 'string') o.note = b.note;
      if (Array.isArray(b.items)) {                                                  // réserves / ajustements + notes par produit (admin)
        for (const adj of b.items) {
          const it = o.items.find((x) => x.productId === adj.productId); if (!it) continue;
          if (adj.qty != null && Number(adj.qty) >= 0) it.qtyConfirmed = Math.floor(Number(adj.qty));
          if (typeof adj.note === 'string') it.note = adj.note;
        }
        o.totalConfirme = Math.round(o.items.reduce((a, x) => a + ((x.unitPrice != null ? x.unitPrice : 0) * (x.qtyConfirmed != null ? x.qtyConfirmed : x.qty)), 0) * 100) / 100;
      }
      if (b.status === 'recue' && !o.restocked) {
        if (!stock[o.boutiqueId]) stock[o.boutiqueId] = {};
        const sk = stock[o.boutiqueId];
        const exp = (function () { const d = new Date(); d.setMonth(d.getMonth() + 18); return d.toISOString().slice(0, 7); })();
        for (const it of o.items) {
          const qty = (it.qtyConfirmed != null ? it.qtyConfirmed : it.qty);   // quantité réellement envoyée (après réserve)
          if (qty <= 0) continue;
          const ref = String(it.productId || '').toUpperCase();
          const lot = (o.lotRef || o.numero) + '-' + ref;            // n° de lot choisi par l'admin, sinon n° de commande + référence
          if (it.unit === 'g') { if (!sk[it.productId] || !Array.isArray(sk[it.productId].lots)) sk[it.productId] = { lots: [] }; sk[it.productId].lots.push({ lot: lot, g: qty, exp: exp, ref: ref }); }
          else { if (!sk[it.productId] || typeof sk[it.productId].units !== 'number') sk[it.productId] = { units: 0 }; sk[it.productId].units += qty; }
        }
        o.restocked = true;
        o.receivedAt = Date.now();
      }
      persist();
      return send(res, 200, { ok: true, order: o });
    }

    // ---------------- JOURNAL DES VENTES (borne + caisse) + exports comptables ----------------
    if (path === '/api/journal' || path.indexOf('/api/journal/') === 0) {
      if (PG) return send(res, 501, { error: 'Journal indisponible en mode PostgreSQL (prototype)' });
      // Selection commune : scope boutique (admin = toutes, sinon la sienne) + periode + source.
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const from = u.searchParams.get('from') || '';
      const to = u.searchParams.get('to') || '';
      const src = u.searchParams.get('source') || '';
      const inRange = (iso) => { const d = (iso || '').slice(0, 10); if (from && d < from) return false; if (to && d > to) return false; return true; };
      const list = invoices
        .filter((i) => (bId ? i.boutiqueId === bId : true))
        .filter((i) => inRange(i.date))
        .filter((i) => (src ? (i.source || 'caisse') === src : true))
        .slice().sort((a, b) => (a.date < b.date ? 1 : -1));
      const r2 = (n) => Math.round(n * 100) / 100;

      if (req.method === 'GET' && path === '/api/journal') {
        const ventes = list.map((i) => ({
          numero: i.num, date: i.date, source: i.source || 'caisse', boutique: i.boutiqueId,
          client: i.client, paiement: i.payment,
          lignes: (i.lines || []).map((l) => ({ produit: l.produit, detail: l.detail, prix: l.prix, qty: l.qty || null, grams: l.grams || null, vat: l.vat })),
          totalTTC: i.total, totalHT: i.tva ? i.tva.totalHT : null, totalTVA: i.tva ? i.tva.totalTVA : null,
          ventilationTVA: i.tva ? i.tva.ventilation : null, remise: i.remise || 0,
          refunded: !!i.refunded, avoirDe: i.avoirDe || null, empreinte: (i.hash || '').slice(0, 12),
        }));
        return send(res, 200, { count: ventes.length, ventes: ventes });
      }

      if (req.method === 'GET' && path === '/api/journal/stats') {
        let ttc = 0, ht = 0, tva = 0, nb = 0;
        const bySource = {}, byPay = {}, vtMap = {}, byProd = {}, byDay = {};
        list.forEach((i) => {
          ttc += i.total; nb += 1;
          if (i.tva) { ht += i.tva.totalHT; tva += i.tva.totalTVA; }
          const s = i.source || 'caisse';
          bySource[s] = bySource[s] || { nb: 0, ttc: 0 }; bySource[s].nb++; bySource[s].ttc += i.total;
          byPay[i.payment] = (byPay[i.payment] || 0) + i.total;
          const day = (i.date || '').slice(0, 10);
          byDay[day] = byDay[day] || { ttc: 0, nb: 0 }; byDay[day].ttc += i.total; byDay[day].nb++;
          // Ventilation TVA : on agrege la ventilation NETTE stockee par facture (remises/coupons deduits) -> reconcilie avec le CA TTC.
          (i.tva && i.tva.ventilation ? i.tva.ventilation : []).forEach((v) => {
            vtMap[v.taux] = vtMap[v.taux] || { taux: v.taux, baseHT: 0, tva: 0, ttc: 0 };
            vtMap[v.taux].baseHT += v.baseHT; vtMap[v.taux].tva += v.tva; vtMap[v.taux].ttc += v.ttc;
          });
          // Meilleures ventes : CA brut par produit (avant remise panier) -> classement de popularite.
          (i.lines || []).forEach((l) => {
            byProd[l.produit] = byProd[l.produit] || { produit: l.produit, quantite: 0, ca: 0 };
            byProd[l.produit].quantite += (l.qty || l.grams || 1); byProd[l.produit].ca += l.prix;
          });
        });
        const ventilationTVA = Object.keys(vtMap).map((k) => ({ taux: k, baseHT: r2(vtMap[k].baseHT), tva: r2(vtMap[k].tva), ttc: r2(vtMap[k].ttc) }));
        const topProduits = Object.keys(byProd).map((k) => ({ produit: k, quantite: r2(byProd[k].quantite), ca: r2(byProd[k].ca) })).sort((a, b) => b.ca - a.ca).slice(0, 10);
        const parJour = Object.keys(byDay).sort().map((d) => ({ date: d, ttc: r2(byDay[d].ttc), nb: byDay[d].nb }));
        return send(res, 200, {
          periode: { from: from || null, to: to || null }, nbVentes: nb,
          ca: { ttc: r2(ttc), ht: r2(ht), tva: r2(tva) }, panierMoyen: nb ? r2(ttc / nb) : 0,
          parSource: Object.keys(bySource).map((k) => ({ source: k, nb: bySource[k].nb, ttc: r2(bySource[k].ttc) })),
          parPaiement: Object.keys(byPay).map((k) => ({ moyen: k, montant: r2(byPay[k]) })),
          ventilationTVA: ventilationTVA, topProduits: topProduits, parJour: parJour,
        });
      }

      if (req.method === 'GET' && path === '/api/journal/export.csv') {
        const sep = ';';
        const head = ['Date', 'Heure', 'N_facture', 'Source', 'Boutique', 'Client', 'Paiement', 'Total_HT', 'TVA', 'Total_TTC', 'Remise', 'Articles'];
        const csv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const rows = list.map((i) => {
          const d = new Date(i.date); const ok = !isNaN(d);
          const arts = (i.lines || []).map((l) => (l.qty ? l.qty + 'x ' : (l.grams ? l.grams + 'g ' : '')) + l.produit).join(' | ');
          return [ok ? d.toLocaleDateString('fr-FR') : (i.date || '').slice(0, 10), ok ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '',
            i.num, i.source || 'caisse', i.boutiqueId, i.client, i.payment,
            i.tva ? i.tva.totalHT : '', i.tva ? i.tva.totalTVA : '', i.total, i.remise || 0, arts].map(csv).join(sep);
        });
        const text = '﻿' + head.join(sep) + '\n' + rows.join('\n') + '\n';
        res.writeHead(200, Object.assign({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="journal-kingston.csv"' }, res._cors));
        return res.end(text);
      }

      if (req.method === 'GET' && path === '/api/journal/ereporting') {
        const nom = (boutiques[bId] || {}).label || (bId || 'Reseau KINGSTON');
        const periode = (from || 'origine') + ' -> ' + (to || 'aujourd_hui');
        const sales = list.map((i) => ({ total: i.total, payment: i.payment, lines: (i.lines || []).map((l) => ({ vat: l.vat, prix: l.prix })) }));
        return send(res, 200, efacture.ereportingZ(nom, periode, sales));
      }

      if (req.method === 'GET' && path === '/api/journal/facturx') {
        const num = u.searchParams.get('num') || '';
        const inv = list.find((i) => i.num === num) || invoices.find((i) => i.num === num);
        if (!inv) return send(res, 404, { error: 'Facture introuvable' });
        if (user.role !== 'admin' && inv.boutiqueId !== user.boutiqueId) return send(res, 403, { error: 'Hors de votre boutique' });
        const lines = (inv.lines || []).map((l) => ({ label: l.produit + (l.detail ? ' (' + l.detail + ')' : ''), qty: l.qty || 1, ttc: l.prix, vat: l.vat }));
        const xml = efacture.facturxXML({
          number: inv.num, date: (inv.date || '').slice(0, 10).replace(/-/g, ''), seller: SELLER,
          buyer: { name: inv.client || 'Client', siren: '', address: '', zip: '', city: '', country: 'FR' }, lines: lines,
        });
        res.writeHead(200, Object.assign({ 'content-type': 'application/xml; charset=utf-8', 'content-disposition': 'attachment; filename="' + inv.num + '.xml"' }, res._cors));
        return res.end(xml);
      }
    }

    // ---------------- Export comptable : les 3 tableaux que le comptable attend ----------------
    // 1) CA par jour x mode de paiement   2) Detail des paiements   3) Detail des ventes (categories/produits + taxes)
    if (req.method === 'GET' && path === '/api/factu/comptable') {
      if (PG) return send(res, 501, { error: 'Indisponible en mode PostgreSQL (prototype)' });
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || null) : user.boutiqueId;
      const from = u.searchParams.get('from') || '';
      const to = u.searchParams.get('to') || '';
      const inRange = (iso) => { const d = (iso || '').slice(0, 10); if (from && d < from) return false; if (to && d > to) return false; return true; };
      const list = invoices.filter((i) => (bId ? i.boutiqueId === bId : true)).filter((i) => inRange(i.date)).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const r2 = (n) => Math.round(n * 100) / 100;

      // Index categorie (par id produit, sinon par nom)
      const catById = {}, catByName = {};
      try { allCatalog().forEach((p) => { catById[p.id] = p.cat || 'Divers'; catByName[String(p.name || '').toLowerCase()] = p.cat || 'Divers'; }); } catch (e) {}
      const catOf = (l) => (l.productId && catById[l.productId]) || catByName[String(l.produit || l.name || '').toLowerCase()] || 'Divers';
      // Normalisation du mode de paiement -> Especes / Carte (sinon tel quel)
      const payNorm = (p) => { const s = String(p || '').toLowerCase(); if (/esp|cash|liquide/.test(s)) return 'Espèces'; if (/carte|cb|monetico|cic|bancaire|tpe/.test(s)) return 'Carte'; return p || 'Autre'; };

      // 1) Pivot : CA TTC par jour x mode
      const days = {}, modeSet = {};
      list.forEach((i) => { const d = (i.date || '').slice(0, 10); const m = payNorm(i.payment); modeSet[m] = 1; days[d] = days[d] || {}; days[d][m] = (days[d][m] || 0) + i.total; });
      const modes = Object.keys(modeSet).sort();
      const jours = Object.keys(days).sort().map((d) => { const row = { date: d, modes: {}, total: 0 }; modes.forEach((m) => { const v = days[d][m] || 0; row.modes[m] = r2(v); row.total += v; }); row.total = r2(row.total); return row; });
      const totauxMode = {}; let totalGeneral = 0; modes.forEach((m) => { let s = 0; jours.forEach((j) => { s += j.modes[m]; }); totauxMode[m] = r2(s); totalGeneral += s; });
      const parJourMode = { modes: modes, jours: jours, totaux: totauxMode, totalGeneral: r2(totalGeneral) };

      // 2) Detail des paiements (chaque facture = un reglement)
      const paiements = list.map((i) => ({ datetime: i.date, mode: payNorm(i.payment), modeBrut: i.payment, num: i.num, montant: r2(i.total) })).sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
      const parMode = {}; paiements.forEach((p) => { parMode[p.mode] = parMode[p.mode] || { count: 0, total: 0 }; parMode[p.mode].count++; parMode[p.mode].total = r2(parMode[p.mode].total + p.montant); });
      const paiementsParMode = Object.keys(parMode).sort().map((m) => ({ mode: m, count: parMode[m].count, total: parMode[m].total }));

      // 3) Detail des ventes : produits par categorie (qte + HT brut) + taxes par taux (net)
      const catMap = {}, taxMap = {};
      let grossHT = 0;
      list.forEach((i) => {
        (i.lines || []).forEach((l) => {
          const c = catOf(l); const rate = (typeof l.vat === 'number' ? l.vat : 0.20);
          const ttc = Number(l.prix) || 0; const ht = ttc / (1 + rate);
          const q = (l.grams != null ? Number(l.grams) : (Number(l.qty) || 1));
          const unit = (l.grams != null ? 'g' : 'Unité(s)');
          catMap[c] = catMap[c] || { cat: c, qty: 0, ht: 0, prods: {} };
          catMap[c].qty += q; catMap[c].ht += ht; grossHT += ht;
          const key = String(l.produit || l.name || 'Article');
          catMap[c].prods[key] = catMap[c].prods[key] || { name: key, code: l.productId || '', qty: 0, unit: unit, ht: 0 };
          catMap[c].prods[key].qty += q; catMap[c].prods[key].ht += ht;
        });
        // Taxes par taux : on agrege la ventilation NETTE de chaque facture (remises deduites) -> reconcilie avec le TTC encaisse
        const vent = (i.tva && i.tva.ventilation) ? i.tva.ventilation : null;
        if (vent) { vent.forEach((v) => { taxMap[v.taux] = taxMap[v.taux] || { taux: v.taux, baseHT: 0, tva: 0, ttc: 0 }; taxMap[v.taux].baseHT += v.baseHT; taxMap[v.taux].tva += v.tva; taxMap[v.taux].ttc += v.ttc; }); }
        else { (i.lines || []).forEach((l) => { const rate = (typeof l.vat === 'number' ? l.vat : 0.20); const taux = Math.round(rate * 100) + '%'; const ttc = Number(l.prix) || 0; const ht = ttc / (1 + rate); taxMap[taux] = taxMap[taux] || { taux: taux, baseHT: 0, tva: 0, ttc: 0 }; taxMap[taux].baseHT += ht; taxMap[taux].tva += (ttc - ht); taxMap[taux].ttc += ttc; }); }
      });
      const taxes = Object.keys(taxMap).sort().map((t) => ({ taux: t, baseHT: r2(taxMap[t].baseHT), tva: r2(taxMap[t].tva), ttc: r2(taxMap[t].ttc) }));
      const netHT = r2(taxes.reduce((a, v) => a + v.baseHT, 0));
      const totalTVA = r2(taxes.reduce((a, v) => a + v.tva, 0));
      const totalTTC = r2(taxes.reduce((a, v) => a + v.ttc, 0));
      const categories = Object.keys(catMap).sort().map((c) => { const o = catMap[c]; return { cat: c, qty: r2(o.qty), ht: r2(o.ht), produits: Object.keys(o.prods).map((k) => { const p = o.prods[k]; return { name: p.name, code: p.code, qty: r2(p.qty), unit: p.unit, ht: r2(p.ht) }; }).sort((a, b) => b.ht - a.ht) }; });
      // Ligne de remise/fidelite pour reconcilier les ventes (brut) avec le net encaisse (comme Odoo).
      // Seuil 0,05 EUR : on ignore le simple bruit d'arrondi, on ne montre la ligne que pour de vraies remises.
      const diff = r2(netHT - r2(grossHT));
      if (Math.abs(diff) >= 0.05) categories.push({ cat: 'Remises & fidélité', qty: 0, ht: diff, produits: [{ name: 'Remises fidélité, coupons & ajustements', code: '', qty: 0, unit: '', ht: diff }] });

      const sl = sellerFor(bId);
      return send(res, 200, {
        meta: {
          from: from || null, to: to || null, boutique: bId, boutiqueLabel: (boutiques[bId] || {}).label || 'Réseau KINGSTON',
          seller: { name: sl.name, address: sl.address, zip: sl.zip, city: sl.city, siren: sl.siren, vat: sl.vat }, nbVentes: list.length, genereLe: new Date().toISOString(),
        },
        parJourMode: parJourMode,
        paiements: { lignes: paiements, parMode: paiementsParMode },
        ventes: { categories: categories, totalQty: r2(Object.keys(catMap).reduce((a, c) => a + catMap[c].qty, 0)), totalHT: netHT, taxes: taxes, totalTVA: totalTVA, totalTTC: totalTTC, paiements: paiementsParMode },
      });
    }

    return send(res, 404, { error: 'Route inconnue : ' + path });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
});

loadPersisted();
if (!PG) {
  // Clé de scellement fiscal : stockée DANS UN FICHIER DÉDIÉ protégé (mode 600), hors du fichier de données.
  const FISCAL_KEY_FILE = process.env.COMPTOIR_FISCAL_KEY_FILE || pathmod.join(pathmod.dirname(DATA_FILE), '.comptoir_fiscal_key');
  try { fs.mkdirSync(pathmod.dirname(FISCAL_KEY_FILE), { recursive: true }); } catch (e) {}
  const migrated = fiscalKey; // éventuelle clé héritée de l'ancien fichier de données (migration)
  fiscalKey = '';
  try { if (fs.existsSync(FISCAL_KEY_FILE)) fiscalKey = fs.readFileSync(FISCAL_KEY_FILE, 'utf8').trim(); } catch (e) { console.error('Cle fiscale : lecture impossible :', e.message); }
  if (!fiscalKey) fiscalKey = migrated || crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(FISCAL_KEY_FILE, fiscalKey, { mode: 0o600 }); } catch (e) { console.error('Cle fiscale : ecriture impossible :', e.message); }

  // Migration unique : Grand Total perpétuel à partir de l'historique des factures.
  if (gtPerpetuel === 0 && gtPerpetuelAvoirs === 0 && invoices.length && !fiscalEvents.some((e) => /^CLOTURE_/.test(e.type))) {
    for (const inv of invoices) { if (inv.total >= 0) gtPerpetuel += inv.total; else gtPerpetuelAvoirs += inv.total; }
    gtPerpetuel = Math.round(gtPerpetuel * 100) / 100; gtPerpetuelAvoirs = Math.round(gtPerpetuelAvoirs * 100) / 100;
  }
  // Backfill : sceller en HMAC les factures existantes non scellées.
  let sealed = 0;
  for (const inv of invoices) { if (inv.seal == null && inv.hash) { inv.seal = sealInvoice(invoiceBody(inv), inv.hash); sealed++; } }

  persist();
  logFiscalEvent('DEMARRAGE', null, { version: 'comptoir-1', port: PORT, node: process.version });

  if (usingDefaultPass) console.log('ATTENTION : mot(s) de passe par defaut « kingston ». Definir COMPTOIR_PASS_ADMIN / _AIX / _MARSEILLE en production.');
  if (SELLER.siren === '000000000') console.log('ATTENTION : SIREN/TVA non renseignes. Definir COMPTOIR_SELLER_SIREN / _VAT avant toute facture reelle.');
  if (sealed) console.log('Conformite : ' + sealed + ' facture(s) historique(s) scellee(s) en HMAC.');
}
server.listen(PORT, () => {
  console.log('Comptoir API en ecoute sur http://localhost:' + PORT + '  | fidelite : ' + LOYALTY_MODE);
  console.log('Conformite caisse (NF525) : ' + fiscalEvents.length + ' evenement(s) scelle(s), Grand Total perpetuel = ' + gtPerpetuel.toFixed(2) + ' EUR.');
});

// Planificateur de sauvegarde externe : verification toutes les 30 min, envoi si la derniere
// sauvegarde reussie date de plus de 24 h (donc ~1 envoi par jour, quel que soit l'horaire de redemarrage).
if (!PG) {
  const bkTick = () => {
    try {
      if (!bkConfigured() || bkRunning) return;
      if (Date.now() - (backupState.lastOkAt || 0) < 24 * 3600 * 1000) return;
      bkRun('auto').then((r) => {
        if (r.ok) console.log('Sauvegarde externe OK (' + r.bytes + ' octets -> ' + r.keys.join(', ') + ')');
        else console.error('Sauvegarde externe echouee :', r.error);
      });
    } catch (e) {}
  };
  setTimeout(bkTick, 90 * 1000);
  setInterval(bkTick, 30 * 60 * 1000).unref();
  if (!bkConfigured()) console.log('INFO : sauvegarde externe non configuree (KT_BACKUP_S3_*) — les donnees ne sont copiees nulle part hors du serveur.');
}

// Synchro catalogue WooCommerce (reassort « en direct ») : au demarrage (differee) puis toutes les heures.
// Desactivable avec COMPTOIR_WOO_SYNC=0.
if (!PG && process.env.COMPTOIR_WOO_SYNC !== '0') {
  setTimeout(function () { syncWooCatalog({}).then(function (r) { if (r && !r.error) console.log('Synchro Woo au demarrage : ' + (r.created || 0) + ' crees, ' + (r.updated || 0) + ' maj.'); }).catch(function () {}); }, 15000);
  setInterval(function () { syncWooCatalog({}).catch(function () {}); }, 60 * 60 * 1000);
}

// Synchro catalogue GROSSISTE kingbase.fr (reassort B2B) : au demarrage (differee) puis toutes les heures.
if (!PG && PRO_WP_URL && process.env.COMPTOIR_PRO_SYNC !== '0') {
  setTimeout(function () { syncProCatalog().then(function (r) { if (r && !r.error) console.log('Synchro kingbase au demarrage : ' + (r.count || 0) + ' produits de gros.'); }).catch(function () {}); }, 20000);
  setInterval(function () { syncProCatalog().catch(function () {}); }, 60 * 60 * 1000);
}
