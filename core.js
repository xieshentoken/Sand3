/**
 * Sand3 core numerical library.
 *
 * This file deliberately has no DOM or storage dependencies.  It contains the
 * reciprocal-lattice, FFT, peak geometry, uncertainty and card-matching code
 * shared by the UI and the test suite.
 */

const DEG = Math.PI / 180;
const EPS = 1e-12;

export const CRYSTAL_SYSTEM_BY_CODE = Object.freeze({
  A: "Triclinic",
  M: "Monoclinic",
  O: "Orthorhombic",
  T: "Tetragonal",
  H: "Hexagonal",
  R: "Rhombohedral",
  C: "Cubic",
  X: "Unknown",
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function combineTolerance(manual, sigma = 0, k = 2, method = "rss") {
  const a = Math.max(0, Number(manual) || 0);
  const b = Math.max(0, Number(sigma) || 0) * Math.max(0, Number(k) || 0);
  return method === "linear" ? a + b : Math.hypot(a, b);
}

function determinant3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function inverse3(m) {
  const d = determinant3(m);
  if (!Number.isFinite(d) || Math.abs(d) < EPS) throw new Error("晶胞矩阵不可逆");
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d,
    ],
  ];
}

function transpose3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function normalizeCell(cell) {
  const values = Array.isArray(cell)
    ? cell
    : [cell?.a, cell?.b, cell?.c, cell?.alpha, cell?.beta, cell?.gamma];
  if (values.length !== 6 || values.some((v) => !Number.isFinite(Number(v)))) {
    throw new Error("晶胞参数必须包含 a、b、c、alpha、beta、gamma");
  }
  const [a, b, c, alpha, beta, gamma] = values.map(Number);
  if (a <= 0 || b <= 0 || c <= 0 || alpha <= 0 || beta <= 0 || gamma <= 0) {
    throw new Error("晶胞长度和角度必须为正数");
  }
  return { a, b, c, alpha, beta, gamma };
}

export function reciprocalBasis(cellInput) {
  const { a, b, c, alpha, beta, gamma } = normalizeCell(cellInput);
  const ca = Math.cos(alpha * DEG);
  const cb = Math.cos(beta * DEG);
  const cg = Math.cos(gamma * DEG);
  const sg = Math.sin(gamma * DEG);
  if (Math.abs(sg) < EPS) throw new Error("gamma 导致退化晶胞");
  const cx = c * cb;
  const cy = (c * (ca - cb * cg)) / sg;
  const cz2 = c * c - cx * cx - cy * cy;
  if (cz2 <= EPS) throw new Error("晶胞角度不构成有效三维晶胞");
  // Columns are direct-space basis vectors in Cartesian coordinates.
  const direct = [
    [a, b * cg, cx],
    [0, b * sg, cy],
    [0, 0, Math.sqrt(cz2)],
  ];
  // Reciprocal basis without 2π: B = A^(-T).
  return transpose3(inverse3(direct));
}

export function reciprocalVector(hkl, cell) {
  const b = reciprocalBasis(cell);
  const [h, k, l] = hkl.map(Number);
  return [
    b[0][0] * h + b[0][1] * k + b[0][2] * l,
    b[1][0] * h + b[1][1] * k + b[1][2] * l,
    b[2][0] * h + b[2][1] * k + b[2][2] * l,
  ];
}

export function dot(a, b) {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

export function dSpacing(hkl, cell) {
  const g = norm(reciprocalVector(hkl, cell));
  return g > EPS ? 1 / g : Infinity;
}

export function vectorAngle(a, b) {
  const denominator = norm(a) * norm(b);
  if (denominator < EPS) return NaN;
  return Math.acos(clamp(dot(a, b) / denominator, -1, 1)) / DEG;
}

export function planeAngle(hkl1, hkl2, cell) {
  return vectorAngle(reciprocalVector(hkl1, cell), reciprocalVector(hkl2, cell));
}

function keyHkl(hkl) {
  return hkl.map((x) => Math.round(x)).join(",");
}

function permutations3(values) {
  const [a, b, c] = values;
  return [
    [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
  ];
}

function uniqueHkls(values) {
  const map = new Map();
  for (const hkl of values) map.set(keyHkl(hkl), hkl.map((x) => Math.round(x)));
  return [...map.values()];
}

/** Preserve the point-symmetry expansion used by the original Sand matcher. */
export function symmetryEquivalents(hklInput, crystalSystem = "Unknown") {
  const [h, k, l] = hklInput.map((x) => Math.round(Number(x)));
  const system = String(crystalSystem).toLowerCase();
  const out = [];
  if (system.includes("cubic")) {
    for (const p of [1, -1]) for (const q of [1, -1]) for (const r of [1, -1]) {
      out.push(...permutations3([p * h, q * k, r * l]));
    }
  } else if (system.includes("tetragonal")) {
    for (const p of [1, -1]) for (const q of [1, -1]) for (const r of [1, -1]) {
      out.push([p * h, q * k, r * l], [q * k, p * h, r * l]);
    }
  } else if (system.includes("orthorhombic")) {
    for (const p of [1, -1]) for (const q of [1, -1]) for (const r of [1, -1]) {
      out.push([p * h, q * k, r * l]);
    }
  } else if (system.includes("hexagonal")) {
    const i = -h - k;
    for (const pair of permutations3([h, k, i])) {
      for (const p of [1, -1]) for (const r of [1, -1]) {
        out.push([p * pair[0], p * pair[1], r * l]);
        out.push([p * pair[1], p * pair[0], r * l]);
      }
    }
  } else if (system.includes("trigonal") || system.includes("rhombohedral")) {
    for (const p of [1, -1]) out.push(...permutations3([p * h, p * k, p * l]));
  } else if (system.includes("monoclinic")) {
    for (const p of [1, -1]) for (const r of [1, -1]) out.push([p * h, p * k, r * l]);
  } else if (system.includes("triclinic")) {
    out.push([h, k, l], [-h, -k, -l]);
  } else {
    // Unknown symmetry: retain Friedel equivalents only.
    out.push([h, k, l], [-h, -k, -l]);
  }
  return uniqueHkls(out);
}

export function generateReflections(cell, options = {}) {
  const hMax = Math.max(1, Math.floor(options.hMax ?? 10));
  const dMin = Number(options.dMin ?? 0.5);
  const dMax = Number(options.dMax ?? 50);
  const reflections = [];
  for (let h = -hMax; h <= hMax; h += 1) {
    for (let k = -hMax; k <= hMax; k += 1) {
      for (let l = -hMax; l <= hMax; l += 1) {
        if (h === 0 && k === 0 && l === 0) continue;
        // Keep one Friedel representative; the symmetry stage restores -h,-k,-l.
        const first = h !== 0 ? h : k !== 0 ? k : l;
        if (first < 0) continue;
        const d = dSpacing([h, k, l], cell);
        if (d >= dMin && d <= dMax) reflections.push({ h, k, l, d, origin: "cif_generated" });
      }
    }
  }
  return reflections.sort((a, b) => b.d - a.d);
}

function toleranceFor(measurement, index, kind, options) {
  const sigmaList = measurement[`${kind}Sigma`] || [];
  const manual = kind === "d" ? options.distanceTolerance : options.angleTolerance;
  return combineTolerance(manual, sigmaList[index] || 0, options.sigmaMultiplier, options.toleranceMethod);
}

function divisibleHkl(hkl, order) {
  const n = Math.max(1, Math.round(Number(order) || 1));
  return hkl.every((value) => Math.round(value) % n === 0);
}

/**
 * Match one indexed card against the fixed three-plane parallelogram model.
 * The hard conditions are preserved: g1 + g3 = g2 and all d/angle residuals
 * must fall inside their combined tolerances.
 */
export function matchCard(card, measurement, userOptions = {}) {
  if (!card?.cell || (!Array.isArray(card?.reflections) && !(card?.dValues && card?.hkls))) return [];
  const options = {
    distanceTolerance: 0.1,
    angleTolerance: 5,
    sigmaMultiplier: 2,
    toleranceMethod: "rss",
    diffractionOrder: 1,
    maxResults: 100,
    ...userOptions,
  };
  const observedD = [measurement.d1, measurement.d2, measurement.d3].map(Number);
  const observedPhi = [measurement.phi12, measurement.phi23].map(Number);
  if (observedD.some((x) => !Number.isFinite(x) || x <= 0) || observedPhi.some((x) => !Number.isFinite(x))) {
    return [];
  }
  const crystalSystem = card.crystalSystem || CRYSTAL_SYSTEM_BY_CODE[card.classCode] || "Unknown";
  const candidates = observedD.map((dObs, index) => {
    const tol = toleranceFor(measurement, index, "d", options);
    const map = new Map();
    const reflectionCount = Array.isArray(card.reflections) ? card.reflections.length : card.dValues.length;
    for (let reflectionIndex = 0; reflectionIndex < reflectionCount; reflectionIndex += 1) {
      const reflection = Array.isArray(card.reflections) ? card.reflections[reflectionIndex] : {
        d: card.dValues[reflectionIndex],
        h: card.hkls[reflectionIndex * 3],
        k: card.hkls[reflectionIndex * 3 + 1],
        l: card.hkls[reflectionIndex * 3 + 2],
      };
      const base = [reflection.h, reflection.k, reflection.l].map(Number);
      if (base.some((x) => x === 32767)) continue;
      if (base.some((x) => !Number.isFinite(x))) continue;
      const recordedD = Number.isFinite(Number(reflection.d)) ? Number(reflection.d) : dSpacing(base, card.cell);
      if (Math.abs(recordedD - dObs) > tol) continue;
      for (const hkl of symmetryEquivalents(base, crystalSystem)) {
        if (divisibleHkl(hkl, options.diffractionOrder)) map.set(keyHkl(hkl), hkl);
      }
    }
    return [...map.values()];
  });
  if (candidates.some((list) => list.length === 0)) return [];

  const qMap = new Map(candidates[1].map((q) => [keyHkl(q), q]));
  const results = [];
  for (const p of candidates[0]) {
    for (const m of candidates[2]) {
      const predictedQ = p.map((value, i) => value + m[i]);
      const q = qMap.get(keyHkl(predictedQ));
      if (!q) continue;
      const calD = [p, q, m].map((hkl) => dSpacing(hkl, card.cell));
      const calPhi = [planeAngle(p, q, card.cell), planeAngle(q, m, card.cell)];
      const dResidual = calD.map((value, i) => Math.abs(value - observedD[i]));
      const phiResidual = calPhi.map((value, i) => Math.abs(value - observedPhi[i]));
      const dTolerance = dResidual.map((_, i) => toleranceFor(measurement, i, "d", options));
      const phiTolerance = phiResidual.map((_, i) => toleranceFor(measurement, i, "phi", options));
      if (dResidual.some((value, i) => value > dTolerance[i])) continue;
      if (phiResidual.some((value, i) => value > phiTolerance[i])) continue;
      const score =
        dResidual.reduce((sum, value, i) => sum + (value / Math.max(dTolerance[i], EPS)) ** 2, 0) +
        phiResidual.reduce((sum, value, i) => sum + (value / Math.max(phiTolerance[i], EPS)) ** 2, 0);
      results.push({
        phaseId: card.id,
        name: card.name,
        formula: card.formula,
        hkl1: p,
        hkl2: q,
        hkl3: m,
        calculatedD: calD,
        calculatedPhi: calPhi,
        dResidual,
        phiResidual,
        dTolerance,
        phiTolerance,
        score,
        zoneAxis: zoneAxis(p, m),
      });
    }
  }
  const dedup = new Map();
  for (const result of results) {
    const key = `${keyHkl(result.hkl1)}|${keyHkl(result.hkl2)}|${keyHkl(result.hkl3)}`;
    const previous = dedup.get(key);
    if (!previous || result.score < previous.score) dedup.set(key, result);
  }
  return [...dedup.values()].sort((a, b) => a.score - b.score).slice(0, options.maxResults);
}

function gcd2(a, b) {
  a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

export function zoneAxis(hkl1, hkl2) {
  const [a, b, c] = hkl1;
  const [d, e, f] = hkl2;
  let z = [b * f - c * e, c * d - a * f, a * e - b * d].map(Math.round);
  const divisor = z.reduce((g, value) => gcd2(g, value), 0) || 1;
  z = z.map((value) => value / divisor);
  const first = z.find((value) => value !== 0);
  if (first < 0) z = z.map((value) => -value);
  return z;
}

export function measurementFromVectors(vectors, reciprocalScale) {
  if (!Array.isArray(vectors) || vectors.length !== 3) throw new Error("需要三个倒易矢量");
  const scale = Number(reciprocalScale);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("倒易标定必须大于 0");
  const d = vectors.map((v) => 1 / (Math.hypot(v.x, v.y) * scale));
  return {
    d1: d[0], d2: d[1], d3: d[2],
    phi12: vectorAngle([vectors[0].x, vectors[0].y], [vectors[1].x, vectors[1].y]),
    phi23: vectorAngle([vectors[1].x, vectors[1].y], [vectors[2].x, vectors[2].y]),
  };
}

/** Locate a likely solid horizontal scale bar, preferentially near the image bottom. */
export function detectScaleBar(gray, width, height, options = {}) {
  if (!gray || width < 24 || height < 24) return null;
  const yStart = Math.max(1, Math.floor(height * (options.topFraction ?? 0.55)));
  const minLength = Math.max(12, Math.floor(width * (options.minFraction ?? 0.035)));
  const maxLength = Math.floor(width * (options.maxFraction ?? 0.65));
  let mean = 0; let square = 0; let count = 0;
  for (let y = yStart; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const value = gray[y * width + x]; mean += value; square += value * value; count += 1;
  }
  mean /= Math.max(1, count);
  const sigma = Math.sqrt(Math.max(1e-8, square / Math.max(1, count) - mean * mean));
  const candidates = [];
  for (const polarity of [1, -1]) {
    const threshold = mean + polarity * sigma * 1.15;
    for (let y = yStart; y < height - 1; y += 1) {
      let run = -1;
      for (let x = 1; x < width; x += 1) {
        const value = gray[y * width + x]; const active = polarity > 0 ? value >= threshold : value <= threshold;
        if (active && run < 0) run = x;
        const ended = run >= 0 && (!active || x === width - 1);
        if (!ended) continue;
        const end = active ? x : x - 1; const length = end - run + 1;
        if (length >= minLength && length <= maxLength) {
          let contrast = 0;
          for (let sx = run; sx <= end; sx += Math.max(1, Math.floor(length / 24))) {
            const local = gray[y * width + sx];
            const above = gray[Math.max(0, y - 2) * width + sx]; const below = gray[Math.min(height - 1, y + 2) * width + sx];
            contrast += Math.abs(local - (above + below) / 2);
          }
          const bottomWeight = 0.6 + 0.4 * ((y - yStart) / Math.max(1, height - yStart));
          candidates.push({ x1: run, y1: y, x2: end, y2: y, length, score: length * (0.04 + contrast) * bottomWeight, polarity });
        }
        run = -1;
      }
    }
  }
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return { a: { x: best.x1, y: best.y1 }, b: { x: best.x2, y: best.y2 }, pixelLength: best.length, confidence: Math.min(1, best.score / Math.max(1, width * 0.3)) };
}

/** Snap an approximate coordinate to the strongest locally contrasted bright point. */
export function snapToBrightPoint(values, width, height, point, options = {}) {
  if (!values || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return point;
  const radius = Math.max(2, Math.round(options.radius ?? 12)); const localRadius = Math.max(2, Math.round(options.localRadius ?? 3));
  const cx = Math.round(point.x); const cy = Math.round(point.y); let best = null;
  for (let y = Math.max(localRadius, cy - radius); y <= Math.min(height - localRadius - 1, cy + radius); y += 1) {
    for (let x = Math.max(localRadius, cx - radius); x <= Math.min(width - localRadius - 1, cx + radius); x += 1) {
      const value = values[y * width + x]; let sum = 0; let count = 0;
      for (let dy = -localRadius; dy <= localRadius; dy += 1) for (let dx = -localRadius; dx <= localRadius; dx += 1) {
        if (Math.hypot(dx, dy) < localRadius * 0.65) continue;
        sum += values[(y + dy) * width + x + dx]; count += 1;
      }
      const contrast = value - sum / Math.max(1, count);
      const distancePenalty = Math.hypot(x - point.x, y - point.y) / Math.max(1, radius) * 0.015;
      const score = contrast + value * 0.08 - distancePenalty;
      if (!best || score > best.score) best = { x, y, score, contrast, value };
    }
  }
  if (!best || best.contrast < Number(options.minContrast ?? 0.015)) return { ...point };
  let weight = 0; let sx = 0; let sy = 0;
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    const x = best.x + dx; const y = best.y + dy; const w = Math.max(0, values[y * width + x] - (best.value - best.contrast));
    weight += w; sx += x * w; sy += y * w;
  }
  return { x: weight ? sx / weight : best.x, y: weight ? sy / weight : best.y, snapped: true, contrast: best.contrast };
}

function mulberry32(seed) {
  return function random() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(EPS, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

/** Monte-Carlo propagation, including the shared uncertainty of the 000 centre. */
export function estimateMeasurementUncertainty(vectors, reciprocalScale, options = {}) {
  const iterations = Math.max(100, Math.round(options.iterations ?? 1500));
  const peakSigma = options.peakSigma ?? 0.35;
  const centerSigma = Number(options.centerSigma ?? 0.25);
  const scaleSigma = Number(options.scaleSigma ?? 0);
  const random = mulberry32(options.seed ?? 1234567);
  const samples = [[], [], [], [], []];
  for (let n = 0; n < iterations; n += 1) {
    const cx = gaussian(random) * centerSigma;
    const cy = gaussian(random) * centerSigma;
    const scale = Math.max(EPS, reciprocalScale + gaussian(random) * scaleSigma);
    const perturbed = vectors.map((v, i) => {
      const sigma = Array.isArray(peakSigma) ? Number(peakSigma[i] ?? peakSigma[0]) : Number(peakSigma);
      return { x: v.x + gaussian(random) * sigma - cx, y: v.y + gaussian(random) * sigma - cy };
    });
    const m = measurementFromVectors(perturbed, scale);
    [m.d1, m.d2, m.d3, m.phi12, m.phi23].forEach((value, i) => samples[i].push(value));
  }
  return {
    dSigma: samples.slice(0, 3).map(sampleStd),
    phiSigma: samples.slice(3).map(sampleStd),
  };
}

export function findParallelograms(peaks, center, options = {}) {
  const tolerance = Number(options.closureTolerance ?? 0.035);
  const maxResults = Math.max(1, options.maxResults ?? 24);
  const minAngle = Number(options.minAngle ?? 8);
  const vectors = peaks.map((peak, index) => ({
    ...peak,
    index,
    vx: peak.x - center.x,
    vy: peak.y - center.y,
  })).filter((p) => Math.hypot(p.vx, p.vy) > (options.minRadius ?? 5));
  const results = [];
  const seen = new Set();
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const a = vectors[i]; const c = vectors[j];
      const angle = vectorAngle([a.vx, a.vy], [c.vx, c.vy]);
      if (!Number.isFinite(angle) || angle < minAngle || angle > 180 - minAngle) continue;
      const tx = a.vx + c.vx; const ty = a.vy + c.vy;
      const targetNorm = Math.max(Math.hypot(tx, ty), Math.hypot(a.vx, a.vy), Math.hypot(c.vx, c.vy), EPS);
      let best = null;
      for (let k = 0; k < vectors.length; k += 1) {
        if (k === i || k === j) continue;
        const q = vectors[k];
        const closure = Math.hypot(q.vx - tx, q.vy - ty) / targetNorm;
        if (!best || closure < best.closure) best = { q, closure };
      }
      if (!best || best.closure > tolerance) continue;
      const key = [Math.min(a.index, c.index), Math.max(a.index, c.index), best.q.index].join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      const intensityBonus = Math.log1p((a.value || 0) + (c.value || 0) + (best.q.value || 0));
      results.push({
        peak1: a,
        peak2: best.q,
        peak3: c,
        closure: best.closure,
        angle13: angle,
        score: best.closure - intensityBonus * 1e-4,
      });
    }
  }
  return results.sort((a, b) => a.score - b.score).slice(0, maxResults);
}

/** Estimate a blocked/saturated SAED centre from Friedel inversion symmetry. */
export function refineInversionCenter(peaks, initialCenter, options = {}) {
  const selected = [...peaks].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, options.maxPeaks ?? 70);
  const maxOffset = Number(options.maxOffset ?? 0.12 * Math.max(options.width || 0, options.height || 0, 100));
  const tolerance = Number(options.tolerance ?? 3.5);
  if (selected.length < 4) return { ...initialCenter, score: 0 };
  const candidates = [{ x: initialCenter.x, y: initialCenter.y }];
  for (let i = 0; i < selected.length; i += 1) for (let j = i + 1; j < selected.length; j += 1) {
    const candidate = { x: (selected[i].x + selected[j].x) / 2, y: (selected[i].y + selected[j].y) / 2 };
    if (Math.hypot(candidate.x - initialCenter.x, candidate.y - initialCenter.y) <= maxOffset) candidates.push(candidate);
  }
  let best = { ...initialCenter, score: -Infinity };
  for (const candidate of candidates) {
    let score = 0;
    for (const peak of selected) {
      const mx = 2 * candidate.x - peak.x; const my = 2 * candidate.y - peak.y;
      let nearest = Infinity;
      for (const other of selected) nearest = Math.min(nearest, Math.hypot(other.x - mx, other.y - my));
      if (nearest <= tolerance) score += 1 - nearest / tolerance;
    }
    score -= Math.hypot(candidate.x - initialCenter.x, candidate.y - initialCenter.y) / Math.max(maxOffset, EPS) * 0.1;
    if (score > best.score) best = { ...candidate, score };
  }
  return best;
}

function fft1d(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wLenR = Math.cos(angle); const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1; let wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const uR = re[i + j]; const uI = im[i + j];
        const vR = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const vI = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = uR + vR; im[i + j] = uI + vI;
        re[i + j + len / 2] = uR - vR; im[i + j + len / 2] = uI - vI;
        [wr, wi] = [wr * wLenR - wi * wLenI, wr * wLenI + wi * wLenR];
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}

export function previousPowerOfTwo(value) {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

function squareCropResample(gray, width, height, size) {
  const out = new Float64Array(size * size);
  const side = Math.min(width, height);
  const x0 = (width - side) / 2; const y0 = (height - side) / 2;
  for (let y = 0; y < size; y += 1) {
    const sy = y0 + ((y + 0.5) * side) / size - 0.5;
    const y1 = clamp(Math.floor(sy), 0, height - 1); const y2 = clamp(y1 + 1, 0, height - 1);
    const fy = sy - Math.floor(sy);
    for (let x = 0; x < size; x += 1) {
      const sx = x0 + ((x + 0.5) * side) / size - 0.5;
      const x1 = clamp(Math.floor(sx), 0, width - 1); const x2 = clamp(x1 + 1, 0, width - 1);
      const fx = sx - Math.floor(sx);
      const top = gray[y1 * width + x1] * (1 - fx) + gray[y1 * width + x2] * fx;
      const bottom = gray[y2 * width + x1] * (1 - fx) + gray[y2 * width + x2] * fx;
      out[y * size + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data: out, side };
}

export function fftMagnitude(gray, width, height, options = {}) {
  const maxSize = previousPowerOfTwo(Math.max(32, options.maxSize ?? 1024));
  const size = Math.min(previousPowerOfTwo(width), previousPowerOfTwo(height), maxSize);
  if (size < 32) throw new Error("图像尺寸过小，无法进行 FFT");
  const { data, side } = squareCropResample(gray, width, height, size);
  let mean = 0;
  for (const value of data) mean += value;
  mean /= data.length;
  const re = new Float64Array(size * size);
  const im = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (size - 1));
    for (let x = 0; x < size; x += 1) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (size - 1));
      re[y * size + x] = (data[y * size + x] - mean) * wx * wy;
    }
  }
  const rowR = new Float64Array(size); const rowI = new Float64Array(size);
  for (let y = 0; y < size; y += 1) {
    rowR.set(re.subarray(y * size, (y + 1) * size));
    rowI.fill(0); fft1d(rowR, rowI);
    re.set(rowR, y * size); im.set(rowI, y * size);
  }
  const colR = new Float64Array(size); const colI = new Float64Array(size);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) { colR[y] = re[y * size + x]; colI[y] = im[y * size + x]; }
    fft1d(colR, colI);
    for (let y = 0; y < size; y += 1) { re[y * size + x] = colR[y]; im[y * size + x] = colI[y]; }
  }
  const magnitude = new Float32Array(size * size);
  let max = 0;
  const half = size >> 1;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const shiftedX = (x + half) % size; const shiftedY = (y + half) % size;
    const value = Math.log1p(Math.hypot(re[y * size + x], im[y * size + x]));
    magnitude[shiftedY * size + shiftedX] = value; if (value > max) max = value;
  }
  if (max > 0) for (let i = 0; i < magnitude.length; i += 1) magnitude[i] /= max;
  return { magnitude, width: size, height: size, sourceSide: side, sourcePixelPerFftPixel: side / size };
}

export function detectPeaks(values, width, height, options = {}) {
  const center = options.center || { x: (width - 1) / 2, y: (height - 1) / 2 };
  const excludeRadius = Number(options.excludeRadius ?? Math.max(7, Math.min(width, height) * 0.015));
  const border = Math.max(2, Math.round(options.border ?? 3));
  let mean = 0; let square = 0; let count = 0;
  for (let y = border; y < height - border; y += 1) for (let x = border; x < width - border; x += 1) {
    if (Math.hypot(x - center.x, y - center.y) < excludeRadius) continue;
    const value = values[y * width + x]; mean += value; square += value * value; count += 1;
  }
  mean /= Math.max(1, count);
  const sigma = Math.sqrt(Math.max(0, square / Math.max(1, count) - mean * mean));
  const threshold = Math.max(Number(options.minValue ?? 0.08), mean + Number(options.sigmaThreshold ?? 3.25) * sigma);
  const peaks = [];
  for (let y = border; y < height - border; y += 1) for (let x = border; x < width - border; x += 1) {
    const value = values[y * width + x];
    if (value < threshold || Math.hypot(x - center.x, y - center.y) < excludeRadius) continue;
    let localMax = true;
    for (let dy = -2; dy <= 2 && localMax; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if ((dx || dy) && values[(y + dy) * width + x + dx] > value) { localMax = false; break; }
    }
    if (!localMax) continue;
    let sum = 0; let sx = 0; let sy = 0;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const weight = Math.max(0, values[(y + dy) * width + x + dx] - mean);
      sum += weight; sx += (x + dx) * weight; sy += (y + dy) * weight;
    }
    peaks.push({ x: sum ? sx / sum : x, y: sum ? sy / sum : y, value, sigma: 0.35 });
  }
  const selected = [];
  for (const peak of peaks.sort((a, b) => b.value - a.value)) {
    if (selected.every((other) => Math.hypot(other.x - peak.x, other.y - peak.y) > (options.minSeparation ?? 5))) {
      selected.push(peak);
      if (selected.length >= (options.maxPeaks ?? 160)) break;
    }
  }
  return selected;
}

export function elementsFromFormula(formula) {
  const cleaned = String(formula || "")
    .replace(/\$[A-Z]+/g, "")
    .replace(/\bD\b/g, "H");
  const elements = cleaned.match(/[A-Z][a-z]?/g) || [];
  return [...new Set(elements)].sort();
}

export function phasePassesElementFilter(phaseElements, filter = {}) {
  const present = new Set(phaseElements || []);
  const required = filter.required || [];
  const excluded = filter.excluded || [];
  const allowed = filter.allowed || [];
  if (filter.logic === "or" && required.length) {
    if (!required.some((element) => present.has(element))) return false;
  } else if (required.some((element) => !present.has(element))) return false;
  if (excluded.some((element) => present.has(element))) return false;
  if (filter.onlyAllowed && allowed.length) {
    const permitted = new Set([...allowed, ...required]);
    if ([...present].some((element) => !permitted.has(element))) return false;
  }
  return true;
}
