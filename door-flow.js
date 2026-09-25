/**
 * Flujo PWA: preflight → (1.er acceso: abrir directo | resto: escáner QR) → abrir puerta
 */
window.MinkaDoorFlow = function(cfg) {
  var API_URL = cfg.apiUrl;
  var IMG_BP = cfg.imgBp;
  var getToken = cfg.getToken || function() { return ''; };
  var isAdmin = cfg.isAdmin || function() { return false; };
  var getDeviceId = cfg.getDeviceId || function() { return ''; };

  var qrScanner = null;
  var scanLock = false;
  var LANG_KEY = 'minka_lang';
  var LANG_CHOSEN_KEY = 'minka_lang_chosen';
  var _lastResponseContext = null;
  var _pendingDoorQr = null;

  /** Llave física: texto plano o URL PWA con ?doorQr= / ?qr= (ignora el resto de la URL). */
  function extractDoorQrFromScan(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    if (/^https?:\/\//i.test(s) || /^www\./i.test(s)) {
      try {
        var href = s.indexOf('://') >= 0 ? s : 'https://' + s;
        var u = new URL(href);
        var q = u.searchParams.get('doorQr') || u.searchParams.get('qr') || '';
        if (q) return decodeURIComponent(q).trim();
      } catch (e) {}
      var qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        var parts = s.substring(qIdx + 1).split('&');
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].split('=');
          if (kv[0] === 'doorQr' || kv[0] === 'qr') {
            try { return decodeURIComponent(kv[1] || '').trim(); } catch (e2) { return (kv[1] || '').trim(); }
          }
        }
      }
      return '';
    }
    return s;
  }

  window.MinkaDoorQr = { extract: extractDoorQrFromScan };

  function hasUserChosenLang() {
    try { return localStorage.getItem(LANG_CHOSEN_KEY) === '1'; } catch (e) {}
    return false;
  }

  function getLang() {
    try {
      var l = localStorage.getItem(LANG_KEY) || sessionStorage.getItem(LANG_KEY);
      if (l === 'en' || l === 'es') return l;
    } catch (e) {}
    return 'es';
  }

  function confirmImplicitLangChoice() {
    if (hasUserChosenLang() || isAdmin()) return;
    try {
      localStorage.setItem(LANG_KEY, getLang());
      sessionStorage.setItem(LANG_KEY, getLang());
      localStorage.setItem(LANG_CHOSEN_KEY, '1');
    } catch (e) {}
    bindLangSwitch(false);
  }

  function setLang(lang) {
    if (lang !== 'es' && lang !== 'en') return;
    try {
      localStorage.setItem(LANG_KEY, lang);
      sessionStorage.setItem(LANG_KEY, lang);
      localStorage.setItem(LANG_CHOSEN_KEY, '1');
    } catch (e) {}
    updateLangSwitchUI();
    try { window.dispatchEvent(new CustomEvent('minkaLangChange')); } catch (e) {}
    updateQrHintUI();
    if (_lastResponseContext) {
      applyResponse(_lastResponseContext.data, _lastResponseContext.confirmBalance);
    }
  }

  function isEs() {
    return getLang() === 'es';
  }

  function updateLangSwitchUI() {
    var sw = document.getElementById('doorLangSwitch');
    if (!sw) return;
    var esBtn = document.getElementById('doorLangEs');
    var enBtn = document.getElementById('doorLangEn');
    if (esBtn) esBtn.classList.toggle('active', getLang() === 'es');
    if (enBtn) enBtn.classList.toggle('active', getLang() === 'en');
  }

  function shouldShowDoorLangSwitch(guestUi) {
    return !!guestUi && !isAdmin() && !hasUserChosenLang();
  }

  function bindLangSwitch(show) {
    var sw = document.getElementById('doorLangSwitch');
    if (!sw) return;
    sw.style.display = show ? 'flex' : 'none';
    updateLangSwitchUI();
  }

  window.MinkaPwaLang = { get: getLang, set: setLang, isEs: isEs };

  function el() {
    return {
      overlay: document.getElementById('doorOverlay'),
      loading: document.getElementById('doorLoading'),
      statusEl: document.getElementById('doorStatus'),
      card: document.getElementById('doorCard'),
      qrStage: document.getElementById('doorQrStage'),
      qrHintMain: document.getElementById('doorQrHintMain'),
      qrHintSub: document.getElementById('doorQrHintSub'),
      iconEl: document.getElementById('doorIcon'),
      titleEl: document.getElementById('doorTitle'),
      msgEl: document.getElementById('doorMsg'),
      extraEl: document.getElementById('doorExtra'),
      actionsEl: document.getElementById('doorActions'),
      closeBtn: document.getElementById('doorClose')
    };
  }

  function stopScanner() {
    scanLock = false;
    if (qrScanner) {
      var s = qrScanner;
      qrScanner = null;
      s.stop().catch(function() {}).finally(function() {
        try { s.clear(); } catch (e) {}
      });
    }
    var e = el();
    if (e.qrStage) e.qrStage.style.display = 'none';
  }

  function resetOverlay() {
    stopScanner();
    var e = el();
    if (!e.overlay) return;
    e.loading.style.display = 'block';
    e.card.style.display = 'none';
    if (e.qrStage) e.qrStage.style.display = 'none';
  }

  function openPaymentsPage(payUrl) {
    if (!payUrl) return;
    confirmImplicitLangChoice();
    var path = payUrl;
    if (path.indexOf('https://www.minkahostel.com') === 0) {
      path = path.substring('https://www.minkahostel.com'.length);
    }
    if (cfg.onOpenWeb) cfg.onOpenWeb(path);
    else window.open(payUrl, '_blank');
    closeOverlay();
  }

  function closeOverlay(opts) {
    if (!isAdmin() && getToken()) confirmImplicitLangChoice();
    _pendingDoorQr = null;
    var e = el();
    var cardVisible = e.card && e.card.style.display === 'block';
    var fromRect = cardVisible ? e.card.getBoundingClientRect() : null;
    var hintFab = !!(opts && opts.fabHint);
    if (!hintFab && cardVisible && !isAdmin() && getToken()) {
      try {
        if (!localStorage.getItem('minka_door_fab_hint_done')) hintFab = true;
      } catch (err) {}
    }
    stopScanner();
    if (e.overlay) e.overlay.classList.remove('active');
    resetOverlay();
    if (hintFab) {
      try { localStorage.setItem('minka_door_fab_hint_done', '1'); } catch (err2) {}
    }
    if (cfg.onDoorOverlayClosed) {
      cfg.onDoorOverlayClosed({ fromRect: fromRect, hintFab: hintFab });
    }
  }

  function showCard(type, title, msg, extra, actions, guestUi) {
    var e = el();
    stopScanner();
    e.loading.style.display = 'none';
    e.card.style.display = 'block';
    bindLangSwitch(shouldShowDoorLangSwitch(guestUi));
    e.iconEl.className = 'd-icon ' + type;
    e.iconEl.style.display = 'flex';
    e.iconEl.textContent = type === 'success' ? '✔' : type === 'error' ? '✗' : type === 'warning' ? '!' : '◎';
    e.titleEl.className = 'd-title ' + type;
    e.titleEl.textContent = title;
    e.msgEl.innerHTML = msg;
    e.extraEl.innerHTML = extra || '';
    e.actionsEl.innerHTML = actions || '';
  }

  function securityLine(es) {
    return es
      ? '<b>Por tu seguridad:</b> no permitas el ingreso de extraños y mantén la puerta siempre cerrada.'
      : '<b>For your security:</b> do not allow strangers in and always keep the door closed.';
  }

  function smileLineHtml(es, name) {
    var n = name || '';
    var text = es
      ? 'No olvides sonreír a la cámara' + (n ? ', ' + n : '') + '.'
      : 'Don\'t forget to smile at the camera' + (n ? ', ' + n : '') + '.';
    return '<p class="d-msg-smile">' + text + '</p>';
  }

  function securityLineHtml(es) {
    return '<p class="d-msg-security">' + securityLine(es) + '</p>';
  }

  function monitoringLine(es) {
    return es
      ? 'No olvides sonreír a la cámara; por seguridad, el acceso al hotel es monitorizado 24/7.'
      : 'Don\'t forget to smile at the camera; for your security, hotel access is monitored 24/7.';
  }

  var QR_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h4v2H6v2H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v2h2v2H4v-4zm16 0v4h-4v-2h2v-2h2zM9 9h2v2H9V9zm4 0h2v2h-2V9zm-4 4h2v2H9v-2zm4 0h2v2h-2v-2zm4-8h2v2h-2V5zm0 4h2v2h-2V9zm-4 4h2v2h-2v-2zm4 0h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>';

  function updateQrHintUI() {
    var e = el();
    if (!e.qrHintMain) return;
    var es = isEs();
    e.qrHintMain.textContent = es
      ? 'Escanea el código QR del Hotel'
      : 'Scan the hotel QR code';
    if (e.qrHintSub) {
      e.qrHintSub.textContent = es
        ? 'Para abrir la puerta escanea el código QR que se encuentra en el timbre de la entrada del hotel.'
        : 'To open the door, scan the QR code on the doorbell at the hotel entrance.';
    }
  }

  function doorOpenButtonHtml(es, btnId) {
    return '<button type="button" class="d-btn d-btn-door-style" id="' + btnId + '">' +
      '<span class="hub-btn-layout">' +
      '<span class="hub-btn-icon" aria-hidden="true">' + QR_ICON_SVG + '</span>' +
      '<span class="hub-btn-text"><span class="hub-btn-main">' + (es ? 'Abrir puerta' : 'Open door') + '</span>' +
      '<span class="hub-btn-sub">' + (es ? 'Escanear QR' : 'Scan QR') + '</span></span></span></button>';
  }

  function apiPost(extra, cb) {
    var e = el();
    var payload = { token: getToken() };
    var did = getDeviceId();
    if (did) payload.deviceId = did;
    if (extra) {
      for (var k in extra) payload[k] = extra[k];
    }
    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 14000);
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
      .then(function(r) {
        clearTimeout(tid);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) { cb(null, data); })
      .catch(function(err) {
        clearTimeout(tid);
        cb(err, null);
      });
  }

  function applySuggestedToken(data) {
    if (data && data.suggestedToken && cfg.onTokenRefresh) {
      cfg.onTokenRefresh(data.suggestedToken);
    }
  }

  function handleResponse(data, confirmBalanceRetry) {
    applySuggestedToken(data);
    _lastResponseContext = { data: data, confirmBalance: confirmBalanceRetry };
    applyResponse(data, confirmBalanceRetry);
  }

  function maybeRevokeGuestAccess(data) {
    if (data && data.accessRevoked && cfg.onAccessRevoked) {
      cfg.onAccessRevoked();
    }
  }

  function expiredAccessHtml(es) {
    return es
      ? 'No hay una estadía activa para este acceso en la fecha de hoy. Si necesitas ayuda, contacta recepción o WhatsApp.'
      : 'There is no active stay for this access on today\'s date. Contact reception or WhatsApp if you need help.';
  }

  function applyResponse(data, confirmBalanceRetry) {
    var es = isEs();
    var guestUi = !isAdmin();
    if (data.success) {
      var roomHtml = '';
      if (data.firstAccess && data.roomInfo && data.roomInfo.length) {
        data.roomInfo.forEach(function(rm) {
          roomHtml += '<div class="room-card"><div class="rc-cat">' + ((rm.categoria || rm.title || '').replace(/-/g, ' ')) + '</div>';
          if (rm.ubicacion) {
            var u = rm.ubicacion;
            if (u.numero) {
              roomHtml += '<div class="rc-detail">🛏️ ' + (es ? 'Habitación N°: ' : 'Room #: ') + u.numero + (u.piso ? ' — ' + (es ? 'Piso ' : 'Floor ') + u.piso : '') + '</div>';
            }
            if (u.instrucciones) roomHtml += '<div class="rc-detail" style="font-style:italic;margin-top:4px">' + u.instrucciones + '</div>';
            if (u.claveAcceso) roomHtml += '<div class="rc-key">🔑 ' + u.claveAcceso + '</div>';
          }
          roomHtml += '</div>';
        });
      }
      var tit;
      var msg;
      var actions = '';
      if (data.firstAccess) {
        tit = es ? ('¡Bienvenido, ' + (data.name || '') + '!') : ('Welcome, ' + (data.name || '') + '!');
        msg = monitoringLine(es);
        actions = '<button type="button" class="d-btn" id="_doorAccept">' + (es ? 'Aceptar' : 'Accept') + '</button>';
        actions += '<div class="d-security-foot">' + securityLine(es) + '</div>';
      } else {
        tit = es ? 'Puerta abierta' : 'Door opened';
        msg = smileLineHtml(es, data.name) + securityLineHtml(es);
      }
      showCard('success', tit, msg, roomHtml, actions, guestUi);
      var acceptBtn = document.getElementById('_doorAccept');
      if (acceptBtn) acceptBtn.onclick = function() { closeOverlay({ fabHint: true }); };
      if (!data.firstAccess && guestUi) {
        setTimeout(function() { closeOverlay(); }, 2400);
      }
      return;
    }

    var err = data.error;
    if (err === 'ACCESS_EXPIRED') {
      maybeRevokeGuestAccess(data);
      showCard('warning', es ? 'Acceso caducado' : 'Access expired',
        data.message && data.message.indexOf('|') < 0 ? data.message : expiredAccessHtml(es),
        '', '<button type="button" class="d-btn" id="_doorExpOk">' + (es ? 'Entendido' : 'OK') + '</button>', guestUi);
      var expOk = document.getElementById('_doorExpOk');
      if (expOk) expOk.onclick = function() { closeOverlay(); };
      return;
    }
    if (err === 'NO_ACTIVE_RESERVATION') {
      maybeRevokeGuestAccess({ accessRevoked: true });
      showCard('warning', es ? 'Acceso caducado' : 'Access expired', expiredAccessHtml(es),
        '', '<button type="button" class="d-btn" id="_doorNaOk">' + (es ? 'Entendido' : 'OK') + '</button>', guestUi);
      var naOk = document.getElementById('_doorNaOk');
      if (naOk) naOk.onclick = function() { closeOverlay(); };
      return;
    }
    if (err === 'STAY_NOT_STARTED') {
      showCard('info', es ? 'Estadía por comenzar' : 'Stay not started yet',
        data.message || (es
          ? 'Tu reserva aún no está en curso. El acceso a la puerta se habilitará el día de tu check-in.'
          : 'Your booking is not active yet. Door access will be enabled on your check-in day.'),
        '', '', guestUi);
      return;
    }
    if (err === 'CHECKIN_REQUIRED') {
      showCard('warning', es ? 'Check-in requerido' : 'Check-in required', data.message, '',
        '<a class="d-btn" href="https://www.minkahostel.com/checkin?id=' + (data.uuid || '') + '&returnDoor=1&msg=checkin" target="_blank">📋 ' + (es ? 'Completar Check-in' : 'Complete Check-in') + '</a>', guestUi);
      return;
    }
    if (err === 'BALANCE_WARNING') {
      var bal = data.balance || 0;
      var bHtml = '<div style="font-size:11px;color:#555;line-height:1.6;margin-bottom:10px">' + data.message + '</div>';
      if (bal > 0) {
        bHtml += '<table class="balance-table"><tr><td style="color:#555">' + (es ? 'Concepto' : 'Item') + '</td><td style="text-align:right;font-weight:600">' + (es ? 'Saldo' : 'Balance') + '</td></tr>';
        bHtml += '<tr><td style="color:#555">' + (es ? 'Hospedaje' : 'Accommodation') + '</td><td style="text-align:right;font-weight:600">$' + bal.toFixed(2) + '</td></tr>';
        bHtml += '<tr class="total"><td>Total</td><td style="text-align:right;font-weight:700">$' + bal.toFixed(2) + '</td></tr></table>';
      }
      showCard('warning', es ? 'Saldo pendiente' : 'Pending balance', '', bHtml,
        doorOpenButtonHtml(es, '_bwo'), guestUi);
      document.getElementById('_bwo').onclick = function() {
        runPreflight(true, confirmBalanceRetry);
      };
      return;
    }
    if (err === 'BALANCE_CHECKOUT' || err === 'ENDED_BALANCE' || err === 'DC_ENDED_BALANCE' || err === 'DC_LAST_HOUR') {
      var pHtml = '<div style="font-size:11px;color:#555;line-height:1.6">' + data.message + '</div>';
      var payActions = data.balance > 0 && data.payUrl
        ? '<button type="button" class="d-btn" id="_doorPayBtn">' + (es ? 'Pagar' : 'Pay') + '</button>'
        : '';
      showCard('warning', es ? 'Saldo pendiente' : 'Pending balance', '', pHtml, payActions, guestUi);
      var payBtn = document.getElementById('_doorPayBtn');
      if (payBtn) payBtn.onclick = function() { openPaymentsPage(data.payUrl); };
      return;
    }
    if (err === 'DC_NOT_STARTED') { showCard('info', es ? 'Horario no disponible' : 'Schedule not available', data.message, '', '', guestUi); return; }
    if (err === 'DC_ENDED' || err === 'ENDED') {
      maybeRevokeGuestAccess(data.accessRevoked ? data : { accessRevoked: true });
      showCard('warning', es ? 'Acceso caducado' : 'Access expired',
        err === 'ENDED' ? expiredAccessHtml(es) : (data.message || expiredAccessHtml(es)),
        '', '<button type="button" class="d-btn" id="_doorEndOk">' + (es ? 'Entendido' : 'OK') + '</button>', guestUi);
      var endOk = document.getElementById('_doorEndOk');
      if (endOk) endOk.onclick = function() { closeOverlay(); };
      return;
    }
    if (err === 'CANCELLED') {
      maybeRevokeGuestAccess({ accessRevoked: true });
      showCard('warning', es ? 'Acceso caducado' : 'Access expired', data.message || expiredAccessHtml(es), '', '', guestUi);
      return;
    }
    if (err === 'DISABLED') { showCard('error', es ? 'Acceso no autorizado' : 'Access denied', data.message, '', '', guestUi); return; }
    if (err === 'DOOR_FAIL') {
      var who = data.name || '';
      showCard('error', es ? 'No se pudo abrir' : 'Could not open',
        (who ? who + ', ' : '') + (es
          ? 'no pudimos abrir la puerta en este momento. Presiona el timbre <b>una sola vez</b> frente a la cámara y espera que el sistema o un administrador autorice la apertura.'
          : 'we could not open the door right now. Press the doorbell <b>once</b> in front of the camera and wait for authorization.'), '', '', guestUi);
      return;
    }
    if (err === 'QR_INVALID') {
      showCard('warning', es ? 'QR incorrecto' : 'Wrong QR',
        es ? 'Ese código no es el de la puerta del hotel. Intenta de nuevo.' : 'That is not the hotel entrance code. Try again.',
        '', '<button class="d-btn" id="_retryQr">' + (es ? 'Escanear de nuevo' : 'Scan again') + '</button>', guestUi);
      document.getElementById('_retryQr').onclick = function() { startScanner(confirmBalanceRetry); };
      return;
    }
    if (err === 'GEO_FAR') {
      var farMsg = es
        ? 'Esta opción se activa cuando estés frente a la puerta del hotel. Acércate un poco más e inténtalo de nuevo.'
        : 'This option activates when you are in front of the hotel entrance. Get closer and try again.';
      if (data.distance != null) {
        farMsg += '<br><span style="font-size:10px;color:#999;">' + (es ? 'Distancia' : 'Distance') + ': ~' + data.distance + ' m</span>';
      }
      showCard('info', es ? 'Fuera de rango' : 'Out of range', farMsg, '', '', guestUi);
      return;
    }
    if (err === 'GEO_REQUIRED') {
      showCard('warning', es ? 'Ubicación requerida' : 'Location required',
        es ? 'Activa la ubicación en la configuración del navegador para este sitio e inténtalo de nuevo.' : 'Enable location for this site in your browser settings and try again.', '', '', guestUi);
      return;
    }
    if (err === 'QR_REQUIRED') {
      showCard('warning', es ? 'QR requerido' : 'QR required',
        data.message || (es ? 'Escanea el QR de la puerta del hotel.' : 'Scan the hotel door QR sticker.'), '', '', guestUi);
      return;
    }
    if (err === 'NOT_FOUND' || err === 'NO_UUID') {
      maybeRevokeGuestAccess({ accessRevoked: true });
      showCard('warning', es ? 'Acceso caducado' : 'Access expired', expiredAccessHtml(es), '', '', guestUi);
      return;
    }
    if (err === 'DEVICE_BOUND') {
      if (cfg.onDeviceBound) cfg.onDeviceBound();
      showCard('warning', es ? 'Acceso en otro dispositivo' : 'Access on another device',
        data.message || (es
          ? 'Este enlace ya está vinculado a otro teléfono. Usa el dispositivo donde lo abriste la primera vez o pide ayuda en recepción.'
          : 'This link is already linked to another phone. Use the device where you first opened it, or ask at reception.'),
        '', '<button type="button" class="d-btn" id="_doorBoundOk">' + (es ? 'Entendido' : 'OK') + '</button>', guestUi);
      var boundOk = document.getElementById('_doorBoundOk');
      if (boundOk) boundOk.onclick = function() { closeOverlay(); };
      return;
    }
    if (err === 'DEVICE_REQUIRED') {
      showCard('warning', es ? 'Dispositivo no identificado' : 'Device not identified',
        data.message || (es ? 'Actualiza la PWA e intenta de nuevo.' : 'Update the PWA and try again.'), '', '', guestUi);
      return;
    }
    showCard('error', es ? 'Acceso no autorizado' : 'Access denied', data.message || '', '', '', guestUi);
  }

  function openDoorRequest(extra) {
    var e = el();
    var esLoad = isEs();
    e.statusEl.textContent = e.statusEl.textContent.indexOf('...') >= 0 ? e.statusEl.textContent : (extra && extra.preflight
      ? (esLoad ? 'Verificando acceso...' : 'Checking access...')
      : (esLoad ? 'Abriendo puerta...' : 'Opening door...'));
    apiPost(extra, function(err, data) {
      if (err) {
        var esErr = isEs();
        showCard('error', esErr ? 'Error de conexión' : 'Connection error',
          (esErr ? 'No se pudo conectar.<br>' : 'Could not connect.<br>') + '<span style="font-size:9px;color:#999">' + (err.name === 'AbortError' ? (esErr ? 'Tiempo agotado' : 'Timed out') : err.message) + '</span>', '', '', !isAdmin());
        return;
      }
      if (data.success && data.preflight) {
        afterPreflightOk(data, extra && extra.confirmBalance);
        return;
      }
      handleResponse(data, extra && extra.confirmBalance);
    });
  }

  function afterPreflightOk(data, confirmBalance) {
    if (isAdmin()) {
      openDoorRequest({ confirmBalance: !!confirmBalance, doorQr: _pendingDoorQr || undefined });
      _pendingDoorQr = null;
      return;
    }
    if (_pendingDoorQr) {
      var key = _pendingDoorQr;
      _pendingDoorQr = null;
      openDoorRequest({ doorQr: key, confirmBalance: !!confirmBalance });
      return;
    }
    if (data.firstAccess) {
      openDoorRequest({ confirmBalance: !!confirmBalance });
      return;
    }
    startScanner(!!confirmBalance);
  }

  function startScanner(confirmBalance) {
    var e = el();
    if (typeof Html5Qrcode === 'undefined') {
      var esSc = isEs();
      showCard('error', esSc ? 'Escáner no disponible' : 'Scanner unavailable',
        esSc ? 'No se pudo cargar el lector QR. Recarga la app e intenta de nuevo.' : 'Could not load the QR reader. Reload the app and try again.', '', '', !isAdmin());
      return;
    }
    stopScanner();
    e.card.style.display = 'none';
    e.loading.style.display = 'none';
    e.qrStage.style.display = 'block';
    updateQrHintUI();

    qrScanner = new Html5Qrcode('doorQrReader');
    scanLock = false;
    qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      function(decoded) {
        if (scanLock) return;
        scanLock = true;
        var doorKey = extractDoorQrFromScan(decoded);
        if (!doorKey) {
          scanLock = false;
          showCard('warning', isEs() ? 'QR incorrecto' : 'Wrong QR',
            isEs() ? 'Ese código no es el de la puerta del hotel. Usa el QR debajo del timbre.' : 'That is not the hotel entrance code. Use the QR below the doorbell.',
            '', '<button class="d-btn" id="_retryQrBad">' + (isEs() ? 'Escanear de nuevo' : 'Scan again') + '</button>', !isAdmin());
          document.getElementById('_retryQrBad').onclick = function() { startScanner(confirmBalance); };
          return;
        }
        stopScanner();
        e.loading.style.display = 'block';
        e.statusEl.textContent = isEs() ? 'Abriendo puerta...' : 'Opening door...';
        openDoorRequest({ doorQr: doorKey, confirmBalance: !!confirmBalance });
      },
      function() {}
    ).catch(function(err) {
      var esCam = isEs();
      showCard('warning', esCam ? 'Cámara requerida' : 'Camera required',
        (esCam ? 'Permite el acceso a la cámara para escanear el QR de la puerta.<br>' : 'Allow camera access to scan the door QR.<br>') + '<span style="font-size:10px;color:#999">' + (err.message || err) + '</span>', '', '', !isAdmin());
    });
  }

  function runPreflight(confirmBalance, _retry) {
    var e = el();
    e.overlay.classList.add('active');
    resetOverlay();
    var esPf = isEs();
    e.statusEl.textContent = confirmBalance ? (esPf ? 'Verificando acceso...' : 'Checking access...') : (esPf ? 'Verificando reserva...' : 'Checking reservation...');
    openDoorRequest({ preflight: true, confirmBalance: !!confirmBalance });
  }

  function start() {
    _pendingDoorQr = null;
    if (!getToken()) {
      var esNa = isEs();
      showCard('warning', esNa ? 'Sin acceso' : 'No access', esNa ? 'Abre la app desde el enlace de tu correo de reserva.' : 'Open the app from your booking email link.', '', '', !isAdmin());
      el().overlay.classList.add('active');
      return;
    }
    runPreflight(false);
  }

  /** Escaneo externo del sticker: abre puerta con llave física + token del dispositivo (sin cámara). */
  function openFromDoorQr(doorQrRaw, confirmBalance) {
    var key = extractDoorQrFromScan(doorQrRaw);
    if (!key) return false;
    if (!getToken()) return false;
    if (isAdmin()) {
      var eAd = el();
      eAd.overlay.classList.add('active');
      resetOverlay();
      var esAd = isEs();
      eAd.statusEl.textContent = esAd ? 'Abriendo puerta...' : 'Opening door...';
      openDoorRequest({ doorQr: key, confirmBalance: !!confirmBalance });
      return true;
    }
    _pendingDoorQr = key;
    runPreflight(!!confirmBalance);
    return true;
  }

  var e0 = el();
  if (e0.closeBtn) {
    e0.closeBtn.onclick = function() { closeOverlay(); };
  }

  var langEsBtn = document.getElementById('doorLangEs');
  var langEnBtn = document.getElementById('doorLangEn');
  if (langEsBtn) langEsBtn.onclick = function() { setLang('es'); };
  if (langEnBtn) langEnBtn.onclick = function() { setLang('en'); };
  updateLangSwitchUI();

  return { start: start, runPreflight: runPreflight, openFromDoorQr: openFromDoorQr, extractDoorQrFromScan: extractDoorQrFromScan };
};
