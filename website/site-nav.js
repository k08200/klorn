// Shared site chrome behaviour for the landings and every compare.css page.
// The site has no build step, so this is the one place the header logic lives;
// pages load it with <script src="/site-nav.js" defer>.
(function () {
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
