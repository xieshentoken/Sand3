import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDm3Buffer, parseTiffBuffer } from "../image-io.js";

function arrayBufferOf(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const tiffPath = fileURLToPath(new URL("../../test data sand/Image_32.tif", import.meta.url));
if (existsSync(tiffPath)) {
  await assert.rejects(
    parseTiffBuffer(arrayBufferOf(readFileSync(tiffPath)), "Image_32.tif"),
    /JPEG 压缩 TIFF 需要浏览器图像解码器/,
  );
}

// Minimal uncompressed little-endian 2×2 8-bit TIFF.
const rawTiff = new ArrayBuffer(126); const tiffView = new DataView(rawTiff); const little = true;
tiffView.setUint8(0, 0x49); tiffView.setUint8(1, 0x49); tiffView.setUint16(2, 42, little); tiffView.setUint32(4, 8, little);
const entries = [[256,3,1,2],[257,3,1,2],[258,3,1,8],[259,3,1,1],[262,3,1,1],[273,4,1,122],[277,3,1,1],[278,4,1,2],[279,4,1,4]];
tiffView.setUint16(8, entries.length, little);
entries.forEach(([tag,type,count,value], index) => { const p=10+index*12; tiffView.setUint16(p,tag,little);tiffView.setUint16(p+2,type,little);tiffView.setUint32(p+4,count,little);if(type===3)tiffView.setUint16(p+8,value,little);else tiffView.setUint32(p+8,value,little); });
tiffView.setUint32(118,0,little); new Uint8Array(rawTiff,122,4).set([0,64,128,255]);
const rawImage = await parseTiffBuffer(rawTiff, "fixture.tif");
assert.equal(rawImage.width, 2); assert.equal(rawImage.height, 2); assert.equal(rawImage.gray[3], 1);

const dm3Path = fileURLToPath(new URL("../../test data sand/15.dm3", import.meta.url));
if (existsSync(dm3Path)) {
  const image = parseDm3Buffer(arrayBufferOf(readFileSync(dm3Path)), "15.dm3");
  assert.ok(image.width > 0 && image.height > 0);
  assert.equal(image.gray.length, image.width * image.height);
  assert.ok(image.gray.some((value) => value > 0));
  assert.ok(image.calibration.reciprocalPerPixelAngstrom > 0);
}

console.log("image I/O tests passed");
