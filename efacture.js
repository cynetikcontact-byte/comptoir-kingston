/**
 * Comptoir — e-facture (réforme française)
 * =====================================================================
 *  - facturxXML(inv)  : génère le XML Factur-X (profil CII / EN16931, simplifié)
 *                       = le cœur structuré d'une facture électronique B2B.
 *                       Étape finale en prod : l'embarquer dans un PDF/A-3 (Factur-X)
 *                       et l'envoyer via une PDP. Le XML ci-dessous est la substance.
 *  - ereportingZ(...) : produit le résumé "ticket Z" à transmettre en e-reporting
 *                       pour les ventes B2C (total, ventilation TVA, encaissements).
 *
 *  Démo / auto-test :  node efacture.js --demo
 * =====================================================================
 */
'use strict';
function round2(n) { return Math.round(n * 100) / 100; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function facturxXML(inv) {
  const groups = {};
  let ttcTotal = 0;
  inv.lines.forEach((l) => { ttcTotal += l.ttc; groups[l.vat] = (groups[l.vat] || 0) + l.ttc; });
  const taxLines = Object.keys(groups).map((r) => { const rate = Number(r); const ttc = round2(groups[r]); const base = round2(ttc / (1 + rate)); return { rate: rate, base: base, tax: round2(ttc - base) }; });
  const totalHT = round2(taxLines.reduce((a, t) => a + t.base, 0));
  const totalTVA = round2(taxLines.reduce((a, t) => a + t.tax, 0));
  const totalTTC = round2(ttcTotal);

  const lineXML = inv.lines.map((l, i) => {
    const rate = Number(l.vat); const ttc = round2(l.ttc); const ht = round2(ttc / (1 + rate)); const unit = round2(ht / (l.qty || 1));
    return '    <ram:IncludedSupplyChainTradeLineItem>\n' +
      '      <ram:AssociatedDocumentLineDocument><ram:LineID>' + (i + 1) + '</ram:LineID></ram:AssociatedDocumentLineDocument>\n' +
      '      <ram:SpecifiedTradeProduct><ram:Name>' + esc(l.label) + '</ram:Name></ram:SpecifiedTradeProduct>\n' +
      '      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>' + unit.toFixed(2) + '</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>\n' +
      '      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="' + (l.qty ? 'C62' : 'GRM') + '">' + (l.qty || 1) + '</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>\n' +
      '      <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>' + (rate * 100).toFixed(2) + '</ram:RateApplicablePercent></ram:ApplicableTradeTax>' +
      '<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>' + ht.toFixed(2) + '</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>\n' +
      '    </ram:IncludedSupplyChainTradeLineItem>';
  }).join('\n');

  const taxXML = taxLines.map((t) => '      <ram:ApplicableTradeTax><ram:CalculatedAmount>' + t.tax.toFixed(2) + '</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>' + t.base.toFixed(2) + '</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>' + (t.rate * 100).toFixed(2) + '</ram:RateApplicablePercent></ram:ApplicableTradeTax>').join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">\n' +
    '  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>\n' +
    '  <rsm:ExchangedDocument><ram:ID>' + esc(inv.number) + '</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">' + inv.date + '</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>\n' +
    '  <rsm:SupplyChainTradeTransaction>\n' + lineXML + '\n' +
    '    <ram:ApplicableHeaderTradeAgreement>\n' +
    '      <ram:SellerTradeParty><ram:Name>' + esc(inv.seller.name) + '</ram:Name><ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">' + esc(inv.seller.siren) + '</ram:ID></ram:SpecifiedLegalOrganization><ram:PostalTradeAddress><ram:PostcodeCode>' + esc(inv.seller.zip) + '</ram:PostcodeCode><ram:LineOne>' + esc(inv.seller.address) + '</ram:LineOne><ram:CityName>' + esc(inv.seller.city) + '</ram:CityName><ram:CountryID>' + (inv.seller.country || 'FR') + '</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">' + esc(inv.seller.vat) + '</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>\n' +
    '      <ram:BuyerTradeParty><ram:Name>' + esc(inv.buyer.name) + '</ram:Name><ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">' + esc(inv.buyer.siren) + '</ram:ID></ram:SpecifiedLegalOrganization><ram:PostalTradeAddress><ram:PostcodeCode>' + esc(inv.buyer.zip) + '</ram:PostcodeCode><ram:LineOne>' + esc(inv.buyer.address) + '</ram:LineOne><ram:CityName>' + esc(inv.buyer.city) + '</ram:CityName><ram:CountryID>' + (inv.buyer.country || 'FR') + '</ram:CountryID></ram:PostalTradeAddress></ram:BuyerTradeParty>\n' +
    '    </ram:ApplicableHeaderTradeAgreement>\n' +
    '    <ram:ApplicableHeaderTradeDelivery/>\n' +
    '    <ram:ApplicableHeaderTradeSettlement>\n' +
    '      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>\n' + taxXML + '\n' +
    '      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>' + totalHT.toFixed(2) + '</ram:LineTotalAmount><ram:TaxBasisTotalAmount>' + totalHT.toFixed(2) + '</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">' + totalTVA.toFixed(2) + '</ram:TaxTotalAmount><ram:GrandTotalAmount>' + totalTTC.toFixed(2) + '</ram:GrandTotalAmount><ram:DuePayableAmount>' + totalTTC.toFixed(2) + '</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n' +
    '    </ram:ApplicableHeaderTradeSettlement>\n' +
    '  </rsm:SupplyChainTradeTransaction>\n' +
    '</rsm:CrossIndustryInvoice>';
}

function ereportingZ(boutique, periode, sales) {
  const byRate = {}, byPay = {};
  let ttc = 0;
  sales.forEach((s) => {
    ttc += s.total;
    (s.lines || []).forEach((l) => { byRate[l.vat] = (byRate[l.vat] || 0) + l.prix; });
    byPay[s.payment] = (byPay[s.payment] || 0) + s.total;
  });
  const ventilation = Object.keys(byRate).map((r) => { const rate = Number(r); const b = round2(byRate[r]); const ht = round2(b / (1 + rate)); return { taux: Math.round(rate * 100) + '%', baseHT: ht, tva: round2(b - ht), ttc: b }; });
  return {
    type: 'e-reporting',
    boutique: boutique,
    periode: periode,
    nombreTickets: sales.length,
    totalTTC: round2(ttc),
    ventilationTVA: ventilation,
    encaissements: Object.keys(byPay).map((p) => ({ moyen: p, montant: round2(byPay[p]) })),
  };
}

module.exports = { facturxXML: facturxXML, ereportingZ: ereportingZ };

if (require.main === module && process.argv.includes('--demo')) {
  const inv = {
    number: 'KING-2026-0042', date: '20260529',
    seller: { name: 'KINGSTON SARL', siren: '000000000', vat: 'FR00000000000', address: '1 rue du Comptoir', zip: '13290', city: 'Aix-en-Provence', country: 'FR' },
    buyer: { name: 'Franchise Marseille SARL', siren: '111111111', address: '2 av. du Prado', zip: '13008', city: 'Marseille', country: 'FR' },
    lines: [{ label: 'King #5.1 - 25 g', qty: 1, ttc: 120, vat: 0.20 }, { label: 'Tyson Paper x50', qty: 50, ttc: 100, vat: 0.20 }],
  };
  const xml = facturxXML(inv);
  console.log('--- Factur-X (CII), extrait ---');
  console.log(xml.slice(0, 540) + '\n  ...');
  const required = ['CrossIndustryInvoice', 'ExchangedDocument', 'GrandTotalAmount', 'TaxTotalAmount', 'SellerTradeParty', 'BuyerTradeParty', 'RateApplicablePercent'];
  console.log('\nBalises EN16931 clés présentes :', required.every((t) => xml.indexOf(t) >= 0));
  console.log('Équilibre des balises < > :', (xml.match(/</g) || []).length === (xml.match(/>/g) || []).length);

  const z = ereportingZ('Aix-en-Provence', '2026-05-29', [
    { total: 13, payment: 'Carte Monetico', lines: [{ vat: 0.20, prix: 11 }, { vat: 0.20, prix: 2 }] },
    { total: 7, payment: 'Espèces', lines: [{ vat: 0.20, prix: 7 }] },
  ]);
  console.log('\n--- e-reporting (ticket Z) ---');
  console.log(JSON.stringify(z, null, 2));
}
