/* Tearable pages: each section is a sheet of plastic film you rip off to reach the next one.

   Grab the page and pull. Up tears it off toward the next section, down goes back one. The film
   lifts toward you and gives a little; pull far enough and the edge holding it stretches into
   strands and snaps. While you hold it, it hangs from your hand; let go and it's thrown off with
   your mouse's speed. Nav links, the "Tear" cue, back-to-top, and wheeling or paging past a
   section's edge rip it for you. The page you're going to is already underneath.

   The screen is photographed (modern-screenshot, loaded on first use) and laid on a Verlet sheet
   drawn with WebGL, pinned along a perforation just off-screen. Past a small strain the film
   flows (stretches for good), goes milky and thins out, the way plastic does. Desktop layout
   only; phones, reduced motion, no WebGL or any failure fall back to plain scrolling. */
(function () {
  'use strict';

  var LIB = 'https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/dist/index.mjs';
  var wide = window.matchMedia('(min-width: 960px)');
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  var root = document.documentElement;
  var hero = document.getElementById('home');
  var main = document.querySelector('main.orig');
  if (!hero || !main || !window.WebGLRenderingContext || !window.Promise) return;
  var pages = [hero].concat(Array.prototype.filter.call(main.children, function (n) { return n.classList.contains('o-section'); }));

  /* ---------- physics constants (CSS px, seconds) ---------- */
  var COLS = 44;             // sheet resolution across; rows follow the screen's aspect
  var DT = 1 / 120;          // fixed sub-step
  var ITER = 10;             // constraint passes per sub-step
  var BEND = 0.22;           // skip-one links that resist folding: film is floppy
  var YIELD = 1.06;          // past 6% strain the film flows: it stays stretched
  var FLOW = 0.25;           // how quickly it flows once past yield
  var SNAP = 2.4;            // a perforation strand snaps at this stretch of its original length...
  var SNAP_RUN = 1.45;       // ...or much sooner once the running tear has reached it
  var GRAVITY = 2400;        // px/s^2, from the moment the sheet comes free
  var AIR_N = 6.5;           // drag across the sheet's face (1/s): it glides and flutters
  var AIR_T = 0.35;          // drag along the face
  var FOCAL = 1700;          // camera distance; z toward the viewer grows the sheet
  var PULL = 0.14;           // share of the screen height you pull before the film gives
  var LIGHT = norm3(-0.38, -0.52, 0.76);   // from the top left, in front of the screen

  var enabledFlag = true, busy = false, queued = null;
  var sheets = [], raf = 0, lastT = 0;

  function enabled() { return enabledFlag && wide.matches && !calm.matches; }
  function norm3(x, y, z) { var l = Math.sqrt(x * x + y * y + z * z); return [x / l, y / l, z / l]; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function vh() { return window.innerHeight; }
  function scrollY() { return window.pageYOffset || root.scrollTop; }
  function bounds(i) {
    var r = pages[i].getBoundingClientRect(), y = scrollY();
    return { top: r.top + y, bottom: r.bottom + y };
  }
  function pageAt(y) {
    for (var i = pages.length - 1; i >= 0; i--) if (bounds(i).top <= y + 1) return i;
    return 0;
  }
  /* the last page (Contact) is the back of the pad: it can't be torn, so leaving it just scrolls */
  var last = pages.length - 1;
  function onLast() { return pageAt(scrollY()) === last; }
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
  [wide, calm].forEach(function (q) { if (q.addEventListener) q.addEventListener('change', mark); else if (q.addListener) q.addListener(mark); });

  /* ---------- screen snapshot ---------- */
  var lib = null, shot = null, pending = null, dirty = 0, mutatedAt = 0, heroOn = true, warmT = 0, wanted = false;
  function changed() { dirty++; mutatedAt = performance.now(); if (wanted) schedule(); }
  var watch = { subtree: true, childList: true, attributes: true, characterData: true };
  new MutationObserver(changed).observe(main, watch);
  /* the hero's headline types forever; it only matters while the hero is in the picture */
  new MutationObserver(function () { if (heroOn) changed(); }).observe(hero, watch);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { heroOn = es[0].isIntersecting; }).observe(hero);

  function scale() { return Math.min(window.devicePixelRatio || 1, 2); }
  function shotKey() { return [Math.round(scrollY()), window.innerWidth, vh(), scale(), dirty].join(); }
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
      return canvas;
    }, function (err) { if (pending === job) pending = null; throw err; });
    pending = job;
    return job.promise;
  }

  function paint(ms) {
    var s = scale(), w = window.innerWidth, h = vh();
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
    '  float lit = clamp(1.0 + 0.8 * (dot(n, uLight) - uLight.z), 0.5, 1.15);',
    '  vec3 t = texture2D(uTex, clamp(vUv, 0.0, 1.0)).rgb;',
    /* film: from behind you see the print reversed through a pale layer */
    '  vec3 col = gl_FrontFacing ? t : mix(vec3(0.9, 0.92, 0.95), t, 0.42);',
    /* stretched plastic goes milky and thins until the page below shows through */
    '  col = mix(col, vec3(0.93, 0.95, 0.98), 0.6 * smoothstep(0.1, 0.7, vS));',
    '  float a = 1.0 - 0.6 * smoothstep(0.45, 1.5, vS);',
    /* gloss: a highlight wherever the film bends toward the light (none while it lies flat) */
    '  vec3 h = normalize(uLight + vec3(0.0, 0.0, 1.0));',
    '  float sp = max(pow(max(dot(n, h), 0.0), 60.0) - pow(h.z, 60.0), 0.0);',
    '  col = col * lit + vec3(0.45 * sp);',
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
      layer.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:30;pointer-events:none;display:none';
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
    var s = scale(), w = Math.round(window.innerWidth * s), h = Math.round(vh() * s);
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
  /* dir 1: the perforation is along the bottom and the sheet leaves upward (on to the next page);
     dir -1: along the top, and it leaves downward (back a page).
     opt.hand 'auto' rips it by itself from a corner near opt.x; 'pointer' follows the mouse from
     (opt.x, opt.y) and only comes free when rip() is called. */
  function Sheet(img, dir, opt) {
    var W = window.innerWidth, H = vh();
    var cols = COLS, rows = Math.max(10, Math.round(COLS * H / W));
    var nx = cols + 1, lines = rows + 2, n = nx * lines, cw = W / cols, ch = H / rows;
    var pin = dir > 0 ? lines - 1 : 0;           // the off-screen perforation line
    this.W = W; this.H = H; this.dir = dir; this.nx = nx; this.lines = lines; this.n = n; this.t = 0;
    var pos = this.pos = new Float32Array(n * 3), prev = this.prev = new Float32Array(n * 3);
    var inv = this.inv = new Float32Array(n), uv = new Float32Array(n * 2);
    this.nor = new Float32Array(n * 3);
    this.strain = new Float32Array(n);
    for (var L = 0; L < lines; L++) {
      var y = (dir > 0 ? L : L - 1) * ch;
      for (var i = 0; i < nx; i++) {
        var k = L * nx + i;
        pos[k * 3] = prev[k * 3] = i * cw; pos[k * 3 + 1] = prev[k * 3 + 1] = y;
        uv[k * 2] = i / cols; uv[k * 2 + 1] = y / H;
        inv[k] = L === pin ? 0 : 1;
        this.nor[k * 3 + 2] = 1;
      }
    }
    this.home = new Float32Array(pos);            // where each point lies on the pad

    var A = [], B = [], S = [], T = [], vert = [];
    function link(a, b, s, t) { A.push(a); B.push(b); S.push(s); T.push(t ? 1 : 0); return A.length - 1; }
    function perfCell(L) { return dir > 0 ? L === lines - 2 : L === 0; }
    function touchesPin(a, b) { return Math.floor(a / nx) === pin || Math.floor(b / nx) === pin; }
    for (L = 0; L < lines; L++) {
      for (i = 0; i < nx; i++) {
        k = L * nx + i;
        if (i < cols && L !== pin) link(k, k + 1, 1, false);
        if (L < lines - 1) vert[k] = link(k, k + nx, 1, perfCell(L));
        if (i < cols - 1 && L !== pin) link(k, k + 2, BEND, false);
        if (L < lines - 2 && !touchesPin(k, k + 2 * nx)) link(k, k + 2 * nx, BEND, false);
      }
    }
    var tris = [], perf = [];
    for (L = 0; L < lines - 1; L++) {
      for (i = 0; i < cols; i++) {
        var a = L * nx + i, b = a + 1, c = a + nx, d = c + 1;
        var s1 = link(b, c, 1, perfCell(L)), s2 = link(a, d, 1, perfCell(L));
        if (perfCell(L)) perf.push({ at: tris.length, cons: [vert[a], vert[b], s1, s2] });
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
    var side = opt.x < W / 2 ? -1 : 1, gx, gy, R;
    if (auto) {
      /* near a corner opposite the perforation: it peels the corner up toward you, then rips
         diagonally across so the sheet turns as it goes (a straight pull reads as a scroll) */
      gx = W * (0.5 + side * 0.36) + (Math.random() - 0.5) * W * 0.05;
      gy = dir > 0 ? H * 0.1 : H * 0.9;
      R = Math.min(W, H) * 0.3;
    } else { gx = opt.x; gy = opt.y; R = Math.min(W, H) * 0.24; }
    var grab = [];
    for (k = 0; k < n; k++) {
      if (!inv[k]) continue;
      var ex = pos[k * 3] - gx, ey = pos[k * 3 + 1] - gy, dd = Math.sqrt(ex * ex + ey * ey);
      if (dd < R) { var wgt = 1 - dd / R; grab.push({ k: k, w: wgt * wgt, ox: ex, oy: ey }); }
    }
    var tilt = (Math.random() - 0.5) * 0.14;
    this.hand = {
      mode: auto ? 'auto' : 'pointer', grab: grab, x: gx, y: gy, z: 0, tx: gx, ty: gy, tz: 0,
      dir: norm3(-side * 0.5 + tilt, dir > 0 ? -1 : 1, 0.3), s: 0, v: 0, t0: 0, done: -1,
      peel: auto ? [-side * W * 0.04, dir * H * 0.05, Math.min(W, H) * 0.2] : null
    };
    this.free = auto; this.freeAt = 0; this.settled = false;

    /* distance of each perforation link from the grabbed side, for the running tear */
    var zipAt = this.zipAt = new Float32Array(m);
    for (q = 0; q < m; q++) if (this.tear[q]) {
      var fx = inv[A[q]] ? pos[A[q] * 3] : pos[B[q] * 3];
      zipAt[q] = side < 0 ? fx : W - fx;
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
    if (this.free) return;
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
    h.dir = sp > 350 ? norm3(vx / sp, vy / sp, 0.25) : norm3(0, -this.dir, 0.25);
    h.mode = 'auto'; h.peel = null; h.x = h.tx; h.y = h.ty; h.z = h.tz;
    h.s = 0; h.v = Math.max(1500, Math.min(sp, 4200)); h.t0 = this.t;
  };

  Sheet.prototype.step = function (dt) {
    var pos = this.pos, prev = this.prev, inv = this.inv, nor = this.nor, n = this.n, h = this.hand;
    this.t += dt;
    var g = this.free ? GRAVITY * clamp01((this.t - this.freeAt - 0.05) / 0.2) * dt * dt : 0;
    var an = Math.min(1, AIR_N * dt), at = Math.min(1, AIR_T * dt);
    for (var k = 0; k < n; k++) {
      if (!inv[k]) continue;
      var i3 = k * 3;
      var vx = pos[i3] - prev[i3], vy = pos[i3 + 1] - prev[i3 + 1], vz = pos[i3 + 2] - prev[i3 + 2];
      var vn = vx * nor[i3] + vy * nor[i3 + 1] + vz * nor[i3 + 2];
      vx -= nor[i3] * vn * an + vx * at; vy -= nor[i3 + 1] * vn * an + vy * at; vz -= nor[i3 + 2] * vn * an + vz * at;
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      pos[i3] += vx; pos[i3 + 1] += vy + g; pos[i3 + 2] += vz;
    }

    if (h && h.mode === 'auto') {
      /* peel the corner up, then yank: accelerates hard and holds a steady pull, letting go only
         once the torn sheet is being carried off the screen */
      var t = this.t - h.t0, lift = h.peel ? 1 - Math.pow(1 - clamp01(t / 0.13), 3) : 0;
      if (!h.peel || t > 0.07) { h.v = Math.min(3400, h.v + 15000 * dt); h.s += h.v * dt; }
      h.tx = h.x + (h.peel ? h.peel[0] * lift : 0) + h.dir[0] * h.s;
      h.ty = h.y + (h.peel ? h.peel[1] * lift : 0) + h.dir[1] * h.s;
      h.tz = h.z + (h.peel ? h.peel[2] * lift : 0) + h.dir[2] * h.s;
      if (this.broken === this.tearable && h.done < 0) h.done = this.t;
      if ((h.done >= 0 && this.clearing()) || t > 1.1) { this.hand = h = null; this.release(); }
    } else if (h && h.mode === 'return') {
      h.k = Math.min(1, h.k + dt / 0.16);
      var e = 1 - Math.pow(1 - h.k, 3);
      h.tx = h.rx + (h.x - h.rx) * e; h.ty = h.ry + (h.y - h.ry) * e; h.tz = h.rz * (1 - e);
      if (h.k >= 1) this.hand = h = null;
    }

    /* once the film gives, the tear runs along the perforation from the grabbed side: strands
       it reaches snap soon after, so the far end can't stay tethered while the sheet swings */
    if (this.free && this.zip < 0 && (this.broken || this.t - this.freeAt > 0.12)) this.zip = 0;
    if (this.zip >= 0) this.zip += 5000 * dt;
    var zip = this.zip, zipAt = this.zipAt, free = this.free;

    var ca = this.ca, cb = this.cb, rest = this.rest, rest0 = this.rest0, stiff = this.stiff, tearF = this.tear, alive = this.alive, m = this.m;
    var flow = FLOW / ITER;
    for (var it = 0; it < ITER; it++) {
      if (h) {
        var grab = h.grab, f = 0.28;
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
            if (d > rest0[c] * (run ? SNAP_RUN : SNAP) || (run && zipAt[c] < zip - 700)) {
              alive[c] = 0; this.broken++; this.indexDirty = true; continue;
            }
          }
          /* plastic flow: stretched past yield, the film keeps some of the stretch */
          if (stiff[c] === 1 && d > rest[c] * YIELD) rest[c] += (d / YIELD - rest[c]) * flow;
        }
        var s = (d - rest[c]) / (d * ws) * stiff[c];
        pos[a3] += dx * s * wa; pos[a3 + 1] += dy * s * wa; pos[a3 + 2] += dz * s * wa;
        pos[b3] -= dx * s * wb; pos[b3 + 1] -= dy * s * wb; pos[b3 + 2] -= dz * s * wb;
      }
    }
    /* the pad is solid: nothing goes behind the screen */
    for (k = 2; k < n * 3; k += 3) if (pos[k] < 0) pos[k] = 0;

    /* until it tears, the film lies on the pad: wherever it isn't lifted it stays put, and once
       the hand lets go it settles back flat (moved without adding speed, like friction) */
    if (!free) {
      var home = this.home, hold = !!h, far = 0;
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
      if (!alive[p.cons[0]] || !alive[p.cons[1]] || !alive[p.cons[2]] || !alive[p.cons[3]]) drop[p.at] = 1;
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
    if (this.settled) return true;
    if (!this.free || this.hand) return false;
    if (this.t - this.freeAt > 3.5) return true;
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
    var W = window.innerWidth, H = vh();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    /* newest sheet is the lowest in the pile: draw it first, older (falling) ones over it */
    for (var i = sheets.length - 1; i >= 0; i--) {
      var sh = sheets[i];
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
      gl.uniform1f(P.uBias, (sheets.length - 1 - i) * 0.002);   // older sheets sit higher in the pile
      gl.uniform3f(P.uLight, LIGHT[0], LIGHT[1], LIGHT[2]);
      gl.drawElements(gl.TRIANGLES, sh.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
      unbindAttr(P.aNor); unbindAttr(P.aUv); unbindAttr(P.aStrain);
    }
  }

  function shadow(sh, W, H) {
    if (!sh.torn && !sh.hand) return;
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

  function advance(dt) {
    var steps = Math.max(1, Math.min(4, Math.round(dt / DT)));
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
  function layDown(img, dir, opt, y, onRelease) {
    sizeLayer();
    var sheet = new Sheet(img, dir, opt);
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
    if (onLast()) { fallback(y); return Promise.resolve(); }
    if (busy) { queued = { y: y, dir: dir, x: grabX }; return Promise.resolve(); }
    if (!ensureGL()) { fallback(y); return Promise.resolve(); }
    busy = true;
    return capture().then(function (img) {
      return layDown(img, dir, { hand: 'auto', x: grabX == null ? 0 : grabX }, y, function () {
        busy = false;
        warm();
        if (queued) { var q = queued; queued = null; tearTo(q.y, q.dir, q.x); }
      });
    }).catch(function (e) { off(e); fallback(y); });
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

  /* wheel: native inside a page; at a page's edge, one deliberate gesture tears to the next */
  var gesture = 0, lastWheel = 0, lastAbs = 0, tornIn = -1, arrivedIn = -1, push = 0;
  function scrollsInside(el, dy) {
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      var oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
    return false;
  }
  function edgeMove(dy, x, e, deliberate, smooth) {
    var y = scrollY(), dir = dy > 0 ? 1 : -1, i = pageAt(y), next = i + dir;
    if (next < 0 || next >= pages.length || i === last) return 'native';
    var b = bounds(i), edge = dir > 0 ? b.bottom - vh() : b.top;
    var atEdge = dir > 0 ? y >= edge - 1 : y <= edge + 1;
    if (!atEdge) {
      if (dir > 0 ? y + dy > edge : y + dy < edge) {
        e.preventDefault();
        if (smooth) window.scrollTo({ top: edge, behavior: 'smooth' }); else jump(edge);
        return 'arrived';
      }
      return 'native';
    }
    e.preventDefault();
    if (!deliberate()) return 'held';
    var nb = bounds(next);
    tearTo(dir > 0 ? nb.top : nb.bottom - vh(), dir, x);
    return 'tore';
  }
  window.addEventListener('wheel', function (e) {
    if (!enabled() || e.ctrlKey || e.defaultPrevented) return;
    var now = performance.now();
    if (now - lastWheel > 220) { gesture++; push = 0; lastAbs = 0; }
    lastWheel = now;
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh() : 1);
    /* trackpad momentum arrives as steadily shrinking deltas; only a held or growing push counts */
    var active = Math.abs(dy) >= lastAbs * 0.9;
    lastAbs = Math.abs(dy);
    if (!dy || Math.abs(e.deltaX) > Math.abs(dy)) return;
    /* a gesture that already tore is spent, momentum tail included */
    if (busy || tornIn === gesture) { e.preventDefault(); return; }
    if (scrollsInside(e.target, dy)) return;
    var r = edgeMove(dy, e.clientX, e, function () {
      /* if this gesture only just reached the edge, it has to keep pushing */
      if (active) push += Math.abs(dy);
      if (arrivedIn === gesture && push < 380) return false;
      tornIn = gesture;
      return true;
    });
    if (r === 'arrived') { arrivedIn = gesture; push = 0; warm(); }
  }, { passive: false });

  /* keyboard scrolling does the same at page edges; Home and End tear straight to the ends */
  window.addEventListener('keydown', function (e) {
    if (!enabled() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var el = document.activeElement;
    if (el && el !== document.body && el !== root && el.tagName !== 'A') return;
    var k = e.key, amount = 0;
    if (k === 'ArrowDown') amount = 60; else if (k === 'ArrowUp') amount = -60;
    else if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) amount = vh() * 0.85;
    else if (k === 'PageUp' || (k === ' ' && e.shiftKey)) amount = -vh() * 0.85;
    else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      if (!busy) go(k === 'Home' ? 0 : pages.length - 1, window.innerWidth / 2);
      return;
    } else return;
    if (busy) { e.preventDefault(); return; }
    var r = edgeMove(amount, window.innerWidth / 2, e, function () { return !e.repeat; }, true);
    if (r === 'arrived') warm();
  });

  /* ---------- tearing by hand ---------- */
  /* press on the page (not on something clickable) and drag up or down: up tears toward the next
     page, down goes back one. Page text isn't selectable while tearing is on, so a drag always
     means the paper; hold Cmd (Ctrl on Windows/Linux) to select text instead. */
  var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  var SEL_KEY = mac ? '\u2318' : 'Ctrl';
  var selHint = hero.querySelector('.sel-key');
  if (selHint) selHint.textContent = SEL_KEY;
  var NOGRAB = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="tab"], [role="slider"], [tabindex], iframe, video';
  var hold = null;

  document.addEventListener('pointerdown', function (e) {
    if (!enabled() || busy || e.button !== 0 || e.metaKey || e.ctrlKey || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
    if (!(hero.contains(e.target) || main.contains(e.target)) || (e.target.closest && e.target.closest(NOGRAB))) return;
    if (pages[last].contains(e.target) || onLast()) return;
    selectable(false);                    // a plain press is for tearing: drop any earlier selection
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, dir: 0, trail: [[e.clientX, e.clientY, e.timeStamp]] };
    /* start the picture now; it's usually ready by the time the drag declares itself */
    if (!fresh() && ensureGL()) capture().catch(function () {});
  });

  window.addEventListener('pointermove', function (e) {
    var g = hold;
    if (!g || e.pointerId !== g.id) return;
    g.cx = e.clientX; g.cy = e.clientY;
    g.trail.push([e.clientX, e.clientY, e.timeStamp]);
    if (g.trail.length > 8) g.trail.shift();
    var dx = g.cx - g.x, dy = g.cy - g.y;
    if (!g.dir) {
      /* wait until the drag says which way; a pull that starts off diagonal still counts. A
         clearly sideways drag is someone trying to select text: tell them how */
      if (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(dx) * 0.6) {
        if (!g.hinted && Math.abs(dx) > 40) { g.hinted = true; tip(g.cx, g.cy); }
        return;
      }
      begin(g, dy < 0 ? 1 : -1);
    }
    aimAt(g);
  });

  function begin(g, dir) {
    g.dir = dir;
    var i = pageAt(scrollY()), j = i + dir;
    g.origin = scrollY();
    g.target = j >= 0 && j < pages.length ? bounds(j).top : null;   // nothing there: it only stretches
    busy = true;
    root.classList.add('is-tearing');
    if (window.getSelection) window.getSelection().removeAllRanges();
    if (!ensureGL()) { busy = false; root.classList.remove('is-tearing'); hold = null; return; }
    capture().then(function (img) {
      if (g.up) { busy = false; root.classList.remove('is-tearing'); return; }   // let go before the picture was ready
      return layDown(img, dir, { hand: 'pointer', x: g.x, y: g.y }, g.target, function () {
        if (g.sheet && !g.sheet.free) jump(g.origin);   // it settled back untorn: put the page back where it was
        busy = false;
        root.classList.remove('is-tearing');
        warm();
      }).then(function (sheet) {
        g.sheet = sheet;
        if (g.up) finish(g); else aimAt(g);
      });
    }).catch(function (e) { off(e); root.classList.remove('is-tearing'); hold = null; });
  }

  function aimAt(g) {
    var sh = g.sheet;
    if (!sh || !sh.hand) return;
    var dx = g.cx - g.x, dy = g.cy - g.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (!sh.free) {
      /* the film resists: it follows less the further you pull, and lifts toward you */
      var k = 1 / (1 + dist / 260);
      if (g.target != null && -dy * g.dir > vh() * PULL) sh.rip();
      sh.aim(g.x + dx * k, g.y + dy * k, 24 + Math.min(dist * 0.55, 190));
    } else sh.aim(g.cx, g.cy, 150);
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
  /* double-clicking a word is another try at selecting */
  document.addEventListener('dblclick', function (e) {
    if (!enabled() || e.metaKey || e.ctrlKey || !(hero.contains(e.target) || main.contains(e.target))) return;
    if ((e.target.closest && e.target.closest(NOGRAB)) || pages[last].contains(e.target)) return;
    tip(e.clientX, e.clientY);
  });

  /* a small note by the pointer: how to select text on a tearable page */
  var tipEl = null, tipT = 0;
  function tip(x, y) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tear-tip';
      tipEl.setAttribute('role', 'status');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = 'Hold ' + SEL_KEY + ' and drag to select text';
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
    tipEl.classList.add('show');
    clearTimeout(tipT);
    tipT = setTimeout(function () { tipEl.classList.remove('show'); }, 1900);
  }

  /* photograph ahead of time: whenever the page comes to rest, and when reaching for the nav */
  var settle = 0;
  window.addEventListener('scroll', function () {
    clearTimeout(settle);
    settle = setTimeout(warm, 220);
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

  window.addEventListener('resize', function () { if (sheets.length) clearAll(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && sheets.length) clearAll(); });

  window.pageTear = {
    /* returns true when it took over the scroll to y */
    to: function (y) {
      if (!enabled()) return false;
      tearTo(y, y > scrollY() ? 1 : -1, window.innerWidth);
      return true;
    }
  };
})();
