"use strict";

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = () => $("#view");

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function modeTag(mode) {
  const m = (mode || "").toLowerCase();
  return `<span class="tag tag-${m || "full"}">${esc(mode || "FULL")}</span>`;
}
function caughtTag(caught) {
  return caught === false
    ? '<span class="tag tag-uncaught">UNCAUGHT</span>'
    : '<span class="tag tag-caught">caught</span>';
}
function num(n) { return (n === null || n === undefined) ? "—" : Number(n).toLocaleString(); }
function bytes(n) {
  if (n === null || n === undefined || n < 0) return "—";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// ---------- dashboard ----------
async function renderDashboard() {
  view().innerHTML = `<h1>Dashboard</h1><p class="subtitle">Live overview of captured exceptions</p>
    <div id="dash"></div>`;
  let s;
  try { s = await api("/stats"); } catch { view().innerHTML += `<p class="empty">collector unreachable</p>`; return; }

  const maxTop = Math.max(1, ...s.topTypes.map((t) => t.count));
  const bars = s.topTypes.map((t) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(t.type)}">${esc(t.type)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(t.count / maxTop) * 100}%"></div></div>
      <div class="bar-count">${num(t.count)}</div>
    </div>`).join("") || `<p class="empty">no data yet</p>`;

  const deps = s.recentDeployments.map((d) =>
    `<tr><td class="mono">${esc(d.deployment)}</td><td class="mono">${esc(d.lastSeen)}</td></tr>`
  ).join("") || `<tr><td colspan="2" class="empty">none</td></tr>`;

  $("#dash").innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Total exceptions</div><div class="v">${num(s.totalExceptions)}</div></div>
      <div class="card"><div class="k">Unique fingerprints</div><div class="v">${num(s.uniqueFingerprints)}</div></div>
      <div class="card"><div class="k">Deployments</div><div class="v">${num(s.deployments)}</div></div>
      <div class="card"><div class="k">Uncaught</div><div class="v ${s.uncaught ? "red" : "green"}">${num(s.uncaught)}</div></div>
    </div>
    <div class="panel"><h2>Top exception types</h2>${bars}</div>
    <div class="panel"><h2>Recent deployments</h2>
      <table><thead><tr><th>Deployment</th><th>Last seen</th></tr></thead><tbody>${deps}</tbody></table>
    </div>`;
}

// ---------- exceptions list ----------
const exState = { limit: 50, offset: 0, type: "", deployment: "", caught: "" };

async function renderExceptions() {
  view().innerHTML = `<h1>Exceptions</h1><p class="subtitle">Filter and inspect captured errors</p>
    <div class="filters">
      <input id="f-type" placeholder="exception type" value="${esc(exState.type)}" />
      <input id="f-dep" placeholder="deployment" value="${esc(exState.deployment)}" />
      <select id="f-caught">
        <option value="">caught + uncaught</option>
        <option value="true">caught only</option>
        <option value="false">uncaught only</option>
      </select>
      <button class="primary" id="f-apply">Apply</button>
      <button id="f-clear">Clear</button>
    </div>
    <div id="ex-table"></div>`;
  $("#f-caught").value = exState.caught;
  $("#f-apply").onclick = () => {
    exState.type = $("#f-type").value.trim();
    exState.deployment = $("#f-dep").value.trim();
    exState.caught = $("#f-caught").value;
    exState.offset = 0; loadExceptions();
  };
  $("#f-clear").onclick = () => {
    exState.type = exState.deployment = exState.caught = ""; exState.offset = 0;
    renderExceptions();
  };
  loadExceptions();
}

async function loadExceptions() {
  const p = new URLSearchParams({ limit: exState.limit, offset: exState.offset });
  if (exState.type) p.set("type", exState.type);
  if (exState.deployment) p.set("deployment", exState.deployment);
  if (exState.caught) p.set("caught", exState.caught);
  let d;
  try { d = await api(`/exceptions?${p}`); } catch { $("#ex-table").innerHTML = `<p class="empty">collector unreachable</p>`; return; }

  if (!d.items.length) { $("#ex-table").innerHTML = `<p class="empty">no matching exceptions</p>`; return; }
  const rows = d.items.map((r) => `
    <tr onclick="location.hash='#/exception/${r.id}'">
      <td>${modeTag(r.capture_mode)}</td>
      <td class="mono">${esc(r.exception_type)}</td>
      <td>${esc((r.class_name || "") + "." + (r.method_name || ""))}:${esc(r.line_number)}</td>
      <td>${num(r.hit_count)}</td>
      <td>${caughtTag(r.caught)}</td>
      <td class="mono">${esc(r.deployment_id || "—")}</td>
      <td class="mono">${esc(r.timestamp || "")}</td>
    </tr>`).join("");
  const from = d.offset + 1, to = d.offset + d.items.length;
  $("#ex-table").innerHTML = `
    <table><thead><tr><th>Mode</th><th>Type</th><th>Location</th><th>Hits</th><th>Caught</th><th>Deployment</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="pager">
      <button ${d.offset === 0 ? "disabled" : ""} onclick="pageEx(-1)">‹ Prev</button>
      <span>${from}–${to} of ${num(d.total)}</span>
      <button ${to >= d.total ? "disabled" : ""} onclick="pageEx(1)">Next ›</button>
    </div>`;
}
window.pageEx = (dir) => { exState.offset = Math.max(0, exState.offset + dir * exState.limit); loadExceptions(); };

// ---------- exception detail ----------
function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join("")}</div>`;
}
function locationBlock(loc) {
  if (!loc) return `<p class="empty">n/a</p>`;
  return kv([
    ["Class", esc(loc.className)],
    ["Method", esc(loc.methodName)],
    ["Line", esc(loc.lineNumber)],
    ["Source file", esc(loc.sourceFile)],
  ]);
}
function framesBlock(stack) {
  if (!stack || !stack.length) return `<p class="empty">no frames</p>`;
  return stack.map((f, idx) => {
    const locals = (f.localVariables || []).map((lv) => {
      const bci = lv.source === "bci_shadow" ? ' <span class="dot-bci" title="captured via bytecode instrumentation">●</span>' : "";
      const sig = lv.signature ? ` <span class="sig">: ${esc(lv.signature)}</span>` : "";
      const nm = lv.name || `slot${lv.slot}`;
      return `<div class="local"><span class="name">${esc(nm)}</span>${sig} = <span class="val">${esc(lv.value)}</span>${bci}</div>`;
    }).join("");
    const cls = f.isAppCode === false ? "frame-lib" : "frame-app";
    const loc = `${esc(f.className)}.${esc(f.methodName)}(${esc(f.sourceFile || "?")}:${esc(f.lineNumber)})`;
    return `<div class="frame">
      <div class="frame-head ${cls}" onclick="this.nextElementSibling.classList.toggle('hidden')">
        <span>#${idx}</span><span>${loc}</span>${locals ? `<span style="color:var(--text-dim)">(${f.localVariables.length} locals)</span>` : ""}
      </div>
      <div class="locals ${locals ? "" : "hidden"}">${locals || '<span class="sig">no locals</span>'}</div>
    </div>`;
  }).join("");
}
function causesBlock(causes) {
  if (!causes || !causes.length) return `<p class="empty">none</p>`;
  return causes.map((c) => `<div class="local"><span class="name">${esc(c.exceptionType)}</span>: ${esc(c.exceptionMessage)}</div>`).join("");
}

async function renderDetail(id) {
  view().innerHTML = `<span class="back-link" onclick="history.back()">‹ back to exceptions</span><div id="detail"></div>`;
  let e;
  try { e = await api(`/exceptions/${id}`); } catch { $("#detail").innerHTML = `<p class="empty">not found</p>`; return; }

  const m = e.jvmMetrics || {};
  $("#detail").innerHTML = `
    <h1 class="mono">${esc(e.exceptionType)}</h1>
    <p class="subtitle">${esc(e.exceptionMessage || "")}</p>
    <details class="section" open><summary>Overview</summary><div class="body">${kv([
      ["Capture mode", modeTag(e.captureMode)],
      ["Caught", caughtTag(e.caught)],
      ["Hit count", num(e.hitCount)],
      ["Fingerprint", esc(e.fingerprint)],
      ["Timestamp", esc(e.timestamp)],
      ["Deployment", esc(e.deploymentId || "—")],
      ["Instance", esc(e.instanceId || "—")],
    ])}</div></details>
    <details class="section" open><summary>Throw location</summary><div class="body">${locationBlock(e.location)}</div></details>
    <details class="section"><summary>Catch location</summary><div class="body">${locationBlock(e.caughtAt)}</div></details>
    <details class="section"><summary>Thread info</summary><div class="body">${e.threadInfo ? kv([
      ["Name", esc(e.threadInfo.name)], ["Priority", esc(e.threadInfo.priority)], ["Daemon", esc(e.threadInfo.isDaemon)],
    ]) : '<p class="empty">n/a</p>'}</div></details>
    <details class="section" open><summary>Stack trace (${(e.stackTrace || []).length} frames)</summary><div class="body">${framesBlock(e.stackTrace)}</div></details>
    <details class="section"><summary>Cause chain</summary><div class="body">${causesBlock(e.causeChain)}</div></details>
    <details class="section"><summary>Suppressed</summary><div class="body">${causesBlock(e.suppressedExceptions)}</div></details>
    <details class="section"><summary>JVM metrics</summary><div class="body">${kv([
      ["Heap used", bytes(m.heapUsedBytes)], ["Heap max", bytes(m.heapMaxBytes)],
      ["GC count", num(m.gcCollectionCount)], ["GC time", m.gcTimeMs != null ? m.gcTimeMs + " ms" : "—"],
      ["Threads", num(m.threadCount)], ["Loaded classes", num(m.loadedClassCount)],
      ["Uptime", m.uptimeMs != null ? (m.uptimeMs / 1000).toFixed(1) + " s" : "—"],
    ])}</div></details>`;
}

// ---------- JVM info ----------
async function renderJvm() {
  view().innerHTML = `<h1>JVM Info</h1><p class="subtitle">Registered agent instances</p><div id="jvm"></div>`;
  let list;
  try { list = await api("/jvm-instances"); } catch { $("#jvm").innerHTML = `<p class="empty">collector unreachable</p>`; return; }
  if (!list.length) { $("#jvm").innerHTML = `<p class="empty">no instances registered</p>`; return; }

  $("#jvm").innerHTML = list.map((j) => {
    const h = j.hostInfo || {}, v = j.jvmInfo || {}, cfg = j.agentConfig || {};
    const args = (j.jvmArgs || []).map((a) => `<div class="local mono">${esc(a)}</div>`).join("") || '<span class="sig">none</span>';
    const props = Object.entries(j.systemProperties || {}).map(([k, val]) =>
      `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(val)}</td></tr>`).join("");
    const envs = Object.entries(j.envVars || {}).map(([k, val]) =>
      `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(val)}</td></tr>`).join("") || `<tr><td colspan="2" class="sig">none captured</td></tr>`;
    return `<div class="panel">
      <h2>${esc(j.instanceId)} ${h.kubernetes ? '<span class="tag tag-caught">k8s</span>' : ""}</h2>
      ${kv([
        ["Host", esc(h.name)], ["OS", `${esc(h.os)} ${esc(h.osVersion || "")} (${esc(h.arch || "")})`],
        ["JVM", `${esc(v.version)} — ${esc(v.vmName || "")}`], ["Vendor", esc(v.vendor)],
        ["Deployment", esc(j.deploymentId || "—")], ["Started", esc(j.timestamp)],
        ["Collector", `${esc(cfg.host)}:${esc(cfg.port)}${esc(cfg.path || "")}`],
      ])}
      <details class="section" style="margin-top:12px"><summary>JVM args</summary><div class="body">${args}</div></details>
      <details class="section"><summary>Environment variables</summary><div class="body"><table><tbody>${envs}</tbody></table></div></details>
      <details class="section"><summary>System properties</summary><div class="body"><table><tbody>${props}</tbody></table></div></details>
      <details class="section"><summary>Classpath</summary><div class="body"><div class="local mono" style="word-break:break-all">${esc(j.classpath || "—")}</div></div></details>
    </div>`;
  }).join("");
}

// ---------- live feed ----------
const live = { events: [], cap: 500, domCap: 200, count: 0, active: false };

function renderLive() {
  live.active = true; live.count = 0; updateBadge();
  view().innerHTML = `<h1>Live Feed</h1><p class="subtitle">Real-time exceptions via WebSocket</p>
    <div id="feed" class="feed"></div>`;
  const feed = $("#feed");
  if (!live.events.length) feed.innerHTML = `<p class="empty">waiting for events…</p>`;
  else live.events.slice(0, live.domCap).forEach((e) => feed.appendChild(feedCard(e)));
}
window.addEventListener("hashchange", () => { if (route() !== "live") live.active = false; });

function feedCard(e) {
  const div = document.createElement("div");
  div.className = "feed-card" + (e.caught === false ? " uncaught" : "");
  const loc = e.location || {};
  div.innerHTML = `<div class="ft">${esc(e.exceptionType)} ${modeTag(e.captureMode)} ${caughtTag(e.caught)}</div>
    <div class="fm">${esc((loc.className || "") + "." + (loc.methodName || ""))}:${esc(loc.lineNumber)} — ${esc(e.exceptionMessage || "")}</div>`;
  return div;
}

function onLiveEvent(ev) {
  live.events.unshift(ev);
  if (live.events.length > live.cap) live.events.length = live.cap;
  if (live.active) {
    const feed = $("#feed");
    if (feed) {
      if (feed.querySelector(".empty")) feed.innerHTML = "";
      feed.insertBefore(feedCard(ev), feed.firstChild);
      while (feed.childElementCount > live.domCap) feed.removeChild(feed.lastChild);
    }
  } else {
    live.count++; updateBadge();
  }
}
function updateBadge() {
  const b = $("#live-badge");
  if (live.count > 0) { b.textContent = live.count > 99 ? "99+" : live.count; b.classList.remove("hidden"); }
  else b.classList.add("hidden");
}

// ---------- websocket ----------
let ws = null;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/live`);
  ws.onopen = () => setWs(true);
  ws.onclose = () => { setWs(false); setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.kind === "exception" && msg.event) onLiveEvent(msg.event);
    } catch {}
  };
}
function setWs(on) {
  $("#ws-dot").className = "dot " + (on ? "dot-on" : "dot-off");
  $("#ws-text").textContent = on ? "connected" : "disconnected";
}

// ---------- router ----------
function route() { return (location.hash.replace(/^#\//, "") || "dashboard").split("/")[0]; }
function routeArg() { return location.hash.split("/")[2]; }

function render() {
  const r = route();
  document.querySelectorAll(".nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === (r === "exception" ? "exceptions" : r)));
  if (r === "dashboard") renderDashboard();
  else if (r === "exceptions") renderExceptions();
  else if (r === "exception") renderDetail(routeArg());
  else if (r === "live") renderLive();
  else if (r === "jvm") renderJvm();
  else renderDashboard();
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", () => {
  if (!location.hash) location.hash = "#/dashboard";
  render();
  connectWs();
});
