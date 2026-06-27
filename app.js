import {
  combineTolerance,
  detectRings,
  detectScaleBar,
  detectPeaks,
  estimateMeasurementUncertainty,
  fftMagnitude,
  findParallelograms,
  matchCard,
  matchRings,
  measurementFromVectors,
  refineInversionCenter,
  scoreGlobalPeakFit,
  snapToBrightPoint,
} from "./core.js";
import { grayToImageData, loadImageFile } from "./image-io.js";
import {
  clearDatabase,
  getDatabaseStats,
  importPdf2Dat,
  parseCif,
  parseJadeTxt,
  queryPhases,
  searchPhaseSummaries,
  savePhases,
} from "./database.js";

const $ = (id) => document.getElementById(id);
const state = {
  image: null, pattern: null, peaks: [], center: null, parallelograms: [], selected: null,
  rings: [], pickMode: null, picked: [], dSigma: [0, 0, 0], phiSigma: [0, 0], results: [],
  elementStates: new Map(), reciprocalScale: null, scaleLine: null, roi: null, prefiltered: 0,
  inputTransform: null, inputDrag: null, patternDrag: null, centerLocked: false,
  brightness: 0, contrast: 1, inputView: null, patternView: null, inputMode: null, patternMode: null,
  roiShape: "rectangle", snapBright: false, sharpness: 0, ringEdit: false, ringEditAction: null, selectedRing: null,
};

function toast(message, error = false) {
  const element = $("toast"); element.textContent = message; element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.className = "toast"; }, 3600);
}

function status(message) { $("globalStatus").textContent = message; }
function number(id) { return Number($(id).value); }
function fmt(value, digits = 4) { return Number.isFinite(value) ? value.toFixed(digits) : "—"; }
function hkl(value) { return `(${value.join(" ")})`; }

async function refreshDatabaseStats() {
  const stats = await getDatabaseStats();
  $("dbBadge").textContent = `${stats.phases.toLocaleString()} 相`;
  $("dbBadge").classList.toggle("active", stats.phases > 0);
  if (stats.sources.length) {
    const latest = stats.sources.sort((a, b) => b.importedAt - a.importedAt)[0];
    $("dbInfo").textContent = `${stats.sources.length} 个数据源；最近导入 ${latest.name}${latest.cards ? `，${latest.cards.toLocaleString()} 张卡片` : ""}；保存于 Sand3/database/sand3.sqlite`;
  } else $("dbInfo").textContent = "持久数据库：Sand3/database/sand3.sqlite；导入一次，后续启动直接调用。";
}

function drawGray(context, gray, width, height, x, y, drawWidth, drawHeight, options = {}) {
  const adjusted = new Float32Array(gray.length); const brightness = Number(options.brightness || 0); const contrast = Number(options.contrast ?? 1);
  for (let i = 0; i < gray.length; i += 1) adjusted[i] = Math.max(0, Math.min(1, (gray[i] - 0.5) * contrast + 0.5 + brightness));
  const sharpness = Math.max(0, Number(options.sharpness || 0));
  if (sharpness > 0 && width > 2 && height > 2) {
    const source = new Float32Array(adjusted);
    for (let yy = 1; yy < height - 1; yy += 1) for (let xx = 1; xx < width - 1; xx += 1) {
      const index = yy * width + xx;
      const blur = (source[index - 1] + source[index + 1] + source[index - width] + source[index + width]) * 0.25;
      adjusted[index] = Math.max(0, Math.min(1, source[index] + (source[index] - blur) * sharpness));
    }
  }
  const temp = document.createElement("canvas"); temp.width = width; temp.height = height;
  temp.getContext("2d").putImageData(grayToImageData(adjusted, width, height, { gamma: options.gamma ?? 1 }), 0, 0);
  const source = options.source;
  if (source) context.drawImage(temp, source.x, source.y, source.width, source.height, x, y, drawWidth, drawHeight);
  else context.drawImage(temp, x, y, drawWidth, drawHeight);
}

function fullView(image) { return { x: 0, y: 0, width: image.width, height: image.height }; }
function normalizedSelection(start, end, square = false) {
  let width = Math.abs(end.x - start.x); let height = Math.abs(end.y - start.y);
  if (square) width = height = Math.min(width, height);
  return { x: end.x >= start.x ? start.x : start.x - width, y: end.y >= start.y ? start.y : start.y - height, width, height };
}
function clampView(view, image, minimum = 12) {
  const width = Math.max(minimum, Math.min(image.width, view.width)); const height = Math.max(minimum, Math.min(image.height, view.height));
  return { x: Math.max(0, Math.min(image.width - width, view.x)), y: Math.max(0, Math.min(image.height - height, view.y)), width, height };
}

function physicalLabel() { return `${$("scaleValue").value || "?"} ${$("scaleUnit").selectedOptions[0]?.textContent || ""}`; }

function updateCalibrationFromScale() {
  if (!state.scaleLine) return;
  const pixels = Math.hypot(state.scaleLine.b.x - state.scaleLine.a.x, state.scaleLine.b.y - state.scaleLine.a.y);
  const value = number("scaleValue"); const unit = $("scaleUnit").value; const mode = $("imageMode").value;
  let physical;
  if (mode === "hrtem") physical = unit === "nm" ? value * 10 : unit === "pm" ? value / 100 : unit === "angstrom" ? value : NaN;
  else physical = unit === "1/nm" ? value / 10 : unit === "1/angstrom" ? value : NaN;
  const calibration = physical / Math.max(pixels, 1e-12);
  $("calibration").value = Number.isFinite(calibration) && calibration > 0 ? calibration.toPrecision(7) : "";
  $("scaleStatus").textContent = Number.isFinite(calibration) && calibration > 0
    ? `标尺 ${pixels.toFixed(1)} px · ${calibration.toPrecision(5)} ${mode === "hrtem" ? "Å/pixel" : "Å⁻¹/pixel"}`
    : "标尺单位与图像类型不匹配，请修正";
  drawInputImage();
}

function setScaleFromImage() {
  const candidate = detectScaleBar(state.image.gray, state.image.width, state.image.height);
  const detected = candidate?.confidence >= 0.12 ? candidate : null;
  state.scaleLine = detected || {
    a: { x: state.image.width * 0.66, y: state.image.height * 0.88 },
    b: { x: state.image.width * 0.9, y: state.image.height * 0.88 }, confidence: 0,
  };
  const pixels = Math.hypot(state.scaleLine.b.x - state.scaleLine.a.x, state.scaleLine.b.y - state.scaleLine.a.y);
  const mode = $("imageMode").value; const calibration = state.image.calibration;
  if (mode === "hrtem") {
    $("scaleUnit").value = "nm";
    $("scaleValue").value = calibration?.pixelSizeAngstrom ? (pixels * calibration.pixelSizeAngstrom / 10).toPrecision(5) : 1;
  } else {
    $("scaleUnit").value = "1/nm";
    $("scaleValue").value = calibration?.reciprocalPerPixelAngstrom ? (pixels * calibration.reciprocalPerPixelAngstrom * 10).toPrecision(5) : 1;
  }
  const description = state.image.metadata?.description || "";
  const textScale = description.match(/scale\s*bar[^0-9]*([0-9.]+)\s*(nm|pm|angstrom|å|1\s*\/\s*nm|nm\s*[-^]?1)/i);
  if (textScale) {
    $("scaleValue").value = textScale[1];
    const unit = textScale[2].toLowerCase();
    $("scaleUnit").value = /1|\^-?1|-1/.test(unit) ? "1/nm" : unit === "nm" ? "nm" : unit === "pm" ? "pm" : "angstrom";
  }
  const side = Math.min(state.image.width, state.image.height) * 0.72;
  if (!state.roi) state.roi = { x: (state.image.width - side) / 2, y: (state.image.height - side) / 2, width: side, height: side };
  updateCalibrationFromScale();
  $("scaleStatus").textContent += detected ? ` · 自动定位置信度 ${Math.round(detected.confidence * 100)}%` : " · 未可靠定位，请拖动端点";
}

function inferImageMode(image) {
  let mean = 0; let bright = 0;
  const step = Math.max(1, Math.floor(image.gray.length / 120000)); let count = 0;
  for (let i = 0; i < image.gray.length; i += step) { mean += image.gray[i]; if (image.gray[i] > 0.78) bright += 1; count += 1; }
  mean /= Math.max(1, count); bright /= Math.max(1, count);
  return mean < 0.28 && bright < 0.12 ? "saed" : "hrtem";
}

async function recognizeScaleText() {
  if (!("TextDetector" in globalThis) || !state.image) return false;
  try {
    const canvas = document.createElement("canvas"); canvas.width = state.image.width; canvas.height = state.image.height;
    canvas.getContext("2d").putImageData(grayToImageData(state.image.gray, state.image.width, state.image.height), 0, 0);
    const blocks = await new TextDetector().detect(canvas);
    const text = blocks.map((block) => block.rawValue || "").join(" ");
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(nm|pm|å|angstrom|nm\s*[-^]?1|1\s*\/\s*nm|å\s*[-^]?1)/i);
    if (!match) return false;
    $("scaleValue").value = match[1]; const unit = match[2].toLowerCase();
    $("scaleUnit").value = /1\s*\/|-1|\^-?1/.test(unit) ? (unit.includes("nm") ? "1/nm" : "1/angstrom") : unit === "nm" ? "nm" : unit === "pm" ? "pm" : "angstrom";
    updateCalibrationFromScale(); $("scaleStatus").textContent += " · 已识别标尺文字"; return true;
  } catch { return false; }
}

function drawInputImage() {
  if (!state.image) return;
  const canvas = $("inputCanvas"); const wrap = $("inputCanvasWrap"); const ratio = window.devicePixelRatio || 1;
  const cssWidth = Math.max(280, wrap.clientWidth); const cssHeight = 330;
  canvas.width = cssWidth * ratio; canvas.height = cssHeight * ratio;
  const context = canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const view = state.inputView || fullView(state.image);
  const scale = Math.min(cssWidth / view.width, cssHeight / view.height);
  const width = view.width * scale; const height = view.height * scale; const ox = (cssWidth - width) / 2; const oy = (cssHeight - height) / 2;
  state.inputTransform = { scale, ox, oy, view };
  context.fillStyle = "#071313"; context.fillRect(0, 0, cssWidth, cssHeight);
  drawGray(context, state.image.gray, state.image.width, state.image.height, ox, oy, width, height, { source: view });
  const map = (point) => ({ x: ox + (point.x - view.x) * scale, y: oy + (point.y - view.y) * scale });
  if (state.roi && $("imageMode").value === "hrtem") {
    context.strokeStyle = "#4fd2ca"; context.lineWidth = 1.5; context.setLineDash([6, 4]);
    const roiPoint = map(state.roi); context.strokeRect(roiPoint.x, roiPoint.y, state.roi.width * scale, state.roi.height * scale); context.setLineDash([]);
    context.fillStyle = "#4fd2ca"; context.font = "700 10px system-ui"; context.fillText("FFT ROI", roiPoint.x + 5, roiPoint.y + 14);
  }
  if (state.scaleLine) {
    const a = map(state.scaleLine.a); const b = map(state.scaleLine.b);
    context.strokeStyle = "#ffd06a"; context.fillStyle = "#ffd06a"; context.lineWidth = 2.5;
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    for (const p of [a, b]) { context.beginPath(); context.arc(p.x, p.y, 6, 0, Math.PI * 2); context.fill(); context.strokeStyle = "#173332"; context.lineWidth = 1; context.stroke(); }
    const label = physicalLabel(); context.font = "700 11px system-ui"; const labelWidth = context.measureText(label).width + 14;
    const x = (a.x + b.x - labelWidth) / 2; const y = Math.min(a.y, b.y) - 28;
    context.fillStyle = "rgba(9,32,32,.42)"; context.fillRect(x, y, labelWidth, 20); context.fillStyle = "rgba(255,243,202,.9)"; context.fillText(label, x + 7, y + 14);
  }
  if (state.inputSelection) {
    const p = map(state.inputSelection); context.strokeStyle = "#ffffff"; context.setLineDash([5, 3]); context.lineWidth = 1.5;
    context.strokeRect(p.x, p.y, state.inputSelection.width * scale, state.inputSelection.height * scale); context.setLineDash([]);
  }
}

function inputPoint(event) {
  const rect = $("inputCanvas").getBoundingClientRect(); const t = state.inputTransform;
  return { x: t.view.x + ((event.clientX - rect.left) - t.ox) / t.scale, y: t.view.y + ((event.clientY - rect.top) - t.oy) / t.scale };
}

function cropImage(image, roi) {
  const x0 = Math.max(0, Math.floor(roi.x)); const y0 = Math.max(0, Math.floor(roi.y));
  const width = Math.max(32, Math.min(image.width - x0, Math.round(roi.width))); const height = Math.max(32, Math.min(image.height - y0, Math.round(roi.height)));
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) gray.set(image.gray.subarray((y0 + y) * image.width + x0, (y0 + y) * image.width + x0 + width), y * width);
  return { width, height, gray };
}

function drawPattern() {
  if (!state.pattern) return;
  const canvas = $("patternCanvas"); const wrap = $("canvasWrap");
  const cssWidth = Math.max(300, wrap.clientWidth); const cssHeight = cssWidth;
  const ratio = window.devicePixelRatio || 1; canvas.width = cssWidth * ratio; canvas.height = cssHeight * ratio;
  const context = canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const view = state.patternView || fullView(state.pattern);
  const scale = Math.min(cssWidth / view.width, cssHeight / view.height);
  const drawW = view.width * scale; const drawH = view.height * scale; const ox = (cssWidth - drawW) / 2; const oy = (cssHeight - drawH) / 2;
  state.canvasTransform = { scale, ox, oy, cssWidth, cssHeight, view };
  context.fillStyle = "#071313"; context.fillRect(0, 0, cssWidth, cssHeight);
  drawGray(context, state.pattern.gray, state.pattern.width, state.pattern.height, ox, oy, drawW, drawH, { gamma: 0.7, brightness: state.brightness, contrast: state.contrast, sharpness: state.sharpness, source: view });
  const map = (point) => ({ x: ox + (point.x - view.x) * scale, y: oy + (point.y - view.y) * scale });
  if (state.center) {
    const { x, y } = map(state.center);
    context.strokeStyle = "white"; context.lineWidth = 1.5; context.beginPath(); context.moveTo(x - 7, y); context.lineTo(x + 7, y); context.moveTo(x, y - 7); context.lineTo(x, y + 7); context.stroke();
  }
  if (state.center && state.rings?.length) {
    const centerPoint = map(state.center);
    state.rings.slice(0, 8).forEach((ring, index) => {
      const selected = index === state.selectedRing;
      context.strokeStyle = selected ? "rgba(142,239,255,.98)" : "rgba(101,216,255,.7)";
      context.fillStyle = selected ? "rgba(142,239,255,.98)" : "rgba(101,216,255,.88)";
      context.lineWidth = selected ? 2.2 : 1.2; context.font = "700 10px system-ui";
      context.beginPath(); context.arc(centerPoint.x, centerPoint.y, ring.radius * scale, 0, Math.PI * 2); context.stroke();
      context.fillText(`R${index + 1} ${fmt(ring.d, 3)}Å`, centerPoint.x + ring.radius * scale + 4, centerPoint.y - 4);
    });
  }
  if (state.selected && state.center) {
    const colors = ["#ffd06a", "#ff9c42", "#ffd06a"];
    const points = state.selected.map(map); const centerPoint = map(state.center);
    context.strokeStyle = "rgba(255,208,106,.72)"; context.lineWidth = 1.5; context.beginPath();
    context.moveTo(centerPoint.x, centerPoint.y); context.lineTo(points[0].x, points[0].y); context.lineTo(points[1].x, points[1].y); context.lineTo(points[2].x, points[2].y); context.closePath(); context.stroke();
    state.selected.forEach((peak, index) => {
      const { x: cx, y: cy } = centerPoint; const { x, y } = map(peak);
      context.strokeStyle = colors[index]; context.fillStyle = colors[index]; context.lineWidth = 2;
      context.beginPath(); context.moveTo(cx, cy); context.lineTo(x, y); context.stroke();
      context.beginPath(); context.arc(x, y, 7, 0, Math.PI * 2); context.fillStyle = "rgba(7,19,19,.55)"; context.fill(); context.stroke();
      context.fillStyle = colors[index]; context.font = "bold 12px system-ui"; context.fillText(`g${index + 1}`, x + 8, y - 7);
    });
  }
  if (state.patternSelection) {
    const p = map(state.patternSelection); context.strokeStyle = "white"; context.setLineDash([5, 3]);
    context.strokeRect(p.x, p.y, state.patternSelection.width * scale, state.patternSelection.height * scale); context.setLineDash([]);
  }
}

function canvasPoint(event) {
  const rect = $("patternCanvas").getBoundingClientRect(); const t = state.canvasTransform;
  return { x: t.view.x + ((event.clientX - rect.left) - t.ox) / t.scale, y: t.view.y + ((event.clientY - rect.top) - t.oy) / t.scale };
}

function nearestPeak(point) {
  return state.peaks.reduce((best, peak) => {
    const distance = Math.hypot(peak.x - point.x, peak.y - point.y);
    return !best || distance < best.distance ? { peak, distance } : best;
  }, null);
}

function maybeSnapPattern(point) {
  if (!state.snapBright || !state.pattern) return point;
  const radius = Math.max(3, Math.min(24, 14 / Math.max(0.2, state.canvasTransform?.scale || 1)));
  return snapToBrightPoint(state.pattern.gray, state.pattern.width, state.pattern.height, point, { radius });
}

function ringFromRadius(radius, extra = {}) {
  const value = Math.max(3, Number(radius) || 3);
  const d = state.reciprocalScale > 0 ? 1 / (value * state.reciprocalScale) : NaN;
  return { value: 1, profileScore: 0, manual: true, ...extra, radius: value, d, dSigma: Number.isFinite(d) ? d / value : 0 };
}

function updateRingRadius(index, radius) {
  if (index == null || !state.rings[index]) return;
  state.rings[index] = { ...state.rings[index], ...ringFromRadius(radius, state.rings[index]) };
}

function nearestRing(point) {
  if (!state.center || !state.rings.length) return null;
  const radius = Math.hypot(point.x - state.center.x, point.y - state.center.y);
  const scale = state.canvasTransform?.scale || 1;
  let best = null;
  state.rings.forEach((ring, index) => {
    const delta = Math.abs(ring.radius - radius);
    if (!best || delta < best.delta) best = { index, ring, delta, radius };
  });
  return best && best.delta * scale <= 12 ? best : null;
}

function ringStatus(prefix = "环手动模式") {
  $("geometryStatus").textContent = state.rings.length
    ? `${prefix} · ${state.rings.length} 条环：${state.rings.slice(0, 5).map((ring) => `${fmt(ring.d, 3)} Å`).join(" / ")}`
    : `${prefix} · 当前无衍射环`;
}

function setRingEdit(enabled) {
  state.ringEdit = enabled;
  state.ringEditAction = null;
  $("ringEdit").textContent = `环手动：${enabled ? "开" : "关"}`;
  $("ringEdit").classList.toggle("active", enabled);
  $("addRing").disabled = !enabled || !state.pattern;
  $("deleteRing").disabled = !enabled || !state.pattern;
  if (enabled) {
    state.pickMode = null; state.patternMode = null;
    ringStatus("环手动模式：拖动环改半径，拖动 000 改中心");
  } else {
    ringStatus("环手动模式关闭");
  }
  drawPattern();
}

function addManualRingAt(point) {
  if (!state.center) return false;
  const radius = Math.hypot(point.x - state.center.x, point.y - state.center.y);
  if (radius < 4) return false;
  state.rings.push(ringFromRadius(radius));
  state.rings.sort((a, b) => a.radius - b.radius);
  state.selectedRing = state.rings.findIndex((ring) => Math.abs(ring.radius - radius) < 1e-6);
  ringStatus("已添加衍射环");
  drawPattern();
  return true;
}

function deleteRing(index = state.selectedRing) {
  if (index == null || !state.rings[index]) return false;
  state.rings.splice(index, 1);
  state.selectedRing = state.rings.length ? Math.min(index, state.rings.length - 1) : null;
  ringStatus("已删除衍射环");
  drawPattern();
  return true;
}

function updateMeasurement(selected, quick = false) {
  state.selected = selected;
  const vectors = selected.map((peak) => ({ x: peak.x - state.center.x, y: peak.y - state.center.y }));
  const measurement = measurementFromVectors(vectors, state.reciprocalScale);
  const scaleSigmaInput = number("calibrationSigma");
  const scaleSigma = $("imageMode").value === "saed"
    ? scaleSigmaInput * (state.pattern?.sourcePixelPerPatternPixel || 1)
    : state.reciprocalScale * (scaleSigmaInput / Math.max(number("calibration"), 1e-12));
  if (!quick) {
    const uncertainty = estimateMeasurementUncertainty(vectors, state.reciprocalScale, {
      peakSigma: selected.map((peak) => peak.sigma || 0.35), centerSigma: 0.25, scaleSigma, iterations: 1200,
    });
    state.dSigma = uncertainty.dSigma; state.phiSigma = uncertainty.phiSigma;
  }
  ["d1", "d2", "d3"].forEach((id, i) => { $(id).value = measurement[id].toFixed(5); });
  $("phi12").value = measurement.phi12.toFixed(4); $("phi23").value = measurement.phi23.toFixed(4);
  if (!quick) $("uncertaintyReadout").textContent = `自动测量不确定度（1σ）：d = ${state.dSigma.map((x) => fmt(x, 4)).join(" / ")} Å；φ = ${state.phiSigma.map((x) => fmt(x, 3)).join(" / ")}°`;
  drawPattern();
}

function setCurrentGeometry(candidate) {
  if (!candidate) return;
  state.parallelograms = [candidate];
  updateMeasurement([candidate.peak1, candidate.peak2, candidate.peak3]);
  $("geometryStatus").textContent = `当前一组 · 闭合 ${(candidate.closure * 100).toFixed(2)}%`;
}

function identifyCurrentGeometry() {
  const candidate = findParallelograms(state.peaks, state.center, { closureTolerance: 0.045, maxResults: 1 })[0];
  if (!candidate) { $("geometryStatus").textContent = "未找到闭合几何，可手动选择三点"; state.selected = null; drawPattern(); return false; }
  setCurrentGeometry(candidate); return true;
}

function clearCurrentGeometry() {
  state.selected = null; state.parallelograms = []; state.pickMode = null; state.picked = [];
  state.dSigma = [0, 0, 0]; state.phiSigma = [0, 0];
  ["d1", "d2", "d3", "phi12", "phi23"].forEach((id) => { $(id).value = "0"; });
  $("uncertaintyReadout").textContent = "自动测量不确定度：等待选点";
  $("geometryStatus").textContent = "已删除当前平行四边形";
  drawPattern();
}

function detectCurrentRings(showToast = true) {
  if (!state.pattern || !state.center) throw new Error("请先生成 / 载入 SAED 几何图");
  if ($("imageMode").value !== "saed") throw new Error("SAED 环匹配只用于选区电子衍射原图");
  state.rings = detectRings(state.pattern.gray, state.pattern.width, state.pattern.height, state.center, state.reciprocalScale, {
    sigmaThreshold: Math.max(0.8, number("peakThreshold") * 0.35), maxRings: 12,
    minRadius: Math.max(10, Math.min(state.pattern.width, state.pattern.height) * 0.025),
  });
  state.selectedRing = null; state.ringEditAction = null;
  $("geometryStatus").textContent = state.rings.length
    ? `已识别 ${state.rings.length} 条 SAED 环：${state.rings.slice(0, 5).map((ring) => `${fmt(ring.d, 3)} Å`).join(" / ")}`
    : "未识别到可靠 SAED 环";
  drawPattern();
  if (showToast) toast(state.rings.length ? `已识别 ${state.rings.length} 条 SAED 环` : "未识别到可靠 SAED 环", !state.rings.length);
  return state.rings;
}

function resampleForSaed(image, maxSize = 1200) {
  const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
  if (ratio === 1) return { ...image, sourcePixelPerPatternPixel: 1 };
  const width = Math.round(image.width * ratio); const height = Math.round(image.height * ratio); const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    gray[y * width + x] = image.gray[Math.min(image.height - 1, Math.floor(y / ratio)) * image.width + Math.min(image.width - 1, Math.floor(x / ratio))];
  }
  return { ...image, width, height, gray, sourcePixelPerPatternPixel: 1 / ratio };
}

async function analyzeImage() {
  if (!state.image) return;
  try {
    status("正在分析图像…"); $("analyzeImage").disabled = true;
    const mode = $("imageMode").value; const calibration = number("calibration");
    if (!(calibration > 0)) throw new Error("请填写有效的图像标定");
    if (mode === "hrtem") {
      if (!state.roi) throw new Error("请先在输入图上框选 FFT ROI");
      const roiImage = cropImage(state.image, state.roi);
      const fft = fftMagnitude(roiImage.gray, roiImage.width, roiImage.height, { maxSize: 1024 });
      state.pattern = { gray: fft.magnitude, width: fft.width, height: fft.height };
      state.center = { x: fft.width / 2, y: fft.height / 2 };
      state.reciprocalScale = 1 / (fft.sourceSide * calibration);
    } else {
      const pattern = resampleForSaed(state.image);
      state.pattern = pattern; state.center = { x: (pattern.width - 1) / 2, y: (pattern.height - 1) / 2 };
      state.reciprocalScale = calibration * pattern.sourcePixelPerPatternPixel;
    }
    state.peaks = detectPeaks(state.pattern.gray, state.pattern.width, state.pattern.height, {
      center: state.center, sigmaThreshold: number("peakThreshold"), maxPeaks: 160,
    });
    if (mode === "saed") {
      state.center = refineInversionCenter(state.peaks, state.center, {
        width: state.pattern.width, height: state.pattern.height, tolerance: 4, maxOffset: Math.min(state.pattern.width, state.pattern.height) * 0.12,
      });
      state.peaks = detectPeaks(state.pattern.gray, state.pattern.width, state.pattern.height, {
        center: state.center, sigmaThreshold: number("peakThreshold"), maxPeaks: 160,
      });
    }
    state.parallelograms = []; state.rings = []; state.selectedRing = null; state.ringEdit = false; state.ringEditAction = null; state.patternView = null;
    state.selected = null; state.centerLocked = false; $("lockCenter").textContent = "固定 000";
    $("ringEdit").textContent = "环手动：关"; $("ringEdit").classList.remove("active");
    $("canvasEmpty").classList.add("hidden");
    for (const id of ["lockCenter", "snapBright", "findParallelogram", "pickPeaks", "clearParallelogram", "zoomPattern", "zoomPatternOut"]) $(id).disabled = false;
    const ringEnabled = mode === "saed";
    $("detectRings").disabled = !ringEnabled;
    $("ringEdit").disabled = !ringEnabled;
    $("addRing").disabled = true;
    $("deleteRing").disabled = true;
    $("geometryStatus").textContent = "等待识别当前一组或手动选择三点"; drawPattern();
    status(`检测到 ${state.peaks.length} 个峰`); toast(`已检测 ${state.peaks.length} 个亮点，请识别当前平行四边形`);
  } catch (error) { status("分析失败"); toast(error.message, true); }
  finally { $("analyzeImage").disabled = false; }
}

async function onImageFile(file) {
  if (!file) return;
  try {
    status("正在读取图像…"); state.image = await loadImageFile(file); state.roi = null; state.rings = []; state.inputView = null; state.patternView = null; state.inputMode = null; state.patternMode = null;
    $("imageBadge").textContent = `${state.image.format} · ${state.image.width}×${state.image.height}`; $("imageBadge").classList.add("active");
    if (state.image.calibration?.suggestedMode) $("imageMode").value = state.image.calibration.suggestedMode;
    else $("imageMode").value = inferImageMode(state.image);
    $("imageMetadata").textContent = `${file.name}；${state.image.metadata.bits ? `${state.image.metadata.bits}-bit；` : ""}尺寸 ${state.image.width} × ${state.image.height}`;
    if (state.image.calibration?.pixelSizeAngstrom) {
      $("imageMode").value = "hrtem"; updateCalibrationLabels();
      $("imageMetadata").textContent += `；已读取标定 ${state.image.calibration.pixelSizeAngstrom} Å/pixel`;
    } else if (state.image.calibration?.reciprocalPerPixelAngstrom) {
      $("imageMode").value = "saed"; updateCalibrationLabels();
      $("imageMetadata").textContent += `；已读取倒易标定 ${state.image.calibration.reciprocalPerPixelAngstrom} Å⁻¹/pixel`;
    }
    $("imageDropZone").classList.add("hidden"); $("inputCanvasSection").classList.remove("hidden");
    setScaleFromImage(); await recognizeScaleText(); drawInputImage(); $("analyzeImage").disabled = false; status("图像与标尺已载入，请核对标尺和 ROI");
  } catch (error) { state.image = null; $("analyzeImage").disabled = true; status("图像读取失败"); toast(error.message, true); }
}

function updateCalibrationLabels() {
  const saed = $("imageMode").value === "saed";
  $("calibrationLabel").firstChild.textContent = saed ? "倒易标定（Å⁻¹/pixel）\n" : "实空间像素尺寸（Å/pixel）\n";
  $("calibrationSigmaLabel").firstChild.textContent = saed ? "倒易标定不确定度（Å⁻¹/pixel）\n" : "像素尺寸不确定度（Å/pixel）\n";
  $("selectRoi").classList.toggle("hidden", saed);
  $("roiShape").closest("label").classList.toggle("hidden", saed);
  if (state.image) {
    const reciprocalUnit = ["1/nm", "1/angstrom"].includes($("scaleUnit").value);
    if (saed !== reciprocalUnit) $("scaleUnit").value = saed ? "1/nm" : "nm";
    updateCalibrationFromScale();
  }
}

const periodicRows = [
  ["H",...Array(16).fill(""),"He"],
  ["Li","Be",...Array(10).fill(""),"B","C","N","O","F","Ne"],
  ["Na","Mg",...Array(10).fill(""),"Al","Si","P","S","Cl","Ar"],
  ["K","Ca","Sc","Ti","V","Cr","Mn","Fe","Co","Ni","Cu","Zn","Ga","Ge","As","Se","Br","Kr"],
  ["Rb","Sr","Y","Zr","Nb","Mo","Tc","Ru","Rh","Pd","Ag","Cd","In","Sn","Sb","Te","I","Xe"],
  ["Cs","Ba","La","Hf","Ta","W","Re","Os","Ir","Pt","Au","Hg","Tl","Pb","Bi","Po","At","Rn"],
  ["Fr","Ra","Ac","Rf","Db","Sg","Bh","Hs","Mt","Ds","Rg","Cn","Nh","Fl","Mc","Lv","Ts","Og"],
  ["","","Ce","Pr","Nd","Pm","Sm","Eu","Gd","Tb","Dy","Ho","Er","Tm","Yb","Lu","",""],
  ["","","Th","Pa","U","Np","Pu","Am","Cm","Bk","Cf","Es","Fm","Md","No","Lr","",""]
];

function renderElements() {
  const grid = $("elementGrid"); grid.replaceChildren();
  for (const row of periodicRows) for (const symbol of row) {
    const button = document.createElement("button"); button.className = symbol ? "element" : "element placeholder"; button.textContent = symbol;
    if (symbol) button.addEventListener("click", () => {
      const current = state.elementStates.get(symbol) || "neutral";
      state.elementStates.set(symbol, current === "neutral" ? "required" : current === "required" ? "excluded" : "neutral");
      updateElementUI();
    });
    grid.append(button);
  }
}

function updateElementUI() {
  $("elementGrid").querySelectorAll(".element:not(.placeholder)").forEach((button) => {
    const value = state.elementStates.get(button.textContent) || "neutral"; button.classList.toggle("required", value === "required"); button.classList.toggle("excluded", value === "excluded");
  });
  const filter = elementFilter();
  $("elementSummary").textContent = filter.required.length || filter.excluded.length
    ? `${filter.logic === "or" ? "包含任一" : "必须全部包含"}：${filter.required.join("、") || "无"}；排除：${filter.excluded.join("、") || "无"}` : "未设置元素限制";
}

function elementFilter() {
  const required = []; const excluded = [];
  for (const [element, value] of state.elementStates) { if (value === "required") required.push(element); if (value === "excluded") excluded.push(element); }
  return { required, excluded, allowed: required, onlyAllowed: $("onlyAllowed").checked, logic: $("elementLogic").value };
}

async function importDat(file) {
  if (!file) return;
  const progress = $("importProgress"); progress.classList.remove("hidden"); status("正在建立 PDF2 索引…");
  try {
    const result = await importPdf2Dat(file, { onProgress(info) {
      if (Number.isFinite(info.ratio)) $("importProgressBar").style.width = `${(info.ratio * 100).toFixed(1)}%`;
      $("dbInfo").textContent = `正在写入 Sand3/database：${((info.ratio || 0) * 100).toFixed(1)}%`;
    }});
    toast(result.skipped ? "该 PDF2.DAT 已建立索引" : `已导入 ${result.cards.toLocaleString()} 张 PDF 卡片`);
    await refreshDatabaseStats(); status("数据库就绪");
  } catch (error) { status("数据库导入失败"); toast(error.message, true); }
  finally { progress.classList.add("hidden"); }
}

async function importPhaseFiles(files) {
  const phases = []; const errors = [];
  for (const file of files) {
    try { const text = await file.text(); phases.push(/\.cif$/i.test(file.name) ? parseCif(text, file.name) : parseJadeTxt(text, file.name)); }
    catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  if (phases.length) {
    await savePhases(phases, { fingerprint: `files:${Date.now()}`, name: `${phases.length} 个 CIF/TXT`, size: 0, lastModified: Date.now(), importedAt: Date.now(), cards: phases.length });
    await refreshDatabaseStats(); toast(`成功加入 ${phases.length} 个晶相`);
  }
  if (errors.length) toast(errors.slice(0, 3).join("；"), true);
}

async function searchCards() {
  const panel = $("priorResults"); const list = $("priorList"); panel.classList.remove("hidden");
  list.innerHTML = '<div class="prior-empty">正在筛选卡片摘要…</div>'; $("searchCards").disabled = true;
  try {
    const filter = { ...elementFilter(), statuses: $("includeDeleted").checked ? ["P", "A", "D", "CIF", "TXT"] : ["P", "A", "CIF", "TXT"] };
    const phases = await searchPhaseSummaries(filter, 150); list.replaceChildren();
    $("priorResultCount").textContent = `${phases.length} 条${phases.length === 150 ? "（已限制）" : ""}`;
    if (!phases.length) { list.innerHTML = '<div class="prior-empty">没有满足当前元素条件的 PDF / CIF 卡片</div>'; return; }
    for (const phase of phases) {
      const row = document.createElement("div"); row.className = "prior-card";
      const title = document.createElement("div"); const name = document.createElement("strong"); name.textContent = phase.pdfNumber || phase.name || phase.id;
      const sub = document.createElement("small"); sub.textContent = `${phase.status} · ${phase.sourceType || "卡片"} · ${phase.formula || phase.elements.join(" ") || "无化学式"}`;
      title.append(name, sub);
      const summary = document.createElement("p");
      const cell = phase.cell ? `a/b/c ${[phase.cell.a, phase.cell.b, phase.cell.c].map((v) => fmt(v, 3)).join(" / ")} Å` : "无晶胞摘要";
      summary.textContent = `${phase.name || "未命名"}；${phase.crystalSystem || "未知晶系"}${phase.spaceGroup ? `；${phase.spaceGroup}` : ""}；${cell}`;
      row.append(title, summary); list.append(row);
    }
  } catch (error) { const message = document.createElement("div"); message.className = "prior-empty"; message.textContent = error.message; list.replaceChildren(message); toast(error.message, true); }
  finally { $("searchCards").disabled = false; }
}

function getMeasurement() {
  return { d1: number("d1"), d2: number("d2"), d3: number("d3"), phi12: number("phi12"), phi23: number("phi23"), dSigma: state.dSigma, phiSigma: state.phiSigma };
}

function matchOptions() {
  return {
    distanceTolerance: number("distanceTolerance"), angleTolerance: number("angleTolerance"), sigmaMultiplier: number("sigmaMultiplier"),
    toleranceMethod: $("toleranceMethod").value, diffractionOrder: number("diffractionOrder"), maxResults: 40,
  };
}

function addGlobalScore(result, phase, options) {
  if (!state.selected || !state.center || !state.peaks.length) return { ...result, phase, rankingScore: result.score };
  const basisVectors = [
    { x: state.selected[0].x - state.center.x, y: state.selected[0].y - state.center.y },
    { x: state.selected[2].x - state.center.x, y: state.selected[2].y - state.center.y },
  ];
  const global = scoreGlobalPeakFit(result, phase, state.peaks, state.center, state.reciprocalScale, {
    basisVectors, distanceTolerance: options.distanceTolerance, maxOrder: 5, maxPeaks: 36,
  });
  const rankingScore = result.score + (global ? global.score * 0.35 : 0);
  return { ...result, phase, globalScore: global?.score ?? null, globalMatched: global?.matched ?? 0, globalTotal: global?.total ?? 0, globalMeanResidual: global?.meanResidual ?? null, rankingScore };
}

async function runThreePlaneMatch() {
  const measurement = getMeasurement();
  if ([measurement.d1, measurement.d2, measurement.d3].some((value) => !(value > 0))) return toast("请先测量或填写三个有效晶面距", true);
  const options = matchOptions();
  const dTolerances = state.dSigma.map((sigma) => combineTolerance(options.distanceTolerance, sigma, options.sigmaMultiplier, options.toleranceMethod));
  $("runMatch").disabled = true; status("正在预筛选晶相…");
  try {
    const phases = await queryPhases({
      elementFilter: elementFilter(), observedD: [measurement.d1, measurement.d2, measurement.d3], dTolerances,
      statuses: $("includeDeleted").checked ? ["P", "A", "D", "CIF", "TXT"] : ["P", "A", "CIF", "TXT"], indexedOnly: true,
    });
    status(`正在计算 ${phases.length.toLocaleString()} 个候选…`); const all = [];
    for (let i = 0; i < phases.length; i += 1) {
      all.push(...matchCard(phases[i], measurement, options).map((result) => addGlobalScore(result, phases[i], options)));
      if (i % 80 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.results = all.sort((a, b) => (a.rankingScore ?? a.score) - (b.rankingScore ?? b.score)).slice(0, 250); state.prefiltered = phases.length; renderResults();
    status(`匹配完成：${state.results.length} 个结果`); $("exportResults").disabled = !state.results.length;
  } catch (error) { status("匹配失败"); toast(error.message, true); }
  finally { $("runMatch").disabled = false; }
}

async function runRingMatch() {
  const options = matchOptions();
  let rings;
  try { rings = state.rings?.length ? state.rings : detectCurrentRings(false); }
  catch (error) { toast(error.message, true); return; }
  if (!rings.length) return toast("请先识别到有效 SAED 环", true);
  const dTolerances = rings.map((ring) => combineTolerance(options.distanceTolerance, ring.dSigma || 0, options.sigmaMultiplier, options.toleranceMethod));
  $("runMatch").disabled = true; status("正在按 SAED 环预筛选晶相…");
  try {
    const phases = await queryPhases({
      elementFilter: elementFilter(), observedD: rings.map((ring) => ring.d), dTolerances,
      minObservedMatches: Math.min(3, Math.max(1, rings.length - 1)),
      statuses: $("includeDeleted").checked ? ["P", "A", "D", "CIF", "TXT"] : ["P", "A", "CIF", "TXT"], indexedOnly: true, limit: 25000,
    });
    status(`正在计算 ${phases.length.toLocaleString()} 个环匹配候选…`); const all = [];
    for (let i = 0; i < phases.length; i += 1) {
      all.push(...matchRings(phases[i], rings, {
        distanceTolerance: options.distanceTolerance, sigmaMultiplier: options.sigmaMultiplier,
        toleranceMethod: options.toleranceMethod, minRings: Math.min(3, rings.length), maxRings: 12,
      }).map((result) => ({ ...result, phase: phases[i], rankingScore: result.score })));
      if (i % 120 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.results = all.sort((a, b) => (a.rankingScore ?? a.score) - (b.rankingScore ?? b.score)).slice(0, 250);
    state.prefiltered = phases.length; renderResults();
    status(`SAED 环匹配完成：${state.results.length} 个结果`); $("exportResults").disabled = !state.results.length;
  } catch (error) { status("环匹配失败"); toast(error.message, true); }
  finally { $("runMatch").disabled = false; }
}

async function runMatch() {
  if ($("matchMode").value === "ring") return runRingMatch();
  return runThreePlaneMatch();
}

function resultScore(result) { return result.rankingScore ?? result.score; }

function orderedResults() {
  const direction = $("resultSort").value === "score-desc" ? -1 : 1;
  return [...state.results].sort((a, b) => direction * (resultScore(a) - resultScore(b)));
}

function renderResults(prefiltered = state.prefiltered) {
  const body = $("resultsBody"); body.replaceChildren();
  const mode = state.results[0]?.kind === "ring" || $("matchMode").value === "ring" ? "SAED 环匹配" : "三晶面硬判据 + 多峰排序";
  $("resultSummary").textContent = `${mode}：预筛选 ${prefiltered.toLocaleString()} 个物相；得到 ${state.results.length.toLocaleString()} 个结果。`;
  if (!state.results.length) { body.innerHTML = '<tr><td colspan="8" class="empty-cell">没有满足当前匹配条件的候选相</td></tr>'; return; }
  orderedResults().forEach((result, index) => {
    const row = document.createElement("tr");
    const phaseText = `<span class="status-pill">${result.phase.status}</span><span class="phase-name">${result.phase.pdfNumber || result.phase.name}</span><div class="phase-formula">${result.phase.name}${result.phase.formula ? ` · ${result.phase.formula}` : ""}</div>`;
    if (result.kind === "ring") {
      const ringText = result.ringMatches.slice(0, 5).map((match, i) => `R${i + 1}:${hkl(match.hkl)}`).join(" ");
      row.innerHTML = `<td>${index + 1}</td><td>${phaseText}</td><td>${result.phase.elements.join(" ")}</td><td class="mono">${ringText}</td><td class="mono">多晶环</td><td class="mono">${result.dResidual.map((v) => fmt(v, 4)).join(" / ")}</td><td class="mono">—</td><td class="score">${fmt(resultScore(result), 4)}<div class="phase-formula">${result.matchedRings}/${result.observedRings} 环</div></td>`;
    } else {
      const globalText = result.globalScore == null ? "" : `<div class="phase-formula">硬 ${fmt(result.score, 3)} · 多峰 ${fmt(result.globalScore, 3)}（${result.globalMatched}/${result.globalTotal}）</div>`;
      row.innerHTML = `<td>${index + 1}</td><td>${phaseText}</td><td>${result.phase.elements.join(" ")}</td><td class="mono">${hkl(result.hkl1)} + ${hkl(result.hkl3)} = ${hkl(result.hkl2)}</td><td class="mono">[${result.zoneAxis.join(" ")}]</td><td class="mono">${result.dResidual.map((v) => fmt(v, 4)).join(" / ")}</td><td class="mono">${result.phiResidual.map((v) => fmt(v, 3)).join(" / ")}</td><td class="score">${fmt(resultScore(result), 4)}${globalText}</td>`;
    }
    body.append(row);
  });
}

function exportCsv() {
  if (!state.results.length) return;
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [["rank","mode","phase","name","formula","hkl_or_rings","zone_axis","d_residual","angle_residual","hard_score","global_score","ranking_score"]];
  orderedResults().forEach((r, i) => rows.push([
    i + 1, r.kind === "ring" ? "ring" : "three-plane", r.phase.pdfNumber || r.phase.id, r.phase.name, r.phase.formula,
    r.kind === "ring" ? r.ringMatches.map((match) => hkl(match.hkl)).join(" ") : `${hkl(r.hkl1)} + ${hkl(r.hkl3)} = ${hkl(r.hkl2)}`,
    r.kind === "ring" ? "polycrystalline-ring" : `[${r.zoneAxis.join(" ")}]`, r.dResidual.join("/"), r.kind === "ring" ? "" : r.phiResidual.join("/"),
    r.kind === "ring" ? "" : r.score, r.globalScore ?? "", resultScore(r),
  ]));
  const blob = new Blob([rows.map((row) => row.map(quote).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `sand3-results-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

$("imageFile").addEventListener("change", (event) => onImageFile(event.target.files[0]));
$("imageMode").addEventListener("change", updateCalibrationLabels);
$("analyzeImage").addEventListener("click", analyzeImage);

$("replaceImage").addEventListener("click", () => $("imageFile").click());
$("scaleValue").addEventListener("input", updateCalibrationFromScale); $("scaleUnit").addEventListener("change", updateCalibrationFromScale);
$("detectScale").addEventListener("click", async () => { state.inputView = null; setScaleFromImage(); await recognizeScaleText(); drawInputImage(); toast("已重新识别标尺，请核对端点、数值和单位"); });
$("roiShape").addEventListener("change", (event) => { state.roiShape = event.target.value; });
$("selectRoi").addEventListener("click", () => { state.inputMode = "roi"; toast(`请在输入图上拖出${state.roiShape === "square" ? "正方形" : "矩形"} FFT ROI`); });
$("zoomInput").addEventListener("click", () => { state.inputMode = "zoom"; toast("请在输入图上框选需要放大的区域"); });
$("resetInputView").addEventListener("click", () => { state.inputView = null; state.inputSelection = null; state.inputMode = null; drawInputImage(); toast("输入图已恢复原始显示尺寸"); });
$("inputCanvas").addEventListener("pointerdown", (event) => {
  if (!state.image) return; const point = inputPoint(event); const t = state.inputTransform;
  if (["roi", "zoom"].includes(state.inputMode)) { state.inputDrag = { type: state.inputMode, start: point }; state.inputSelection = { x: point.x, y: point.y, width: 1, height: 1 }; }
  else {
    const endpoints = [state.scaleLine?.a, state.scaleLine?.b];
    const index = endpoints.findIndex((p) => p && Math.hypot(p.x - point.x, p.y - point.y) * t.scale <= 14);
    if (index >= 0) state.inputDrag = { type: "scale", index };
  }
  if (state.inputDrag) $("inputCanvas").setPointerCapture(event.pointerId);
});
$("inputCanvas").addEventListener("pointermove", (event) => {
  if (!state.inputDrag) return; const point = inputPoint(event);
  point.x = Math.max(0, Math.min(state.image.width - 1, point.x)); point.y = Math.max(0, Math.min(state.image.height - 1, point.y));
  if (state.inputDrag.type === "scale") {
    const key = state.inputDrag.index ? "b" : "a"; const other = state.inputDrag.index ? state.scaleLine.a : state.scaleLine.b;
    state.scaleLine[key] = { x: point.x, y: event.shiftKey ? other.y : point.y }; updateCalibrationFromScale();
  } else {
    const square = state.inputDrag.type === "roi" && state.roiShape === "square";
    state.inputSelection = clampView(normalizedSelection(state.inputDrag.start, point, square), state.image, 1); drawInputImage();
  }
});
$("inputCanvas").addEventListener("pointerup", () => {
  if (state.inputDrag?.type === "roi" && state.inputSelection?.width >= 8 && state.inputSelection?.height >= 8) {
    state.roi = state.inputSelection; toast(`FFT ROI：${Math.round(state.roi.width)} × ${Math.round(state.roi.height)} px`);
  } else if (state.inputDrag?.type === "zoom" && state.inputSelection?.width >= 8 && state.inputSelection?.height >= 8) {
    state.inputView = clampView(state.inputSelection, state.image); toast("已放大输入图局部区域");
  }
  state.inputSelection = null; state.inputMode = null; state.inputDrag = null; drawInputImage();
});

$("patternCanvas").addEventListener("pointerdown", (event) => {
  if (!state.pattern) return; const point = canvasPoint(event); const scale = state.canvasTransform.scale;
  if (state.patternMode === "zoom") {
    state.patternDrag = { type: "zoom", start: point }; state.patternSelection = { x: point.x, y: point.y, width: 1, height: 1 };
    $("patternCanvas").setPointerCapture(event.pointerId); return;
  }
  if (state.pickMode === "peaks") {
    const nearest = nearestPeak(point); if (!nearest || nearest.distance * scale > 18) return toast("点击位置附近没有检测峰", true);
    state.picked.push({ ...nearest.peak });
    if (state.picked.length === 3) { state.pickMode = null; state.parallelograms = []; updateMeasurement(state.picked); $("geometryStatus").textContent = "当前一组 · 手动选择"; toast("已按 g₁、g₂、g₃ 顺序完成手动选点"); }
    else toast(`已选择 g${state.picked.length}，请继续选择 g${state.picked.length + 1}`);
    drawPattern(); return;
  }
  if (state.ringEdit) {
    if (!state.centerLocked && state.center && Math.hypot(point.x - state.center.x, point.y - state.center.y) * scale <= 14) {
      state.patternDrag = { type: "center" }; $("patternCanvas").setPointerCapture(event.pointerId); return;
    }
    if (state.ringEditAction === "add") {
      if (!addManualRingAt(point)) return toast("添加环的位置离 000 过近", true);
      state.patternDrag = { type: "ring", index: state.selectedRing }; $("patternCanvas").setPointerCapture(event.pointerId); return;
    }
    const nearest = nearestRing(point);
    if (state.ringEditAction === "delete") {
      if (!nearest) return toast("请点击需要删除的衍射环", true);
      deleteRing(nearest.index); state.ringEditAction = null; return;
    }
    if (nearest) {
      state.selectedRing = nearest.index; state.patternDrag = { type: "ring", index: nearest.index };
      ringStatus(`已选中 R${nearest.index + 1}，拖动可修改半径`);
      drawPattern(); $("patternCanvas").setPointerCapture(event.pointerId); return;
    }
    state.selectedRing = null; ringStatus("环手动模式：未选中环"); drawPattern(); return;
  }
  if (!state.centerLocked && state.center && Math.hypot(point.x - state.center.x, point.y - state.center.y) * scale <= 14) state.patternDrag = { type: "center" };
  else if (state.selected) {
    const index = state.selected.findIndex((p) => Math.hypot(point.x - p.x, point.y - p.y) * scale <= 15);
    if (index >= 0) state.patternDrag = { type: "peak", index };
  }
  if (state.patternDrag) $("patternCanvas").setPointerCapture(event.pointerId);
});
$("patternCanvas").addEventListener("pointermove", (event) => {
  if (!state.patternDrag) return; let point = canvasPoint(event);
  point.x = Math.max(0, Math.min(state.pattern.width - 1, point.x)); point.y = Math.max(0, Math.min(state.pattern.height - 1, point.y));
  if (state.patternDrag.type === "zoom") { state.patternSelection = clampView(normalizedSelection(state.patternDrag.start, point), state.pattern, 1); drawPattern(); return; }
  if (state.patternDrag.type === "ring") {
    const radius = Math.hypot(point.x - state.center.x, point.y - state.center.y);
    updateRingRadius(state.patternDrag.index, radius); state.selectedRing = state.patternDrag.index;
    ringStatus(`正在调整 R${state.patternDrag.index + 1}`);
    drawPattern(); return;
  }
  point = maybeSnapPattern(point);
  if (state.patternDrag.type === "center") state.center = point; else state.selected[state.patternDrag.index] = { ...state.selected[state.patternDrag.index], ...point };
  if (state.selected) { updateMeasurement(state.selected, true); $("geometryStatus").textContent = state.snapBright && point.snapped ? "当前一组 · 已吸附亮点" : "当前一组 · 手动调整"; } else drawPattern();
});
$("patternCanvas").addEventListener("pointerup", () => {
  if (state.patternDrag?.type === "zoom" && state.patternSelection?.width >= 6 && state.patternSelection?.height >= 6) {
    state.patternView = clampView(state.patternSelection, state.pattern); toast("已放大几何图局部区域");
  } else if (state.patternDrag?.type === "ring") {
    state.rings.sort((a, b) => a.radius - b.radius);
    state.selectedRing = null; state.ringEditAction = null; ringStatus("环半径已更新");
  } else if (state.patternDrag && state.selected) updateMeasurement(state.selected);
  state.patternSelection = null; state.patternMode = null; state.patternDrag = null; drawPattern();
});

$("lockCenter").addEventListener("click", () => { state.centerLocked = !state.centerLocked; $("lockCenter").textContent = state.centerLocked ? "松开 000" : "固定 000"; toast(state.centerLocked ? "000 中心已固定" : "000 中心可拖动"); });
$("snapBright").addEventListener("click", () => { state.snapBright = !state.snapBright; $("snapBright").textContent = `亮点吸附：${state.snapBright ? "开" : "关"}`; $("snapBright").classList.toggle("active", state.snapBright); toast(state.snapBright ? "拖动 000 或 g 点时将吸附至局部亮点" : "亮点吸附已关闭"); });
$("findParallelogram").addEventListener("click", () => { const found = identifyCurrentGeometry(); toast(found ? "已识别并选定当前一组平行四边形" : "未识别到满足闭合条件的一组", !found); });
$("pickPeaks").addEventListener("click", () => { state.pickMode = "peaks"; state.picked = []; toast("请依次点击 g₁、g₂、g₃"); });
$("clearParallelogram").addEventListener("click", () => { clearCurrentGeometry(); toast("已删除当前平行四边形"); });
$("detectRings").addEventListener("click", () => { try { detectCurrentRings(true); } catch (error) { toast(error.message, true); } });
$("ringEdit").addEventListener("click", () => {
  try {
    if ($("imageMode").value !== "saed") throw new Error("环手动模式仅用于 SAED 多晶环");
    setRingEdit(!state.ringEdit);
  } catch (error) { toast(error.message, true); }
});
$("addRing").addEventListener("click", () => {
  if (!state.ringEdit) setRingEdit(true);
  state.ringEditAction = "add"; toast("请在图中点击新衍射环的半径位置");
});
$("deleteRing").addEventListener("click", () => {
  if (!state.ringEdit) setRingEdit(true);
  if (deleteRing()) return toast("已删除选中的衍射环");
  state.ringEditAction = "delete"; toast("请点击需要删除的衍射环");
});
$("zoomPattern").addEventListener("click", () => { state.patternMode = "zoom"; toast("请在几何图上框选需要放大的区域"); });
$("zoomPatternOut").addEventListener("click", () => {
  if (!state.patternView) return toast("几何图已是原始显示范围");
  const view = state.patternView; const expanded = { x: view.x - view.width * 0.3, y: view.y - view.height * 0.3, width: view.width * 1.6, height: view.height * 1.6 };
  state.patternView = expanded.width >= state.pattern.width * 0.98 || expanded.height >= state.pattern.height * 0.98 ? null : clampView(expanded, state.pattern);
  drawPattern(); toast(state.patternView ? "几何图已缩小一级" : "几何图已恢复完整范围");
});
$("patternBrightness").addEventListener("input", (event) => { state.brightness = Number(event.target.value); drawPattern(); });
$("patternContrast").addEventListener("input", (event) => { state.contrast = Number(event.target.value); drawPattern(); });
$("patternSharpness").addEventListener("input", (event) => { state.sharpness = Number(event.target.value); drawPattern(); });
$("pdf2File").addEventListener("change", (event) => importDat(event.target.files[0]));
$("phaseFiles").addEventListener("change", (event) => importPhaseFiles([...event.target.files]));
$("searchCards").addEventListener("click", searchCards);
$("elementLogic").addEventListener("change", updateElementUI);
$("resultSort").addEventListener("change", () => renderResults());
$("matchMode").addEventListener("change", () => {
  $("runMatch").textContent = $("matchMode").value === "ring" ? "开始环匹配" : "开始匹配";
  renderResults();
});
$("clearDatabase").addEventListener("click", async () => {
  if (!confirm("确认清空 Sand3/database 中的全部卡片索引？原始 pdf2.dat 不会被删除。")) return;
  await clearDatabase(); await refreshDatabaseStats(); toast("Sand3 持久数据库已清空");
});
$("runMatch").addEventListener("click", runMatch); $("exportResults").addEventListener("click", exportCsv);
window.addEventListener("resize", () => { drawInputImage(); drawPattern(); });
const dropZone = $("imageDropZone");
for (const name of ["dragenter", "dragover"]) dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add("drag"); });
for (const name of ["dragleave", "drop"]) dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove("drag"); });
dropZone.addEventListener("drop", (event) => onImageFile(event.dataTransfer.files[0]));

renderElements(); updateCalibrationLabels(); refreshDatabaseStats().catch((error) => toast(error.message, true));
