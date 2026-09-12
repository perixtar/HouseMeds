// Plain browser JS (no DOM lib in this project's tsconfig) injected into
// /docs — verifies the "Authorize" token via a real GET /prescriptions call.
export const swaggerAuthorizeStatusScript = `
(function () {
  var BANNER_ID = 'medhouse-authorize-status';
  var COLORS = { pending: '#1d4ed8', ok: '#15803d', fail: '#b91c1c' };

  function ensureBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 20px;' +
      'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'text-align:center;display:none;color:#fff;cursor:pointer;';
    el.title = 'Click to dismiss';
    el.addEventListener('click', function () { el.style.display = 'none'; });
    document.body.appendChild(el);
    return el;
  }

  function showBanner(kind, text) {
    var el = ensureBanner();
    el.style.background = COLORS[kind] || COLORS.fail;
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    if (kind !== 'pending') {
      el._hideTimer = setTimeout(function () { el.style.display = 'none'; }, 10000);
    }
  }

  function verifyToken(token) {
    showBanner('pending', 'Authorize: verifying token against GET /prescriptions…');
    fetch('/prescriptions', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) {
        if (res.ok) {
          showBanner(
            'ok',
            'Authorize succeeded — token accepted (verified against GET /prescriptions, HTTP ' + res.status + ').'
          );
          return;
        }
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (body) {
            var reason = (body && body.message) ? body.message : ('HTTP ' + res.status);
            showBanner('fail', 'Authorize failed — server rejected the token: ' + reason + ' (HTTP ' + res.status + ').');
          });
      })
      .catch(function (err) {
        showBanner('fail', 'Authorize failed — could not reach the server to verify: ' + err.message);
      });
  }

  // Matches by dialog + label, not class name, to survive UI version bumps.
  function findAuthorizeSubmitButton(target) {
    var btn = target.closest && target.closest('button');
    if (!btn) return null;
    var modal = btn.closest('.modal-ux');
    if (!modal) return null; // topbar button that only opens the dialog
    var label = (btn.textContent || '').trim().toLowerCase();
    if (label !== 'authorize') return null; // ignore "Close" / "Logout"
    return { btn: btn, modal: modal };
  }

  document.addEventListener(
    'click',
    function (event) {
      var match = findAuthorizeSubmitButton(event.target);
      if (!match) return;

      var input = match.modal.querySelector('.auth-container input, .scheme-container input');
      var token = input && input.value && input.value.trim();
      if (!token) {
        showBanner('fail', 'Authorize failed — no token entered.');
        return;
      }

      // Let Swagger UI's own click handler persist the value first.
      setTimeout(function () { verifyToken(token); }, 50);
    },
    true,
  );
})();
`;
