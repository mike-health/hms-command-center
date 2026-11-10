(function () {
  try {
    var k = 'hms_visit_fp_v1';
    var fp = localStorage.getItem(k);
    if (!fp) {
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      fp = Array.prototype.map.call(a, function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
      localStorage.setItem(k, fp);
    }
    var payload = {
      fp: fp,
      ua: navigator.userAgent || '',
      screen: (screen.width || 0) + 'x' + (screen.height || 0),
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
      lang: navigator.language || '',
      path: location.pathname || '/'
    };
    fetch('/api/visit-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function () {});
  } catch (e) {}
})();
