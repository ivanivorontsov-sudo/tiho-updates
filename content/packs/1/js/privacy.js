/* Тихо — anti-fingerprinting & privacy shims, injected at document-start into every frame (MAIN world).
 * Techniques follow Brave "farbling" (per-session + per-site seeded noise), Cromite (API disabling,
 * canvas/audio/rects/measureText noise, hardware spoofing) and Tor/Firefox RFP (uniform values).
 * Patched functions are masked so Function.prototype.toString() still reports [native code]. */
const tihoPrivacy = (function () {
  const nativeToString = Function.prototype.toString;
  const masks = new WeakMap();
  const patched = new WeakSet();
  const hash32 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const prng = (seed) => { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

  function topHost(W) {
    try { const ao = W.location.ancestorOrigins; if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname; } catch (e) {}
    try { return W.top.location.hostname; } catch (e) {}
    return W.location.hostname;
  }
  function site(h) {
    const p = (h || '').split('.');
    if (p.length <= 2 || /^[0-9.]+$/.test(h)) return h;
    const two = p[p.length - 2];
    return (['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'msk', 'spb'].includes(two) && p[p.length - 1].length === 2) ? p.slice(-3).join('.') : p.slice(-2).join('.');
  }

  return function apply(W, C, TB) {
    if (!W || patched.has(W)) return;
    patched.add(W);
    const O = W.Object, R = W.Reflect;
    const siteKey = hash32(C.seed + '|' + site(topHost(W)));
    const rnd = prng(siteKey);
    const fudge = 0.99 + rnd() * 0.0099; // Brave "balanced" audio factor

    const mask = (fn, orig) => { masks.set(fn, typeof orig === 'function' ? nativeToString.call(orig) : 'function ' + orig + '() { [native code] }'); return fn; };
    // Mask toString itself (in this realm).
    const ts = ({ toString() { return masks.has(this) ? masks.get(this) : nativeToString.call(this); } }).toString;
    masks.set(ts, nativeToString.call(W.Function.prototype.toString));
    O.defineProperty(W.Function.prototype, 'toString', { value: ts, writable: true, configurable: true, enumerable: false });

    function method(proto, name, wrap) {
      if (!proto) return;
      const d = O.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== 'function') return;
      const orig = d.value;
      const f = ({ [name](...a) { return wrap.call(this, orig, a); } })[name];
      O.defineProperty(f, 'length', { value: orig.length });
      mask(f, orig);
      O.defineProperty(proto, name, { ...d, value: f });
    }
    function getter(proto, name, get) {
      if (!proto) return;
      const d = O.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.get) return;
      const orig = d.get;
      const g = O.getOwnPropertyDescriptor({ get [name]() { return get.call(this, orig); } }, name).get;
      mask(g, orig);
      O.defineProperty(proto, name, { ...d, get: g });
    }
    function remove(obj, name) { try { if (obj && name in obj) delete obj[name]; } catch (e) {} }
    const N = W.Navigator && W.Navigator.prototype;

    // ---------------------------------------------------------------- WebRTC IP-leak protection
    const webrtc = (mode) => {
      if (mode === 0) {
        ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCSctpTransport', 'RTCIceTransport', 'RTCDtlsTransport'].forEach((n) => remove(W, n));
      } else if (mode === 1 && W.RTCPeerConnection) {
        // Force TURN relay: no host/srflx candidates → neither local nor public IP is exposed.
        const PC = W.RTCPeerConnection;
        const relay = (cfg) => O.assign({}, cfg || {}, { iceTransportPolicy: 'relay' });
        const Wrapped = function RTCPeerConnection(cfg, ...rest) { return R.construct(PC, [relay(cfg), ...rest], new.target || Wrapped); };
        Wrapped.prototype = PC.prototype;
        O.setPrototypeOf(Wrapped, PC);
        O.defineProperty(PC.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true });
        mask(Wrapped, PC);
        method(PC.prototype, 'setConfiguration', function (orig, a) { return orig.call(this, relay(a[0])); });
        W.RTCPeerConnection = Wrapped;
        if (W.webkitRTCPeerConnection) W.webkitRTCPeerConnection = Wrapped;
      }
    };
    // «Безопасный режим оплаты»: no fingerprint noise, no UA/tz/hardware spoofing, no blocker hooks.
    // Only WebRTC stays relay-only (never fully removed here: some 3-DS / bank flows probe for it).
    if (C.payMin) { webrtc(C.webrtc === 2 ? 2 : 1); return; }
    webrtc(C.webrtc);


    // ---------------------------------------------------------------- privacy signals
    if (C.gpc) {
      if (N && !('globalPrivacyControl' in N)) {
        const g = O.getOwnPropertyDescriptor({ get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get;
        mask(g, 'get globalPrivacyControl');
        O.defineProperty(N, 'globalPrivacyControl', { get: g, enumerable: true, configurable: true });
      }
    }
    if (C.dnt) getter(N, 'doNotTrack', () => '1');

    // ---------------------------------------------------------------- beacons / hyperlink auditing
    if (C.pings) {
      method(N, 'sendBeacon', () => true); // Cromite disables Beacon API; we pretend success, send nothing
      const A = W.HTMLAnchorElement && W.HTMLAnchorElement.prototype;
      const pd = A && O.getOwnPropertyDescriptor(A, 'ping');
      if (pd && pd.set) {
        const s = O.getOwnPropertyDescriptor({ set ping(v) {} }, 'ping').set; mask(s, pd.set);
        O.defineProperty(A, 'ping', { ...pd, set: s });
      }
      remove(A, 'attributionSrc');
    }

    // ---------------------------------------------------------------- referrer trimming
    if (C.referrer && W === W.top) {
      try {
        const m = W.document.createElement('meta'); m.name = 'referrer'; m.content = 'same-origin';
        (W.document.head || W.document.documentElement).appendChild(m);
      } catch (e) {}
    }
    // Brave-style referrer trimming for script: cross-site document.referrer exposes the origin only
    // (Chromium's default header policy strict-origin-when-cross-origin already trims the Referer header).
    try {
      const D = W.Document && W.Document.prototype;
      getter(D, 'referrer', function (orig) {
        const r = orig.call(this);
        if (!r) return r;
        try { const u = new URL(r); if (site(u.hostname) !== site(W.location.hostname)) return u.origin + '/'; } catch (e) {}
        return r;
      });
    } catch (e) {}
    // Firefox/Tor-style: don't leak window.name across sites.
    try {
      if (W === W.top && W.name) {
        const ref = W.document.referrer;
        if (!ref || site(new URL(ref).hostname) !== site(W.location.hostname)) W.name = '';
      }
    } catch (e) {}

    // ---------------------------------------------------------------- blocker parity for fetch()/XHR
    // In Chrome a blocked request fails with ERR_BLOCKED_BY_CLIENT. WebView can only answer with an HTTP response,
    // which would *resolve* fetch(); so script-initiated requests are checked against adblock-rust first.
    if (C.adblock && TB) {
      const abs = (u) => { try { return new W.URL(u, W.location.href).href; } catch (e) { return ''; } };
      const check = (u) => { const a = abs(u); if (!/^https?:/.test(a)) return W.Promise.resolve(false); return TB.call('blk', { u: a }).then((r) => r === true, () => false); };
      method(W, 'fetch', function (orig, a) {
        const self = this;
        const r = a[0];
        const u = r && typeof r === 'object' && 'url' in r ? r.url : String(r);
        return check(u).then((b) => (b ? W.Promise.reject(new W.TypeError('Failed to fetch')) : orig.apply(self, a)));
      });
      const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (XP) {
        const st = new WeakMap();
        const XO = XP.open;
        method(XP, 'open', function (orig, a) { st.set(this, Array.from(a)); return orig.apply(this, a); });
        // Async check at send(): a blocked XHR is re-opened to a port Chromium refuses (ERR_UNSAFE_PORT) →
        // genuine network error, status 0. Synchronous XHRs rely on network-level blocking only.
        method(XP, 'send', function (orig, a) {
          const args = st.get(this);
          if (!args || args[2] === false) return orig.apply(this, a);
          const u = abs(args[1]);
          if (!/^https?:/.test(u)) return orig.apply(this, a);
          const xhr = this;
          check(u).then((b) => {
            try {
              if (b) { const na = args.slice(); na[1] = 'https://0.0.0.0:1/'; XO.apply(xhr, na); orig.call(xhr); }
              else orig.apply(xhr, a);
            } catch (e) {}
          });
        });
      }
    }

    if (!C.fp) return;

    // ---------------------------------------------------------------- hardware / platform uniformity
    getter(N, 'hardwareConcurrency', () => C.cores);
    getter(N, 'deviceMemory', () => C.mem);
    getter(N, 'platform', () => (C.desktop ? 'Linux x86_64' : 'Linux armv8l'));
    getter(N, 'maxTouchPoints', function (orig) { return C.desktop ? 0 : 5; });
    // Brave "prevent fingerprinting via language": expose only the primary language.
    getter(N, 'languages', function (orig) { const l = orig.call(this); return O.freeze(l && l.length ? [l[0]] : []); });
    remove(N, 'getBattery');
    remove(N, 'getInstalledRelatedApps');
    remove(N, 'keyboard');
    remove(N, 'gpu');
    remove(W, 'IdleDetector');
    // Cromite-style: hardware access APIs a web page never needs in a privacy browser.
    remove(N, 'requestMIDIAccess'); remove(N, 'hid'); remove(N, 'usb'); remove(N, 'serial'); remove(N, 'bluetooth');
    remove(W, 'ComputePressureObserver'); remove(W, 'PressureObserver');
    method(N, 'getGamepads', () => []);
    if (W.NetworkInformation) {
      const NI = W.NetworkInformation.prototype;
      getter(NI, 'effectiveType', () => '4g');
      getter(NI, 'rtt', () => 100);
      getter(NI, 'downlink', () => 10);
      getter(NI, 'downlinkMax', () => Infinity);
      getter(NI, 'saveData', () => false);
      getter(NI, 'type', () => 'unknown');
    }
    if (W.NavigatorUAData) {
      const UD = W.NavigatorUAData.prototype;
      method(UD, 'getHighEntropyValues', function (orig, a) {
        return orig.apply(this, a).then((v) => {
          const o = O.assign({}, v);
          if ('model' in o) o.model = '';
          if ('platformVersion' in o) o.platformVersion = C.desktop ? '' : '10.0.0';
          if ('architecture' in o) o.architecture = '';
          if ('bitness' in o) o.bitness = '';
          if ('uaFullVersion' in o) o.uaFullVersion = C.major + '.0.0.0';
          if ('fullVersionList' in o) o.fullVersionList = (o.fullVersionList || []).map((b) => ({ brand: b.brand, version: b.version.split('.')[0] + '.0.0.0' }));
          if ('formFactors' in o) o.formFactors = [C.desktop ? 'Desktop' : 'Mobile'];
          return o;
        });
      });
    }
    // Media devices: expose at most one device per kind with empty ids/labels until permission is granted.
    if (W.MediaDevices) {
      method(W.MediaDevices.prototype, 'enumerateDevices', function (orig, a) {
        return orig.apply(this, a).then((list) => {
          if (list.some((d) => d.label)) return list;
          const seen = new Set();
          return list.filter((d) => (seen.has(d.kind) ? false : (seen.add(d.kind), true)));
        });
      });
    }
    // Screen: report the browser window instead of the physical display (Brave/Tor approach), 24-bit colour.
    if (W.Screen) {
      const SP = W.Screen.prototype;
      const ow = () => W.outerWidth || W.innerWidth, oh = () => W.outerHeight || W.innerHeight;
      getter(SP, 'width', function (orig) { return ow() || orig.call(this); });
      getter(SP, 'height', function (orig) { return oh() || orig.call(this); });
      getter(SP, 'availWidth', function (orig) { return ow() || orig.call(this); });
      getter(SP, 'availHeight', function (orig) { return oh() || orig.call(this); });
      getter(SP, 'colorDepth', () => 24);
      getter(SP, 'pixelDepth', () => 24);
    }
    // Speech synthesis voices are a strong OS/locale fingerprint (Cromite disables the API).
    if (W.SpeechSynthesis) method(W.SpeechSynthesis.prototype, 'getVoices', () => []);

    // ---------------------------------------------------------------- sensors
    if (C.sensors) {
      ['Accelerometer', 'Gyroscope', 'Magnetometer', 'AbsoluteOrientationSensor', 'RelativeOrientationSensor',
        'LinearAccelerationSensor', 'GravitySensor', 'AmbientLightSensor', 'DeviceMotionEvent', 'DeviceOrientationEvent'].forEach((n) => remove(W, n));
      const blocked = new Set(['devicemotion', 'deviceorientation', 'deviceorientationabsolute']);
      method(W.EventTarget && W.EventTarget.prototype, 'addEventListener', function (orig, a) {
        if (this === W && blocked.has(String(a[0]).toLowerCase())) return undefined;
        return orig.apply(this, a);
      });
      ['ondevicemotion', 'ondeviceorientation', 'ondeviceorientationabsolute'].forEach((n) => {
        try { O.defineProperty(W, n, { get() { return null; }, set(v) {}, configurable: true }); } catch (e) {}
      });
    }

    // ---------------------------------------------------------------- canvas farbling
    const noisify = (data, w, h) => {
      const n = (data.length / 4) | 0;
      if (!n) return;
      let hsh = siteKey;
      const step = Math.max(4, ((data.length / 97) | 0) & ~3);
      for (let i = 0; i < data.length; i += step) hsh = Math.imul(hsh ^ data[i], 16777619) >>> 0;
      const r = prng(hsh);
      const count = Math.min(n, 12 + (n >> 11));
      for (let k = 0; k < count; k++) {
        const p = ((r() * n) | 0) * 4 + ((r() * 3) | 0);
        data[p] = data[p] ^ 1;
      }
    };
    const C2D = W.CanvasRenderingContext2D && W.CanvasRenderingContext2D.prototype;
    const origGetImageData = C2D && C2D.getImageData;
    const origPutImageData = C2D && C2D.putImageData;
    [C2D, W.OffscreenCanvasRenderingContext2D && W.OffscreenCanvasRenderingContext2D.prototype].forEach((P) => {
      method(P, 'getImageData', function (orig, a) { const d = orig.apply(this, a); try { noisify(d.data); } catch (e) {} return d; });
    });
    const farbledCopy = (src) => {
      const w = src.width, h = src.height;
      if (!w || !h || w * h > 4096 * 4096) return null;
      const c = W.document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const id = origGetImageData.call(ctx, 0, 0, w, h);
      noisify(id.data);
      origPutImageData.call(ctx, id, 0, 0);
      return c;
    };
    const HC = W.HTMLCanvasElement && W.HTMLCanvasElement.prototype;
    ['toDataURL', 'toBlob'].forEach((name) => method(HC, name, function (orig, a) {
      let copy = null;
      try { copy = farbledCopy(this); } catch (e) { copy = null; }
      return orig.apply(copy || this, a);
    }));
    if (W.OffscreenCanvas) method(W.OffscreenCanvas.prototype, 'convertToBlob', function (orig, a) {
      try {
        const ctx = this.getContext('2d');
        if (ctx) { const id = ctx.getImageData(0, 0, this.width, this.height); ctx.putImageData(id, 0, 0); }
      } catch (e) {}
      return orig.apply(this, a);
    });
    // measureText & DOMRect noise (Cromite: #fingerprinting-canvas-measuretext-noise / client-rects-noise)
    if (W.TextMetrics) {
      const k = 1 + (rnd() - 0.5) * 2e-5;
      ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent'].forEach((p) =>
        getter(W.TextMetrics.prototype, p, function (orig) { return orig.call(this) * k; }));
    }
    const rk = 1 + (rnd() - 0.5) * 2e-7;
    const farbleRect = (r) => { try { return new W.DOMRect(r.x * rk, r.y * rk, r.width * rk, r.height * rk); } catch (e) { return r; } };
    method(W.Element && W.Element.prototype, 'getBoundingClientRect', function (orig, a) { return farbleRect(orig.apply(this, a)); });
    method(W.Range && W.Range.prototype, 'getBoundingClientRect', function (orig, a) { return farbleRect(orig.apply(this, a)); });

    // ---------------------------------------------------------------- WebGL
    const GLs = [W.WebGLRenderingContext, W.WebGL2RenderingContext].filter(Boolean).map((c) => c.prototype);
    if (C.webgl) {
      // Cromite default: WebGL disabled.
      [HC, W.OffscreenCanvas && W.OffscreenCanvas.prototype].forEach((P) => method(P, 'getContext', function (orig, a) {
        const t = String(a[0]).toLowerCase();
        if (t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl') return null;
        return orig.apply(this, a);
      }));
    } else {
      GLs.forEach((P) => {
        method(P, 'getParameter', function (orig, a) {
          // Report one very common GPU instead of the real one (large anonymity set, like a uniform RFP value).
          if (a[0] === 0x9245) return C.desktop ? 'Google Inc. (Intel)' : 'Qualcomm';               // UNMASKED_VENDOR_WEBGL
          if (a[0] === 0x9246) return C.desktop ? 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' : 'Adreno (TM) 640'; // UNMASKED_RENDERER_WEBGL
          return orig.apply(this, a);
        });
        method(P, 'readPixels', function (orig, a) {
          const r = orig.apply(this, a);
          try { const px = a[6]; if (px && px.length) noisify(px); } catch (e) {}
          return r;
        });
      });
    }

    // ---------------------------------------------------------------- audio farbling
    if (W.AudioBuffer) {
      const done = new WeakSet();
      method(W.AudioBuffer.prototype, 'getChannelData', function (orig, a) {
        const d = orig.apply(this, a);
        if (!done.has(d)) { done.add(d); for (let i = 0; i < d.length; i++) d[i] *= fudge; }
        return d;
      });
      method(W.AudioBuffer.prototype, 'copyFromChannel', function (orig, a) {
        const r = orig.apply(this, a); const d = a[0]; if (d) for (let i = 0; i < d.length; i++) d[i] *= fudge; return r;
      });
    }
    if (W.AnalyserNode) {
      const AN = W.AnalyserNode.prototype;
      ['getFloatFrequencyData', 'getFloatTimeDomainData'].forEach((n) => method(AN, n, function (orig, a) {
        const r = orig.apply(this, a); const d = a[0]; if (d) for (let i = 0; i < d.length; i++) d[i] *= fudge; return r;
      }));
      ['getByteFrequencyData', 'getByteTimeDomainData'].forEach((n) => method(AN, n, function (orig, a) {
        const r = orig.apply(this, a); const d = a[0]; if (d) for (let i = 0; i < d.length; i += 97) d[i] = (d[i] * fudge) | 0; return r;
      }));
    }

    // ---------------------------------------------------------------- timezone → UTC (Tor-style, optional)
    if (C.tz) {
      const DTF = W.Intl.DateTimeFormat;
      const Wrapped = function DateTimeFormat(loc, opts) {
        const o = O.assign({}, opts || {}); if (!o.timeZone) o.timeZone = 'UTC';
        return new.target ? R.construct(DTF, [loc, o], new.target) : DTF(loc, o);
      };
      Wrapped.prototype = DTF.prototype; O.setPrototypeOf(Wrapped, DTF); mask(Wrapped, DTF);
      W.Intl.DateTimeFormat = Wrapped;
      const D = W.Date.prototype;
      method(D, 'getTimezoneOffset', () => 0);
      [['getHours', 'getUTCHours'], ['getMinutes', 'getUTCMinutes'], ['getSeconds', 'getUTCSeconds'], ['getDate', 'getUTCDate'],
        ['getDay', 'getUTCDay'], ['getMonth', 'getUTCMonth'], ['getFullYear', 'getUTCFullYear'], ['getMilliseconds', 'getUTCMilliseconds']]
        .forEach(([l, u]) => { const f = D[u]; method(D, l, function () { return f.call(this); }); });
      ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((n) => method(D, n, function (orig, a) {
        const o = O.assign({}, a[1] || {}); if (!o.timeZone) o.timeZone = 'UTC'; return orig.call(this, a[0], o);
      }));
      method(D, 'toString', function () { return isNaN(this) ? 'Invalid Date' : this.toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)'); });
      method(D, 'toTimeString', function () { return isNaN(this) ? 'Invalid Date' : this.toISOString().substr(11, 8) + ' GMT+0000 (Coordinated Universal Time)'; });
    }

    // ---------------------------------------------------------------- same-origin iframes created from script
    // (a classic bypass: grab pristine APIs from a fresh about:blank iframe)
    const IF = W.HTMLIFrameElement && W.HTMLIFrameElement.prototype;
    getter(IF, 'contentWindow', function (orig) { const w = orig.call(this); try { if (w) apply(w, C, TB); } catch (e) {} return w; });
    getter(IF, 'contentDocument', function (orig) { const d = orig.call(this); try { if (d && d.defaultView) apply(d.defaultView, C, TB); } catch (e) {} return d; });
  };
})();
