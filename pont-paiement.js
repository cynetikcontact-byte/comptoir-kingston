'use strict';
/**
 * Pont de paiement TPE — protocole CAISSE-AP (ex-CONCERT) — KINGSTON / Comptoir.
 * ---------------------------------------------------------------------------
 * Fait le lien entre la caisse / la borne (pages web) et le terminal de
 * paiement (Monetico CM-CIC ou tout TPE conforme CAISSE-AP), en serie/USB ou IP.
 *
 * La CONFIG (mode + port/IP) se regle DEPUIS LE LOGICIEL (Reglages -> Terminal
 * de paiement) : rien a editer a la main. Elle est memorisee dans tpe-config.json.
 *
 * Modes : "simulation" (defaut, repond accepte) | "ip" | "serial".
 *
 * ⚠️ A COMPLETER avec la doc officielle CAISSE-AP : seules buildRequest() et
 *    parseResponse() dependent de la spec. Tout le reste est pret.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const pathmod = require('path');

const PORT = parseInt(process.env.PONT_PORT || '3002', 10);
const TPE_TIMEOUT = parseInt(process.env.TPE_TIMEOUT_MS || '90000', 10); // un paiement carte peut durer ~1 min
const CONFIG_FILE = pathmod.join(__dirname, 'tpe-config.json');
// PRODUCTION : mettre PONT_REQUIRE_REAL=1 -> interdit le mode simulation (qui accepte tout sans carte).
const REQUIRE_REAL = process.env.PONT_REQUIRE_REAL === '1';

// Config du terminal — reglable depuis le logiciel, persistee sur disque.
let cfg = {
  mode: process.env.TPE_MODE || 'simulation',
  serialPort: process.env.TPE_SERIAL_PORT || '',
  baud: parseInt(process.env.TPE_SERIAL_BAUD || '9600', 10),
  ip: process.env.TPE_IP || '',
  tcpPort: parseInt(process.env.TPE_TCP_PORT || '8888', 10),
  // Mode cloud : le pont s'appaire a kingtools.fr et recoit les ordres de paiement (caisse iPad / multi-appareils).
  server: process.env.KT_SERVER || 'https://kingtools.fr',   // serveur Kingtools
  deviceId: '',                              // identifiant unique de ce pont (genere au 1er lancement)
  setupToken: process.env.KT_SETUP_TOKEN || '',   // jeton de boutique : le pont s'appaire TOUT SEUL (libre-service)
  autoDiscover: process.env.TPE_AUTODISCOVER !== '0', // detecte l'IP du terminal sur le reseau automatiquement
};
function loadCfg() { try { if (fs.existsSync(CONFIG_FILE)) cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { console.error('Pont : lecture config impossible :', e.message); } }
function saveCfg() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('Pont : ecriture config impossible :', e.message); } }
loadCfg();
if (!cfg.deviceId) { cfg.deviceId = require('crypto').randomBytes(16).toString('hex'); saveCfg(); }
// L'installateur (LaunchAgent) impose le jeton + serveur via variables d'env : elles gagnent toujours.
if (process.env.KT_SETUP_TOKEN) cfg.setupToken = process.env.KT_SETUP_TOKEN;
if (process.env.KT_SERVER) cfg.server = process.env.KT_SERVER;
var PAIR = { claimed: false, code: '', boutique: null };   // etat d'appairage, affiche sur la page d'etat (/)

// CORS restreint : on n'autorise que les origines locales (la borne/caisse servies en localhost).
function corsFor(req) {
  const o = req.headers.origin || '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  // Caisse hebergee (kingtools.fr) ouverte sur CET ordinateur : on l'autorise aussi a piloter le terminal local.
  const allowedRemote = /^https:\/\/(www\.)?kingtools\.fr$/.test(o) || (!!process.env.PONT_ALLOW_ORIGIN && o === process.env.PONT_ALLOW_ORIGIN);
  const h = { 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-private-network': 'true' };
  if (o && (local || allowedRemote)) h['access-control-allow-origin'] = o;     // origine connue -> on la reflète
  else if (!o) h['access-control-allow-origin'] = '*';      // appel sans origine (curl, app native) -> toléré
  return h;
}
function send(res, status, obj) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, res._cors || {}));
  res.end(JSON.stringify(obj, null, 2));
}
function readJson(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } }); });
}

/* =========================================================================
 *  PROTOCOLE CAISSE-AP — les 2 seules fonctions a finaliser avec la spec.
 * ========================================================================= */
// === Protocole CAISSE-AP sur IP (Concert V3) — format exact (ref: akretion/caisse-ap-ip) ===
// Chaque champ = tag(2) + longueur sur 3 chiffres + valeur. Pas de cadrage (ni STX/ETX ni LRC).
// La demande commence TOUJOURS par CZ. Tags obligatoires : CZ, CJ, CA, CB, CD, CE.
const TPE_IPC = process.env.TPE_IPC || '012345678901'; // Identifiant Protocole Concert (defaut ref akretion)
function apField(tag, value) { value = String(value); return tag + String(value.length).padStart(3, '0') + value; }
function buildRequest(amountEuros, ref) {
  let cents = String(Math.round(Math.abs(amountEuros) * 100));
  if (cents.length < 2) cents = cents.padStart(2, '0');
  const sens = amountEuros >= 0 ? '0' : '1'; // CD : 0 = debit, 1 = remboursement
  // CZ doit etre en premier ; l'ordre des autres champs est libre.
  const msg =
    apField('CZ', '0300') +        // version du protocole Caisse-AP
    apField('CJ', TPE_IPC) +       // IPC
    apField('CA', '01') +          // numero de caisse
    apField('CE', '978') +         // monnaie : EUR
    apField('BA', '0') +           // 0 = reponse en fin de transaction
    apField('CD', sens) +          // sens
    apField('CB', cents);          // montant en centimes
  return Buffer.from(msg, 'ascii');
}
function parseResponse(buf) {
  let s = buf.toString('ascii');
  const start = s.indexOf('CZ'); // le terminal peut prefixer sa reponse : on se cale sur le 1er tag CZ
  if (start > 0) s = s.slice(start);
  const fields = {};
  let i = 0;
  while (i + 5 <= s.length) {
    const tag = s.substr(i, 2);
    const size = parseInt(s.substr(i + 2, 3), 10);
    if (!/^[A-Z]{2}$/.test(tag) || isNaN(size)) break;
    fields[tag] = s.substr(i + 5, size);
    i += 5 + size;
  }
  const ae = fields.AE || '';
  // AE : 10 = operation faite (accepte), 01 = operation non faite (echec), 11 = prise en compte (BA=1).
  // AF (sur echec) : 11 abandon, 08 timeout, 04 refus, 05 interdit, 09 tags manquants.
  return {
    approved: ae === '10',
    codeReponse: ae || '?',
    echec: fields.AF || null,
    autorisation: fields.AC || null,
    carte: fields.AA || null,
    raw: buf.toString('ascii'),
    fields: fields,
  };
}

/* ----------------------------- Transports ----------------------------- */
function payViaSimulation(amount, ref, cb) {
  setTimeout(() => cb(null, { approved: true, mode: 'simulation', montant: amount, ref: ref || null, codeReponse: '00' }), 1600);
}
function connectAndPay(ip, amount, ref, cb) {
  paymentBusy = true;
  let buf = Buffer.alloc(0); let done = false; let quiet = null; let connected = false;
  const sock = net.createConnection({ host: ip, port: cfg.tcpPort });
  const finish = (err, result) => { if (done) return; done = true; paymentBusy = false; clearTimeout(connTo); clearTimeout(to); if (quiet) clearTimeout(quiet); try { sock.destroy(); } catch (e) {} cb(err, result); };
  const settle = () => finish(null, Object.assign({ mode: 'ip', montant: amount, ref: ref || null }, parseResponse(buf)));
  const connTo = setTimeout(() => { if (!connected) finish(new Error('connect timeout ' + ip)); }, 5000);
  const to = setTimeout(() => finish(new Error('Timeout terminal (IP)')), TPE_TIMEOUT);
  sock.on('connect', () => { connected = true; clearTimeout(connTo); try { sock.write(buildRequest(amount, ref)); } catch (e) {} });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const r = parseResponse(buf); const ae = (r.fields && r.fields.AE) || '';
    if (ae === '10' || ae === '01' || (r.fields && r.fields.AF)) return settle();
    if (quiet) clearTimeout(quiet); quiet = setTimeout(settle, 3000);
  });
  sock.on('end', () => { if (!done && buf.length) settle(); });
  sock.on('close', () => { if (!done && buf.length) settle(); });
  sock.on('error', (e) => finish(e));
}
function payViaIp(amount, ref, cb) {
  const attempted = {};
  const tryIp = (ip) => {
    if (!ip) return cb(new Error('Terminal introuvable sur le reseau'));
    attempted[ip] = 1;
    connectAndPay(ip, amount, ref, (err, result) => {
      if (!err) { ipHealthy = true; cfg.ip = ip; return cb(null, result); }
      ipHealthy = false;
      const msg = String((err && err.message) || err);
      const connErr = /timeout|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ECONNREFUSED|ENETUNREACH|ECONNRESET/i.test(msg);
      if (connErr && cfg.autoDiscover && !discovering) {
        console.log('Paiement: terminal injoignable sur ' + ip + ' -> recherche de la nouvelle adresse...');
        cfg.ip = '';
        discoverTerminal(true).then((found) => {
          if (found && !attempted[found]) { console.log('Paiement: terminal retrouve sur ' + found + ', nouvelle tentative.'); return tryIp(found); }
          return cb(err);
        }).catch(() => cb(err));
      } else { cb(err); }
    });
  };
  if (!cfg.ip && cfg.autoDiscover && !discovering) {
    discoverTerminal(true).then((found) => tryIp(found || '')).catch(() => cb(new Error('Adresse IP du terminal non definie')));
  } else if (!cfg.ip) {
    cb(new Error('Adresse IP du terminal non definie'));
  } else {
    tryIp(cfg.ip);
  }
}
function payViaSerial(amount, ref, cb) {
  let SerialPort;
  try { SerialPort = require('serialport').SerialPort; } catch (e) { return cb(new Error("Module 'serialport' absent (npm install serialport pour le mode USB/serie)")); }
  if (!cfg.serialPort) return cb(new Error('Port serie du terminal non defini'));
  let buf = Buffer.alloc(0); let done = false;
  const port = new SerialPort({ path: cfg.serialPort, baudRate: cfg.baud });
  const finish = (err, result) => { if (done) return; done = true; clearTimeout(to); try { port.close(() => {}); } catch (e) {} cb(err, result); };
  const to = setTimeout(() => finish(new Error('Timeout terminal (serie)')), TPE_TIMEOUT);
  port.on('open', () => port.write(buildRequest(amount, ref)));
  port.on('data', (d) => { buf = Buffer.concat([buf, d]); finish(null, Object.assign({ mode: 'serial', montant: amount, ref: ref || null }, parseResponse(buf))); });
  port.on('error', (e) => finish(e));
}
function runPayment(amount, ref, cb) {
  if (cfg.mode === 'ip') return payViaIp(amount, ref, cb);
  if (cfg.mode === 'serial') return payViaSerial(amount, ref, cb);
  return payViaSimulation(amount, ref, cb);
}

/* ----- Test de connexion (sans transaction carte) ----- */
function testConnection(cb) {
  if (cfg.mode === 'simulation') return cb(null, { ok: true, detail: 'Mode simulation — aucun terminal requis.' });
  if (cfg.mode === 'ip') {
    if (!cfg.ip) return cb(null, { ok: false, detail: 'Renseigne l’adresse IP du terminal.' });
    let done = false;
    const sock = net.createConnection({ host: cfg.ip, port: cfg.tcpPort });
    const finish = (ok, detail) => { if (done) return; done = true; clearTimeout(to); try { sock.destroy(); } catch (e) {} cb(null, { ok, detail }); };
    const to = setTimeout(() => finish(false, 'Terminal injoignable (timeout) sur ' + cfg.ip + ':' + cfg.tcpPort), 5000);
    sock.on('connect', () => finish(true, 'Reseau joignable sur ' + cfg.ip + ':' + cfg.tcpPort + ' (verif reseau uniquement, pas le dialogue carte)'));
    sock.on('error', (e) => finish(false, 'Erreur reseau : ' + (e.message || e)));
    return;
  }
  if (cfg.mode === 'serial') {
    let SerialPort;
    try { SerialPort = require('serialport').SerialPort; } catch (e) { return cb(null, { ok: false, detail: "Module 'serialport' absent (mode USB)." }); }
    if (!cfg.serialPort) return cb(null, { ok: false, detail: 'Choisis le port du terminal.' });
    let done = false;
    const port = new SerialPort({ path: cfg.serialPort, baudRate: cfg.baud });
    const finish = (ok, detail) => { if (done) return; done = true; try { port.close(() => {}); } catch (e) {} cb(null, { ok, detail }); };
    port.on('open', () => finish(true, 'Port ' + cfg.serialPort + ' ouvert.'));
    port.on('error', (e) => finish(false, 'Impossible d’ouvrir ' + cfg.serialPort + ' : ' + (e.message || e)));
    return;
  }
  cb(null, { ok: false, detail: 'Mode inconnu.' });
}

/* ------------------------------- API HTTP ------------------------------ */
const server = http.createServer(async (req, res) => {
  res._cors = corsFor(req);
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, res._cors); return res.end(); }

  if (u.pathname === '/' || u.pathname === '/etat') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(statusPage()); }
  if (u.pathname === '/health') return send(res, 200, { ok: true, service: 'Pont paiement CAISSE-AP', mode: cfg.mode });

  if (req.method === 'GET' && u.pathname === '/diag') {
    var dlines = [];
    try {
      var dlp = pathmod.join(__dirname, 'pont.log');
      var dtxt = ''; try { dtxt = fs.readFileSync(dlp, 'utf8'); } catch (e2) {}
      if (dtxt.length > 24000) dtxt = dtxt.slice(-24000);
      dlines = dtxt.split('\n').filter(function (l) { return /DIAG|Resultat|Ordre de la caisse|Reponse terminal/i.test(l); });
      dlines = dlines.slice(-40).map(function (l) { return l.replace(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/g, 'x.x.x.x').replace(/[0-9]{6,}/g, '######'); });
    } catch (e) {}
    return send(res, 200, { lines: dlines });
  }
  if (req.method === 'GET' && u.pathname === '/config') {
    return send(res, 200, { mode: cfg.mode, serialPort: cfg.serialPort, baud: cfg.baud, ip: cfg.ip, tcpPort: cfg.tcpPort });
  }
  if (req.method === 'POST' && u.pathname === '/config') {
    const body = await readJson(req);
    if (body.mode && ['simulation', 'serial', 'ip'].indexOf(body.mode) < 0) return send(res, 400, { error: 'Mode invalide' });
    if (body.mode) cfg.mode = body.mode;
    if (typeof body.serialPort === 'string') cfg.serialPort = body.serialPort;
    if (body.baud) cfg.baud = parseInt(body.baud, 10) || cfg.baud;
    if (typeof body.ip === 'string') cfg.ip = body.ip.trim();
    if (body.tcpPort) cfg.tcpPort = parseInt(body.tcpPort, 10) || cfg.tcpPort;
    saveCfg();
    return send(res, 200, { ok: true, mode: cfg.mode, serialPort: cfg.serialPort, baud: cfg.baud, ip: cfg.ip, tcpPort: cfg.tcpPort });
  }

  if (req.method === 'GET' && u.pathname === '/ports') {
    let SerialPort;
    try { SerialPort = require('serialport').SerialPort; } catch (e) { return send(res, 200, { ports: [], note: "Module serialport non installe (mode USB)." }); }
    try { const list = await SerialPort.list(); return send(res, 200, { ports: list.map((p) => ({ path: p.path, manufacturer: p.manufacturer || null })) }); }
    catch (e) { return send(res, 500, { error: String(e) }); }
  }

  if (req.method === 'POST' && u.pathname === '/test') {
    return testConnection((e, r) => send(res, 200, r || { ok: false, detail: String(e) }));
  }

  if (req.method === 'POST' && u.pathname === '/pay') {
    const body = await readJson(req);
    const amount = Number(body.amount) || 0;
    if (amount <= 0) return send(res, 400, { approved: false, error: 'Montant invalide' });
    if (cfg.mode === 'simulation' && REQUIRE_REAL) {
      console.log('<-- REFUS : mode simulation interdit en production (PONT_REQUIRE_REAL=1).');
      return send(res, 409, { approved: false, error: 'Terminal réel requis : le mode simulation est désactivé en production.', mode: cfg.mode });
    }
    console.log('--> Demande paiement ' + amount.toFixed(2) + ' EUR (mode ' + cfg.mode + ', ' + cfg.ip + ':' + cfg.tcpPort + ')');
    runPayment(amount, body.ref || null, (err, result) => {
      if (err) { console.log('<-- ERREUR : ' + (err.message || err)); return send(res, 502, { approved: false, error: String(err.message || err), mode: cfg.mode }); }
      console.log('<-- Reponse terminal : ' + JSON.stringify(result));
      return send(res, 200, result);
    });
    return;
  }

  send(res, 404, { error: 'Route inconnue' });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Pont de paiement CAISSE-AP en ecoute sur http://127.0.0.1:' + PORT + '  | mode : ' + cfg.mode);
  if (cfg.mode === 'simulation') console.log(REQUIRE_REAL
    ? 'ATTENTION : mode SIMULATION + PONT_REQUIRE_REAL=1 -> les paiements sont REFUSES tant qu\'un vrai terminal n\'est pas configure.'
    : 'ATTENTION : mode SIMULATION -> tout paiement est accepte SANS carte. NE PAS utiliser en production (configurer le TPE puis PONT_REQUIRE_REAL=1).');
});

// ---- Page d'etat du pont (http://localhost:3002) : affiche le code d'appairage, ou l'etat connecte ----
function statusPage() {
  var body = PAIR.claimed
    ? '<div class="ok">Pont connecte</div><p>Boutique : <b>' + (PAIR.boutique || '?') + '</b><br>Terminal : ' + (cfg.ip || '?') + ':' + cfg.tcpPort + '</p><p>Tout est pret. Les encaissements faits sur kingtools.fr declenchent ce terminal.</p>'
    : (cfg.setupToken
        ? '<div class="wait">Appairage automatique en cours…</div><p>Ce pont s\'appaire <b>tout seul</b> a ta boutique et detecte le terminal sur le reseau. Patiente quelques secondes — rien a saisir.</p>' + (cfg.ip ? '<p>Terminal detecte : <b>' + cfg.ip + ':' + cfg.tcpPort + '</b></p>' : '<p>Recherche du terminal sur le reseau…</p>')
        : '<div class="wait">En attente de connexion</div><p>Sur <b>kingtools.fr</b> : Reglages &gt; Paiement par carte &gt; Connecter un pont, puis saisis ce code :</p><div class="code">' + (PAIR.code || '...') + '</div>');
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pont KINGSTON</title>'
    + '<style>body{font-family:-apple-system,system-ui,sans-serif;background:#16130d;color:#f4efe3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}'
    + '.card{max-width:480px;text-align:center;padding:30px}.wm{letter-spacing:.2em;font-weight:800;font-size:24px}.sub{color:#9a9180;font-size:12px;letter-spacing:.12em;margin-bottom:6px}'
    + '.ok{color:#7bd88f;font-size:20px;font-weight:700;margin:16px 0}.wait{color:#d8b252;font-size:18px;font-weight:700;margin:16px 0}'
    + '.code{font-family:ui-monospace,monospace;font-size:46px;letter-spacing:.18em;font-weight:800;background:#241a0c;border:1px solid #4a3a1c;border-radius:14px;padding:18px;margin:16px 0;color:#fff}'
    + 'p{color:#c9bfa6;line-height:1.55}b{color:#fff}</style></head><body><div class="card"><div class="wm">KINGSTON</div><div class="sub">PONT DE PAIEMENT</div>' + body + '</div></body></html>';
}

// ---- Mode cloud : appairage par code (le pont s'annonce) + relais (kingtools.fr -> ce pont -> terminal) ----
// Requete JSON avec connexion FRAICHE a chaque appel (agent:false) : un redemarrage du serveur
// kingtools.fr ne peut donc jamais bloquer le pont sur une vieille socket. Timeout court de securite.
function httpJson(method, urlStr, headers, bodyObj) {
  return new Promise(function (resolve, reject) {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const opts = {
      method: method, hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({}, headers || {}), agent: false,
    };
    if (data) { opts.headers['content-type'] = 'application/json'; opts.headers['content-length'] = data.length; }
    const rq = lib.request(opts, function (rs) {
      let d = ''; rs.setEncoding('utf8');
      rs.on('data', function (c) { d += c; });
      rs.on('end', function () { let j = {}; try { j = d ? JSON.parse(d) : {}; } catch (e) {} resolve({ status: rs.statusCode, json: j }); });
    });
    rq.setTimeout(12000, function () { rq.destroy(new Error('timeout')); });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}
// Telecharge un texte (le code du pont) depuis le serveur.
function httpGetText(urlStr) {
  return new Promise(function (resolve, reject) {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const rq = lib.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: {}, agent: false }, function (rs) {
      let d = ''; rs.setEncoding('utf8'); rs.on('data', function (c) { d += c; }); rs.on('end', function () { resolve({ status: rs.statusCode, body: d }); });
    });
    rq.setTimeout(15000, function () { rq.destroy(new Error('timeout')); });
    rq.on('error', reject);
    rq.end();
  });
}
let selfUpdating = false;
function selfUpdate() {
  if (selfUpdating || paymentBusy) return; selfUpdating = true;
  const base = String(cfg.server || '').replace(/[/]+$/, '');
  if (!base) { selfUpdating = false; return; }
  httpGetText(base + '/pont-paiement.js').then(function (r) {
    selfUpdating = false;
    if (!r || r.status !== 200) return;
    const remote = r.body || '';
    if (remote.length < 8000) return;
    if (remote.indexOf('CAISSE-AP') < 0 || remote.indexOf('function payViaIp') < 0 || remote.indexOf('function connectAndPay') < 0) return;
    try { new Function(remote); } catch (e) { console.log('Pont: maj ignoree (syntaxe invalide).'); return; }
    let current = ''; try { current = fs.readFileSync(__filename, 'utf8'); } catch (e) {}
    if (remote === current) return;
    try { fs.writeFileSync(__filename, remote, 'utf8'); } catch (e) { return; }
    console.log('Pont: nouvelle version installee, redemarrage automatique...');
    setTimeout(function () { process.exit(0); }, 1000);
  }).catch(function () { selfUpdating = false; });
}
/* ----- Auto-detection du terminal sur le reseau local (zero IP a saisir) ----- */
function localSubnets() {
  const out = []; const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const a of (ifs[name] || [])) {
    if (a.family === 'IPv4' && !a.internal) { const p = a.address.split('.'); if (p.length === 4) out.push({ base: p[0] + '.' + p[1] + '.' + p[2] + '.', self: a.address }); }
  }
  return out;
}
function probeHost(ip, port, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false; const sock = net.createConnection({ host: ip, port: port });
    const fin = function (ok) { if (done) return; done = true; clearTimeout(to); try { sock.destroy(); } catch (e) {} resolve(ok); };
    const to = setTimeout(function () { fin(false); }, timeoutMs);
    sock.on('connect', function () { fin(true); });
    sock.on('error', function () { fin(false); });
  });
}
let discovering = false;
let paymentBusy = false;
let ipHealthy = false;
let ipFails = 0;
var IP_FAIL_LIMIT = 2;
async function discoverTerminal(force) {
  if ((cfg.ip && !force) || cfg.mode === 'serial' || !cfg.autoDiscover || discovering) return cfg.ip || '';
  discovering = true;
  const port = cfg.tcpPort || 8888;
  try {
    for (const n of localSubnets()) {
      for (let start = 1; start <= 254; start += 32) {
        const batch = [];
        for (let i = start; i < start + 32 && i <= 254; i++) { const ip = n.base + i; if (ip === n.self) continue; batch.push(probeHost(ip, port, 350).then(function (ok) { return ok ? ip : null; })); }
        const found = (await Promise.all(batch)).find(function (x) { return x; });
        if (found) { cfg.ip = found; cfg.mode = 'ip'; ipHealthy = true; ipFails = 0; saveCfg(); console.log('Terminal detecte automatiquement sur le reseau : ' + found + ':' + port); return found; }
      }
    }
    console.log('Aucun terminal detecte sur le reseau (port ' + port + '). Branche-le en reseau, ou saisis l\'IP manuellement dans Reglages.');
  } finally { discovering = false; }
  return '';
}

function healthCheck() {
  if (cfg.mode !== 'ip' || !cfg.autoDiscover) return;
  if (!cfg.ip) { ipHealthy = false; if (!discovering) discoverTerminal().catch(function () {}); return; }
  probeHost(cfg.ip, cfg.tcpPort || 8888, 1500).then(function (ok) {
    if (ok) { ipHealthy = true; ipFails = 0; return; }
    ipHealthy = false; ipFails++;
    if (ipFails >= IP_FAIL_LIMIT) { ipFails = 0; console.log('Terminal injoignable -> redetection automatique...'); discoverTerminal(true).catch(function () {}); }
  });
}
function cloudLoop() {
  const base = String(cfg.server || '').replace(/\/$/, '');
  if (!base) return;
  console.log('Mode cloud -> ' + base + ' | identifiant de ce pont : ' + cfg.deviceId);
  let busy = false, warned = false, n = 0;
  async function hello() {
    try {
      const r = await httpJson('POST', base + '/api/pont/hello', {}, { deviceId: cfg.deviceId, setupToken: cfg.setupToken || '', terminalIp: cfg.ip || '', terminalPort: cfg.tcpPort || 8888 });
      const d = r.json || {};
      PAIR.claimed = !!d.claimed; PAIR.code = d.code || ''; PAIR.boutique = d.boutique || null;
      if (d.claimed) { if (d.terminalIp && !ipHealthy && d.terminalIp !== cfg.ip) { cfg.ip = d.terminalIp; ipFails = 0; saveCfg(); } if (d.terminalPort) cfg.tcpPort = d.terminalPort; cfg.mode = 'ip'; }
      else { console.log('>>> PONT NON CONNECTE. Sur ' + base + ' (Reglages > Paiement par carte > Connecter un pont), entre le CODE : ' + PAIR.code); }
      warned = false;
    } catch (e) { if (!warned) { console.error('Mode cloud : serveur injoignable (' + (e.message || e) + ')...'); warned = true; } }
  }
  async function poll() {
    if (busy || !PAIR.claimed) return;
    try {
      const r = await httpJson('GET', base + '/api/pont/poll', { 'x-pont-device': cfg.deviceId }, null);
      if (r.status === 401) { PAIR.claimed = false; return; }
      const d = r.json || {};
      const cmd = d && d.command;
      if (cmd && Number(cmd.amount) > 0) {
        busy = true;
        console.log('--> Ordre de la caisse : ' + Number(cmd.amount).toFixed(2) + ' EUR (' + cmd.ref + ')');
        runPayment(Number(cmd.amount), cmd.ref || ('KT-' + cmd.id), function (err, result) {
          const out = err ? { id: cmd.id, approved: false, echec: '08' } : { id: cmd.id, approved: !!(result && result.approved), codeReponse: (result && result.codeReponse) || null, echec: (result && result.echec) || null };
          httpJson('POST', base + '/api/pont/result', { 'x-pont-device': cfg.deviceId }, out).catch(function () {});
          console.log('<-- DIAG: ' + JSON.stringify({ err: err?String(err.message||err):null, raw: result?String(result.raw||''):null, fields: result?result.fields:null }));
          console.log('<-- Resultat : ' + (out.approved ? 'ACCEPTE' : 'refuse/echec'));
          busy = false;
        });
      }
    } catch (e) {}
  }
  if (!cfg.ip) discoverTerminal().catch(function () {});   // detecte le terminal des le demarrage (zero IP a saisir)
  hello();
  setTimeout(function () { healthCheck(); }, 6000);
  setTimeout(function () { if (!paymentBusy) selfUpdate(); }, 25000);
  // hello frequent (~4.5s) meme une fois connecte : recupere vite l'IP/appairage et se
  // reconnecte tout seul en quelques secondes apres un redemarrage du serveur.
  setInterval(function () { n++; if (!PAIR.claimed || n % 3 === 0) hello(); poll(); if (!cfg.ip && n % 40 === 0) discoverTerminal().catch(function () {}); if (cfg.ip && n % 7 === 0) healthCheck(); if (!paymentBusy && n % 80 === 0) selfUpdate(); }, 1500);
}
cloudLoop();
