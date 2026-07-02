/* KINGSTON Comptoir - Routeur d'URL (additif, a charger apres l'app).
   Donne une vraie URL a chaque ecran : lien profond partageable,
   bouton Precedent/Suivant du navigateur, et F5 qui conserve l'ecran.
   Route en #/hash -> 100% cote navigateur, aucun changement serveur,
   et jamais de JSON brut affiche (le serveur n'est pas sollicite).
   N'utilise que le DOM public (clic sur .nav-item[data-view]). */
(function () {
  'use strict';

  var SLUGS = ['dash','pos','borne','commandes','challenge','produits',
               'stock','fidelite','journal','factu','conformite',
               'franchises','pro','reglages'];

  function itemFor(slug){ return document.querySelector('.nav-item[data-view="' + slug + '"]'); }
  function navCount(){ return document.querySelectorAll('.nav-item[data-view]').length; }
  function activeSlug(){
    var a = document.querySelector('.nav-item[data-view].active');
    return a ? a.getAttribute('data-view') : null;
  }
  function slugFromHash(){
    var h = (location.hash || '').replace(/^#\/?/, '');
    return SLUGS.indexOf(h) !== -1 ? h : null;
  }

  var applying = false;

  document.addEventListener('click', function (e) {
    var it = e.target && e.target.closest ? e.target.closest('.nav-item[data-view]') : null;
    if (!it) return;
    var slug = it.getAttribute('data-view');
    if (slug && ('#/' + slug) !== location.hash) {
      history.pushState({ v: slug }, '', '#/' + slug);
    }
  }, true);

  function syncFromUrl(){
    if (applying) return;
    var slug = slugFromHash();
    if (!slug) return;
    if (slug === activeSlug()) return;
    var it = itemFor(slug);
    if (it) { applying = true; it.click(); applying = false; }
  }
  window.addEventListener('hashchange', syncFromUrl);
  window.addEventListener('popstate', syncFromUrl);

  function boot(){
    var slug = slugFromHash();
    if (slug && slug !== activeSlug()) {
      var it = itemFor(slug);
      if (it) it.click();
    } else if (!location.hash) {
      var a = activeSlug() || 'dash';
      history.replaceState({ v: a }, '', '#/' + a);
    }
  }

  var tries = 0;
  (function waitNav(){
    if (navCount()) { boot(); }
    else if (tries++ < 60) { setTimeout(waitNav, 100); }
  })();
})();
