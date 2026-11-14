// =============================================================
//  読み込み係（キャッシュ対策）
//  毎回 version.js の番号を確認し、各ファイルに ?v=番号 を付けて読み込む。
//  → version.js の VERSION を上げれば、ブラウザが古いファイルを使い続けない。
//  使い方：<script src="loader.js" data-entry="tier.js" data-css="style.css"></script>
//  ※ 新しい .js ファイルを追加したら FILES にも名前を足す
// =============================================================
(function () {
  var me = document.currentScript;
  var entry = me.dataset.entry;
  var css = (me.dataset.css || '').split(',').filter(Boolean);
  var FILES = ['store.js', 'common.js', 'firebase-config.js', 'version.js', 'presets.js', 'ekaki-presets.js', 'tier.js', 'ekaki.js', 'eshiri.js', 'dots.js', 'dengon.js', 'drawkit.js', 'jintori.js', 'jintori-rules.js', 'hub.js'];
  var abs = function (f) { return new URL(f, location.href).href; };

  fetch('version.js', { cache: 'no-store' })
    .then(function (r) { return r.text(); })
    .then(function (t) { var m = t.match(/VERSION\s*=\s*'([^']+)'/); return m ? m[1] : String(Date.now()); })
    .catch(function () { return String(Date.now()); })
    .then(function (v) {
      var q = '?v=' + encodeURIComponent(v);
      var imports = {};
      FILES.forEach(function (f) { imports[abs(f)] = abs(f) + q; });
      var map = document.createElement('script');
      map.type = 'importmap';
      map.textContent = JSON.stringify({ imports: imports });
      document.head.appendChild(map);
      css.forEach(function (c) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = c + q;
        document.head.appendChild(l);
      });
      var s = document.createElement('script');
      s.type = 'module'; s.src = entry + q;
      document.body.appendChild(s);
    });
})();
