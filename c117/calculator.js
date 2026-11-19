/*!
 * C117 单片段同源重组加样计算器 —— 纯计算内核
 *
 * 与 cloning_calculator_v2.py 逐行对应，浏览器与 Node 通用 (UMD)。
 * 所有公式、分支、提示文案、取整方式均与 Python 版保持一致，
 * 由 tests/parity.test.js 用 Python 生成的基准用例逐字段校验。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.C117 = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- 固定反应体系 ----
  var CE_MIX_VOL = 5.0;        // 2x CE Mix V3 固定体积 (uL)
  var DNA_REGION_VOL = 5.0;    // Vector + Insert + ddH2O 合计体积 (uL)
  var TOTAL_VOL = 10.0;        // 最终反应总体积 (uL)

  // ---- 说明书质量公式 ----
  var MASS_MIN = 10.0;         // 建议质量下限 (ng)
  var MASS_MAX = 100.0;        // 建议质量上限 (ng)
  var VECTOR_COEF = 0.02;      // ng/bp
  var INSERT_COEF = 0.04;      // ng/bp

  // ---- 默认参数 ----
  var DEFAULT_MIN_PIPETTE_VOL = 1.0;
  var DEFAULT_DILUTION_FINAL_VOL = 30.0;

  var EPS = 1e-9;

  /* ------------------------------------------------------------------ *
   * 与 C printf("%.*f") 一致的定点格式化（round-half-even）。
   * 避免 0.125 这类二进制可精确表示的值在 JS toFixed（half-up）与
   * Python %（half-even）之间出现 0.12 / 0.13 的差异。
   * ------------------------------------------------------------------ */
  function pyFixed(value, digits) {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";

    var negative = value < 0;
    var x = Math.abs(value);

    // 拆解 double: x = mantissa * 2^exponent
    var buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, x);
    var hi = buf.getUint32(0);
    var lo = buf.getUint32(4);
    var expBits = (hi >>> 20) & 0x7ff;
    var mantissa;
    var exponent;
    if (expBits === 0) {
      exponent = -1074;
      mantissa = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
    } else {
      exponent = expBits - 1075;
      mantissa = (BigInt((hi & 0xfffff) | 0x100000) << BigInt(32)) | BigInt(lo);
    }

    // x * 10^digits = mantissa * 5^digits * 2^(exponent + digits)
    var num = mantissa * (BigInt(5) ** BigInt(digits));
    var shift = exponent + digits;
    var scaled;
    if (shift >= 0) {
      scaled = num << BigInt(shift);
    } else {
      var denom = BigInt(1) << BigInt(-shift);
      var q = num / denom;
      var r = num % denom;
      var twice = r * BigInt(2);
      if (twice > denom) scaled = q + BigInt(1);
      else if (twice < denom) scaled = q;
      else scaled = q % BigInt(2) === BigInt(0) ? q : q + BigInt(1);
    }

    var text = scaled.toString();
    if (digits > 0) {
      text = text.padStart(digits + 1, "0");
      text = text.slice(0, -digits) + "." + text.slice(-digits);
    }
    if (negative && scaled !== BigInt(0)) text = "-" + text;
    return text;
  }

  function fmt2(x) { return pyFixed(x, 2); }
  function fmt4(x) { return pyFixed(x, 4); }

  function fmtLen(x) {
    return Math.abs(x - Math.round(x)) < 1e-9 ? pyFixed(x, 0) : fmt2(x);
  }

  /* ------------------------------------------------------------------ *
   * 1. 理论质量
   * ------------------------------------------------------------------ */
  function calcTheoryMass(vectorLen, insertLen) {
    if (insertLen > vectorLen) {
      return {
        vectorMass: INSERT_COEF * vectorLen,
        insertMass: VECTOR_COEF * insertLen,
        swapped: true
      };
    }
    return {
      vectorMass: VECTOR_COEF * vectorLen,
      insertMass: INSERT_COEF * insertLen,
      swapped: false
    };
  }

  function clamp(x) {
    return Math.max(MASS_MIN, Math.min(MASS_MAX, x));
  }

  /* ------------------------------------------------------------------ *
   * 2. 质量归一化（优先同一系数）
   * ------------------------------------------------------------------ */
  function normalizeMassPair(vectorMass, insertMass) {
    var lo = Math.min(vectorMass, insertMass);
    var hi = Math.max(vectorMass, insertMass);
    if (lo <= 0) throw new Error("DNA 理论质量必须大于 0");

    var lower = MASS_MIN / lo;   // 把较小者抬到下限所需系数
    var upper = MASS_MAX / hi;   // 把较大者压到上限允许的最大系数
    if (lower > upper + EPS) {
      return {
        vectorTarget: clamp(vectorMass),
        insertTarget: clamp(insertMass),
        factor: null,
        common: false
      };
    }
    var factor = Math.min(Math.max(1.0, lower), upper);
    return {
      vectorTarget: vectorMass * factor,
      insertTarget: insertMass * factor,
      factor: factor,
      common: true
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. 体积分配（5 uL 上限 + 最小加样体积）
   * ------------------------------------------------------------------ */
  function planDnaVolumes(vectorMass, insertMass, vectorConc, insertConc, minVol) {
    var vTheo = vectorMass / vectorConc;
    var iTheo = insertMass / insertConc;
    var totalTheo = vTheo + iTheo;
    var limit = DNA_REGION_VOL;
    var overLimit;
    var vVol;
    var iVol;
    var note;

    if (totalTheo <= limit + EPS) {
      overLimit = false;
      vVol = Math.max(vTheo, minVol);
      iVol = Math.max(iTheo, minVol);
      var raisedV = vVol > vTheo + EPS;
      var raisedI = iVol > iTheo + EPS;
      var raiseParts = [];
      if (raisedV) {
        raiseParts.push("Vector 理论体积 " + fmt2(vTheo) + " uL 低于最小加样体积 " +
          fmt2(minVol) + " uL，已抬高至 " + fmt2(vVol) + " uL");
      }
      if (raisedI) {
        raiseParts.push("Insert 理论体积 " + fmt2(iTheo) + " uL 低于最小加样体积 " +
          fmt2(minVol) + " uL，已抬高至 " + fmt2(iVol) + " uL");
      }

      if (vVol + iVol > limit + EPS) {
        if (raisedV && !raisedI) {
          iVol = limit - vVol;
          note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 不超过 " + fmt2(limit) +
            " uL；" + raiseParts[0] + "，Insert 相应压缩至 " + fmt2(iVol) + " uL";
        } else if (raisedI && !raisedV) {
          vVol = limit - iVol;
          note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 不超过 " + fmt2(limit) +
            " uL；" + raiseParts[0] + "，Vector 相应压缩至 " + fmt2(vVol) + " uL";
        } else {
          var scale = limit / (vVol + iVol);
          vVol *= scale;
          iVol *= scale;
          note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 不超过 " + fmt2(limit) +
            " uL，但两种 DNA 均低于最小加样体积，按体积比例分配到合计 " + fmt2(limit) + " uL";
        }
      } else if (raiseParts.length) {
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 不超过 " + fmt2(limit) +
          " uL，保留理论质量；" + raiseParts.join("；");
      } else {
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 不超过 " + fmt2(limit) +
          " uL，直接保留理论质量和理论体积";
      }
    } else {
      overLimit = true;
      var k = limit / totalTheo;
      vVol = vTheo * k;
      iVol = iTheo * k;

      if (vVol < minVol - EPS && iVol < minVol - EPS) {
        vVol = limit / 2.0;
        iVol = limit / 2.0;
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 超过 " + fmt2(limit) +
          " uL，两种 DNA 按比例缩小后均低于最小加样体积，各分配 " + fmt2(limit / 2.0) + " uL";
      } else if (vVol < minVol - EPS) {
        vVol = minVol;
        iVol = limit - minVol;
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 超过 " + fmt2(limit) +
          " uL；按比例缩小后 Vector 仅 " + fmt2(vTheo * k) + " uL (< 最小加样体积 " +
          fmt2(minVol) + " uL)，固定 Vector = " + fmt2(vVol) + " uL，余量 " +
          fmt2(iVol) + " uL 全部分配给 Insert";
      } else if (iVol < minVol - EPS) {
        iVol = minVol;
        vVol = limit - minVol;
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 超过 " + fmt2(limit) +
          " uL；按比例缩小后 Insert 仅 " + fmt2(iTheo * k) + " uL (< 最小加样体积 " +
          fmt2(minVol) + " uL)，固定 Insert = " + fmt2(iVol) + " uL，余量 " +
          fmt2(vVol) + " uL 全部分配给 Vector";
      } else {
        note = "理论 DNA 总体积 " + fmt2(totalTheo) + " uL 超过 " + fmt2(limit) +
          " uL，两种 DNA 按体积比例 " + fmt4(k) + " 同时缩小到合计 " + fmt2(limit) +
          " uL（均不低于最小加样体积 " + fmt2(minVol) + " uL）";
      }
    }

    // 数值保护：体积必须落在 [0, 5] 内
    vVol = Math.max(0.0, Math.min(limit, vVol));
    iVol = Math.max(0.0, Math.min(limit - vVol, iVol));

    return {
      vector_theo_vol: vTheo,
      insert_theo_vol: iTheo,
      total_theo_vol: totalTheo,
      vector_vol: vVol,
      insert_vol: iVol,
      over_limit: overLimit,
      note: note
    };
  }

  /* ------------------------------------------------------------------ *
   * 4. 稀释方案 C1 x V1 = C2 x V2
   * ------------------------------------------------------------------ */
  function planDilution(stockConc, workConc, finalVol) {
    var plan = {
      needed: false,
      stock_conc: stockConc,
      work_conc: workConc,
      final_vol: finalVol,
      stock_vol: 0.0,
      water_vol: 0.0,
      fold: 1.0,
      error: null
    };
    if (workConc <= 0) {
      plan.needed = null;
      plan.error = "目标工作液浓度为 0，无法用母液配制";
      return plan;
    }
    if (workConc > stockConc + EPS) {
      plan.needed = null;
      plan.error = "目标工作液浓度 " + fmt2(workConc) + " ng/uL 高于母液浓度 " +
        fmt2(stockConc) + " ng/uL，不能靠稀释实现";
      return plan;
    }
    if (Math.abs(workConc - stockConc) <= EPS) {
      return plan;
    }
    var stockVol = workConc * finalVol / stockConc;
    plan.needed = true;
    plan.stock_vol = Math.max(0.0, Math.min(finalVol, stockVol));
    plan.water_vol = finalVol - plan.stock_vol;
    plan.fold = stockConc / workConc;
    return plan;
  }

  /* ------------------------------------------------------------------ *
   * 5. 主计算
   * ------------------------------------------------------------------ */
  function compute(opts) {
    var vectorLen = opts.vectorLen;
    var vectorConc = opts.vectorConc;
    var insertLen = opts.insertLen;
    var insertConc = opts.insertConc;
    var minPipetteVol = opts.minPipetteVol === undefined || opts.minPipetteVol === null
      ? DEFAULT_MIN_PIPETTE_VOL : opts.minPipetteVol;
    var dilutionFinalVol = opts.dilutionFinalVol === undefined || opts.dilutionFinalVol === null
      ? DEFAULT_DILUTION_FINAL_VOL : opts.dilutionFinalVol;

    var inputs = [
      ["--vector-len (bp)", vectorLen],
      ["--vector-conc (ng/uL)", vectorConc],
      ["--insert-len (bp)", insertLen],
      ["--insert-conc (ng/uL)", insertConc]
    ];
    for (var i = 0; i < inputs.length; i += 1) {
      var label = inputs[i][0];
      var value = inputs[i][1];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(label + " 必须为大于 0 的有限数值，当前为 " + value);
      }
    }

    if (!Number.isFinite(minPipetteVol) || minPipetteVol <= 0) {
      throw new Error("--min-pipette-vol 必须为大于 0 的有限数值，当前为 " + minPipetteVol);
    }
    if (2.0 * minPipetteVol > DNA_REGION_VOL + EPS) {
      throw new Error("--min-pipette-vol " + fmt2(minPipetteVol) +
        " uL 过大：两种 DNA 各取最小体积合计 " + fmt2(2.0 * minPipetteVol) +
        " uL，已超过 DNA 加样区上限 " + fmt2(DNA_REGION_VOL) +
        " uL，无法同时满足；请降低该参数");
    }
    if (!Number.isFinite(dilutionFinalVol) || dilutionFinalVol <= 0) {
      throw new Error("--dilution-final-vol 必须为大于 0 的有限数值，当前为 " + dilutionFinalVol);
    }

    var warnings = [];

    // 1. 理论质量
    var theory = calcTheoryMass(vectorLen, insertLen);
    var vectorTheoMass = theory.vectorMass;
    var insertTheoMass = theory.insertMass;
    var swapped = theory.swapped;
    var vectorCoef = swapped ? INSERT_COEF : VECTOR_COEF;
    var insertCoef = swapped ? VECTOR_COEF : INSERT_COEF;

    // 2. 质量归一化
    var norm = normalizeMassPair(vectorTheoMass, insertTheoMass);
    var vectorTarget = norm.vectorTarget;
    var insertTarget = norm.insertTarget;
    var normFactor = norm.factor;
    var normCommon = norm.common;

    if (!normCommon) {
      warnings.push(
        "两种 DNA 的理论质量相差超过 " + pyFixed(MASS_MAX / MASS_MIN, 0) +
        " 倍（Vector " + fmt2(vectorTheoMass) + " ng / Insert " + fmt2(insertTheoMass) +
        " ng），无法用同一系数同时落入 " + pyFixed(MASS_MIN, 0) + "-" + pyFixed(MASS_MAX, 0) +
        " ng，已分别钳制；此情况下的目标质量比与理论质量比不同"
      );
    }

    // 3. 理论体积 + 体积分配
    var volumes = planDnaVolumes(vectorTarget, insertTarget, vectorConc, insertConc, minPipetteVol);
    var vectorVol = volumes.vector_vol;
    var insertVol = volumes.insert_vol;

    // 4. 统一质量缩放系数 s
    var caps = [1.0];
    caps.push(vectorConc * vectorVol / vectorTarget);
    caps.push(insertConc * insertVol / insertTarget);
    var massScale = Math.max(0.0, Math.min.apply(null, caps));
    massScale = Math.min(1.0, massScale);

    var vectorMass = vectorTarget * massScale;
    var insertMass = insertTarget * massScale;

    // 5. 工作液浓度
    var vectorWorkConc = vectorVol > EPS ? vectorMass / vectorVol : 0.0;
    var insertWorkConc = insertVol > EPS ? insertMass / insertVol : 0.0;

    var vectorDilution = planDilution(vectorConc, vectorWorkConc, dilutionFinalVol);
    var insertDilution = planDilution(insertConc, insertWorkConc, dilutionFinalVol);

    if (vectorDilution.needed === null) warnings.push("Vector: " + vectorDilution.error);
    if (insertDilution.needed === null) warnings.push("Insert: " + insertDilution.error);
    [["Vector", vectorDilution], ["Insert", insertDilution]].forEach(function (pair) {
      var name = pair[0];
      var plan = pair[1];
      if (plan.needed && plan.stock_vol < 0.5 - EPS) {
        warnings.push(name + " 工作液所需原始母液仅 " + fmt2(plan.stock_vol) +
          " uL，低于常规移液精度；建议增大 --dilution-final-vol 或先对母液做一次预稀释");
      }
    });

    // 6. 体系体积
    var dnaVol = vectorVol + insertVol;
    var waterVol = Math.max(0.0, DNA_REGION_VOL - dnaVol);
    var ceMixVol = CE_MIX_VOL;
    var totalVol = dnaVol + waterVol + ceMixVol;

    var targetRatio = vectorTarget / insertTarget;
    var actualRatio = insertMass > EPS ? vectorMass / insertMass : Infinity;

    if (Math.min(vectorMass, insertMass) < MASS_MIN - EPS) {
      warnings.push(
        "至少一种 DNA 的实际投入质量低于说明书建议下限 " + pyFixed(MASS_MIN, 0) +
        " ng（Vector " + fmt2(vectorMass) + " ng / Insert " + fmt2(insertMass) +
        " ng），可能降低重组效率"
      );
    }

    // 7. 校验
    var checks = [
      {
        name: "所有体积非负",
        detail: "Vector " + fmt2(vectorVol) + " / Insert " + fmt2(insertVol) +
          " / ddH2O " + fmt2(waterVol) + " uL 均 >= 0",
        ok: Math.min(vectorVol, insertVol, waterVol) >= -EPS
      },
      {
        name: "DNA 加样区合计 = 5.00 uL",
        detail: fmt2(vectorVol) + " (Vector) + " + fmt2(insertVol) + " (Insert) + " +
          fmt2(waterVol) + " (ddH2O) = " + fmt2(dnaVol + waterVol) + " uL",
        ok: Math.abs(dnaVol + waterVol - DNA_REGION_VOL) <= 1e-9
      },
      {
        name: "反应总体积 = 10.00 uL",
        detail: fmt2(dnaVol + waterVol) + " (DNA 区) + " + fmt2(ceMixVol) +
          " (2x CE Mix V3) = " + fmt2(totalVol) + " uL",
        ok: Math.abs(totalVol - TOTAL_VOL) <= 1e-9
      },
      {
        name: "质量比不变",
        detail: "实际 " + fmt4(actualRatio) + " : 1 / 目标 " + fmt4(targetRatio) + " : 1",
        ok: Math.abs(actualRatio - targetRatio) <= 1e-9 * Math.max(1.0, Math.abs(targetRatio))
      },
      {
        name: "每种 DNA 体积不低于最小加样体积",
        detail: "Vector " + fmt2(vectorVol) + " uL / Insert " + fmt2(insertVol) +
          " uL，最小 " + fmt2(minPipetteVol) + " uL",
        ok: Math.min(vectorVol, insertVol) >= minPipetteVol - EPS
      },
      {
        name: "工作液浓度可通过稀释母液获得",
        detail: "Vector " + fmt2(vectorWorkConc) + " <= " + fmt2(vectorConc) +
          " ng/uL；Insert " + fmt2(insertWorkConc) + " <= " + fmt2(insertConc) + " ng/uL",
        ok: vectorWorkConc <= vectorConc + EPS && insertWorkConc <= insertConc + EPS
      }
    ];

    return {
      vector_len: vectorLen,
      vector_conc: vectorConc,
      insert_len: insertLen,
      insert_conc: insertConc,
      min_pipette_vol: minPipetteVol,
      dilution_final_vol: dilutionFinalVol,
      swapped: swapped,
      vector_coef: vectorCoef,
      insert_coef: insertCoef,
      vector_theoretical_mass_ng: vectorTheoMass,
      insert_theoretical_mass_ng: insertTheoMass,
      vector_target_mass_ng: vectorTarget,
      insert_target_mass_ng: insertTarget,
      mass_norm_factor: normFactor,
      mass_norm_common: normCommon,
      vector_theoretical_vol_ul: volumes.vector_theo_vol,
      insert_theoretical_vol_ul: volumes.insert_theo_vol,
      dna_theoretical_vol_ul: volumes.total_theo_vol,
      vector_vol_ul: vectorVol,
      insert_vol_ul: insertVol,
      dna_vol_ul: dnaVol,
      water_vol_ul: waterVol,
      ce_mix_vol_ul: ceMixVol,
      total_vol_ul: totalVol,
      vector_mass_ng: vectorMass,
      insert_mass_ng: insertMass,
      mass_scale: massScale,
      vector_work_conc_ng_ul: vectorWorkConc,
      insert_work_conc_ng_ul: insertWorkConc,
      vector_dilution: vectorDilution,
      insert_dilution: insertDilution,
      target_ratio: targetRatio,
      actual_ratio: actualRatio,
      volume_note: volumes.note,
      over_limit: volumes.over_limit,
      checks: checks,
      warnings: warnings
    };
  }

  return {
    CE_MIX_VOL: CE_MIX_VOL,
    DNA_REGION_VOL: DNA_REGION_VOL,
    TOTAL_VOL: TOTAL_VOL,
    MASS_MIN: MASS_MIN,
    MASS_MAX: MASS_MAX,
    VECTOR_COEF: VECTOR_COEF,
    INSERT_COEF: INSERT_COEF,
    DEFAULT_MIN_PIPETTE_VOL: DEFAULT_MIN_PIPETTE_VOL,
    DEFAULT_DILUTION_FINAL_VOL: DEFAULT_DILUTION_FINAL_VOL,
    pyFixed: pyFixed,
    fmtLen: fmtLen,
    calcTheoryMass: calcTheoryMass,
    normalizeMassPair: normalizeMassPair,
    planDnaVolumes: planDnaVolumes,
    planDilution: planDilution,
    compute: compute
  };
});
