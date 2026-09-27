/* Tearable pages: each section is a sheet of plastic film you rip off to reach the next one.

   The page rests one screen at a time. Grab it and pull, any way you like: the film lifts toward
   you and gives a little; pull far enough and the edge holding it stretches into strands and
   snaps. While you hold it, it hangs from your hand; let go and it's thrown off with your mouse's
   speed. The wheel and keys tear on or turn back a screen, and nav links, the "Tear" cue and
   back-to-top go anywhere. The page you're going to is already underneath. The last page
   (Contact) is indestructible: it stretches and springs back.

   The screen is photographed (modern-screenshot, loaded on first use) and laid on a Verlet sheet
   drawn with WebGL, pinned along a perforation just off-screen. Past a small strain the film
   flows (stretches for good), goes milky and thins out, the way plastic does. Desktop only (a
   wide screen with a mouse or trackpad); phones, tablets, reduced motion, no WebGL or any
   failure keep plain scrolling. */
(function () {
  'use strict';

  var LIB = 'https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/dist/index.mjs';
  var wide = window.matchMedia('(min-width: 960px)');
  var coarse = window.matchMedia('(pointer: coarse)');   // phones and tablets just scroll
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var root = document.documentElement;
  var hero = document.getElementById('home');
  var main = document.querySelector('main.orig');
  if (!hero || !main || !window.WebGLRenderingContext || !window.Promise) return;
  var pages = [hero].concat(Array.prototype.filter.call(main.children, function (n) { return n.classList.contains('o-section'); }));

  /* ---------- physics constants (CSS px, seconds) ---------- */
  var COLS = 64;             // cells along the screen's long side
  var DT = 1 / 120;          // fixed sub-step
  var ITER = 4;              // constraint passes per sub-step: few, so the film is elastic
  var FILM = 0.5;            // how hard each pass pulls a link back: soft, so it flows in smooth waves
  var BEND = 0.08;           // skip-one links that resist folding: film is floppy
  var DAMP = 0.986;          // speed kept per sub-step: heavily damped, so motion is smooth, never twitchy
  var YIELD = 1.25;          // past 25% strain the film flows: it stays stretched
  var FLOW = 0.15;           // how quickly it flows once past yield
  var SNAP = 3.2;            // a perforation strand snaps at this stretch of its original length...
  var SNAP_RUN = 1.9;        // ...or sooner once the running tear has reached it
  var GRAVITY = 1400;        // px/s^2, from the moment the sheet comes free: light, so it floats off
  var AIR_N = 8;             // drag across the sheet's face (1/s): it glides and flutters
  var AIR_T = 0.35;          // drag along the face
  var FOCAL = 1700;          // camera distance; z toward the viewer grows the sheet
  var PULL = 0.14;           // share of the screen height you pull before the film gives
  var LIGHT = norm3(-0.38, -0.52, 0.76);   // from the top left, in front of the screen

  var enabledFlag = true, busy = false, queued = null, sheetSeq = 0;
  var sheets = [], raf = 0, lastT = 0;

  function enabled() { return enabledFlag && wide.matches && !coarse.matches && !calm.matches; }
  function norm3(x, y, z) { var l = Math.sqrt(x * x + y * y + z * z); return [x / l, y / l, z / l]; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function vh() { return window.innerHeight; }
  function vw() { return root.clientWidth; }            // without a classic scrollbar
  function scrollY() { return window.pageYOffset || root.scrollTop; }
  function bounds(i) {
    var r = pages[i].getBoundingClientRect(), y = scrollY();
    return { top: r.top + y, bottom: r.bottom + y };
  }
  function pageAt(y) {
    for (var i = pages.length - 1; i >= 0; i--) if (bounds(i).top <= y + 1) return i;
    return 0;
  }
  /* the page you're on; at the very bottom that's the last page */
  function here() {
    var y = scrollY();
    return y >= root.scrollHeight - vh() - 2 ? pages.length - 1 : pageAt(y);
  }
  var last = pages.length - 1;
  /* instant scroll even though html has scroll-behavior:smooth (the style is read back first so
     the browser can't scroll with a stale, smooth one) */
  function jump(y) {
    var s = root.style, was = s.scrollBehavior;
    s.scrollBehavior = 'auto';
    void getComputedStyle(root).scrollBehavior;
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
    s.scrollBehavior = was;
  }

  /* tell the page it can be torn: the hero cue says so, and the pages show a grab cursor */
  var cue = hero.querySelector('.hero-scroll'), cueWord = cue && cue.querySelector('.cue-word');
  function mark() {
    var on = enabled();
    root.classList.toggle('tearable', on);
    if (cueWord) cueWord.textContent = on ? 'Tear' : 'Scroll';
    if (cue) cue.setAttribute('aria-label', (on ? 'Tear' : 'Scroll') + ' to Experience');
  }
  mark();
  [wide, coarse, calm].forEach(function (q) { if (q.addEventListener) q.addEventListener('change', mark); else if (q.addListener) q.addListener(mark); });

  /* ---------- screen snapshot ---------- */
  var lib = null, shot = null, pending = null, dirty = 0, mutatedAt = 0, heroOn = true, warmT = 0, wanted = false, shotDoneAt = -1;
  function changed() { dirty++; mutatedAt = performance.now(); if (wanted) schedule(); }
  var watch = { subtree: true, childList: true, attributes: true, characterData: true };
  new MutationObserver(changed).observe(main, watch);
  /* the hero's headline types forever; it only matters while the hero is in the picture */
  new MutationObserver(function () { if (heroOn) changed(); }).observe(hero, watch);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { heroOn = es[0].isIntersecting; }).observe(hero);

  function scale() { return Math.min(window.devicePixelRatio || 1, 2); }
  function shotKey() { return [Math.round(scrollY()), vw(), vh(), scale(), dirty].join(); }
  function fresh() { return !!shot && shot.key === shotKey(); }
  function visible(el) { var r = el.getBoundingClientRect(); return r.bottom > 1 && r.top < vh() - 1; }

  function capture() {
    var key = shotKey();
    if (shot && shot.key === key) return Promise.resolve(shot.canvas);
    if (pending && pending.key === key) return pending.promise;
    var job = { key: key };
    job.promise = (lib || (lib = import(LIB))).then(function (ms) { return paint(ms); }).then(function (canvas) {
      /* a picture taken mid-animation goes stale once the animation moves on, so only keep it
         when nothing had changed for a moment before it was taken */
      if (performance.now() - mutatedAt > 1500 && shotKey() === key) shot = { key: key, canvas: canvas };
      if (pending === job) pending = null;
      shotDoneAt = performance.now();
      return canvas;
    }, function (err) { if (pending === job) pending = null; shotDoneAt = performance.now(); throw err; });
    pending = job;
    return job.promise;
  }

  function paint(ms) {
    var s = scale(), w = vw(), h = vh();
    var out = document.createElement('canvas');
    out.width = Math.round(w * s); out.height = Math.round(h * s);
    var g = out.getContext('2d');
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#140c0e';
    g.fillRect(0, 0, out.width, out.height);
    var work = Promise.resolve();
    if (visible(hero)) work = work.then(function () {
      /* WebGL clears its buffer after each frame; the portal renders one on demand for us */
      var cv = hero.querySelector('canvas'), still = cv && cv._still && cv._still();
      if (still) cv.toDataURL = function () { return still; };
      return ms.domToCanvas(hero, { scale: s }).then(function (c) {
        if (still) delete cv.toDataURL;
        var r = hero.getBoundingClientRect();
        g.drawImage(c, r.left * s, r.top * s, r.width * s, r.height * s);
      }, function (e) { if (still) delete cv.toDataURL; throw e; });
    });
    var keep = pages.slice(1).filter(visible);
    if (keep.length) work = work.then(function () {
      var mr = main.getBoundingClientRect(), fr = keep[0].getBoundingClientRect();
      var lr = keep[keep.length - 1].getBoundingClientRect(), skipped = fr.top - mr.top;
      /* render only the sections on screen; shift main's grid background by what was skipped */
      return ms.domToCanvas(main, {
        scale: s,
        height: lr.bottom - fr.top,
        style: { backgroundPosition: '0 ' + (-skipped) + 'px' },
        filter: function (n) { return !(n.parentNode === main && n.nodeType === 1 && n.classList.contains('o-section') && keep.indexOf(n) < 0); }
      }).then(function (c) { g.drawImage(c, mr.left * s, fr.top * s, c.width, c.height); });
    });
    return work.then(function () { return out; });
  }

  /* a standing request for a fresh picture: it waits until the page has been still for a moment
     (a picture of an entrance animation mid-way would be stale), and asks again if the page
     changes before it lands */
  function warm() { if (enabled()) { wanted = true; schedule(); } }
  function schedule() {
    clearTimeout(warmT);
    warmT = setTimeout(tryWarm, heroOn ? 60 : Math.max(60, 1600 - (performance.now() - mutatedAt)));
  }
  function tryWarm() {
    if (!wanted || busy || pending) return;
    if (fresh()) { wanted = false; return; }
    if (!heroOn && performance.now() - mutatedAt < 1500) { schedule(); return; }
    var run = function () {
      if (busy || !wanted) return;
      capture().then(function () { if (fresh()) wanted = false; else schedule(); }, function () { wanted = false; });
    };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 700 }); else setTimeout(run, 60);
  }

  /* ---------- WebGL layer ---------- */
  var layer = null, gl = null, glBroken = false, P = null, SP = null, CP = null, quad = null, fbo = null;

  var VS = [
    'attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUv; attribute float aStrain;',
    'uniform vec2 uView; uniform float uF; uniform float uBias;',
    'varying vec2 vUv; varying vec3 vNor; varying float vS;',
    'void main(){',
    '  float z = min(aPos.z, uF * 0.7), w = (uF - z) / uF;',
    '  vec2 c = uView * 0.5, q = c + (aPos.xy - c) / w;',
    '  vec2 ndc = vec2(q.x / uView.x * 2.0 - 1.0, 1.0 - q.y / uView.y * 2.0);',
    '  gl_Position = vec4(ndc * w, (-z / 4000.0 - uBias) * w, w);',
    '  vUv = aUv; vNor = aNor; vS = aStrain;',
    '}'
  ].join('\n');
  var FS = [
    'precision mediump float;',
    'uniform sampler2D uTex; uniform vec3 uLight;',
    'varying vec2 vUv; varying vec3 vNor; varying float vS;',
    'void main(){',
    '  vec3 n = normalize(vNor); if (!gl_FrontFacing) n = -n;',
    '  float lit = clamp(1.0 + 0.55 * (dot(n, uLight) - uLight.z), 0.62, 1.1);',
    '  vec3 t = texture2D(uTex, clamp(vUv, 0.0, 1.0)).rgb;',
    /* film: from behind you see the print reversed through a pale layer */
    '  vec3 col = gl_FrontFacing ? t : mix(vec3(0.9, 0.92, 0.95), t, 0.42);',
    /* stretched plastic goes milky and thins until the page below shows through */
    '  col = mix(col, vec3(0.93, 0.95, 0.98), 0.35 * smoothstep(0.3, 1.4, vS));',
    '  float a = 1.0 - 0.4 * smoothstep(0.9, 2.4, vS);',
    /* gloss: a highlight wherever the film bends toward the light (none while it lies flat) */
    '  vec3 h = normalize(uLight + vec3(0.0, 0.0, 1.0));',
    '  float sp = max(pow(max(dot(n, h), 0.0), 60.0) - pow(h.z, 60.0), 0.0);',
    '  col = col * lit + vec3(0.14 * sp);',
    '  gl_FragColor = vec4(col * a, a);',
    '}'
  ].join('\n');
  /* shadow: the sheet flattened onto the page, pushed away from the light by its height */
  var SVS = [
    'attribute vec3 aPos; uniform vec2 uView; uniform vec2 uCast; varying float vZ;',
    'void main(){',
    '  vec2 q = aPos.xy + uCast * aPos.z;',
    '  gl_Position = vec4(q.x / uView.x * 2.0 - 1.0, 1.0 - q.y / uView.y * 2.0, 0.0, 1.0);',
    '  vZ = aPos.z;',
    '}'
  ].join('\n');
  var SFS = [
    'precision mediump float; varying float vZ;',
    'void main(){ float a = 0.26 * smoothstep(0.0, 40.0, vZ) * (1.0 - smoothstep(60.0, 1100.0, vZ)); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }'
  ].join('\n');
  /* composite the low-res shadow with a small blur */
  var CVS = 'attribute vec2 aQ; varying vec2 vT; void main(){ vT = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }';
  var CFS = [
    'precision mediump float; uniform sampler2D uS; uniform vec2 uPx; varying vec2 vT;',
    'void main(){',
    '  vec4 s = texture2D(uS, vT) * 0.36;',
    '  s += (texture2D(uS, vT + vec2(uPx.x, 0.0)) + texture2D(uS, vT - vec2(uPx.x, 0.0)) + texture2D(uS, vT + vec2(0.0, uPx.y)) + texture2D(uS, vT - vec2(0.0, uPx.y))) * 0.16;',
    '  gl_FragColor = s;',
    '}'
  ].join('\n');

  function program(vs, fs) {
    function sh(type, src) {
      var o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), o = { p: p };
    for (var i = 0; i < n; i++) { var u = gl.getActiveUniform(p, i).name; o[u] = gl.getUniformLocation(p, u); }
    for (var j = 0; j < m; j++) { var a = gl.getActiveAttrib(p, j).name; o[a] = gl.getAttribLocation(p, a); }
    return o;
  }

  function ensureGL() {
    if (gl) return true;
    if (glBroken) return false;
    try {
      layer = document.createElement('canvas');
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:30;pointer-events:none;display:none';   // 100% of the viewport = clientWidth
      document.body.appendChild(layer);
      gl = layer.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
      if (!gl) throw new Error('no webgl');
      P = program(VS, FS); SP = program(SVS, SFS); CP = program(CVS, CFS);
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      layer.addEventListener('webglcontextlost', function (e) { e.preventDefault(); glBroken = true; clearAll(); });
      return true;
    } catch (e) {
      if (window.console) console.warn('[page tear] off:', e && e.message);
      glBroken = true; gl = null;
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      return false;
    }
  }

  function sizeLayer() {
    var s = scale(), w = Math.round(vw() * s), h = Math.round(vh() * s);
    if (layer.width !== w || layer.height !== h) { layer.width = w; layer.height = h; }
    var fw = Math.max(1, Math.round(w / 8)), fh = Math.max(1, Math.round(h / 8));
    if (!fbo || fbo.w !== fw || fbo.h !== fh) {
      if (fbo) { gl.deleteFramebuffer(fbo.f); gl.deleteTexture(fbo.t); }
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fbo = { f: f, t: t, w: fw, h: fh };
    }
  }

  /* ---------- the sheet ---------- */
  /* the way a sheet leaves when held along one side */
  function awayFrom(pin) { return pin === 'top' ? [0, 1] : pin === 'bottom' ? [0, -1] : pin === 'left' ? [1, 0] : [-1, 0]; }

  /* pin: the side held by the perforation, just off-screen ('top', 'bottom', 'left', 'right');
     the sheet leaves the other way. On to the next page it goes up ('bottom') or, swiped on a
     phone, left ('right'); back a page, down ('top') or right ('left').
     opt.hand 'auto' rips it by itself from a corner (on the side of opt.x / opt.y); 'pointer'
     follows the mouse or finger from (opt.x, opt.y) and only comes free when rip() is called. */
  function Sheet(img, pin, opt) {
    var W = vw(), H = vh();
    /* cells along the long side; the short side follows the screen's aspect */
    var long = COLS, cols, rows;
    if (W >= H) { cols = long; rows = Math.max(8, Math.round(long * H / W)); }
    else { rows = long; cols = Math.max(8, Math.round(long * W / H)); }
    var eL = pin === 'left' ? 1 : 0, eR = pin === 'right' ? 1 : 0, eT = pin === 'top' ? 1 : 0, eB = pin === 'bottom' ? 1 : 0;
    var nx = cols + 1 + eL + eR, ny = rows + 1 + eT + eB, n = nx * ny, cw = W / cols, ch = H / rows;
    var away = this.away = awayFrom(pin);
    var horiz = away[1] === 0;
    this.W = W; this.H = H; this.pin = pin; this.nx = nx; this.lines = ny; this.n = n; this.t = 0;
    var pos = this.pos = new Float32Array(n * 3), prev = this.prev = new Float32Array(n * 3);
    var inv = this.inv = new Float32Array(n), uv = new Float32Array(n * 2);
    this.nor = new Float32Array(n * 3);
    this.strain = new Float32Array(n);
    for (var L = 0; L < ny; L++) {
      var y = (L - eT) * ch;
      for (var i = 0; i < nx; i++) {
        var k = L * nx + i, x = (i - eL) * cw;
        pos[k * 3] = prev[k * 3] = x; pos[k * 3 + 1] = prev[k * 3 + 1] = y;
        uv[k * 2] = x / W; uv[k * 2 + 1] = y / H;
        inv[k] = (eT && L === 0) || (eB && L === ny - 1) || (eL && i === 0) || (eR && i === nx - 1) ? 0 : 1;
        this.nor[k * 3 + 2] = 1;
      }
    }
    this.home = new Float32Array(pos);            // where each point lies on the pad

    /* links: a link from the perforation line to the sheet is a perforation link (it can tear) */
    var A = [], B = [], S = [], T = [], hId = [], vId = [];
    function link(a, b, s) {
      if (!inv[a] && !inv[b]) return -1;
      A.push(a); B.push(b); S.push(s); T.push(!inv[a] || !inv[b] ? 1 : 0);
      return A.length - 1;
    }
    for (L = 0; L < ny; L++) {
      for (i = 0; i < nx; i++) {
        k = L * nx + i;
        if (i < nx - 1) hId[k] = link(k, k + 1, 1);
        if (L < ny - 1) vId[k] = link(k, k + nx, 1);
        if (i < nx - 2 && inv[k] && inv[k + 2]) link(k, k + 2, BEND);
        if (L < ny - 2 && inv[k] && inv[k + 2 * nx]) link(k, k + 2 * nx, BEND);
      }
    }
    var tris = [], perf = [];
    for (L = 0; L < ny - 1; L++) {
      for (i = 0; i < nx - 1; i++) {
        var a = L * nx + i, b = a + 1, c = a + nx, d = c + 1;
        var s1 = link(b, c, 1), s2 = link(a, d, 1);
        if (!inv[a] || !inv[b] || !inv[c] || !inv[d]) {
          perf.push({ at: tris.length, cons: [hId[a], hId[c], vId[a], vId[b], s1, s2].filter(function (q) { return q >= 0 && T[q]; }) });
        }
        tris.push(a, c, b, b, c, d);
      }
    }
    var m = A.length;
    this.m = m;
    this.ca = new Int32Array(A); this.cb = new Int32Array(B);
    this.stiff = new Float32Array(S); this.tear = new Uint8Array(T);
    this.alive = new Uint8Array(m); this.alive.fill(1);
    this.rest = new Float32Array(m);
    for (var q = 0; q < m; q++) {
      var ia = A[q] * 3, ib = B[q] * 3;
      var dx = pos[ib] - pos[ia], dy = pos[ib + 1] - pos[ia + 1];
      this.rest[q] = Math.sqrt(dx * dx + dy * dy);
    }
    this.rest0 = new Float32Array(this.rest);     // the film's original lengths, before it flowed
    this.tearable = T.reduce(function (s, v) { return s + v; }, 0);
    this.broken = 0; this.torn = 0;
    this.tris = new Uint16Array(tris); this.perf = perf; this.indexDirty = true; this.count = tris.length;

    /* the hand */
    var auto = opt.hand !== 'pointer';
    var across = horiz ? [0, 1] : [1, 0];                  // along the perforation
    var aDim = horiz ? W : H, cDim = horiz ? H : W;
    var side = (horiz ? opt.y : opt.x) < cDim / 2 ? -1 : 1, gx, gy, R;
    if (auto) {
      /* near the leading corner, far from the perforation: it peels the corner up toward you,
         then rips diagonally across so the sheet turns as it goes (a straight pull reads as a scroll) */
      var lead = (horiz ? away[0] : away[1]) > 0 ? 0.9 : 0.1, acr = 0.5 + side * 0.36 + (Math.random() - 0.5) * 0.05;
      gx = horiz ? W * lead : W * acr;
      gy = horiz ? H * acr : H * lead;
      R = Math.min(W, H) * 0.42;
    } else { gx = opt.x; gy = opt.y; R = Math.min(W, H) * 0.4; }
    var grab = [];
    for (k = 0; k < n; k++) {
      if (!inv[k]) continue;
      var ex = pos[k * 3] - gx, ey = pos[k * 3 + 1] - gy, dd = Math.sqrt(ex * ex + ey * ey);
      if (dd < R) grab.push({ k: k, w: 0.5 + 0.5 * Math.cos(Math.PI * dd / R), ox: ex, oy: ey });   // smooth falloff to the edge
    }
    var slant = -side * 0.5 + (Math.random() - 0.5) * 0.14;
    this.hand = {
      mode: auto ? 'auto' : 'pointer', grab: grab, x: gx, y: gy, z: 0, tx: gx, ty: gy, tz: 0,
      dir: norm3(away[0] + across[0] * slant, away[1] + across[1] * slant, 0.3), s: 0, v: 0, t0: 0, done: -1,
      peel: auto ? [-away[0] * aDim * 0.05 - across[0] * side * cDim * 0.04, -away[1] * aDim * 0.05 - across[1] * side * cDim * 0.04, Math.min(W, H) * 0.2] : null
    };
    this.free = auto; this.freeAt = 0; this.settled = false;
    this.solid = !!opt.solid;                     // indestructible: it stretches, never tears
    this.keep = opt.hand === 'still';             // a still cover stays until it's told to go
    /* stacking: a still cover lies under everything, a page being put back over everything, and
       between them newer torn sheets lie under older ones */
    this.rank = opt.hand === 'still' ? -1e9 : opt.hand === 'arrive' ? 1e9 : -(++sheetSeq);
    if (opt.hand === 'still' || opt.hand === 'arrive') {
      this.hand = null; this.free = false;
      for (k = 0; k < n; k++) inv[k] = 1;         // nothing pinned: it's lying on the pad, not bound to it
    }
    if (opt.hand === 'arrive') {
      /* a page put back on the pad: it drifts in from above, a little askew, and settles flat */
      this.arrive = true;
      var tw = (Math.random() - 0.5) * 0.1, cs = Math.cos(tw), sn = Math.sin(tw);
      for (k = 0; k < n; k++) {
        var px = pos[k * 3] - W / 2, py = pos[k * 3 + 1] - H / 2;
        pos[k * 3] = prev[k * 3] = W / 2 + px * cs - py * sn;
        pos[k * 3 + 1] = prev[k * 3 + 1] = H / 2 + px * sn + py * cs - H * 1.05;
        pos[k * 3 + 2] = prev[k * 3 + 2] = 140;
      }
    }

    /* distance of each perforation link from the grabbed side, for the running tear */
    var zipAt = this.zipAt = new Float32Array(m);
    for (q = 0; q < m; q++) if (this.tear[q]) {
      var f3 = (inv[A[q]] ? A[q] : B[q]) * 3, f = horiz ? pos[f3 + 1] : pos[f3];
      zipAt[q] = side < 0 ? f : cDim - f;
    }
    this.zip = -1;

    /* GPU side */
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.bPos = gl.createBuffer(); this.bNor = gl.createBuffer(); this.bUv = gl.createBuffer();
    this.bStrain = gl.createBuffer(); this.bIdx = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bUv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  }

  /* the hand follows the mouse (pointer mode) */
  Sheet.prototype.aim = function (x, y, z) {
    var h = this.hand;
    if (h && h.mode === 'pointer') { h.tx = x; h.ty = y; h.tz = z; }
  };
  /* pulled far enough: the perforation starts to go */
  Sheet.prototype.rip = function () {
    if (this.free || this.solid) return;
    this.free = true; this.freeAt = this.t; this.zip = 0;
  };
  /* let go before it tore: the hand eases back and the film settles flat on the pad */
  Sheet.prototype.letGo = function () {
    var h = this.hand;
    if (!h || h.mode !== 'pointer') return;
    h.mode = 'return'; h.rx = h.tx; h.ry = h.ty; h.rz = h.tz; h.k = 0;
  };
  /* let go of a torn sheet: it carries on with the mouse's speed until it's off the screen */
  Sheet.prototype.fling = function (vx, vy) {
    var h = this.hand;
    if (!h) return;
    var sp = Math.sqrt(vx * vx + vy * vy);
    h.dir = sp > 350 ? norm3(vx / sp, vy / sp, 0.25) : norm3(this.away[0], this.away[1], 0.25);
    h.mode = 'auto'; h.peel = null; h.x = h.tx; h.y = h.ty; h.z = h.tz;
    h.s = 0; h.v = Math.max(900, Math.min(sp, 3000)); h.t0 = this.t;
  };

  Sheet.prototype.step = function (dt) {
    var pos = this.pos, prev = this.prev, inv = this.inv, nor = this.nor, n = this.n, h = this.hand;
    this.t += dt;
    var g = this.free ? GRAVITY * clamp01((this.t - this.freeAt - 0.1) / 0.4) * dt * dt : 0;
    var an = Math.min(1, AIR_N * dt), at = Math.min(1, AIR_T * dt), home = this.home;
    /* a page being put back is drawn home by a spring that firms up as it arrives */
    var pull = this.arrive ? Math.pow(13 * clamp01(this.t / 0.3), 2) * dt * dt : 0, damp = this.arrive ? 0.91 : DAMP;
    for (var k = 0; k < n; k++) {
      if (!inv[k]) continue;
      var i3 = k * 3;
      var vx = pos[i3] - prev[i3], vy = pos[i3 + 1] - prev[i3 + 1], vz = pos[i3 + 2] - prev[i3 + 2];
      var vn = vx * nor[i3] + vy * nor[i3 + 1] + vz * nor[i3 + 2];
      vx -= nor[i3] * vn * an + vx * at; vy -= nor[i3 + 1] * vn * an + vy * at; vz -= nor[i3 + 2] * vn * an + vz * at;
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      vx *= damp; vy *= damp; vz *= damp;
      if (pull) { vx += (home[i3] - pos[i3]) * pull; vy += (home[i3 + 1] - pos[i3 + 1]) * pull; vz -= pos[i3 + 2] * pull; }
      pos[i3] += vx; pos[i3 + 1] += vy + g; pos[i3 + 2] += vz;
    }

    if (h && h.mode === 'auto') {
      /* peel the corner up, then yank: accelerates hard and holds a steady pull, letting go only
         once the torn sheet is being carried off the screen */
      var t = this.t - h.t0, lift = h.peel ? 1 - Math.pow(1 - clamp01(t / 0.3), 3) : 0;
      if (!h.peel || t > 0.16) { h.v = Math.min(1300, h.v + 4000 * dt); h.s += h.v * dt; }
      h.tx = h.x + (h.peel ? h.peel[0] * lift : 0) + h.dir[0] * h.s;
      h.ty = h.y + (h.peel ? h.peel[1] * lift : 0) + h.dir[1] * h.s;
      h.tz = h.z + (h.peel ? h.peel[2] * lift : 0) + h.dir[2] * h.s;
      if (this.broken === this.tearable && h.done < 0) h.done = this.t;
      if ((h.done >= 0 && this.clearing()) || t > 2.4) { this.hand = h = null; this.release(); }
    } else if (h && h.mode === 'return') {
      h.k = Math.min(1, h.k + dt / 0.16);
      var e = 1 - Math.pow(1 - h.k, 3);
      h.tx = h.rx + (h.x - h.rx) * e; h.ty = h.ry + (h.y - h.ry) * e; h.tz = h.rz * (1 - e);
      if (h.k >= 1) this.hand = h = null;
    }

    /* once the film gives, the tear runs along the perforation from the grabbed side: strands
       it reaches snap soon after, so the far end can't stay tethered while the sheet swings */
    if (this.free && this.zip < 0 && (this.broken || this.t - this.freeAt > 0.25)) this.zip = 0;
    if (this.zip >= 0) this.zip += 1600 * dt;
    var zip = this.zip, zipAt = this.zipAt, free = this.free;

    var ca = this.ca, cb = this.cb, rest = this.rest, rest0 = this.rest0, stiff = this.stiff, tearF = this.tear, alive = this.alive, m = this.m;
    var flow = FLOW / ITER;
    for (var it = 0; it < ITER; it++) {
      if (h) {
        var grab = h.grab, f = 0.34;
        for (var j = 0; j < grab.length; j++) {
          var gp = grab[j], p3 = gp.k * 3, w = gp.w * f;
          pos[p3] += (h.tx + gp.ox - pos[p3]) * w;
          pos[p3 + 1] += (h.ty + gp.oy - pos[p3 + 1]) * w;
          pos[p3 + 2] += (h.tz - pos[p3 + 2]) * w;
        }
      }
      for (var c = 0; c < m; c++) {
        if (!alive[c]) continue;
        var a = ca[c], b = cb[c], wa = inv[a], wb = inv[b], ws = wa + wb;
        if (!ws) continue;
        var a3 = a * 3, b3 = b * 3;
        var dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        if (free) {
          if (tearF[c]) {
            var run = zip >= 0 && zipAt[c] < zip;
            if (d > rest0[c] * (run ? SNAP_RUN : SNAP) || (run && zipAt[c] < zip - 450)) {
              alive[c] = 0; this.broken++; this.indexDirty = true; continue;
            }
          }
          /* plastic flow: stretched past yield, the film keeps some of the stretch */
          if (stiff[c] === 1 && d > rest[c] * YIELD) rest[c] += (d / YIELD - rest[c]) * flow;
        }
        var s = (d - rest[c]) / (d * ws) * stiff[c] * FILM;
        pos[a3] += dx * s * wa; pos[a3 + 1] += dy * s * wa; pos[a3 + 2] += dz * s * wa;
        pos[b3] -= dx * s * wb; pos[b3 + 1] -= dy * s * wb; pos[b3 + 2] -= dz * s * wb;
      }
    }
    /* the pad is solid: nothing goes behind the screen */
    for (k = 2; k < n * 3; k += 3) if (pos[k] < 0) pos[k] = 0;

    /* until it tears, the film lies on the pad: wherever it isn't lifted it stays put, and once
       the hand lets go it settles back flat (moved without adding speed, like friction) */
    if (this.arrive) {
      /* landed: snap the last fraction of a pixel so it lines up with the page exactly */
      var off = 0;
      for (k = 0; k < n * 3; k++) off = Math.max(off, Math.abs(home[k] - pos[k]));
      if (this.t > 0.35 && off < 0.4) { pos.set(home); prev.set(home); this.settled = true; }
    } else if (!free) {
      var hold = !!h, far = 0;
      for (k = 0; k < n; k++) {
        if (!inv[k]) continue;
        var q3 = k * 3, lift2 = hold ? clamp01(pos[q3 + 2] / 24) : 0, sp = 0.32 * (1 - lift2);
        var mx = (home[q3] - pos[q3]) * sp, my = (home[q3 + 1] - pos[q3 + 1]) * sp;
        pos[q3] += mx; prev[q3] += mx; pos[q3 + 1] += my; prev[q3 + 1] += my;
        if (!hold) {
          var mz = -pos[q3 + 2] * 0.3;
          pos[q3 + 2] += mz; prev[q3 + 2] += mz;
          far = Math.max(far, Math.abs(home[q3] - pos[q3]), Math.abs(home[q3 + 1] - pos[q3 + 1]), pos[q3 + 2]);
        }
      }
      if (!hold && far < 0.3) this.settled = true;
    }
    if (this.broken && !this.torn) this.torn = 1;
  };

  /* follow-through: the hand lets go once the sheet's trailing edge is past the middle of the
     screen in the direction it's going, fast enough that the throw carries it the rest of the way */
  Sheet.prototype.clearing = function () {
    var pos = this.pos, inv = this.inv, W = this.W, H = this.H, d = this.hand.dir;
    var lx = 1e9, hx = -1e9, ly = 1e9, hy = -1e9;
    for (var k = 0; k < this.n; k++) if (inv[k]) {
      var x = pos[k * 3], y = pos[k * 3 + 1];
      if (x < lx) lx = x; if (x > hx) hx = x; if (y < ly) ly = y; if (y > hy) hy = y;
    }
    if (Math.abs(d[1]) >= Math.abs(d[0])) return d[1] < 0 ? hy < H * 0.45 : ly > H * 0.55;
    return d[0] < 0 ? hx < W * 0.45 : lx > W * 0.55;
  };

  Sheet.prototype.release = function () { if (this.onRelease) { var f = this.onRelease; this.onRelease = null; f(); } };

  Sheet.prototype.normals = function () {
    var pos = this.pos, nor = this.nor, nx = this.nx, lines = this.lines;
    for (var L = 0; L < lines; L++) {
      for (var i = 0; i < nx; i++) {
        var k = L * nx + i;
        var l = (i > 0 ? k - 1 : k) * 3, r = (i < nx - 1 ? k + 1 : k) * 3, u = (L > 0 ? k - nx : k) * 3, d = (L < lines - 1 ? k + nx : k) * 3;
        var ax = pos[r] - pos[l], ay = pos[r + 1] - pos[l + 1], az = pos[r + 2] - pos[l + 2];
        var bx = pos[d] - pos[u], by = pos[d + 1] - pos[u + 1], bz = pos[d + 2] - pos[u + 2];
        var cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        var len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        nor[k * 3] = cx / len; nor[k * 3 + 1] = cy / len; nor[k * 3 + 2] = cz / len;
      }
    }
    /* strain per point: how far the film around it is stretched past its original length */
    var st = this.strain, ca = this.ca, cb = this.cb, rest0 = this.rest0, alive = this.alive, stiff = this.stiff;
    st.fill(0);
    for (var c = 0; c < this.m; c++) {
      if (!alive[c] || stiff[c] !== 1) continue;
      var a3 = ca[c] * 3, b3 = cb[c] * 3;
      var dx = pos[b3] - pos[a3], dy = pos[b3 + 1] - pos[a3 + 1], dz = pos[b3 + 2] - pos[a3 + 2];
      var e = Math.sqrt(dx * dx + dy * dy + dz * dz) / rest0[c] - 1;
      if (e > st[ca[c]]) st[ca[c]] = e;
      if (e > st[cb[c]]) st[cb[c]] = e;
    }
  };

  Sheet.prototype.indices = function () {
    if (!this.indexDirty) return;
    this.indexDirty = false;
    var alive = this.alive, tris = this.tris, drop = {};
    this.perf.forEach(function (p) {
      for (var i = 0; i < p.cons.length; i++) if (!alive[p.cons[i]]) { drop[p.at] = 1; return; }
    });
    var out = new Uint16Array(tris.length), o = 0;
    for (var t = 0; t < tris.length; t += 6) {
      if (drop[t]) continue;
      for (var j = 0; j < 6; j++) out[o++] = tris[t + j];
    }
    this.count = o;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, out.subarray(0, o), gl.DYNAMIC_DRAW);
  };

  /* done: settled back untorn, or thrown clear of the viewport */
  Sheet.prototype.gone = function () {
    if (this.keep) return false;
    if (this.settled) return true;
    if (!this.free || this.hand) return false;
    if (this.t - this.freeAt > 6) return true;
    var pos = this.pos, inv = this.inv, W = this.W, H = this.H, cx = W / 2, cy = H / 2;
    for (var k = 0; k < this.n; k++) {
      if (!inv[k]) continue;
      var z = Math.min(pos[k * 3 + 2], FOCAL * 0.7), sc = FOCAL / (FOCAL - z);
      var x = cx + (pos[k * 3] - cx) * sc, y = cy + (pos[k * 3 + 1] - cy) * sc;
      if (x > -60 && x < W + 60 && y > -60 && y < H + 60) return false;
    }
    return true;
  };

  Sheet.prototype.dispose = function () {
    gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.bPos); gl.deleteBuffer(this.bNor); gl.deleteBuffer(this.bUv);
    gl.deleteBuffer(this.bStrain); gl.deleteBuffer(this.bIdx);
  };

  /* ---------- frame ---------- */
  function draw() {
    var W = vw(), H = vh();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    /* newest sheet is the lowest in the pile: draw it first, older (falling) ones over it */
    var order = sheets.slice().sort(function (a, b) { return a.rank - b.rank; });
    for (var i = 0; i < order.length; i++) {
      var sh = order[i];
      sh.normals();
      sh.indices();
      gl.bindBuffer(gl.ARRAY_BUFFER, sh.bPos); gl.bufferData(gl.ARRAY_BUFFER, sh.pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, sh.bNor); gl.bufferData(gl.ARRAY_BUFFER, sh.nor, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, sh.bStrain); gl.bufferData(gl.ARRAY_BUFFER, sh.strain, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sh.bIdx);
      shadow(sh, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, layer.width, layer.height);
      gl.useProgram(P.p);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // thinned film lets the page through
      bindAttr(P.aPos, sh.bPos, 3); bindAttr(P.aNor, sh.bNor, 3); bindAttr(P.aUv, sh.bUv, 2); bindAttr(P.aStrain, sh.bStrain, 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sh.tex);
      gl.uniform1i(P.uTex, 0);
      gl.uniform2f(P.uView, W, H);
      gl.uniform1f(P.uF, FOCAL);
      gl.uniform1f(P.uBias, i * 0.002);   // drawn later = higher in the pile
      gl.uniform3f(P.uLight, LIGHT[0], LIGHT[1], LIGHT[2]);
      gl.drawElements(gl.TRIANGLES, sh.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
      unbindAttr(P.aNor); unbindAttr(P.aUv); unbindAttr(P.aStrain);
    }
  }

  function shadow(sh, W, H) {
    if (!sh.torn && !sh.hand && !sh.arrive) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.f);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(SP.p);
    bindAttr(SP.aPos, sh.bPos, 3);
    gl.uniform2f(SP.uView, W, H);
    gl.uniform2f(SP.uCast, -LIGHT[0] / LIGHT[2] * 0.55, -LIGHT[1] / LIGHT[2] * 0.55);
    gl.drawElements(gl.TRIANGLES, sh.count, gl.UNSIGNED_SHORT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.useProgram(CP.p);
    bindAttr(CP.aQ, quad, 2);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fbo.t);
    gl.uniform1i(CP.uS, 1);
    gl.uniform2f(CP.uPx, 1.5 / fbo.w, 1.5 / fbo.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    unbindAttr(CP.aQ);
  }

  function bindAttr(loc, buf, size) {
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  function unbindAttr(loc) { if (loc >= 0) gl.disableVertexAttribArray(loc); }

  var carry = 0;
  function advance(dt) {
    carry = Math.min(carry + dt, DT * 6);
    var steps = Math.floor(carry / DT);
    carry -= steps * DT;
    for (var i = 0; i < sheets.length; i++) for (var s = 0; s < steps; s++) sheets[i].step(DT);
    for (i = sheets.length - 1; i >= 0; i--) if (sheets[i].gone()) { sheets[i].release(); sheets[i].dispose(); sheets.splice(i, 1); }
    if (sheets.length) draw();
    else layer.style.display = 'none';
  }

  function frame(now) {
    raf = 0;
    var dt = Math.min(0.05, (now - lastT) / 1000 || 1 / 60);
    lastT = now;
    advance(dt);
    if (sheets.length) raf = requestAnimationFrame(frame);
  }
  function loop() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }

  function clearAll() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    sheets.forEach(function (s) { s.release(); if (gl && !glBroken) s.dispose(); });
    sheets = [];
    if (layer) layer.style.display = 'none';
    busy = false;
    root.classList.remove('is-tearing');
  }

  function off(e) {
    if (window.console) console.warn('[page tear] off:', e && e.message);
    busy = false;
    enabledFlag = false;                    // the snapshot failed once; don't keep trying
    mark();
  }

  /* lay a sheet over the screen, pixel for pixel, then move the page underneath to y */
  function layDown(img, pin, opt, y, onRelease) {
    sizeLayer();
    var sheet = new Sheet(img, pin, opt);
    sheet.onRelease = onRelease;
    sheets.push(sheet);
    layer.style.display = 'block';
    draw();
    return new Promise(function (done) {
      requestAnimationFrame(function () { if (y != null) jump(y); loop(); done(sheet); });
    });
  }

  /* ---------- the automatic tear: links, cue, back-to-top, wheel and keys ---------- */
  function fallback(y) { window.scrollTo({ top: y, behavior: calm.matches ? 'auto' : 'smooth' }); }

  function tearTo(y, dir, grabX) {
    y = Math.max(0, Math.min(y, root.scrollHeight - vh()));
    if (Math.abs(y - scrollY()) < 2) return Promise.resolve();
    if (busy) { queued = { y: y, dir: dir, x: grabX }; hurry(); return Promise.resolve(); }
    if (!ensureGL()) { fallback(y); return Promise.resolve(); }
    if (here() === last && y < scrollY()) return putBack(y);
    busy = true;
    return capture().then(function (img) {
      return layDown(img, dir > 0 ? 'bottom' : 'top', { hand: 'auto', x: grabX == null ? 0 : grabX, y: vh() / 2 }, y, function () {
        busy = false;
        warm();
        runQueued();
      });
    }).catch(function (e) { off(e); fallback(y); });
  }

  /* navigation asked for while a page you let go of is still springing back (a stretch of the
     last page, or a pull that didn't tear): skip the rest of the spring, so the navigation runs now */
  function hurry() {
    sheets.forEach(function (sh) {
      if (sh.free || sh.keep || sh.arrive || (sh.hand && sh.hand.mode === 'pointer')) return;
      sh.hand = null;
      sh.pos.set(sh.home); sh.prev.set(sh.home);
      sh.settled = true;
    });
    if (sheets.length && !raf) loop();
  }
  function runQueued() { if (queued) { var q = queued; queued = null; tearTo(q.y, q.dir, q.x); } }

  /* the last page can't be torn: going back from it, the page you're going to is put back on the
     pad instead. The current page is held as a still picture, the page underneath moves to y and
     is photographed, and that picture drifts in from above and settles over it */
  function putBack(y) {
    busy = true;
    var cover = null;
    return capture().then(function (img) {
      sizeLayer();
      cover = new Sheet(img, 'top', { hand: 'still' });
      sheets.push(cover);
      layer.style.display = 'block';
      draw();
      return new Promise(function (done) { requestAnimationFrame(function () { jump(y); done(); }); });
    }).then(function () { return capture(); }).then(function (img) {
      var sheet = new Sheet(img, 'top', { hand: 'arrive' });
      sheet.onRelease = function () {
        cover.keep = false;
        busy = false;
        warm();
        runQueued();
      };
      sheets.push(sheet);
      loop();
    }).catch(function (e) {
      if (cover) cover.keep = false;
      off(e); fallback(y);
    });
  }

  function go(i, grabX) {
    var cur = scrollY(), target = bounds(i).top;
    return tearTo(target, target > cur ? 1 : -1, grabX);
  }

  /* in-page links to a page */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !enabled()) return;
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1), i = -1;
    for (var j = 0; j < pages.length; j++) if (pages[j].id === id) i = j;
    if (i < 0) return;
    e.preventDefault();
    if (history.pushState && location.hash !== '#' + id) history.pushState(null, '', '#' + id);
    go(i, e.clientX);
  });

  /* ---------- where the page rests ---------- */
  /* The page never scrolls by itself; it only rests at stops. Every page's top is one, and a page
     taller than the screen (on a short screen) has more, a screen at a time down to its end.
     Going on to the next stop is always a tear; going back to the previous one is a page turn. */
  function stops() {
    var H = vh(), max = Math.max(0, root.scrollHeight - H), out = [];
    pages.forEach(function (p, i) {
      var b = bounds(i), top = Math.min(max, b.top), end = Math.min(max, b.bottom - H);
      out.push(top);
      if (end > top + H * 0.15) {           // a sliver that's mostly padding isn't worth a stop of its own
        var n = Math.max(1, Math.ceil((end - top) / H));
        for (var k = 1; k <= n; k++) out.push(top + (end - top) * k / n);
      }
    });
    return out.map(Math.round).sort(function (a, b) { return a - b; }).filter(function (v, k, a) { return !k || v - a[k - 1] > 2; });
  }
  function nextStop() { var y = scrollY(), s = stops(); for (var k = 0; k < s.length; k++) if (s[k] > y + 2) return s[k]; return null; }
  function prevStop() { var y = scrollY(), s = stops(); for (var k = s.length - 1; k >= 0; k--) if (s[k] < y - 2) return s[k]; return null; }
  function tearOn(x) { var n = nextStop(); if (n != null) tearTo(n, 1, x); }
  function turnBack() { var p = prevStop(); if (p != null) window.scrollTo({ top: p, behavior: calm.matches ? 'auto' : 'smooth' }); }

  /* wheel: each gesture is one move, on (a tear) or back (a turn); a box on the page that scrolls
     by itself (a long role's card) scrolls first, and that gesture is then spent */
  var gesture = 0, lastWheel = 0, lastAbs = 0, doneIn = -1, boxIn = -1, handledAt = 0;
  function scrollsInside(el, dy) {
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      var oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
    return false;
  }
  window.addEventListener('wheel', function (e) {
    if (!enabled() || e.ctrlKey || e.defaultPrevented) return;
    /* gestures are timed by when the input happened, not when it's handled: while a page is being
       photographed the browser holds wheel events back, and a held-back momentum tail must not
       look like a fresh swipe (that tore twice and skipped a page) */
    var now = e.timeStamp || performance.now();
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh() : 1), ad = Math.abs(dy);
    /* a gap that only exists because a snapshot held the page up isn't a pause in the swipe: the
       held-back events are handled in a burst the moment the snapshot finishes */
    var stalled = shotDoneAt > handledAt && performance.now() - shotDoneAt < 50;
    handledAt = performance.now();
    /* a new gesture: a pause in the stream, or a new swipe starting while the last one's momentum
       is still dying away (momentum only ever shrinks) */
    if ((now - lastWheel > 220 && !stalled) || (doneIn === gesture && !busy && ad > 12 && ad > lastAbs * 2.2)) { gesture++; lastAbs = 0; }
    lastWheel = now;
    lastAbs = ad;
    if (!dy || Math.abs(e.deltaX) > Math.abs(dy)) return;
    if (boxIn !== gesture && doneIn !== gesture && scrollsInside(e.target, dy)) { boxIn = gesture; return; }
    e.preventDefault();
    if (busy || doneIn === gesture || boxIn === gesture) return;   // one move per gesture, momentum tail included
    doneIn = gesture;
    if (dy > 0) tearOn(e.clientX); else turnBack();
  }, { passive: false });

  /* keys: Down, Page Down and Space tear on; Up, Page Up and Shift+Space turn back; Home and End go
     to the ends */
  window.addEventListener('keydown', function (e) {
    if (!enabled() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var el = document.activeElement;
    if (el && el !== document.body && el !== root && el.tagName !== 'A') return;
    var k = e.key;
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      if (!busy) go(k === 'Home' ? 0 : pages.length - 1, vw() / 2);
      return;
    }
    var on = k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey);
    var back = k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey);
    if (!on && !back) return;
    e.preventDefault();
    if (busy || e.repeat) return;
    if (on) tearOn(vw() / 2); else turnBack();
  });

  /* ---------- tearing by hand ---------- */
  /* Press on the page (not on something clickable) and drag it any way you like: it rips, on to the
     next stop. Page text isn't selectable while tearing is on, so a drag always means the paper;
     hold Cmd (Ctrl on Windows/Linux) to select text. A touch just does what a touch does. */
  var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  var SEL_KEY = mac ? '\u2318' : 'Ctrl';
  var selHint = hero.querySelector('.sel-key');
  if (selHint) selHint.textContent = SEL_KEY;
  var NOGRAB = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="tab"], [role="slider"], [tabindex], iframe, video';
  var hold = null;

  document.addEventListener('pointerdown', function (e) {
    if (!enabled() || busy || e.button !== 0 || e.metaKey || e.ctrlKey || !e.isPrimary) return;
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    if (!(hero.contains(e.target) || main.contains(e.target)) || (e.target.closest && e.target.closest(NOGRAB))) return;
    selectable(false);                    // a plain press is for tearing: drop any earlier selection
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, dir: 0, trail: [[e.clientX, e.clientY, e.timeStamp]] };
    /* start the picture now: it's usually ready by the time the drag declares itself */
    if (!fresh() && ensureGL()) capture().catch(function () {});
  });

  window.addEventListener('pointermove', function (e) {
    var g = hold;
    if (!g || e.pointerId !== g.id) return;
    g.cx = e.clientX; g.cy = e.clientY;
    g.trail.push([e.clientX, e.clientY, e.timeStamp]);
    if (g.trail.length > 8) g.trail.shift();
    var dx = g.cx - g.x, dy = g.cy - g.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (!g.dir) {
      /* the sheet is held along the side away from your pull, so it leaves the way you rip it */
      if (ax < 8 && ay < 8) return;
      start(g, ay >= ax ? (dy < 0 ? 'bottom' : 'top') : (dx < 0 ? 'right' : 'left'));
      if (!g.dir) return;
    }
    aimAt(g);
  });

  /* every rip goes on to the next stop, whichever way you pull; going back is a page turn or the
     navigation. At the last stop the page is indestructible: it stretches, springs back, never tears */
  function start(g, pin) { begin(g, pin, nextStop()); }

  function begin(g, pin, target) {
    g.dir = pin;
    g.solid = target == null;
    g.origin = scrollY();
    g.target = target;
    busy = true;
    root.classList.add('is-tearing');
    /* nothing to reveal: lifting the film shows the bare pad, not a second copy of the page */
    if (g.solid) root.classList.add('tear-solo');
    if (window.getSelection) window.getSelection().removeAllRanges();
    if (!ensureGL()) { busy = false; root.classList.remove('is-tearing', 'tear-solo'); hold = null; return; }
    capture().then(function (img) {
      /* let go before the picture was ready: a real flick still tears (the sheet finishes the rip
         by itself); a nudge doesn't */
      var auto = !!g.up;
      if (auto && (g.solid || !flicked(g, pin))) {
        busy = false; root.classList.remove('is-tearing', 'tear-solo');
        runQueued();
        return;
      }
      return layDown(img, pin, { hand: auto ? 'auto' : 'pointer', x: g.x, y: g.y, solid: g.solid }, g.target, function () {
        if (g.sheet && !g.sheet.free) jump(g.origin);   // it settled back untorn: put the page back where it was
        busy = false;
        root.classList.remove('is-tearing', 'tear-solo');
        warm();
        runQueued();
      }).then(function (sheet) {
        g.sheet = sheet;
        if (!auto) { if (g.up) finish(g); else aimAt(g); }
      });
    }).catch(function (e) { off(e); root.classList.remove('is-tearing', 'tear-solo'); hold = null; });
  }

  /* far enough, or fast enough, away from the perforation to count as a rip */
  function flicked(g, pin) {
    var a = awayFrom(pin), tr = g.trail, last = tr[tr.length - 1], first = tr[0];
    for (var i = tr.length - 1; i >= 0; i--) { first = tr[i]; if (last[2] - tr[i][2] > 80) break; }
    var dt = Math.max(1, last[2] - first[2]) / 1000;
    var speed = ((last[0] - first[0]) * a[0] + (last[1] - first[1]) * a[1]) / dt;
    var dist = (g.cx - g.x) * a[0] + (g.cy - g.y) * a[1];
    return dist > (a[1] === 0 ? vw() * 0.18 : vh() * 0.1) || speed > 450;
  }

  function aimAt(g) {
    var sh = g.sheet;
    if (!sh || !sh.hand) return;
    var dx = g.cx - g.x, dy = g.cy - g.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (!sh.free) {
      /* the film resists: it follows less the further you pull, and lifts toward you. It gives
         once you've pulled far enough away from the perforation */
      var small = Math.min(sh.W, sh.H), k = 1 / (1 + dist / (260 * Math.min(1, small / 800)));
      var away = dx * sh.away[0] + dy * sh.away[1];
      var need = sh.away[1] === 0 ? Math.max(80, sh.W * 0.22) : Math.max(80, sh.H * PULL);
      if (away > need) sh.rip();
      sh.aim(g.x + dx * k, g.y + dy * k, 24 + Math.min(dist * 0.55, small * 0.24));
    } else sh.aim(g.cx, g.cy, Math.min(150, Math.min(sh.W, sh.H) * 0.19));
  }

  function finish(g) {
    var sh = g.sheet;
    if (!sh) return;
    if (!sh.free) { sh.letGo(); return; }
    /* throw speed from the last ~60ms of the drag */
    var tr = g.trail, last = tr[tr.length - 1], first = tr[0];
    for (var i = tr.length - 1; i >= 0; i--) { first = tr[i]; if (last[2] - tr[i][2] > 60) break; }
    var dt = Math.max(1, last[2] - first[2]) / 1000;
    sh.fling((last[0] - first[0]) / dt, (last[1] - first[1]) / dt);
  }

  function drop(e) {
    var g = hold;
    if (!g || (e && e.pointerId != null && e.pointerId !== g.id)) return;
    hold = null;
    if (!g.dir) return;                   // it was a click, not a tear
    g.up = true;
    finish(g);
  }
  window.addEventListener('pointerup', drop);
  window.addEventListener('pointercancel', drop);
  window.addEventListener('blur', function () { drop(); });
  /* no ghost images or text selection while a page is in your hand */
  document.addEventListener('dragstart', function (e) { if (hold) e.preventDefault(); });
  document.addEventListener('selectstart', function (e) { if (hold) e.preventDefault(); });

  /* Cmd/Ctrl held: the page is selectable text again (and won't tear). What you select stays
     selected after you let go, so it can be copied, until the selection is cleared. */
  var modDown = false;
  function isMod(e) { return e.key === 'Meta' || e.key === 'Control'; }
  function selectable(on) { root.classList.toggle('select-text', on && enabled()); }
  function selectionEmpty() { var sel = window.getSelection && window.getSelection(); return !sel || sel.isCollapsed; }
  window.addEventListener('keydown', function (e) { if (isMod(e)) { modDown = true; selectable(true); } });
  window.addEventListener('keyup', function (e) { if (isMod(e)) { modDown = false; if (selectionEmpty()) selectable(false); } });
  window.addEventListener('blur', function () { modDown = false; if (selectionEmpty()) selectable(false); });
  document.addEventListener('selectionchange', function () { if (!modDown && selectionEmpty()) selectable(false); });

  /* photograph ahead of time: whenever the page comes to rest, and when reaching for the nav */
  var settle = 0;
  window.addEventListener('scroll', function () {
    clearTimeout(settle);
    settle = setTimeout(warm, 180);
  }, { passive: true });
  ['sideNav', 'toTop'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('pointerenter', warm);
  });
  if (cue) cue.addEventListener('pointerenter', warm);

  /* fetch the snapshot library once the page is idle, so the first tear doesn't wait on it */
  window.addEventListener('load', function () {
    if (!enabled()) return;
    var get = function () { if (!lib) lib = import(LIB); lib.catch(function () {}); warm(); };
    if (window.requestIdleCallback) window.requestIdleCallback(get, { timeout: 4000 }); else setTimeout(get, 2000);
  });

  /* only a change of width ends a tear in progress */
  var lastW = vw();
  window.addEventListener('resize', function () { if (vw() !== lastW) { lastW = vw(); if (sheets.length) clearAll(); } });
  document.addEventListener('visibilitychange', function () { if (document.hidden && sheets.length) clearAll(); });

  window.pageTear = {
    /* returns true when it took over the scroll to y */
    to: function (y) {
      if (!enabled()) return false;
      tearTo(y, y > scrollY() ? 1 : -1, vw());
      return true;
    }
  };
})();
