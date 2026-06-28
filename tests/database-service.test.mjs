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
  const phase = database.getPhase("pdf2:P000001C");
  assert.equal(phase.pdfNumber, "00-0001");
  assert.equal(phase.dValues.length, 1);
  assert.equal(phase.hkls.length, 3);
  assert.ok(phase.rawCardText.includes("Synthetic phase"));
  assert.equal(phase.rawCardText.split("\n").length, 6);
  assert.equal(phase.rawReflections.length, 1);
  assert.equal(database.hasRawPdf2Records(), true);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2], dTolerances: [0.01], elementFilter: { required: ["Fe"], excluded: [] } }).length, 1);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2, 9], dTolerances: [0.01, 0.01] }).length, 0);
  assert.equal(database.query({ statuses: ["P"], indexedOnly: true, observedD: [2, 9], dTolerances: [0.01, 0.01], minObservedMatches: 1 }).length, 1);
  assert.equal(database.searchSummaries({ required: ["Fe"], excluded: [], statuses: ["P"] }).length, 1);
  assert.equal(database.searchSummaries({ required: ["H", "Fe"], logic: "and", statuses: ["P"] }).length, 0);
  assert.equal(database.searchSummaries({ required: ["H", "Fe"], logic: "or", statuses: ["P"] }).length, 1);
  const smallCell = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };
  const smallReflection = [{ d: 2, h: 1, k: 0, l: 0 }];
  database.savePhases([
    { id: "phase:li", status: "P", name: "Li", formula: "Li", elements: ["Li"], indexed: true, cell: smallCell, reflections: smallReflection },
    { id: "phase:li-o", status: "P", name: "Li O", formula: "Li O", elements: ["Li", "O"], indexed: true, cell: smallCell, reflections: smallReflection },
    { id: "phase:li-s", status: "P", name: "Li S", formula: "Li S", elements: ["Li", "S"], indexed: true, cell: smallCell, reflections: smallReflection },
    { id: "phase:li-o-s", status: "P", name: "Li O S", formula: "Li O S", elements: ["Li", "O", "S"], indexed: true, cell: smallCell, reflections: smallReflection },
    { id: "phase:li-o-fe", status: "P", name: "Li O Fe", formula: "Li O Fe", elements: ["Li", "O", "Fe"], indexed: true, cell: smallCell, reflections: smallReflection },
  ]);
  const exact = database.searchSummaries({ statuses: ["P"], exactElementSets: [["Li"], ["Li", "O"], ["Li", "S"], ["Li", "O", "S"]] }, 20).map((phase) => phase.id).sort();
  assert.deepEqual(exact, ["phase:li", "phase:li-o", "phase:li-o-s", "phase:li-s"]);
  database.close();

  database = new CrystalDatabase(path);
  assert.equal(database.stats().phases, 6, "SQLite index should survive service restart");
  database.clear(); assert.equal(database.stats().phases, 0); database.close();
  console.log("database service tests passed");
} finally { rmSync(directory, { recursive: true, force: true }); }
