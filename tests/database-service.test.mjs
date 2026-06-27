import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrystalDatabase } from "../database-service.js";

const directory = mkdtempSync(join(tmpdir(), "sand3-db-"));
const path = join(directory, "database", "sand3.sqlite");
const tag = (code) => `P000001C${code}`;
const record = (data, code) => `${data.padEnd(71)}${tag(code)}`;
const slot = (d, intensity, h, k, l) => `${d.toFixed(3).padStart(7)}${String(intensity).padStart(3)} ${String(h).padStart(4)}${String(k).padStart(3)}${String(l).padStart(3)}  `;

try {
  let database = new CrystalDatabase(path);
  const content = [
    record("", "1"), record("Synthetic phase", "5"), record("Fe2 O3", "7"),
    record("4 4 4 90 90 90", "D"), record(slot(2, 100, 1, 0, 0), "I"), record("", "K"),
  ].join("");
  const session = database.beginPdf2({ name: "small.dat", size: Buffer.byteLength(content), lastModified: 1 });
  session.write(Buffer.from(content, "latin1"));
  const imported = session.finish();
  assert.equal(imported.cards, 1); assert.equal(imported.indexed, 1);
  assert.equal(database.stats().phases, 1);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2], dTolerances: [0.01], elementFilter: { required: ["Fe"], excluded: [] } }).length, 1);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2, 9], dTolerances: [0.01, 0.01] }).length, 0);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2, 9], dTolerances: [0.01, 0.01], minObservedMatches: 1 }).length, 1);
  assert.equal(database.searchSummaries({ required: ["Fe"], excluded: [], statuses: ["P"] }).length, 1);
  assert.equal(database.searchSummaries({ required: ["H", "Fe"], logic: "and", statuses: ["P"] }).length, 0);
  assert.equal(database.searchSummaries({ required: ["H", "Fe"], logic: "or", statuses: ["P"] }).length, 1);
  database.close();

  database = new CrystalDatabase(path);
  assert.equal(database.stats().phases, 1, "SQLite index should survive service restart");
  database.clear(); assert.equal(database.stats().phases, 0); database.close();
  console.log("database service tests passed");
} finally { rmSync(directory, { recursive: true, force: true }); }
