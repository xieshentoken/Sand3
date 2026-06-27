import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CRYSTAL_SYSTEM_BY_CODE, elementsFromFormula, phasePassesElementFilter } from "./core.js";

function json(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function floatBlob(values) {
  const array = values instanceof Float32Array ? values : Float32Array.from(values || []);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function int16Blob(values) {
  const array = values instanceof Int16Array ? values : Int16Array.from(values || []);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function uint16Blob(values) {
  const array = values instanceof Uint16Array ? values : Uint16Array.from(values || [], (v) => Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function typedCopy(Type, blob) {
  if (!blob?.byteLength) return new Type();
  const copy = Buffer.from(blob);
  return new Type(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
}

function compactReflections(phase) {
  if (phase.dValues && phase.hkls) {
    return {
      dValues: phase.dValues,
      hkls: phase.hkls,
      intensities: phase.intensities || new Uint16Array(phase.dValues.length),
    };
  }
  const reflections = phase.reflections || [];
  return {
    dValues: Float32Array.from(reflections, (r) => r.d),
    hkls: Int16Array.from(reflections.flatMap((r) => [r.h, r.k, r.l])),
    intensities: Uint16Array.from(reflections, (r) => Number.isFinite(r.intensity) ? Math.max(0, Math.round(r.intensity)) : 0),
  };
}

function elementKey(elements) { return `|${[...new Set(elements || [])].sort().join("|")}|`; }

function addElementWhere(where, params, filter = {}) {
  const required = filter.required || [];
  if (filter.logic === "or" && required.length) {
    where.push(`(${required.map(() => "elements LIKE ?").join(" OR ")})`);
    params.push(...required.map((element) => `%|${element}|%`));
  } else for (const element of required) { where.push("elements LIKE ?"); params.push(`%|${element}|%`); }
  for (const excluded of filter.excluded || []) { where.push("elements NOT LIKE ?"); params.push(`%|${excluded}|%`); }
}

function phaseFromRow(row, includeArrays = true) {
  const phase = {
    id: row.external_id, cardKey: row.card_key, pdfNumber: row.pdf_number, status: row.status,
    classCode: row.class_code, crystalSystem: row.crystal_system, sourceType: row.source_type,
    sourceName: row.source_name, name: row.name, formula: row.formula,
    elements: (row.elements || "").split("|").filter(Boolean), spaceGroup: row.space_group,
    cell: json(row.cell_json, null), indexed: Boolean(row.indexed), dMin: row.d_min, dMax: row.d_max,
  };
  if (includeArrays) {
    phase.dValues = Array.from(typedCopy(Float32Array, row.d_values));
    phase.hkls = Array.from(typedCopy(Int16Array, row.hkls));
    phase.intensities = Array.from(typedCopy(Uint16Array, row.intensities));
  }
  return phase;
}

export class CrystalDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS phases (
        row_id INTEGER PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, card_key TEXT, pdf_number TEXT,
        status TEXT, class_code TEXT, crystal_system TEXT, source_type TEXT, source_name TEXT,
        name TEXT, formula TEXT, elements TEXT, space_group TEXT, cell_json TEXT, indexed INTEGER,
        d_min REAL, d_max REAL, d_values BLOB, hkls BLOB, intensities BLOB
      );
      CREATE INDEX IF NOT EXISTS phases_filter ON phases(status, indexed, source_type);
      CREATE TABLE IF NOT EXISTS sources (
        fingerprint TEXT PRIMARY KEY, name TEXT, size INTEGER, last_modified INTEGER,
        imported_at INTEGER, cards INTEGER, indexed INTEGER, deleted INTEGER, kind TEXT
      );
    `);
    this.insertPhase = this.db.prepare(`INSERT OR REPLACE INTO phases
      (external_id,card_key,pdf_number,status,class_code,crystal_system,source_type,source_name,name,formula,elements,space_group,cell_json,indexed,d_min,d_max,d_values,hkls,intensities)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.insertSource = this.db.prepare(`INSERT OR REPLACE INTO sources
      (fingerprint,name,size,last_modified,imported_at,cards,indexed,deleted,kind) VALUES (?,?,?,?,?,?,?,?,?)`);
  }

  close() { this.db.close(); }

  putPhase(phase) {
    const compact = compactReflections(phase);
    this.insertPhase.run(
      phase.id, phase.cardKey || "", phase.pdfNumber || "", phase.status || "P", phase.classCode || "",
      phase.crystalSystem || "Unknown", phase.sourceType || "", phase.sourceName || "", phase.name || "",
      phase.formula || "", elementKey(phase.elements), phase.spaceGroup || "", JSON.stringify(phase.cell || null),
      phase.indexed ? 1 : 0, phase.dMin ?? null, phase.dMax ?? null,
      floatBlob(compact.dValues), int16Blob(compact.hkls), uint16Blob(compact.intensities),
    );
  }

  savePhases(phases, source) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const phase of phases) this.putPhase(phase);
      if (source) this.putSource({ ...source, kind: source.kind || "files" });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  putSource(source) {
    this.insertSource.run(source.fingerprint, source.name, source.size || 0, source.lastModified || 0,
      source.importedAt || Date.now(), source.cards || 0, source.indexed || 0, source.deleted || 0, source.kind || "files");
  }

  stats() {
    const phases = Number(this.db.prepare("SELECT count(*) n FROM phases").get().n);
    const sources = this.db.prepare("SELECT * FROM sources ORDER BY imported_at DESC").all().map((row) => ({
      fingerprint: row.fingerprint, name: row.name, size: Number(row.size), lastModified: Number(row.last_modified),
      importedAt: Number(row.imported_at), cards: Number(row.cards), indexed: Number(row.indexed), deleted: Number(row.deleted), kind: row.kind,
    }));
    let bytes = 0; try { bytes = statSync(this.filePath).size; } catch {}
    return { phases, sources, path: this.filePath, bytes };
  }

  query(query = {}) {
    const statuses = query.statuses || ["P", "A", "CIF", "TXT"];
    const params = [...statuses];
    const where = [`status IN (${statuses.map(() => "?").join(",")})`];
    if (query.indexedOnly !== false) where.push("indexed=1");
    addElementWhere(where, params, query.elementFilter);
    const rows = this.db.prepare(`SELECT * FROM phases WHERE ${where.join(" AND ")}`).iterate(...params);
    const observed = (query.observedD || []).filter((d) => Number.isFinite(d) && d > 0);
    const tolerances = query.dTolerances || observed.map(() => 0.1);
    const minObservedMatches = observed.length
      ? Math.max(1, Math.min(observed.length, Math.round(query.minObservedMatches ?? observed.length)))
      : 0;
    const limit = query.limit || 10000; const output = [];
    for (const row of rows) {
      const elements = (row.elements || "").split("|").filter(Boolean);
      if (!phasePassesElementFilter(elements, query.elementFilter)) continue;
      const dValues = typedCopy(Float32Array, row.d_values); const hkls = typedCopy(Int16Array, row.hkls);
      let observedMatches = 0;
      for (let measurementIndex = 0; measurementIndex < observed.length; measurementIndex += 1) {
        const d = observed[measurementIndex]; let matched = false;
        for (let i = 0; i < dValues.length; i += 1) {
          if (hkls[i * 3] !== 32767 && Math.abs(dValues[i] - d) <= tolerances[measurementIndex]) { matched = true; break; }
        }
        if (matched) observedMatches += 1;
      }
      const passes = observedMatches >= minObservedMatches;
      if (!passes) continue;
      output.push(phaseFromRow(row));
      if (output.length >= limit) break;
    }
    return output;
  }

  searchSummaries(filter = {}, limit = 150) {
    const statuses = filter.statuses || ["P", "A", "CIF", "TXT"];
    const params = [...statuses]; const where = [`status IN (${statuses.map(() => "?").join(",")})`];
    addElementWhere(where, params, filter);
    const rows = this.db.prepare(`SELECT external_id,pdf_number,status,crystal_system,source_type,name,formula,elements,space_group,cell_json,indexed
      FROM phases WHERE ${where.join(" AND ")} ORDER BY indexed DESC, pdf_number, name LIMIT ?`)
      .all(...params, Math.max(1, Math.min(500, Number(limit) || 150)));
    return rows.map((row) => ({
      id: row.external_id, pdfNumber: row.pdf_number, status: row.status, crystalSystem: row.crystal_system,
      sourceType: row.source_type, name: row.name, formula: row.formula,
      elements: (row.elements || "").split("|").filter(Boolean), spaceGroup: row.space_group,
      cell: json(row.cell_json, null), indexed: Boolean(row.indexed),
    })).filter((phase) => phasePassesElementFilter(phase.elements, filter));
  }

  clear() {
    this.db.exec("BEGIN IMMEDIATE; DELETE FROM phases; DELETE FROM sources; COMMIT; VACUUM;");
  }

  beginPdf2(source) {
    return new Pdf2ImportSession(this, source);
  }
}

class Pdf2ImportSession {
  constructor(service, source) {
    this.service = service; this.source = source; this.carry = Buffer.alloc(0); this.current = null;
    this.cards = 0; this.indexed = 0; this.deleted = 0; this.finished = false;
    service.db.exec("BEGIN IMMEDIATE");
    service.db.prepare("DELETE FROM phases WHERE source_type='PDF2.DAT'").run();
    service.db.prepare("DELETE FROM sources WHERE kind='pdf2'").run();
  }

  write(chunk) {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const full = data.length - (data.length % 80);
    for (let offset = 0; offset < full; offset += 80) this.record(data.subarray(offset, offset + 80).toString("latin1"));
    this.carry = Buffer.from(data.subarray(full));
  }

  record(record) {
    const data = record.slice(0, 71); const tag = record.slice(71, 80); const code = tag[8];
    if (!/^[A-Z][0-9]{6}[A-Z0-9][A-Z0-9+*]$/.test(tag)) throw new Error(`无效 PDF2 记录标记：${tag}`);
    if (code === "1") {
      const cardKey = tag.slice(0, 8);
      this.current = { id: `pdf2:${cardKey}`, cardKey, pdfNumber: `${tag.slice(1, 3)}-${tag.slice(3, 7)}`, status: tag[0],
        classCode: tag[7], sourceType: "PDF2.DAT", sourceName: this.source.name,
        nameParts: [], formulaParts: [], cell: null, d: [], hkl: [], intensity: [] };
      return;
    }
    if (!this.current) return;
    if (code === "2" && !this.current.spaceGroup) this.current.spaceGroup = data.slice(0, 12).trim();
    else if (code === "5") this.current.nameParts.push(data.slice(0, 65).trim());
    else if (code === "7") this.current.formulaParts.push(data.slice(0, 65).trim());
    else if (code === "D") {
      const nums = data.trim().split(/\s+/).slice(0, 6).map(Number);
      if (nums.length >= 6) this.current.cell = { a: nums[0], b: nums[1], c: nums[2], alpha: nums[3], beta: nums[4], gamma: nums[5] };
    } else if (code === "I") {
      for (let slot = 0; slot < 3; slot += 1) {
        const value = data.slice(slot * 23, slot * 23 + 23); const d = Number(value.slice(0, 7));
        if (!(d > 0)) continue;
        const h = Number(value.slice(11, 15)); const k = Number(value.slice(15, 18)); const l = Number(value.slice(18, 21));
        this.current.d.push(d); this.current.intensity.push(Number(value.slice(7, 10)) || 0);
        this.current.hkl.push([h, k, l].every(Number.isFinite) ? h : 32767, [h, k, l].every(Number.isFinite) ? k : 32767, [h, k, l].every(Number.isFinite) ? l : 32767);
      }
    } else if (code === "K") this.flushCard();
  }

  flushCard() {
    const card = this.current; if (!card) return;
    const formula = card.formulaParts.join(" ").replace(/\s+/g, " ").trim(); const indexed = Boolean(card.cell && card.hkl.some((v) => v !== 32767));
    const phase = { ...card, name: card.nameParts.join(" ").trim(), formula, elements: elementsFromFormula(formula),
      crystalSystem: CRYSTAL_SYSTEM_BY_CODE[card.classCode] || "Unknown", spaceGroup: "", indexed,
      dMin: card.d.length ? Math.min(...card.d) : null, dMax: card.d.length ? Math.max(...card.d) : null,
      dValues: Float32Array.from(card.d), hkls: Int16Array.from(card.hkl), intensities: Uint16Array.from(card.intensity) };
    delete phase.nameParts; delete phase.formulaParts; delete phase.d; delete phase.hkl; delete phase.intensity;
    this.service.putPhase(phase); this.cards += 1; if (indexed) this.indexed += 1; if (card.status === "D") this.deleted += 1;
    this.current = null;
  }

  finish() {
    if (this.carry.length) throw new Error(`PDF2.DAT 尾部存在 ${this.carry.length} 个不完整字节`);
    this.flushCard();
    const result = { ...this.source, fingerprint: `${this.source.name}:${this.source.size}:${this.source.lastModified}`,
      importedAt: Date.now(), cards: this.cards, indexed: this.indexed, deleted: this.deleted, kind: "pdf2" };
    this.service.putSource(result); this.service.db.exec("COMMIT"); this.finished = true; return result;
  }

  abort() { if (!this.finished) { try { this.service.db.exec("ROLLBACK"); } catch {} this.finished = true; } }
}
