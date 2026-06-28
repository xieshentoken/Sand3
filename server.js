import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CrystalDatabase } from "./database-service.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8768);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const databasePath = join(root, "database", "sand3.sqlite");
const database = new CrystalDatabase(databasePath);
const execFileAsync = promisify(execFile);

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request, maxBytes = 100_000_000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("请求数据过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBuffer(request, maxBytes = 500_000_000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("请求数据过大"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function decodeTiffWithSystem(request, response) {
  if (process.platform !== "darwin") return sendJson(response, 501, { error: "RGB JPEG-in-TIFF 原生解码当前仅支持 macOS sips" });
  const input = await readBuffer(request);
  const directory = mkdtempSync(join(tmpdir(), "sand3-tiff-"));
  const inputPath = join(directory, "input.tif"); const outputPath = join(directory, "output.png");
  try {
    writeFileSync(inputPath, input);
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", inputPath, "--out", outputPath], { timeout: 120000, maxBuffer: 2_000_000 });
    const png = readFileSync(outputPath);
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    response.end(png); return true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function api(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/image/decode-tiff") return decodeTiffWithSystem(request, response);
  if (request.method === "GET" && url.pathname === "/api/database/stats") return sendJson(response, 200, database.stats());
  if (request.method === "GET" && url.pathname === "/api/database/phase") {
    const phase = database.getPhase(url.searchParams.get("id") || url.searchParams.get("pdf") || "");
    return phase ? sendJson(response, 200, phase) : sendJson(response, 404, { error: "未找到对应卡片" });
  }
  if (request.method === "DELETE" && url.pathname === "/api/database") { database.clear(); return sendJson(response, 200, database.stats()); }
  if (request.method === "POST" && url.pathname === "/api/database/phases") {
    const body = await readJson(request); database.savePhases(body.phases || [], body.source || null);
    return sendJson(response, 200, { saved: body.phases?.length || 0 });
  }
  if (request.method === "POST" && url.pathname === "/api/database/query") {
    return sendJson(response, 200, database.query(await readJson(request, 2_000_000)));
  }
  if (request.method === "POST" && url.pathname === "/api/database/search") {
    const body = await readJson(request, 2_000_000);
    return sendJson(response, 200, database.searchSummaries(body.filter || {}, body.limit));
  }
  if (request.method === "POST" && url.pathname === "/api/database/import-pdf2") {
    const size = Number(url.searchParams.get("size") || request.headers["content-length"] || 0);
    if (!size || size % 80 !== 0) throw new Error("PDF2.DAT 文件大小必须是 80 字节记录的整数倍");
    const source = { name: url.searchParams.get("name") || "pdf2.dat", size, lastModified: Number(url.searchParams.get("lastModified") || 0) };
    const fingerprint = `${source.name}:${source.size}:${source.lastModified}`;
    const existing = database.stats().sources.find((item) => item.fingerprint === fingerprint);
    if (existing && url.searchParams.get("force") !== "1" && database.hasRawPdf2Records()) { request.resume(); return sendJson(response, 200, { ...existing, skipped: true }); }
    const session = database.beginPdf2(source);
    try { for await (const chunk of request) session.write(chunk); return sendJson(response, 200, session.finish()); }
    catch (error) { session.abort(); throw error; }
  }
  return false;
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try { if (url.pathname.startsWith("/api/")) { const handled = await api(request, response, url); if (handled !== false) return; } }
  catch (error) { sendJson(response, 500, { error: error.message }); return; }
  const pathname = decodeURIComponent(url.pathname);
  const candidate = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!candidate.startsWith(root)) { response.writeHead(403); response.end("Forbidden"); return; }
  try {
    if (!statSync(candidate).isFile()) throw new Error("not file");
    response.writeHead(200, { "Content-Type": types[extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(candidate).pipe(response);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(port, "127.0.0.1", () => {
  console.log(`Sand3 Industrial running at http://127.0.0.1:${port}`);
  console.log(`Database: ${databasePath}`);
});
