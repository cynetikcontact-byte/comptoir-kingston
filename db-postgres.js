/**
 * Comptoir — Couche d'accès données PostgreSQL (production)
 * =====================================================================
 * Implemente les operations du serveur contre PostgreSQL, avec
 * l'isolation par Row-Level Security : a chaque requete on pose le
 * contexte de l'utilisateur (org / role / boutique) via SET LOCAL,
 * dans une transaction, et la base filtre automatiquement les lignes.
 *
 * Pre-requis :  npm install pg   +   variable DATABASE_URL
 * Brancher dans comptoir-server.js :
 *     const db = process.env.DATABASE_URL ? require('./db-postgres.js') : null;
 *     // puis router les handlers vers db.getProducts(...), db.recordSale(...), etc.
 *
 * Le role PostgreSQL utilise par l'application NE DOIT PAS etre proprietaire
 * des tables ni super-utilisateur, sinon la RLS est contournee.
 * =====================================================================
 */
'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Correspondance jeton -> compte -> e-mail (prototype ; en prod : vraie session/JWT)
const USER_BY_TOKEN = { 'admin-token': 'admin', 'aix-token': 'aix', 'marseille-token': 'marseille' };
const EMAIL_BY_USER = { admin: 'lenny@kingston-cbd.fr', aix: 'manager.aix@kingston-cbd.fr', marseille: 'manager.marseille@kingston-cbd.fr' };

// Corps canonique de l'empreinte : uniquement des scalaires formates de facon deterministe,
// pour que recordSale et verifyChain calculent EXACTEMENT la meme valeur (numeric pg = string).
function invBody(o) {
  return JSON.stringify([o.seq, o.number, o.boutiqueId, Number(o.total).toFixed(2), o.customerEmail || '', o.payment, o.prevHash]);
}

/**
 * Execute fn(client, ctx) dans une transaction ou le contexte RLS est pose.
 * user = { orgId, role, boutiqueId, id }
 */
async function withContext(user, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL via set_config(..., is_local = true) -> efface a la fin de la transaction
    await client.query("SELECT set_config('app.org', $1, true)", [user.orgId]);
    await client.query("SELECT set_config('app.role', $1, true)", [user.role]);
    await client.query("SELECT set_config('app.boutique', $1, true)", [user.boutiqueId || '']);
    const ctx = { orgId: user.orgId, role: user.role, boutiqueId: user.boutiqueId, userId: user.id };
    const result = await fn(client, ctx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Décrément du stock fleurs en FEFO (premier périmé, premier sorti), avec verrou. */
async function decrementLots(client, boutiqueId, productId, grams) {
  const { rows } = await client.query(
    `SELECT id, grams_remaining FROM lots
       WHERE boutique_id = $1 AND product_id = $2 AND grams_remaining > 0
       ORDER BY expires_on ASC NULLS LAST
       FOR UPDATE`,
    [boutiqueId, productId]
  );
  const available = rows.reduce((a, r) => a + Number(r.grams_remaining), 0);
  if (available < Number(grams)) throw new Error('Stock insuffisant (grammes)');
  let need = Number(grams);
  for (const r of rows) {
    if (need <= 0) break;
    const take = Math.min(Number(r.grams_remaining), need);
    await client.query('UPDATE lots SET grams_remaining = grams_remaining - $2 WHERE id = $1', [r.id, take]);
    need -= take;
  }
}

/** Catalogue + stock de la boutique courante (RLS limite déjà la visibilité). */
async function getProducts(user, viewBoutiqueId) {
  return withContext(user, async (client, ctx) => {
    const bId = ctx.role === 'admin' ? (viewBoutiqueId || null) : ctx.boutiqueId;
    const rows = (await client.query(
      'SELECT id, name, category AS cat, unit, unit_price FROM products WHERE org_id = $1 ORDER BY name', [ctx.orgId]
    )).rows;
    const products = [];
    for (const p of rows) {
      const out = { id: p.id, name: p.name, cat: p.cat, unit: p.unit };
      if (p.unit === 'g') {
        const tiers = (await client.query('SELECT grams, price FROM product_tiers WHERE product_id = $1 ORDER BY grams', [p.id])).rows;
        out.tiers = tiers.map((t) => [Number(t.grams), Number(t.price)]);
        const g = await client.query('SELECT COALESCE(SUM(grams_remaining),0) AS g FROM lots WHERE product_id = $1 AND ($2::uuid IS NULL OR boutique_id = $2)', [p.id, bId]);
        out.stockG = Number(g.rows[0].g);
      } else {
        out.price = Number(p.unit_price);
        const u = await client.query('SELECT COALESCE(SUM(units),0) AS u FROM stock_units WHERE product_id = $1 AND ($2::uuid IS NULL OR boutique_id = $2)', [p.id, bId]);
        out.stockU = Number(u.rows[0].u);
      }
      products.push(out);
    }
    return { boutique: bId, products };
  });
}

/** Vente : décrément stock (FEFO) + facture séquentielle chaînée par empreinte, le tout en une transaction. */
async function recordSale(user, { items, customerEmail, payment, boutiqueId }) {
  return withContext(user, async (client, ctx) => {
    const bId = ctx.role === 'admin' ? (boutiqueId || null) : ctx.boutiqueId;
    if (!bId) throw new Error('Boutique non précisée');

    const lines = [];
    let total = 0;
    for (const it of items) {
      const p = (await client.query('SELECT id, name, unit, unit_price FROM products WHERE id = $1 AND org_id = $2', [it.productId, ctx.orgId])).rows[0];
      if (!p) throw new Error('Produit inconnu : ' + it.productId);
      if (p.unit === 'g') {
        const tier = (await client.query('SELECT price FROM product_tiers WHERE product_id = $1 AND grams = $2', [p.id, it.grams])).rows[0];
        if (!tier) throw new Error('Palier de grammes invalide pour ' + p.name);
        await decrementLots(client, bId, p.id, it.grams);
        const price = Number(tier.price);
        total += price;
        lines.push({ product_id: p.id, label: p.name, grams: it.grams, qty: null, price });
      } else {
        const qty = Number(it.qty || 1);
        const upd = await client.query(
          'UPDATE stock_units SET units = units - $3 WHERE boutique_id = $1 AND product_id = $2 AND units >= $3 RETURNING units',
          [bId, p.id, qty]
        );
        if (!upd.rows[0]) throw new Error('Stock insuffisant pour ' + p.name);
        const price = Number(p.unit_price) * qty;
        total += price;
        lines.push({ product_id: p.id, label: p.name, grams: null, qty, price });
      }
    }
    total = Math.round(total * 100) / 100;

    const sale = (await client.query(
      'INSERT INTO sales(org_id, boutique_id, user_id, customer_email, total, payment) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [ctx.orgId, bId, ctx.userId || null, customerEmail || null, total, payment]
    )).rows[0];

    for (const l of lines) {
      await client.query(
        'INSERT INTO sale_lines(sale_id, product_id, label, grams, qty, price) VALUES ($1,$2,$3,$4,$5,$6)',
        [sale.id, l.product_id, l.label, l.grams, l.qty, l.price]
      );
    }

    // Numéro séquentiel + chaînage : on verrouille la dernière facture de l'org.
    const last = (await client.query('SELECT seq, hash FROM invoices WHERE org_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE', [ctx.orgId])).rows[0];
    const seq = last ? Number(last.seq) + 1 : 1;
    const prevHash = last ? last.hash : 'GENESIS';
    const number = 'KING-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
    const hash = crypto.createHash('sha256').update(invBody({ seq: seq, number: number, boutiqueId: bId, total: total, customerEmail: customerEmail, payment: payment, prevHash: prevHash })).digest('hex');

    await client.query(
      'INSERT INTO invoices(org_id, boutique_id, seq, number, sale_id, total, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [ctx.orgId, bId, seq, number, sale.id, total, prevHash, hash]
    );

    return { facture: { numero: number, total, empreinte: hash.slice(0, 16) + '...' }, lignes: lines };
  });
}

/** Liste des factures visibles (RLS applique le périmètre). */
async function listInvoices(user) {
  return withContext(user, async (client) => {
    const rows = (await client.query(
      'SELECT number, created_at, total, payment, customer_email FROM invoices ORDER BY seq DESC'
    )).rows;
    return { count: rows.length, factures: rows };
  });
}

/** Tableau de bord : RLS limite déjà aux boutiques visibles (admin = toutes, manager = la sienne). */
async function dashboard(user) {
  return withContext(user, async (client) => {
    const rows = (await client.query(
      `SELECT b.name AS boutique, COUNT(s.id) AS tickets, COALESCE(SUM(s.total),0) AS ca
         FROM boutiques b LEFT JOIN sales s ON s.boutique_id = b.id
        GROUP BY b.name ORDER BY b.name`
    )).rows;
    return { role: user.role, dashboard: rows };
  });
}

/** Vérifie l'intégrité de la chaîne d'empreintes des factures de l'organisation. */
async function verifyChain(user) {
  return withContext(user, async (client, ctx) => {
    const invs = (await client.query(
      'SELECT seq, number, boutique_id, total, prev_hash, hash, customer_email, payment FROM invoices WHERE org_id = $1 ORDER BY seq ASC',
      [ctx.orgId]
    )).rows;
    let prev = 'GENESIS', chainOk = true, brokenAt = null;
    for (const i of invs) {
      const recomputed = crypto.createHash('sha256').update(invBody({ seq: Number(i.seq), number: i.number, boutiqueId: i.boutique_id, total: i.total, customerEmail: i.customer_email, payment: i.payment, prevHash: i.prev_hash })).digest('hex');
      if (i.prev_hash !== prev || recomputed !== i.hash) { chainOk = false; brokenAt = i.number; break; }
      prev = i.hash;
    }
    return { chainOk, invoices: invs.length, brokenAt };
  });
}

/** Authentifie un compte. Prototype : tant que le hash n'est pas remplace, le mot de passe demo est « kingston ». */
async function authenticate(username, password) {
  const email = EMAIL_BY_USER[username] || username;
  const u = (await pool.query('SELECT id, org_id, boutique_id, name, role, password_hash FROM app_users WHERE email = $1', [email])).rows[0];
  if (!u) return null;
  let ok;
  if (u.password_hash && u.password_hash.indexOf('REMPLACER') !== -1) ok = (password === 'kingston'); // DEMO
  else ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return null;
  const token = Object.keys(USER_BY_TOKEN).find((t) => USER_BY_TOKEN[t] === username) || null;
  return { token: token, name: u.name, role: u.role, boutiqueId: u.boutique_id };
}

/** Reconstruit le contexte (org / role / boutique) a partir d'un jeton. */
async function contextFromToken(token) {
  const username = USER_BY_TOKEN[token];
  if (!username) return null;
  const u = (await pool.query('SELECT id, org_id, boutique_id, role, name FROM app_users WHERE email = $1', [EMAIL_BY_USER[username]])).rows[0];
  return u ? { id: u.id, orgId: u.org_id, boutiqueId: u.boutique_id, role: u.role, name: u.name } : null;
}

module.exports = { pool, withContext, getProducts, recordSale, listInvoices, dashboard, verifyChain, authenticate, contextFromToken };
