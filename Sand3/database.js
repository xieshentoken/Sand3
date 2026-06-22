import {
  CRYSTAL_SYSTEM_BY_CODE,
  elementsFromFormula,
  generateReflections,
} from "./core.js";

const DB_NAME = "sand3-crystal-database";
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `数据库服务错误（${response.status}）`);
  return body;
}

export function getDatabaseStats() { return api("/api/database/stats"); }

export async function importPdf2Dat(file, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ name: file.name, size: String(file.size), lastModified: String(file.lastModified) });
    if (callbacks.force) query.set("force", "1");
    const request = new XMLHttpRequest(); request.open("POST", `/api/database/import-pdf2?${query}`);
    request.upload.onprogress = (event) => callbacks.onProgress?.({ ratio: event.lengthComputable ? event.loaded / event.total : 0, bytes: event.loaded, total: event.total });
    request.onerror = () => reject(new Error("无法连接 Sand3 本地数据库服务"));
    request.onload = () => {
      const body = JSON.parse(request.responseText || "{}");
      if (request.status >= 200 && request.status < 300) resolve(body); else reject(new Error(body.error || `PDF2 导入失败（${request.status}）`));
    };
    request.send(file);
  });
}

export async function savePhases(phases, source = null) {
  return api("/api/database/phases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phases, source }) });
}

export async function queryPhases(query = {}) {
  return api("/api/database/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
}

export async function searchPhaseSummaries(filter = {}, limit = 150) {
  return api("/api/database/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter, limit }) });
}

export async function clearDatabase() {
  await api("/api/database", { method: "DELETE" });
  if ("indexedDB" in globalThis) await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

function stripQuotes(value) {
  return String(value || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

function cifScalar(text, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`^\\s*${escaped}\\s+(.+?)\\s*$`, "im"));
    if (match) return stripQuotes(match[1]).replace(/\([^)]*\)$/, "");
  }
  return "";
}

function inferCrystalSystem(text, spaceGroup) {
  const explicit = cifScalar(text, ["_space_group_crystal_system", "_symmetry_cell_setting"]);
  if (explicit) return explicit[0].toUpperCase() + explicit.slice(1).toLowerCase();
  const sg = spaceGroup.toUpperCase();
  if (sg.includes("M-3") || sg.includes("23") || sg.includes("432")) return "Cubic";
  if (sg.includes("6")) return "Hexagonal";
  if (sg.includes("4")) return "Tetragonal";
  return "Unknown";
}

export function parseCif(text, fileName = "phase.cif", options = {}) {
  const number = (name) => Number(cifScalar(text, [name]));
  const cell = {
    a: number("_cell_length_a"), b: number("_cell_length_b"), c: number("_cell_length_c"),
    alpha: number("_cell_angle_alpha"), beta: number("_cell_angle_beta"), gamma: number("_cell_angle_gamma"),
  };
  if (Object.values(cell).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error(`${fileName} 缺少有效晶胞参数`);
  const formula = cifScalar(text, ["_chemical_formula_sum", "_chemical_formula_structural"]);
  const spaceGroup = cifScalar(text, ["_space_group_name_H-M_alt", "_symmetry_space_group_name_H-M"]);
  const block = text.match(/^\s*data_([^\s]+)/im)?.[1] || fileName.replace(/\.cif$/i, "");
  const atomElements = [...text.matchAll(/^\s*([A-Z][a-z]?)\d*\s+/gm)].map((match) => match[1]);
  const elements = elementsFromFormula(formula).length ? elementsFromFormula(formula) : [...new Set(atomElements)].sort();
  const crystalSystem = inferCrystalSystem(text, spaceGroup);
  const reflections = generateReflections(cell, {
    hMax: options.hMax ?? 10,
    dMin: options.dMin ?? 0.5,
    dMax: options.dMax ?? 50,
  });
  return {
    id: `cif:${fileName}:${block}`,
    cardKey: block,
    pdfNumber: "",
    status: "CIF",
    classCode: Object.entries(CRYSTAL_SYSTEM_BY_CODE).find(([, value]) => value === crystalSystem)?.[0] || "X",
    crystalSystem,
    sourceType: "CIF",
    sourceName: fileName,
    name: block,
    formula,
    elements,
    spaceGroup,
    cell,
    reflections,
    indexed: true,
    dMin: reflections.at(-1)?.d ?? null,
    dMax: reflections[0]?.d ?? null,
  };
}

export function parseJadeTxt(text, fileName = "card.txt") {
  const lines = text.split(/\r?\n/);
  const systemMatch = text.match(/Cubic|Tetragonal|Orthorhombic|Monoclinic|Triclinic|Hexagonal|Trigonal|Rhombohedral/i);
  const crystalSystem = systemMatch ? systemMatch[0][0].toUpperCase() + systemMatch[0].slice(1).toLowerCase() : "Unknown";
  const headerIndex = lines.findIndex((line) => /d\s*\([^)]*[AÅ?][^)]*\)/i.test(line) && /\bh\b/.test(line) && /\bk\b/.test(line));
  if (headerIndex < 0) throw new Error(`${fileName} 中未找到 d/h/k/l 表头`);
  const columns = lines[headerIndex].trim().split(/\s+/);
  const dIndex = columns.findIndex((name) => /^d\(/i.test(name));
  const hIndex = columns.indexOf("h"); const kIndex = columns.indexOf("k"); const lIndex = columns.findIndex((name) => /^l\)?$/.test(name));
  const reflections = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const values = line.replace(/[()]/g, " ").trim().split(/\s+/);
    if (values.length < columns.length - 2) continue;
    const d = Number(values[dIndex]); const h = Number(values[hIndex]); const k = Number(values[kIndex]); const l = Number(values[lIndex]);
    if ([d, h, k, l].every(Number.isFinite)) reflections.push({ d, h, k, l, intensity: null, origin: "jade_txt" });
  }
  const cellText = text.match(/^\s*Cell\s*=\s*(.*?)(?:\s+Pearson\s*=|\r?$)/im)?.[1] || "";
  const cellValues = (cellText.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  let cell;
  if (cellValues.length >= 6) cell = { a: cellValues[0], b: cellValues[1], c: cellValues[2], alpha: cellValues[3], beta: cellValues[4], gamma: cellValues[5] };
  else if (crystalSystem === "Cubic" && cellValues.length >= 1) cell = { a: cellValues[0], b: cellValues[0], c: cellValues[0], alpha: 90, beta: 90, gamma: 90 };
  else if (["Tetragonal", "Hexagonal", "Trigonal", "Rhombohedral"].includes(crystalSystem) && cellValues.length >= 2) {
    cell = { a: cellValues[0], b: cellValues[0], c: cellValues[1], alpha: 90, beta: 90, gamma: ["Hexagonal", "Trigonal", "Rhombohedral"].includes(crystalSystem) ? 120 : 90 };
  } else if (cellValues.length >= 3) {
    const [a, b, c] = cellValues;
    cell = { a, b, c, alpha: 90, beta: crystalSystem === "Monoclinic" && cellValues[3] ? cellValues[3] : 90, gamma: 90 };
  }
  if (!cell || !reflections.length) throw new Error(`${fileName} 缺少可用晶胞或指标化反射`);
  const formula = lines[2]?.split("\t")[0].trim() || "";
  const pdfNumber = lines[0]?.match(/PDF#([0-9-]+)/i)?.[1] || "";
  return {
    id: `txt:${fileName}:${pdfNumber || Date.now()}`,
    pdfNumber,
    status: "TXT", classCode: Object.entries(CRYSTAL_SYSTEM_BY_CODE).find(([, value]) => value === crystalSystem)?.[0] || "X", crystalSystem, sourceType: "Jade TXT", sourceName: fileName,
    name: lines[1]?.trim() || fileName, formula, elements: elementsFromFormula(formula), cell, reflections, indexed: true,
  };
}
