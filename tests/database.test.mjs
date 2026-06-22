import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCif, parseJadeTxt } from "../database.js";
import { dSpacing, matchCard, planeAngle } from "../core.js";

const cif = `
data_NaCl
_chemical_formula_sum 'Na Cl'
_cell_length_a 5.6402
_cell_length_b 5.6402
_cell_length_c 5.6402
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_space_group_name_H-M_alt 'F m -3 m'
_space_group_crystal_system cubic
`;
const phase = parseCif(cif, "nacl.cif", { hMax: 3 });
assert.equal(phase.cell.a, 5.6402);
assert.deepEqual(phase.elements, ["Cl", "Na"]);
assert.equal(phase.crystalSystem, "Cubic");
assert.ok(phase.reflections.length > 0);

const hkl1 = [1, 0, 0]; const hkl3 = [0, 1, 0]; const hkl2 = [1, 1, 0];
const measurement = {
  d1: dSpacing(hkl1, phase.cell), d2: dSpacing(hkl2, phase.cell), d3: dSpacing(hkl3, phase.cell),
  phi12: planeAngle(hkl1, hkl2, phase.cell), phi23: planeAngle(hkl2, hkl3, phase.cell),
  dSigma: [0, 0, 0], phiSigma: [0, 0],
};
assert.ok(matchCard(phase, measurement, { distanceTolerance: 0.001, angleTolerance: 0.01 }).length > 0);

const jadePath = fileURLToPath(new URL("../../test data sand/PDF#43-1290(22).txt", import.meta.url));
if (existsSync(jadePath)) {
  const jade = parseJadeTxt(readFileSync(jadePath, "utf8"), "PDF#43-1290(22).txt");
  assert.equal(jade.crystalSystem, "Cubic"); assert.equal(jade.cell.a, 4.211); assert.equal(jade.reflections.length, 17);
  assert.deepEqual(jade.elements, ["Nb", "O"]);
}
console.log("database tests passed");
