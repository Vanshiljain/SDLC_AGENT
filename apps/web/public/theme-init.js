// Apply the saved theme before first paint to avoid a flash. Loaded as a blocking
// external script so the Content-Security-Policy needs no 'unsafe-inline' for scripts.
(function () {
  try {
    var t = localStorage.getItem('fl-theme');
    document.documentElement.classList.toggle('dark', t ? t === 'dark' : true);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
