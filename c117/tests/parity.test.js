#!/usr/bin/env node
/**
 * 网页计算内核与 Python 版的逐字段一致性测试。
 *
 * 运行:
 *   node c117/tests/parity.test.js
 *
 * 基准数据由 export_web_fixtures.py 调用 cloning_calculator_v2.compute() 生成，
 * 覆盖任务书案例、手选边界、参数网格抽样与随机极端值。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const calc = require("../calculator.js");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));

let checked = 0;
const failures = [];

function fail(where, expected, actual) {
  failures.push({ where, expected, actual });
}

function compare(pathName, expected, actual) {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number") {
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        fail(pathName, expected, actual);
        return;
      }
      const tolerance = 1e-9 * Math.max(1.0, Math.abs(expected));
      if (Math.abs(actual - expected) > tolerance) fail(pathName, expected, actual);
      return;
    }
    if (expected !== actual) fail(pathName, expected, actual);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      fail(pathName, expected, actual);
      return;
    }
    expected.forEach((item, i) => compare(pathName + "[" + i + "]", item, actual[i]));
    return;
  }
  if (actual === null || typeof actual !== "object") {
    fail(pathName, expected, actual);
    return;
  }
  Object.keys(expected).forEach((key) =>
    compare(pathName + "." + key, expected[key], actual[key]));
}

data.cases.forEach((testCase, index) => {
  const [vectorLen, vectorConc, insertLen, insertConc, minVol, finalVol] = testCase.args;
  let res;
  try {
    res = calc.compute({
      vectorLen,
      vectorConc,
      insertLen,
      insertConc,
      minPipetteVol: minVol,
      dilutionFinalVol: finalVol
    });
  } catch (err) {
    fail("case[" + index + "].compute", testCase.args.join(", "), err.message);
    return;
  }

  compare("case[" + index + "].out", testCase.out, res);

  if (res.volume_note !== testCase.note) {
    fail("case[" + index + "].note", testCase.note, res.volume_note);
  }
  if (JSON.stringify(res.warnings) !== JSON.stringify(testCase.warnings)) {
    fail("case[" + index + "].warnings", testCase.warnings, res.warnings);
  }
  const okFlags = res.checks.map((c) => c.ok);
  if (JSON.stringify(okFlags) !== JSON.stringify(testCase.checks)) {
    fail("case[" + index + "].checks", testCase.checks, okFlags);
  }
  checked += 1;
});

/* ---------------- 定点格式化：必须与 C printf / Python % 一致 ---------------- */
const formatCases = [
  [0.125, "0.12"], [0.375, "0.38"], [0.625, "0.62"], [0.875, "0.88"],
  [2.5, "2"], [3.5, "4"], [0.005, "0.01"], [1.0, "1.00"], [0, "0.00"],
  [4.544999999999999, "4.54"], [12.345, "12.35"], [1e-7, "0.00"]
];
formatCases.forEach(([value, expected]) => {
  const digits = expected.indexOf(".") >= 0 ? expected.split(".")[1].length : 0;
  const actual = calc.pyFixed(value, digits);
  if (actual !== expected) fail("pyFixed(" + value + ", " + digits + ")", expected, actual);
  checked += 1;
});

/* ---------------- 任务书案例的显式断言 ---------------- */
(function specCase() {
  const r = calc.compute({
    vectorLen: 10000, vectorConc: 20, insertLen: 2500, insertConc: 50
  });
  const expectations = {
    vector_theoretical_mass_ng: 200,
    insert_theoretical_mass_ng: 100,
    vector_target_mass_ng: 100,
    insert_target_mass_ng: 50,
    vector_theoretical_vol_ul: 5,
    insert_theoretical_vol_ul: 1,
    dna_theoretical_vol_ul: 6,
    vector_vol_ul: 4,
    insert_vol_ul: 1,
    water_vol_ul: 0,
    mass_scale: 0.8,
    vector_mass_ng: 80,
    insert_mass_ng: 40,
    vector_work_conc_ng_ul: 20,
    insert_work_conc_ng_ul: 40,
    total_vol_ul: 10,
    actual_ratio: 2,
    target_ratio: 2
  };
  Object.keys(expectations).forEach((key) => {
    const exp = expectations[key];
    if (Math.abs(r[key] - exp) > 1e-9) fail("spec." + key, exp, r[key]);
    checked += 1;
  });
  if (r.insert_dilution.stock_vol !== 24 || r.insert_dilution.water_vol !== 6) {
    fail("spec.insert_dilution", [24, 6],
      [r.insert_dilution.stock_vol, r.insert_dilution.water_vol]);
  }
  if (r.vector_dilution.needed !== false || r.insert_dilution.needed !== true) {
    fail("spec.dilution_needed", [false, true],
      [r.vector_dilution.needed, r.insert_dilution.needed]);
  }
  checked += 2;
})();

/* ---------------- 非法输入：与 Python 一样抛错 ---------------- */
const invalid = [
  { vectorLen: 0, vectorConc: 20, insertLen: 2500, insertConc: 50 },
  { vectorLen: -1, vectorConc: 20, insertLen: 2500, insertConc: 50 },
  { vectorLen: 10000, vectorConc: 0, insertLen: 2500, insertConc: 50 },
  { vectorLen: 10000, vectorConc: 20, insertLen: 2500, insertConc: -5 },
  { vectorLen: NaN, vectorConc: 20, insertLen: 2500, insertConc: 50 },
  { vectorLen: Infinity, vectorConc: 20, insertLen: 2500, insertConc: 50 },
  { vectorLen: 10000, vectorConc: 20, insertLen: 2500, insertConc: 50, minPipetteVol: 0 },
  { vectorLen: 10000, vectorConc: 20, insertLen: 2500, insertConc: 50, minPipetteVol: 3 },
  { vectorLen: 10000, vectorConc: 20, insertLen: 2500, insertConc: 50, dilutionFinalVol: 0 }
];
invalid.forEach((opts, i) => {
  let threw = false;
  try {
    calc.compute(opts);
  } catch (err) {
    threw = true;
  }
  if (!threw) fail("invalid[" + i + "]", "throw", "no throw");
  checked += 1;
});

/* ---------------- 输出 ---------------- */
if (failures.length) {
  console.error("FAIL: " + failures.length + " mismatches / " + checked + " checks");
  failures.slice(0, 15).forEach((f) => {
    console.error("  - " + f.where + "\n      expected: " + JSON.stringify(f.expected) +
      "\n      actual  : " + JSON.stringify(f.actual));
  });
  if (failures.length > 15) console.error("  ... 其余 " + (failures.length - 15) + " 条省略");
  process.exit(1);
}
console.log("OK: " + checked + " checks, " + data.cases.length + " fixtures, 0 mismatches");
