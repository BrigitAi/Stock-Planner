(function () {
  "use strict";

  /* =====================================================================
     Brigit Stock Planner — screens
     Data:  Supabase sp_* tables (loaded by n8n from the Qlik exports)
     Maths: engine.js (SPEngine.plan)
     ===================================================================== */
  const CFG = window.SP_CONFIG || {};
  const PREVIEW = window.SP_PREVIEW || null;      // local preview with test data (no Supabase)
  const E = window.SPEngine;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DOMAINS = (CFG.emailDomains || ["brigit.co.za"]).map(d => d.toLowerCase());

  const db = PREVIEW ? null : window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { flowType: "implicit", persistSession: true, detectSessionInUrl: true }
  });

  const ST = {
    user: null, me: null, rows: [], settings: {}, suppliers: [], overrides: [], imports: [], users: [],
    res: null, tab: "overview",
    buy: { q: "", type: "ALL", view: "order", abc: "", buyer: "", supplier: "", sort: ["orderValue", -1], limit: 200 },
    restock: { branch: null, q: "", view: "send", sort: ["sendValue", -1], limit: 200 },
    health: { view: "over", q: "", sort: ["excessValue", -1], limit: 200 },
    exc: { kind: "", q: "", sort: ["orderValue", -1], limit: 200 }
  };

  /* ---------------- formatting ---------------- */
  const nf0 = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 1 });
  const qty = v => v == null || v === "" ? "" : (Math.abs(v) < 10 && v % 1 ? nf1.format(v) : nf0.format(v));
  const rand = v => "R " + nf0.format(Math.round(v || 0));
  const randShort = v => { v = v || 0; const a = Math.abs(v); return a >= 1e6 ? "R " + nf1.format(v / 1e6) + "m" : a >= 1e3 ? "R " + nf0.format(v / 1e3) + "k" : "R " + nf0.format(v); };
  const monthName = k => { const [y, m] = k.split("-"); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m - 1] + " " + y.slice(2); };
  const cover = v => v === Infinity ? "∞" : v == null ? "" : nf1.format(v);
  const chip = s => `<span class="chip ${esc(String(s).replace(/\s+/g, "-"))}">${esc(s)}</span>`;
  const tag = t => `<span class="tag ${esc(t)}">${esc(t === "IN-HOUSE" ? "IN-HOUSE" : t)}</span>`;
  const dateTime = d => d ? new Date(d).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200); }
  const ICON = {
    cart: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.1l1.7-6.8H6.4"/></svg>',
    truck: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
    alert: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.5v.2"/></svg>',
    box: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>',
    gear: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"/></svg>',
    clock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
  };

  /* =====================================================================
     SIGN-IN (same accounts as the trivia game: email + password)
     ===================================================================== */
  let authEmail = "";
  const siteUrl = () => location.href.split("#")[0].split("?")[0];
  const okEmail = e => DOMAINS.some(d => e.endsWith("@" + d));
  const domainText = () => DOMAINS.map(d => "@" + d).join(" or ");
  function say(text, cls = "muted") { const m = $("#login-msg"); m.textContent = text; m.className = "login-msg " + cls; }
  function setMode(mode) {
    $$("#login .auth-form").forEach(f => { f.hidden = f.dataset.mode !== mode; });
    $$("#login .auth-tab").forEach(t => t.classList.toggle("on", t.dataset.mode === mode));
    $$("#login .auth-email").forEach(b => { b.textContent = authEmail; });
    const form = $(`#login .auth-form[data-mode="${mode}"]`);
    if (form && form.email && authEmail && !form.email.value) form.email.value = authEmail;
  }
  const busy = (f, on) => { f.querySelector("button[type=submit]").disabled = on; };
  function friendly(err) {
    const m = String(err && err.message || err || "");
    if (/invalid login credentials/i.test(m)) return "Wrong email or password. First time here? Click Register. Forgot it? Click Forgot password.";
    if (/rate limit|too many/i.test(m)) return "Too many emails were sent in a short time. Please wait a few minutes and try again.";
    if (/expired|invalid.*(otp|token)|token.*(invalid|expired)/i.test(m)) return "That code is wrong or has expired. Check the latest email, or send a new code.";
    if (/password should|weak|at least/i.test(m)) return "Please choose a stronger password (at least 8 characters).";
    return m;
  }
  function wireLogin() {
    $$("#login .auth-tab").forEach(t => t.onclick = () => { say(""); setMode(t.dataset.mode); });
    $$("#login [data-goto]").forEach(a => a.onclick = e => { e.preventDefault(); say(""); setMode(a.dataset.goto); });
    $("#f-signin").onsubmit = async e => {
      e.preventDefault(); const f = e.target, email = f.email.value.trim().toLowerCase();
      if (!okEmail(email)) return say(`Use your ${domainText()} email address.`, "bad-t");
      authEmail = email; busy(f, true); say("Signing in…");
      const { error } = await db.auth.signInWithPassword({ email, password: f.password.value });
      busy(f, false);
      if (error && /not confirmed/i.test(error.message)) {
        await db.auth.resend({ type: "signup", email, options: { emailRedirectTo: siteUrl() } });
        setMode("code"); return say("Your email isn't confirmed yet, so we've sent you a new code.", "good-t");
      }
      if (error) return say(friendly(error), "bad-t");
      location.reload();
    };
    $("#f-register").onsubmit = async e => {
      e.preventDefault(); const f = e.target, email = f.email.value.trim().toLowerCase();
      if (!okEmail(email)) return say(`Use your ${domainText()} email address.`, "bad-t");
      if (f.password.value.length < 8) return say("The password needs at least 8 characters.", "bad-t");
      if (f.password.value !== f.password2.value) return say("The two passwords don't match.", "bad-t");
      authEmail = email; busy(f, true); say("Registering…");
      const { data, error } = await db.auth.signUp({ email, password: f.password.value, options: { emailRedirectTo: siteUrl() } });
      busy(f, false);
      if (error) return say(friendly(error), "bad-t");
      if (data.session) return location.reload();
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setMode("signin"); return say("This email is already registered (maybe for the Trivia League). Sign in with that password, or click Forgot password.", "bad-t");
      }
      setMode("code"); say("Check your email for the code. It can take a minute to arrive.", "good-t");
    };
    $("#f-code").onsubmit = async e => {
      e.preventDefault(); const f = e.target, token = f.code.value.replace(/\s+/g, "");
      busy(f, true); say("Checking the code…");
      let { error } = await db.auth.verifyOtp({ email: authEmail, token, type: "signup" });
      if (error) ({ error } = await db.auth.verifyOtp({ email: authEmail, token, type: "email" }));
      busy(f, false);
      if (error) return say(friendly(error), "bad-t");
      location.reload();
    };
    $("#resend-code").onclick = async e => {
      e.preventDefault(); if (!authEmail) return setMode("register");
      const { error } = await db.auth.resend({ type: "signup", email: authEmail, options: { emailRedirectTo: siteUrl() } });
      say(error ? friendly(error) : "A new code is on its way.", error ? "bad-t" : "good-t");
    };
    $("#f-forgot").onsubmit = async e => {
      e.preventDefault(); const f = e.target, email = f.email.value.trim().toLowerCase();
      if (!okEmail(email)) return say(`Use your ${domainText()} email address.`, "bad-t");
      authEmail = email; busy(f, true); say("Sending…");
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
      busy(f, false);
      if (error) return say(friendly(error), "bad-t");
      $("#f-reset").email.value = email; setMode("reset"); say("Check your email for the code.", "good-t");
    };
    let recovering = /type=recovery/.test(location.hash);
    $("#f-reset").onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      if (f.password.value.length < 8) return say("The password needs at least 8 characters.", "bad-t");
      if (f.password.value !== f.password2.value) return say("The two passwords don't match.", "bad-t");
      busy(f, true); say("Saving…");
      if (!recovering) {
        const { error } = await db.auth.verifyOtp({ email: authEmail, token: f.code.value.replace(/\s+/g, ""), type: "recovery" });
        if (error) { busy(f, false); return say(friendly(error), "bad-t"); }
      }
      const { error } = await db.auth.updateUser({ password: f.password.value });
      busy(f, false);
      if (error) return say(friendly(error), "bad-t");
      say("Password saved. Signing you in…", "good-t"); setTimeout(() => location.reload(), 600);
    };
    if (recovering) { setMode("reset"); $("#f-reset").code.hidden = true; $("#f-reset .reset-intro").hidden = true; }
    else setMode("signin");
  }

  /* =====================================================================
     DATA
     ===================================================================== */
  const STOCK_COLS = "stock_code,warehouse,description,long_description,obsolete,product_manager,buyer,supplier_code,supplier,product_class,on_hold,unit_cost,qty_on_hand_m1,qty_available,mtd_sold,sales,issues,mtd_issued,overdue_qty,po_due_qty,open_so_qty,lead_time_days,planner,abc_class";

  async function fetchAll(table, cols, order) {
    const PAGE = 1000;
    const { count, error } = await db.from(table).select(order, { count: "exact", head: true });
    if (error) throw error;
    const pages = Math.ceil((count || 0) / PAGE), out = [];
    for (let start = 0; start < pages; start += 6) {
      const batch = [];
      for (let p = start; p < Math.min(pages, start + 6); p++)
        batch.push(db.from(table).select(cols).order(order).range(p * PAGE, p * PAGE + PAGE - 1));
      for (const r of await Promise.all(batch)) { if (r.error) throw r.error; out.push(...r.data); }
      $("#loading") && ($("#loading").textContent = `Loading stock data… ${nf0.format(out.length)} of ${nf0.format(count)} rows`);
    }
    return out;
  }

  async function loadAll() {
    if (PREVIEW) {
      Object.assign(ST, { rows: PREVIEW.rows, settings: PREVIEW.settings || {}, suppliers: PREVIEW.suppliers || [], overrides: PREVIEW.overrides || [], imports: PREVIEW.imports || [], users: PREVIEW.users || [] });
      return;
    }
    const [rows, set, sup, ov, imp] = await Promise.all([
      fetchAll("sp_stock", STOCK_COLS, "stock_code"),
      db.from("sp_settings").select("data").eq("id", 1).maybeSingle(),
      db.from("sp_suppliers").select("*"),
      db.from("sp_item_overrides").select("*"),
      db.from("sp_imports").select("*").order("created_at", { ascending: false }).limit(50)
    ]);
    ST.rows = rows;
    ST.settings = set.data ? set.data.data : {};
    ST.suppliers = sup.data || []; ST.overrides = ov.data || []; ST.imports = imp.data || [];
    if (ST.me.role === "admin") { const u = await db.from("sp_users").select("*").order("name"); ST.users = u.data || []; }
  }

  function replan() { ST.res = E.plan(ST.rows, ST.settings, ST.suppliers, ST.overrides); }

  /* =====================================================================
     START
     ===================================================================== */
  async function start() {
    if (PREVIEW) {
      ST.user = { email: PREVIEW.email || "preview@brigit.co.za" };
      ST.me = { email: ST.user.email, name: "Preview", role: PREVIEW.role || "admin" };
    } else {
      const { data: { session } } = await db.auth.getSession();
      if (!session || /type=recovery/.test(location.hash)) { $("#login").hidden = false; wireLogin(); return; }
      ST.user = session.user;
      const email = (ST.user.email || "").toLowerCase();
      const { data: me } = await db.from("sp_users").select("*").eq("email", email).maybeSingle();
      if (!me) {
        $("#noaccess").hidden = false; $("#na-email").textContent = email;
        $("#na-signout").onclick = async () => { await db.auth.signOut(); location.reload(); };
        return;
      }
      ST.me = me;
    }
    $("#app").hidden = false;
    document.body.classList.toggle("is-admin", ST.me.role === "admin");
    $("#who").textContent = ST.me.name || ST.user.email;
    $("#signout").onclick = async () => { if (db) await db.auth.signOut(); location.reload(); };
    try { await loadAll(); }
    catch (err) { $("#main").innerHTML = `<div class="empty">Couldn't load the stock data: ${esc(err.message || err)}</div>`; return; }
    if (!ST.rows.length) { renderFreshness(); location.hash = "#data"; }
    replan();
    renderFreshness();
    window.addEventListener("hashchange", route);
    route();
  }

  function renderFreshness() {
    const done = ST.imports.filter(i => i.status === "done");
    const latest = {};
    for (const i of done) for (const w of i.warehouses || []) if (!latest[w]) latest[w] = i;
    const whs = Object.keys(latest).sort();
    if (!whs.length) { $("#freshness").innerHTML = ST.rows.length ? `Data loaded` : `<span class="stale">No stock data loaded yet</span>`; return; }
    const newest = done[0];
    const ageDays = (Date.now() - new Date(newest.finished_at || newest.created_at)) / 864e5;
    const m = ST.res ? ST.res.months : [];
    $("#freshness").innerHTML = `Qlik data ${ageDays > 3 ? `<span class="stale">${esc(dateTime(newest.finished_at || newest.created_at))}</span>` : `<b>${esc(dateTime(newest.finished_at || newest.created_at))}</b>`}
      · ${esc(whs.join(", "))}${m.length ? ` · sales ${esc(monthName(m[m.length - 1]))} – ${esc(monthName(m[0]))}` : ""}`;
  }

  function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; }
  function route() {
    closeDrawer();
    const [tab, arg] = (location.hash.replace("#", "") || "overview").split("/");
    ST.tab = ["overview", "buy", "restock", "health", "exceptions", "data", "settings"].includes(tab) ? tab : "overview";
    if (ST.tab === "settings" && ST.me.role !== "admin") ST.tab = "overview";
    if (ST.tab === "restock" && arg) ST.restock.branch = arg.toUpperCase();
    $$("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === ST.tab));
    ({ overview: renderOverview, buy: renderBuy, restock: renderRestock, health: renderHealth, exceptions: renderExceptions, data: renderData, settings: renderSettings })[ST.tab]();
  }

  /* =====================================================================
     GENERIC TABLE (sortable, "show more", row click → detail)
     ===================================================================== */
  function table(el, cols, rows, state, onRow) {
    const [sk, sd] = state.sort;
    const col = cols.find(c => c.key === sk);
    if (col) {
      const get = col.sortVal || col.val || (r => r[sk]);
      rows = rows.slice().sort((a, b) => {
        let x = get(a), y = get(b);
        if (typeof x === "string" || typeof y === "string") return String(x ?? "").localeCompare(String(y ?? "")) * sd;
        x = x == null || Number.isNaN(x) ? -Infinity : x; y = y == null || Number.isNaN(y) ? -Infinity : y;
        return (x === y ? 0 : x > y ? 1 : -1) * sd;
      });
    }
    const shown = rows.slice(0, state.limit);
    el.innerHTML = rows.length ? `<div class="tbl-wrap"><table class="data"><thead><tr>${cols.map(c =>
      `<th class="${c.num ? "num" : ""}" data-k="${c.key}" title="${esc(c.tip || "")}">${esc(c.label)}${c.key === sk ? ` <span class="arrow">${sd > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr data-i="${i}">${cols.map(c => `<td class="${c.cls || ""}${c.num ? " num" : ""}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt((c.val || (x => x[c.key]))(r)) : (c.val || (x => x[c.key]))(r))}</td>`).join("")}</tr>`).join("")}</tbody></table>
      ${rows.length > shown.length ? `<div class="more"><button class="btn small" type="button">Show ${nf0.format(Math.min(500, rows.length - shown.length))} more of ${nf0.format(rows.length - shown.length)}</button></div>` : ""}</div>`
      : `<div class="tbl-wrap"><div class="empty">Nothing to show with these filters.</div></div>`;
    $$("th", el).forEach(th => th.onclick = () => {
      const k = th.dataset.k; const c = cols.find(x => x.key === k);
      state.sort = state.sort[0] === k ? [k, -state.sort[1]] : [k, c.num ? -1 : 1];
      table(el, cols, rows, state, onRow);
    });
    $$("tbody tr", el).forEach(tr => tr.onclick = () => onRow && onRow(shown[+tr.dataset.i]));
    const more = $(".more button", el);
    if (more) more.onclick = () => { state.limit += 500; table(el, cols, rows, state, onRow); };
  }

  function seg(name, options, value) {
    return `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
  }
  function onSeg(el, name, fn) { $$(`[data-seg="${name}"] button`, el).forEach(b => b.onclick = () => fn(b.dataset.v)); }
  const opts = (list, val, all = "All") => `<option value="">${esc(all)}</option>` + list.map(v => `<option ${v === val ? "selected" : ""} value="${esc(v)}">${esc(v)}</option>`).join("");
  const match = (q, ...f) => !q || f.some(x => String(x || "").toLowerCase().includes(q));

  /* =====================================================================
     OVERVIEW
     ===================================================================== */
  function renderOverview() {
    const R = ST.res, S = R.summary;
    const buy = R.items.filter(i => i.action === "BUY");
    const bySup = groupSuppliers(buy).slice(0, 10);
    const branches = Object.keys(R.settings.branches);
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Overview</h2>
        <p class="lede">What to buy into M1, what to send to the branches, and where money is tied up. Local items are planned for ${esc(R.settings.coverMonths.LOCAL)} months' stock and foreign items for ${esc(R.settings.coverMonths.FOREIGN)} months.</p></div></div>
      <div class="grid kpis">
        <a class="kpi" href="#buy"><div class="k-label">${ICON.cart} To buy</div><div class="k-value">${randShort(S.buyValue)}</div><div class="k-sub">${nf0.format(S.buyLines)} items · ${nf0.format(R.items.filter(i => i.action === "BUY" && i.status === "URGENT").length)} urgent</div></a>
        <a class="kpi" href="#buy"><div class="k-label">${ICON.gear} To make (in-house)</div><div class="k-value">${randShort(S.makeValue)}</div><div class="k-sub">${nf0.format(S.makeLines)} items</div></a>
        <a class="kpi" href="#restock"><div class="k-label">${ICON.truck} Send to branches</div><div class="k-value">${randShort(branches.reduce((t, b) => t + S.branches[b].value, 0))}</div><div class="k-sub">${nf0.format(branches.reduce((t, b) => t + S.branches[b].lines, 0))} lines from M1</div></a>
        <a class="kpi" href="#health"><div class="k-label">${ICON.box} Above max</div><div class="k-value">${randShort(S.overstockValue)}</div><div class="k-sub">${nf0.format(S.overstockLines)} items overstocked</div></a>
        <a class="kpi" href="#health/dead"><div class="k-label">${ICON.clock} No sales in 12 months</div><div class="k-value">${randShort(S.noDemandValue)}</div><div class="k-sub">${nf0.format(S.noDemandLines)} items still in stock</div></a>
        <a class="kpi" href="#exceptions"><div class="k-label">${ICON.alert} To check</div><div class="k-value">${nf0.format(S.exceptionLines)}</div><div class="k-sub">items with a data problem</div></a>
      </div>
      <div class="grid two">
        <div class="card"><h3>Biggest orders by supplier</h3>
          <table class="mini"><thead><tr><th>Supplier</th><th>Type</th><th class="num">Items</th><th class="num">Urgent</th><th class="num">Value</th></tr></thead>
          <tbody>${bySup.map(s => `<tr class="click" data-sup="${esc(s.key)}"><td>${esc(s.name)}</td><td>${tag(s.type)}</td><td class="num">${s.lines}</td><td class="num">${s.urgent || ""}</td><td class="num">${rand(s.value)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nothing to order.</td></tr>`}</tbody></table>
        </div>
        <div>
          <div class="grid branch-cards">${branches.map(b => `
            <a class="card bcard kpi" href="#restock/${b}"><h3><span>${esc(b)}</span><span class="muted">${R.settings.branches[b]} day${R.settings.branches[b] == 1 ? "" : "s"} from M1</span></h3>
              <div class="big">${randShort(S.branches[b].value)}</div>
              <div class="k-sub">${nf0.format(S.branches[b].lines)} lines to send${S.branches[b].shortLines ? ` · ${nf0.format(S.branches[b].shortLines)} M1 can't cover` : ""}</div></a>`).join("")}
          </div>
          <div class="card" style="margin-top:14px"><h3>Stock value by warehouse</h3>${warehouseValueTable()}</div>
        </div>
      </div>`;
    $$("[data-sup]").forEach(tr => tr.onclick = () => { ST.buy.supplier = tr.dataset.sup; ST.buy.view = "order"; location.hash = "#buy"; });
  }

  function warehouseValueTable() {
    const by = {};
    for (const i of ST.res.items) for (const [w, d] of Object.entries(i.perWh)) {
      by[w] = by[w] || { value: 0, lines: 0 };
      if (d.available > 0) { by[w].value += d.available * i.unit_cost; by[w].lines++; }
    }
    const rows = Object.entries(by).sort((a, b) => b[1].value - a[1].value);
    const max = Math.max(1, ...rows.map(r => r[1].value));
    return `<table class="mini"><tbody>${rows.map(([w, d]) => `<tr><td style="width:60px"><b>${esc(w)}</b></td>
      <td><svg width="100%" height="10" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="bar" x="0" y="1" height="8" rx="2" width="${(d.value / max * 100).toFixed(2)}" fill="var(--bar)"/></svg></td>
      <td class="num" style="width:110px">${rand(d.value)}</td><td class="num muted" style="width:90px">${nf0.format(d.lines)} items</td></tr>`).join("")}</tbody></table>`;
  }

  function groupSuppliers(items) {
    const m = new Map();
    for (const i of items) {
      const key = i.supplier_code || "(none)";
      if (!m.has(key)) m.set(key, { key, name: i.supplier || "(no supplier)", type: i.type, lines: 0, urgent: 0, value: 0 });
      const s = m.get(key); s.lines++; s.value += i.orderValue; if (i.status === "URGENT") s.urgent++;
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }

  /* =====================================================================
     BUY (M1)
     ===================================================================== */
  const BUY_VIEWS = [["order", "To order"], ["make", "To make"], ["slow", "Slow movers"], ["all", "All items"]];
  function buyRows() {
    const f = ST.buy, q = f.q.trim().toLowerCase();
    return ST.res.items.filter(i => {
      if (f.view === "order" && i.action !== "BUY") return false;
      if (f.view === "make" && i.action !== "MAKE") return false;
      if (f.view === "slow" && i.status !== "SLOW MOVER") return false;
      if (f.type !== "ALL" && i.type !== f.type) return false;
      if (f.abc && i.abc !== f.abc) return false;
      if (f.buyer && i.buyer !== f.buyer) return false;
      return match(q, i.code, i.description, i.supplier, i.product_class);
    });
  }
  function renderBuy() {
    const f = ST.buy, R = ST.res;
    const buyers = [...new Set(R.items.map(i => i.buyer).filter(Boolean))].sort();
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Buy into M1</h2>
        <p class="lede">Company-wide: all warehouses' sales against stock in every warehouse plus open purchase orders. Order when stock falls below the minimum; the suggested quantity brings it back up to the maximum.</p></div>
        <button class="btn" id="exp-buy" type="button">Export to Excel</button></div>
      <div class="filters">
        <input type="search" id="q" placeholder="Search code, description, supplier…" value="${esc(f.q)}">
        ${seg("view", BUY_VIEWS, f.view)}
        ${seg("type", [["ALL", "All"], ["LOCAL", "Local"], ["FOREIGN", "Foreign"], ["IN-HOUSE", "In-house"]], f.type)}
        <select id="abc" aria-label="ABC class">${opts(["A", "B", "C"], f.abc, "All classes")}</select>
        <select id="buyer" aria-label="Buyer">${opts(buyers, f.buyer, "All buyers")}</select>
        <span class="spacer"></span><span class="count-note" id="count"></span>
      </div>
      <div class="buy-layout"><div class="sup-list" id="sups"></div><div id="tbl"></div></div>`;
    const draw = () => {
      const rows = buyRows();
      const sups = groupSuppliers(rows);
      const shown = f.supplier ? rows.filter(i => (i.supplier_code || "(none)") === f.supplier) : rows;
      $("#sups").innerHTML = `<h3>Suppliers <span class="muted">(${sups.length})</span></h3>
        <div class="sup ${!f.supplier ? "on" : ""}" data-k=""><span class="s-name">All suppliers</span><span class="s-val">${randShort(rows.reduce((t, i) => t + i.orderValue, 0))}</span><span class="s-sub">${nf0.format(rows.length)} items</span></div>
        ${sups.map(s => `<div class="sup ${f.supplier === s.key ? "on" : ""}" data-k="${esc(s.key)}"><span class="s-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="s-val">${s.value ? randShort(s.value) : ""}</span><span class="s-sub">${tag(s.type)} ${s.lines} item${s.lines === 1 ? "" : "s"}${s.urgent ? ` · <span class="warn-dot">${s.urgent} urgent</span>` : ""}</span></div>`).join("")}`;
      $$(".sup", $("#sups")).forEach(d => d.onclick = () => { f.supplier = d.dataset.k; f.limit = 200; draw(); });
      $("#count").textContent = `${nf0.format(shown.length)} items · ${rand(shown.reduce((t, i) => t + i.orderValue, 0))}`;
      table($("#tbl"), buyCols(), shown, f, openItem);
      ST.buy.lastShown = shown;
    };
    $("#q").oninput = e => { f.q = e.target.value; f.limit = 200; draw(); };
    $("#abc").onchange = e => { f.abc = e.target.value; draw(); };
    $("#buyer").onchange = e => { f.buyer = e.target.value; draw(); };
    onSeg($("#main"), "view", v => { f.view = v; f.limit = 200; f.supplier = ""; renderBuy(); });
    onSeg($("#main"), "type", v => { f.type = v; f.limit = 200; f.supplier = ""; renderBuy(); });
    $("#exp-buy").onclick = () => exportXlsx("Brigit buy list", [["Buy list", ST.buy.lastShown.map(buyExportRow)]]);
    draw();
  }
  function buyCols() {
    return [
      { key: "status", label: "Status", html: i => chip(i.status) },
      { key: "code", label: "Stock code", cls: "code" },
      { key: "description", label: "Description", cls: "desc" },
      { key: "orderQty", label: "Order qty", num: true, cls: "strong", fmt: v => v ? qty(v) : "" },
      { key: "orderValue", label: "Value", num: true, cls: "strong", fmt: v => v ? rand(v) : "" },
      { key: "demand", label: "Use / month", num: true, fmt: qty, tip: "Average monthly sales (higher of the 6- and 12-month average)" },
      { key: "available", label: "Available", num: true, fmt: qty, tip: "Available in all planning warehouses" },
      { key: "poDue", label: "On order", num: true, fmt: qty },
      { key: "minQty", label: "Min", num: true, fmt: qty },
      { key: "maxQty", label: "Max", num: true, fmt: qty },
      { key: "monthsCover", label: "Months cover", num: true, fmt: cover, tip: "(Available + on order) ÷ use per month" },
      { key: "leadTime", label: "Lead days", num: true, html: i => `${qty(i.leadTime)}${i.leadTimeSource === "default" ? '<span class="muted" title="Default lead time: no lead time from Qlik or supplier settings">*</span>' : ""}` },
      { key: "abc", label: "ABC" },
      { key: "supplier", label: "Supplier", cls: "nowrap", html: i => `${esc(i.supplier)} ${tag(i.type)}` }
    ];
  }
  const buyExportRow = i => ({
    "Status": i.status, "Stock code": i.code, "Description": i.description, "Supplier code": i.supplier_code, "Supplier": i.supplier,
    "Type": i.type, "Buyer": i.buyer, "ABC": i.abc, "Lead time (days)": i.leadTime, "Lead time from": i.leadTimeSource,
    "Use per month": +i.demand.toFixed(2), "Available (all wh)": i.available, "On order": i.poDue, "Position": i.position,
    "Safety stock": i.safety, "Min": i.minQty, "Max": i.maxQty, "Months cover": i.monthsCover === Infinity ? "" : +i.monthsCover.toFixed(1),
    "Order qty": i.orderQty, "Unit cost": i.unit_cost, "Order value": +i.orderValue.toFixed(2), "To check": i.exceptions.join("; "), "Buyer note": i.note
  });

  /* =====================================================================
     BRANCH RESTOCK
     ===================================================================== */
  function renderRestock() {
    const R = ST.res, f = ST.restock, branches = Object.keys(R.settings.branches);
    if (!f.branch || !branches.includes(f.branch)) f.branch = branches[0];
    const lines = R.restock[f.branch] || [];
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Branch restock from M1</h2>
        <p class="lede">Branches are restocked from M1 once every ${esc(R.settings.restockCycleDays)} days. Each branch gets enough for one cycle plus the transfer time plus safety stock, based on that branch's own sales. If M1 can't cover all branches, the stock is shared in proportion.</p></div>
        <button class="btn" id="exp-rs" type="button">Export transfer list</button></div>
      <div class="filters">
        ${seg("branch", branches.map(b => [b, `${b} · ${R.settings.branches[b]}d`]), f.branch)}
        <input type="search" id="q" placeholder="Search code or description…" value="${esc(f.q)}">
        ${seg("view", [["send", "To send"], ["short", "M1 can't cover"], ["over", "Too much at branch"], ["all", "All items"]], f.view)}
        <span class="spacer"></span><span class="count-note" id="count"></span>
      </div><div id="tbl"></div>`;
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const rows = lines.filter(l => {
        if (f.view === "send" && !(l.send > 0)) return false;
        if (f.view === "short" && !(l.short > 0)) return false;
        if (f.view === "over" && l.status !== "OVER" && l.status !== "NO DEMAND") return false;
        if (f.view === "all" && l.status === "INACTIVE") return false;
        return match(q, l.code, l.description, l.supplier);
      });
      $("#count").textContent = `${nf0.format(rows.length)} items · ${rand(rows.reduce((t, l) => t + (l.sendValue || 0), 0))} to send`;
      table($("#tbl"), [
        { key: "status", label: "Status", html: l => chip(l.status) },
        { key: "code", label: "Stock code", cls: "code" },
        { key: "description", label: "Description", cls: "desc" },
        { key: "abc", label: "ABC" },
        { key: "demand", label: "Use / month", num: true, fmt: qty },
        { key: "available", label: "At branch", num: true, fmt: qty },
        { key: "minQty", label: "Min", num: true, fmt: qty },
        { key: "maxQty", label: "Max", num: true, fmt: qty },
        { key: "need", label: "Needs", num: true, fmt: v => v ? qty(v) : "" },
        { key: "m1", label: "M1 has", num: true, val: l => Math.max(0, (l.item.perWh[R.settings.mainWarehouse] || {}).available || 0), fmt: qty },
        { key: "send", label: "Send", num: true, cls: "strong", fmt: v => v ? qty(v) : "" },
        { key: "short", label: "Short", num: true, html: l => l.short ? `<span class="warn-dot">${qty(l.short)}</span>` : "" },
        { key: "sendValue", label: "Value", num: true, fmt: v => v ? rand(v) : "" }
      ], rows, f, l => openItem(l.item));
      f.lastShown = rows;
    };
    $("#q").oninput = e => { f.q = e.target.value; f.limit = 200; draw(); };
    onSeg($("#main"), "branch", v => { location.hash = "#restock/" + v; });
    onSeg($("#main"), "view", v => { f.view = v; f.limit = 200; renderRestock(); });
    $("#exp-rs").onclick = () => exportXlsx(`Brigit transfers M1 to ${f.branch}`, [[`M1 to ${f.branch}`, f.lastShown.map(l => ({
      "From": R.settings.mainWarehouse, "To": f.branch, "Stock code": l.code, "Description": l.description, "Status": l.status, "ABC": l.abc,
      "Use per month": +l.demand.toFixed(2), "At branch": l.available, "Min": l.minQty, "Max": l.maxQty, "Needs": l.need,
      "Send": l.send, "Short at M1": l.short, "Unit cost": l.unit_cost, "Value": +(l.sendValue || 0).toFixed(2)
    }))]]);
    draw();
  }

  /* =====================================================================
     STOCK HEALTH
     ===================================================================== */
  function renderHealth() {
    const f = ST.health, R = ST.res;
    if (location.hash === "#health/dead") f.view = "dead";
    const views = [["over", "Above max"], ["dead", "No sales in 12 months"], ["obsolete", "Obsolete / on hold with stock"]];
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Stock health</h2>
        <p class="lede">Where money is tied up: stock above the planned maximum, stock that hasn't sold in a year, and obsolete or on-hold items still holding value.</p></div>
        <button class="btn" id="exp-h" type="button">Export to Excel</button></div>
      <div class="filters"><input type="search" id="q" placeholder="Search…" value="${esc(f.q)}">${seg("view", views, f.view)}<span class="spacer"></span><span class="count-note" id="count"></span></div>
      <div id="tbl"></div>`;
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const rows = R.items.filter(i => {
        if (f.view === "over" && i.status !== "OVERSTOCK") return false;
        if (f.view === "dead" && i.status !== "NO DEMAND") return false;
        if (f.view === "obsolete" && !((i.status === "OBSOLETE" || i.status === "ON HOLD") && i.stockValue > 0)) return false;
        return match(q, i.code, i.description, i.supplier);
      });
      const valKey = f.view === "over" ? "excessValue" : "stockValue";
      if (!["excessValue", "stockValue"].includes(f.sort[0]) || f.sort[0] !== valKey) f.sort = [valKey, -1];
      $("#count").textContent = `${nf0.format(rows.length)} items · ${rand(rows.reduce((t, i) => t + i[valKey], 0))}`;
      table($("#tbl"), [
        { key: "status", label: "Status", html: i => chip(i.status) },
        { key: "code", label: "Stock code", cls: "code" },
        { key: "description", label: "Description", cls: "desc" },
        { key: "supplier", label: "Supplier" },
        { key: "type", label: "Type", html: i => tag(i.type) },
        { key: "demand", label: "Use / month", num: true, fmt: qty },
        { key: "available", label: "Available", num: true, fmt: qty },
        { key: "poDue", label: "On order", num: true, fmt: qty },
        { key: "maxQty", label: "Max", num: true, fmt: qty },
        { key: "monthsCover", label: "Months cover", num: true, fmt: cover },
        ...(f.view === "over" ? [{ key: "excessQty", label: "Above max", num: true, fmt: qty }, { key: "excessValue", label: "Excess value", num: true, cls: "strong", fmt: rand }]
          : [{ key: "stockValue", label: "Stock value", num: true, cls: "strong", fmt: rand }])
      ], rows, f, openItem);
      f.lastShown = rows;
    };
    $("#q").oninput = e => { f.q = e.target.value; f.limit = 200; draw(); };
    onSeg($("#main"), "view", v => { f.view = v; f.limit = 200; if (location.hash !== "#health") history.replaceState(null, "", "#health"); renderHealth(); });
    $("#exp-h").onclick = () => exportXlsx("Brigit stock health", [[views.find(v => v[0] === f.view)[1].slice(0, 30), f.lastShown.map(buyExportRow)]]);
    draw();
  }

  /* =====================================================================
     EXCEPTIONS
     ===================================================================== */
  function renderExceptions() {
    const f = ST.exc, R = ST.res;
    const kinds = {};
    for (const i of R.items) for (const x of i.exceptions) { const k = x.replace(/ in .*$/, ""); kinds[k] = (kinds[k] || 0) + 1; }
    const kindList = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Exceptions to check</h2>
        <p class="lede">Data problems that make a suggestion unreliable. Fix them in SYSPRO or Qlik, or set a lead time / exclusion on the item.</p></div>
        <button class="btn" id="exp-x" type="button">Export to Excel</button></div>
      <div class="grid kpis">${kindList.map(([k, n]) => `<button class="kpi" type="button" data-kind="${esc(k)}" style="text-align:left;cursor:pointer;${f.kind === k ? "border-color:var(--brand-text)" : ""}"><div class="k-label">${ICON.alert} ${esc(k)}</div><div class="k-value">${nf0.format(n)}</div></button>`).join("")}</div>
      <div class="filters"><input type="search" id="q" placeholder="Search…" value="${esc(f.q)}">${f.kind ? `<button class="btn small" id="clear" type="button">Show all exceptions</button>` : ""}<span class="spacer"></span><span class="count-note" id="count"></span></div>
      <div id="tbl"></div>`;
    $$("[data-kind]").forEach(b => b.onclick = () => { f.kind = f.kind === b.dataset.kind ? "" : b.dataset.kind; f.limit = 200; renderExceptions(); });
    if ($("#clear")) $("#clear").onclick = () => { f.kind = ""; renderExceptions(); };
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const rows = R.items.filter(i => i.exceptions.length && (!f.kind || i.exceptions.some(x => x.startsWith(f.kind))) && match(q, i.code, i.description, i.supplier));
      $("#count").textContent = `${nf0.format(rows.length)} items`;
      table($("#tbl"), [
        { key: "status", label: "Status", html: i => chip(i.status) },
        { key: "code", label: "Stock code", cls: "code" },
        { key: "description", label: "Description", cls: "desc" },
        { key: "supplier", label: "Supplier" },
        { key: "exceptions", label: "To check", val: i => i.exceptions.join("; ") },
        { key: "orderQty", label: "Order qty", num: true, fmt: v => v ? qty(v) : "" },
        { key: "orderValue", label: "Order value", num: true, fmt: v => v ? rand(v) : "" },
        { key: "stockValue", label: "Stock value", num: true, fmt: v => v ? rand(v) : "" }
      ], rows, f, openItem);
      f.lastShown = rows;
    };
    $("#q").oninput = e => { f.q = e.target.value; f.limit = 200; draw(); };
    $("#exp-x").onclick = () => exportXlsx("Brigit exceptions", [["Exceptions", f.lastShown.map(buyExportRow)]]);
    draw();
  }

  /* =====================================================================
     ITEM DETAIL
     ===================================================================== */
  function openItem(i) {
    const R = ST.res, S = R.settings, d = $("#drawer");
    const ov = ST.overrides.find(o => o.stock_code === i.code) || {};
    const canEdit = ST.me.role === "admin" || ST.me.role === "buyer";
    const whRows = Object.entries(i.perWh).sort((a, b) => (a[0] === S.mainWarehouse ? -1 : b[0] === S.mainWarehouse ? 1 : a[0].localeCompare(b[0])));
    const ltM = i.leadTime / 30;
    d.innerHTML = `
      <div class="d-head"><div class="grow"><div class="muted">${esc(i.code)} · ${tag(i.type)} · class ${esc(i.abc)}</div><h2>${esc(i.description || i.code)}</h2>
        <div>${chip(i.status)} ${i.orderQty ? `<b>${i.action === "MAKE" ? "Make" : "Order"} ${qty(i.orderQty)}</b> · ${rand(i.orderValue)}` : ""}</div></div>
        <button class="btn ghost small" id="d-close" type="button" aria-label="Close">Close</button></div>
      ${i.exceptions.length ? `<section class="calc" style="border-color:var(--st-urgent)"><b class="warn-dot">To check:</b> ${esc(i.exceptions.join(" · "))}</section>` : ""}
      <section><h3>Sales per month (all warehouses)</h3>${monthChart(i)}</section>
      <section><h3>How the suggestion is worked out</h3><div class="calc">
        <div class="row"><span>Use per month <span class="why">(higher of 6-month ${qty(i.avg6)} and 12-month ${qty(i.avg12)} average)</span></span><b>${qty(i.demand)}</b></div>
        <div class="row"><span>Lead time <span class="why">(${esc(i.leadTimeSource === "default" ? "default for " + i.type.toLowerCase() + " items" : "from " + i.leadTimeSource)})</span></span><b>${qty(i.leadTime)} days</b></div>
        <div class="row"><span>Safety stock <span class="why">(class ${esc(i.abc)}: ${Math.round((S.serviceLevel[i.abc] || .9) * 100)}% service, monthly variation ${qty(i.sd)})</span></span><b>${qty(i.safety)}</b></div>
        <div class="row"><span>Minimum = use × lead time + safety <span class="why">(${qty(i.demand)} × ${nf1.format(ltM)} + ${qty(i.safety)})</span></span><b>${qty(i.minQty)}</b></div>
        <div class="row"><span>Maximum = use × ${esc(i.cover)} months + safety</span><b>${qty(i.maxQty)}</b></div>
        <div class="row"><span>Stock position = available ${qty(i.available)} + on order ${qty(i.poDue)}${S.subtractOpenSO ? ` − open sales orders ${qty(i.openSO)}` : ""}</span><b>${qty(i.position)}</b></div>
        <div class="row total"><span>${i.orderQty ? `Position below minimum → order up to maximum (${qty(i.maxQty)} − ${qty(i.position)})` : statusWhy(i)}</span><b>${i.orderQty ? qty(i.orderQty) : "—"}</b></div>
      </div></section>
      <section><h3>Stock by warehouse</h3><table class="mini"><thead><tr><th>Warehouse</th><th class="num">Available</th><th class="num">Open SO</th><th class="num">Sales / month</th><th class="num">MTD</th>${Object.keys(S.branches).length ? `<th class="num">Send</th>` : ""}</tr></thead><tbody>
        ${whRows.map(([w, x]) => { const l = (R.restock[w] || []).find(r => r.code === i.code);
          return `<tr><td><b>${esc(w)}</b></td><td class="num">${qty(x.available)}</td><td class="num">${qty(x.openSO)}</td><td class="num">${qty(x.series.reduce((t, v) => t + v, 0) / 12)}</td><td class="num">${qty(x.mtd)}</td>${Object.keys(S.branches).length ? `<td class="num">${l && l.send ? qty(l.send) : ""}</td>` : ""}</tr>`; }).join("")}
      </tbody></table></section>
      <section><h3>Details</h3><dl>
        <dt>Supplier</dt><dd>${esc(i.supplier || "—")} ${i.supplier_code ? `<span class="muted">(${esc(i.supplier_code)})</span>` : ""}</dd>
        <dt>Buyer</dt><dd>${esc(i.buyer || "—")} <span class="muted">→ ${esc(i.type)} (${esc(i.typeSource)})</span></dd>
        <dt>Product class</dt><dd>${esc(i.product_class || "—")}</dd>
        <dt>Product manager</dt><dd>${esc(i.product_manager || "—")}</dd>
        <dt>Unit cost (M1)</dt><dd>${rand(i.unit_cost)}</dd>
        <dt>Obsolete / on hold</dt><dd>${esc(i.obsolete || "—")} / ${esc(i.on_hold || "—")}</dd>
      </dl></section>
      ${canEdit ? `<section><h3>Buyer settings for this item</h3>
        <form class="ov-form" id="ov">
          <span>Don't suggest buying</span><label class="chk"><input type="checkbox" name="exclude" ${ov.exclude ? "checked" : ""}> Exclude this item</label>
          <span>Local / foreign</span><select name="supply_type"><option value="">Automatic (${esc(i.typeSource)})</option>${["LOCAL", "FOREIGN", "IN-HOUSE"].map(t => `<option ${ov.supply_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
          <span>Lead time (days)</span><input type="number" name="lead_time_days" min="0" max="730" value="${ov.lead_time_days ?? ""}" placeholder="${esc(i.leadTime)}">
          <span>Months of cover</span><input type="number" name="cover_months" min="0" max="24" step="0.5" value="${ov.cover_months ?? ""}" placeholder="${esc(S.coverMonths[i.type] ?? "")}">
          <span>Note</span><textarea name="note" placeholder="e.g. Supplier discontinuing — buy alternative">${esc(ov.note || "")}</textarea>
          <span></span><div><button class="btn primary" type="submit">Save</button> <span class="muted" id="ov-msg">${ov.updated_by ? `Last changed by ${esc(ov.updated_by)} ${esc(dateTime(ov.updated_at))}` : ""}</span></div>
        </form></section>` : ""}`;
    d.hidden = false; $("#scrim").hidden = false; d.scrollTop = 0;
    const close = closeDrawer;
    $("#d-close").onclick = close; $("#scrim").onclick = close;
    document.onkeydown = e => { if (e.key === "Escape") close(); };
    const form = $("#ov");
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const v = n => form[n].value === "" ? null : Number(form[n].value);
      const row = { stock_code: i.code, exclude: form.exclude.checked, supply_type: form.supply_type.value || null,
        lead_time_days: v("lead_time_days"), cover_months: v("cover_months"), note: form.note.value.trim() || null,
        updated_by: ST.me.email || ST.user.email, updated_at: new Date().toISOString() };
      if (db) { const { error } = await db.from("sp_item_overrides").upsert(row); if (error) { $("#ov-msg").textContent = error.message; return; } }
      ST.overrides = ST.overrides.filter(o => o.stock_code !== i.code).concat([row]);
      replan(); toast("Saved — suggestions updated"); close(); route();
    };
  }
  function statusWhy(i) {
    return ({ OK: "Between minimum and maximum: nothing to order", OVERSTOCK: `Above maximum by ${qty(i.excessQty)}: nothing to order`,
      "NO DEMAND": "No sales in 12 months: nothing to order", INACTIVE: "No sales and no stock", OBSOLETE: "Obsolete in SYSPRO: not bought",
      "ON HOLD": "On hold in SYSPRO: not bought", EXCLUDED: "Excluded by a buyer", "SLOW MOVER": `Sold in only ${i.hits} of the last 12 months: buy against customer orders, don't hold stock` })[i.status] || "";
  }
  function monthChart(i) {
    const m = i.months.slice().reverse(), v = i.monthly.slice(0, m.length).reverse().map(x => Math.max(0, x));
    if (!m.length) return `<p class="muted">No sales history.</p>`;
    const W = 580, H = 150, L = 34, B = 20, T = 14, max = Math.max(1, i.demand, ...v) * 1.1, bw = (W - L) / m.length;
    const y = x => T + (H - T - B) * (1 - x / max);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly sales">
      <line class="axis" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/>
      <text x="${L - 4}" y="${y(max / 1.1) + 3}" text-anchor="end">${esc(qty(max / 1.1))}</text>
      ${v.map((x, k) => `<rect class="bar" x="${L + k * bw + 3}" y="${y(x)}" width="${bw - 6}" height="${Math.max(0, H - B - y(x))}" rx="3"><title>${esc(monthName(m[k]))}: ${esc(qty(x))}</title></rect>
        <text x="${L + k * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(monthName(m[k]).slice(0, 3))}</text>`).join("")}
      ${i.demand > 0 ? `<line class="ref" x1="${L}" x2="${W}" y1="${y(i.demand)}" y2="${y(i.demand)}"/>` : ""}
    </svg>${i.demand > 0 ? `<div class="muted" style="font-size:12px"><span style="color:var(--orange);font-weight:700">- - -</span> planning use: ${esc(qty(i.demand))} per month</div>` : ""}`;
  }

  /* =====================================================================
     DATA (imports, upload, SYSPRO min/max)
     ===================================================================== */
  function renderData() {
    const admin = ST.me.role === "admin";
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Data</h2>
        <p class="lede">The stock data comes from the Qlik <b>Stock Planning</b> report, exported per warehouse by n8n and loaded straight into the planner. Each load replaces the data for the warehouses in it.</p></div></div>
      <div class="grid two">
        <div class="card"><h3>Recent loads</h3>
          <table class="mini"><thead><tr><th>When</th><th>From</th><th>Warehouses</th><th class="num">Rows</th><th>Status</th></tr></thead><tbody>
          ${ST.imports.map(i => `<tr><td>${esc(dateTime(i.finished_at || i.created_at))}</td><td>${esc(i.source)}${i.file_name ? `<div class="muted" style="font-size:12px">${esc(i.file_name)}</div>` : ""}</td><td>${esc((i.warehouses || []).join(", "))}</td><td class="num">${nf0.format(i.row_count || 0)}</td><td>${chip(i.status === "done" ? "OK" : i.status.toUpperCase())}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nothing loaded yet.</td></tr>`}
          </tbody></table>
        </div>
        <div>
          ${admin ? `<div class="card"><h3>Load Qlik export files by hand</h3>
            <p class="muted" style="margin-top:0">Use this if n8n hasn't run, or to test. Pick one or more <b>STOCK PLANNING - &lt;warehouse&gt; - &lt;date&gt;.xlsx</b> files.</p>
            <div class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls,.csv" multiple hidden><button class="btn" type="button" id="pick">Choose files</button><div style="margin-top:6px">or drop them here</div></div>
            <div id="up-msg" class="muted" style="margin-top:10px"></div><div class="progress" hidden id="up-bar"><div></div></div></div>` : ""}
          <div class="card" style="margin-top:14px"><h3>Min / max levels for SYSPRO</h3>
            <p class="muted" style="margin-top:0">The planner's minimum, maximum and safety stock for every active item: M1 at company level, and each branch from its own sales. Ready for loading into SYSPRO later.</p>
            <button class="btn" type="button" id="exp-mm">Download min / max list</button></div>
        </div>
      </div>`;
    $("#exp-mm").onclick = () => exportXlsx("Brigit min max levels", [["Min max", E.minMaxRows(ST.res)]]);
    if (!admin) return;
    const pick = $("#pick"), file = $("#file"), drop = $("#drop");
    pick.onclick = () => file.click();
    file.onchange = () => uploadFiles([...file.files]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); };
  }

  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return xlsxLoading = xlsxLoading || new Promise((ok, bad) => {
      const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => bad(new Error("Couldn't load the Excel reader")); document.head.appendChild(s);
    });
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    const msg = $("#up-msg"), bar = $("#up-bar");
    const set = (t, p) => { msg.textContent = t; if (p != null) { bar.hidden = false; bar.firstElementChild.style.width = (p * 100).toFixed(0) + "%"; } };
    try {
      set("Reading files…", 0.02);
      await loadXlsx();
      let rows = [];
      for (const f of files) {
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const r = XLSX.utils.sheet_to_json(sh, { defval: null, raw: true });
        rows = rows.concat(r);
        set(`Read ${f.name}: ${nf0.format(r.length)} rows`);
      }
      if (!rows.length || !Object.keys(rows[0]).some(k => /warehouse/i.test(k))) throw new Error("These files don't have a Warehouse column. Use the Qlik Stock Planning export.");
      const date = (files.map(f => (f.name.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).find(Boolean)) || null;
      const name = files.map(f => f.name).join(", ").slice(0, 300);
      if (PREVIEW) { set(`Preview only: ${nf0.format(rows.length)} rows read, nothing saved.`, 1); return; }
      const { data: id, error } = await db.rpc("sp_import_begin", { p_file_name: name, p_report_date: date, p_source: "upload" });
      if (error) throw error;
      const CH = 1000;
      for (let k = 0; k < rows.length; k += CH) {
        const { error: e2 } = await db.rpc("sp_import_rows", { p_import_id: id, p_rows: rows.slice(k, k + CH) });
        if (e2) throw e2;
        set(`Sending… ${nf0.format(Math.min(rows.length, k + CH))} of ${nf0.format(rows.length)} rows`, 0.05 + 0.85 * Math.min(1, (k + CH) / rows.length));
      }
      set("Finishing…", 0.93);
      const { data: res, error: e3 } = await db.rpc("sp_import_finish", { p_import_id: id });
      if (e3) throw e3;
      set(`Loaded ${nf0.format(res.rows)} rows for ${(res.warehouses || []).join(", ")}. Reloading…`, 1);
      await loadAll(); replan(); renderFreshness(); route();
      toast("Stock data loaded");
    } catch (err) { set("Load failed: " + (err.message || err)); bar.hidden = true; }
  }

  async function exportXlsx(name, sheets) {
    try {
      await loadXlsx();
      const wb = XLSX.utils.book_new();
      for (const [title, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "Nothing to export" }]), title.replace(/[\\/?*[\]:]/g, "").slice(0, 31));
      XLSX.writeFile(wb, `${name} ${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) { toast(err.message || String(err)); }
  }

  /* =====================================================================
     SETTINGS (admins)
     ===================================================================== */
  function renderSettings() {
    const S = E.settingsWithDefaults(ST.settings);
    const buyers = [...new Set(ST.res.items.map(i => i.buyer).filter(Boolean))].sort();
    const sel = (name, val, list) => `<select name="${name}">${list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const types = [["LOCAL", "Local"], ["FOREIGN", "Foreign"], ["IN-HOUSE", "In-house"]];
    $("#main").innerHTML = `
      <div class="page-head"><div class="grow"><h2>Settings</h2><p class="lede">Planning rules for everyone. Changes apply as soon as you save.</p></div></div>
      <form id="set" class="grid settings-sections">
        <div class="card"><h3>Cover and lead times</h3><div class="form-grid">
          <span>Months of stock</span><div class="inline-inputs"><label>Local <input type="number" name="cov_LOCAL" min="0" max="24" step="0.5" value="${S.coverMonths.LOCAL}"></label><label>Foreign <input type="number" name="cov_FOREIGN" min="0" max="24" step="0.5" value="${S.coverMonths.FOREIGN}"></label><label>In-house <input type="number" name="cov_IN-HOUSE" min="0" max="24" step="0.5" value="${S.coverMonths["IN-HOUSE"] ?? S.coverMonths.LOCAL}"></label></div>
          <span>Default lead time (days)</span><div class="inline-inputs"><label>Local <input type="number" name="lt_LOCAL" min="0" max="730" value="${S.leadTimeDays.LOCAL}"></label><label>Foreign <input type="number" name="lt_FOREIGN" min="0" max="730" value="${S.leadTimeDays.FOREIGN}"></label><label>In-house <input type="number" name="lt_IN-HOUSE" min="0" max="730" value="${S.leadTimeDays["IN-HOUSE"] ?? 14}"></label></div>
          <span class="hint">Used only when Qlik, the supplier or the item has no lead time.</span>
          <span>Use per month</span>${sel("demandBasis", S.demandBasis, [["max6and12", "Higher of 6- and 12-month average"], ["avg12", "12-month average"], ["avg6", "6-month average"], ["avg3", "3-month average"]])}
          <span>Slow mover</span><div class="inline-inputs">Sold in fewer than <input type="number" name="minSalesMonths" min="0" max="12" value="${S.minSalesMonths}"> of 12 months</div>
          <span class="hint">Slow movers are not stocked: buy against the customer order.</span>
          <span>Open sales orders</span><label class="chk"><input type="checkbox" name="subtractOpenSO" ${S.subtractOpenSO ? "checked" : ""}> Subtract open sales orders from available stock</label>
          <span class="hint">Leave off if Qlik's "available" already excludes stock allocated to orders.</span>
          <span>Production issues</span><label class="chk"><input type="checkbox" name="includeIssues" ${S.includeIssues ? "checked" : ""}> Count issues to jobs as use (when the export has them)</label>
        </div></div>
        <div class="card"><h3>Service level (safety stock)</h3><div class="form-grid">
          ${["A", "B", "C"].map(c => `<span>Class ${c}</span><div class="inline-inputs"><input type="number" name="sl_${c}" min="50" max="99.9" step="0.5" value="${Math.round(S.serviceLevel[c] * 1000) / 10}"> %</div>`).join("")}
          <span class="hint">A = items making up the top ${Math.round(S.abcSplit.A * 100)}% of yearly usage value, B = the next ${Math.round((S.abcSplit.B - S.abcSplit.A) * 100)}%, C = the rest.</span>
        </div>
        <h3 style="margin-top:18px">Branches restocked from ${esc(S.mainWarehouse)}</h3><div class="form-grid">
          ${Object.entries(S.branches).map(([b, t]) => `<span>${esc(b)}</span><div class="inline-inputs"><input type="number" name="br_${esc(b)}" min="0" max="60" value="${t}"> days transfer</div>`).join("")}
          <span>Restock every</span><div class="inline-inputs"><input type="number" name="restockCycleDays" min="1" max="120" value="${S.restockCycleDays}"> days</div>
        </div></div>
        <div class="card"><h3>Buyer code → local / foreign</h3><p class="muted" style="margin-top:0">Used when Qlik doesn't say whether an item is local or foreign.</p><div class="form-grid">
          ${buyers.map(b => `<span>${esc(b)} <span class="muted">(${nf0.format(ST.res.items.filter(i => i.buyer === b).length)} items)</span></span>${sel("bt_" + b, S.buyerTypes[b] || "", [["", "— not set —"], ...types])}`).join("")}
          <span>Anything else</span>${sel("unknownBuyerType", S.unknownBuyerType, types)}
        </div></div>
        <div style="grid-column:1/-1"><button class="btn primary" type="submit">Save settings</button> <span id="set-msg" class="muted"></span></div>
      </form>
      <div class="grid two" style="margin-top:18px">
        <div class="card"><h3>Supplier lead times</h3><p class="muted" style="margin-top:0">Overrides Qlik and the defaults for every item from that supplier. Suppliers with something to order are listed first.</p>
          <input type="search" id="sq" placeholder="Search supplier…" style="width:100%;margin-bottom:8px"><div id="sup-tbl" style="max-height:420px;overflow:auto"></div></div>
        <div class="card"><h3>Who can use the planner</h3>
          <table class="mini"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
            ${ST.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${sel("role", u.role, [["admin", "Admin"], ["buyer", "Buyer"], ["viewer", "Viewer"]]).replace("<select", `<select data-email="${esc(u.email)}"`)}</td><td>${u.email === (ST.me.email || "") ? "" : `<button class="btn small ghost" type="button" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join("")}
          </tbody></table>
          <form id="adduser" class="inline-inputs" style="margin-top:12px"><input name="name" placeholder="Name" required><input name="email" type="email" placeholder="name@brigit.co.za" required>${sel("role", "buyer", [["buyer", "Buyer"], ["viewer", "Viewer"], ["admin", "Admin"]])}<button class="btn" type="submit">Add</button></form>
          <p class="muted" style="font-size:12px">Buyers can set item exclusions, lead times and notes. Viewers can only look. Admins also change settings, users and load data. New people register on the sign-in page with the same email.</p>
        </div>
      </div>`;

    $("#set").onsubmit = async e => {
      e.preventDefault(); const f = e.target, n = k => Number(f[k].value);
      const next = Object.assign({}, ST.settings, {
        coverMonths: { LOCAL: n("cov_LOCAL"), FOREIGN: n("cov_FOREIGN"), "IN-HOUSE": n("cov_IN-HOUSE") },
        leadTimeDays: { LOCAL: n("lt_LOCAL"), FOREIGN: n("lt_FOREIGN"), "IN-HOUSE": n("lt_IN-HOUSE") },
        demandBasis: f.demandBasis.value, minSalesMonths: n("minSalesMonths"), subtractOpenSO: f.subtractOpenSO.checked, includeIssues: f.includeIssues.checked,
        serviceLevel: { A: n("sl_A") / 100, B: n("sl_B") / 100, C: n("sl_C") / 100 },
        branches: Object.fromEntries(Object.keys(S.branches).map(b => [b, n("br_" + b)])), restockCycleDays: n("restockCycleDays"),
        buyerTypes: Object.fromEntries(Object.entries(Object.assign({}, S.buyerTypes, Object.fromEntries(buyers.map(b => [b, f["bt_" + b].value])))).filter(([, v]) => v)),
        unknownBuyerType: f.unknownBuyerType.value
      });
      if (db) { const { error } = await db.from("sp_settings").update({ data: next, updated_by: ST.me.email, updated_at: new Date().toISOString() }).eq("id", 1); if (error) { $("#set-msg").textContent = error.message; return; } }
      ST.settings = next; replan(); renderFreshness(); toast("Settings saved — suggestions updated");
    };

    // supplier table
    const supMap = new Map();
    for (const i of ST.res.items) {
      if (!i.supplier_code) continue;
      const s = supMap.get(i.supplier_code) || { code: i.supplier_code, name: i.supplier, items: 0, order: 0, type: i.type };
      s.items++; s.order += i.orderValue; supMap.set(i.supplier_code, s);
    }
    const drawSup = () => {
      const q = ($("#sq").value || "").toLowerCase();
      const list = [...supMap.values()].filter(s => match(q, s.code, s.name)).sort((a, b) => b.order - a.order || b.items - a.items).slice(0, 150);
      $("#sup-tbl").innerHTML = `<table class="mini"><thead><tr><th>Supplier</th><th class="num">Items</th><th>Type</th><th>Lead days</th></tr></thead><tbody>${list.map(s => {
        const r = ST.suppliers.find(x => x.supplier_code === s.code) || {};
        return `<tr><td>${esc(s.name)} <span class="muted">${esc(s.code)}</span></td><td class="num">${s.items}</td>
          <td><select data-sup="${esc(s.code)}" data-f="supply_type"><option value="">Auto</option>${types.map(([v, l]) => `<option value="${v}" ${r.supply_type === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
          <td><input type="number" min="0" max="730" data-sup="${esc(s.code)}" data-f="lead_time_days" value="${r.lead_time_days ?? ""}" placeholder="—" style="width:76px"></td></tr>`; }).join("")}</tbody></table>`;
      $$("[data-sup]", $("#sup-tbl")).forEach(inp => inp.onchange = async () => {
        const code = inp.dataset.sup, cur = ST.suppliers.find(x => x.supplier_code === code) || { supplier_code: code };
        const val = inp.value === "" ? null : inp.dataset.f === "lead_time_days" ? Number(inp.value) : inp.value;
        const row = { supplier_code: code, supply_type: cur.supply_type || null, lead_time_days: cur.lead_time_days ?? null, [inp.dataset.f]: val, updated_by: ST.me.email, updated_at: new Date().toISOString() };
        if (db) { const { error } = await db.from("sp_suppliers").upsert(row); if (error) return toast(error.message); }
        ST.suppliers = ST.suppliers.filter(x => x.supplier_code !== code).concat([row]); replan(); toast("Supplier saved");
      });
    };
    $("#sq").oninput = drawSup; drawSup();

    // users
    $$("select[data-email]").forEach(s => s.onchange = async () => {
      if (db) { const { error } = await db.from("sp_users").update({ role: s.value }).eq("email", s.dataset.email); if (error) return toast(error.message); }
      ST.users.find(u => u.email === s.dataset.email).role = s.value; toast("Role changed");
    });
    $$("[data-del]").forEach(b => b.onclick = async () => {
      if (db) { const { error } = await db.from("sp_users").delete().eq("email", b.dataset.del); if (error) return toast(error.message); }
      ST.users = ST.users.filter(u => u.email !== b.dataset.del); renderSettings();
    });
    $("#adduser").onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      const row = { name: f.name.value.trim(), email: f.email.value.trim().toLowerCase(), role: f.role.value };
      if (db) { const { error } = await db.from("sp_users").insert(row); if (error) return toast(error.message); }
      ST.users.push(row); renderSettings(); toast(`${row.name} added`);
    };
  }

  start();
})();
