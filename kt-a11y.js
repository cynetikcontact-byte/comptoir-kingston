/* KINGSTON Comptoir - Accessibilite des formulaires (additif).
   Aucun champ n'a d'association <label for> reelle (les intitules visibles
   sont du texte stylé). Ce script relie chaque champ a son intitule sans
   toucher le HTML : il associe le <label> voisin (via for=) ou pose un aria-label.
   Se relance apres chaque changement d'ecran (SPA) via un observateur. */
(function () {
  'use strict';

  function hasName(el){
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')) return true;
    return false;
  }

  function labelFor(el){
    var box = el.closest('.fld');
    var lab = box ? box.querySelector('label') : null;
    if (!lab) { var p = el.previousElementSibling; if (p && p.tagName === 'LABEL') lab = p; }
    return lab;
  }

  function fix(){
    var fields = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (el.type === 'hidden' || hasName(el)) continue;
      var lab = labelFor(el);
      if (lab) {
        var txt = (lab.textContent || '').trim();
        if (txt) {
          if (el.id && !lab.getAttribute('for')) lab.setAttribute('for', el.id);
          else el.setAttribute('aria-label', txt);
          continue;
        }
      }
      if (el.placeholder) el.setAttribute('aria-label', el.placeholder);
    }
  }

  fix();

  var t;
  new MutationObserver(function () {
    clearTimeout(t);
    t = setTimeout(fix, 200);
  }).observe(document.body, { childList: true, subtree: true });
})();
