/**
 * Comptoir — moteur de conformité fiscale « logiciel de caisse »
 * =====================================================================
 *  Met en oeuvre les 4 exigences de la loi anti-fraude TVA (art. 286-I-3°bis
 *  du CGI), socle de la certification NF525 / LNE :
 *    - INALTERABILITE : chaque enregistrement est figé ; aucune modification
 *      ni suppression, seulement des corrections par nouvel enregistrement.
 *    - SECURISATION  : chaque enregistrement est SCELLE par une signature
 *      HMAC-SHA256 (clé secrète propre à l'installation) et CHAINE au
 *      précédent -> toute altération casse la chaîne et devient détectable.
 *    - CONSERVATION  : clôtures Z (journalière), mensuelle et annuelle, avec
 *      Grand Total perpétuel (cumul jamais remis à zéro).
 *    - ARCHIVAGE     : archive scellée d'une période + export de contrôle,
 *      vérifiables (recalcul des signatures).
 *
 *  Ce module ne contient QUE des fonctions pures (pas d'état, pas d'I/O) :
 *  l'état (événements, compteurs) et la persistance vivent dans le serveur.
 *  Démo / auto-test :  node comptoir-fiscal.js --demo
 * =====================================================================
 */
'use strict';
const crypto = require('crypto');

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Représentation canonique et stable d'un événement (sert d'assiette à la signature).
// Tout changement d'un seul champ change le corps -> change la signature.
function eventBody(e) {
  return JSON.stringify([e.seq, e.type, e.boutiqueId || '', e.date, e.data]);
}

// Scelle un événement : HMAC-SHA256( clé , signaturePrécédente | corps ).
// Le chaînage (prevSig) lie chaque enregistrement au précédent.
function sealEvent(e, key) {
  return crypto.createHmac('sha256', String(key || ''))
    .update(String(e.prevSig) + '|' + eventBody(e))
    .digest('hex');
}

// Vérifie l'intégrité de toute la chaîne d'événements (journal + clôtures).
function verifyEventChain(events, key) {
  let prev = 'GENESIS', ok = true, brokenAt = null;
  const ordered = events.slice().sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    const recomputed = sealEvent(e, key);
    if (e.prevSig !== prev || recomputed !== e.sig) { ok = false; brokenAt = e.seq; break; }
    prev = e.sig;
  }
  return { ok: ok, count: events.length, brokenAt: brokenAt, derniereSignature: prev };
}

// Agrège un ensemble de factures (ventes + avoirs) en totaux de clôture.
// Une facture = { total, payment, tva:{ totalHT, totalTVA, ventilation:[{taux,baseHT,tva,ttc}] } }.
function aggregate(factures) {
  let ttc = 0, ht = 0, tva = 0, nbVentes = 0, nbAvoirs = 0, ttcAvoirs = 0;
  const byPay = {}, vt = {};
  factures.forEach((f) => {
    if (f.total >= 0) { nbVentes++; ttc += f.total; }
    else { nbAvoirs++; ttcAvoirs += f.total; }
    if (f.tva) { ht += (f.tva.totalHT || 0); tva += (f.tva.totalTVA || 0); }
    byPay[f.payment || 'Inconnu'] = (byPay[f.payment || 'Inconnu'] || 0) + f.total;
    ((f.tva && f.tva.ventilation) ? f.tva.ventilation : []).forEach((v) => {
      vt[v.taux] = vt[v.taux] || { taux: v.taux, baseHT: 0, tva: 0, ttc: 0 };
      vt[v.taux].baseHT += (v.baseHT || 0); vt[v.taux].tva += (v.tva || 0); vt[v.taux].ttc += (v.ttc || 0);
    });
  });
  return {
    nbTickets: nbVentes,
    nbAvoirs: nbAvoirs,
    totalTTC: r2(ttc),
    totalAvoirs: r2(ttcAvoirs),
    totalHT: r2(ht),
    totalTVA: r2(tva),
    ventilationTVA: Object.keys(vt).map((k) => ({ taux: vt[k].taux, baseHT: r2(vt[k].baseHT), tva: r2(vt[k].tva), ttc: r2(vt[k].ttc) })),
    encaissements: Object.keys(byPay).map((p) => ({ moyen: p, montant: r2(byPay[p]) })),
  };
}

// Signature globale d'une archive : scelle l'ensemble {factures, événements} en un seul sceau.
function archiveSignature(factures, events, key) {
  const corps = JSON.stringify([
    factures.map((f) => [f.num, f.total, f.hash]),
    events.map((e) => [e.seq, e.type, e.sig]),
  ]);
  return crypto.createHmac('sha256', String(key || '')).update(corps).digest('hex');
}

module.exports = {
  eventBody: eventBody,
  sealEvent: sealEvent,
  verifyEventChain: verifyEventChain,
  aggregate: aggregate,
  archiveSignature: archiveSignature,
  r2: r2,
};

// --------------------------- Auto-test ---------------------------
if (require.main === module && process.argv.includes('--demo')) {
  const KEY = 'cle-fiscale-demo';
  let seq = 0, prev = 'GENESIS';
  const events = [];
  const add = (type, bId, data) => {
    const e = { seq: ++seq, type: type, boutiqueId: bId, date: new Date(2026, 4, 29, 9 + seq).toISOString(), data: data || {}, prevSig: prev };
    e.sig = sealEvent(e, KEY); prev = e.sig; events.push(e); return e;
  };
  add('DEMARRAGE', null, { version: 'demo' });
  const factures = [
    { num: 'K-1', total: 13, payment: 'CB', hash: 'h1', tva: { totalHT: 10.83, totalTVA: 2.17, ventilation: [{ taux: '20%', baseHT: 10.83, tva: 2.17, ttc: 13 }] } },
    { num: 'K-2', total: 7, payment: 'Espèces', hash: 'h2', tva: { totalHT: 5.83, totalTVA: 1.17, ventilation: [{ taux: '20%', baseHT: 5.83, tva: 1.17, ttc: 7 }] } },
    { num: 'K-3', total: -7, payment: 'Avoir', hash: 'h3', tva: { totalHT: -5.83, totalTVA: -1.17, ventilation: [{ taux: '20%', baseHT: -5.83, tva: -1.17, ttc: -7 }] } },
  ];
  const agg = aggregate(factures);
  add('CLOTURE_Z', 'aix', Object.assign({ numero: 1, grandTotalPerpetuel: 20 }, agg));

  let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fail++; };
  ok(agg.totalTTC === 20 && agg.nbTickets === 2, 'agrégat : 2 ventes = 20 € TTC (' + agg.totalTTC + ')');
  ok(agg.totalAvoirs === -7 && agg.nbAvoirs === 1, 'agrégat : 1 avoir = -7 €');
  ok(agg.encaissements.length === 3, 'agrégat : 3 moyens de paiement');
  const v1 = verifyEventChain(events, KEY);
  ok(v1.ok && v1.count === 2, 'chaîne intègre (' + v1.count + ' événements)');
  // Altération : on modifie une donnée scellée -> la chaîne doit casser.
  events[1].data.grandTotalPerpetuel = 99999;
  const v2 = verifyEventChain(events, KEY);
  ok(!v2.ok && v2.brokenAt === events[1].seq, 'altération détectée à l\'événement #' + v2.brokenAt);
  const sig = archiveSignature(factures, events, KEY);
  ok(typeof sig === 'string' && sig.length === 64, 'signature d\'archive (HMAC-SHA256) produite');
  console.log(fail ? ('\n>>> ' + fail + ' ECHEC(S)') : '\n>>> TOUS LES TESTS PASSENT');
  process.exit(fail ? 1 : 0);
}
