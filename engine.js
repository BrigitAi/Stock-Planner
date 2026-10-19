/* =====================================================================
   Brigit Stock Planner — planning engine
   Pure calculations, no screen code. Works in the browser
   (window.SPEngine) and in Node (require) for testing.

   Input rows are the sp_stock table: one row per stock code per warehouse.
   ===================================================================== */
(function (root) {
  "use strict";

  const DEFAULTS = {
    coverMonths: { LOCAL: 3, FOREIGN: 6, "IN-HOUSE": 3 },
    leadTimeDays: { LOCAL: 30, FOREIGN: 90, "IN-HOUSE": 14 },
    buyerTypes: { CP: "LOCAL", CH: "FOREIGN", PRODUCTION: "IN-HOUSE", "IN-BRANCH": "IN-HOUSE", INBRANCH: "IN-HOUSE" },
    unknownBuyerType: "LOCAL",
    demandBasis: "max6and12",          // max6and12 | avg12 | avg6 | avg3
    serviceLevel: { A: 0.99, B: 0.95, C: 0.90 },
    abcSplit: { A: 0.80, B: 0.95 },     // cumulative share of annual usage value
    mainWarehouse: "M1",
    branches: { JH01: 1, CT01: 3, DN01: 2 },   // branch → transfer days from M1
    restockCycleDays: 30,
    planWarehouses: ["M1", "JH01", "DN01", "CT01", "JH02", "JH05", "JHP1"],
    subtractOpenSO: false,
    includeIssues: true,
    minSalesMonths: 3                  // sold in fewer months than this (of 12) = slow mover: no automatic order
  };

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const up = v => String(v == null ? "" : v).trim().toUpperCase();
  const ceil = v => Math.max(0, Math.ceil(v - 1e-9));
  const round1 = v => Math.round(v * 10) / 10;

  // inverse standard normal (Acklam) — service level → z
  function zFor(p) {
    p = Math.min(Math.max(num(p), 0.5), 0.9999);
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    let q, r;
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  function settingsWithDefaults(s) {
    s = Object.assign({}, DEFAULTS, s || {});
    for (const k of ["coverMonths", "leadTimeDays", "buyerTypes", "serviceLevel", "abcSplit", "branches"]) s[k] = Object.assign({}, DEFAULTS[k], (s || {})[k] || {});
    s.planWarehouses = (s.planWarehouses || DEFAULTS.planWarehouses).map(up);
    s.mainWarehouse = up(s.mainWarehouse || "M1");
    return s;
  }

  // the latest 12 month keys found in the data ("YYYY-MM"), newest first
  function monthsIn(rows) {
    const set = new Set();
    for (const r of rows) { for (const k of Object.keys(r.sales || {})) set.add(k); for (const k of Object.keys(r.issues || {})) set.add(k); }
    return [...set].filter(k => /^\d{4}-\d{2}$/.test(k)).sort().reverse().slice(0, 12);
  }

  function supplyTypeOf(info, S, supplierRule, itemRule) {
    if (itemRule && itemRule.supply_type) return [itemRule.supply_type, "item"];
    if (supplierRule && supplierRule.supply_type) return [supplierRule.supply_type, "supplier"];
    const pl = up(info.planner);
    if (pl) {
      if (pl === "LOCAL") return ["LOCAL", "Qlik planner"];
      if (/FOREIGN|IMPORT|OVERSEAS/.test(pl)) return ["FOREIGN", "Qlik planner"];
      if (/^(IH|IN)[- ]?|INHOUSE|IN-HOUSE/.test(pl)) return ["IN-HOUSE", "Qlik planner"];
    }
    const b = up(info.buyer);
    if (S.buyerTypes[b]) return [S.buyerTypes[b], "buyer " + b];
    return [S.unknownBuyerType || "LOCAL", b ? "buyer " + b + " (not mapped)" : "no buyer"];
  }

  function stats(series, basis) {
    // series: monthly demand, newest first, length 12 (missing = 0)
    const s12 = series.slice(0, 12), s6 = series.slice(0, 6), s3 = series.slice(0, 3);
    const sum = a => a.reduce((t, v) => t + v, 0);
    const avg12 = sum(s12) / 12, avg6 = sum(s6) / 6, avg3 = sum(s3) / 3;
    const mean = avg12;
    const sd = Math.sqrt(s12.reduce((t, v) => t + (v - mean) * (v - mean), 0) / 11);
    const demand = basis === "avg12" ? avg12 : basis === "avg6" ? avg6 : basis === "avg3" ? avg3 : Math.max(avg6, avg12);
    const hits = s12.filter(v => v > 0).length;
    return { avg12, avg6, avg3, demand, sd, hits, total12: sum(s12) };
  }

  /**
   * plan(rows, settings, suppliers, overrides)
   *   rows      — sp_stock rows
   *   settings  — sp_settings.data
   *   suppliers — sp_suppliers rows (optional)
   *   overrides — sp_item_overrides rows (optional)
   */
  function plan(rows, settings, suppliers, overrides) {
    const S = settingsWithDefaults(settings);
    const months = monthsIn(rows);
    const supBy = new Map((suppliers || []).map(r => [up(r.supplier_code), r]));
    const ovBy = new Map((overrides || []).map(r => [up(r.stock_code), r]));
    const planWh = new Set(S.planWarehouses);
    const branchCodes = Object.keys(S.branches).map(up);

    // group rows by stock code
    const byCode = new Map();
    for (const r of rows) {
      const code = up(r.stock_code), wh = up(r.warehouse);
      if (!code || !wh) continue;
      if (!byCode.has(code)) byCode.set(code, new Map());
      byCode.get(code).set(wh, r);
    }

    const seriesOf = r => months.map(m => num((r.sales || {})[m]) + (S.includeIssues ? num((r.issues || {})[m]) : 0));

    const items = [];
    for (const [code, whs] of byCode) {
      const main = whs.get(S.mainWarehouse) || whs.values().next().value;
      const info = {
        code, description: main.description || "", long_description: main.long_description || "",
        buyer: up(main.buyer), supplier_code: up(main.supplier_code), supplier: main.supplier || "",
        product_class: main.product_class || "", product_manager: main.product_manager || "",
        planner: main.planner || "", obsolete: up(main.obsolete), on_hold: up(main.on_hold),
        unit_cost: num(main.unit_cost), qlik_abc: up(main.abc_class)
      };
      const itemRule = ovBy.get(code), supRule = supBy.get(info.supplier_code);
      const [type, typeSource] = supplyTypeOf(info, S, supRule, itemRule);

      // lead time
      let lt, ltSource;
      const qlikLt = [...whs.values()].map(r => r.lead_time_days).find(v => v != null && num(v) > 0);
      if (itemRule && itemRule.lead_time_days != null) { lt = num(itemRule.lead_time_days); ltSource = "item"; }
      else if (supRule && supRule.lead_time_days != null) { lt = num(supRule.lead_time_days); ltSource = "supplier"; }
      else if (qlikLt != null) { lt = num(qlikLt); ltSource = "Qlik"; }
      else { lt = num(S.leadTimeDays[type] != null ? S.leadTimeDays[type] : S.leadTimeDays.LOCAL); ltSource = "default"; }

      // company demand = all planning warehouses together
      const company = months.map(() => 0);
      const perWh = {};
      let available = 0, openSO = 0, negWh = [];
      for (const [wh, r] of whs) {
        if (!planWh.has(wh)) continue;
        const s = seriesOf(r);
        s.forEach((v, i) => { company[i] += v; });
        const av = num(r.qty_available);
        available += av; openSO += num(r.open_so_qty);
        if (av < 0) negWh.push(wh);
        perWh[wh] = { available: av, openSO: num(r.open_so_qty), series: s, mtd: num(r.mtd_sold) + (S.includeIssues ? num(r.mtd_issued) : 0) };
      }
      while (company.length < 12) company.push(0);
      const clamped = company.map(v => Math.max(0, v));
      const st = stats(clamped, S.demandBasis);

      const poDue = num(main.po_due_qty), overdue = num(main.overdue_qty);
      const position = available + poDue - (S.subtractOpenSO ? openSO : 0);
      const cover = itemRule && itemRule.cover_months != null ? num(itemRule.cover_months) : num(S.coverMonths[type] != null ? S.coverMonths[type] : S.coverMonths.LOCAL);

      items.push({
        ...info, type, typeSource, leadTime: lt, leadTimeSource: ltSource, cover,
        months, monthly: company, perWh, available, openSO, poDue, overdue, position, negWh,
        avg12: st.avg12, avg6: st.avg6, avg3: st.avg3, demand: st.demand, sd: st.sd, hits: st.hits, total12: st.total12,
        annualValue: st.avg12 * 12 * info.unit_cost,
        note: itemRule && itemRule.note || "", excludedByBuyer: !!(itemRule && itemRule.exclude)
      });
    }

    // ABC by annual usage value (unless Qlik supplied it)
    const ranked = items.filter(i => i.annualValue > 0).sort((a, b) => b.annualValue - a.annualValue);
    const totalValue = ranked.reduce((t, i) => t + i.annualValue, 0) || 1;
    let run = 0;
    for (const i of ranked) {
      run += i.annualValue;
      const share = (run - i.annualValue) / totalValue;   // share BEFORE this item, so the top item is always A
      i.abc = share < S.abcSplit.A ? "A" : share < S.abcSplit.B ? "B" : "C";
    }
    for (const i of items) { if (/^[ABC]$/.test(i.qlik_abc)) i.abc = i.qlik_abc; else if (!i.abc) i.abc = "C"; }

    // levels, status and order quantity
    for (const i of items) {
      const z = zFor(S.serviceLevel[i.abc] || 0.9);
      i.z = z;
      const ltM = i.leadTime / 30;
      i.safety = i.demand > 0 ? ceil(z * i.sd * Math.sqrt(Math.max(ltM, 0.25))) : 0;
      i.minQty = i.demand > 0 ? ceil(i.demand * ltM + i.safety) : 0;
      i.maxQty = i.demand > 0 ? Math.max(i.minQty, ceil(i.demand * i.cover + i.safety)) : 0;
      i.monthsCover = i.demand > 0 ? i.position / i.demand : (i.position > 0 ? Infinity : 0);
      i.orderQty = 0; i.excessQty = 0;

      if (i.obsolete === "YES") i.status = "OBSOLETE";
      else if (i.on_hold) i.status = "ON HOLD";
      else if (i.excludedByBuyer) i.status = "EXCLUDED";
      else if (i.demand <= 0) i.status = i.position > 0 ? "NO DEMAND" : "INACTIVE";
      else if (i.hits < num(S.minSalesMonths) && i.type !== "IN-HOUSE") {
        // sold in only a month or two: don't hold stock, buy against the order (shown for review)
        i.status = "SLOW MOVER";
        i.slowShortfall = Math.max(0, ceil(i.openSO - i.available - i.poDue));
      }
      else if (i.position < i.minQty) {
        i.status = (i.position < i.safety || (i.available <= 0 && i.poDue <= 0)) ? "URGENT" : "ORDER";
        i.orderQty = ceil(i.maxQty - i.position);
      } else if (i.position > i.maxQty) { i.status = "OVERSTOCK"; i.excessQty = Math.floor(i.position - i.maxQty); }
      else i.status = "OK";

      if (i.type === "IN-HOUSE" && i.orderQty > 0) i.action = "MAKE"; else if (i.orderQty > 0) i.action = "BUY"; else i.action = "";
      i.orderValue = i.orderQty * i.unit_cost;
      i.excessValue = i.excessQty * i.unit_cost;
      i.stockValue = Math.max(0, i.available) * i.unit_cost;

      // things a person should look at
      const ex = [];
      if (i.orderQty > 0 && !i.unit_cost) ex.push("No unit cost");
      if (i.orderQty > 0 && i.type !== "IN-HOUSE" && !i.supplier_code) ex.push("No supplier");
      if (i.orderQty > 0 && i.total12 > 0 && i.orderQty > i.total12 * 1.5) ex.push("Order is more than 18 months' usage");
      if (i.type === "LOCAL" && i.leadTime > i.cover * 30) ex.push("Lead time longer than cover");
      if (i.negWh.length) ex.push("Negative stock in " + i.negWh.join(", "));
      if (/not mapped/.test(i.typeSource)) ex.push("Buyer code not mapped to local/foreign");
      if (i.status === "NO DEMAND" && i.stockValue > 0) ex.push("Stock with no sales in 12 months");
      if (i.status === "SLOW MOVER" && i.slowShortfall > 0) ex.push("Slow mover with open orders not covered");
      i.exceptions = ex;
    }

    // ---------- branch restock from M1 ----------
    const cycle = num(S.restockCycleDays) || 30;
    const restock = {};
    const mainFree = new Map(items.map(i => [i.code, Math.max(0, (i.perWh[S.mainWarehouse] || {}).available || 0)]));
    for (const b of branchCodes) {
      const t = num(S.branches[b]);
      const lines = [];
      for (const i of items) {
        const w = i.perWh[b];
        if (!w) continue;
        const series = w.series.map(v => Math.max(0, v));
        while (series.length < 12) series.push(0);
        const st = stats(series, S.demandBasis);
        const prot = (cycle + t) / 30;
        const safety = st.demand > 0 ? ceil(i.z * st.sd * Math.sqrt(t / 30 + 0.25)) : 0;
        const minQty = st.demand > 0 ? ceil(st.demand * t / 30 + safety) : 0;
        const maxQty = st.demand > 0 ? Math.max(minQty, ceil(st.demand * prot + safety)) : 0;
        const position = w.available - (S.subtractOpenSO ? w.openSO : 0);
        let status, need = 0;
        if (i.on_hold || i.excludedByBuyer) status = "BLOCKED";     // obsolete stock may still be sent to branches
        else if (st.demand <= 0) status = w.available > 0 ? "NO DEMAND" : "INACTIVE";
        else if (st.hits < num(S.minSalesMonths)) status = "SLOW";          // rarely sold here: send against orders only
        else if (position < maxQty) { need = ceil(maxQty - position); status = position < minQty ? "LOW" : "TOP UP"; }
        else if (position > maxQty * 2 && position - maxQty >= 2) status = "OVER";
        else status = "OK";
        lines.push({ code: i.code, description: i.description, supplier: i.supplier, abc: i.abc, type: i.type, unit_cost: i.unit_cost,
          demand: st.demand, avg12: st.avg12, avg3: st.avg3, sd: st.sd, monthly: w.series, available: w.available, openSO: w.openSO,
          safety, minQty, maxQty, position, need, status, transferDays: t, item: i });
      }
      restock[b] = lines;
    }
    // share M1 stock between branches when it can't cover everyone
    for (const i of items) {
      const asks = branchCodes.map(b => (restock[b] || []).find(l => l.code === i.code)).filter(l => l && l.need > 0);
      if (!asks.length) continue;
      const free = mainFree.get(i.code) || 0, total = asks.reduce((t, l) => t + l.need, 0);
      if (total <= free) asks.forEach(l => { l.send = l.need; });
      else {
        let left = free;
        asks.forEach(l => { l.send = Math.floor(free * l.need / total); left -= l.send; });
        asks.sort((a, b) => (b.need - b.send) - (a.need - a.send)).forEach(l => { if (left > 0 && l.send < l.need) { l.send++; left--; } });
      }
      asks.forEach(l => { l.short = l.need - l.send; l.sendValue = l.send * l.unit_cost; });
      i.branchNeed = total;
    }
    for (const b of branchCodes) for (const l of restock[b]) { if (l.send == null) { l.send = 0; l.short = 0; l.sendValue = 0; } }

    // ---------- summary ----------
    const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
    const toBuy = items.filter(i => i.action === "BUY"), toMake = items.filter(i => i.action === "MAKE");
    const summary = {
      items: items.length,
      months,
      buyLines: toBuy.length, buyValue: sum(toBuy, i => i.orderValue),
      urgent: items.filter(i => i.status === "URGENT" && i.action).length,
      makeLines: toMake.length, makeValue: sum(toMake, i => i.orderValue),
      overstockLines: items.filter(i => i.status === "OVERSTOCK").length, overstockValue: sum(items.filter(i => i.status === "OVERSTOCK"), i => i.excessValue),
      noDemandLines: items.filter(i => i.status === "NO DEMAND").length, noDemandValue: sum(items.filter(i => i.status === "NO DEMAND"), i => i.stockValue),
      stockValue: sum(items, i => i.stockValue),
      exceptionLines: items.filter(i => i.exceptions.length).length,
      slowLines: items.filter(i => i.status === "SLOW MOVER").length,
      branches: Object.fromEntries(branchCodes.map(b => {
        const ls = restock[b] || [];
        return [b, { lines: ls.filter(l => l.send > 0).length, value: sum(ls, l => l.sendValue || 0), shortLines: ls.filter(l => l.short > 0).length }];
      }))
    };

    return { settings: S, months, items, restock, summary };
  }

  // SYSPRO min/max list per warehouse (for a later import into SYSPRO)
  function minMaxRows(result) {
    const out = [];
    const S = result.settings;
    for (const i of result.items) {
      if (i.demand > 0 && !["OBSOLETE", "ON HOLD", "EXCLUDED"].includes(i.status))
        out.push({ StockCode: i.code, Warehouse: S.mainWarehouse, SafetyStock: i.safety, MinimumQty: i.minQty, MaximumQty: i.maxQty, Basis: "Company demand, " + i.cover + " months cover" });
    }
    for (const [b, lines] of Object.entries(result.restock)) for (const l of lines) {
      if (l.demand > 0 && l.status !== "BLOCKED") out.push({ StockCode: l.code, Warehouse: b, SafetyStock: l.safety, MinimumQty: l.minQty, MaximumQty: l.maxQty, Basis: "Branch demand, monthly restock" });
    }
    return out;
  }

  const api = { plan, minMaxRows, zFor, DEFAULTS, settingsWithDefaults, round1 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SPEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
