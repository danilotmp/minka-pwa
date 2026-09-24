/**
 * Flujo PWA: preflight → (1.er acceso: abrir directo | resto: escáner QR) → abrir puerta
 */
window.MinkaDoorFlow = function(cfg) {
  var API_URL = cfg.apiUrl;
  var IMG_BP = cfg.imgBp;
  var getToken = cfg.getToken || function() { return ''; };
  var isAdmin = cfg.isAdmin || function() { return false; };

  var qrScanner = null;
  var scanLock = false;
  var LANG_KEY = 'minka_lang';
  var _lastResponseContext = null;

  function getLang() {
    try {
      var l = sessionStorage.getItem(LANG_KEY);
      if (l === 'en' || l === 'es') return l;
    } catch (e) {}
    return 'es';
  }

  function setLang(lang) {
    if (lang !== 'es' && lang !== 'en') return;
    try { sessionStorage.setItem(LANG_KEY, lang); } catch (e) {}
    updateLangSwitchUI();
    try { window.dispatchEvent(new CustomEvent('minkaLangChange')); } catch (e) {}
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
      qrHint: document.getElementById('doorQrHint'),
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

  function closeOverlay(opts) {
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
    if (hintFab && cfg.onDoorOverlayClosed) {
      try { localStorage.setItem('minka_door_fab_hint_done', '1'); } catch (err2) {}
      cfg.onDoorOverlayClosed({ fromRect: fromRect });
    }
  }

  function showCard(type, title, msg, extra, actions, guestUi) {
    var e = el();
    stopScanner();
    e.loading.style.display = 'none';
    e.card.style.display = 'block';
    bindLangSwitch(!!guestUi && !isAdmin());
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

  function smileLine(es, name) {
    var n = name || '';
    return es
      ? 'No olvides sonreír a la cámara' + (n ? ', <b>' + n + '</b>' : '') + '.'
      : 'Don\'t forget to smile at the camera' + (n ? ', <b>' + n + '</b>' : '') + '.';
  }

  function monitoringLine(es) {
    return es
      ? 'No olvides sonreír a la cámara; por seguridad, el acceso al hotel es monitorizado 24/7.'
      : 'Don\'t forget to smile at the camera; for your security, hotel access is monitored 24/7.';
  }

  function apiPost(extra, cb) {
    var e = el();
    var payload = { token: getToken() };
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

  function handleResponse(data, confirmBalanceRetry) {
    _lastResponseContext = { data: data, confirmBalance: confirmBalanceRetry };
    applyResponse(data, confirmBalanceRetry);
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
        msg = smileLine(es, data.name) + '<br>' + securityLine(es);
      }
      showCard('success', tit, msg, roomHtml, actions, guestUi);
      var acceptBtn = document.getElementById('_doorAccept');
      if (acceptBtn) acceptBtn.onclick = function() { closeOverlay({ fabHint: true }); };
      return;
    }

    var err = data.error;
    if (err === 'NO_ACTIVE_RESERVATION') {
      showCard('info', es ? 'Sin reserva activa' : 'No active reservation', es ? 'No se encontró una reserva activa para hoy.' : 'No active reservation found for today.', '', '', guestUi);
      return;
    }
    if (err === 'CHECKIN_REQUIRED') {
      showCard('warning', es ? 'Check-in requerido' : 'Check-in required', data.message, '',
        '<a class="d-btn" href="https://www.minkahostel.com/checkin?id=' + (data.uuid || '') + '&returnDoor=1&msg=checkin" target="_blank">📋 ' + (es ? 'Completar Check-in' : 'Complete Check-in') + '</a>', guestUi);
      return;
    }
    if (err === 'BALANCE_WARNING') {
      var bal = data.balance || 0;
      var bHtml = '<img src="' + IMG_BP + '" style="width:60px;margin:4px auto 8px;display:block">';
      bHtml += '<div style="font-size:11px;color:#555;line-height:1.6;margin-bottom:10px">' + data.message + '</div>';
      if (bal > 0) {
        bHtml += '<table class="balance-table"><tr><td style="color:#555">' + (es ? 'Concepto' : 'Item') + '</td><td style="text-align:right;font-weight:600">' + (es ? 'Saldo' : 'Balance') + '</td></tr>';
        bHtml += '<tr><td style="color:#555">' + (es ? 'Hospedaje' : 'Accommodation') + '</td><td style="text-align:right;font-weight:600">$' + bal.toFixed(2) + '</td></tr>';
        bHtml += '<tr class="total"><td>Total</td><td style="text-align:right;font-weight:700">$' + bal.toFixed(2) + '</td></tr></table>';
      }
      showCard('warning', es ? 'Saldo pendiente' : 'Pending balance', '', bHtml,
        '<button class="d-btn" id="_bwo">' + (es ? 'Continuar' : 'Continue') + '</button>', guestUi);
      document.getElementById('_bwo').onclick = function() {
        runPreflight(true, confirmBalanceRetry);
      };
      return;
    }
    if (err === 'BALANCE_CHECKOUT' || err === 'ENDED_BALANCE' || err === 'DC_ENDED_BALANCE' || err === 'DC_LAST_HOUR') {
      var pHtml = '<img src="' + IMG_BP + '" style="width:60px;margin:4px auto 8px;display:block">';
      pHtml += '<div style="font-size:11px;color:#555;line-height:1.6">' + data.message + '</div>';
      showCard('warning', es ? 'Saldo pendiente' : 'Pending balance', '', pHtml,
        data.balance > 0 ? '<a class="d-btn" href="https://www.minkahostel.com/?t=' + encodeURIComponent(getToken()) + '" target="_blank">' + (es ? 'Pagar' : 'Pay') + '</a>' : '', guestUi);
      return;
    }
    if (err === 'DC_NOT_STARTED') { showCard('info', es ? 'Horario no disponible' : 'Schedule not available', data.message, '', '', guestUi); return; }
    if (err === 'DC_ENDED' || err === 'ENDED') { showCard('success', es ? 'Finalizado' : 'Ended', data.message, '', '', guestUi); return; }
    if (err === 'CANCELLED' || err === 'DISABLED') { showCard('error', es ? 'Acceso no autorizado' : 'Access denied', data.message, '', '', guestUi); return; }
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
      showCard('error', es ? 'Reserva no encontrada' : 'Reservation not found',
        es ? 'No pudimos encontrar tu reserva. Verifica el enlace o contáctanos.' : 'We could not find your reservation. Check your link or contact us.', '', '', guestUi);
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
      openDoorRequest({ confirmBalance: !!confirmBalance });
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
    e.qrHint.textContent = isEs()
      ? 'Apunta al QR de la puerta (código del hotel, no tu enlace de reserva)'
      : 'Point at the door QR (hotel code, not your booking link)';

    qrScanner = new Html5Qrcode('doorQrReader');
    scanLock = false;
    qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      function(decoded) {
        if (scanLock) return;
        scanLock = true;
        stopScanner();
        e.loading.style.display = 'block';
        e.statusEl.textContent = isEs() ? 'Abriendo puerta...' : 'Opening door...';
        openDoorRequest({ doorQr: decoded, confirmBalance: !!confirmBalance });
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
    if (!getToken()) {
      var esNa = isEs();
      showCard('warning', esNa ? 'Sin acceso' : 'No access', esNa ? 'Abre la app desde el enlace de tu correo de reserva.' : 'Open the app from your booking email link.', '', '', !isAdmin());
      el().overlay.classList.add('active');
      return;
    }
    runPreflight(false);
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

  return { start: start, runPreflight: runPreflight };
};
