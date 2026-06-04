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
};
function serveStatic(res, file) {
  fs.readFile(pathmod.join(__dirname, file), function (err, data) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache', 'expires': '0' });
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
function rebuildAccounts() {
  for (const k of Object.keys(credentials)) delete credentials[k];
  accounts = { admin: { name: 'Lenny K.', role: 'admin', boutiqueId: null } };
  { const p = process.env.COMPTOIR_PASS_ADMIN; if (!p) usingDefaultPass = true; credentials.admin = { hash: hashPass(p || DEFAULT_PASS) }; }
  for (const id of boutiqueIds()) {
    const b = boutiques[id];
    accounts[id] = { name: 'Manager ' + (b.label || id), role: 'manager', boutiqueId: id };
    const envp = process.env['COMPTOIR_PASS_' + id.toUpperCase()];
    if (envp) credentials[id] = { hash: hashPass(envp) };
    else if (b.cred && b.cred.salt) credentials[id] = { stored: b.cred };
    else { credentials[id] = { hash: hashPass(DEFAULT_PASS) }; usingDefaultPass = true; }
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
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// Jeton de service OPTIONNEL pour l'automatisation/intégrations (réglé par l'exploitant, jamais en dur).
const API_TOKEN = process.env.COMPTOIR_API_TOKEN || '';
function newSession(user) { const a = accounts[user]; const token = crypto.randomBytes(24).toString('hex'); sessions[token] = { name: a.name, role: a.role, boutiqueId: a.boutiqueId, exp: Date.now() + SESSION_TTL }; return token; }
function sessionUser(token) {
  if (!token) return null;
  if (API_TOKEN && token === API_TOKEN) return { name: 'Service', role: 'admin', boutiqueId: null };
  const s = sessions[token]; if (!s) return null;
  if (s.exp <= Date.now()) { delete sessions[token]; return null; }
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
    if (!stock[id]) stock[id] = {};
    if (!stock[id][p.id]) stock[id][p.id] = (p.unit === 'g') ? { lots: [] } : { units: 0 };
  }
}
const IMG_DIR = process.env.COMPTOIR_IMG_DIR || pathmod.join(__dirname, 'img');

// ---- Réassort pro (B2B) : les franchisés commandent leur stock au réseau. Prix de gros = prix public x proRate ----
let proRate = Number(process.env.COMPTOIR_PRO_RATE || 0.5);   // 0.5 = -50% du prix public (réglable par l'admin)
let supplyOrders = [];      // commandes de réassort (B2B)
let supplySeq = 1;

// ---- Relais terminal de paiement (kingtools.fr <-> pont de la boutique <-> TPE) ----
const pontDevices = {};         // deviceId -> { code, boutiqueId, ip, tcpPort, lastSeen } (appairage initie par le pont)
const pontCmds = {};            // boutiqueId -> [ {id, amount, ref, status:'pending'|'sent'|'done', approved, ...} ]
let pontCmdSeq = 1;
function pontDeviceByCode(code) { code = String(code || '').trim().toUpperCase(); if (!code) return null; for (const k of Object.keys(pontDevices)) if (pontDevices[k].code === code) return pontDevices[k]; return null; }
function pontDeviceForBoutique(id) { let best = null; for (const k of Object.keys(pontDevices)) { const d = pontDevices[k]; if (d.boutiqueId === id && (!best || (d.lastSeen || 0) > (best.lastSeen || 0))) best = d; } return best; } // pont le plus recemment vu (= le pont vivant, pas une vieille inscription)
function pontOnline(id) { const d = pontDeviceForBoutique(id); return !!d && (Date.now() - (d.lastSeen || 0)) < 12000; }
function pontPaired(id) { return !!pontDeviceForBoutique(id); }
function genShortCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.randomBytes(6); for (let i = 0; i < 6; i++) s += a[r[i] % a.length]; return s; }
function proUnitInfo(p) {
  // Prix de gros fixé MANUELLEMENT par l'admin (p.proPrice). Tant qu'il n'est pas defini -> price=null
  // (le franchise commande quand meme ses quantites ; le prix sera ajoute plus tard).
  return { unit: p.unit === 'g' ? 'g' : 'u', step: p.unit === 'g' ? 25 : 10, price: (typeof p.proPrice === 'number' ? p.proPrice : null) };
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
let gtByB = {};             // { boutiqueId: Grand Total perpetuel TTC de CETTE boutique }
let gtAvoirsByB = {};       // { boutiqueId: cumul des avoirs de CETTE boutique }
let clotureSeqByB = {};     // { boutiqueId: { Z, M, A } }
function fb(id) { if (seqByB[id] == null) seqByB[id] = 0; if (gtByB[id] == null) gtByB[id] = 0; if (gtAvoirsByB[id] == null) gtAvoirsByB[id] = 0; if (!clotureSeqByB[id]) clotureSeqByB[id] = { Z: 0, M: 0, A: 0 }; return id; }

/* ----------------------------- Identite vendeur (e-facture / e-reporting) ---------------------------- */
// Identite par defaut du reseau. CHAQUE boutique porte sa PROPRE identite (boutiques[id].seller, souvent
// un SIREN distinct) ; on retombe sur celle-ci tant qu'une boutique n'a pas renseigne la sienne.
const SELLER = SELLER_DEFAULT;
function sellerFor(boutiqueId) { const b = boutiques[boutiqueId]; return (b && b.seller) || SELLER_DEFAULT; }

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
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), pointsPerEuro: POINTS_PER_EURO, hideBaseCatalog, customProducts, stock, boutiques, invoiceSeq, lastHash, invoices, orderSeq, orders, fiscalEvents, fiscalSeq, lastFiscalSig, clotureSeq, gtPerpetuel, gtPerpetuelAvoirs, seqByB, gtByB, gtAvoirsByB, clotureSeqByB, supplyOrders, supplySeq, proRate, pontDevices }), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Persistance impossible :', e.message); }
  }, 200);
}
function loadPersisted() {
  if (PG) return;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
    if (d.clotureSeqByB && typeof d.clotureSeqByB === 'object') clotureSeqByB = d.clotureSeqByB;
    if (Array.isArray(d.supplyOrders)) supplyOrders = d.supplyOrders;
    if (d.pontDevices && typeof d.pontDevices === 'object') Object.assign(pontDevices, d.pontDevices);
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
    seller: { name: sl.name, siren: sl.siren, vat: sl.vat, address: sl.address, zip: sl.zip, city: sl.city, country: sl.country } });
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
  for (const inv of invoices.slice().sort((a, b) => a.seq - b.seq)) {
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

const server = http.createServer(async (req, res) => {
  res._cors = corsFor(req);
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
    const allowed = ['nouveau', 'preparation', 'prete', 'servie'];
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
    const list = allCatalog().map((p) => {
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
  if (req.method === 'POST' && path === '/api/login') {
    const body = await readJson(req);
    if (PG) {
      const r = await PG.authenticate(body && body.user, body && body.password);
      if (!r) return send(res, 401, { error: 'Identifiants invalides' });
      return send(res, 200, r);
    }
    const uname = body && body.user;
    if (!accounts[uname] || !checkPass(uname, body && body.password)) return send(res, 401, { error: 'Identifiants invalides' });
    const token = newSession(uname);
    const a = accounts[uname];
    return send(res, 200, { token: token, name: a.name, role: a.role, boutiqueId: a.boutiqueId });
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

  // Authentification (prototype : un jeton -> un utilisateur avec role + boutique)
  const user = PG ? await PG.contextFromToken(req.headers['x-comptoir-token']) : sessionUser(req.headers['x-comptoir-token']);
  if (!user) return send(res, 401, { error: 'Session expirée ou invalide — reconnecte-toi.' });

  try {
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
    if (req.method === 'GET' && path === '/api/products') {
      if (PG) return send(res, 200, await PG.getProducts(user, u.searchParams.get('boutique')));
      const bId = user.role === 'admin' ? (u.searchParams.get('boutique') || 'aix') : user.boutiqueId;
      const products = allCatalog().map((p) => {
        const s = (stock[bId] || {})[p.id];
        const base = { id: p.id, name: p.name, cat: p.cat, unit: p.unit, img: p.img || '', desc: p.desc || '', custom: !!p.custom };
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
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
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
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const b = await readJson(req);
      const name = (b.name || '').trim();
      if (!name) return send(res, 400, { error: 'Nom du produit requis' });
      const unit = b.unit === 'g' ? 'g' : 'u';
      const p = { id: 'cp' + Date.now().toString(36), name: name, cat: (b.cat || 'Divers').trim(), unit: unit, custom: true, img: b.img || '', desc: (b.desc || '').trim() };
      if (typeof b.proPrice === 'number') p.proPrice = Math.round(b.proPrice * 100) / 100;   // prix de gros (réassort)
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
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
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
      if (user.role !== 'admin') return send(res, 403, { error: 'Réservé à l\'administrateur réseau' });
      const id = decodeURIComponent(mProd[1]);
      const p = customProducts.find((x) => x.id === id);
      if (!p) return send(res, 404, { error: 'Seuls les produits ajoutés depuis l\'app sont modifiables ici.' });
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
      if (typeof b.proPrice === 'number') p.proPrice = Math.round(b.proPrice * 100) / 100; else if (b.proPrice === null) delete p.proPrice; // prix de gros (réassort), réglé par l'admin
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
      if (typeof fetch === 'undefined') return send(res, 500, { error: 'fetch indisponible (Node 18+ requis)' });
      const body = await readJson(req);
      const baseUrl = (body.siteUrl || process.env.COMPTOIR_WP_URL || 'https://kingston-cbd.fr').replace(/\/$/, '');
      const apiBase = baseUrl + '/wp-json/wc/store/v1/products';
      const bId = user.role === 'admin' ? (body.boutiqueId || 'aix') : user.boutiqueId;
      const defStock = body.stock === 'zero' ? 0 : (Number(body.defaultStock) || 200);
      let list;
      try { const r = await fetch(apiBase + '?per_page=100'); list = await r.json(); } catch (e) { return send(res, 502, { error: 'Site injoignable : ' + e.message }); }
      if (!Array.isArray(list)) return send(res, 502, { error: 'Réponse du site inattendue (Store API WooCommerce introuvable)' });
      const seen = {}; customProducts.forEach((p) => { seen[(p.name || '').toLowerCase()] = true; });
      let created = 0, skipped = 0, errors = 0;
      for (const wp of list) {
        const name = (wp.name || '').trim();
        if (!name || seen[name.toLowerCase()]) { skipped++; continue; }
        try {
          const mu = (wp.prices && wp.prices.currency_minor_unit) || 2;
          const div = Math.pow(10, mu);
          const prod = {
            id: 'cp' + Date.now().toString(36) + created,
            name: name,
            cat: (wp.categories && wp.categories[0] && wp.categories[0].name) || 'Boutique',
            custom: true,
            img: (wp.images && wp.images[0] && wp.images[0].src) || '',
            desc: (wp.short_description || wp.description || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
          };
          if (wp.type === 'variable' && Array.isArray(wp.variations) && wp.variations.length) {
            const tiers = [];
            for (const v of wp.variations) {
              let vp; try { vp = await (await fetch(apiBase + '/' + v.id)).json(); } catch (e) { continue; }
              const wTxt = (v.attributes || []).map((a) => a.value).join(' ');
              const grams = parseFloat(String(wTxt).replace(',', '.'));
              const price = Math.round((Number(vp.prices && vp.prices.price) / div) * 100) / 100;
              if (grams > 0 && isFinite(price)) tiers.push([grams, price]);
            }
            tiers.sort((a, b2) => a[0] - b2[0]);
            if (!tiers.length) { skipped++; continue; }
            prod.unit = 'g'; prod.tiers = tiers;
          } else {
            prod.unit = 'u';
            prod.price = Math.round((Number(wp.prices && wp.prices.price) / div) * 100) / 100;
          }
          customProducts.push(prod);
          ensureStock(prod);
          if (defStock > 0) {
            if (prod.unit === 'g') stock[bId][prod.id] = { lots: [{ lot: 'SITE-' + (created + 1), g: defStock, exp: '2099-01' }] };
            else stock[bId][prod.id] = { units: defStock };
          }
          seen[name.toLowerCase()] = true;
          created++;
        } catch (e) { errors++; }
      }
      hideBaseCatalog = true; // remplacer la démo par le catalogue du site
      persist();
      return send(res, 200, { ok: true, created: created, skipped: skipped, errors: errors, total: list.length, hideBase: true });
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
      if (PG) {
        const out = await PG.recordSale(user, { items: body.items || [], customerEmail: body.customerRef, payment: body.payment || 'Carte Monetico', boutiqueId: body.boutiqueId });
        let fidelite = 'client au comptoir';
        if (body.customerRef) {
          const r = await loyalty.earnFromSale(body.customerRef, out.facture.total, out.facture.numero);
          fidelite = { membre: body.customerRef, pointsGagnes: Math.round(out.facture.total * POINTS_PER_EURO), nouveauSolde: r.points };
        }
        const lignes = out.lignes.map((l) => ({ produit: l.label, detail: l.grams ? l.grams + ' g' : (l.qty + ' x'), prix: l.price }));
        return send(res, 201, { facture: out.facture, lignes: lignes, fidelite: fidelite });
      }
      const bId = user.role === 'admin' ? (body.boutiqueId || 'aix') : user.boutiqueId;
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new Error('Aucun article dans la vente');

      const lines = [];
      let brut = 0;
      for (const it of items) {
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

      return send(res, 201, {
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
        return { id: id, label: b.label || id, prefix: b.prefix || id.toUpperCase().slice(0, 4), seller: b.seller || SELLER_DEFAULT, motDePasseDefini: hasPass };
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
      boutiques[id] = rec;
      if (!stock[id]) stock[id] = {};                                    // stock de la boutique
      fb(id);                                                            // etat fiscal de la boutique
      rebuildAccounts();                                                 // compte manager cree/mis a jour
      persist();
      return send(res, 200, { ok: true, boutique: { id: id, label: rec.label, prefix: rec.prefix, seller: rec.seller, motDePasseDefini: !!(rec.cred || process.env['COMPTOIR_PASS_' + id.toUpperCase()]) } });
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

    if (req.method === 'GET' && path === '/api/dashboard') {
      if (PG) return send(res, 200, await PG.dashboard(user));
      const scope = user.role === 'admin' ? boutiqueIds() : [user.boutiqueId];
      const dashboard = scope.map((id) => {
        const inv = invoices.filter((i) => i.boutiqueId === id);
        return { boutique: id, tickets: inv.length, ca: Math.round(inv.reduce((a, i) => a + i.total, 0) * 100) / 100 };
      });
      return send(res, 200, { role: user.role, voitLesBoutiques: scope, dashboard });
    }

    // Entrée de stock avec un NUMÉRO DE LOT choisi (produit entrant / arrivage). Admin ou manager (sa boutique).
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
          const s = sk[p.id];
          const q = p.unit === 'g' ? totalGrams(s) : (s ? (s.units || 0) : 0);
          if (q > 0) inStock++;
          if (p.unit === 'g') { if (q > 0 && q <= 10) low++; else if (q <= 0) out++; } else { if (q > 0 && q <= 3) low++; else if (q <= 0) out++; }
        }
        const so = supplyOrders.filter((o) => o.boutiqueId === id);
        const ventes = invoices.filter((i) => i.boutiqueId === id && i.total >= 0);
        return { id: id, label: bq.label || id, siren: (bq.seller && bq.seller.siren) || '', pontOnline: pontOnline(id), pontPaired: pontPaired(id), produitsEnStock: inStock, stockBas: low, ruptures: out, aTraiter: so.filter((o) => o.status === 'envoyee').length, reassortEnCours: so.filter((o) => o.status !== 'recue').length, reassortTotal: so.length, ventes: ventes.length, ca: Math.round(ventes.reduce((a, i) => a + i.total, 0) * 100) / 100 };
      });
      return send(res, 200, { boutiques: rows, totalProduits: cat.length, totalATraiter: rows.reduce((a, r) => a + r.aTraiter, 0) });
    }

    // ---------------- RÉASSORT PRO (B2B) : les franchisés commandent leur stock au réseau ----------------
    if (req.method === 'GET' && path === '/api/pro/catalog') {
      const list = allCatalog().map((p) => {
        const pi = proUnitInfo(p);
        const retail = p.unit === 'g' ? ((p.tiers && p.tiers[0]) ? p.tiers[0][1] : 0) : (p.price || 0);
        return { id: p.id, name: p.name, cat: p.cat, img: p.img || '', unit: p.unit, pro: pi ? pi.price : null, proUnit: pi ? pi.unit : 'u', step: pi ? pi.step : 1, retail: retail };
      });
      return send(res, 200, { rate: proRate, products: list });
    }
    if (req.method === 'POST' && path === '/api/pro/orders') {
      if (user.role !== 'admin' && user.role !== 'manager') return send(res, 403, { error: 'Réservé au personnel' });
      const b = await readJson(req);
      const bId = user.role === 'admin' ? (b.boutiqueId || 'aix') : user.boutiqueId;
      const items = []; let total = 0;
      for (const it of (Array.isArray(b.items) ? b.items : [])) {
        const p = findProduct(it.productId); if (!p) continue;
        const pi = proUnitInfo(p); if (!pi) continue;
        const qty = Math.max(0, Math.floor(Number(it.qty) || 0)); if (qty <= 0) continue;
        const up = (pi.price != null ? pi.price : 0);
        const lineTotal = Math.round(up * qty * 100) / 100; total += lineTotal;
        items.push({ productId: p.id, name: p.name, unit: pi.unit, qty: qty, unitPrice: pi.price, lineTotal: lineTotal });
      }
      if (!items.length) return send(res, 400, { error: 'Commande de réassort vide' });
      total = Math.round(total * 100) / 100;
      const o = { id: supplySeq, numero: 'PRO-' + String(supplySeq).padStart(4, '0'), boutiqueId: bId, items: items, total: total, status: 'envoyee', ts: Date.now(), by: user.name || null };
      supplySeq++; supplyOrders.push(o); persist();
      return send(res, 201, { ok: true, order: o });
    }
    if (req.method === 'GET' && path === '/api/pro/orders') {
      const list = supplyOrders.filter((o) => user.role === 'admin' ? true : o.boutiqueId === user.boutiqueId).slice().sort((a, b) => b.id - a.id);
      return send(res, 200, { orders: list });
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
