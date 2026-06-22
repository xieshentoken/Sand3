import { CRYSTAL_SYSTEM_BY_CODE, elementsFromFormula } from "./core.js";

const RECORD_SIZE = 80;
const CHUNK_SIZE = 8_000_000; // exactly divisible by 80

function parseReflection(item) {
  const d = Number.parseFloat(item.slice(0, 7));
  if (!Number.isFinite(d) || d <= 0) return null;
  const intensity = Number.parseFloat(item.slice(7, 10));
  const h = Number.parseInt(item.slice(11, 15), 10);
  const k = Number.parseInt(item.slice(15, 18), 10);
  const l = Number.parseInt(item.slice(18, 21), 10);
  return {
    d,
    intensity: Number.isFinite(intensity) ? intensity : null,
    h: Number.isFinite(h) ? h : null,
    k: Number.isFinite(k) ? k : null,
    l: Number.isFinite(l) ? l : null,
    flags: `${item.slice(10, 11)}${item.slice(21, 23)}`.trim(),
    origin: "pdf2_dat",
  };
}

function finalizeCard(card, endOffset) {
  card.endOffset = endOffset;
  card.name = card.nameParts.join(" ").replace(/\s+/g, " ").trim() || card.id;
  card.formula = card.formulaParts.join(" ").replace(/\s+/g, " ").trim();
  card.elements = elementsFromFormula(card.formula);
  delete card.nameParts; delete card.formulaParts;
  card.indexed = Boolean(card.cell && card.reflections.some((r) => Number.isFinite(r.h)));
  card.dMin = card.reflections.length ? card.reflections.reduce((value, r) => Math.min(value, r.d), Infinity) : null;
  card.dMax = card.reflections.length ? card.reflections.reduce((value, r) => Math.max(value, r.d), -Infinity) : null;
  // Store millions of reflections compactly. 32767 marks missing h/k/l.
  card.reflectionCount = card.reflections.length;
  card.dValues = Float32Array.from(card.reflections, (r) => r.d);
  card.intensities = Uint16Array.from(card.reflections, (r) => Number.isFinite(r.intensity) ? r.intensity : 65535);
  card.hkls = Int16Array.from(card.reflections.flatMap((r) => [r.h ?? 32767, r.k ?? 32767, r.l ?? 32767]));
  delete card.reflections;
  return card;
}

let acknowledge = null;

self.onmessage = async (event) => {
  if (event.data?.type === "ack") { acknowledge?.(); acknowledge = null; return; }
  if (event.data?.type !== "parse") return;
  const file = event.data.file;
  const batchSize = Math.max(20, Number(event.data.batchSize) || 250);
  const decoder = new TextDecoder("latin1");
  const batch = [];
  let card = null; let cards = 0; let indexed = 0; let deleted = 0;
  try {
    if (!file || file.size % RECORD_SIZE !== 0) throw new Error("PDF2.DAT 文件大小不是 80 字节记录的整数倍");
    for (let chunkStart = 0; chunkStart < file.size; chunkStart += CHUNK_SIZE) {
      const chunk = decoder.decode(await file.slice(chunkStart, Math.min(file.size, chunkStart + CHUNK_SIZE)).arrayBuffer());
      for (let local = 0; local + RECORD_SIZE <= chunk.length; local += RECORD_SIZE) {
        const absolute = chunkStart + local;
        const record = chunk.slice(local, local + RECORD_SIZE);
        const data = record.slice(0, 71);
        const tag = record.slice(71, 80);
        if (!/^[A-Z][0-9]{6}[A-Z0-9][A-Z0-9+*]$/.test(tag)) throw new Error(`偏移 ${absolute} 处记录标记无效`);
        const code = tag[8];
        if (code === "1") {
          if (card) throw new Error(`卡片 ${card.id} 缺少结束记录`);
          const cardKey = tag.slice(0, 8);
          card = {
            id: `pdf2:${cardKey}`,
            cardKey,
            pdfNumber: `${tag.slice(1, 3)}-${tag.slice(3, 7)}`,
            status: tag[0],
            classCode: tag[7],
            crystalSystem: CRYSTAL_SYSTEM_BY_CODE[tag[7]] || "Unknown",
            sourceType: "PDF2.DAT",
            sourceName: file.name,
            startOffset: absolute,
            nameParts: [], formulaParts: [], reflections: [],
          };
        }
        if (!card) continue;
        if (code === "2" && !card.spaceGroup) {
          card.spaceGroup = data.slice(0, 12).trim();
          const number = Number.parseInt(data.slice(12, 24).match(/\d+/)?.[0], 10);
          if (Number.isFinite(number)) card.spaceGroupNumber = number;
        } else if (code === "5") {
          const value = data.slice(0, 65).trim(); if (value) card.nameParts.push(value);
        } else if (code === "7") {
          const value = data.slice(0, 65).trim(); if (value) card.formulaParts.push(value);
        } else if (code === "D") {
          const values = data.trim().split(/\s+/).slice(0, 6).map(Number);
          if (values.length === 6 && values.every(Number.isFinite)) {
            card.cell = { a: values[0], b: values[1], c: values[2], alpha: values[3], beta: values[4], gamma: values[5] };
          }
        } else if (code === "I") {
          for (let i = 0; i < 3; i += 1) {
            const reflection = parseReflection(data.slice(i * 23, i * 23 + 23));
            if (reflection) card.reflections.push(reflection);
          }
        } else if (code === "K") {
          finalizeCard(card, absolute + RECORD_SIZE);
          cards += 1; if (card.indexed) indexed += 1; if (card.status === "D") deleted += 1;
          batch.push(card); card = null;
          if (batch.length >= batchSize) {
            self.postMessage({ type: "batch", phases: batch.splice(0), cards, indexed, deleted });
            await new Promise((resolve) => { acknowledge = resolve; });
          }
        }
      }
      self.postMessage({ type: "progress", bytes: Math.min(file.size, chunkStart + chunk.length), total: file.size, cards, indexed, deleted });
    }
    if (card) throw new Error(`卡片 ${card.id} 没有完整结束`);
    if (batch.length) {
      self.postMessage({ type: "batch", phases: batch.splice(0), cards, indexed, deleted });
      await new Promise((resolve) => { acknowledge = resolve; });
    }
    self.postMessage({ type: "done", cards, indexed, deleted });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
