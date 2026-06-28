const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 5) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
const missing = (value) => value == null || value === "" || Number(value) === 32767;
const cellText = (value) => missing(value) ? "—" : String(value);

function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3600);
}

function pair(term, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value == null || value === "" ? "—" : String(value);
  return [dt, dd];
}

function renderList(container, entries) {
  container.replaceChildren();
  for (const [term, value] of entries) container.append(...pair(term, value));
}

function reflectionRows(phase) {
  const dValues = phase.dValues || [];
  const hkls = phase.hkls || [];
  const intensities = phase.intensities || [];
  const count = Math.min(dValues.length, Math.floor(hkls.length / 3));
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      d: dValues[index],
      h: hkls[index * 3],
      k: hkls[index * 3 + 1],
      l: hkls[index * 3 + 2],
      intensity: intensities[index],
    });
  }
  return rows;
}

function renderReflections(phase) {
  const body = $("reflectionBody");
  const rows = reflectionRows(phase);
  $("reflectionCount").textContent = `${rows.length.toLocaleString()} 条`;
  const maxRows = 3000;
  $("reflectionSummary").textContent = rows.length
    ? `显示 ${Math.min(rows.length, maxRows).toLocaleString()} / ${rows.length.toLocaleString()} 条反射。d 范围：${fmt(phase.dMin, 4)} – ${fmt(phase.dMax, 4)} Å。`
    : "该卡片没有可显示的指标化反射。";
  body.replaceChildren();
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">无反射数据</td></tr>';
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.slice(0, maxRows).forEach((row, index) => {
    const tr = document.createElement("tr");
    for (const value of [index + 1, fmt(row.d, 5), row.h, row.k, row.l, Number.isFinite(Number(row.intensity)) ? row.intensity : "—"]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      if (index >= 0) td.className = "mono";
      tr.append(td);
    }
    fragment.append(tr);
  });
  body.append(fragment);
}

function rawReflectionRows(phase) {
  if (phase.sourceType === "PDF2.DAT" && phase.rawCardText) {
    const rows = [];
    for (const line of phase.rawCardText.split(/\r?\n/)) {
      const tag = line.slice(71, 80);
      if (tag.slice(-1) !== "I") continue;
      const data = line.slice(0, 71);
      for (let slot = 0; slot < 3; slot += 1) {
        const raw = data.slice(slot * 23, slot * 23 + 23);
        const d = Number(raw.slice(0, 7));
        if (!(d > 0)) continue;
        rows.push({
          d,
          intensity: Number(raw.slice(7, 10)),
          h: Number(raw.slice(11, 15)),
          k: Number(raw.slice(15, 18)),
          l: Number(raw.slice(18, 21)),
          raw: `${tag} · ${raw}`,
          origin: "pdf2_raw_i",
        });
      }
    }
    if (rows.length) return rows;
  }
  if (Array.isArray(phase.rawReflections) && phase.rawReflections.length) return phase.rawReflections;
  return reflectionRows(phase).map((row) => ({ ...row, origin: "compact-cache" }));
}

function renderRawReflections(phase) {
  const body = $("rawReflectionBody");
  const rows = rawReflectionRows(phase);
  $("rawReflectionCount").textContent = `${rows.length.toLocaleString()} 条`;
  const source = rows.some((row) => row.origin === "pdf2_raw_i") ? "pdf2"
    : rows.some((row) => row.origin === "compact-cache") ? "compact" : "stored";
  $("rawReflectionSummary").textContent = rows.length
    ? source === "pdf2" ? "显示从 PDF2 原始 I 记录还原的晶面槽；最后一列保留对应 tag 与 23 字节原始槽内容。"
      : source === "compact" ? "当前缓存没有独立原始晶面记录，已由紧凑 d/I/hkl 缓存还原显示。"
        : "显示导入时保存的原始晶面条目。"
    : "该卡片没有可显示的原始晶面内容。";
  body.replaceChildren();
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">无原始晶面内容</td></tr>';
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const values = [
      index + 1,
      fmt(row.d, 5),
      Number.isFinite(Number(row.intensity)) ? row.intensity : "—",
      cellText(row.h),
      cellText(row.k),
      cellText(row.i),
      cellText(row.l),
      row.raw || row.rawLine || row.origin || row.source || "—",
    ];
    values.forEach((value, column) => {
      const td = document.createElement("td");
      td.textContent = String(value);
      td.className = column === 7 ? "mono raw-record-cell" : "mono";
      tr.append(td);
    });
    fragment.append(tr);
  });
  body.append(fragment);
}

function rawRecordRows(phase) {
  const text = phase.rawCardText || "";
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  if (phase.sourceType === "PDF2.DAT") return lines.filter((line) => line.length).map((line) => {
    const tag = line.slice(71, 80);
    return { code: tag.slice(-1) || "—", tag: tag || "—", content: line };
  });
  return lines.map((line, index) => ({ code: "SRC", tag: `${phase.sourceType || "SOURCE"}:${index + 1}`, content: line }));
}

function renderRawRecords(phase) {
  const body = $("rawRecordBody");
  const rows = rawRecordRows(phase);
  $("rawRecordCount").textContent = `${rows.length.toLocaleString()} 条`;
  $("rawRecordSummary").textContent = rows.length
    ? phase.sourceType === "PDF2.DAT"
      ? "显示该 PDF2 卡片导入时保存的完整 80-byte 原始记录行；记录码为 tag 最后一位。"
      : "显示该 CIF / TXT 文件导入时保存的原始文本行。"
    : "当前数据库缓存没有保存全量原始条目。若该相来自旧版 PDF2 缓存，请重新导入 PDF2.DAT 后再打开卡片。";
  body.replaceChildren();
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-cell">无全量原始条目</td></tr>';
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    [index + 1, row.code, row.tag, row.content].forEach((value, column) => {
      const td = document.createElement("td");
      td.textContent = String(value);
      td.className = column === 3 ? "mono raw-record-cell" : "mono";
      tr.append(td);
    });
    fragment.append(tr);
  });
  body.append(fragment);
}

async function loadPhase() {
  const id = new URLSearchParams(location.search).get("id") || "";
  if (!id) throw new Error("缺少卡片 id");
  const response = await fetch(`/api/database/phase?id=${encodeURIComponent(id)}`);
  const phase = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(phase.error || `读取失败（${response.status}）`);
  return phase;
}

try {
  const phase = await loadPhase();
  document.title = `Sand3 Industrial · ${phase.pdfNumber || phase.name || "卡片详情"}`;
  $("cardStatus").textContent = "已载入";
  $("phaseTitle").textContent = phase.pdfNumber || phase.name || phase.id;
  $("phaseBadge").textContent = `[ ${phase.status || "CARD"} ]`;
  $("phaseSource").textContent = phase.sourceType || "LOCAL SQLITE";
  $("phaseStatus").textContent = phase.status || "—";
  $("indexedBadge").textContent = phase.indexed ? "INDEXED" : "UNINDEXED";

  renderList($("summaryList"), [
    ["内部 ID", phase.id],
    ["PDF 号", phase.pdfNumber],
    ["卡片键", phase.cardKey],
    ["名称", phase.name],
    ["化学式", phase.formula],
    ["元素", (phase.elements || []).join(" ")],
    ["来源类型", phase.sourceType],
    ["来源文件", phase.sourceName],
    ["状态", phase.status],
  ]);

  const cell = phase.cell || {};
  renderList($("cellList"), [
    ["晶系", phase.crystalSystem],
    ["空间群", phase.spaceGroup],
    ["a / b / c（Å）", [cell.a, cell.b, cell.c].map((value) => fmt(value, 5)).join(" / ")],
    ["α / β / γ（°）", [cell.alpha, cell.beta, cell.gamma].map((value) => fmt(value, 4)).join(" / ")],
    ["d min / d max（Å）", `${fmt(phase.dMin, 5)} / ${fmt(phase.dMax, 5)}`],
    ["指标化", phase.indexed ? "是" : "否"],
  ]);

  renderReflections(phase);
  renderRawReflections(phase);
  renderRawRecords(phase);
} catch (error) {
  $("cardStatus").textContent = "读取失败";
  $("phaseTitle").textContent = "卡片读取失败";
  $("reflectionBody").innerHTML = '<tr><td colspan="6" class="empty-cell">无法读取卡片</td></tr>';
  $("rawReflectionBody").innerHTML = '<tr><td colspan="8" class="empty-cell">无法读取卡片</td></tr>';
  $("rawRecordBody").innerHTML = '<tr><td colspan="4" class="empty-cell">无法读取卡片</td></tr>';
  toast(error.message, true);
}
