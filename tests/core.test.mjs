import assert from "node:assert/strict";
import {
  combineTolerance,
  detectRings,
  detectScaleBar,
  detectPeaks,
  dSpacing,
  elementsFromFormula,
  fftMagnitude,
  findParallelograms,
  hkilToHkl,
  matchCard,
  matchRings,
  measurementFromVectors,
  normalizePlaneIndex,
  planeAngle,
  phasePassesElementFilter,
  refineInversionCenter,
  scoreGlobalPeakFit,
  snapToBrightPoint,
  zoneAxis,
} from "../core.js";

const cubic = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };
assert.ok(Math.abs(dSpacing([1, 0, 0], cubic) - 4) < 1e-10);
assert.ok(Math.abs(dSpacing([1, 1, 0], cubic) - 4 / Math.sqrt(2)) < 1e-10);
assert.ok(Math.abs(planeAngle([1, 0, 0], [1, 1, 0], cubic) - 45) < 1e-10);
assert.deepEqual(zoneAxis([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
assert.deepEqual(elementsFromFormula("Ca(OH)2"), ["Ca", "H", "O"]);
assert.equal(phasePassesElementFilter(["O", "Fe"], { required: ["H", "O"], logic: "and" }), false);
assert.equal(phasePassesElementFilter(["O", "Fe"], { required: ["H", "O"], logic: "or" }), true);
assert.ok(Math.abs(combineTolerance(0.1, 0.03, 2) - Math.hypot(0.1, 0.06)) < 1e-12);
assert.deepEqual(hkilToHkl(1, 0, -1, 2), [1, 0, 2]);
assert.equal(hkilToHkl(1, 0, 0, 2), null);
assert.deepEqual(normalizePlaneIndex({ h: 1, k: 0, i: -1, l: 2 }, "Hexagonal"), [1, 0, 2]);

const scaleImage = new Float32Array(160 * 100).fill(0.15);
for (let x = 92; x <= 142; x += 1) scaleImage[84 * 160 + x] = 1;
const scaleBar = detectScaleBar(scaleImage, 160, 100);
assert.ok(scaleBar && Math.abs(scaleBar.pixelLength - 51) <= 2);

const brightImage = new Float32Array(80 * 60).fill(0.1); brightImage[31 * 80 + 43] = 1;
const snapped = snapToBrightPoint(brightImage, 80, 60, { x: 39, y: 29 }, { radius: 8 });
assert.ok(Math.hypot(snapped.x - 43, snapped.y - 31) < 1);

const vectors = [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const measurement = measurementFromVectors(vectors, 0.025);
assert.ok(Math.abs(measurement.d1 - 4) < 1e-12);
assert.ok(Math.abs(measurement.d2 - 4 / Math.sqrt(2)) < 1e-12);
assert.ok(Math.abs(measurement.phi12 - 45) < 1e-12);

const peaks = [
  { x: 60, y: 50, value: 1 },
  { x: 60, y: 60, value: 1 },
  { x: 50, y: 60, value: 1 },
];
const parallelograms = findParallelograms(peaks, { x: 50, y: 50 }, { closureTolerance: 0.01 });
assert.ok(parallelograms.length >= 1);

const size = 128;
const synthetic = new Float32Array(size * size);
for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
  synthetic[y * size + x] =
    Math.cos(2 * Math.PI * 8 * x / size) +
    Math.cos(2 * Math.PI * 8 * y / size) +
    Math.cos(2 * Math.PI * 8 * (x + y) / size);
}
const fft = fftMagnitude(synthetic, size, size, { maxSize: size });
const fftPeaks = detectPeaks(fft.magnitude, size, size, {
  center: { x: size / 2, y: size / 2 }, sigmaThreshold: 2.5, minValue: 0.05,
});
assert.ok(fftPeaks.length >= 6);
assert.ok(findParallelograms(fftPeaks, { x: size / 2, y: size / 2 }, { closureTolerance: 0.08 }).length > 0);

const inversionPeaks = [
  {x:30,y:40,value:1},{x:74,y:64,value:1},
  {x:44,y:20,value:.8},{x:60,y:84,value:.8},
  {x:20,y:66,value:.7},{x:84,y:38,value:.7},
];
const refined = refineInversionCenter(inversionPeaks, {x:50,y:50}, {width:100,height:100,maxOffset:20,tolerance:1});
assert.ok(Math.hypot(refined.x - 52, refined.y - 52) < 1e-9);

const card = {
  id: "test-cubic",
  name: "cubic fixture",
  formula: "X",
  crystalSystem: "Cubic",
  cell: cubic,
  reflections: [
    { d: 4, h: 1, k: 0, l: 0 },
    { d: 4 / Math.sqrt(2), h: 1, k: 1, l: 0 },
  ],
};
const results = matchCard(card, { ...measurement, dSigma: [0, 0, 0], phiSigma: [0, 0] }, {
  distanceTolerance: 0.01,
  angleTolerance: 0.1,
});
assert.ok(results.length > 0);
assert.equal(results[0].score, 0);

const compactCard = {
  ...card,
  reflections: undefined,
  dValues: Float32Array.from([4, 4 / Math.sqrt(2)]),
  hkls: Int16Array.from([1, 0, 0, 1, 1, 0]),
};
assert.ok(matchCard(compactCard, { ...measurement, dSigma: [0, 0, 0], phiSigma: [0, 0] }, {
  distanceTolerance: 0.01,
  angleTolerance: 0.1,
}).length > 0);

const hexCell = { a: 2.5, b: 2.5, c: 4, alpha: 90, beta: 90, gamma: 120 };
const hexMeasurement = {
  d1: dSpacing([1, 0, 0], hexCell),
  d2: dSpacing([1, 1, 0], hexCell),
  d3: dSpacing([0, 1, 0], hexCell),
  phi12: planeAngle([1, 0, 0], [1, 1, 0], hexCell),
  phi23: planeAngle([1, 1, 0], [0, 1, 0], hexCell),
  dSigma: [0, 0, 0],
  phiSigma: [0, 0],
};
const hexCard = {
  id: "hex-hkil",
  name: "hex hkil fixture",
  formula: "X",
  crystalSystem: "Hexagonal",
  cell: hexCell,
  reflections: [
    { d: hexMeasurement.d1, h: 1, k: 0, i: -1, l: 0 },
    { d: hexMeasurement.d2, h: 1, k: 1, i: -2, l: 0 },
    { d: hexMeasurement.d3, h: 0, k: 1, i: -1, l: 0 },
  ],
};
assert.ok(matchCard(hexCard, hexMeasurement, { distanceTolerance: 0.001, angleTolerance: 0.001 }).length > 0);

const globalScore = scoreGlobalPeakFit(results[0], card, [
  { x: 60, y: 50, value: 1 },
  { x: 50, y: 60, value: 1 },
  { x: 60, y: 60, value: 0.9 },
  { x: 70, y: 50, value: 0.8 },
], { x: 50, y: 50 }, 0.025, {
  basisVectors: [{ x: 10, y: 0 }, { x: 0, y: 10 }],
  distanceTolerance: 0.01,
});
assert.ok(globalScore && globalScore.total >= 3);
assert.equal(globalScore.matched, globalScore.total);

const ringSize = 120;
const ringImage = new Float32Array(ringSize * ringSize).fill(0.04);
const ringCenter = { x: 60, y: 60 };
for (let y = 0; y < ringSize; y += 1) for (let x = 0; x < ringSize; x += 1) {
  const r = Math.hypot(x - ringCenter.x, y - ringCenter.y);
  if (Math.abs(r - 20) < 1.2 || Math.abs(r - 35) < 1.2) ringImage[y * ringSize + x] = 1;
}
const rings = detectRings(ringImage, ringSize, ringSize, ringCenter, 0.025, { sigmaThreshold: 0.6, minRadius: 8, maxRings: 4 });
assert.ok(rings.length >= 2);
assert.ok(Math.abs(rings[0].d - 2) < 0.15);
assert.ok(Math.abs(rings[1].d - (1 / (35 * 0.025))) < 0.15);
const ringCard = {
  id: "ring-card",
  name: "ring fixture",
  formula: "X",
  crystalSystem: "Cubic",
  cell: cubic,
  reflections: [
    { d: rings[0].d, h: 2, k: 0, l: 0 },
    { d: rings[1].d, h: 3, k: 0, l: 0 },
  ],
};
assert.ok(matchRings(ringCard, rings.slice(0, 2), { distanceTolerance: 0.05, minRings: 2 }).length === 1);

console.log("core tests passed");
