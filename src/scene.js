import * as THREE from 'three';

/* ================================================================
   Солнечная система — иммерсивный скролл-вояж.
   Сцена — чистая функция (scrollProgress, time): детерминированная
   генерация через seeded rand, никаких Math.random в рендере.
   ================================================================ */

document.documentElement.classList.add('js');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ————— Seeded RNG —————
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261103);

/* ================================================================
   Процедурные текстуры: периодический value-noise + fbm,
   попиксельная генерация карт цвета / высоты / шероховатости.
   ================================================================ */
function makeNoise(seed) {
  const r = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const g = (i, j) => perm[(perm[i & 255] + (j & 255)) & 511] / 255;
  // value-noise, периодический по x (бесшовная стыковка текстуры на сфере)
  function noiseP(x, y, per) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const w = (i) => ((i % per) + per) % per;
    const a = g(w(ix), iy), b = g(w(ix + 1), iy), c = g(w(ix), iy + 1), d = g(w(ix + 1), iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function fbm(x, y, per, oct) {
    let v = 0, a = 0.55, f = 1, sum = 0;
    for (let i = 0; i < oct; i++) { v += a * noiseP(x * f, y * f, per * f); sum += a; f *= 2; a *= 0.5; }
    return v / sum;
  }
  return { fbm };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth01 = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix3 = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];

// fill(u,v) → [r,g,b] или [r,g,b,a]
function pixelCanvas(w, h, fill) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const d = id.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++, i += 4) {
      const o = fill((x + 0.5) / w, v);
      d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o.length > 3 ? o[3] : 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
function toTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ————— Земля: континенты fbm + биомы + ледяные шапки + ночные огни; карты цвета/высоты/шероховатости —————
function earthMaps() {
  const W = 1024, H = 512, P = 8, SEA = 0.52;
  const hN = makeNoise(11), mN = makeNoise(23), wN = makeNoise(37), cN = makeNoise(91), fN = makeNoise(101);
  const heightAt = (u, v) => {
    const warp = wN.fbm(u * P, v * P, P, 4);
    return hN.fbm(u * P + warp * 1.35, v * P, P, 6) * 0.72 + warp * 0.28;
  };
  const color = pixelCanvas(W, H, (u, v) => {
    const lat = Math.abs(v - 0.5) * 2;
    const h = heightAt(u, v);
    const moist = mN.fbm(u * 12, v * 12, 12, 4);
    if (h < SEA) {
      const d = (SEA - h) / SEA;
      let col = mix3([48, 112, 170], [11, 38, 86], smooth01(0.02, 0.5, d));
      const ice = smooth01(0.82, 0.95, lat);
      return mix3(col, [232, 240, 246], ice);
    }
    const e = (h - SEA) / (1 - SEA);
    let col = mix3([152, 136, 90], [54, 102, 60], smooth01(0.35, 0.62, moist));
    col = mix3(col, [122, 112, 88], smooth01(0.55, 0.85, lat) * 0.7);
    col = mix3(col, [124, 110, 96], smooth01(0.42, 0.62, e));
    col = mix3(col, [240, 244, 248], smooth01(0.66, 0.8, e));
    col = mix3(col, [234, 240, 246], smooth01(0.84, 0.95, lat));
    col = mix3([172, 154, 108], col, smooth01(0.0, 0.045, e));
    return col;
  });
  const bump = pixelCanvas(256, 128, (u, v) => { const g = heightAt(u, v) * 255; return [g, g, g]; });
  const rough = pixelCanvas(256, 128, (u, v) => {
    const g = heightAt(u, v) < SEA ? 70 : 235; return [g, g, g];
  });
  // ночные огни городов (emissive): кластеры на суше
  const lights = pixelCanvas(W, H, (u, v) => {
    if (heightAt(u, v) < SEA) return [0, 0, 0];
    const cl = cN.fbm(u * 10, v * 10, 10, 4);
    const fine = fN.fbm(u * 48, v * 48, 48, 3);
    const b = smooth01(0.56, 0.7, cl) * (0.45 + 0.55 * fine);
    return [255 * b, 196 * b, 118 * b];
  });
  return { map: toTex(color), bumpMap: toTex(bump, false), roughnessMap: toTex(rough, false), emissiveMap: toTex(lights) };
}
function earthClouds() {
  const n = makeNoise(53), w = makeNoise(67);
  const c = pixelCanvas(512, 256, (u, v) => {
    const warp = w.fbm(u * 5, v * 5, 5, 4);
    // вытянутые вдоль широты перистые облака
    let cl = n.fbm(u * 10 + warp * 2.6, v * 5.5, 10, 5);
    cl = cl * 0.75 + w.fbm(u * 20, v * 9, 20, 3) * 0.25;
    const a = smooth01(0.54, 0.8, cl) * 245;
    return [255, 255, 255, a];
  });
  return toTex(c);
}

// ————— Газовые/ледяные гиганты: полосы с доменным искажением —————
function giantTexture(stops, { warpAmt = 0.05, turbAmt = 0.03, seed = 5, W = 1024, H = 512, spot = null } = {}) {
  const n1 = makeNoise(seed), n2 = makeNoise(seed + 7);
  const sample = (vv) => {
    vv = clamp01(vv);
    for (let i = 0; i < stops.length - 1; i++) {
      const [p1, c1] = stops[i], [p2, c2] = stops[i + 1];
      if (vv >= p1 && vv <= p2) {
        const t = (vv - p1) / Math.max(1e-6, p2 - p1);
        return mix3(c1, c2, t);
      }
    }
    return stops[stops.length - 1][1];
  };
  const canvas = pixelCanvas(W, H, (u, v) => {
    const warp = (n1.fbm(u * 4, v * 6, 4, 4) - 0.5) * warpAmt;
    const turb = (n2.fbm(u * 12, v * 12, 12, 4) - 0.5) * turbAmt;
    const col = sample(v + warp + turb);
    const br = 1 + turb * 8;
    return [clamp01(col[0] * br / 255) * 255, clamp01(col[1] * br / 255) * 255, clamp01(col[2] * br / 255) * 255];
  });
  if (spot) { // Большое красное пятно / Тёмное пятно: перьевой овал + кромка + шлейф
    const ctx = canvas.getContext('2d');
    const [sx, sy, sr, rgb, rim] = spot;
    const cx = sx * W, cy = sy * H, rx = sr * W, ry = sr * W * 0.5;
    const grad = ctx.createRadialGradient(cx, cy, ry * 0.15, cx, cy, rx);
    grad.addColorStop(0, `rgba(${rgb},0.95)`);
    grad.addColorStop(0.7, `rgba(${rgb},0.75)`);
    grad.addColorStop(0.88, `rgba(${rim},0.55)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx); ctx.translate(-cx, -cy);
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rx * 1.4, cy - ry * 1.4 / (ry / rx), rx * 2.8, rx * 2.8);
    ctx.restore();
    // турбулентный шлейф
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = `rgba(${rim},0.6)`;
    for (let i = 0; i < 26; i++) {
      const t = rand();
      ctx.beginPath();
      ctx.ellipse(cx + rx * (0.9 + t * 1.6), cy + (rand() - 0.5) * ry * 0.9, rx * 0.32, ry * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  return { map: toTex(canvas) };
}

// ————— Каменистые планеты: fbm-рельеф + кратеры —————
function rockyTexture({ base, dark, light, craters = 0, caps = 0, basalt = null, seed = 3, W = 512, H = 256 }) {
  const hN = makeNoise(seed), mN = makeNoise(seed + 11);
  const P = 8;
  const hAt = (u, v) => hN.fbm(u * P, v * P, P, 6);
  const canvas = pixelCanvas(W, H, (u, v) => {
    const lat = Math.abs(v - 0.5) * 2;
    const h = hAt(u, v);
    let col = mix3(dark, light, smooth01(0.34, 0.68, h));
    col = mix3(base, col, 0.65);
    if (basalt) { // тёмные базальтовые равнины (марсианские «моря»)
      const m = mN.fbm(u * 5, v * 5, 5, 4);
      col = mix3(col, basalt, smooth01(0.55, 0.7, m) * 0.7);
    }
    col = mix3(col, [236, 230, 226], smooth01(1 - caps - 0.06, 1 - caps + 0.02, lat));
    return col;
  });
  if (craters) {
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < craters; i++) {
      const x = rand() * W, y = H * (0.08 + rand() * 0.84), r = 1.5 + rand() * rand() * 10;
      const gr = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      gr.addColorStop(0, 'rgba(30,24,20,0.34)');
      gr.addColorStop(0.75, 'rgba(30,24,20,0.16)');
      gr.addColorStop(0.92, 'rgba(235,225,210,0.22)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  const bump = pixelCanvas(256, 128, (u, v) => { const g = hAt(u, v) * 255; return [g, g, g]; });
  return { map: toTex(canvas), bumpMap: toTex(bump, false) };
}

function ringsTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const cx = 256, cy = 256;
  for (let i = 0; i < 240; i++) {
    const r = 0.36 * cx + rand() * 0.62 * cx;
    ctx.globalAlpha = 0.05 + rand() * 0.3;
    ctx.strokeStyle = rand() > 0.45 ? '#d8c49a' : '#9a8a6c';
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  // щель Кассини
  ctx.globalAlpha = 0.75; ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(cx, cy, 0.72 * cx, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  return toTex(c);
}

/* ================================================================
   WebGL init (при сбое — CSS-постер)
   ================================================================ */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('scene'),
    antialias: true, alpha: false, preserveDrawingBuffer: true,
  });
} catch (e) {
  document.body.classList.add('no-webgl');
}

let scene, camera, sunUniforms, beltGroup, moonPivot;
const coronaSprites = [], starGroups = [], planetMeshes = {};

const SUN_R = 12;
const JUPITER_STOPS = [
  [0.0, [172, 146, 116]], [0.07, [206, 186, 156]], [0.14, [166, 126, 94]],
  [0.22, [222, 202, 170]], [0.3, [186, 146, 104]], [0.38, [230, 212, 180]],
  [0.45, [198, 158, 114]], [0.52, [216, 194, 160]], [0.6, [170, 126, 90]],
  [0.68, [226, 206, 174]], [0.76, [188, 150, 108]], [0.85, [208, 188, 156]],
  [0.93, [168, 138, 110]], [1.0, [158, 134, 110]],
];
const SATURN_STOPS = [
  [0.0, [196, 178, 140]], [0.12, [220, 202, 164]], [0.24, [206, 186, 142]],
  [0.36, [228, 212, 172]], [0.5, [214, 196, 152]], [0.64, [230, 216, 178]],
  [0.78, [204, 184, 140]], [0.9, [216, 198, 158]], [1.0, [190, 172, 134]],
];
const VENUS_STOPS = [
  [0.0, [226, 204, 160]], [0.2, [238, 222, 182]], [0.4, [222, 196, 146]],
  [0.55, [240, 226, 188]], [0.75, [226, 204, 158]], [1.0, [234, 216, 172]],
];
const URANUS_STOPS = [
  [0.0, [158, 210, 214]], [0.3, [170, 220, 224]], [0.5, [182, 228, 228]],
  [0.72, [168, 218, 222]], [0.9, [162, 212, 216]], [1.0, [156, 208, 212]],
];
const NEPTUNE_STOPS = [
  [0.0, [74, 112, 190]], [0.15, [62, 98, 172]], [0.3, [92, 134, 214]],
  [0.45, [78, 120, 204]], [0.58, [102, 146, 222]], [0.72, [72, 114, 194]],
  [0.86, [86, 130, 210]], [1.0, [68, 106, 180]],
];

const PLANETS = [
  { id: 'mercury', x: 27, r: 1.5, speed: 0.30, bump: 0.5,
    tex: () => rockyTexture({ base: [156, 144, 128], dark: [92, 82, 72], light: [206, 194, 174], craters: 110, seed: 3 }) },
  { id: 'venus', x: 41, r: 2.5, speed: 0.18, atmo: ['#eec98a', 1.3],
    tex: () => giantTexture(VENUS_STOPS, { warpAmt: 0.1, turbAmt: 0.02, seed: 21 }) },
  { id: 'earth', x: 57, r: 2.7, speed: 0.35, bump: 0.6, clouds: true, atmo: ['#5da4ff', 3.4],
    tex: earthMaps },
  { id: 'mars', x: 71, r: 2.0, speed: 0.32, bump: 0.5, atmo: ['#e08a5a', 0.6],
    tex: () => rockyTexture({ base: [198, 106, 60], dark: [140, 66, 40], light: [226, 148, 92], basalt: [104, 54, 40], caps: 0.09, seed: 9 }) },
  { id: 'jupiter', x: 100, r: 7.2, speed: 0.55, atmo: ['#d8b98a', 0.9],
    tex: () => giantTexture(JUPITER_STOPS, { warpAmt: 0.045, turbAmt: 0.028, seed: 31, spot: [0.68, 0.63, 0.052, '196,84,58', '232,200,170'] }) },
  { id: 'saturn', x: 131, r: 6.0, speed: 0.5, rings: true, atmo: ['#e3d0a0', 0.85],
    tex: () => giantTexture(SATURN_STOPS, { warpAmt: 0.03, turbAmt: 0.016, seed: 41 }) },
  { id: 'uranus', x: 157, r: 3.9, speed: 0.4, atmo: ['#8fe0e0', 1.2],
    tex: () => giantTexture(URANUS_STOPS, { warpAmt: 0.015, turbAmt: 0.006, seed: 51 }) },
  { id: 'neptune', x: 181, r: 3.7, speed: 0.42, atmo: ['#6f92e8', 1.7],
    tex: () => giantTexture(NEPTUNE_STOPS, { warpAmt: 0.05, turbAmt: 0.02, seed: 61, spot: [0.6, 0.4, 0.045, '44,66,136', '92,134,214'] }) },
];

// ————— Атмосферное свечение: яркий ободок + широкий мягкий ореол —————
function makeAtmosphere(radius, color, k) {
  const group = new THREE.Group();
  const vertexShader = `
    varying vec3 vN;
    void main(){
      vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const fragmentShader = `
    uniform vec3 uColor; uniform float uK; uniform float uP;
    varying vec3 vN;
    void main(){
      float rim = pow(max(0.0, 0.7 - dot(vN, vec3(0.0, 0.0, 1.0))), uP);
      gl_FragColor = vec4(uColor * rim * uK, 1.0);
    }`;
  for (const [scale, pow_, mul] of [[1.05, 2.6, 1.0], [1.2, 4.2, 0.3]]) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uK: { value: k * mul }, uP: { value: pow_ },
      },
      vertexShader, fragmentShader,
      side: THREE.BackSide, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false,
    });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(radius * scale, 64, 40), mat));
  }
  return group;
}

if (renderer) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);
  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 1500);

  // ————— Свет: драматичный, с глубокими тенями —————
  scene.add(new THREE.AmbientLight(0x6f80a8, 0.2));
  const sunLight = new THREE.PointLight(0xffe9c4, 10, 0, 0.5);
  sunLight.position.set(0, 0, 0);
  scene.add(sunLight);

  // ————— Звёзды: сферическая оболочка + галактическая полоса —————
  function starCloud(count, rMin, rMax, size, band = false) {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const palette = [[1, 1, 1], [0.75, 0.85, 1], [1, 0.9, 0.75], [1, 0.8, 0.6]];
    for (let i = 0; i < count; i++) {
      let x, y, z;
      if (band) {
        const a = rand() * Math.PI * 2, r = rMin + rand() * (rMax - rMin);
        const spread = (rand() - 0.5) * (rMax - rMin) * 0.22;
        x = Math.cos(a) * r; z = Math.sin(a) * r;
        y = spread + (rand() - 0.5) * 60;
        const tilt = 0.42; const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
        const z2 = y * Math.sin(tilt) + z * Math.cos(tilt); y = y2; z = z2;
      } else {
        const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = rMin + rand() * (rMax - rMin);
        const s = Math.sqrt(1 - u * u);
        x = s * Math.cos(a) * r; y = u * r; z = s * Math.sin(a) * r;
      }
      pos.set([x, y, z], i * 3);
      const p = palette[(rand() * palette.length) | 0], b = 0.35 + rand() * 0.65;
      col.set([p[0] * b, p[1] * b, p[2] * b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false });
    const pts = new THREE.Points(g, m);
    scene.add(pts);
    starGroups.push(pts);
    return pts;
  }
  starCloud(2600, 500, 1000, 1.8);
  starCloud(2600, 650, 950, 1.4, true);
  starCloud(140, 500, 950, 3.2); // яркие звёзды переднего плана

  // ————— Млечный Путь: мягкие светящиеся облака вдоль наклонной полосы —————
  function nebulaSpriteTexture(seed) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(256, 256);
    const d = id.data;
    const n = makeNoise(seed);
    let i = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++, i += 4) {
      const dx = (x - 128) / 128, dy = (y - 128) / 128;
      const r = Math.sqrt(dx * dx + dy * dy);
      const fall = Math.max(0, 1 - r);
      const cl = n.fbm(x / 256 * 6, y / 256 * 6, 6, 5);
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.pow(fall, 1.8) * (0.3 + 0.7 * cl) * 255;
    }
    ctx.putImageData(id, 0, 0);
    return new THREE.CanvasTexture(c);
  }
  const nebTex = nebulaSpriteTexture(303);
  const MW_TILT = 0.42;
  for (let i = 0; i < 38; i++) {
    const a = rand() * Math.PI * 2;
    const r = 740 + rand() * 180;
    let x = Math.cos(a) * r, z = Math.sin(a) * r;
    let y = (rand() - 0.5) * 110 * (rand() > 0.5 ? 1 : 0.4);
    const y2 = y * Math.cos(MW_TILT) - z * Math.sin(MW_TILT);
    const z2 = y * Math.sin(MW_TILT) + z * Math.cos(MW_TILT);
    y = y2; z = z2;
    const tint = [0xbccce8, 0x9fb4d8, 0xd8cfbf, 0x8898c0][(rand() * 4) | 0];
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebTex, color: tint, transparent: true,
      opacity: 0.05 + rand() * 0.09, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sp.position.set(x, y, z);
    sp.scale.setScalar(150 + rand() * 280);
    scene.add(sp);
  }

  // ————— Солнце: шейдерная поверхность + корона —————
  sunUniforms = { uTime: { value: 0 } };
  const sunMat = new THREE.ShaderMaterial({
    uniforms: sunUniforms,
    vertexShader: `
      varying vec3 vN; varying vec3 vP;
      void main(){
        vN = normalize(normalMatrix * normal);
        vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vN; varying vec3 vP;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
      float noise(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        float n000=hash(i), n100=hash(i+vec3(1,0,0)), n010=hash(i+vec3(0,1,0)), n110=hash(i+vec3(1,1,0));
        float n001=hash(i+vec3(0,0,1)), n101=hash(i+vec3(1,0,1)), n011=hash(i+vec3(0,1,1)), n111=hash(i+vec3(1,1,1));
        return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
                   mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
      }
      float fbm(vec3 p){
        float v=0.0, a=0.5;
        for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.1; a*=0.5; }
        return v;
      }
      void main(){
        float n = fbm(vP*0.35 + vec3(uTime*0.06, uTime*0.04, 0.0));
        float n2 = fbm(vP*1.1 - vec3(0.0, uTime*0.08, uTime*0.05));
        float m = clamp(n*0.7 + n2*0.45, 0.0, 1.0);
        vec3 deep = vec3(0.55,0.14,0.02);
        vec3 mid  = vec3(1.0,0.45,0.08);
        vec3 hot  = vec3(1.0,0.88,0.55);
        vec3 col = mix(deep, mid, smoothstep(0.15,0.55,m));
        col = mix(col, hot, smoothstep(0.55,0.9,m));
        vec3 vDir = normalize((viewMatrix * vec4(0.0,0.0,0.0,1.0)).xyz);
        float fres = pow(1.0 - abs(vN.z), 2.0);
        col += vec3(1.0,0.7,0.35) * fres * 0.9;
        gl_FragColor = vec4(col * 1.35, 1.0);
      }`,
  });
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 64), sunMat);
  scene.add(sunMesh);

  function coronaTexture(rays) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,235,190,1)');
    g.addColorStop(0.25, 'rgba(255,190,100,0.55)');
    g.addColorStop(0.6, 'rgba(255,140,50,0.16)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    if (rays) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 46; i++) {
        const a = rand() * Math.PI * 2, len = 60 + rand() * 65;
        const gg = ctx.createLinearGradient(128, 128, 128 + Math.cos(a) * len, 128 + Math.sin(a) * len);
        gg.addColorStop(0, 'rgba(255,220,150,0.28)'); gg.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.strokeStyle = gg; ctx.lineWidth = 1 + rand() * 2.5;
        ctx.beginPath(); ctx.moveTo(128 + Math.cos(a) * 22, 128 + Math.sin(a) * 22);
        ctx.lineTo(128 + Math.cos(a) * len, 128 + Math.sin(a) * len); ctx.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  for (const [scale, opacity, rays] of [[3.4, 0.95, true], [5.6, 0.4, false]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: coronaTexture(rays), blending: THREE.AdditiveBlending,
      transparent: true, opacity, depthWrite: false,
    }));
    sp.scale.setScalar(SUN_R * scale);
    scene.add(sp);
    coronaSprites.push(sp);
  }

  // ————— Орбиты —————
  for (const p of PLANETS) {
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * p.x, 0, Math.sin(a) * p.x));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x8899bb, transparent: true, opacity: 0.14 }));
    scene.add(line);
  }

  // ————— Планеты —————
  for (const p of PLANETS) {
    const maps = p.tex();
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map, roughness: 1, metalness: 0,
      ...(maps.roughnessMap ? { roughnessMap: maps.roughnessMap } : {}),
      ...(maps.bumpMap ? { bumpMap: maps.bumpMap, bumpScale: p.bump ?? 0.4 } : {}),
      ...(maps.emissiveMap ? { emissive: new THREE.Color(0xffd9a0), emissiveMap: maps.emissiveMap, emissiveIntensity: 2.6 } : {}),
    });
    if (!maps.roughnessMap) mat.roughness = 0.95;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.r, 64, 40), mat);
    mesh.position.set(p.x, 0, 0);
    mesh.rotation.z = (rand() - 0.5) * 0.24;
    scene.add(mesh);
    planetMeshes[p.id] = { mesh, cfg: p };

    if (p.atmo) mesh.add(makeAtmosphere(p.r, p.atmo[0], p.atmo[1]));
    if (p.clouds) {
      const clouds = new THREE.Mesh(
        new THREE.SphereGeometry(p.r * 1.03, 64, 40),
        new THREE.MeshStandardMaterial({ map: earthClouds(), transparent: true, depthWrite: false, roughness: 1 }));
      mesh.add(clouds);
      planetMeshes[p.id].clouds = clouds;
    }
    if (p.rings) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(p.r * 1.35, p.r * 2.3, 128, 1),
        new THREE.MeshBasicMaterial({
          map: ringsTexture(), side: THREE.DoubleSide, transparent: true,
          opacity: 0.92, depthWrite: false,
        }));
      ring.rotation.x = Math.PI / 2 - 0.42;
      mesh.add(ring);
    }
  }
  // Луна у Земли
  moonPivot = new THREE.Group();
  const moonMaps = rockyTexture({ base: [148, 146, 140], dark: [96, 94, 90], light: [196, 194, 186], craters: 70, seed: 77, W: 256, H: 128 });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 20),
    new THREE.MeshStandardMaterial({ map: moonMaps.map, bumpMap: moonMaps.bumpMap, bumpScale: 0.3, roughness: 1 }));
  moon.position.set(5.2, 0, 0);
  moonPivot.add(moon);
  planetMeshes.earth.mesh.add(moonPivot);

  // ————— Пояс астероидов (инстансы) —————
  beltGroup = new THREE.Group();
  const beltGeo = new THREE.DodecahedronGeometry(1, 0);
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x8d8578, roughness: 1 });
  const belt = new THREE.InstancedMesh(beltGeo, beltMat, 1700);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 1700; i++) {
    const a = rand() * Math.PI * 2, r = 78 + rand() * 13;
    dummy.position.set(Math.cos(a) * r, (rand() - 0.5) * 4.2, Math.sin(a) * r);
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    dummy.scale.setScalar(0.07 + rand() * rand() * 0.34);
    dummy.updateMatrix();
    belt.setMatrixAt(i, dummy.matrix);
  }
  beltGroup.add(belt);
  scene.add(beltGroup);
}

/* ================================================================
   Камера-сторителлинг: остановки привязаны к секциям DOM
   ================================================================ */
const STOPS = [
  { id: 'hero',    pos: new THREE.Vector3(-30, 48, 132), tgt: new THREE.Vector3(66, 0, 4), shift: 0 },
  { id: 'sun',     pos: new THREE.Vector3(27, 9, 33),    tgt: new THREE.Vector3(0, 0, 0), shift: -1 },
  { id: 'mercury', pos: new THREE.Vector3(19.5, 2.0, 6.5), tgt: new THREE.Vector3(27, 0, 0), shift: 1 },
  { id: 'venus',   pos: new THREE.Vector3(33.5, 3.0, 7.5), tgt: new THREE.Vector3(41, 0, 0), shift: -1 },
  { id: 'earth',   pos: new THREE.Vector3(48.5, 3.2, 8.5), tgt: new THREE.Vector3(57, 0, 0), shift: 1 },
  { id: 'mars',    pos: new THREE.Vector3(62.5, 2.2, 6.0), tgt: new THREE.Vector3(71, 0, 0), shift: -1 },
  { id: 'jupiter', pos: new THREE.Vector3(77, 8, 24),      tgt: new THREE.Vector3(100, 0, 0), shift: 1 },
  { id: 'saturn',  pos: new THREE.Vector3(106, 9, 28),     tgt: new THREE.Vector3(131, 0, 0), shift: -1 },
  { id: 'uranus',  pos: new THREE.Vector3(145, 5, 13.5),   tgt: new THREE.Vector3(157, 0, 0), shift: 1 },
  { id: 'neptune', pos: new THREE.Vector3(170, 4.5, 12.5), tgt: new THREE.Vector3(181, 0, 0), shift: -1 },
  { id: 'finale',  pos: new THREE.Vector3(90, 62, 265),  tgt: new THREE.Vector3(80, 0, 0), shift: 0 },
];
const smooth = (t) => t * t * (3 - 2 * t);

// Центры секций в долях прокрутки — камера синхронизирована с DOM
let stopAnchors = [];
function computeAnchors() {
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  stopAnchors = STOPS.map((s) => {
    if (s.id === 'hero') return 0;
    const el = document.getElementById(s.id);
    if (!el) return 0;
    return Math.min(1, Math.max(0, (el.offsetTop + el.offsetHeight / 2 - innerHeight / 2) / maxScroll));
  });
  stopAnchors[stopAnchors.length - 1] = 1;
}
computeAnchors();

function scrollProgress() {
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  return Math.min(1, Math.max(0, scrollY / maxScroll));
}

const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function applyCamera(p) {
  let i = 0;
  while (i < STOPS.length - 2 && p > stopAnchors[i + 1]) i++;
  const a0 = stopAnchors[i], a1 = stopAnchors[i + 1];
  const t = a1 > a0 ? smooth(Math.min(1, Math.max(0, (p - a0) / (a1 - a0)))) : 0;
  camPos.lerpVectors(STOPS[i].pos, STOPS[i + 1].pos, t);
  camTgt.lerpVectors(STOPS[i].tgt, STOPS[i + 1].tgt, t);
  // смещение кадра: планета уходит в сторону, противоположную текстовой панели
  const shift = STOPS[i].shift + (STOPS[i + 1].shift - STOPS[i].shift) * t;
  if (shift !== 0) {
    _dir.subVectors(camTgt, camPos);
    const dist = _dir.length();
    _right.crossVectors(_dir.normalize(), _up).normalize();
    camTgt.addScaledVector(_right, -shift * dist * 0.26);
  }
  camera.position.copy(camPos);
  camera.lookAt(camTgt);
  return i;
}

/* ================================================================
   DOM: reveal, навигация, прогресс-бар
   ================================================================ */
const panels = document.querySelectorAll('.panel');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.2 });
panels.forEach((p) => io.observe(p));
requestAnimationFrame(() => document.querySelector('.hero-inner')?.classList.add('in'));

const navLinks = [...document.querySelectorAll('.nav a')];
const progressTop = document.querySelector('.progress-top');
function updateNav(activeIdx) {
  const activeId = STOPS[activeIdx]?.id;
  for (const a of navLinks) a.classList.toggle('active', a.dataset.stop === activeId);
}

/* ================================================================
   Цикл рендера
   ================================================================ */
let sp = scrollProgress();          // сглаженный прогресс
let mouseX = 0, mouseY = 0;
addEventListener('pointermove', (e) => {
  mouseX = (e.clientX / innerWidth - 0.5) * 2;
  mouseY = (e.clientY / innerHeight - 0.5) * 2;
}, { passive: true });

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  const p = scrollProgress();

  if (REDUCED) sp = p; else sp += (p - sp) * Math.min(1, dt * 4.5);
  const activeIdx = renderer ? applyCamera(sp) : 0;

  if (renderer) {
    // лёгкое дыхание камеры + параллакс
    if (!REDUCED) {
      camera.position.x += Math.sin(t * 0.35) * 0.35 + mouseX * 0.9;
      camera.position.y += Math.cos(t * 0.28) * 0.3 - mouseY * 0.6;
      camera.lookAt(camTgt);
    }
    sunUniforms.uTime.value = t;
    for (const id in planetMeshes) {
      const pm = planetMeshes[id];
      pm.mesh.rotation.y += dt * pm.cfg.speed * 0.4;
      if (pm.clouds) pm.clouds.rotation.y += dt * 0.09; // облака чуть обгоняют сушу
    }
    moonPivot.rotation.y += dt * 0.5;
    beltGroup.rotation.y += dt * 0.006;
    coronaSprites.forEach((s, i) => {
      s.scale.setScalar(SUN_R * (i === 0 ? 3.4 : 5.6) * (1 + Math.sin(t * (0.6 + i * 0.35)) * 0.03));
    });
    starGroups.forEach((g, i) => { g.rotation.y += dt * (0.0012 + i * 0.0006); });
    renderer.render(scene, camera);
  }

  progressTop.style.transform = `scaleX(${p})`;
  updateNav(activeIdx);
}
renderer ? renderer.setAnimationLoop(frame) : setInterval(frame, 100);

addEventListener('resize', () => {
  computeAnchors();
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}, { passive: true });

// ————— Хуки для верификации скриншотами —————
window.__seek = (v) => {
  const p = Number(v);
  if (Number.isFinite(p)) {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    scrollTo({ top: Math.min(1, Math.max(0, p)) * maxScroll, behavior: 'instant' });
    sp = scrollProgress();
    if (renderer) { applyCamera(sp); renderer.render(scene, camera); }
  }
};
window.__SCENE_READY__ = true;
