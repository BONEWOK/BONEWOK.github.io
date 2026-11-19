/* C117 加样计算器 —— 页面交互层
   只负责读写表单、调用 C117.compute()、渲染结果与复制文本。
   计算逻辑全部在 calculator.js 中，由 tests/parity.test.js 与 Python 版比对。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var form = $("calc-form");
  var resultsBox = $("results");
  var errorBox = $("error");
  var toast = $("toast");

  var fields = {
    vectorLen: $("vl"),
    vectorConc: $("vc"),
    insertLen: $("il"),
    insertConc: $("ic"),
    minPipetteVol: $("mp"),
    dilutionFinalVol: $("df")
  };

  var DEFAULT_MIN_PIPETTE = 1.0;
  var DEFAULT_DILUTION_FINAL = 30.0;

  var current = null;         // 最近一次成功的结果
  var toastTimer = null;

  var f2 = function (x) { return C117.pyFixed(x, 2); };
  var f4 = function (x) { return C117.pyFixed(x, 4); };
  var f6 = function (x) { return C117.pyFixed(x, 6); };
  var fLen = C117.fmtLen;

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function num(input, fallback) {
    var raw = input.value.trim();
    if (raw === "") return fallback === undefined ? NaN : fallback;
    var value = Number(raw);
    return Number.isFinite(value) ? value : NaN;
  }

  function gather() {
    var params = {
      vectorLen: num(fields.vectorLen),
      vectorConc: num(fields.vectorConc),
      insertLen: num(fields.insertLen),
      insertConc: num(fields.insertConc),
      minPipetteVol: num(fields.minPipetteVol, DEFAULT_MIN_PIPETTE),
      dilutionFinalVol: num(fields.dilutionFinalVol, DEFAULT_DILUTION_FINAL)
    };
    if ([params.vectorLen, params.vectorConc, params.insertLen, params.insertConc]
      .some(function (value) { return Number.isNaN(value); })) {
      throw new Error("请填写 Vector 与 Insert 的长度和母液浓度（均须为正数）");
    }
    return params;
  }

  /* ---------------- 展示小工具 ---------------- */
  function b(value, digits) {
    return "<b>" + C117.pyFixed(value, digits) + "</b>";
  }

  function withUnit(value, digits, unit, hint) {
    return b(value, digits) + (unit ? ' <span class="unit">' + unit + "</span>" : "") +
      (hint ? ' <span class="hint">' + esc(hint) + "</span>" : "");
  }

  function row(label, valueHTML) {
    return '<div class="row"><dt>' + label + "</dt><dd>" + valueHTML + "</dd></div>";
  }

  function card(index, title, body, extraClass) {
    return '<section class="card' + (extraClass ? " " + extraClass : "") + '">' +
      '<h2><span class="idx">' + index + "</span>" + title + "</h2>" + body + "</section>";
  }

  function stat(label, valueHTML, sub) {
    return '<div class="stat"><div class="stat-k">' + label + "</div>" +
      '<div class="stat-v">' + valueHTML + "</div>" +
      '<div class="stat-s">' + sub + "</div></div>";
  }

  /* ---------------- 各结果卡片 ---------------- */
  function cardTheory(res) {
    var swapped = res.swapped;
    var body = '<div class="subhead">理论质量（C117 说明书公式）</div><dl class="rows">';
    body += row("Vector 长度 / 母液浓度",
      fLen(res.vector_len) + " bp / " + b(res.vector_conc, 2) + " ng/μL");
    body += row("Insert 长度 / 母液浓度",
      fLen(res.insert_len) + " bp / " + b(res.insert_conc, 2) + " ng/μL");
    body += row("Vector 理论质量", withUnit(res.vector_theoretical_mass_ng, 2, "ng",
      C117.pyFixed(res.vector_coef, 2) + " ng/bp × " + fLen(res.vector_len) + " bp"));
    body += row("Insert 理论质量", withUnit(res.insert_theoretical_mass_ng, 2, "ng",
      C117.pyFixed(res.insert_coef, 2) + " ng/bp × " + fLen(res.insert_len) + " bp"));
    body += "</dl>";

    if (swapped) {
      body += '<p class="note">Insert 长度 &gt; Vector 长度，两个质量系数已自动互换（0.04 / 0.02 ng/bp）。</p>';
    }

    body += '<div class="subhead">归一化到 10–100 ng</div><dl class="rows">';
    if (res.mass_norm_common) {
      body += row("归一化系数", b(res.mass_norm_factor, 6) +
        ' <span class="hint">两种 DNA 使用同一系数，质量比不变</span>');
    } else {
      body += row("归一化系数", '<b>无法统一</b> <span class="hint">两者质量相差超过 10 倍，已分别钳制</span>');
    }
    body += row("Vector 目标质量", withUnit(res.vector_target_mass_ng, 2, "ng"));
    body += row("Insert 目标质量", withUnit(res.insert_target_mass_ng, 2, "ng"));
    body += row("目标质量比 V : I", b(res.target_ratio, 4) + " : 1");
    body += "</dl>";
    return body;
  }

  function cardVolumes(res) {
    var body = '<div class="subhead">理论体积 = 目标质量 / 母液浓度</div><dl class="rows">';
    body += row("Vector 理论体积", withUnit(res.vector_theoretical_vol_ul, 2, "μL",
      f2(res.vector_target_mass_ng) + " / " + f2(res.vector_conc)));
    body += row("Insert 理论体积", withUnit(res.insert_theoretical_vol_ul, 2, "μL",
      f2(res.insert_target_mass_ng) + " / " + f2(res.insert_conc)));
    if (res.dna_theoretical_vol_ul > C117.DNA_REGION_VOL) {
      body += row("理论合计", b(res.dna_theoretical_vol_ul, 2) +
        ' <span class="unit">μL</span> <span class="badge work">超出 5 μL 上限</span>');
    } else {
      body += row("理论合计", b(res.dna_theoretical_vol_ul, 2) +
        ' <span class="unit">μL</span> <span class="badge stock">未超过 5 μL</span>');
    }
    body += "</dl>";

    body += '<p class="note">分配说明：' + esc(res.volume_note) + "</p>";

    body += '<div class="subhead">最终实际加样体积（最小 ' + f2(res.min_pipette_vol) + ' μL）</div><dl class="rows">';
    body += row("Vector 实际体积", withUnit(res.vector_vol_ul, 2, "μL"));
    body += row("Insert 实际体积", withUnit(res.insert_vol_ul, 2, "μL"));
    body += row("DNA 合计", withUnit(res.dna_vol_ul, 2, "μL"));
    body += row("ddH₂O 补足", withUnit(res.water_vol_ul, 2, "μL"));
    body += "</dl>";
    return body;
  }

  function cardMass(res) {
    var body = '<div class="subhead">实际质量</div><dl class="rows">';
    body += row("统一质量系数 s", b(res.mass_scale, 4) +
      (res.mass_scale < 1 - 1e-9 ? ' <span class="hint">两种 DNA 同步缩减</span>' : ""));
    body += row("Vector 实际质量", withUnit(res.vector_mass_ng, 2, "ng"));
    body += row("Insert 实际质量", withUnit(res.insert_mass_ng, 2, "ng"));
    body += row("实际质量比 V : I", b(res.actual_ratio, 4) + " : 1" +
      ' <span class="hint">目标 ' + f4(res.target_ratio) + " : 1</span>");
    body += "</dl>";

    body += '<div class="subhead">最终工作液浓度 = 实际质量 / 实际体积</div><dl class="rows">';
    body += row("Vector 工作液", withUnit(res.vector_work_conc_ng_ul, 2, "ng/μL",
      "母液 " + f2(res.vector_conc)));
    body += row("Insert 工作液", withUnit(res.insert_work_conc_ng_ul, 2, "ng/μL",
      "母液 " + f2(res.insert_conc)));
    body += "</dl>";
    return body;
  }

  function recipeBlock(name, plan) {
    var html = '<div class="recipe"><div class="recipe-head">' + name +
      ' 工作液 <span class="badge work">需稀释</span></div>';
    html += '<div class="recipe-line"><span>原始母液 · ' + f2(plan.stock_conc) +
      ' ng/μL</span><b>' + f2(plan.stock_vol) + " μL</b></div>";
    html += '<div class="recipe-line"><span>ddH₂O</span><b>' + f2(plan.water_vol) + " μL</b></div>";
    html += '<div class="recipe-line total"><span>终体积 ' + f2(plan.final_vol) +
      " μL · " + f2(plan.work_conc) + ' ng/μL</span><b>稀释 ' + f2(plan.fold) + "×</b></div>";
    html += "</div>";
    return html;
  }

  function cardDilution(res) {
    var plans = [["Vector", res.vector_dilution], ["Insert", res.insert_dilution]];
    var anyNeeded = plans.some(function (pair) { return pair[1].needed === true; });
    var anyBroken = plans.some(function (pair) { return pair[1].needed === null; });

    if (!anyNeeded && !anyBroken) {
      return '<div class="callout ok"><strong>无需稀释。</strong>' +
        "两种 DNA 的工作液浓度均等于母液浓度，可直接使用原始母液加样。</div>";
    }

    var body = "";
    plans.forEach(function (pair) {
      var name = pair[0];
      var plan = pair[1];
      if (plan.needed === null) {
        body += '<div class="callout warn"><strong>' + name + " 无法配制：</strong>" +
          esc(plan.error) + "。请先浓缩母液后重新计算。</div>";
        return;
      }
      if (plan.needed) {
        body += recipeBlock(name, plan);
      } else {
        body += '<p class="dil-none">' + name + " 无需稀释，直接使用原始母液（" +
          f2(plan.stock_conc) + " ng/μL）。</p>";
      }
    });
    body += '<p class="hint">按 C1 × V1 = C2 × V2 由原始母液配制；工作液体积可在“高级参数”中修改。</p>';
    return body;
  }

  function mixRow(name, working, conc, volume, mass) {
    var badge = working
      ? '<span class="badge work">工作液 ' + f2(conc) + " ng/μL</span>"
      : '<span class="badge stock">原始母液 ' + f2(conc) + " ng/μL</span>";
    return "<tr><td>" + name + " " + badge + "</td><td>" + f2(volume) +
      "</td><td>" + f2(mass) + "</td></tr>";
  }

  function cardTable(res) {
    var vWorking = res.vector_dilution.needed === true;
    var iWorking = res.insert_dilution.needed === true;
    var html = '<table class="mix"><thead><tr><th>组分</th><th>体积 (μL)</th><th>DNA 质量 (ng)</th></tr></thead><tbody>';
    html += mixRow("Vector", vWorking, vWorking ? res.vector_work_conc_ng_ul : res.vector_conc,
      res.vector_vol_ul, res.vector_mass_ng);
    html += mixRow("Insert", iWorking, iWorking ? res.insert_work_conc_ng_ul : res.insert_conc,
      res.insert_vol_ul, res.insert_mass_ng);
    html += '<tr><td>ddH₂O</td><td>' + f2(res.water_vol_ul) + '</td><td class="dash">—</td></tr>';
    html += '<tr><td>2× CE Mix V3</td><td>' + f2(res.ce_mix_vol_ul) + '</td><td class="dash">—</td></tr>';
    html += '<tr class="total"><td>总计</td><td>' + f2(res.total_vol_ul) + "</td><td>" +
      f2(res.vector_mass_ng + res.insert_mass_ng) + "</td></tr>";
    html += "</tbody></table>";
    html += '<div class="table-actions">' +
      '<button type="button" class="btn" data-copy="table">复制表格</button>' +
      '<button type="button" class="btn" data-copy="protocol">复制实验记录</button>' +
      '<button type="button" class="btn" data-copy="cli">复制 CLI 命令</button>' +
      "</div>";
    return html;
  }

  function cardChecks(res) {
    return '<div class="checks">' + res.checks.map(function (check) {
      return '<div class="check' + (check.ok ? "" : " bad") + '">' +
        '<span class="mark">' + (check.ok ? "✓" : "!") + "</span>" +
        '<div class="check-body"><div class="check-name">' + esc(check.name) + "</div>" +
        '<div class="check-detail">' + esc(check.detail) + "</div></div></div>";
    }).join("") + "</div>";
  }

  function prepBoxHTML(res) {
    var items = [["Vector", res.vector_dilution], ["Insert", res.insert_dilution]].map(
      function (pair) {
        var name = pair[0];
        var plan = pair[1];
        var badge;
        var text;
        if (plan.needed === null) {
          badge = '<span class="badge bad-badge">无法配制</span>';
          text = esc(plan.error);
        } else if (plan.needed) {
          badge = '<span class="badge work">需稀释</span>';
          text = "取 <b>" + f2(plan.stock_vol) + " μL</b> 母液（" + f2(plan.stock_conc) +
            " ng/μL）+ <b>" + f2(plan.water_vol) + " μL</b> ddH₂O → <b>" +
            f2(plan.final_vol) + " μL</b>，<b>" + f2(plan.work_conc) + " ng/μL</b>";
        } else {
          badge = '<span class="badge stock">无需稀释</span>';
          text = "直接使用原始母液 <b>" + f2(plan.stock_conc) + " ng/μL</b>";
        }
        return '<div class="prep-row"><div class="prep-name">' + name + " " + badge +
          '</div><div class="prep-text">' + text + "</div></div>";
      });
    return '<div class="prep"><div class="prep-head">工作液准备' +
      '<span class="hint">先配好工作液，再按下方体系加样</span></div>' +
      '<div class="prep-rows">' + items.join("") + "</div></div>";
  }

  function renderResults(res) {
    var html = "";
    if (res.warnings.length) {
      html += '<div class="callout warn"><strong>注意</strong><ul>' +
        res.warnings.map(function (warning) { return "<li>" + esc(warning) + "</li>"; }).join("") +
        "</ul></div>";
    }
    html += prepBoxHTML(res);
    html += '<div class="stats">' +
      stat("Vector 实际体积", f2(res.vector_vol_ul) + "<span>μL</span>",
        f2(res.vector_mass_ng) + " ng · " + f2(res.vector_work_conc_ng_ul) + " ng/μL") +
      stat("Insert 实际体积", f2(res.insert_vol_ul) + "<span>μL</span>",
        f2(res.insert_mass_ng) + " ng · " + f2(res.insert_work_conc_ng_ul) + " ng/μL") +
      stat("ddH₂O 补足", f2(res.water_vol_ul) + "<span>μL</span>",
        "DNA 合计 " + f2(res.dna_vol_ul) + " μL") +
      stat("实际质量比 V : I", f4(res.actual_ratio) + " : 1",
        "目标 " + f4(res.target_ratio) + " : 1") +
      "</div>";

    html += card("1–2", "理论质量与归一化", cardTheory(res));
    html += card("3–4", "理论体积与体积分配", cardVolumes(res));
    html += card("5–6", "实际质量与工作液浓度", cardMass(res));
    html += card("7–8", "工作液与稀释", cardDilution(res));
    html += card("9", "最终 10 μL 反应体系", cardTable(res), "table-card");
    html += card("10", "体系校验", cardChecks(res));

    resultsBox.innerHTML = html;
    resultsBox.hidden = false;
    current = res;
  }

  /* ---------------- 复制文本 ---------------- */
  function tableText(res) {
    var vWorking = res.vector_dilution.needed === true;
    var iWorking = res.insert_dilution.needed === true;
    var lines = ["组分\t体积 (μL)\tDNA 质量 (ng)"];
    lines.push("Vector " + (vWorking ? "工作液" : "原始母液") + " (" +
      f2(vWorking ? res.vector_work_conc_ng_ul : res.vector_conc) + " ng/μL)\t" +
      f2(res.vector_vol_ul) + "\t" + f2(res.vector_mass_ng));
    lines.push("Insert " + (iWorking ? "工作液" : "原始母液") + " (" +
      f2(iWorking ? res.insert_work_conc_ng_ul : res.insert_conc) + " ng/μL)\t" +
      f2(res.insert_vol_ul) + "\t" + f2(res.insert_mass_ng));
    lines.push("ddH2O\t" + f2(res.water_vol_ul) + "\t-");
    lines.push("2x CE Mix V3\t" + f2(res.ce_mix_vol_ul) + "\t-");
    lines.push("总计\t" + f2(res.total_vol_ul) + "\t" +
      f2(res.vector_mass_ng + res.insert_mass_ng));
    return lines.join("\n");
  }

  function protocolText(res) {
    var lines = [];
    lines.push("C117 单片段同源重组 10 μL 体系");
    lines.push("Vector: " + fLen(res.vector_len) + " bp, 母液 " + f2(res.vector_conc) + " ng/μL");
    lines.push("Insert: " + fLen(res.insert_len) + " bp, 母液 " + f2(res.insert_conc) + " ng/μL");
    lines.push("目标质量比 V:I = " + f4(res.target_ratio) + " : 1");
    lines.push("");
    [["Vector", res.vector_dilution], ["Insert", res.insert_dilution]].forEach(function (pair) {
      var plan = pair[1];
      if (plan.needed) {
        lines.push(pair[0] + " 工作液: 取 " + f2(plan.stock_vol) + " μL 母液(" +
          f2(plan.stock_conc) + " ng/μL) + " + f2(plan.water_vol) + " μL ddH2O -> " +
          f2(plan.final_vol) + " μL (" + f2(plan.work_conc) + " ng/μL)");
      } else {
        lines.push(pair[0] + ": 直接使用原始母液 " + f2(plan.stock_conc) + " ng/μL");
      }
    });
    lines.push("");
    lines.push("加样:");
    lines.push("  Vector " + (res.vector_dilution.needed ? "工作液" : "原始母液") + " " +
      f2(res.vector_vol_ul) + " μL (" + f2(res.vector_mass_ng) + " ng)");
    lines.push("  Insert " + (res.insert_dilution.needed ? "工作液" : "原始母液") + " " +
      f2(res.insert_vol_ul) + " μL (" + f2(res.insert_mass_ng) + " ng)");
    lines.push("  ddH2O " + f2(res.water_vol_ul) + " μL");
    lines.push("  2x CE Mix V3 " + f2(res.ce_mix_vol_ul) + " μL");
    lines.push("  总计 " + f2(res.total_vol_ul) + " μL");
    lines.push("");
    lines.push("反应: 50 °C 5-15 min，随后 4 °C 或立即冰上冷却");
    return lines.join("\n");
  }

  function cliText(res) {
    return "python cloning_calculator_v2.py" +
      " --vector-len " + String(res.vector_len) +
      " --vector-conc " + String(res.vector_conc) +
      " --insert-len " + String(res.insert_len) +
      " --insert-conc " + String(res.insert_conc) +
      " --min-pipette-vol " + String(res.min_pipette_vol) +
      " --dilution-final-vol " + String(res.dilution_final_vol);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
  }

  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (err) { /* 忽略 */ }
    document.body.removeChild(area);
  }

  function copyText(text, message) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(message);
      }, function () {
        legacyCopy(text);
        showToast(message);
      });
    } else {
      legacyCopy(text);
      showToast(message);
    }
  }

  /* ---------------- URL 同步 ---------------- */
  function paramsToQuery(params) {
    var query = new URLSearchParams();
    query.set("vl", String(params.vectorLen));
    query.set("vc", String(params.vectorConc));
    query.set("il", String(params.insertLen));
    query.set("ic", String(params.insertConc));
    query.set("mp", String(params.minPipetteVol));
    query.set("df", String(params.dilutionFinalVol));
    return query;
  }

  function updateUrl(params) {
    if (!window.history.replaceState) return;
    var url = new URL(window.location.href);
    url.search = paramsToQuery(params).toString();
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
  }

  /* ---------------- 表单流程 ---------------- */
  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    resultsBox.hidden = true;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function run(scroll) {
    var params;
    try {
      params = gather();
    } catch (err) {
      showError(err.message);
      return;
    }
    var res;
    try {
      res = C117.compute(params);
    } catch (err) {
      showError(err.message);
      return;
    }
    clearError();
    renderResults(res);
    updateUrl(params);
    if (scroll) {
      resultsBox.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    run(true);
  });

  $("example-btn").addEventListener("click", function () {
    fields.vectorLen.value = "10000";
    fields.vectorConc.value = "20";
    fields.insertLen.value = "2500";
    fields.insertConc.value = "50";
    fields.minPipetteVol.value = "1";
    fields.dilutionFinalVol.value = "30";
    run(true);
  });

  $("link-btn").addEventListener("click", function () {
    var params;
    try {
      params = gather();
    } catch (err) {
      showToast("请先填写完整参数");
      return;
    }
    var url = new URL(window.location.href);
    url.search = paramsToQuery(params).toString();
    url.hash = "";
    copyText(url.toString(), "分享链接已复制");
  });

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-copy]") : null;
    if (!button || !current) return;
    var kind = button.getAttribute("data-copy");
    if (kind === "table") copyText(tableText(current), "加样表已复制（可直接粘贴到 Excel）");
    else if (kind === "protocol") copyText(protocolText(current), "实验记录已复制");
    else if (kind === "cli") copyText(cliText(current), "命令行已复制");
  });

  /* ---------------- 首次加载：从 URL 恢复 ---------------- */
  (function init() {
    var query = new URLSearchParams(window.location.search);
    ["vl", "vc", "il", "ic", "mp", "df"].forEach(function (key) {
      if (!query.has(key)) return;
      var map = { vl: "vectorLen", vc: "vectorConc", il: "insertLen", ic: "insertConc",
        mp: "minPipetteVol", df: "dilutionFinalVol" };
      fields[map[key]].value = query.get(key);
    });
    if (query.has("vl") && query.has("vc") && query.has("il") && query.has("ic")) {
      run(false);
    }
  })();
})();
