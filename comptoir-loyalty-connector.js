/**
 * Connecteur Fidelite  Comptoir  <->  myCred  (cote SERVEUR Comptoir).
 * ----------------------------------------------------------------------
 * Appelle les deux portes exposees par le plugin WordPress
 * "comptoir-mycred-connector" (balance / adjust).
 *
 * IMPORTANT : ce code tourne sur le SERVEUR Comptoir, jamais dans le
 * navigateur ni sur la borne. La cle secrete ne doit jamais etre exposee
 * cote client.
 *
 * Test local, sans aucun vrai site (faux myCred integre) :
 *     node comptoir-loyalty-connector.js --demo
 */
'use strict';

class ComptoirLoyalty {
  constructor({ baseUrl, apiKey, pointType = 'mycred_default', pointsPerEuro = 1, fetchImpl } = {}) {
    if (!baseUrl) throw new Error('baseUrl requis (ex : https://kingston-cbd.fr)');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.pointType = pointType;
    this.pointsPerEuro = pointsPerEuro;
    this._fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!this._fetch) throw new Error('fetch indisponible : fournissez fetchImpl');
  }

  async _call(path, { method = 'GET', body } = {}) {
    const res = await this._fetch(`${this.baseUrl}/wp-json/comptoir/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Comptoir-Key': this.apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('myCred: ' + ((data && data.message) || ('Erreur ' + res.status)));
    return data;
  }

  /** Solde de points d'un client (e-mail, telephone ou ID WordPress). */
  async getBalance(userRef) {
    return this._call('/balance?user=' + encodeURIComponent(userRef) + '&type=' + encodeURIComponent(this.pointType));
  }

  /** Liste paginee des clients du site (recherche nom / e-mail / telephone). */
  async listCustomers({ search = '', page = 1, perPage = 50, membersOnly = false } = {}) {
    const qs = [
      'type=' + encodeURIComponent(this.pointType),
      'page=' + encodeURIComponent(page),
      'per_page=' + encodeURIComponent(perPage),
    ];
    if (search) qs.push('search=' + encodeURIComponent(search));
    if (membersOnly) qs.push('members_only=1');
    return this._call('/customers?' + qs.join('&'));
  }

  /** Crediter les points gagnes sur une vente (montant en euros) selon la regle pointsPerEuro. */
  async earnFromSale(userRef, amountEuros, ref, reason = 'Achat en boutique') {
    const points = Math.round(amountEuros * this.pointsPerEuro);
    return this.adjust(userRef, points, reason, ref);
  }

  /** Debiter des points utilises en caisse (passez un nombre positif). */
  async redeem(userRef, points, ref, reason = 'Points utilises en boutique') {
    return this.adjust(userRef, -Math.abs(points), reason, ref);
  }

  /** Ajustement brut : amount > 0 credite, amount < 0 debite. Idempotent via "ref" (n0 de ticket). */
  async adjust(userRef, amount, reason, ref) {
    return this._call('/adjust', { method: 'POST', body: { user: userRef, amount, reason, ref, type: this.pointType } });
  }
}

module.exports = { ComptoirLoyalty };

/* --------------------- Demo locale avec un faux myCred --------------------- */
if (require.main === module && process.argv.includes('--demo')) {
  const store = { 'lenny@kingston-cbd.fr': 240 };
  const seen = new Set();
  const fakeFetch = async (url, opts) => {
    const u = new URL(url);
    if (opts.headers['X-Comptoir-Key'] !== 'demo-secret')
      return { ok: false, status: 401, json: async () => ({ message: 'cle invalide' }) };
    if (u.pathname.endsWith('/balance')) {
      const user = u.searchParams.get('user');
      if (!(user in store)) return { ok: false, status: 404, json: async () => ({ message: 'Client introuvable' }) };
      return { ok: true, status: 200, json: async () => ({ user_id: 7, email: user, name: 'Lenny K.', points: store[user], type: 'mycred_default' }) };
    }
    if (u.pathname.endsWith('/adjust')) {
      const b = JSON.parse(opts.body);
      if (b.ref && seen.has(b.ref))
        return { ok: true, status: 200, json: async () => ({ user_id: 7, points: store[b.user], type: 'mycred_default', duplicate: true }) };
      if (b.ref) seen.add(b.ref);
      store[b.user] = (store[b.user] || 0) + b.amount;
      return { ok: true, status: 200, json: async () => ({ user_id: 7, points: store[b.user], type: 'mycred_default', adjusted: b.amount }) };
    }
    if (u.pathname.endsWith('/customers')) {
      const s = (u.searchParams.get('search') || '').toLowerCase();
      let list = Object.keys(store).map((email, i) => ({ user_id: i + 1, name: email.split('@')[0], email, phone: '', points: store[email] }));
      if (s) list = list.filter((c) => c.email.toLowerCase().includes(s) || c.name.toLowerCase().includes(s));
      return { ok: true, status: 200, json: async () => ({ type: 'mycred_default', total: list.length, count: list.length, customers: list }) };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'route inconnue' }) };
  };

  (async () => {
    const loyalty = new ComptoirLoyalty({ baseUrl: 'https://exemple.test', apiKey: 'demo-secret', pointsPerEuro: 1, fetchImpl: fakeFetch });
    const email = 'lenny@kingston-cbd.fr';
    console.log('1. Solde initial myCred         :', (await loyalty.getBalance(email)).points, 'pts');
    console.log('2. Achat 31 EUR (+31 pts)        :', (await loyalty.earnFromSale(email, 31, 'KING-2026-0421')).points, 'pts');
    const dup = await loyalty.earnFromSale(email, 31, 'KING-2026-0421');
    console.log('3. Meme ticket rejoue            : doublon =', dup.duplicate === true, '/ solde inchange =', dup.points, 'pts');
    console.log('4. Utilisation de 50 pts (-50)   :', (await loyalty.redeem(email, 50, 'KING-2026-0422')).points, 'pts');
    console.log('\nOK — un seul solde, partage entre site, caisse et borne.');
  })();
}
