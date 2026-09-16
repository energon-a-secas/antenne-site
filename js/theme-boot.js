// Runs before first paint, as a classic script in desk.html's <head>. It is a file,
// not an inline <script>, because the desk's Content-Security-Policy allows no inline
// script (same move as overworld-site/js/theme-boot.js).
(function () {
  // GitHub Pages cannot send frame-ancestors, so a framed desk hides itself and there
  // is nothing to click through an invisible overlay. This runs first: in a sandboxed
  // frame, reading document.cookie below throws. A frame that blocks scripts skips
  // this line, and also every desk control, since the desk renders from JS.
  if (window.top !== window.self) document.documentElement.style.setProperty('display', 'none', 'important');

  // The header kit's theme bootstrap, unchanged: ?theme= wins, then the neo_theme cookie.
  var m = location.search.match(/[?&]theme=([\w-]+)/)
    || document.cookie.match(/(?:^|;\s*)neo_theme=([\w-]+)/);
  if (m && m[1] !== 'default') document.documentElement.dataset.theme = decodeURIComponent(m[1]);
})();
