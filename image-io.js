/** Browser-side microscopy image readers. */

function extensionOf(name) {
  const match = String(name || "").toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

function normalizeGray(values) {
  let min = Infinity; let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min || 1;
  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) output[i] = Number.isFinite(values[i]) ? (values[i] - min) / range : 0;
  return { values: output, min, max };
}

async function loadNativeImage(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const gray = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    gray[j] = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
  }
  bitmap.close?.();
  return { width: canvas.width, height: canvas.height, gray, metadata: {}, format: extensionOf(file.name).toUpperCase() };
}

const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function packBitsDecode(source, expectedLength) {
  const output = new Uint8Array(expectedLength);
  let input = 0; let out = 0;
  while (input < source.length && out < output.length) {
    const header = source[input++];
    if (header <= 127) {
      const count = header + 1;
      output.set(source.subarray(input, input + count), out); input += count; out += count;
    } else if (header >= 129) {
      const count = 257 - header; const value = source[input++];
      output.fill(value, out, Math.min(out + count, output.length)); out += count;
    }
  }
  return output;
}

function lzwDecode(source, expectedLength) {
  const output = new Uint8Array(expectedLength);
  let bitPosition = 0;
  const readCode = (bits) => {
    let code = 0;
    for (let i = 0; i < bits; i += 1) {
      const byte = source[bitPosition >> 3];
      code = (code << 1) | ((byte >> (7 - (bitPosition & 7))) & 1); bitPosition += 1;
    }
    return code;
  };
  let dictionary; let codeSize; let nextCode; let previous = null; let out = 0;
  const reset = () => {
    dictionary = Array.from({ length: 258 }, (_, i) => (i < 256 ? Uint8Array.of(i) : null));
    codeSize = 9; nextCode = 258; previous = null;
  };
  reset();
  while (bitPosition + codeSize <= source.length * 8 && out < output.length) {
    const code = readCode(codeSize);
    if (code === 256) { reset(); continue; }
    if (code === 257) break;
    let entry;
    if (dictionary[code]) entry = dictionary[code];
    else if (code === nextCode && previous) {
      entry = new Uint8Array(previous.length + 1); entry.set(previous); entry[entry.length - 1] = previous[0];
    } else throw new Error("TIFF LZW 数据损坏");
    output.set(entry.subarray(0, output.length - out), out); out += entry.length;
    if (previous && nextCode < 4096) {
      const combined = new Uint8Array(previous.length + 1); combined.set(previous); combined[combined.length - 1] = entry[0];
      dictionary[nextCode++] = combined;
      if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return output;
}

async function deflateDecode(source) {
  if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不能解压 Deflate TIFF");
  for (const format of ["deflate", "deflate-raw"]) {
    try {
      const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* try the second wrapper */ }
  }
  throw new Error("Deflate TIFF 解压失败");
}

function parseTiffDescriptionCalibration(description) {
  const text = String(description || "");
  const match = text.match(/(?:pixel(?:\s+size)?|physicalsize[xy]|scale)\s*[:=]\s*([0-9.eE+-]+)\s*(nm|pm|angstrom|å|a\b)/i);
  if (!match) return null;
  const value = Number(match[1]); const unit = match[2].toLowerCase();
  const angstrom = unit === "nm" ? value * 10 : unit === "pm" ? value / 100 : value;
  return Number.isFinite(angstrom) && angstrom > 0 ? { pixelSizeAngstrom: angstrom, source: "TIFF metadata" } : null;
}

async function decodeJpegTiffStrips(buffer, offsets, byteCounts, tags, width, height) {
  if (typeof createImageBitmap === "undefined") throw new Error("JPEG 压缩 TIFF 需要浏览器图像解码器");
  const rowsPerStrip = Number(tags.get(278)?.[0] || height);
  const tables = tags.get(347) ? Uint8Array.from(tags.get(347)) : null;
  const gray = new Float64Array(width * height); let destinationY = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    let jpeg = new Uint8Array(buffer, offsets[i], byteCounts[Math.min(i, byteCounts.length - 1)]);
    if (tables?.length && !(jpeg[0] === 0xff && jpeg[1] === 0xd8)) {
      const tableEnd = tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.length - 2 : tables.length;
      const merged = new Uint8Array(tableEnd + jpeg.length + 2); merged.set(tables.subarray(0, tableEnd)); merged.set(jpeg, tableEnd);
      if (!(merged[merged.length - 2] === 0xff && merged[merged.length - 1] === 0xd9)) merged.set([0xff, 0xd9], merged.length - 2);
      jpeg = merged;
    }
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const rows = Math.min(rowsPerStrip, height - destinationY, bitmap.height);
    for (let y = 0; y < rows; y += 1) for (let x = 0; x < Math.min(width, bitmap.width); x += 1) {
      const source = (y * bitmap.width + x) * 4;
      gray[(destinationY + y) * width + x] = 0.2126 * pixels[source] + 0.7152 * pixels[source + 1] + 0.0722 * pixels[source + 2];
    }
    destinationY += rows; bitmap.close?.();
  }
  return gray;
}

export async function parseTiffBuffer(buffer, fileName = "image.tif") {
  const view = new DataView(buffer);
  const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (byteOrder !== "II" && byteOrder !== "MM") throw new Error("不是有效的 TIFF 文件");
  const little = byteOrder === "II";
  if (view.getUint16(2, little) !== 42) throw new Error("当前只支持经典 TIFF，不支持 BigTIFF");
  const ifdOffset = view.getUint32(4, little); const entryCount = view.getUint16(ifdOffset, little);
  const tags = new Map();
  const readValue = (type, offset) => {
    if (type === 1 || type === 2 || type === 6 || type === 7) return view.getUint8(offset);
    if (type === 3) return view.getUint16(offset, little);
    if (type === 4) return view.getUint32(offset, little);
    if (type === 8) return view.getInt16(offset, little);
    if (type === 9) return view.getInt32(offset, little);
    if (type === 11) return view.getFloat32(offset, little);
    if (type === 12) return view.getFloat64(offset, little);
    return null;
  };
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entry, little); const type = view.getUint16(entry + 2, little); const count = view.getUint32(entry + 4, little);
    const size = TIFF_TYPE_SIZE[type]; if (!size) continue;
    const dataOffset = count * size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    const values = [];
    if (type === 5 || type === 10) {
      for (let j = 0; j < count; j += 1) {
        const n = type === 5 ? view.getUint32(dataOffset + j * 8, little) : view.getInt32(dataOffset + j * 8, little);
        const d = type === 5 ? view.getUint32(dataOffset + j * 8 + 4, little) : view.getInt32(dataOffset + j * 8 + 4, little);
        values.push(n / d);
      }
    } else if (type === 2) {
      const bytes = new Uint8Array(buffer, dataOffset, count); values.push(new TextDecoder("latin1").decode(bytes).replace(/\0+$/, ""));
    } else for (let j = 0; j < count; j += 1) values.push(readValue(type, dataOffset + j * size));
    tags.set(tag, values);
  }
  const scalar = (tag, fallback) => tags.get(tag)?.[0] ?? fallback;
  const width = Number(scalar(256)); const height = Number(scalar(257));
  const bits = Number(scalar(258, 8)); const compression = Number(scalar(259, 1));
  const photometric = Number(scalar(262, 1)); const samples = Number(scalar(277, 1)); const sampleFormat = Number(scalar(339, 1));
  const predictor = Number(scalar(317, 1));
  if (!width || !height) throw new Error("TIFF 缺少图像尺寸");
  if (![8, 16, 32, 64].includes(bits)) throw new Error(`暂不支持 ${bits}-bit TIFF`);
  if (samples > 4) throw new Error(`暂不支持每像素 ${samples} 个通道的 TIFF`);
  if (!tags.get(273) && tags.get(324)) throw new Error("当前 TIFF 读取器暂不支持 tiled TIFF，请先转为 strip TIFF");
  const offsets = tags.get(273); const byteCounts = tags.get(279);
  if (!offsets?.length || !byteCounts?.length) throw new Error("TIFF 缺少 strip/tile 数据位置");
  if (compression === 7) {
    const mono = await decodeJpegTiffStrips(buffer, offsets, byteCounts, tags, width, height);
    const normalized = normalizeGray(mono); const description = scalar(270, "");
    return {
      width, height, gray: normalized.values, format: "TIFF",
      metadata: { bits, compression, samples, sampleFormat, description, rawMin: normalized.min, rawMax: normalized.max },
      calibration: parseTiffDescriptionCalibration(description),
    };
  }
  const bytesPerSample = bits / 8; const expected = width * height * samples * bytesPerSample;
  const raw = new Uint8Array(expected); let cursor = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const compressed = new Uint8Array(buffer, offsets[i], byteCounts[Math.min(i, byteCounts.length - 1)]);
    let decoded;
    const remaining = expected - cursor;
    if (compression === 1) decoded = compressed;
    else if (compression === 32773) decoded = packBitsDecode(compressed, remaining);
    else if (compression === 5) decoded = lzwDecode(compressed, remaining);
    else if (compression === 8 || compression === 32946) decoded = await deflateDecode(compressed);
    else throw new Error(`暂不支持 TIFF 压缩类型 ${compression}`);
    raw.set(decoded.subarray(0, remaining), cursor); cursor += Math.min(decoded.length, remaining);
  }
  const rawView = new DataView(raw.buffer); const values = new Float64Array(width * height * samples);
  for (let i = 0; i < values.length; i += 1) {
    const offset = i * bytesPerSample;
    if (sampleFormat === 3) values[i] = bits === 32 ? rawView.getFloat32(offset, little) : rawView.getFloat64(offset, little);
    else if (sampleFormat === 2) values[i] = bits === 8 ? rawView.getInt8(offset) : bits === 16 ? rawView.getInt16(offset, little) : rawView.getInt32(offset, little);
    else values[i] = bits === 8 ? rawView.getUint8(offset) : bits === 16 ? rawView.getUint16(offset, little) : rawView.getUint32(offset, little);
  }
  if (predictor === 2) {
    for (let y = 0; y < height; y += 1) for (let x = 1; x < width; x += 1) for (let s = 0; s < samples; s += 1) {
      const index = (y * width + x) * samples + s; values[index] += values[index - samples];
    }
  }
  const mono = new Float64Array(width * height);
  for (let i = 0; i < mono.length; i += 1) {
    if (samples === 1) mono[i] = values[i];
    else mono[i] = 0.2126 * values[i * samples] + 0.7152 * values[i * samples + 1] + 0.0722 * values[i * samples + 2];
  }
  const normalized = normalizeGray(mono);
  if (photometric === 0) for (let i = 0; i < normalized.values.length; i += 1) normalized.values[i] = 1 - normalized.values[i];
  const description = scalar(270, "");
  return {
    width, height, gray: normalized.values, format: "TIFF",
    metadata: { bits, compression, samples, sampleFormat, description, rawMin: normalized.min, rawMax: normalized.max },
    calibration: parseTiffDescriptionCalibration(description),
  };
}

async function loadTiff(file) {
  return parseTiffBuffer(await file.arrayBuffer(), file.name);
}

const DM_TYPE_SIZE = { 2: 2, 3: 4, 4: 2, 5: 4, 6: 4, 7: 8, 8: 1, 9: 1, 10: 1, 11: 8, 12: 8 };

export function parseDm3Buffer(buffer, fileName = "image.dm3") {
  const view = new DataView(buffer); let offset = 0; let tagCount = 0;
  const readU8 = () => view.getUint8(offset++);
  const readU16 = () => { const value = view.getUint16(offset, false); offset += 2; return value; };
  const readI32BE = () => { const value = view.getInt32(offset, false); offset += 4; return value; };
  const version = readI32BE();
  if (version !== 3) throw new Error(`检测到 DM${version}；当前读取器针对 DM3`);
  const declaredSize = readI32BE(); const byteOrder = readI32BE(); const dataLittle = byteOrder === 1;
  const scalars = new Map(); const arrays = [];
  const readPrimitive = (type, position, little = dataLittle) => {
    if (type === 2) return view.getInt16(position, little);
    if (type === 3) return view.getInt32(position, little);
    if (type === 4) return view.getUint16(position, little);
    if (type === 5) return view.getUint32(position, little);
    if (type === 6) return view.getFloat32(position, little);
    if (type === 7) return view.getFloat64(position, little);
    if (type === 8 || type === 9 || type === 10) return view.getUint8(position);
    if (type === 11) return Number(view.getBigUint64(position, little));
    if (type === 12) return Number(view.getBigInt64(position, little));
    throw new Error(`未知 DM3 基础类型 ${type}`);
  };
  const parseGroup = (path, depth = 0) => {
    if (depth > 64) throw new Error("DM3 标签嵌套过深");
    readU8(); readU8(); const count = readI32BE();
    if (count < 0 || count > 1_000_000) throw new Error("DM3 标签数量异常");
    for (let index = 0; index < count; index += 1) {
      if (++tagCount > 2_000_000) throw new Error("DM3 标签过多");
      const kind = readU8(); const labelLength = readU16();
      const label = new TextDecoder("latin1").decode(new Uint8Array(buffer, offset, labelLength)); offset += labelLength;
      const childPath = path ? `${path}/${label || index}` : (label || String(index));
      if (kind === 20) { parseGroup(childPath, depth + 1); continue; }
      if (kind !== 21) throw new Error(`未知 DM3 标签类型 ${kind}`);
      offset += 4; // "%%%%"
      const infoCount = readI32BE();
      if (infoCount <= 0 || infoCount > 256) throw new Error("DM3 标签描述异常");
      const info = Array.from({ length: infoCount }, readI32BE);
      const type = info[0];
      if (DM_TYPE_SIZE[type]) {
        scalars.set(childPath, readPrimitive(type, offset)); offset += DM_TYPE_SIZE[type];
      } else if (type === 18) {
        const length = info.at(-1); const bytes = new Uint8Array(buffer, offset, length * 2);
        let text = ""; for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(dataLittle ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
        scalars.set(childPath, text); offset += bytes.length;
      } else if (type === 20 && DM_TYPE_SIZE[info[1]]) {
        const elementType = info[1]; const length = info.at(-1); const byteLength = length * DM_TYPE_SIZE[elementType];
        if (/\/Units$/i.test(childPath) && length < 128) {
          let text = "";
          for (let i = 0; i < length; i += 1) text += String.fromCharCode(readPrimitive(elementType, offset + i * DM_TYPE_SIZE[elementType]));
          scalars.set(childPath, text.replace(/\0+$/, ""));
        } else arrays.push({ path: childPath, offset, length, byteLength, elementType });
        offset += byteLength;
      } else if (type === 15) {
        const fields = info[2]; let byteLength = 0;
        for (let field = 0, cursor = 3; field < fields; field += 1, cursor += 2) {
          const fieldType = info[cursor + 1];
          if (!DM_TYPE_SIZE[fieldType]) throw new Error(`DM3 结构包含未知类型 ${fieldType}`);
          byteLength += DM_TYPE_SIZE[fieldType];
        }
        offset += byteLength;
      } else if (type === 20 && info[1] === 15) {
        const fields = info[3]; let itemSize = 0;
        for (let field = 0, cursor = 4; field < fields; field += 1, cursor += 2) {
          const fieldType = info[cursor + 1];
          if (!DM_TYPE_SIZE[fieldType]) throw new Error(`DM3 结构数组包含未知类型 ${fieldType}`);
          itemSize += DM_TYPE_SIZE[fieldType];
        }
        offset += itemSize * info.at(-1);
      } else {
        throw new Error(`DM3 中出现暂不支持的复合标签（类型 ${type}）`);
      }
      if (offset > buffer.byteLength) throw new Error("DM3 标签超出文件边界");
    }
  };
  parseGroup("");
  const candidates = arrays.filter((entry) => /\/ImageData\/Data$/i.test(entry.path));
  const image = candidates.sort((a, b) => b.length - a.length)[0];
  if (!image) throw new Error("DM3 中没有找到 ImageData/Data");
  const base = image.path.replace(/\/Data$/i, "");
  const dimensions = [...scalars.entries()]
    .filter(([path]) => path.startsWith(`${base}/Dimensions/`))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => Number(value)).filter((value) => value > 0);
  let width = dimensions[0]; let height = dimensions[1];
  if (!width || !height || width * height > image.length) {
    const side = Math.round(Math.sqrt(image.length));
    if (side * side !== image.length) throw new Error("无法确定 DM3 图像尺寸");
    width = side; height = side;
  }
  const values = new Float64Array(width * height);
  for (let i = 0; i < values.length; i += 1) values[i] = readPrimitive(image.elementType, image.offset + i * DM_TYPE_SIZE[image.elementType]);
  const normalized = normalizeGray(values);
  const scaleEntries = [...scalars.entries()].filter(([path]) => path.startsWith(`${base}/Calibrations/Dimension/`) && /\/Scale$/i.test(path));
  const unitEntries = [...scalars.entries()].filter(([path]) => path.startsWith(`${base}/Calibrations/Dimension/`) && /\/Units$/i.test(path));
  let calibration = null;
  if (scaleEntries.length && unitEntries.length) {
    const scale = Number(scaleEntries[0][1]); const unit = String(unitEntries[0][1]).trim().toLowerCase();
    if (/1\s*\/\s*(?:nm|n\s*m)|nm\s*\^?-1/.test(unit)) {
      calibration = { reciprocalPerPixelAngstrom: scale / 10, source: "DM3 metadata", suggestedMode: "saed" };
    } else if (/1\s*\/\s*(?:å|a\b)|(?:å|a)\s*\^?-1/.test(unit)) {
      calibration = { reciprocalPerPixelAngstrom: scale, source: "DM3 metadata", suggestedMode: "saed" };
    } else {
      const pixelSizeAngstrom = unit.includes("nm") ? scale * 10 : unit.includes("pm") ? scale / 100 : unit.includes("å") || unit === "a" ? scale : null;
      if (pixelSizeAngstrom > 0) calibration = { pixelSizeAngstrom, source: "DM3 metadata", suggestedMode: "hrtem" };
    }
  }
  return {
    width, height, gray: normalized.values, format: "DM3", calibration,
    metadata: {
      version, declaredSize, byteOrder, imagePath: image.path, rawMin: normalized.min, rawMax: normalized.max,
      calibrationTags: [...scaleEntries, ...unitEntries, ...[...scalars.entries()].filter(([path]) => /\/Units$/i.test(path))]
        .map(([path, value]) => ({ path, value })),
    },
  };
}

export async function loadImageFile(file) {
  const extension = extensionOf(file.name);
  if (["jpg", "jpeg", "png", "webp", "bmp"].includes(extension)) return loadNativeImage(file);
  if (["tif", "tiff"].includes(extension)) return loadTiff(file);
  if (extension === "dm3") return parseDm3Buffer(await file.arrayBuffer(), file.name);
  // Last chance for a browser-supported image MIME type.
  if (file.type?.startsWith("image/")) return loadNativeImage(file);
  throw new Error(`不支持的图像格式：.${extension || "unknown"}`);
}

export function grayToImageData(gray, width, height, options = {}) {
  const gamma = Math.max(0.05, Number(options.gamma ?? 1));
  const invert = Boolean(options.invert);
  const image = new ImageData(width, height);
  for (let i = 0; i < gray.length; i += 1) {
    let value = Math.pow(Math.max(0, Math.min(1, gray[i])), 1 / gamma);
    if (invert) value = 1 - value;
    const byte = Math.round(value * 255); const p = i * 4;
    image.data[p] = byte; image.data[p + 1] = byte; image.data[p + 2] = byte; image.data[p + 3] = 255;
  }
  return image;
}
