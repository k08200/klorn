// Shared site chrome behaviour for the landings and every subpage.
// The site has no build step, so this is the one place the header logic lives;
// pages load it with <script src="/site-nav.js" defer>.
(function () {
  // The site's one nav: Accounts · Lanes · Pricing · Security · Blog, then Log
  // in and Download (static in each page). Every page that uses the floating
  // pill ships these links in its HTML too, so the header works without
  // script; this rebuilds them from the table below so the labels and targets
  // can only come from here. Keep the static copies identical.
  var NAV_LABELS = {
    en: ['Accounts', 'Lanes', 'Pricing', 'Security', 'Blog'],
    ko: ['계정', '레인', '요금', '보안', '블로그'],
    ja: ['アカウント', 'レーン', '料金', 'セキュリティ', 'ブログ'],
    zh: ['账户', '分类', '定价', '安全', '博客'],
    es: ['Cuentas', 'Carriles', 'Precios', 'Seguridad', 'Blog'],
    fr: ['Comptes', 'Files', 'Tarifs', 'Sécurité', 'Blog'],
    de: ['Konten', 'Spuren', 'Preise', 'Sicherheit', 'Blog']
  };
  var navMenu = document.querySelector('.nav-links[data-site-nav]');
  if (navMenu) {
    var lang = (document.documentElement.lang || 'en').slice(0, 2);
    var labels = NAV_LABELS[lang] || NAV_LABELS.en;
    var home = lang === 'en' || !NAV_LABELS[lang] ? '/' : '/' + lang + '/';
    var path = location.pathname.replace(/index\.html$/, '');
    var onHome = path === home;
    var pricing = onHome ? '#pricing' : home === '/' ? '/pricing/' : home + '#pricing';
    var hrefs = [
      (onHome ? '' : home) + '#accounts',
      (onHome ? '' : home) + '#lanes',
      pricing,
      '/security/',
      '/blog/'
    ];
    navMenu.textContent = '';
    hrefs.forEach(function (href, i) {
      var a = document.createElement('a');
      a.href = href;
      a.textContent = labels[i];
      if (href.charAt(0) === '/' && href.indexOf('#') < 0 && path === href) {
        a.setAttribute('aria-current', 'page');
      }
      navMenu.appendChild(a);
    });
  }

  // Disclosure menu. Below the header breakpoint the section links collapse
  // behind a button; click toggles, click away or Escape closes, and Escape
  // returns focus to the button so keyboard users are never stranded.
  document.querySelectorAll('[data-menu-toggle]').forEach(function (btn) {
    var menu = document.getElementById(btn.getAttribute('aria-controls'));
    if (!menu) return;

    function setOpen(open) {
      if (open) menu.setAttribute('data-open', '');
      else menu.removeAttribute('data-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!menu.hasAttribute('data-open'));
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', function (e) {
      if (!menu.hasAttribute('data-open')) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !menu.hasAttribute('data-open')) return;
      setOpen(false);
      btn.focus();
    });
  });

  // Subpage Download button: the .dmg is the default, Windows visitors get the
  // installer instead. Same platform signal as the landing's download row.
  var uaData = navigator.userAgentData;
  var raw = String((uaData && uaData.platform) || navigator.platform ||
                   navigator.userAgent || '');
  if (!/win/i.test(raw) || /mac|iphone|ipad|ipod/i.test(raw)) return;
  document.querySelectorAll('.dl-cta[data-win-href]').forEach(function (a) {
    a.setAttribute('href', a.getAttribute('data-win-href'));
    a.removeAttribute('rel');
  });
})();

// Hero motion (Sig 2), landings only: the inline <head> gate adds
// html.hero-motion when motion is allowed. Give each hero row its stagger
// index, then reveal once the lane list is actually on screen (on phones it
// can sit below the fold). This script owns the reveal from here, so it
// cancels the gate's failsafe. Desktop hides the list, so nothing moves there.
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('hero-motion')) return;
  var list = document.querySelector('.hero .mlist');
  function reveal() { root.classList.add('hero-in'); }
  if (!list || !list.getClientRects().length) return;
  clearTimeout(window.klornHeroFailsafe);
  try {
    list.querySelectorAll('.mrow').forEach(function (row, i) {
      row.style.setProperty('--i', String(i));
    });
    var io = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      requestAnimationFrame(reveal);
    }, { threshold: 0.2 });
    io.observe(list);
  } catch (e) {
    reveal();
  }
})();
