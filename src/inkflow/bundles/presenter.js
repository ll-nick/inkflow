"use strict";
(() => {
  // src/ts/presenter/menus.ts
  var activeClose = null;
  function menuOpened(close) {
    if (activeClose && activeClose !== close) activeClose();
    activeClose = close;
  }
  function menuClosed(close) {
    if (activeClose === close) activeClose = null;
  }

  // src/ts/presenter/state.ts
  var state = {
    slides: [],
    transitions: [],
    slideIndex: 0,
    step: 0,
    syncMode: "two-way",
    _pickerMatches: [],
    _pickerActive: 0,
    _overviewActive: 0,
    _overviewCols: 1,
    _editActive: 0,
    ws: null,
    windowLink: null,
    _syncingFromServer: false,
    _laserMode: false
  };

  // src/ts/presenter/ui.ts
  var curtain = document.getElementById("curtain");
  var help = document.getElementById("help");
  var errorOverlay = document.getElementById("error-overlay");
  var errorMsg = document.getElementById("error-msg");
  var logBanner = document.getElementById("log-banner");
  var logList = document.getElementById("log-list");
  var logClose = document.getElementById("log-close");
  var logIndicator = document.getElementById("log-indicator");
  var statusBarEl = document.getElementById("statusbar");
  var notify = document.getElementById("notify");
  var notifyText = document.getElementById("notify-text");
  var notifyClose = document.getElementById("notify-close");
  var notifyHistoryBtn = document.getElementById("notify-history-btn");
  var notifyHistoryEl = document.getElementById("notify-history");
  var notifyHistoryList = document.getElementById("notify-history-list");
  var notifyHistoryClose = document.getElementById("notify-history-close");
  var _doc = document;
  var _fsHideTimer;
  function showCurtain(color) {
    curtain.style.background = color;
    curtain.classList.add("visible");
  }
  function hideCurtain() {
    curtain.classList.remove("visible");
  }
  function toggleCurtain(color) {
    curtain.classList.contains("visible") ? hideCurtain() : showCurtain(color);
  }
  function toggleHelp() {
    help.classList.toggle("visible");
  }
  function showError(msg) {
    errorMsg.textContent = msg;
    errorOverlay.classList.add("visible");
  }
  function hideError() {
    errorOverlay.classList.remove("visible");
  }
  var LOG_LEVEL_ORDER = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3
  };
  var LOG_ICON = {
    debug: "\u25E6",
    info: "\u2139\uFE0E",
    warning: "\u26A0\uFE0E",
    error: "\u2716\uFE0E"
  };
  function highestLevel(logs) {
    return logs.reduce(
      (top, e2) => (LOG_LEVEL_ORDER[e2.level] ?? 0) > (LOG_LEVEL_ORDER[top] ?? 0) ? e2.level : top,
      logs[0].level
    );
  }
  var logSignature = "";
  function showLogs(logs) {
    if (logs.length === 0) {
      hideLogs();
      logSignature = "";
      logIndicator.removeAttribute("data-level");
      return;
    }
    const signature = JSON.stringify(logs);
    const changed = signature !== logSignature;
    logSignature = signature;
    logList.replaceChildren(
      ...logs.map((entry) => {
        const li = document.createElement("li");
        li.className = `log-${entry.level}`;
        const ico = document.createElement("span");
        ico.className = "log-ico";
        ico.textContent = LOG_ICON[entry.level] ?? LOG_ICON.warning;
        const msg = document.createElement("span");
        msg.textContent = entry.message;
        li.append(ico, msg);
        return li;
      })
    );
    logIndicator.dataset.level = highestLevel(logs);
    if (changed) logBanner.classList.add("visible");
  }
  function hideLogs() {
    logBanner.classList.remove("visible");
  }
  function toggleLogs() {
    if (logBanner.classList.contains("visible")) {
      hideLogs();
    } else if (logIndicator.hasAttribute("data-level")) {
      logBanner.classList.add("visible");
    }
  }
  var notifyHistory = [];
  var NOTIFY_DURATION_MS = 3e3;
  var notifyTimeout = null;
  function hideNotify() {
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notify.classList.remove("visible");
    notifyTimeout = null;
  }
  function showNotify(message, style = "green") {
    notifyHistory.push({ message, style, time: Date.now() });
    notifyText.textContent = message;
    notify.dataset.style = style;
    notify.classList.remove("visible");
    void notify.offsetWidth;
    notify.classList.add("visible");
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(hideNotify, NOTIFY_DURATION_MS);
  }
  var NOTIFY_HISTORY_ICON = {
    green: "\u2713",
    yellow: "\u26A0\uFE0E",
    red: "\u2716\uFE0E"
  };
  function pad2(n2) {
    return String(n2).padStart(2, "0");
  }
  function formatHistoryTime(time) {
    const d2 = new Date(time);
    return `${pad2(d2.getHours())}:${pad2(d2.getMinutes())}:${pad2(d2.getSeconds())}`;
  }
  function renderNotifyHistory() {
    if (notifyHistory.length === 0) {
      const empty = document.createElement("li");
      empty.id = "notify-history-empty";
      empty.className = "nh-row";
      empty.textContent = "No messages yet.";
      notifyHistoryList.replaceChildren(empty);
      return;
    }
    notifyHistoryList.replaceChildren(
      ...notifyHistory.slice().reverse().map((entry) => {
        const li = document.createElement("li");
        li.className = "nh-row";
        const time = document.createElement("span");
        time.className = "nh-time";
        time.textContent = formatHistoryTime(entry.time);
        const ico = document.createElement("span");
        ico.className = `nh-ico nh-${entry.style}`;
        ico.textContent = NOTIFY_HISTORY_ICON[entry.style];
        const msg = document.createElement("span");
        msg.className = "nh-message";
        msg.textContent = entry.message;
        li.append(time, ico, msg);
        return li;
      })
    );
  }
  function openNotifyHistory() {
    renderNotifyHistory();
    notifyHistoryEl.classList.add("visible");
  }
  function closeNotifyHistory() {
    notifyHistoryEl.classList.remove("visible");
  }
  function toggleNotifyHistory() {
    if (notifyHistoryEl.classList.contains("visible")) closeNotifyHistory();
    else openNotifyHistory();
  }
  function toggleTheme() {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === "light" ? "" : "light";
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement)
      document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  function showFsBar() {
    statusBarEl.classList.add("fs-visible");
    clearTimeout(_fsHideTimer);
    _fsHideTimer = void 0;
  }
  function scheduleFsHide() {
    if (_fsHideTimer) return;
    _fsHideTimer = setTimeout(() => {
      statusBarEl.classList.remove("fs-visible");
      _fsHideTimer = void 0;
    }, 600);
  }
  function handleFullscreenChange() {
    const isFS = !!(document.fullscreenElement || _doc.webkitFullscreenElement);
    document.body.classList.toggle("is-fullscreen", isFS);
    if (!isFS) {
      statusBarEl.classList.remove("fs-visible");
      clearTimeout(_fsHideTimer);
      _fsHideTimer = void 0;
    }
  }
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  document.addEventListener("mousemove", (e2) => {
    if (!document.fullscreenElement && !_doc.webkitFullscreenElement) return;
    const inZone = e2.clientX < window.innerWidth * 0.2 && e2.clientY > window.innerHeight * 0.9;
    if (inZone) showFsBar();
    else scheduleFsHide();
  });
  statusBarEl.addEventListener("mouseenter", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement) showFsBar();
  });
  statusBarEl.addEventListener("mouseleave", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement)
      scheduleFsHide();
  });
  var _mhudTimer;
  function showMobileHud() {
    document.body.classList.add("mobile-hud-visible");
    clearTimeout(_mhudTimer);
    _mhudTimer = setTimeout(() => {
      document.body.classList.remove("mobile-hud-visible");
      _mhudTimer = void 0;
    }, 3e3);
  }
  function toggleMobileHud() {
    if (document.body.classList.contains("mobile-hud-visible")) {
      document.body.classList.remove("mobile-hud-visible");
      clearTimeout(_mhudTimer);
      _mhudTimer = void 0;
    } else {
      showMobileHud();
    }
  }
  document.getElementById("mobile-hud").addEventListener("pointerdown", showMobileHud, { passive: true });
  logClose.addEventListener("click", hideLogs);
  logIndicator.addEventListener("click", () => {
    logBanner.classList.add("visible");
  });
  notifyClose.addEventListener("click", hideNotify);
  notifyHistoryBtn.addEventListener("click", toggleNotifyHistory);
  notifyHistoryClose.addEventListener("click", closeNotifyHistory);
  notifyHistoryEl.addEventListener("click", (e2) => {
    if (e2.target === notifyHistoryEl) closeNotifyHistory();
  });
  curtain.addEventListener("click", hideCurtain);
  help.addEventListener("click", (e2) => {
    if (e2.target === help) toggleHelp();
  });

  // src/ts/presenter/edit.ts
  var btnEdit = document.getElementById("btn-edit");
  var editMenu = document.getElementById("edit-menu");
  var editWrap = btnEdit.closest(".edit-wrap");
  var config = { default: false, svg: false };
  var ROW_ICONS = {
    Layout: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"/></svg>`,
    Parent: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 14 5.5 8 9 2 5.5 8 2Z"/><path d="M2 9 8 12.5 14 9"/></svg>`,
    Content: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.5h5.5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"/><path d="M9.5 1.5v3.5H13"/><path d="M4.7 9h6.2M4.7 11.3h4.3"/></svg>`,
    Notes: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3.2 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/></svg>`,
    Deck: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4"/><path d="M10.5 4 14 8l-3.5 4"/></svg>`
  };
  function isConfigured(file) {
    const suffix = file.path.split(".").pop()?.toLowerCase() ?? "";
    if (config.suffixes) return config.suffixes.includes(suffix);
    if (suffix === "svg") return config.svg || config.default;
    return config.default;
  }
  function actOn(file) {
    if (isConfigured(file) && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "edit", path: file.path }));
      showNotify(`Opened ${file.name}`);
      return;
    }
    try {
      void navigator.clipboard.writeText(file.path);
      showNotify(`Copied ${file.path}`);
    } catch (_2) {
    }
  }
  function renderEditButton() {
    const files = state.slides[state.slideIndex]?.editableFiles ?? [];
    editMenu.innerHTML = "";
    for (const file of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "edit-row";
      row.insertAdjacentHTML("beforeend", ROW_ICONS[file.label] ?? "");
      const text = document.createElement("span");
      text.className = "edit-row-text";
      const label = document.createElement("span");
      label.className = "edit-row-label";
      label.textContent = file.label;
      const name = document.createElement("span");
      name.className = "edit-row-name";
      name.textContent = file.name;
      text.append(label, name);
      row.appendChild(text);
      row.addEventListener("click", () => {
        actOn(file);
        closeMenu();
      });
      editMenu.appendChild(row);
    }
  }
  function editMenuSetActive(i2) {
    const rows = Array.from(
      editMenu.querySelectorAll(".edit-row")
    );
    if (rows.length === 0) return;
    state._editActive = Math.max(0, Math.min(rows.length - 1, i2));
    rows.forEach((row, idx) => {
      row.classList.toggle("active", idx === state._editActive);
    });
    rows[state._editActive]?.scrollIntoView({ block: "nearest" });
  }
  function editMenuCommit() {
    const files = state.slides[state.slideIndex]?.editableFiles ?? [];
    const file = files[state._editActive];
    if (file) actOn(file);
    closeMenu();
  }
  function onDocClick(e2) {
    const t2 = e2.target;
    if (!btnEdit.contains(t2) && !editMenu.contains(t2)) closeMenu();
  }
  function openMenu() {
    editMenu.classList.add("open");
    btnEdit.setAttribute("aria-expanded", "true");
    editMenuSetActive(0);
    document.addEventListener("click", onDocClick);
    menuOpened(closeMenu);
  }
  function closeMenu() {
    if (!editMenu.classList.contains("open")) return;
    editMenu.classList.remove("open");
    btnEdit.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    menuClosed(closeMenu);
  }
  function toggleMenu() {
    if (editMenu.classList.contains("open")) closeMenu();
    else openMenu();
  }
  function initEditMenu(cfg, wsPort) {
    if (!wsPort) {
      editWrap.style.display = "none";
      return;
    }
    config = cfg;
    btnEdit.addEventListener("click", (e2) => {
      e2.stopPropagation();
      toggleMenu();
    });
    renderEditButton();
  }

  // node_modules/.pnpm/perfect-freehand@1.2.3/node_modules/perfect-freehand/dist/esm/index.mjs
  var { PI: e } = Math;
  var t = e + 1e-4;
  var n = 0.5;
  var r = [1, 1];
  function i(e2, t2, n2, r2 = (e3) => e3) {
    return e2 * r2(0.5 - t2 * (0.5 - n2));
  }
  var { min: a } = Math;
  function o(e2, t2, n2) {
    let r2 = a(1, t2 / n2);
    return a(1, e2 + (a(1, 1 - r2) - e2) * (r2 * 0.275));
  }
  function s(e2) {
    return [-e2[0], -e2[1]];
  }
  function c(e2, t2) {
    return [e2[0] + t2[0], e2[1] + t2[1]];
  }
  function l(e2, t2, n2) {
    return e2[0] = t2[0] + n2[0], e2[1] = t2[1] + n2[1], e2;
  }
  function u(e2, t2) {
    return [e2[0] - t2[0], e2[1] - t2[1]];
  }
  function d(e2, t2, n2) {
    return e2[0] = t2[0] - n2[0], e2[1] = t2[1] - n2[1], e2;
  }
  function f(e2, t2) {
    return [e2[0] * t2, e2[1] * t2];
  }
  function p(e2, t2, n2) {
    return e2[0] = t2[0] * n2, e2[1] = t2[1] * n2, e2;
  }
  function m(e2, t2) {
    return [e2[0] / t2, e2[1] / t2];
  }
  function h(e2) {
    return [e2[1], -e2[0]];
  }
  function g(e2, t2) {
    let n2 = t2[0];
    return e2[0] = t2[1], e2[1] = -n2, e2;
  }
  function ee(e2, t2) {
    return e2[0] * t2[0] + e2[1] * t2[1];
  }
  function _(e2, t2) {
    return e2[0] === t2[0] && e2[1] === t2[1];
  }
  function v(e2) {
    return Math.hypot(e2[0], e2[1]);
  }
  function y(e2, t2) {
    let n2 = e2[0] - t2[0], r2 = e2[1] - t2[1];
    return n2 * n2 + r2 * r2;
  }
  function b(e2) {
    return m(e2, v(e2));
  }
  function x(e2, t2) {
    return Math.hypot(e2[1] - t2[1], e2[0] - t2[0]);
  }
  function S(e2, t2, n2) {
    let r2 = Math.sin(n2), i2 = Math.cos(n2), a2 = e2[0] - t2[0], o2 = e2[1] - t2[1], s2 = a2 * i2 - o2 * r2, c2 = a2 * r2 + o2 * i2;
    return [s2 + t2[0], c2 + t2[1]];
  }
  function C(e2, t2, n2, r2) {
    let i2 = Math.sin(r2), a2 = Math.cos(r2), o2 = t2[0] - n2[0], s2 = t2[1] - n2[1], c2 = o2 * a2 - s2 * i2, l2 = o2 * i2 + s2 * a2;
    return e2[0] = c2 + n2[0], e2[1] = l2 + n2[1], e2;
  }
  function w(e2, t2, n2) {
    return c(e2, f(u(t2, e2), n2));
  }
  function te(e2, t2, n2, r2) {
    let i2 = n2[0] - t2[0], a2 = n2[1] - t2[1];
    return e2[0] = t2[0] + i2 * r2, e2[1] = t2[1] + a2 * r2, e2;
  }
  function T(e2, t2, n2) {
    return c(e2, f(t2, n2));
  }
  var E = [0, 0];
  var D = [0, 0];
  var O = [0, 0];
  function k(e2, n2) {
    let r2 = T(e2, b(h(u(e2, c(e2, [1, 1])))), -n2), i2 = [], a2 = 1 / 13;
    for (let n3 = a2; n3 <= 1; n3 += a2) i2.push(S(r2, e2, t * 2 * n3));
    return i2;
  }
  function A(e2, n2, r2) {
    let i2 = [], a2 = 1 / r2;
    for (let r3 = a2; r3 <= 1; r3 += a2) i2.push(S(n2, e2, t * r3));
    return i2;
  }
  function j(e2, t2, n2) {
    let r2 = u(t2, n2), i2 = f(r2, 0.5), a2 = f(r2, 0.51);
    return [u(e2, i2), u(e2, a2), c(e2, a2), c(e2, i2)];
  }
  function M(e2, n2, r2, i2) {
    let a2 = [], o2 = T(e2, n2, r2), s2 = 1 / i2;
    for (let n3 = s2; n3 < 1; n3 += s2) a2.push(S(o2, e2, t * 3 * n3));
    return a2;
  }
  function ne(e2, t2, n2) {
    return [c(e2, f(t2, n2)), c(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2))];
  }
  function N(e2, t2, n2) {
    return e2 === false || e2 === void 0 ? 0 : e2 === true ? Math.max(t2, n2) : e2;
  }
  function re(e2, t2, n2) {
    return e2.slice(0, 10).reduce((e3, r2) => {
      let i2 = r2.pressure;
      return t2 && (i2 = o(e3, r2.distance, n2)), (e3 + i2) / 2;
    }, e2[0].pressure);
  }
  function P(e2, n2 = {}) {
    let { size: r2 = 16, smoothing: a2 = 0.5, thinning: f2 = 0.5, simulatePressure: m2 = true, easing: _2 = (e3) => e3, start: v2 = {}, end: b2 = {}, last: x2 = false } = n2, { cap: S2 = true, easing: w2 = (e3) => e3 * (2 - e3) } = v2, { cap: T2 = true, easing: P2 = (e3) => --e3 * e3 * e3 + 1 } = b2;
    if (e2.length === 0 || r2 <= 0) return [];
    let F2 = e2[e2.length - 1].runningLength, I2 = N(v2.taper, r2, F2), L2 = N(b2.taper, r2, F2), R2 = (r2 * a2) ** 2, z = [], B = [], V = re(e2, m2, r2), H = i(r2, f2, e2[e2.length - 1].pressure, _2), U, W = e2[0].vector, G = e2[0].point, K = G, q = G, J = K, Y = false;
    for (let n3 = 0; n3 < e2.length; n3++) {
      let { pressure: a3 } = e2[n3], { point: s2, vector: h2, distance: v3, runningLength: b3 } = e2[n3], x3 = n3 === e2.length - 1;
      if (!x3 && F2 - b3 < 3) continue;
      f2 ? (m2 && (a3 = o(V, v3, r2)), H = i(r2, f2, a3, _2)) : H = r2 / 2, U === void 0 && (U = H);
      let S3 = b3 < I2 ? w2(b3 / I2) : 1, T3 = F2 - b3 < L2 ? P2((F2 - b3) / L2) : 1;
      H = Math.max(0.01, H * Math.min(S3, T3));
      let k2 = (x3 ? e2[n3] : e2[n3 + 1]).vector, A2 = x3 ? 1 : ee(h2, k2), j2 = ee(h2, W) < 0 && !Y, M2 = A2 !== null && A2 < 0;
      if (j2 || M2) {
        g(E, W), p(E, E, H);
        for (let e3 = 0; e3 <= 1; e3 += 0.07692307692307693) d(D, s2, E), C(D, D, s2, t * e3), q = [D[0], D[1]], z.push(q), l(O, s2, E), C(O, O, s2, t * -e3), J = [O[0], O[1]], B.push(J);
        G = q, K = J, M2 && (Y = true);
        continue;
      }
      if (Y = false, x3) {
        g(E, h2), p(E, E, H), z.push(u(s2, E)), B.push(c(s2, E));
        continue;
      }
      te(E, k2, h2, A2), g(E, E), p(E, E, H), d(D, s2, E), q = [D[0], D[1]], (n3 <= 1 || y(G, q) > R2) && (z.push(q), G = q), l(O, s2, E), J = [O[0], O[1]], (n3 <= 1 || y(K, J) > R2) && (B.push(J), K = J), V = a3, W = h2;
    }
    let X = [e2[0].point[0], e2[0].point[1]], Z = e2.length > 1 ? [e2[e2.length - 1].point[0], e2[e2.length - 1].point[1]] : c(e2[0].point, [1, 1]), Q = [], $ = [];
    if (e2.length === 1) {
      if (!(I2 || L2) || x2) return k(X, U || H);
    } else {
      I2 || L2 && e2.length === 1 || (S2 ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));
      let t2 = h(s(e2[e2.length - 1].vector));
      L2 || I2 && e2.length === 1 ? $.push(Z) : T2 ? $.push(...M(Z, t2, H, 29)) : $.push(...ne(Z, t2, H));
    }
    return z.concat($, B.reverse(), Q);
  }
  var F = [0, 0];
  function I(e2) {
    return e2 != null && e2 >= 0;
  }
  function L(e2, t2 = {}) {
    let { streamline: i2 = 0.5, size: a2 = 16, last: o2 = false } = t2;
    if (e2.length === 0) return [];
    let s2 = 0.15 + (1 - i2) * 0.85, l2 = Array.isArray(e2[0]) ? e2 : e2.map(({ x: e3, y: t3, pressure: r2 = n }) => [e3, t3, r2]);
    if (l2.length === 2) {
      let e3 = l2[1];
      l2 = l2.slice(0, -1);
      for (let t3 = 1; t3 < 5; t3++) l2.push(w(l2[0], e3, t3 / 4));
    }
    l2.length === 1 && (l2 = [...l2, [...c(l2[0], r), ...l2[0].slice(2)]]);
    let u2 = [{ point: [l2[0][0], l2[0][1]], pressure: I(l2[0][2]) ? l2[0][2] : 0.25, vector: [...r], distance: 0, runningLength: 0 }], f2 = false, p2 = 0, m2 = u2[0], h2 = l2.length - 1;
    for (let e3 = 1; e3 < l2.length; e3++) {
      let t3 = o2 && e3 === h2 ? [l2[e3][0], l2[e3][1]] : w(m2.point, l2[e3], s2);
      if (_(m2.point, t3)) continue;
      let r2 = x(t3, m2.point);
      if (p2 += r2, e3 < h2 && !f2) {
        if (p2 < a2) continue;
        f2 = true;
      }
      d(F, m2.point, t3), m2 = { point: t3, pressure: I(l2[e3][2]) ? l2[e3][2] : n, vector: b(F), distance: r2, runningLength: p2 }, u2.push(m2);
    }
    return u2[0].vector = u2[1]?.vector || [0, 0], u2;
  }
  function R(e2, t2 = {}) {
    return P(L(e2, t2), t2);
  }

  // src/ts/shared/ink.ts
  var HIGHLIGHTER_OPACITY = 0.35;
  var REFERENCE_WIDTH = 1920;
  var REFERENCE_HEIGHT = 1080;
  function inkScale(width, height = 0) {
    const w2 = width > 0 ? width / REFERENCE_WIDTH : 0;
    const h2 = height > 0 ? height / REFERENCE_HEIGHT : 0;
    return Math.max(w2, h2) || 1;
  }
  var PEN_SIZES = [3, 6, 12];
  var HIGHLIGHTER_SIZES = [20, 36, 60];
  var SWATCHES = [
    { label: "Black", token: null, hex: "#000000" },
    { label: "White", token: null, hex: "#ffffff" },
    { label: "Red", token: "red", hex: "#e64553" },
    { label: "Orange", token: "orange", hex: "#fe640b" },
    { label: "Yellow", token: "yellow", hex: "#df8e1d" },
    { label: "Green", token: "green", hex: "#40a02b" },
    { label: "Blue", token: "blue", hex: "#1e66f5" },
    { label: "Purple", token: "purple", hex: "#8839ef" }
  ];
  var easeOutSine = (t2) => Math.sin(t2 * Math.PI / 2);
  function strokeOptions(style, simulate, last) {
    if (style.tool === "highlighter") {
      return {
        size: style.size,
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.4,
        simulatePressure: false,
        start: { cap: false },
        end: { cap: false },
        last
      };
    }
    return {
      size: style.size,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: simulate ? 0.5 : 0.35,
      easing: easeOutSine,
      simulatePressure: simulate,
      last
    };
  }
  function outlineOf(points, style, simulate, last) {
    return R(points, strokeOptions(style, simulate, last));
  }
  function round(v2, decimals) {
    const f2 = 10 ** decimals;
    const r2 = Math.round(v2 * f2) / f2;
    return String(Object.is(r2, -0) ? 0 : r2);
  }
  function pathData(outline, decimals = 1) {
    const n2 = outline.length;
    if (n2 < 2) return "";
    const mid = (a2, b2) => [
      (a2[0] + b2[0]) / 2,
      (a2[1] + b2[1]) / 2
    ];
    const pt = (p2) => `${round(p2[0], decimals)} ${round(p2[1], decimals)}`;
    const parts = [`M${pt(mid(outline[n2 - 1], outline[0]))}Q`];
    for (let i2 = 0; i2 < n2; i2++) {
      const next = outline[(i2 + 1) % n2];
      parts.push(`${pt(outline[i2])} ${pt(mid(outline[i2], next))}`);
    }
    return `${parts[0]}${parts.slice(1).join(" ")}Z`;
  }
  function simplify(outline, tolerance) {
    if (outline.length < 4 || tolerance <= 0) return outline;
    const keep = new Uint8Array(outline.length);
    keep[0] = 1;
    keep[outline.length - 1] = 1;
    const t2 = tolerance * tolerance;
    const stack = [[0, outline.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      const [ax, ay] = outline[first];
      const [bx, by] = outline[last];
      let worst = -1;
      let index = -1;
      for (let i2 = first + 1; i2 < last; i2++) {
        const d2 = pointSegment2(
          outline[i2][0],
          outline[i2][1],
          ax,
          ay,
          bx,
          by
        );
        if (d2 > worst) {
          worst = d2;
          index = i2;
        }
      }
      if (worst > t2) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    return outline.filter((_2, i2) => keep[i2]);
  }
  function polygonOf(d2) {
    const nums = d2.match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? [];
    const out = [];
    for (let i2 = 0; i2 + 1 < nums.length; i2 += 2) {
      out.push(Number(nums[i2]), Number(nums[i2 + 1]));
    }
    return out;
  }
  function bboxOf(poly) {
    const box = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };
    for (let i2 = 0; i2 + 1 < poly.length; i2 += 2) {
      box.minX = Math.min(box.minX, poly[i2]);
      box.maxX = Math.max(box.maxX, poly[i2]);
      box.minY = Math.min(box.minY, poly[i2 + 1]);
      box.maxY = Math.max(box.maxY, poly[i2 + 1]);
    }
    return box;
  }
  function insidePolygon(poly, x2, y2) {
    let winding = 0;
    const n2 = poly.length / 2;
    for (let i2 = 0; i2 < n2; i2++) {
      const x1 = poly[2 * i2];
      const y1 = poly[2 * i2 + 1];
      const x22 = poly[(2 * i2 + 2) % poly.length];
      const y22 = poly[(2 * i2 + 3) % poly.length];
      const cross = (x22 - x1) * (y2 - y1) - (x2 - x1) * (y22 - y1);
      if (y1 <= y2) {
        if (y22 > y2 && cross > 0) winding++;
      } else if (y22 <= y2 && cross < 0) {
        winding--;
      }
    }
    return winding !== 0;
  }
  function pointSegment2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t2 = len2 === 0 ? 0 : Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)
    );
    const ex = ax + t2 * dx - px;
    const ey = ay + t2 * dy - py;
    return ex * ex + ey * ey;
  }
  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  function eraserHits(poly, box, a2, b2, r2) {
    if (Math.max(a2.x, b2.x) + r2 < box.minX || Math.min(a2.x, b2.x) - r2 > box.maxX || Math.max(a2.y, b2.y) + r2 < box.minY || Math.min(a2.y, b2.y) - r2 > box.maxY) {
      return false;
    }
    if (insidePolygon(poly, a2.x, a2.y) || insidePolygon(poly, b2.x, b2.y)) {
      return true;
    }
    const r22 = r2 * r2;
    const n2 = poly.length / 2;
    for (let i2 = 0; i2 < n2; i2++) {
      const cx = poly[2 * i2];
      const cy = poly[2 * i2 + 1];
      const dx = poly[(2 * i2 + 2) % poly.length];
      const dy = poly[(2 * i2 + 3) % poly.length];
      if (segmentsCross(a2.x, a2.y, b2.x, b2.y, cx, cy, dx, dy) || pointSegment2(cx, cy, a2.x, a2.y, b2.x, b2.y) <= r22 || pointSegment2(a2.x, a2.y, cx, cy, dx, dy) <= r22 || pointSegment2(b2.x, b2.y, cx, cy, dx, dy) <= r22) {
        return true;
      }
    }
    return false;
  }
  function newInkId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `ink-${Array.from(bytes, (b2) => b2.toString(36).padStart(2, "0")).join("")}`;
  }
  var ID_RE = /^ink-[A-Za-z0-9_-]{1,64}$/;
  var HEX_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
  var TOKEN_RE = /^[a-z][a-z-]{0,31}$/;
  var PATH_RE = /^M[MQLZ0-9eE.,\s+-]*$/;
  function finite(v2, low, high) {
    return typeof v2 === "number" && Number.isFinite(v2) && v2 > low && v2 <= high;
  }
  function styleFrom(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const s2 = raw;
    if (typeof s2.id !== "string" || !ID_RE.test(s2.id)) return null;
    if (s2.tool !== "pen" && s2.tool !== "highlighter") return null;
    if (typeof s2.fill !== "string" || !HEX_RE.test(s2.fill)) return null;
    if (s2.token != null && (typeof s2.token !== "string" || !TOKEN_RE.test(s2.token)))
      return null;
    if (!finite(s2.size, 0, 2e3)) return null;
    return {
      id: s2.id,
      tool: s2.tool,
      fill: s2.fill,
      token: s2.token ?? null,
      size: s2.size
    };
  }
  function strokeFrom(raw) {
    const style = styleFrom(raw);
    if (!style) return null;
    const s2 = raw;
    if (typeof s2.d !== "string" || s2.d.length > 2e6 || !PATH_RE.test(s2.d))
      return null;
    const stroke = { ...style, d: s2.d };
    if (s2.opacity !== void 0) {
      if (!finite(s2.opacity, 0, 1)) return null;
      stroke.opacity = s2.opacity;
    }
    return stroke;
  }
  function flatten(points) {
    const out = [];
    for (const [x2, y2, p2] of points) {
      out.push(
        Math.round(x2 * 100) / 100,
        Math.round(y2 * 100) / 100,
        Math.round(p2 * 1e3) / 1e3
      );
    }
    return out;
  }
  function unflatten(flat) {
    if (!Array.isArray(flat) || flat.length % 3 !== 0) return null;
    const out = [];
    for (let i2 = 0; i2 < flat.length; i2 += 3) {
      const [x2, y2, p2] = [flat[i2], flat[i2 + 1], flat[i2 + 2]];
      if (![x2, y2, p2].every((v2) => typeof v2 === "number" && Number.isFinite(v2)))
        return null;
      out.push([x2, y2, Math.max(0, Math.min(1, p2))]);
    }
    return out;
  }
  function finish(live, points, tolerance = 0.1) {
    const outline = outlineOf(points, live, live.simulate, true);
    const stroke = {
      id: live.id,
      tool: live.tool,
      fill: live.fill,
      token: live.token,
      size: live.size,
      d: pathData(simplify(outline, tolerance), 1)
    };
    if (live.tool === "highlighter") stroke.opacity = HIGHLIGHTER_OPACITY;
    return stroke;
  }

  // src/ts/shared/inkpad.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ERASER_RADIUS_PX = 10;
  var PALM_MS = 1500;
  var SWALLOW_MS = 400;
  function paintStroke(el, s2) {
    if (s2.id) el.id = s2.id;
    if (s2.d !== void 0) el.setAttribute("d", s2.d);
    el.setAttribute("fill", s2.fill);
    const classes = [
      ...s2.token ? [`inkflow-fill-${s2.token}`] : [],
      ...s2.tool === "highlighter" ? ["inkflow-highlighter"] : []
    ];
    el.setAttribute("class", classes.join(" "));
    const opacity = s2.opacity ?? (s2.tool === "highlighter" ? HIGHLIGHTER_OPACITY : void 0);
    if (opacity !== void 0 && opacity < 1)
      el.setAttribute("fill-opacity", String(opacity));
    else el.removeAttribute("fill-opacity");
    el.setAttribute("inkflow:tool", s2.tool);
    el.setAttribute("inkflow:size", String(Math.round(s2.size * 100) / 100));
    return el;
  }
  function strokeElement(stroke) {
    return paintStroke(
      document.createElementNS(SVG_NS, "path"),
      stroke
    );
  }
  function strokeOf(el) {
    const d2 = el.getAttribute("d");
    const fill = el.getAttribute("fill");
    if (!el.id || !d2 || !fill) return null;
    const token = (el.getAttribute("class") ?? "").split(/\s+/).find((c2) => c2.startsWith("inkflow-fill-"))?.slice("inkflow-fill-".length) ?? null;
    const tool = el.getAttribute("inkflow:tool") === "highlighter" ? "highlighter" : "pen";
    const stroke = {
      id: el.id,
      tool,
      fill,
      token,
      size: Number(el.getAttribute("inkflow:size")) || 1,
      d: d2
    };
    const opacity = Number(el.getAttribute("fill-opacity"));
    if (opacity > 0 && opacity < 1) stroke.opacity = opacity;
    return stroke;
  }
  var shapes = /* @__PURE__ */ new WeakMap();
  function shapeOf(el) {
    const d2 = el.getAttribute("d") ?? "";
    let shape = shapes.get(el);
    if (!shape || shape.d !== d2) {
      const poly = polygonOf(d2);
      shape = { d: d2, poly, box: bboxOf(poly) };
      shapes.set(el, shape);
    }
    return shape;
  }
  var InkPad = class {
    host;
    gesture = null;
    frame = 0;
    lastPenAt = -Infinity;
    swallowUntil = -Infinity;
    swallowAt = { x: Number.NaN, y: Number.NaN };
    constructor(host) {
      this.host = host;
      const s2 = host.surface;
      s2.addEventListener("pointerdown", (e2) => this.down(e2), {
        capture: true
      });
      s2.addEventListener("pointermove", (e2) => this.move(e2), {
        capture: true
      });
      s2.addEventListener("pointerup", (e2) => this.up(e2, false), {
        capture: true
      });
      s2.addEventListener("pointercancel", (e2) => this.up(e2, true), {
        capture: true
      });
      for (const type of ["touchstart", "touchmove", "touchend"]) {
        s2.addEventListener(type, (e2) => this.claimTouch(e2), {
          capture: true,
          passive: false
        });
      }
      window.addEventListener("click", (e2) => this.claimClick(e2), true);
      s2.addEventListener("contextmenu", (e2) => this.claimClick(e2), true);
    }
    // A stroke or an erase is in progress.
    get busy() {
      return this.gesture !== null;
    }
    // Drop the gesture in progress (the slide is going away).
    cancel() {
      const g2 = this.gesture;
      if (!g2) return;
      this.gesture = null;
      cancelAnimationFrame(this.frame);
      if (g2.kind === "draw") {
        g2.path.remove();
        this.host.onAbandon?.(g2.live);
      } else {
        for (const el of g2.hits.values())
          el.style.removeProperty("display");
        g2.cursor.remove();
      }
    }
    claimTouch(e2) {
      if (this.gesture || performance.now() < this.swallowUntil) {
        e2.stopPropagation();
        if (e2.cancelable && e2.type !== "touchstart") e2.preventDefault();
      }
    }
    // Only the click the browser makes of a gesture's own press and release
    // (where the pointer let go, just after): a click elsewhere, such as on
    // the palette right after a stroke, is the user's.
    claimClick(e2) {
      const near = Math.hypot(
        e2.clientX - this.swallowAt.x,
        e2.clientY - this.swallowAt.y
      ) < 16;
      if (this.gesture || performance.now() < this.swallowUntil && near) {
        e2.stopPropagation();
        e2.preventDefault();
      }
    }
    swallow(e2) {
      e2.preventDefault();
      e2.stopPropagation();
      this.swallowUntil = performance.now() + SWALLOW_MS;
      this.swallowAt = { x: e2.clientX, y: e2.clientY };
    }
    down(e2) {
      if (e2.pointerType === "pen") this.lastPenAt = performance.now();
      if (this.gesture) {
        if (e2.pointerId !== this.gesture.pointerId) this.swallow(e2);
        return;
      }
      if (!this.host.active() || this.host.allows?.(e2) === false) return;
      if (e2.pointerType !== "pen" && !this.host.fingers()) {
        if (e2.pointerType === "touch" && performance.now() - this.lastPenAt < PALM_MS) {
          this.swallow(e2);
        }
        return;
      }
      if (e2.button !== 0 && e2.button !== 5) return;
      const tool = e2.button === 5 ? "eraser" : this.host.tool();
      const svg = this.host.svg();
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return;
      this.swallow(e2);
      try {
        this.host.surface.setPointerCapture(e2.pointerId);
      } catch {
      }
      const inv = ctm.inverse();
      const unitsPerPx = Math.hypot(inv.a, inv.b);
      const at2 = new DOMPoint(e2.clientX, e2.clientY).matrixTransform(inv);
      if (tool === "eraser") {
        const cursor = document.createElementNS(
          SVG_NS,
          "circle"
        );
        cursor.setAttribute("class", "inkflow-eraser-cursor");
        cursor.setAttribute("r", String(ERASER_RADIUS_PX * unitsPerPx));
        cursor.setAttribute("cx", String(at2.x));
        cursor.setAttribute("cy", String(at2.y));
        cursor.setAttribute("stroke-width", String(1.5 * unitsPerPx));
        svg.appendChild(cursor);
        this.gesture = {
          kind: "erase",
          pointerId: e2.pointerId,
          svg,
          inv,
          last: { x: e2.clientX, y: e2.clientY },
          hits: /* @__PURE__ */ new Map(),
          local: /* @__PURE__ */ new Map(),
          cursor
        };
        this.erase(e2.clientX, e2.clientY);
        return;
      }
      const pen = e2.pointerType === "pen";
      const style = this.host.style(tool, svg);
      const simulate = tool === "pen" && (!pen || e2.pressure === 0 || e2.pressure === 0.5);
      const live = { ...style, id: newInkId(), simulate };
      const path = paintStroke(
        document.createElementNS(SVG_NS, "path"),
        live
      );
      path.classList.add("inkflow-live-stroke");
      svg.appendChild(path);
      this.gesture = {
        kind: "draw",
        pointerId: e2.pointerId,
        inv,
        minDist: 0.4 * unitsPerPx,
        live,
        points: [[at2.x, at2.y, simulate ? 0.5 : e2.pressure]],
        predicted: [],
        sent: 0,
        path
      };
      this.schedule();
    }
    move(e2) {
      if (e2.pointerType === "pen") this.lastPenAt = performance.now();
      const g2 = this.gesture;
      if (!g2 || e2.pointerId !== g2.pointerId) return;
      e2.preventDefault();
      e2.stopPropagation();
      const samples = e2.getCoalescedEvents?.() ?? [];
      const events = samples.length ? samples : [e2];
      if (g2.kind === "erase") {
        for (const s2 of events) this.erase(s2.clientX, s2.clientY);
        return;
      }
      for (const s2 of events) this.sample(g2, s2, g2.points);
      g2.predicted = [];
      for (const p2 of e2.getPredictedEvents?.() ?? []) {
        this.sample(g2, p2, g2.predicted);
      }
      this.schedule();
    }
    sample(g2, e2, into) {
      const p2 = new DOMPoint(e2.clientX, e2.clientY).matrixTransform(g2.inv);
      const prev = into[into.length - 1] ?? g2.points[g2.points.length - 1];
      if (prev && Math.hypot(p2.x - prev[0], p2.y - prev[1]) < g2.minDist)
        return;
      into.push([p2.x, p2.y, g2.live.simulate ? 0.5 : e2.pressure]);
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const g2 = this.gesture;
        if (g2?.kind !== "draw") return;
        const pts = g2.predicted.length ? g2.points.concat(g2.predicted) : g2.points;
        g2.path.setAttribute(
          "d",
          pathData(outlineOf(pts, g2.live, g2.live.simulate, false), 2)
        );
        if (g2.points.length > g2.sent) {
          this.host.onDraw?.(g2.live, g2.sent, g2.points.slice(g2.sent));
          g2.sent = g2.points.length;
        }
      });
    }
    erase(clientX, clientY) {
      const g2 = this.gesture;
      if (g2?.kind !== "erase") return;
      const at2 = new DOMPoint(clientX, clientY).matrixTransform(g2.inv);
      g2.cursor.setAttribute("cx", String(at2.x));
      g2.cursor.setAttribute("cy", String(at2.y));
      const a2 = new DOMPoint(g2.last.x, g2.last.y);
      const b2 = new DOMPoint(clientX, clientY);
      g2.last = { x: clientX, y: clientY };
      for (const el of this.host.erasables(g2.svg)) {
        if (g2.hits.has(el.id) || el.style.display === "none") continue;
        let local = g2.local.get(el);
        if (!local) {
          const m2 = el.getScreenCTM();
          if (!m2) continue;
          local = m2.inverse();
          g2.local.set(el, local);
        }
        const shape = shapeOf(el);
        const r2 = ERASER_RADIUS_PX * Math.hypot(local.a, local.b);
        if (eraserHits(
          shape.poly,
          shape.box,
          a2.matrixTransform(local),
          b2.matrixTransform(local),
          r2
        )) {
          el.style.display = "none";
          g2.hits.set(el.id, el);
        }
      }
    }
    up(e2, cancelled) {
      const g2 = this.gesture;
      if (!g2 || e2.pointerId !== g2.pointerId) return;
      this.swallow(e2);
      if (cancelled) {
        this.cancel();
        return;
      }
      this.gesture = null;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (g2.kind === "erase") {
        g2.cursor.remove();
        if (g2.hits.size)
          this.host.onErase([...g2.hits.keys()], [...g2.hits.values()]);
        return;
      }
      const stroke = finish(g2.live, g2.points);
      g2.path.remove();
      if (stroke.d) this.host.onStroke(stroke, g2.live);
      else this.host.onAbandon?.(g2.live);
    }
  };

  // src/ts/shared/inksettings.ts
  function defaultSettings(fingers) {
    return {
      tool: "pen",
      pen: { swatch: 2, custom: "#e64553", size: 1 },
      highlighter: { swatch: 4, custom: "#df8e1d", size: 1 },
      fingers,
      keep: false
    };
  }
  var HEX_RE2 = /^#[0-9a-fA-F]{6}$/;
  function toolFrom(raw, fallback, sizes) {
    if (typeof raw !== "object" || raw === null) return { ...fallback };
    const r2 = raw;
    const swatch = r2.swatch === null ? null : Number.isInteger(r2.swatch) && r2.swatch >= 0 && r2.swatch < SWATCHES.length ? r2.swatch : fallback.swatch;
    return {
      swatch,
      custom: typeof r2.custom === "string" && HEX_RE2.test(r2.custom) ? r2.custom : fallback.custom,
      size: Number.isInteger(r2.size) && r2.size >= 0 && r2.size < sizes ? r2.size : fallback.size
    };
  }
  function settingsFrom(raw, fallback) {
    if (typeof raw !== "object" || raw === null)
      return structuredClone(fallback);
    const r2 = raw;
    return {
      tool: r2.tool === "pen" || r2.tool === "highlighter" || r2.tool === "eraser" ? r2.tool : fallback.tool,
      pen: toolFrom(r2.pen, fallback.pen, PEN_SIZES.length),
      highlighter: toolFrom(
        r2.highlighter,
        fallback.highlighter,
        HIGHLIGHTER_SIZES.length
      ),
      fingers: typeof r2.fingers === "boolean" ? r2.fingers : fallback.fingers,
      keep: typeof r2.keep === "boolean" ? r2.keep : fallback.keep
    };
  }
  function sizesOf(tool) {
    return tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES;
  }
  function styleFor(s2, tool, width, tokenColor2, height = 0) {
    const t2 = s2[tool];
    const swatch = t2.swatch === null ? null : SWATCHES[t2.swatch];
    const fill = swatch ? swatch.token && tokenColor2(swatch.token) || swatch.hex : t2.custom;
    return {
      tool,
      fill: normalizeHex(fill) ?? "#000000",
      token: swatch?.token ?? null,
      size: sizesOf(tool)[t2.size] * inkScale(width, height)
    };
  }
  function normalizeHex(color) {
    const c2 = color.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c2)) return c2;
    if (/^#[0-9a-f]{3}$/.test(c2))
      return `#${[...c2.slice(1)].map((x2) => x2 + x2).join("")}`;
    const m2 = c2.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (m2) {
      return `#${m2.slice(1, 4).map((v2) => Math.min(255, Number(v2)).toString(16).padStart(2, "0")).join("")}`;
    }
    return null;
  }

  // src/ts/shared/inkpalette.ts
  var ICONS = {
    pen: '<path d="M3 13.5 4 10l7-7 2.5 2.5-7 7Z"/><path d="m9.5 4.5 2 2"/>',
    highlighter: '<path d="M5 11 3.5 14h4l.8-1.8"/><path d="m5 11 6.5-8.5 3 2.4L8.3 12.2Z"/>',
    eraser: '<path d="M6.5 14H14"/><path d="M2.8 10.2 9 4l4 4-6 6H5.6Z"/><path d="m6 7 4 4"/>',
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    clear: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
    fingers: '<path d="M6 8.5V3.2a1.1 1.1 0 0 1 2.2 0V7.5"/><path d="M8.2 7V6a1.1 1.1 0 0 1 2.2 0v1.5"/><path d="M10.4 7.2a1.1 1.1 0 0 1 2.1.3V10c0 2.5-1.6 4-4 4H8c-1.7 0-2.6-.8-3.6-2.3L3.2 9.8a1 1 0 0 1 1.6-1.2L6 9.8"/>',
    keep: '<path d="M4 2.5h6.5L13 5v8.5H4Z"/><path d="M6 2.5v3.5h4V2.5M6 13.5V9.5h5v4"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>'
  };
  function icon(name) {
    return `<svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  }
  function button(title, content, data) {
    const b2 = document.createElement("button");
    b2.type = "button";
    b2.className = "ink-btn";
    b2.title = title;
    b2.setAttribute("aria-label", title);
    b2.innerHTML = content;
    for (const [k2, v2] of Object.entries(data)) b2.dataset[k2] = v2;
    return b2;
  }
  function group(...children) {
    const g2 = document.createElement("div");
    g2.className = "ink-group";
    g2.append(...children);
    return g2;
  }
  var TOOL_TITLES = {
    pen: "Pen",
    highlighter: "Highlighter",
    eraser: "Eraser (also a pen's eraser end): wipe over strokes to remove them"
  };
  var InkPalette = class {
    el;
    opts;
    custom;
    sizes;
    constructor(opts) {
      this.opts = opts;
      const el = document.createElement("div");
      el.className = "ink-palette";
      el.setAttribute("role", "toolbar");
      el.setAttribute("aria-label", "Ink");
      this.el = el;
      const tools = group(
        ...["pen", "highlighter", "eraser"].map(
          (t2) => button(TOOL_TITLES[t2], icon(t2), { inkTool: t2 })
        )
      );
      const swatches = group(
        ...SWATCHES.map((s2, i2) => {
          const b2 = button(
            s2.label,
            `<span class="ink-swatch" style="background:${s2.token ? `var(--inkflow-${s2.token}, ${s2.hex})` : s2.hex}"></span>`,
            { inkSwatch: String(i2) }
          );
          return b2;
        })
      );
      swatches.classList.add("ink-colours");
      const customLabel = document.createElement("label");
      customLabel.className = "ink-btn ink-custom";
      customLabel.title = "Another colour";
      customLabel.dataset.inkCustom = "";
      this.custom = document.createElement("input");
      this.custom.type = "color";
      this.custom.setAttribute("aria-label", "Another colour");
      customLabel.append(this.custom);
      swatches.append(customLabel);
      this.sizes = group();
      this.sizes.classList.add("ink-sizes");
      const actions = group(
        button(opts.undoTitle, icon("undo"), { inkAction: "undo" }),
        button(opts.clearTitle, icon("clear"), { inkAction: "clear" })
      );
      const toggles = group(
        button(
          "Draw with a mouse or a finger too (off: only a pen draws, so clicks and swipes still navigate)",
          icon("fingers"),
          { inkToggle: "fingers" }
        )
      );
      if (opts.keep) {
        toggles.append(
          button(
            "Keep: save new strokes with the slide (off: they last for this talk only)",
            icon("keep"),
            { inkToggle: "keep" }
          )
        );
      }
      if (opts.close) {
        toggles.append(
          button("Leave ink mode (i)", icon("close"), {
            inkAction: "close"
          })
        );
      }
      el.append(tools, swatches, this.sizes, actions, toggles);
      el.addEventListener("pointerdown", (e2) => e2.stopPropagation());
      el.addEventListener("click", (e2) => {
        e2.stopPropagation();
        const b2 = e2.target.closest(".ink-btn");
        if (!b2) return;
        this.press(b2.dataset);
      });
      this.custom.addEventListener("input", () => {
        const s2 = this.settings;
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: null, custom: this.custom.value };
        if (s2.tool === "eraser") s2.tool = tool;
        this.commit(s2);
      });
      this.render();
    }
    get settings() {
      return structuredClone(this.opts.settings);
    }
    set(settings2) {
      this.opts.settings = settings2;
      this.render();
    }
    // The pen tool colour and width apply to: the current one, or the pen
    // while the eraser is picked.
    penTool() {
      return this.opts.settings.tool === "highlighter" ? "highlighter" : "pen";
    }
    press(data) {
      const s2 = this.settings;
      if (data.inkTool) {
        s2.tool = data.inkTool;
      } else if (data.inkSwatch !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: Number(data.inkSwatch) };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkSize !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], size: Number(data.inkSize) };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkCustom !== void 0) {
        const tool = this.penTool();
        s2[tool] = { ...s2[tool], swatch: null };
        if (s2.tool === "eraser") s2.tool = tool;
      } else if (data.inkToggle === "fingers") {
        s2.fingers = !s2.fingers;
      } else if (data.inkToggle === "keep") {
        s2.keep = !s2.keep;
      } else if (data.inkAction === "undo") {
        this.opts.undo();
        return;
      } else if (data.inkAction === "clear") {
        this.opts.clear();
        return;
      } else if (data.inkAction === "close") {
        this.opts.close?.();
        return;
      }
      this.commit(s2);
    }
    commit(s2) {
      this.opts.settings = s2;
      this.render();
      this.opts.onChange(structuredClone(s2));
    }
    render() {
      const s2 = this.opts.settings;
      const tool = this.penTool();
      const t2 = s2[tool];
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-tool]"
      )) {
        b2.setAttribute(
          "aria-pressed",
          String(b2.dataset.inkTool === s2.tool)
        );
      }
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-swatch]"
      )) {
        b2.setAttribute(
          "aria-pressed",
          String(t2.swatch === Number(b2.dataset.inkSwatch))
        );
      }
      this.custom.parentElement.classList.toggle("on", t2.swatch === null);
      this.custom.value = t2.custom;
      const sizes = sizesOf(tool);
      const largest = sizes[sizes.length - 1];
      this.sizes.replaceChildren(
        ...sizes.map((size, i2) => {
          const px = Math.max(3, Math.round(size / largest * 16));
          const b2 = button(
            ["Thin", "Medium", "Thick"][i2] ?? `Size ${i2 + 1}`,
            `<span class="ink-dot ${tool}" style="width:${px}px;height:${tool === "highlighter" ? Math.max(3, Math.round(px / 2.5)) : px}px"></span>`,
            { inkSize: String(i2) }
          );
          b2.setAttribute("aria-pressed", String(t2.size === i2));
          return b2;
        })
      );
      this.el.classList.toggle("erasing", s2.tool === "eraser");
      for (const b2 of this.el.querySelectorAll(
        "[data-ink-toggle]"
      )) {
        const key = b2.dataset.inkToggle;
        b2.setAttribute("aria-pressed", String(s2[key]));
      }
    }
  };
  function loadSettings(key, fingers) {
    const fallback = defaultSettings(fingers);
    try {
      const raw = localStorage.getItem(key);
      return raw ? settingsFrom(JSON.parse(raw), fallback) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveSettings(key, settings2) {
    try {
      localStorage.setItem(key, JSON.stringify(settings2));
    } catch {
    }
  }

  // src/ts/presenter/inkstore.ts
  var UNDO_LIMIT = 200;
  var SlideInk = class {
    strokes = [];
    // Bumped on every change, so a render can tell it is up to date.
    rev = 0;
    history = [];
    // Show these strokes; one with the id of a stroke already here replaces it
    // in place (a relayed stroke finishing, a save coming back).
    add(strokes) {
      for (const s2 of strokes) {
        const i2 = this.strokes.findIndex((x2) => x2.id === s2.id);
        if (i2 >= 0) this.strokes[i2] = s2;
        else this.strokes.push(s2);
      }
      if (strokes.length) this.rev++;
    }
    // Stop showing these; returns the ones that were here.
    remove(ids) {
      const gone = new Set(ids);
      const removed = this.strokes.filter((s2) => gone.has(s2.id));
      if (removed.length) {
        this.strokes = this.strokes.filter((s2) => !gone.has(s2.id));
        this.rev++;
      }
      return removed;
    }
    record(action) {
      if (!action.strokes.length) return;
      this.history.push(action);
      this.history.splice(0, this.history.length - UNDO_LIMIT);
    }
    // The last action, taken off the history: the caller undoes it.
    popUndo() {
      return this.history.pop() ?? null;
    }
    get canUndo() {
      return this.history.length > 0;
    }
    // Saved strokes the slide's ink file now shows: no longer held here.
    settle(inFile) {
      const before = this.strokes.length;
      this.strokes = this.strokes.filter((s2) => !inFile.has(s2.id));
      if (this.strokes.length !== before) this.rev++;
    }
  };
  var InkStore = class {
    slides = /* @__PURE__ */ new Map();
    get(slideId2) {
      let ink = this.slides.get(slideId2);
      if (!ink) {
        ink = new SlideInk();
        this.slides.set(slideId2, ink);
      }
      return ink;
    }
    // Every slide's strokes, for a window that just connected.
    snapshot() {
      const out = {};
      for (const [id, ink] of this.slides) {
        const shown = ink.strokes.map(({ saved: _2, ...s2 }) => s2);
        if (shown.length) out[id] = shown;
      }
      return out;
    }
  };

  // src/ts/presenter/slidehooks.ts
  var mounted = [];
  var leaving = [];
  function onSlideMounted(fn) {
    mounted.push(fn);
  }
  function onSlideLeaving(fn) {
    leaving.push(fn);
  }
  function slideMounted() {
    for (const fn of mounted) fn();
  }
  function slideLeaving() {
    for (const fn of leaving) fn();
  }

  // src/ts/shared/easing.ts
  var NAMED_CURVES = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1]
  };
  var CUBIC_BEZIER_PATTERN = /^cubic-bezier\(\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*\)$/;
  function parseControlPoints(spec) {
    if (!spec) return null;
    const trimmed = spec.trim();
    if (trimmed in NAMED_CURVES) return NAMED_CURVES[trimmed];
    const match = CUBIC_BEZIER_PATTERN.exec(trimmed);
    if (!match) return null;
    const points = [match[1], match[2], match[3], match[4]].map(Number);
    return points.every(Number.isFinite) ? points : null;
  }
  var identity = (progress) => progress;
  function makeCubicBezier(points) {
    const [x1, y1, x2, y2] = points;
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t2) => ((ax * t2 + bx) * t2 + cx) * t2;
    const sampleY = (t2) => ((ay * t2 + by) * t2 + cy) * t2;
    const sampleSlopeX = (t2) => (3 * ax * t2 + 2 * bx) * t2 + cx;
    const solveForT = (x3) => {
      let t2 = x3;
      for (let iteration = 0; iteration < 8; iteration++) {
        const error = sampleX(t2) - x3;
        if (Math.abs(error) < 1e-6) return t2;
        const slope = sampleSlopeX(t2);
        if (Math.abs(slope) < 1e-6) break;
        t2 -= error / slope;
      }
      let lower = 0;
      let upper = 1;
      t2 = x3;
      while (lower < upper) {
        const value = sampleX(t2);
        if (Math.abs(value - x3) < 1e-6) return t2;
        if (x3 > value) lower = t2;
        else upper = t2;
        t2 = (lower + upper) / 2;
      }
      return t2;
    };
    return (progress) => {
      if (progress <= 0) return 0;
      if (progress >= 1) return 1;
      return sampleY(solveForT(progress));
    };
  }
  function cubicBezierEasing(spec) {
    const points = parseControlPoints(spec);
    if (!points) return identity;
    const [x1, y1, x2, y2] = points;
    if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return identity;
    return makeCubicBezier(points);
  }

  // src/ts/shared/gestures.ts
  var DELTA_LINE = 1;
  var DELTA_PAGE = 2;
  var LINE_PX = 40;
  var PAGE_PX = 800;
  function wheelPixels(delta, mode, pagePx = PAGE_PX) {
    if (mode === DELTA_LINE) return delta * LINE_PX;
    if (mode === DELTA_PAGE) return delta * pagePx;
    return delta;
  }
  var PINCH_PER_PX = 0.01;
  var MAX_WHEEL_STEP = Math.log(1.2);
  function wheelZoomLog(deltaY, deltaMode) {
    const z = -wheelPixels(deltaY, deltaMode) * PINCH_PER_PX;
    return Math.min(Math.max(z, -MAX_WHEEL_STEP), MAX_WHEEL_STEP);
  }
  function midpoint(a2, b2) {
    return { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  }
  function distance(a2, b2) {
    return Math.hypot(a2.x - b2.x, a2.y - b2.y);
  }
  var TOUCH_DEFAULTS = {
    windowMs: 200,
    slopPx: 10,
    tapMs: 300,
    doubleTapMs: 350,
    doubleTapPx: 30
  };
  var TouchTracker = class {
    opts;
    phase = "idle";
    fingers = /* @__PURE__ */ new Map();
    first = null;
    moved = false;
    committed = false;
    pair = null;
    last = null;
    lastTap = null;
    // This sequence had a second finger: nothing it does is a swipe or tap.
    multi = false;
    constructor(opts = {}) {
      this.opts = { ...TOUCH_DEFAULTS, ...opts };
    }
    // Fingers are down and at least one of them is the gesture's (a pinch,
    // or one left over from it): clicks and swipes are not the page's.
    get claimed() {
      return this.phase === "pinch" || this.phase === "spent";
    }
    get pinching() {
      return this.phase === "pinch";
    }
    // The sequence in progress has had more than one finger.
    get multiTouch() {
      return this.multi;
    }
    get active() {
      return this.phase !== "idle";
    }
    // The single finger's id while one finger acts alone.
    get single() {
      return this.phase === "single" ? this.first?.id ?? null : null;
    }
    get isCommitted() {
      return this.committed;
    }
    has(id) {
      return this.fingers.has(id);
    }
    down(id, at2, t2) {
      const finger = { id, start: at2, at: at2, t0: t2 };
      if (this.phase === "idle") {
        this.fingers.clear();
        this.fingers.set(id, finger);
        this.first = finger;
        this.moved = false;
        this.committed = false;
        this.multi = false;
        this.phase = "single";
        return { pass: true };
      }
      this.fingers.set(id, finger);
      this.multi = true;
      if (this.phase === "single" && this.first) {
        if (this.committed) return { pass: false };
        this.lastTap = null;
        this.startPinch(this.first.id, id);
        return { pass: false, cancelSingle: true, pinchStart: true };
      }
      if (this.phase === "spent" && this.fingers.size === 2) {
        const other = [...this.fingers.keys()].find((k2) => k2 !== id);
        if (other !== void 0) {
          this.startPinch(other, id);
          return { pass: false, pinchStart: true };
        }
      }
      return { pass: false };
    }
    startPinch(a2, b2) {
      this.phase = "pinch";
      this.pair = [a2, b2];
      this.last = this.measure();
    }
    measure() {
      if (!this.pair) return null;
      const a2 = this.fingers.get(this.pair[0]);
      const b2 = this.fingers.get(this.pair[1]);
      if (!a2 || !b2) return null;
      return { mid: midpoint(a2.at, b2.at), dist: distance(a2.at, b2.at) };
    }
    move(id, at2, t2) {
      const f2 = this.fingers.get(id);
      if (!f2) return { pass: true };
      f2.at = at2;
      if (this.phase === "single" && f2 === this.first) {
        if (!this.moved && distance(at2, f2.start) > this.opts.slopPx)
          this.moved = true;
        return { pass: true, commit: this.tryCommit(t2) };
      }
      if (this.phase === "pinch" && this.pair?.includes(id)) {
        const now = this.measure();
        const before = this.last;
        if (!now || !before) return { pass: false };
        this.last = now;
        const scale = before.dist > 0 && now.dist > 0 ? now.dist / before.dist : 1;
        return {
          pass: false,
          pinch: { scale, from: before.mid, to: now.mid }
        };
      }
      return { pass: false };
    }
    // Time passing with no event: a finger that moved past the slop early
    // commits once the window is over, even if it then holds still.
    tick(t2) {
      return { pass: true, commit: this.tryCommit(t2) };
    }
    tryCommit(t2) {
      if (this.phase !== "single" || this.committed || !this.first)
        return false;
      if (!this.moved || t2 - this.first.t0 < this.opts.windowMs) return false;
      this.committed = true;
      return true;
    }
    // `cancelled`: the browser took the pointer back (pointercancel).
    up(id, at2, t2, cancelled = false) {
      const f2 = this.fingers.get(id);
      if (!f2) return { pass: true };
      f2.at = at2;
      this.fingers.delete(id);
      if (this.phase === "single" && f2 === this.first) {
        const release = !this.committed;
        if (this.fingers.size) {
          this.phase = "spent";
          this.first = null;
        } else this.reset();
        const verdict = {
          pass: true,
          release,
          moved: this.moved
        };
        if (!cancelled && !this.moved && distance(at2, f2.start) <= this.opts.slopPx && t2 - f2.t0 <= this.opts.tapMs) {
          verdict.tap = f2.start;
          const prev = this.lastTap;
          if (prev && t2 - prev.t <= this.opts.doubleTapMs && distance(prev.at, f2.start) <= this.opts.doubleTapPx) {
            verdict.doubleTap = f2.start;
            this.lastTap = null;
          } else {
            this.lastTap = { at: f2.start, t: t2 };
          }
        } else {
          this.lastTap = null;
        }
        return verdict;
      }
      const ended = this.phase === "pinch" && !!this.pair?.includes(id);
      if (ended) {
        this.phase = "spent";
        this.pair = null;
        this.last = null;
      }
      if (this.fingers.size === 0) this.reset();
      return ended ? { pass: false, pinchEnd: true } : { pass: false };
    }
    reset() {
      this.phase = "idle";
      this.fingers.clear();
      this.first = null;
      this.pair = null;
      this.last = null;
      this.committed = false;
    }
  };

  // src/ts/shared/gesturepad.ts
  var CLICK_AFTER_MS = 400;
  var PALM_MS2 = 1500;
  var WHEEL_END_MS = 160;
  function at(e2) {
    return { x: e2.clientX, y: e2.clientY };
  }
  function replica(type, src, pos = src) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: src.pointerId,
      pointerType: src.pointerType,
      isPrimary: src.isPrimary,
      clientX: pos.clientX,
      clientY: pos.clientY,
      screenX: pos.screenX,
      screenY: pos.screenY,
      width: pos.width,
      height: pos.height,
      pressure: type === "pointerup" ? 0 : pos.pressure || 0.5,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      ctrlKey: pos.ctrlKey,
      shiftKey: pos.shiftKey,
      altKey: pos.altKey,
      metaKey: pos.metaKey
    });
  }
  function stop(e2) {
    e2.stopImmediatePropagation();
    if (e2.cancelable) e2.preventDefault();
  }
  var GesturePad = class {
    touch;
    host;
    // Touch pointers in the current sequence.
    ours = /* @__PURE__ */ new Set();
    deferred = null;
    replaying = false;
    timer = 0;
    clicksAfter = -Infinity;
    penNear = -Infinity;
    pensDown = /* @__PURE__ */ new Set();
    // This frame's batch.
    frame = 0;
    zoomLog = 0;
    from = null;
    to = null;
    source = "wheel";
    panX = 0;
    panY = 0;
    wheelTimer = 0;
    safariScale = 1;
    constructor(host, tracker = new TouchTracker()) {
      this.host = host;
      this.touch = tracker;
      const opts = { capture: true };
      window.addEventListener("pointerdown", (e2) => this.down(e2), opts);
      window.addEventListener("pointermove", (e2) => this.move(e2), opts);
      window.addEventListener("pointerup", (e2) => this.up(e2, false), opts);
      window.addEventListener("pointercancel", (e2) => this.up(e2, true), opts);
      window.addEventListener("click", (e2) => this.claimClick(e2), opts);
      window.addEventListener("dblclick", (e2) => this.claimClick(e2), opts);
      const s2 = host.surface;
      s2.addEventListener("wheel", (e2) => this.wheel(e2), { passive: false });
      s2.addEventListener("gesturestart", (e2) => this.gesture(e2, "start"));
      s2.addEventListener("gesturechange", (e2) => this.gesture(e2, "change"));
      s2.addEventListener("gestureend", (e2) => this.gesture(e2, "end"));
    }
    // The touch sequence in progress (or the one that just ended) had a
    // second finger: it is no swipe and no tap.
    get multiTouch() {
      return this.touch.multiTouch;
    }
    // Two fingers are zooming, or one is left over from them.
    get claimed() {
      return this.touch.claimed;
    }
    // ── Touch ──
    palm() {
      return this.pensDown.size > 0 || performance.now() - this.penNear < PALM_MS2;
    }
    down(e2) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        this.pensDown.add(e2.pointerId);
        return;
      }
      if (e2.pointerType !== "touch" || this.replaying) return;
      const target = e2.target;
      if (!target || !this.host.surface.contains(target)) return;
      if (!this.touch.active) {
        if (this.palm() || this.host.accepts?.(e2) === false) return;
      }
      const v2 = this.touch.down(e2.pointerId, at(e2), performance.now());
      this.ours.add(e2.pointerId);
      if (v2.cancelSingle) this.rollback();
      if (v2.pinchStart) {
        this.source = "pinch";
        this.clicksAfter = Infinity;
      }
      if (!v2.pass) {
        stop(e2);
        return;
      }
      if (this.host.defer?.(e2)) {
        this.deferred = { target, down: e2, last: e2 };
        stop(e2);
        clearTimeout(this.timer);
        this.timer = window.setTimeout(
          () => this.tick(),
          this.touch.opts.windowMs + 10
        );
      }
    }
    rollback() {
      if (this.deferred) {
        this.deferred = null;
        clearTimeout(this.timer);
      } else {
        this.host.cancelSingle?.();
      }
    }
    move(e2) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        return;
      }
      if (this.replaying || !this.ours.has(e2.pointerId)) return;
      const v2 = this.touch.move(e2.pointerId, at(e2), performance.now());
      this.queuePinch(v2);
      if (!v2.pass) {
        stop(e2);
        return;
      }
      const d2 = this.deferred;
      if (d2 && d2.down.pointerId === e2.pointerId) {
        if (v2.commit) {
          this.replayDown();
        } else {
          d2.last = e2;
          stop(e2);
        }
      }
    }
    tick() {
      const d2 = this.deferred;
      if (!d2) return;
      const v2 = this.touch.tick(performance.now());
      if (!v2.commit) {
        return;
      }
      this.replayDown();
      this.replay(replica("pointermove", d2.down, d2.last), d2.target);
    }
    replayDown() {
      const d2 = this.deferred;
      if (!d2) return;
      this.deferred = null;
      clearTimeout(this.timer);
      this.replay(replica("pointerdown", d2.down), d2.target);
    }
    replay(e2, target) {
      const aim = target.isConnected ? target : document.elementFromPoint(e2.clientX, e2.clientY);
      if (!aim) return;
      this.replaying = true;
      try {
        aim.dispatchEvent(e2);
      } finally {
        this.replaying = false;
      }
    }
    up(e2, cancelled) {
      if (e2.pointerType === "pen") {
        this.penNear = performance.now();
        this.pensDown.delete(e2.pointerId);
        return;
      }
      if (this.replaying || !this.ours.has(e2.pointerId)) return;
      const v2 = this.touch.up(
        e2.pointerId,
        at(e2),
        performance.now(),
        cancelled
      );
      this.ours.delete(e2.pointerId);
      if (!this.touch.active) this.ours.clear();
      if (v2.pinchEnd) {
        this.flush();
        this.host.zoomEnd?.("pinch");
      }
      if (this.touch.multiTouch) {
        this.clicksAfter = this.touch.active ? Infinity : performance.now() + CLICK_AFTER_MS;
      }
      if (!v2.pass) {
        stop(e2);
        return;
      }
      const d2 = this.deferred;
      if (d2 && d2.down.pointerId === e2.pointerId) {
        if (cancelled) {
          this.deferred = null;
          clearTimeout(this.timer);
          stop(e2);
          return;
        }
        this.replayDown();
        if (v2.moved)
          this.replay(replica("pointermove", d2.down, e2), d2.target);
      }
      if (v2.doubleTap) {
        this.host.doubleTap?.(v2.doubleTap, e2.target);
      }
    }
    claimClick(e2) {
      if (this.touch.claimed || performance.now() < this.clicksAfter) {
        e2.stopImmediatePropagation();
        e2.preventDefault();
      }
    }
    // ── Wheel and Safari gestures ──
    wheel(e2) {
      if (this.host.acceptsWheel?.(e2) === false) return;
      if (e2.ctrlKey || e2.metaKey) {
        e2.preventDefault();
        this.zoomLog += wheelZoomLog(e2.deltaY, e2.deltaMode);
        this.source = "wheel";
        this.from = at(e2);
        this.to = at(e2);
        clearTimeout(this.wheelTimer);
        this.wheelTimer = window.setTimeout(() => {
          this.flush();
          this.host.zoomEnd?.("wheel");
        }, WHEEL_END_MS);
        this.schedule();
        return;
      }
      if (!this.host.pan || !this.host.canPan?.(e2)) return;
      e2.preventDefault();
      const page = this.host.surface.clientHeight || void 0;
      this.panX += wheelPixels(e2.deltaX, e2.deltaMode, page);
      this.panY += wheelPixels(e2.deltaY, e2.deltaMode, page);
      this.schedule();
    }
    gesture(raw, phase) {
      const e2 = raw;
      e2.preventDefault();
      if (this.touch.active) return;
      if (phase === "start") {
        this.safariScale = 1;
        return;
      }
      if (phase === "end") {
        this.flush();
        this.host.zoomEnd?.("gesture");
        return;
      }
      if (!(e2.scale > 0)) return;
      this.zoomLog += Math.log(e2.scale / this.safariScale);
      this.safariScale = e2.scale;
      this.source = "gesture";
      this.from = at(e2);
      this.to = at(e2);
      this.schedule();
    }
    // ── Frames ──
    queuePinch(v2) {
      if (!v2.pinch) return;
      this.zoomLog += Math.log(v2.pinch.scale);
      this.from ??= v2.pinch.from;
      this.to = v2.pinch.to;
      this.source = "pinch";
      this.schedule();
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => this.flush());
    }
    // Apply this frame's batch now.
    flush() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      const log = this.zoomLog;
      const from = this.from;
      const to = this.to;
      const dx = this.panX;
      const dy = this.panY;
      this.zoomLog = 0;
      this.from = null;
      this.to = null;
      this.panX = 0;
      this.panY = 0;
      if (from && to && (log !== 0 || from.x !== to.x || from.y !== to.y)) {
        this.host.zoom(Math.exp(log), from, to, this.source);
      }
      if (dx || dy) this.host.pan?.(dx, dy);
    }
  };

  // src/ts/shared/viewbox.ts
  var deckCanvas = { w: 1920, h: 1080 };
  function parseViewBox(attr, fallback = `0 0 ${deckCanvas.w} ${deckCanvas.h}`) {
    const parts = (attr ?? "").trim().split(/[\s,]+/).map(Number);
    const valid = parts.length === 4 && parts.every((n2) => Number.isFinite(n2)) && parts[2] > 0 && parts[3] > 0;
    const [x2, y2, w2, h2] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x: x2, y: y2, w: w2, h: h2 };
  }
  function formatViewBox(vb) {
    const round3 = (n2) => Math.round(n2 * 1e3) / 1e3;
    return `${round3(vb.x)} ${round3(vb.y)} ${round3(vb.w)} ${round3(vb.h)}`;
  }

  // src/ts/shared/zoom-camera.ts
  function clamp(n2, lo, hi) {
    return Math.min(Math.max(n2, lo), hi);
  }
  function scaleOf(vb, base) {
    return base.w / vb.w;
  }
  function isZoomedIn(vb, base, epsilon = 1e-3) {
    return scaleOf(vb, base) > 1 + epsilon;
  }
  function clampToBounds(vb, base) {
    const w2 = Math.min(vb.w, base.w);
    const h2 = Math.min(vb.h, base.h);
    const x2 = w2 >= base.w ? base.x + (base.w - w2) / 2 : clamp(vb.x, base.x, base.x + base.w - w2);
    const y2 = h2 >= base.h ? base.y + (base.h - h2) / 2 : clamp(vb.y, base.y, base.y + base.h - h2);
    return { x: x2, y: y2, w: w2, h: h2 };
  }
  function zoomAt(current2, base, factor, focus, limits) {
    const targetScale = clamp(
      scaleOf(current2, base) * factor,
      limits.minScale,
      limits.maxScale
    );
    const w2 = base.w / targetScale;
    const h2 = base.h / targetScale;
    const fx = (focus.ux - current2.x) / current2.w;
    const fy = (focus.uy - current2.y) / current2.h;
    return clampToBounds(
      { x: focus.ux - fx * w2, y: focus.uy - fy * h2, w: w2, h: h2 },
      base
    );
  }
  function panBy(current2, base, dxUser, dyUser) {
    return clampToBounds(
      { ...current2, x: current2.x + dxUser, y: current2.y + dyUser },
      base
    );
  }
  function lerpViewBox(a2, b2, t2) {
    return {
      x: a2.x + (b2.x - a2.x) * t2,
      y: a2.y + (b2.y - a2.y) * t2,
      w: a2.w + (b2.w - a2.w) * t2,
      h: a2.h + (b2.h - a2.h) * t2
    };
  }

  // src/ts/presenter/progress-driver.ts
  var ProgressDriver = class {
    value = 0;
    // The end the most recent animateTo is travelling toward. Callers read this to
    // decide which way a reversal should go.
    heading = 1;
    animateTo(target, durationSeconds, signal, onFrame) {
      this.heading = target;
      const ratePerMillisecond = 1 / (durationSeconds * 1e3);
      return new Promise((resolve) => {
        let lastTimestamp = null;
        const step = (timestamp) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          if (lastTimestamp === null) lastTimestamp = timestamp;
          const direction = target >= this.value ? 1 : -1;
          this.value += direction * ratePerMillisecond * (timestamp - lastTimestamp);
          lastTimestamp = timestamp;
          const reachedTarget = direction === 1 && this.value >= target || direction === -1 && this.value <= target;
          if (reachedTarget) {
            this.value = target;
            onFrame(this.value);
            resolve();
            return;
          }
          onFrame(this.value);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }
  };

  // src/ts/presenter/zoom.ts
  var stage = document.getElementById("stage");
  var stageWrap = document.getElementById("stage-wrap");
  var indicator = document.getElementById("zoom-indicator");
  var LIMITS = { minScale: 1, maxScale: 8 };
  var KEY_ZOOM_STEP = 1.4;
  var KEY_ANIM_MS = 140;
  var RESET_ANIM_MS = 240;
  var NAV_RESET_MS = 150;
  var EASE = cubicBezierEasing("cubic-bezier(0.22, 1, 0.36, 1)");
  var baseViewBox = null;
  var camera = null;
  var navReset = null;
  var dragStartCamera = null;
  var dragStartInverse = null;
  var dragStartClientX = 0;
  var dragStartClientY = 0;
  function currentSvg() {
    return stage?.querySelector("svg") ?? null;
  }
  function clientToUser(clientX, clientY, inverse) {
    const inv = inverse ?? currentSvg()?.getScreenCTM()?.inverse();
    if (!inv) return null;
    const p2 = new DOMPoint(clientX, clientY).matrixTransform(inv);
    return { ux: p2.x, uy: p2.y };
  }
  function ensureBase() {
    if (camera && baseViewBox) return true;
    const svg = currentSvg();
    if (!svg) return false;
    baseViewBox = parseViewBox(svg.getAttribute("viewBox"));
    camera = { ...baseViewBox };
    return true;
  }
  function renderIndicator() {
    if (!indicator) return;
    const factor = camera && baseViewBox ? scaleOf(camera, baseViewBox) : 1;
    indicator.textContent = `${factor.toFixed(1)}\xD7`;
    indicator.toggleAttribute("data-active", factor > 1.01);
  }
  function applyCamera() {
    const svg = currentSvg();
    if (!svg || !camera) return;
    svg.setAttribute("viewBox", formatViewBox(camera));
    renderIndicator();
  }
  var driver = new ProgressDriver();
  var animController = null;
  function cancelAnim() {
    animController?.abort();
    animController = null;
  }
  function animateCameraTo(target, ms, onDone) {
    cancelAnim();
    if (!camera) {
      camera = { ...target };
      applyCamera();
      onDone?.();
      return;
    }
    const start = { ...camera };
    const controller2 = new AbortController();
    animController = controller2;
    driver.value = 0;
    driver.animateTo(1, ms / 1e3, controller2.signal, (p2) => {
      camera = p2 >= 1 ? { ...target } : lerpViewBox(start, target, EASE(p2));
      applyCamera();
    }).then(() => {
      if (animController === controller2) animController = null;
      if (!controller2.signal.aborted) onDone?.();
    });
  }
  function endDrag() {
    dragStartCamera = null;
    dragStartInverse = null;
    document.body.classList.remove("zoom-grabbing");
  }
  function resetCamera() {
    cancelAnim();
    const svg = currentSvg();
    if (svg && baseViewBox) {
      svg.setAttribute("viewBox", formatViewBox(baseViewBox));
    }
    baseViewBox = null;
    camera = null;
    endDrag();
    renderIndicator();
  }
  function cameraIsZoomed() {
    return !!camera && !!baseViewBox && isZoomedIn(camera, baseViewBox);
  }
  function runNavReset() {
    const fn = navReset;
    navReset = null;
    fn?.();
  }
  function resetCameraThen(after) {
    if (!cameraIsZoomed() || !baseViewBox) {
      navReset = null;
      after();
      return;
    }
    navReset = after;
    animateCameraTo({ ...baseViewBox }, NAV_RESET_MS, runNavReset);
  }
  function cancelPendingNav() {
    navReset = null;
  }
  function flushPendingNav() {
    if (navReset) runNavReset();
  }
  function smoothResetCamera() {
    flushPendingNav();
    if (!ensureBase() || !camera || !baseViewBox) return;
    if (!isZoomedIn(camera, baseViewBox)) return;
    animateCameraTo({ ...baseViewBox }, RESET_ANIM_MS);
  }
  function keyZoom(direction) {
    flushPendingNav();
    if (!ensureBase() || !camera || !baseViewBox) return;
    const factor = direction === "in" ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP;
    const target = zoomAt(
      camera,
      baseViewBox,
      factor,
      { ux: camera.x + camera.w / 2, uy: camera.y + camera.h / 2 },
      LIMITS
    );
    animateCameraTo(target, KEY_ANIM_MS);
  }
  function zoomAbout(factor, from, to) {
    flushPendingNav();
    cancelAnim();
    if (!ensureBase() || !camera || !baseViewBox) return;
    const focus = clientToUser(from.x, from.y);
    if (!focus) return;
    camera = zoomAt(camera, baseViewBox, factor, focus, LIMITS);
    applyCamera();
    if (from.x === to.x && from.y === to.y) return;
    const a2 = clientToUser(from.x, from.y);
    const b2 = clientToUser(to.x, to.y);
    if (!a2 || !b2) return;
    camera = panBy(camera, baseViewBox, a2.ux - b2.ux, a2.uy - b2.uy);
    applyCamera();
  }
  function panPixels(dx, dy) {
    if (!camera || !baseViewBox) return;
    const inv = currentSvg()?.getScreenCTM()?.inverse();
    if (!inv) return;
    const units = Math.hypot(inv.a, inv.b);
    camera = panBy(camera, baseViewBox, dx * units, dy * units);
    applyCamera();
  }
  var touchCancels = [];
  function onTouchCancel(fn) {
    touchCancels.push(fn);
  }
  var gestures = null;
  function multiTouch() {
    return gestures?.multiTouch ?? false;
  }
  function overGrid(target) {
    return Boolean(target?.closest?.("#overview"));
  }
  function isCameraGesture(e2) {
    return e2.ctrlKey;
  }
  function setArmed(on) {
    document.body.classList.toggle("camera-armed", on);
  }
  document.addEventListener("keydown", (e2) => {
    if (e2.key === "Control") setArmed(true);
  });
  document.addEventListener("keyup", (e2) => {
    if (e2.key === "Control") setArmed(false);
  });
  window.addEventListener("blur", () => setArmed(false));
  if (stageWrap) {
    const wrap = stageWrap;
    gestures = new GesturePad({
      surface: wrap,
      accepts: (e2) => !overGrid(e2.target) && !e2.target.closest?.(".ink-palette"),
      acceptsWheel: (e2) => !overGrid(e2.target),
      cancelSingle: () => {
        for (const fn of touchCancels) fn();
      },
      zoom: zoomAbout,
      canPan: () => cameraIsZoomed(),
      pan: panPixels,
      doubleTap: smoothResetCamera
    });
    wrap.addEventListener("pointerdown", (e2) => {
      if (!isCameraGesture(e2) || overGrid(e2.target)) return;
      flushPendingNav();
      cancelAnim();
      if (!ensureBase() || !camera) return;
      const inverse = currentSvg()?.getScreenCTM()?.inverse();
      if (!inverse) return;
      wrap.setPointerCapture(e2.pointerId);
      dragStartCamera = { ...camera };
      dragStartInverse = inverse;
      dragStartClientX = e2.clientX;
      dragStartClientY = e2.clientY;
      document.body.classList.add("zoom-grabbing");
    });
    wrap.addEventListener("pointermove", (e2) => {
      if (!dragStartCamera || !dragStartInverse || !baseViewBox) return;
      const from = clientToUser(
        dragStartClientX,
        dragStartClientY,
        dragStartInverse
      );
      const to = clientToUser(e2.clientX, e2.clientY, dragStartInverse);
      if (!from || !to) return;
      camera = panBy(
        dragStartCamera,
        baseViewBox,
        from.ux - to.ux,
        from.uy - to.uy
      );
      applyCamera();
    });
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("dblclick", smoothResetCamera);
  }

  // src/ts/presenter/ink.ts
  var SETTINGS_KEY = "inkflow-ink-presenter";
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  var stage2 = document.getElementById("stage");
  var stageWrap2 = document.getElementById("stage-wrap");
  var overviewEl = document.getElementById("overview");
  var button2 = document.getElementById("btn-ink");
  var store = new InkStore();
  var settings = loadSettings(SETTINGS_KEY, false);
  var active = false;
  var palette = null;
  var pad = null;
  onTouchCancel(() => pad?.cancel());
  var send = () => {
  };
  var saving = false;
  var drawing = /* @__PURE__ */ new Map();
  var hiddenSaved = /* @__PURE__ */ new Set();
  var pendingSaves = /* @__PURE__ */ new Map();
  var saveCount = 0;
  function slideId() {
    return state.slides[state.slideIndex]?.id ?? null;
  }
  function slideSvg() {
    return stage2?.querySelector(":scope > svg") ?? null;
  }
  function current() {
    const id = slideId();
    return id === null ? null : store.get(id);
  }
  function group2(parent, name) {
    let g2 = parent.querySelector(`:scope > g[data-${name}]`);
    if (!g2) {
      g2 = document.createElementNS(SVG_NS2, "g");
      g2.setAttribute(`data-${name}`, "");
      parent.appendChild(g2);
    }
    return g2;
  }
  function mountInk() {
    const svg = slideSvg();
    const id = slideId();
    if (!svg || id === null) return;
    const ink = store.get(id);
    const inFile = new Set(
      [...svg.querySelectorAll(".inkflow-ink [id]")].map((el) => el.id)
    );
    ink.settle(inFile);
    for (const hidden of [...hiddenSaved]) {
      const el = inFile.has(hidden) ? svg.getElementById(hidden) : null;
      if (el instanceof SVGElement) el.style.display = "none";
      else hiddenSaved.delete(hidden);
    }
    let layer = svg.querySelector(":scope > g.inkflow-live-ink");
    if (!layer) {
      layer = document.createElementNS(SVG_NS2, "g");
      layer.setAttribute("class", "inkflow-live-ink");
      svg.appendChild(layer);
    }
    const held = group2(layer, "held");
    const rev = `${id}:${ink.rev}`;
    if (held.dataset.rev !== rev) {
      held.replaceChildren(...ink.strokes.map(strokeElement));
      held.dataset.rev = rev;
    }
    const relayed = group2(layer, "relayed");
    const shown = new Map(
      [...relayed.children].map((el) => [el.getAttribute("data-stroke"), el])
    );
    for (const [strokeId, d2] of drawing) {
      if (d2.slide !== id) continue;
      let path = shown.get(strokeId);
      if (!path) {
        path = paintStroke(
          document.createElementNS(SVG_NS2, "path"),
          d2.live
        );
        path.setAttribute("data-stroke", strokeId);
        relayed.appendChild(path);
      }
      shown.delete(strokeId);
      path.setAttribute(
        "d",
        pathData(outlineOf(d2.points, d2.live, d2.live.simulate, false), 2)
      );
    }
    for (const stale of shown.values()) stale?.remove();
  }
  var mountFrame = 0;
  function remount() {
    if (mountFrame) return;
    mountFrame = requestAnimationFrame(() => {
      mountFrame = 0;
      mountInk();
    });
  }
  function save(slide, op, payload, ids) {
    const ws = state.ws;
    if (!saving || !ws || ws.readyState !== WebSocket.OPEN) {
      showNotify("Ink not saved: no connection to the inkflow server", "red");
      return false;
    }
    const id = `ink-${++saveCount}`;
    pendingSaves.set(id, { slide, op, ids });
    ws.send(
      JSON.stringify({
        type: "edit-op",
        id,
        action: "ink",
        op,
        slideId: slide,
        ...payload
      })
    );
    return true;
  }
  function inkSaveResult(msg) {
    const pending = typeof msg.id === "string" ? pendingSaves.get(msg.id) : void 0;
    if (!pending) return false;
    pendingSaves.delete(msg.id);
    if (msg.ok) return true;
    showNotify(`Ink not saved: ${String(msg.error ?? "refused")}`, "red");
    const ids = new Set(pending.ids);
    if (pending.op === "add") {
      for (const s2 of store.get(pending.slide).strokes) {
        if (ids.has(s2.id)) s2.saved = false;
      }
    } else {
      for (const id of ids) hiddenSaved.delete(id);
      for (const id of ids) {
        const el = slideSvg()?.getElementById(id);
        if (el instanceof SVGElement) el.style.removeProperty("display");
      }
    }
    return true;
  }
  function plain(s2) {
    const { saved: _2, ...stroke } = s2;
    return stroke;
  }
  function addStrokes(ink, strokes, slide) {
    ink.add(strokes);
    const keep = strokes.filter((s2) => s2.saved);
    if (keep.length && !save(
      slide,
      "add",
      { strokes: keep.map(plain) },
      keep.map((s2) => s2.id)
    )) {
      for (const s2 of keep) s2.saved = false;
    }
    send({ type: "ink", op: "add", slide, strokes: strokes.map(plain) });
  }
  function eraseStrokes(ink, strokes, slide) {
    const ids = strokes.map((s2) => s2.id);
    ink.remove(ids);
    const saved = strokes.filter((s2) => s2.saved).map((s2) => s2.id);
    if (saved.length && save(slide, "erase", { ids: saved }, saved)) {
      for (const id of saved) hiddenSaved.add(id);
    }
    send({ type: "ink", op: "erase", slide, ids });
  }
  function undoInk() {
    const ink = current();
    const slide = slideId();
    const action = ink?.popUndo();
    if (!ink || !action || slide === null) return;
    if (action.kind === "add") eraseStrokes(ink, action.strokes, slide);
    else addStrokes(ink, action.strokes, slide);
    mountInk();
  }
  function savedStrokes(els) {
    return [...els].filter((el) => !hiddenSaved.has(el.id)).map(strokeOf).filter((s2) => s2 !== null).map((s2) => ({ ...s2, saved: true }));
  }
  function clearInk() {
    const ink = current();
    const svg = slideSvg();
    const slide = slideId();
    if (!ink || !svg || slide === null) return;
    const saved = settings.keep && saving ? savedStrokes(svg.querySelectorAll(".inkflow-ink path[id]")) : [];
    const all = [...ink.strokes, ...saved];
    if (!all.length) return;
    if (saved.length && !window.confirm(
      "Clear this slide's ink, including the strokes saved with the deck?"
    ))
      return;
    eraseStrokes(ink, all, slide);
    ink.record({ kind: "erase", strokes: all });
    mountInk();
  }
  function applyIncomingInk(msg) {
    if (msg.op === "request") {
      const slides = store.snapshot();
      if (Object.keys(slides).length)
        send({ type: "ink", op: "state", slides });
      return;
    }
    if (msg.op === "state") {
      if (typeof msg.slides !== "object" || msg.slides === null) return;
      for (const [slide, raw] of Object.entries(msg.slides)) {
        if (!Array.isArray(raw)) continue;
        store.get(slide).add(raw.map(strokeFrom).filter((s2) => s2 !== null));
      }
      remount();
      return;
    }
    if (typeof msg.slide !== "string") return;
    const ink = store.get(msg.slide);
    if (msg.op === "draw") {
      const style = styleFrom(msg.stroke);
      const points = unflatten(msg.points);
      if (!style || !points || typeof msg.from !== "number") return;
      const simulate = msg.stroke.simulate;
      const live = { ...style, simulate: simulate === true };
      const d2 = drawing.get(live.id) ?? {
        slide: msg.slide,
        live,
        points: []
      };
      d2.points = d2.points.slice(0, Math.max(0, msg.from)).concat(points);
      drawing.set(live.id, d2);
    } else if (msg.op === "abandon") {
      drawing.delete(String(msg.id));
    } else if (msg.op === "add") {
      if (!Array.isArray(msg.strokes)) return;
      const strokes = msg.strokes.map(strokeFrom).filter((s2) => s2 !== null);
      for (const s2 of strokes) drawing.delete(s2.id);
      ink.add(strokes);
    } else if (msg.op === "erase") {
      if (!Array.isArray(msg.ids)) return;
      ink.remove(msg.ids.filter((i2) => typeof i2 === "string"));
    }
    if (msg.slide === slideId()) remount();
  }
  function inkActive() {
    return active;
  }
  function toggleInk() {
    active = !active;
    if (!active) pad?.cancel();
    document.body.classList.toggle("ink-mode", active);
    button2?.classList.toggle("active", active);
    button2?.setAttribute("aria-pressed", String(active));
    if (palette) palette.el.hidden = !active;
  }
  function inkKey(e2) {
    if (!active) return false;
    if ((e2.ctrlKey || e2.metaKey) && e2.key.toLowerCase() === "z") {
      e2.preventDefault();
      undoInk();
      return true;
    }
    if (e2.key === "Escape") {
      toggleInk();
      return true;
    }
    return false;
  }
  function tokenColor(token) {
    const value = getComputedStyle(slideSvg() ?? document.documentElement).getPropertyValue(`--inkflow-${token}`).trim();
    return value ? normalizeHex(value) : null;
  }
  function initInk(wsPort, sender) {
    send = sender;
    if (!stage2 || !stageWrap2) return;
    onSlideMounted(mountInk);
    onSlideLeaving(() => pad?.cancel());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(
      location.hostname
    );
    saving = wsPort !== null && local;
    if (!saving) settings.keep = false;
    palette = new InkPalette({
      settings,
      keep: saving,
      undoTitle: "Undo the last stroke (Ctrl+Z)",
      clearTitle: "Clear this slide's ink",
      onChange(next) {
        settings = next;
        saveSettings(SETTINGS_KEY, settings);
      },
      undo: undoInk,
      clear: clearInk,
      close: toggleInk
    });
    palette.el.hidden = true;
    stageWrap2.appendChild(palette.el);
    pad = new InkPad({
      surface: stageWrap2,
      active: () => active,
      fingers: () => settings.fingers,
      tool: () => settings.tool,
      allows: (e2) => !isCameraGesture(e2) && !overviewEl?.classList.contains("visible") && !e2.target.closest(".ink-palette"),
      svg: slideSvg,
      style: (tool, svg) => styleFor(
        settings,
        tool,
        svg.viewBox.baseVal.width,
        tokenColor,
        svg.viewBox.baseVal.height
      ),
      *erasables(svg) {
        yield* svg.querySelectorAll(
          ".inkflow-live-ink [data-held] path[id]"
        );
        if (settings.keep && saving) {
          yield* svg.querySelectorAll(
            ".inkflow-ink path[id]"
          );
        }
      },
      onDraw(live, from, points) {
        const slide = slideId();
        if (slide === null) return;
        send({
          type: "ink",
          op: "draw",
          slide,
          stroke: live,
          from,
          points: flatten(points)
        });
      },
      onAbandon(live) {
        const slide = slideId();
        if (slide !== null)
          send({ type: "ink", op: "abandon", slide, id: live.id });
      },
      onStroke(stroke) {
        const ink = current();
        const slide = slideId();
        if (!ink || slide === null) return;
        const held = {
          ...stroke,
          saved: settings.keep && saving
        };
        addStrokes(ink, [held], slide);
        ink.record({ kind: "add", strokes: [held] });
        mountInk();
      },
      onErase(ids, hidden) {
        const ink = current();
        const slide = slideId();
        if (!ink || slide === null) return;
        const taken = new Set(ids);
        const held = ink.strokes.filter((s2) => taken.has(s2.id));
        const heldIds = new Set(held.map((s2) => s2.id));
        const saved = savedStrokes(
          hidden.filter((el) => !heldIds.has(el.id))
        );
        eraseStrokes(ink, [...held, ...saved], slide);
        ink.record({ kind: "erase", strokes: [...held, ...saved] });
        mountInk();
      }
    });
  }
  function requestInk() {
    send({ type: "ink", op: "request" });
  }

  // src/ts/shared/ring.ts
  function buildStepRing(current2, total) {
    const size = 20, cx = 10, cy = 10, ro = 9, ri = 5;
    if (total === 0) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle"><circle cx="${cx}" cy="${cy}" r="${(ro + ri) / 2}" fill="none" stroke="var(--overlay)" stroke-width="${ro - ri}" opacity="0.2"/></svg>`;
    }
    const gap = total > 1 ? 0.15 : 0;
    const sweep = 2 * Math.PI / total;
    let paths = "";
    for (let i2 = 0; i2 < total; i2++) {
      const a1 = -Math.PI / 2 + i2 * sweep + gap / 2;
      const a2 = -Math.PI / 2 + (i2 + 1) * sweep - gap / 2;
      const ox1 = (cx + ro * Math.cos(a1)).toFixed(2), oy1 = (cy + ro * Math.sin(a1)).toFixed(2);
      const ox2 = (cx + ro * Math.cos(a2)).toFixed(2), oy2 = (cy + ro * Math.sin(a2)).toFixed(2);
      const ix1 = (cx + ri * Math.cos(a1)).toFixed(2), iy1 = (cy + ri * Math.sin(a1)).toFixed(2);
      const ix2 = (cx + ri * Math.cos(a2)).toFixed(2), iy2 = (cy + ri * Math.sin(a2)).toFixed(2);
      const large = a2 - a1 > Math.PI ? 1 : 0;
      const active2 = i2 < current2;
      const d2 = `M${ox1},${oy1}A${ro},${ro},0,${large},1,${ox2},${oy2}L${ix2},${iy2}A${ri},${ri},0,${large},0,${ix1},${iy1}Z`;
      paths += `<path d="${d2}" fill="${active2 ? "var(--text)" : "var(--overlay)"}" opacity="${active2 ? 1 : 0.3}"/>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle" aria-label="Step ${current2} of ${total}">${paths}</svg>`;
  }

  // src/ts/shared/sections.ts
  function sectionRuns(slides) {
    const runs = [];
    slides.forEach((s2, i2) => {
      const section = s2.section ?? null;
      const last = runs[runs.length - 1];
      if (last && (last.section?.index ?? -1) === (section?.index ?? -1)) {
        last.end = i2 + 1;
      } else {
        runs.push({ section, start: i2, end: i2 + 1 });
      }
    });
    return runs;
  }
  function sectionPosition(slides, i2) {
    const run = sectionRuns(slides).find((r2) => i2 >= r2.start && i2 < r2.end);
    if (!run?.section) return null;
    return {
      name: run.section.name,
      at: i2 - run.start + 1,
      of: run.end - run.start
    };
  }
  function gridRows(runs, cols) {
    return runs.reduce((n2, r2) => n2 + Math.ceil((r2.end - r2.start) / cols), 0);
  }
  function verticalNeighbor(boxes, i2, dir) {
    const me = boxes[i2];
    if (!me) return i2;
    const tops = [...new Set(boxes.map((b2) => b2.top))].sort((a2, b2) => a2 - b2);
    const row = tops.indexOf(me.top) + dir;
    if (row < 0 || row >= tops.length) return i2;
    const center = me.left + me.width / 2;
    let best = i2;
    let bestD = Number.POSITIVE_INFINITY;
    boxes.forEach((b2, j2) => {
      if (b2.top !== tops[row]) return;
      const d2 = Math.abs(b2.left + b2.width / 2 - center);
      if (d2 < bestD) {
        best = j2;
        bestD = d2;
      }
    });
    return best;
  }

  // src/ts/shared/keyframes.ts
  var templates = /* @__PURE__ */ new Map();
  function parseOffsets(keyText) {
    return keyText.split(",").map((part) => {
      const t2 = part.trim();
      if (t2 === "from") return 0;
      if (t2 === "to") return 1;
      return Number.parseFloat(t2) / 100;
    }).filter((n2) => Number.isFinite(n2));
  }
  function kebabToCamel(prop) {
    return prop.replace(/-([a-z])/g, (_2, c2) => c2.toUpperCase());
  }
  function ruleToKeyframes(rule) {
    const frames = [];
    for (const raw of Array.from(rule.cssRules)) {
      const kf = raw;
      const style = kf.style;
      const props = {};
      for (let i2 = 0; i2 < style.length; i2++) {
        const name = style[i2];
        props[kebabToCamel(name)] = style.getPropertyValue(name).trim();
      }
      for (const offset of parseOffsets(kf.keyText)) {
        frames.push({ offset, ...props });
      }
    }
    frames.sort((a2, b2) => a2.offset - b2.offset);
    return frames;
  }
  function findKeyframes(name, rules) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (rule.name === name) return rule;
        continue;
      }
      const grouping = rule;
      if (grouping.cssRules) {
        const found = findKeyframes(name, grouping.cssRules);
        if (found) return found;
      }
    }
    return null;
  }
  function templateFor(name) {
    const cached = templates.get(name);
    if (cached !== void 0) return cached;
    let result = null;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const rule = findKeyframes(name, rules);
      if (rule) {
        result = ruleToKeyframes(rule);
        break;
      }
    }
    templates.set(name, result);
    return result;
  }
  var VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;
  function substituteVars(value, vars) {
    return value.replace(
      VAR_ANIM,
      (match, key) => key in vars ? vars[key] : match
    );
  }
  function buildKeyframes(name, vars) {
    const template = templateFor(name);
    if (!template) return [];
    if (Object.keys(vars).length === 0) return template;
    return template.map((frame) => {
      const out = {};
      for (const [k2, v2] of Object.entries(frame)) {
        out[k2] = typeof v2 === "string" ? substituteVars(v2, vars) : v2;
      }
      return out;
    });
  }

  // src/ts/shared/step.ts
  var elementCues = /* @__PURE__ */ new WeakMap();
  var rootStep = /* @__PURE__ */ new WeakMap();
  function parseCues(el) {
    const raw = el.getAttribute("data-cues");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  function cueStates(el) {
    let states = elementCues.get(el);
    if (!states) {
      states = parseCues(el).map((cue) => ({ cue, anim: null }));
      elementCues.set(el, states);
    }
    return states;
  }
  function effectEndMs(cue) {
    const { duration, delay, iterations } = cue.opts;
    return Math.max(0, delay) * 1e3 + Math.max(0, duration) * (iterations ?? 1) * 1e3;
  }
  function ensureAnim(el, st) {
    if (!st.anim) {
      const { name, vars, opts } = st.cue;
      const anim = el.animate(buildKeyframes(`anim-${name}`, vars), {
        duration: Math.max(0, opts.duration * 1e3),
        delay: Math.max(0, opts.delay * 1e3),
        easing: opts.easing || "linear",
        iterations: opts.iterations ?? 1,
        fill: "both"
      });
      anim.pause();
      st.anim = anim;
    }
    return st.anim;
  }
  function holdAtEnd(anim) {
    anim.playbackRate = 1;
    try {
      anim.play();
      anim.finish();
    } catch {
    }
  }
  function restingActions(cues, step) {
    let gov = -1;
    cues.forEach((c2, i2) => {
      if (c2.kind !== "emphasis" && c2.step <= step) gov = i2;
    });
    return cues.map((_2, i2) => i2 === gov ? "hold" : "cancel");
  }
  function buildStepRun(root, fromStep, toStep) {
    const forward = toStep >= fromStep;
    const runStep = Math.max(fromStep, toStep);
    const items = [];
    root.querySelectorAll("[data-cues]").forEach((el) => {
      for (const st of cueStates(el)) {
        if (st.cue.step !== runStep) continue;
        const anim = ensureAnim(el, st);
        anim.pause();
        items.push({
          anim,
          offsetMs: Math.max(0, st.cue.offset) * 1e3,
          spanMs: effectEndMs(st.cue)
        });
      }
    });
    const totalMs = items.reduce(
      (m2, it) => Math.max(m2, it.offsetMs + it.spanMs),
      0
    );
    return { items, totalMs, forward, toStep };
  }
  function seekStepRun(run, value) {
    const runTimeMs = value * run.totalMs;
    for (const it of run.items) {
      it.anim.currentTime = Math.min(
        Math.max(runTimeMs - it.offsetMs, 0),
        it.spanMs
      );
    }
  }
  function applyCodeHighlights(root, step) {
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
      const active2 = spec[specIdx];
      const hasHL = active2 !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n2 = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active2.includes(n2));
        line.classList.toggle("hl-dim", hasHL && !active2.includes(n2));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function appliedStep(root) {
    return rootStep.get(root) ?? 0;
  }
  function maxStep(root) {
    let m2 = 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
      for (const c2 of parseCues(el)) if (c2.step > m2) m2 = c2.step;
    });
    root.querySelectorAll("[data-play-on-step]").forEach((el) => {
      const s2 = +(el.getAttribute("data-play-on-step") ?? "0");
      if (s2 > m2) m2 = s2;
    });
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const last = baseStep + spec.length - 1;
      if (last > m2) m2 = last;
    });
    return m2;
  }
  function commitStepStyles(root) {
    if (typeof root.getAnimations !== "function") return;
    for (const anim of root.getAnimations({ subtree: true })) {
      try {
        anim.commitStyles();
      } catch {
      }
    }
  }
  function applyStepInstant(root, step) {
    root.querySelectorAll("[data-cues]").forEach((el) => {
      const states = cueStates(el);
      const actions = restingActions(
        states.map((s2) => s2.cue),
        step
      );
      states.forEach((st, i2) => {
        if (actions[i2] === "hold") holdAtEnd(ensureAnim(el, st));
        else st.anim?.cancel();
      });
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
  }

  // src/ts/presenter/deck-url.ts
  var SLIDE = "slide";
  var STEPS = "steps";
  function hashParams(url) {
    return new URLSearchParams(url.hash.slice(1));
  }
  function positionHref(url, slideIndex, step) {
    const next = new URL(url.href);
    const params = hashParams(next);
    params.set(SLIDE, String(slideIndex + 1));
    if (step > 0) params.set(STEPS, String(step));
    else params.delete(STEPS);
    next.hash = params.toString();
    return next.href;
  }
  function readPosition(url, slideCount) {
    const params = hashParams(url);
    const slide = parseInt(params.get(SLIDE) ?? "", 10);
    const inDeck = !Number.isNaN(slide) && slide >= 1 && slide <= slideCount;
    const step = parseInt(params.get(STEPS) ?? "0", 10);
    return {
      slideIndex: inDeck ? slide - 1 : null,
      step: !Number.isNaN(step) && step >= 0 ? step : 0
    };
  }

  // src/ts/presenter/video.ts
  var armed = /* @__PURE__ */ new WeakSet();
  var activeState = /* @__PURE__ */ new WeakMap();
  function readSpec(v2) {
    const step = v2.getAttribute("data-play-on-step");
    const start = v2.getAttribute("data-start");
    const end = v2.getAttribute("data-end");
    return {
      autoplay: v2.hasAttribute("data-autoplay"),
      loop: v2.hasAttribute("data-loop"),
      playOnStep: step === null ? null : Number(step),
      start: start === null ? 0 : Number(start),
      end: end === null ? null : Number(end)
    };
  }
  function arm(v2, spec) {
    if (armed.has(v2)) return;
    armed.add(v2);
    if (spec.start > 0) {
      const seek = () => {
        if (v2.currentTime < spec.start) v2.currentTime = spec.start;
      };
      if (v2.readyState >= 1) seek();
      else v2.addEventListener("loadedmetadata", seek, { once: true });
    }
    if (spec.end !== null || spec.loop) {
      v2.addEventListener("timeupdate", () => {
        if (spec.end !== null && v2.currentTime >= spec.end) {
          if (spec.loop) v2.currentTime = spec.start;
          else v2.pause();
        }
      });
    }
    if (spec.loop) {
      v2.addEventListener("ended", () => playFrom(v2, spec.start));
    }
  }
  function playFrom(v2, start) {
    const go = () => {
      v2.currentTime = start;
      void v2.play().catch(() => {
      });
    };
    if (start > 0 && v2.readyState < 1) {
      v2.addEventListener("loadedmetadata", go, { once: true });
    } else {
      go();
    }
  }
  function syncVideos(root, step) {
    root.querySelectorAll("video").forEach((v2) => {
      const spec = readSpec(v2);
      arm(v2, spec);
      const shouldPlay = spec.autoplay || spec.playOnStep !== null && step >= spec.playOnStep;
      const wasActive = activeState.get(v2) ?? false;
      if (shouldPlay && !wasActive) {
        playFrom(v2, spec.start);
      } else if (!shouldPlay && wasActive) {
        v2.pause();
        v2.currentTime = spec.start;
      }
      activeState.set(v2, shouldPlay);
    });
  }

  // src/ts/presenter/status.ts
  var stage3 = document.getElementById("stage");
  var slideInfo = document.getElementById("slide-info");
  var stepInfo = document.getElementById("step-info");
  var mhudSlideInfo = document.getElementById("mhud-slide-info");
  var mhudStepRing = document.getElementById("mhud-step-ring");
  var maxStepSlides = null;
  var maxStepIndex = -1;
  var maxStepValue = 0;
  function maxStep2() {
    if (maxStepSlides === state.slides && maxStepIndex === state.slideIndex)
      return maxStepValue;
    const scratch = document.createElement("div");
    scratch.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    maxStepValue = maxStep(scratch);
    maxStepSlides = state.slides;
    maxStepIndex = state.slideIndex;
    return maxStepValue;
  }
  var runController = null;
  var runDriver = null;
  var runRun = null;
  var runTo = 0;
  var runForward = true;
  function inflightStepDirection() {
    if (!runController) return null;
    return runForward ? "forward" : "backward";
  }
  function driveRun() {
    const ctrl = new AbortController();
    runController = ctrl;
    const driver2 = runDriver;
    const run = runRun;
    const to = runTo;
    void driver2.animateTo(
      runForward ? 1 : 0,
      run.totalMs / 1e3,
      ctrl.signal,
      (v2) => seekStepRun(run, v2)
    ).then(() => {
      if (ctrl.signal.aborted) return;
      if (runController === ctrl) {
        runController = null;
        runDriver = null;
        runRun = null;
      }
      applyStepInstant(stage3, to);
      updateStatus();
    });
  }
  function landRun() {
    if (!runController) return;
    runController.abort();
    runController = null;
    runDriver = null;
    runRun = null;
    applyStepInstant(stage3, runTo);
    syncVideos(stage3, runTo);
  }
  function snapStepRun() {
    if (!runController) return;
    landRun();
    updateStatus();
  }
  function reverseStepRun() {
    if (!runController || !runDriver || !runRun) return false;
    const nextTo = runForward ? runTo - 1 : runTo + 1;
    if (nextTo < 0) return false;
    runController.abort();
    runForward = !runForward;
    runTo = nextTo;
    state.step = runTo;
    applyCodeHighlights(stage3, runTo);
    syncVideos(stage3, runTo);
    updateStatus();
    driveRun();
    return true;
  }
  function settleStepRun() {
    landRun();
  }
  function applyCurrentStep() {
    landRun();
    const from = appliedStep(stage3);
    const to = state.step;
    applyCodeHighlights(stage3, to);
    syncVideos(stage3, to);
    const run = buildStepRun(stage3, from, to);
    if (run.totalMs <= 0 || from === to) {
      applyStepInstant(stage3, to);
      updateStatus();
      return;
    }
    runRun = run;
    runDriver = new ProgressDriver();
    runDriver.value = run.forward ? 0 : 1;
    runTo = to;
    runForward = run.forward;
    updateStatus();
    driveRun();
  }
  function applyCurrentStepInstant() {
    landRun();
    applyStepInstant(stage3, state.step);
    syncVideos(stage3, state.step);
    updateStatus();
  }
  function syncURL() {
    const href = positionHref(
      new URL(window.location.href),
      state.slideIndex,
      state.step
    );
    try {
      history.replaceState(null, "", href);
    } catch (_2) {
    }
  }
  function readURL() {
    const { slideIndex, step } = readPosition(
      new URL(window.location.href),
      state.slides.length
    );
    if (slideIndex !== null) state.slideIndex = slideIndex;
    state.step = step;
    return slideIndex !== null;
  }
  function updateStatus() {
    const infoHtml = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    const at2 = sectionPosition(state.slides, state.slideIndex);
    slideInfo.title = at2 ? `${at2.name}: ${at2.at} of ${at2.of}` : "";
    const ringHtml = buildStepRing(state.step, maxStep2());
    slideInfo.innerHTML = infoHtml;
    stepInfo.innerHTML = ringHtml;
    mhudSlideInfo.innerHTML = infoHtml;
    mhudStepRing.innerHTML = ringHtml;
    syncURL();
  }

  // src/ts/presenter/pv.ts
  var pvPanel = document.getElementById("pv");
  var pvResizeHandle = document.getElementById("pv-resize-handle");
  var pvStrip = document.getElementById("pv-strip");
  var pvClock = document.getElementById("pv-clock");
  var pvElapsed = document.getElementById("pv-elapsed");
  var pvTimerToggle = document.getElementById("pv-timer-toggle");
  var pvTimerReset = document.getElementById("pv-timer-reset");
  var pvSlideInfo = document.getElementById("pv-slide-info");
  var pvSection = document.getElementById("pv-section");
  var pvStepRing = document.getElementById("pv-step-ring");
  var pvNextInner = document.getElementById("pv-next-inner");
  var pvNotes = document.getElementById("pv-notes");
  var _elapsedAccumMs = 0;
  var _runningSince = Date.now();
  function _elapsedMs() {
    const running = _runningSince === null ? 0 : Date.now() - _runningSince;
    return _elapsedAccumMs + running;
  }
  function _setTimerPaused(paused) {
    if (paused === (_runningSince === null)) return;
    if (paused) {
      _elapsedAccumMs = _elapsedMs();
      _runningSince = null;
    } else {
      _runningSince = Date.now();
    }
    pvStrip.classList.toggle("timer-paused", paused);
    const label = paused ? "Resume timer" : "Pause timer";
    pvTimerToggle.title = label;
    pvTimerToggle.setAttribute("aria-label", label);
    updatePvClock();
  }
  function _resetTimer() {
    _elapsedAccumMs = 0;
    if (_runningSince !== null) _runningSince = Date.now();
    updatePvClock();
  }
  pvTimerToggle.addEventListener("click", () => {
    _setTimerPaused(_runningSince !== null);
  });
  pvTimerReset.addEventListener("click", _resetTimer);
  function _pad2(n2) {
    return String(n2).padStart(2, "0");
  }
  function updatePvClock() {
    const now = /* @__PURE__ */ new Date();
    pvClock.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor(_elapsedMs() / 1e3);
    const h2 = Math.floor(secs / 3600);
    const m2 = Math.floor(secs % 3600 / 60);
    const s2 = secs % 60;
    pvElapsed.textContent = h2 > 0 ? `${_pad2(h2)}:${_pad2(m2)}:${_pad2(s2)}` : `${_pad2(m2)}:${_pad2(s2)}`;
  }
  function updatePvInfo() {
    const total = state.slides.length;
    pvSlideInfo.innerHTML = `<span class="slide-current">${total ? state.slideIndex + 1 : "\u2013"}</span> / ${total || "\u2013"}`;
    pvStepRing.innerHTML = buildStepRing(state.step, maxStep2());
    if (pvSection) {
      const at2 = sectionPosition(state.slides, state.slideIndex);
      pvSection.hidden = !at2;
      pvSection.textContent = at2 ? `\xA7 ${at2.name} \xB7 ${at2.at}/${at2.of}` : "";
      pvSection.title = at2 ? `Section \u201C${at2.name}\u201D: slide ${at2.at} of ${at2.of}` : "";
    }
  }
  function _scalePvNext() {
    const svg = pvNextInner.querySelector("svg");
    if (!svg) return;
    const vb = parseViewBox(svg.getAttribute("viewBox"));
    svg.setAttribute("width", String(vb.w));
    svg.setAttribute("height", String(vb.h));
    svg.style.width = `${vb.w}px`;
    svg.style.height = `${vb.h}px`;
    const scale = Math.min(
      pvNextInner.clientWidth / vb.w,
      pvNextInner.clientHeight / vb.h
    );
    const tx = (pvNextInner.clientWidth - vb.w * scale) / 2;
    const ty = (pvNextInner.clientHeight - vb.h * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function renderPvNext() {
    const curMax = maxStep2();
    let previewSvg = null;
    let revealStep = 0;
    if (state.step < curMax) {
      previewSvg = state.slides[state.slideIndex]?.svg ?? null;
      revealStep = state.step + 1;
    } else if (state.slideIndex + 1 < state.slides.length) {
      previewSvg = state.slides[state.slideIndex + 1].svg;
    }
    if (previewSvg === null) {
      pvNextInner.innerHTML = '<div id="pv-next-empty">END</div>';
      return;
    }
    pvNextInner.innerHTML = previewSvg;
    const svg = pvNextInner.querySelector("svg");
    if (svg) applyStepInstant(svg, revealStep);
    requestAnimationFrame(_scalePvNext);
  }
  function renderPvNotes() {
    pvNotes.innerHTML = state.slides[state.slideIndex]?.notes ?? "";
    pvNotes.scrollTop = 0;
  }
  function renderPv() {
    updatePvInfo();
    renderPvNext();
    renderPvNotes();
    renderEditButton();
  }
  function togglePv() {
    document.body.classList.toggle("pv-open");
    pvPanel.addEventListener("transitionend", _scalePvNext, { once: true });
  }
  window.addEventListener("resize", _scalePvNext);
  function _onPvResizeMove(e2) {
    pvPanel.style.setProperty(
      "--pv-width",
      `${window.innerWidth - e2.clientX}px`
    );
    _scalePvNext();
  }
  function _onPvResizeUp(e2) {
    pvResizeHandle.releasePointerCapture(e2.pointerId);
    pvResizeHandle.removeEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.removeEventListener("pointerup", _onPvResizeUp);
    pvPanel.style.transition = "";
  }
  pvResizeHandle.addEventListener("pointerdown", (e2) => {
    e2.preventDefault();
    pvPanel.style.transition = "none";
    pvResizeHandle.setPointerCapture(e2.pointerId);
    pvResizeHandle.addEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.addEventListener("pointerup", _onPvResizeUp);
  });

  // src/ts/shared/deck-styles.ts
  function applyDeckStyles(msg) {
    if (msg.styles !== void 0) {
      const el = document.getElementById("deck-styles");
      if (el) el.textContent = msg.styles;
    }
    if (msg.mode !== void 0)
      document.documentElement.dataset.theme = msg.mode;
  }

  // src/ts/shared/morph-math.ts
  var INTERPOLATED_ATTRIBUTES = [
    "fill",
    "stroke",
    "opacity",
    "fill-opacity",
    "stroke-opacity"
  ];
  function easeInOut(t2) {
    return t2 < 0.5 ? 2 * t2 * t2 : 1 - (-2 * t2 + 2) ** 2 / 2;
  }
  function parseColorToRGB(colorString) {
    if (colorString.startsWith("#")) {
      const hexDigits = colorString.slice(1);
      if (hexDigits.length === 3)
        return hexDigits.split("").map((c2) => parseInt(c2 + c2, 16));
      if (hexDigits.length === 6)
        return [0, 2, 4].map(
          (i2) => parseInt(hexDigits.slice(i2, i2 + 2), 16)
        );
    }
    const rgbMatch = colorString.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    return null;
  }
  function interpolateColorAttribute(fromColor, toColor, progress) {
    const fromRGB = parseColorToRGB(fromColor);
    const toRGB = parseColorToRGB(toColor);
    if (!fromRGB || !toRGB) return progress < 0.5 ? fromColor : toColor;
    return "#" + fromRGB.map(
      (channel, index) => Math.round(channel + (toRGB[index] - channel) * progress).toString(16).padStart(2, "0")
    ).join("");
  }
  function interpolateNumericAttribute(fromValue, toValue, progress) {
    return String(
      parseFloat(fromValue) + (parseFloat(toValue) - parseFloat(fromValue)) * progress
    );
  }
  var COLOR_ATTRIBUTES = /* @__PURE__ */ new Set(["fill", "stroke"]);
  function interpolateAttribute(attribute, fromValue, toValue, progress) {
    if (COLOR_ATTRIBUTES.has(attribute))
      return interpolateColorAttribute(fromValue, toValue, progress);
    return interpolateNumericAttribute(fromValue, toValue, progress);
  }
  function readInterpolatedAttributes(element) {
    const result = {};
    const inlineStyle = element instanceof SVGElement || element instanceof HTMLElement ? element.style : null;
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
      const styleValue = inlineStyle?.getPropertyValue(attribute).trim();
      if (styleValue && styleValue !== "none") {
        result[attribute] = styleValue;
        continue;
      }
      const directValue = element.getAttribute(attribute);
      if (directValue !== null && directValue !== "none") {
        result[attribute] = directValue;
        continue;
      }
      const computedValue = getComputedStyle(element).getPropertyValue(attribute).trim();
      if (computedValue && computedValue !== "none")
        result[attribute] = computedValue;
    }
    return result;
  }
  function decomposeAffine(m2) {
    let a2 = m2.a;
    let b2 = m2.b;
    let c2 = m2.c;
    let d2 = m2.d;
    const determinant = a2 * d2 - b2 * c2;
    let scaleX = Math.hypot(a2, b2);
    if (scaleX !== 0) {
      a2 /= scaleX;
      b2 /= scaleX;
    }
    let skew = a2 * c2 + b2 * d2;
    c2 -= a2 * skew;
    d2 -= b2 * skew;
    const scaleY = Math.hypot(c2, d2);
    if (scaleY !== 0) {
      skew /= scaleY;
    }
    if (determinant < 0) {
      scaleX = -scaleX;
      a2 = -a2;
      b2 = -b2;
    }
    return {
      tx: m2.e,
      ty: m2.f,
      scaleX,
      scaleY,
      skew,
      rotation: Math.atan2(b2, a2)
    };
  }
  function recomposeAffine(c2) {
    const skewMatrix = new DOMMatrix([1, 0, c2.skew, 1, 0, 0]);
    return new DOMMatrix().translate(c2.tx, c2.ty).rotate(c2.rotation * 180 / Math.PI).multiply(skewMatrix).scale(c2.scaleX, c2.scaleY);
  }
  function lerp(from, to, t2) {
    return from + (to - from) * t2;
  }
  function lerpAngle(from, to, t2) {
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return from + delta * t2;
  }
  function interpolateAffine(from, to, t2) {
    return recomposeAffine({
      tx: lerp(from.tx, to.tx, t2),
      ty: lerp(from.ty, to.ty, t2),
      scaleX: lerp(from.scaleX, to.scaleX, t2),
      scaleY: lerp(from.scaleY, to.scaleY, t2),
      skew: lerp(from.skew, to.skew, t2),
      rotation: lerpAngle(from.rotation, to.rotation, t2)
    });
  }
  function matrixScaleX(m2) {
    return Math.hypot(m2.a, m2.b);
  }
  function matrixScaleY(m2) {
    const scaleX = Math.hypot(m2.a, m2.b);
    if (scaleX === 0) return Math.hypot(m2.c, m2.d);
    return Math.abs(m2.a * m2.d - m2.b * m2.c) / scaleX;
  }

  // src/ts/shared/path-data.ts
  var ARGUMENT_COUNT = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7
  };
  var TOKEN_PATTERN = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
  function tokenize(d2) {
    const tokens = [];
    let consumed = 0;
    TOKEN_PATTERN.lastIndex = 0;
    for (let match = TOKEN_PATTERN.exec(d2); match; match = TOKEN_PATTERN.exec(d2)) {
      if (/[^\s,]/.test(d2.slice(consumed, match.index))) return null;
      consumed = match.index + match[0].length;
      tokens.push(
        match[1] ? { command: match[1] } : { value: Number(match[2]) }
      );
    }
    return /[^\s,]/.test(d2.slice(consumed)) ? null : tokens;
  }
  function reflect(about, control) {
    return { x: 2 * about.x - control.x, y: 2 * about.y - control.y };
  }
  function cubicFromQuadratic(from, control, to) {
    return [
      {
        x: from.x + 2 / 3 * (control.x - from.x),
        y: from.y + 2 / 3 * (control.y - from.y)
      },
      {
        x: to.x + 2 / 3 * (control.x - to.x),
        y: to.y + 2 / 3 * (control.y - to.y)
      },
      to
    ];
  }
  function parsePathData(d2) {
    const tokens = tokenize(d2);
    if (!tokens || tokens.length === 0) return null;
    const segments = [];
    let current2 = { x: 0, y: 0 };
    let subpathStart = { x: 0, y: 0 };
    let previousCubicControl = null;
    let previousQuadraticControl = null;
    let previousCommand = "";
    let command = "";
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if ("command" in token) {
        command = token.command;
        index++;
      } else if (command === "") {
        return null;
      }
      const upper = command.toUpperCase();
      const relative = command !== upper;
      if (upper === "Z") {
        segments.push({ type: "Z", points: [] });
        current2 = subpathStart;
        previousCubicControl = null;
        previousQuadraticControl = null;
        previousCommand = upper;
        if (index < tokens.length && !("command" in tokens[index]))
          return null;
        continue;
      }
      const arity = ARGUMENT_COUNT[upper];
      if (arity === void 0) return null;
      const args = [];
      for (let offset = 0; offset < arity; offset++) {
        const argument = tokens[index + offset];
        if (!argument || "command" in argument) return null;
        args.push(argument.value);
      }
      index += arity;
      const origin = current2;
      const at2 = (i2) => relative ? { x: origin.x + args[i2], y: origin.y + args[i2 + 1] } : { x: args[i2], y: args[i2 + 1] };
      switch (upper) {
        case "M": {
          const end = at2(0);
          segments.push({ type: "M", points: [end] });
          current2 = end;
          subpathStart = end;
          command = relative ? "l" : "L";
          break;
        }
        case "L": {
          const end = at2(0);
          segments.push({ type: "L", points: [end] });
          current2 = end;
          break;
        }
        case "H": {
          const end = {
            x: relative ? origin.x + args[0] : args[0],
            y: origin.y
          };
          segments.push({ type: "L", points: [end] });
          current2 = end;
          break;
        }
        case "V": {
          const end = {
            x: origin.x,
            y: relative ? origin.y + args[0] : args[0]
          };
          segments.push({ type: "L", points: [end] });
          current2 = end;
          break;
        }
        case "C": {
          const points = [at2(0), at2(2), at2(4)];
          segments.push({ type: "C", points });
          current2 = points[2];
          previousCubicControl = points[1];
          break;
        }
        case "S": {
          const control1 = previousCubicControl && (previousCommand === "C" || previousCommand === "S") ? reflect(origin, previousCubicControl) : origin;
          const points = [control1, at2(0), at2(2)];
          segments.push({ type: "C", points });
          current2 = points[2];
          previousCubicControl = points[1];
          break;
        }
        case "Q": {
          const control = at2(0);
          const end = at2(2);
          segments.push({
            type: "C",
            points: cubicFromQuadratic(origin, control, end)
          });
          current2 = end;
          previousQuadraticControl = control;
          break;
        }
        case "T": {
          const control = previousQuadraticControl && (previousCommand === "Q" || previousCommand === "T") ? reflect(origin, previousQuadraticControl) : origin;
          const end = at2(0);
          segments.push({
            type: "C",
            points: cubicFromQuadratic(origin, control, end)
          });
          current2 = end;
          previousQuadraticControl = control;
          break;
        }
        default:
          return null;
      }
      if (upper !== "C" && upper !== "S") previousCubicControl = null;
      if (upper !== "Q" && upper !== "T") previousQuadraticControl = null;
      previousCommand = upper;
    }
    return segments.length > 0 ? segments : null;
  }
  function transformSegments(segments, matrix) {
    return segments.map((segment) => ({
      type: segment.type,
      points: segment.points.map((point) => ({
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f
      }))
    }));
  }
  function areCompatible(from, to) {
    return from.length === to.length && from.every((segment, index) => segment.type === to[index].type);
  }
  function interpolateSegments(from, to, t2) {
    return from.map((segment, index) => ({
      type: segment.type,
      points: segment.points.map((point, pointIndex) => {
        const target = to[index].points[pointIndex];
        return {
          x: point.x + (target.x - point.x) * t2,
          y: point.y + (target.y - point.y) * t2
        };
      })
    }));
  }
  function round2(value) {
    return Math.round(value * 1e3) / 1e3;
  }
  function serializePathData(segments) {
    return segments.map(
      (segment) => segment.type === "Z" ? "Z" : `${segment.type} ${segment.points.map((point) => `${round2(point.x)} ${round2(point.y)}`).join(" ")}`
    ).join(" ");
  }

  // src/ts/shared/svg-refs.ts
  var REFERENCE_ATTRIBUTES = [
    "fill",
    "stroke",
    "clip-path",
    "mask",
    "filter",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
    "style"
  ];
  var HREF_ATTRIBUTES = ["href", "xlink:href"];
  var URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
  function eachReference(root, visit) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of REFERENCE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (!value?.includes("#")) continue;
        for (const match of [...value.matchAll(URL_REFERENCE)])
          visit(element, attribute, match[2]);
      }
      for (const attribute of HREF_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith("#"))
          visit(element, attribute, value.slice(1));
      }
    }
  }
  function collectReferencedIds(root) {
    const ids = /* @__PURE__ */ new Set();
    eachReference(root, (_element, _attribute, id) => ids.add(id));
    return ids;
  }
  function referencedDefinitions(root) {
    const defined = /* @__PURE__ */ new Set();
    for (const element of [root, ...root.querySelectorAll("[id]")])
      if (element.id) defined.add(element.id);
    return new Set(
      [...collectReferencedIds(root)].filter((id) => defined.has(id))
    );
  }
  function renameIds(root, prefix, ids) {
    if (ids.size === 0) return;
    eachReference(root, (element, attribute, id) => {
      if (!ids.has(id)) return;
      const value = element.getAttribute(attribute) ?? "";
      element.setAttribute(
        attribute,
        attribute === "href" || attribute === "xlink:href" ? `#${prefix}${id}` : value.replace(
          URL_REFERENCE,
          (whole, quote, referenced) => referenced === id ? `url(${quote}#${prefix}${referenced}${quote})` : whole
        )
      );
    });
    for (const element of [root, ...root.querySelectorAll("[id]")])
      if (ids.has(element.id)) element.id = `${prefix}${element.id}`;
  }

  // src/ts/presenter/ghost-layer.ts
  var GHOST_ATTRIBUTE = "data-morph-ghost";
  function markGhost(element) {
    element.setAttribute(GHOST_ATTRIBUTE, "");
  }
  function removeGhosts(root) {
    for (const ghost of root.querySelectorAll(`[${GHOST_ATTRIBUTE}]`))
      ghost.remove();
  }
  var UNLIMITED_SCOPE = /@scope\s*\(([^)]*)\)\s*(?=\{)/g;
  function limitScopesToLiveContent(root) {
    const originals = /* @__PURE__ */ new Map();
    for (const style of root.querySelectorAll("style")) {
      const css = style.textContent ?? "";
      if (!css.includes("@scope")) continue;
      const limited = css.replace(
        UNLIMITED_SCOPE,
        `@scope($1) to ([${GHOST_ATTRIBUTE}]) `
      );
      if (limited === css) continue;
      originals.set(style, css);
      style.textContent = limited;
    }
    return () => {
      for (const [style, css] of originals) style.textContent = css;
    };
  }
  var CARRIED_TAGS = /* @__PURE__ */ new Set(["defs", "style"]);
  function prune(original, clone, keep) {
    if (keep.has(original)) return true;
    if (CARRIED_TAGS.has(original.tagName)) return true;
    let kept = false;
    const originalChildren = Array.from(original.children);
    for (let index = originalChildren.length - 1; index >= 0; index--) {
      const childClone = clone.children[index];
      if (!childClone) continue;
      if (prune(originalChildren[index], childClone, keep)) kept = true;
      else childClone.remove();
    }
    return kept;
  }
  function buildGhostLayer(outgoing, keep, {
    carryDefinitions,
    idPrefix,
    rename
  }) {
    if (keep.size === 0) return null;
    const layer = outgoing.cloneNode(true);
    prune(outgoing, layer, keep);
    if (!carryDefinitions)
      for (const carried of layer.querySelectorAll("defs, style"))
        carried.remove();
    for (const cued of layer.querySelectorAll("[data-cues]"))
      cued.removeAttribute("data-cues");
    layer.setAttribute("x", "0");
    layer.setAttribute("y", "0");
    layer.setAttribute("width", "100%");
    layer.setAttribute("height", "100%");
    markGhost(layer);
    renameIds(layer, idPrefix, rename);
    return layer;
  }

  // src/ts/presenter/ghost-placement.ts
  function documentOrder(root) {
    const order = /* @__PURE__ */ new Map([[root, 0]]);
    let rank = 1;
    for (const element of root.querySelectorAll("*"))
      order.set(element, rank++);
    return order;
  }
  function topLevelAncestor(root, element) {
    let current2 = element;
    while (current2 && current2.parentElement !== root)
      current2 = current2.parentElement;
    return current2;
  }
  function planGhostPlacement(outgoing, incoming, ghosts, matchedIds) {
    const order = documentOrder(outgoing);
    const anchors = [...order.entries()].filter(([element]) => element.id && matchedIds.has(element.id)).sort((a2, b2) => a2[1] - b2[1]);
    const insertionPoint = /* @__PURE__ */ new Map();
    for (const [element] of anchors) {
      const counterpart = incoming.querySelector(
        `[id="${CSS.escape(element.id)}"]`
      );
      insertionPoint.set(
        element.id,
        counterpart ? topLevelAncestor(incoming, counterpart) : null
      );
    }
    const byAnchor = /* @__PURE__ */ new Map();
    for (const ghost of [...ghosts].sort(
      (a2, b2) => (order.get(a2) ?? 0) - (order.get(b2) ?? 0)
    )) {
      const rank = order.get(ghost) ?? 0;
      const anchor = anchors.find(([, anchorRank]) => anchorRank > rank);
      const before = anchor ? insertionPoint.get(anchor[0].id) ?? null : null;
      const group3 = byAnchor.get(before);
      if (group3) group3.push(ghost);
      else byAnchor.set(before, [ghost]);
    }
    return [...byAnchor.entries()].map(([before, groupGhosts]) => ({
      before,
      ghosts: groupGhosts
    }));
  }

  // src/ts/presenter/morph.ts
  var LEAF_SELECTOR = "rect, circle, ellipse, line, polyline, polygon, path, text, image, foreignObject";
  var DEFINITION_SUBTREE_SELECTOR = "defs, marker, symbol, clipPath, mask, pattern";
  function isDefinitionContent(element) {
    return element.closest(DEFINITION_SUBTREE_SELECTOR) !== null;
  }
  function pairableDescendantIds(root) {
    const ids = /* @__PURE__ */ new Set();
    for (const element of root.querySelectorAll("[id]"))
      if (!isDefinitionContent(element)) ids.add(element.id);
    return ids;
  }
  function collectPairableIds(root) {
    const ids = pairableDescendantIds(root);
    if (root.id && !isDefinitionContent(root)) ids.add(root.id);
    return ids;
  }
  function pairableLeaves(root) {
    return Array.from(
      root.querySelectorAll(LEAF_SELECTOR)
    ).filter(
      (element) => !isDefinitionContent(element) && element.getScreenCTM() !== null
    );
  }
  var GHOST_ID_PREFIX = "morph-ghost-";
  var MORPH_OWNED_STYLE_PROPERTIES = [
    ...INTERPOLATED_ATTRIBUTES,
    "stroke-width",
    "font-size",
    "transform-box",
    "transform-origin"
  ];
  function readInlineStyle(element) {
    const declarations = {};
    for (const property of MORPH_OWNED_STYLE_PROPERTIES) {
      const value = element.style.getPropertyValue(property);
      if (value) declarations[property] = value;
    }
    return declarations;
  }
  function restoreInlineStyle(element, declarations) {
    const style = element.style;
    for (const property of MORPH_OWNED_STYLE_PROPERTIES) {
      const original = declarations[property];
      if (original) style.setProperty(property, original);
      else style.removeProperty(property);
    }
  }
  function captureFrame(element) {
    const bbox = element.getBBox();
    const screenCTM = DOMMatrix.fromMatrix(element.getScreenCTM());
    const frame = screenCTM.translate(bbox.x, bbox.y).scale(bbox.width, bbox.height);
    return {
      comp: decomposeAffine(frame),
      screenScale: { x: matrixScaleX(screenCTM), y: matrixScaleY(screenCTM) },
      bbox
    };
  }
  function readLengthAttributes(element) {
    const lengths = {};
    for (const name of ["rx", "ry"]) {
      const raw = element.getAttribute(name);
      if (raw === null) continue;
      const value = parseFloat(raw);
      if (Number.isFinite(value)) lengths[name] = value;
    }
    const strokeWidth = parseFloat(getComputedStyle(element).strokeWidth);
    if (Number.isFinite(strokeWidth)) lengths["stroke-width"] = strokeWidth;
    return lengths;
  }
  function screenPathSegments(element) {
    if (!(element instanceof SVGPathElement)) return null;
    const segments = parsePathData(element.getAttribute("d") ?? "");
    if (!segments) return null;
    return transformSegments(
      segments,
      element.getScreenCTM() ?? new DOMMatrix()
    );
  }
  function readFontSize(node) {
    const px = parseFloat(getComputedStyle(node).fontSize);
    return Number.isFinite(px) ? px : 0;
  }
  function textAnchorLocal(node) {
    return {
      x: node.x.baseVal.numberOfItems > 0 ? node.x.baseVal.getItem(0).value : 0,
      y: node.y.baseVal.numberOfItems > 0 ? node.y.baseVal.getItem(0).value : 0
    };
  }
  function captureTextScreenPose(node) {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const anchor = textAnchorLocal(node);
    const screen = new DOMPoint(anchor.x, anchor.y).matrixTransform(ctm);
    return {
      anchorX: screen.x,
      anchorY: screen.y,
      rotation: Math.atan2(ctm.b, ctm.a),
      scale: Math.hypot(ctm.a, ctm.b) || 1,
      fontSize: readFontSize(node)
    };
  }
  function captureEndpointsScreen(node) {
    const ctm = node.getScreenCTM() ?? new DOMMatrix();
    const p1 = new DOMPoint(
      node.x1.baseVal.value,
      node.y1.baseVal.value
    ).matrixTransform(ctm);
    const p2 = new DOMPoint(
      node.x2.baseVal.value,
      node.y2.baseVal.value
    ).matrixTransform(ctm);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }
  function leafKind(element) {
    if (element instanceof SVGLineElement) return "line";
    if (element instanceof SVGTextElement) return "text";
    return "box";
  }
  function parentScreenCTM(element) {
    const parent = element.parentElement;
    return parent instanceof SVGGraphicsElement ? parent.getScreenCTM() ?? new DOMMatrix() : new DOMMatrix();
  }
  function ancestorIdChain(element) {
    const ids = [];
    let current2 = element;
    while (current2) {
      if (current2.id) ids.push(current2.id);
      current2 = current2.parentElement;
    }
    return ids;
  }
  function snapshotLeaf(element) {
    const common = {
      ancestorIds: ancestorIdChain(element),
      fromAttributes: readInterpolatedAttributes(element),
      source: element
    };
    if (element instanceof SVGLineElement)
      return {
        kind: "line",
        ...common,
        endpointsScreen: captureEndpointsScreen(element),
        strokeWidth: readLengthAttributes(element)["stroke-width"]
      };
    if (element instanceof SVGTextElement)
      return {
        kind: "text",
        ...common,
        textPose: captureTextScreenPose(element)
      };
    const captured = captureFrame(element);
    return {
      kind: "box",
      ...common,
      frame: captured.comp,
      screenScale: captured.screenScale,
      lengths: readLengthAttributes(element),
      pathScreen: screenPathSegments(element) ?? void 0
    };
  }
  function snapshotLeaves(svg) {
    return {
      ids: pairableDescendantIds(svg),
      leaves: pairableLeaves(svg).map(snapshotLeaf)
    };
  }
  function snapshotTopLevelChildren(svg) {
    return Array.from(svg.children).map((child) => ({
      source: child,
      html: child.outerHTML,
      ids: collectPairableIds(child)
    }));
  }
  function nearestMatchedId(ancestorIds, matchedIds) {
    return ancestorIds.find((id) => matchedIds.has(id));
  }
  var SHAPE_ATTRIBUTES = {
    path: ["d"],
    polygon: ["points"],
    polyline: ["points"],
    image: ["href", "xlink:href"],
    use: ["href", "xlink:href"]
  };
  var SHAPE_FAMILY = {
    circle: "ellipse",
    ellipse: "ellipse"
  };
  function sameIntrinsicShape(from, to) {
    const family = (element) => SHAPE_FAMILY[element.tagName] ?? element.tagName;
    if (family(from) !== family(to)) return false;
    return (SHAPE_ATTRIBUTES[to.tagName] ?? []).every(
      (attribute) => from.getAttribute(attribute) === to.getAttribute(attribute)
    );
  }
  function createPathMorph(element, snapshot, common) {
    if (!(element instanceof SVGPathElement) || !snapshot.pathScreen)
      return null;
    const originalPathData = element.getAttribute("d") ?? "";
    const to = parsePathData(originalPathData);
    if (!to || !areCompatible(snapshot.pathScreen, to)) return null;
    const screenInverse = (element.getScreenCTM() ?? new DOMMatrix()).inverse();
    if (!Number.isFinite(screenInverse.a)) return null;
    return {
      ...common,
      kind: "path",
      element,
      from: transformSegments(snapshot.pathScreen, screenInverse),
      to,
      originalPathData,
      fromStrokeWidth: snapshot.lengths?.["stroke-width"],
      toStrokeWidth: readLengthAttributes(element)["stroke-width"]
    };
  }
  function createLeafMorph(element, snapshot) {
    const kind = leafKind(element);
    if (kind !== snapshot.kind) return null;
    const fromAttributes = snapshot.fromAttributes;
    const toAttributes = readInterpolatedAttributes(element);
    const originalInlineStyle = readInlineStyle(element);
    const common = {
      element,
      fromAttributes,
      toAttributes,
      originalInlineStyle
    };
    if (kind === "line" && element instanceof SVGLineElement && snapshot.endpointsScreen) {
      const screenInverse = (element.getScreenCTM() ?? new DOMMatrix()).inverse();
      const s2 = snapshot.endpointsScreen;
      const p1 = new DOMPoint(s2.x1, s2.y1).matrixTransform(screenInverse);
      const p2 = new DOMPoint(s2.x2, s2.y2).matrixTransform(screenInverse);
      return {
        kind: "line",
        ...common,
        element,
        from: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
        to: {
          x1: element.x1.baseVal.value,
          y1: element.y1.baseVal.value,
          x2: element.x2.baseVal.value,
          y2: element.y2.baseVal.value
        },
        fromStrokeWidth: snapshot.strokeWidth,
        toStrokeWidth: readLengthAttributes(element)["stroke-width"]
      };
    }
    if (kind === "text" && element instanceof SVGTextElement && snapshot.textPose) {
      if (snapshot.source.textContent !== element.textContent) return null;
      const anchor = textAnchorLocal(element);
      return {
        kind: "text",
        ...common,
        element,
        parentCTM: parentScreenCTM(element),
        originalTransform: element.getAttribute("transform") ?? "",
        anchorLocalX: anchor.x,
        anchorLocalY: anchor.y,
        from: snapshot.textPose,
        to: captureTextScreenPose(element)
      };
    }
    const pathMorph = createPathMorph(element, snapshot, common);
    if (pathMorph) return pathMorph;
    if (snapshot.frame && snapshot.screenScale) {
      const captured = captureFrame(element);
      if (captured.bbox.width === 0 || captured.bbox.height === 0)
        return null;
      if (snapshot.source.innerHTML !== element.innerHTML) return null;
      if (!sameIntrinsicShape(snapshot.source, element)) return null;
      const bTo = new DOMMatrix().translate(captured.bbox.x, captured.bbox.y).scale(captured.bbox.width, captured.bbox.height);
      element.style.setProperty("transform-box", "view-box");
      element.style.setProperty("transform-origin", "0 0");
      return {
        kind: "box",
        ...common,
        originalTransform: element.getAttribute("transform") ?? "",
        fromComp: snapshot.frame,
        toComp: captured.comp,
        parentInverse: parentScreenCTM(element).inverse(),
        bToInverse: bTo.inverse(),
        fromLengths: snapshot.lengths ?? {},
        toLengths: readLengthAttributes(element),
        fromScreenScale: snapshot.screenScale,
        toScreenScale: captured.screenScale
      };
    }
    return null;
  }
  function buildLeafEnter(element) {
    const target = parseFloat(element.getAttribute("opacity") ?? "1");
    element.style.opacity = "0";
    return {
      type: "fadeIn",
      element,
      targetOpacity: Number.isFinite(target) ? target : 1
    };
  }
  function buildLeafTasks(svgRoot, oldLeaves, matchedIds, ghosts) {
    const oldByScope = /* @__PURE__ */ new Map();
    for (const leaf of oldLeaves.leaves) {
      const scope = nearestMatchedId(leaf.ancestorIds, matchedIds);
      if (!scope) continue;
      (oldByScope.get(scope) ?? oldByScope.set(scope, []).get(scope)).push(
        leaf
      );
    }
    const newByScope = /* @__PURE__ */ new Map();
    for (const el of pairableLeaves(svgRoot)) {
      const scope = nearestMatchedId(ancestorIdChain(el), matchedIds);
      if (!scope) continue;
      (newByScope.get(scope) ?? newByScope.set(scope, []).get(scope)).push(
        el
      );
    }
    const tasks = [];
    const scopes = /* @__PURE__ */ new Set([...oldByScope.keys(), ...newByScope.keys()]);
    for (const scope of scopes) {
      const oldList = oldByScope.get(scope) ?? [];
      const newList = newByScope.get(scope) ?? [];
      const paired = Math.min(oldList.length, newList.length);
      for (let i2 = 0; i2 < paired; i2++) {
        const snapshot = oldList[i2];
        const element = newList[i2];
        const morph = leafKind(element) === snapshot.kind ? createLeafMorph(element, snapshot) : null;
        if (morph) {
          tickMorph(morph, 0);
          tasks.push({ type: "morph", morph });
        } else {
          ghosts.add(snapshot.source);
          tasks.push(buildLeafEnter(element));
        }
      }
      for (let i2 = paired; i2 < oldList.length; i2++)
        ghosts.add(oldList[i2].source);
      for (let i2 = paired; i2 < newList.length; i2++)
        tasks.push(buildLeafEnter(newList[i2]));
    }
    return tasks;
  }
  function containsMatchedId(ids, matchedIds) {
    for (const id of ids) if (matchedIds.has(id)) return true;
    return false;
  }
  var NON_RENDERING_TAGS = /* @__PURE__ */ new Set([
    "defs",
    "style",
    "metadata",
    "title",
    "desc"
  ]);
  function buildCrossfadeTasks(oldChildren, newChildren, matchedIds, ghosts) {
    const oldHtml = new Set(oldChildren.map((child) => child.html));
    const newHtml = new Set(newChildren.map((child) => child.html));
    const tasks = [];
    for (const child of oldChildren) {
      if (NON_RENDERING_TAGS.has(child.source.tagName)) continue;
      if (containsMatchedId(child.ids, matchedIds)) continue;
      if (newHtml.has(child.html)) continue;
      if (child.source instanceof SVGGraphicsElement)
        ghosts.add(child.source);
    }
    for (const child of newChildren) {
      if (NON_RENDERING_TAGS.has(child.source.tagName)) continue;
      if (containsMatchedId(child.ids, matchedIds)) continue;
      if (oldHtml.has(child.html)) continue;
      const element = child.source;
      if (!(element instanceof SVGGraphicsElement)) continue;
      element.style.opacity = "0";
      tasks.push({
        type: "fadeIn",
        element,
        targetOpacity: parseFloat(element.getAttribute("opacity") ?? "1")
      });
    }
    return tasks;
  }
  function matchedContainingChildIds(children, matchedIds) {
    const ids = /* @__PURE__ */ new Set();
    for (const child of children)
      if (containsMatchedId(child.ids, matchedIds))
        for (const id of child.ids) ids.add(id);
    return ids;
  }
  function buildOrphanTasks(svgRoot, oldLeaves, oldChildren, newChildren, matchedIds, ghosts) {
    const oldScope = matchedContainingChildIds(oldChildren, matchedIds);
    const newScope = matchedContainingChildIds(newChildren, matchedIds);
    const isOrphan = (ancestorIds, scope) => !nearestMatchedId(ancestorIds, matchedIds) && ancestorIds.some((id) => scope.has(id));
    const newLeaves = pairableLeaves(svgRoot);
    const oldHtml = new Set(oldLeaves.leaves.map((l2) => l2.source.outerHTML));
    const newHtml = new Set(newLeaves.map((el) => el.outerHTML));
    const tasks = [];
    for (const leaf of oldLeaves.leaves)
      if (isOrphan(leaf.ancestorIds, oldScope) && !newHtml.has(leaf.source.outerHTML))
        ghosts.add(leaf.source);
    for (const el of newLeaves)
      if (isOrphan(ancestorIdChain(el), newScope) && !oldHtml.has(el.outerHTML))
        tasks.push(buildLeafEnter(el));
    return tasks;
  }
  function buildTasks(svgRoot, oldLeaves, oldChildren, matchedIds) {
    const ghosts = /* @__PURE__ */ new Set();
    const newChildren = Array.from(svgRoot.children).map(
      (child) => ({
        source: child,
        html: child.outerHTML,
        ids: collectPairableIds(child)
      })
    );
    const orphanTasks = buildOrphanTasks(
      svgRoot,
      oldLeaves,
      oldChildren,
      newChildren,
      matchedIds,
      ghosts
    );
    return {
      tasks: [
        ...buildLeafTasks(svgRoot, oldLeaves, matchedIds, ghosts),
        ...orphanTasks,
        ...buildCrossfadeTasks(
          oldChildren,
          newChildren,
          matchedIds,
          ghosts
        )
      ],
      ghosts
    };
  }
  function matrixToSvgTransform(m2) {
    return `matrix(${m2.a} ${m2.b} ${m2.c} ${m2.d} ${m2.e} ${m2.f})`;
  }
  function applyColorAttributes(morph, easedProgress) {
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
      const fromValue = morph.fromAttributes[attribute];
      const toValue = morph.toAttributes[attribute];
      if (fromValue !== void 0 && toValue !== void 0)
        morph.element.style.setProperty(
          attribute,
          interpolateAttribute(
            attribute,
            fromValue,
            toValue,
            easedProgress
          )
        );
    }
  }
  function applyBox(morph, easedProgress) {
    const frame = interpolateAffine(
      morph.fromComp,
      morph.toComp,
      easedProgress
    );
    const localToScreen = frame.multiply(morph.bToInverse);
    morph.element.setAttribute(
      "transform",
      matrixToSvgTransform(morph.parentInverse.multiply(localToScreen))
    );
    const curScaleX = matrixScaleX(localToScreen);
    const curScaleY = matrixScaleY(localToScreen);
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const rxFrom = morph.fromLengths.rx;
    const rxTo = morph.toLengths.rx;
    if (rxFrom !== void 0 && rxTo !== void 0) {
      const ryFrom = morph.fromLengths.ry ?? rxFrom;
      const ryTo = morph.toLengths.ry ?? rxTo;
      const rxScreen = lerp2(
        rxFrom * morph.fromScreenScale.x,
        rxTo * morph.toScreenScale.x
      );
      const ryScreen = lerp2(
        ryFrom * morph.fromScreenScale.y,
        ryTo * morph.toScreenScale.y
      );
      morph.element.setAttribute("rx", String(rxScreen / curScaleX));
      morph.element.setAttribute("ry", String(ryScreen / curScaleY));
    }
    const swFrom = morph.fromLengths["stroke-width"];
    const swTo = morph.toLengths["stroke-width"];
    if (swFrom !== void 0 && swTo !== void 0) {
      const fromUniform = Math.sqrt(
        morph.fromScreenScale.x * morph.fromScreenScale.y
      );
      const toUniform = Math.sqrt(
        morph.toScreenScale.x * morph.toScreenScale.y
      );
      const curUniform = Math.sqrt(Math.max(curScaleX * curScaleY, 1e-6));
      const swScreen = lerp2(swFrom * fromUniform, swTo * toUniform);
      morph.element.setAttribute(
        "stroke-width",
        String(swScreen / curUniform)
      );
    }
  }
  function applyText(morph, easedProgress) {
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const target = new DOMMatrix().translate(
      lerp2(morph.from.anchorX, morph.to.anchorX),
      lerp2(morph.from.anchorY, morph.to.anchorY)
    ).rotate(lerp2(morph.from.rotation, morph.to.rotation) * 180 / Math.PI).scale(lerp2(morph.from.scale, morph.to.scale)).translate(-morph.anchorLocalX, -morph.anchorLocalY);
    const local = morph.parentCTM.inverse().multiply(target);
    morph.element.setAttribute("transform", matrixToSvgTransform(local));
    morph.element.style.fontSize = `${lerp2(morph.from.fontSize, morph.to.fontSize)}px`;
  }
  function applyStrokeWidth(element, from, to, easedProgress) {
    if (from === void 0 || to === void 0) return;
    element.style.setProperty(
      "stroke-width",
      String(from + (to - from) * easedProgress)
    );
  }
  function applyPath(morph, easedProgress) {
    morph.element.setAttribute(
      "d",
      serializePathData(
        interpolateSegments(morph.from, morph.to, easedProgress)
      )
    );
    applyStrokeWidth(
      morph.element,
      morph.fromStrokeWidth,
      morph.toStrokeWidth,
      easedProgress
    );
  }
  function applyLine(morph, easedProgress) {
    const lerp2 = (from, to) => from + (to - from) * easedProgress;
    const element = morph.element;
    element.setAttribute("x1", String(lerp2(morph.from.x1, morph.to.x1)));
    element.setAttribute("y1", String(lerp2(morph.from.y1, morph.to.y1)));
    element.setAttribute("x2", String(lerp2(morph.from.x2, morph.to.x2)));
    element.setAttribute("y2", String(lerp2(morph.from.y2, morph.to.y2)));
    applyStrokeWidth(
      element,
      morph.fromStrokeWidth,
      morph.toStrokeWidth,
      easedProgress
    );
  }
  function tickMorph(morph, easedProgress) {
    if (morph.kind === "box") applyBox(morph, easedProgress);
    else if (morph.kind === "text") applyText(morph, easedProgress);
    else if (morph.kind === "path") applyPath(morph, easedProgress);
    else applyLine(morph, easedProgress);
    applyColorAttributes(morph, easedProgress);
  }
  function tickTasks(tasks, rawProgress) {
    const easedProgress = easeInOut(rawProgress);
    for (const task of tasks) {
      if (task.type === "morph") {
        tickMorph(task.morph, easedProgress);
      } else if (task.type === "fadeIn") {
        const fadeProgress = easeInOut(
          Math.max(0, Math.min((rawProgress - 0.3) / 0.7, 1))
        );
        task.element.style.opacity = String(
          fadeProgress * task.targetOpacity
        );
      } else {
        const exitProgress = easeInOut(Math.min(rawProgress / 0.7, 1));
        task.element.style.opacity = String(
          task.startOpacity * (1 - exitProgress)
        );
      }
    }
  }
  function finalizeMorph(morph) {
    restoreInlineStyle(morph.element, morph.originalInlineStyle);
    if (morph.kind === "path") {
      morph.element.setAttribute("d", morph.originalPathData);
      return;
    }
    if (morph.kind === "line") {
      morph.element.setAttribute("x1", String(morph.to.x1));
      morph.element.setAttribute("y1", String(morph.to.y1));
      morph.element.setAttribute("x2", String(morph.to.x2));
      morph.element.setAttribute("y2", String(morph.to.y2));
      return;
    }
    if (morph.kind === "text") {
      if (morph.originalTransform)
        morph.element.setAttribute("transform", morph.originalTransform);
      else morph.element.removeAttribute("transform");
      return;
    }
    if (morph.originalTransform)
      morph.element.setAttribute("transform", morph.originalTransform);
    else morph.element.removeAttribute("transform");
    if (morph.toLengths.rx !== void 0)
      morph.element.setAttribute("rx", String(morph.toLengths.rx));
    if (morph.toLengths.ry !== void 0)
      morph.element.setAttribute("ry", String(morph.toLengths.ry));
    else if (morph.fromLengths.rx !== void 0)
      morph.element.removeAttribute("ry");
  }
  function finalizeTasks(tasks) {
    for (const task of tasks) {
      if (task.type === "morph") finalizeMorph(task.morph);
      else if (task.type === "exit") task.element.remove();
      else {
        task.element.style.opacity = "";
        if (task.element.getAttribute("style") === "")
          task.element.removeAttribute("style");
      }
    }
  }
  var MorphTransition = class {
    oldLeaves = { ids: /* @__PURE__ */ new Set(), leaves: [] };
    oldChildren = [];
    tasks = [];
    driver = new ProgressDriver();
    stage;
    oldHtml = "";
    // The outgoing <svg> itself. Detached once the new slide is swapped in, but intact,
    // and every ghost layer is a pruned clone of it.
    oldSvg = null;
    restoreScopes = null;
    // Snapshot the outgoing slide before swap() replaces the DOM, and keep its
    // markup so a full reversal can restore the real previous slide.
    prepare({ stage: stage6 }) {
      this.stage = stage6;
      removeGhosts(stage6);
      this.oldHtml = stage6.innerHTML;
      const beforeSvg = stage6.querySelector("svg");
      this.oldSvg = beforeSvg;
      this.oldLeaves = beforeSvg ? snapshotLeaves(beforeSvg) : { ids: /* @__PURE__ */ new Set(), leaves: [] };
      this.oldChildren = beforeSvg ? snapshotTopLevelChildren(beforeSvg) : [];
    }
    async start({
      stage: stage6,
      params,
      signal
    }) {
      if (params.duration <= 0) return;
      const svgRoot = stage6.querySelector("svg");
      if (!svgRoot) return;
      const newIds = collectPairableIds(svgRoot);
      const matchedIds = /* @__PURE__ */ new Set();
      for (const id of this.oldLeaves.ids)
        if (newIds.has(id)) matchedIds.add(id);
      const { tasks, ghosts } = buildTasks(
        svgRoot,
        this.oldLeaves,
        this.oldChildren,
        matchedIds
      );
      this.tasks = [...tasks, ...this.layGhosts(svgRoot, ghosts, matchedIds)];
      await this.driver.animateTo(
        1,
        params.duration,
        signal,
        (progress) => tickTasks(this.tasks, progress)
      );
      if (!signal.aborted) this.settle();
    }
    // Reverse direction mid-flight by retargeting the progress: the same tasks run
    // backward, so every property retraces its exact path. No re-snapshot of the
    // intermediate DOM, hence no colour or corner-radius jump and no crossfade
    // darkening across repeated reversals.
    async reverse({
      params,
      signal
    }) {
      const target = this.driver.heading === 1 ? 0 : 1;
      await this.driver.animateTo(
        target,
        params.duration,
        signal,
        (progress) => tickTasks(this.tasks, progress)
      );
      if (!signal.aborted) this.settle();
    }
    cancel({ stage: stage6 }) {
      this.releaseScopes();
      removeGhosts(stage6);
    }
    // Nest one container per insertion point into the incoming slide's own tree, so a
    // ghost lands where it sat relative to the elements that survive rather than
    // wholly above or below everything.
    layGhosts(svgRoot, ghosts, matchedIds) {
      const outgoing = this.oldSvg;
      if (!outgoing || ghosts.size === 0) return [];
      const rename = referencedDefinitions(outgoing);
      this.restoreScopes = limitScopesToLiveContent(svgRoot);
      const tasks = [];
      let carryDefinitions = true;
      for (const group3 of planGhostPlacement(
        outgoing,
        svgRoot,
        ghosts,
        matchedIds
      )) {
        const container = buildGhostLayer(outgoing, new Set(group3.ghosts), {
          carryDefinitions,
          idPrefix: GHOST_ID_PREFIX,
          rename
        });
        if (!container) continue;
        carryDefinitions = false;
        svgRoot.insertBefore(container, group3.before);
        tasks.push({ type: "exit", element: container, startOpacity: 1 });
      }
      return tasks;
    }
    releaseScopes() {
      this.restoreScopes?.();
      this.restoreScopes = null;
    }
    // progress 1 → the new slide is fully formed; snap it to its natural state.
    // progress 0 → reversed all the way back; the morphed elements only *look* like
    // the previous slide, so restore the real one.
    settle() {
      if (this.driver.value >= 1) finalizeTasks(this.tasks);
      else this.stage.innerHTML = this.oldHtml;
      this.releaseScopes();
      removeGhosts(this.stage);
    }
  };

  // src/ts/presenter/transitions.ts
  var stage4 = document.getElementById("stage");
  var CUT = { type: "cut", duration: 0 };
  var registry = /* @__PURE__ */ new Map();
  function registerTransition(name, factory) {
    registry.set(name, factory);
  }
  function reportTransitionFailure(error) {
    console.error("inkflow: transition failed", error);
  }
  var liveInstance = null;
  var liveController = null;
  var liveParams = null;
  var liveSettle = null;
  function cancelInflight(callThen) {
    if (!liveController) return;
    const ctrl = liveController;
    const inst = liveInstance;
    const params = liveParams;
    const settle = liveSettle;
    liveController = null;
    liveInstance = null;
    liveParams = null;
    liveSettle = null;
    ctrl.abort();
    inst?.cancel?.({ stage: stage4, params });
    settle(callThen);
  }
  function inflightDirection() {
    if (!liveParams) return null;
    return liveParams.reverse ? "backward" : "forward";
  }
  function snapInflight() {
    cancelInflight(true);
    stage4.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
    fitSlideToStage(stage4.firstElementChild);
    slideMounted();
    applyCurrentStepInstant();
    updateStatus();
  }
  var fittedSlides = /* @__PURE__ */ new Set();
  function fitSlideToStage(el) {
    for (const tracked of fittedSlides) {
      if (!tracked.isConnected) fittedSlides.delete(tracked);
    }
    if (!(el instanceof SVGSVGElement)) return;
    fittedSlides.add(el);
    refit(el);
  }
  function refit(el) {
    const parent = el.parentElement;
    if (!parent) return;
    const vb = parseViewBox(el.getAttribute("viewBox"));
    const parentStyle = getComputedStyle(parent);
    const availWidth = parent.clientWidth - Number.parseFloat(parentStyle.paddingLeft) - Number.parseFloat(parentStyle.paddingRight);
    const availHeight = parent.clientHeight - Number.parseFloat(parentStyle.paddingTop) - Number.parseFloat(parentStyle.paddingBottom);
    const scale = Math.min(availWidth / vb.w, availHeight / vb.h);
    el.style.width = `${vb.w * scale}px`;
    el.style.height = `${vb.h * scale}px`;
  }
  new ResizeObserver(() => {
    for (const el of fittedSlides) {
      if (el.isConnected) refit(el);
      else fittedSlides.delete(el);
    }
  }).observe(stage4);
  function makeLayer() {
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
    layer.style.padding = getComputedStyle(stage4).padding;
    return layer;
  }
  function dirAxis(dir) {
    return dir === "up" || dir === "down" ? "Y" : "X";
  }
  function incomingSign(dir) {
    return dir === "left" || dir === "up" ? 1 : -1;
  }
  function flipDir(dir) {
    return { left: "right", right: "left", up: "down", down: "up" }[dir] ?? dir;
  }
  var ProgressTransition = class {
    constructor(render) {
      this.render = render;
    }
    render;
    oldLayer;
    newLayer;
    outgoingHtml = "";
    stageStyleText = "";
    settled = false;
    driver = new ProgressDriver();
    ease = (progress) => progress;
    // Captured at start() and used for every frame, including reverse(). The
    // geometry must not change when direction flips — the progress value alone
    // carries the reversal — so reverse()'s own (direction-flipped) params are
    // ignored for painting.
    startParams;
    prepare() {
      this.outgoingHtml = stage4.innerHTML;
      this.stageStyleText = stage4.style.cssText;
    }
    async start({
      params,
      signal
    }) {
      if (params.duration <= 0) return;
      this.startParams = params;
      this.buildLayers();
      this.ease = cubicBezierEasing(params.easing);
      this.paint(0);
      await this.driver.animateTo(
        1,
        params.duration,
        signal,
        (value) => this.paint(value)
      );
      if (!signal.aborted) this.settle();
    }
    async reverse({
      signal
    }) {
      const target = this.driver.heading === 1 ? 0 : 1;
      await this.driver.animateTo(
        target,
        this.startParams.duration,
        signal,
        (value) => this.paint(value)
      );
      if (!signal.aborted) this.settle();
    }
    cancel() {
      this.teardown(this.newLayer);
    }
    paint(value) {
      this.render(
        { stage: stage4, oldLayer: this.oldLayer, newLayer: this.newLayer },
        this.ease(value),
        this.startParams
      );
    }
    buildLayers() {
      this.settled = false;
      const newLayer = makeLayer();
      while (stage4.firstChild) newLayer.appendChild(stage4.firstChild);
      fitSlideToStage(newLayer.firstElementChild);
      stage4.appendChild(newLayer);
      this.newLayer = newLayer;
      const oldLayer = makeLayer();
      oldLayer.innerHTML = this.outgoingHtml;
      fitSlideToStage(oldLayer.firstElementChild);
      stage4.appendChild(oldLayer);
      this.oldLayer = oldLayer;
    }
    settle() {
      this.teardown(this.driver.value >= 1 ? this.newLayer : this.oldLayer);
    }
    // Replace the stage's content with just the shown slide, dropping both layers
    // and anything else a render added (the fade colour backdrop) in one step, and
    // restore the stage's pre-transition inline style. Idempotent; skipped when no
    // layers were built (duration 0), where the slide is already in place.
    teardown(shownLayer) {
      if (this.settled) return;
      this.settled = true;
      if (shownLayer) stage4.replaceChildren(...shownLayer.children);
      stage4.style.cssText = this.stageStyleText;
    }
  };
  function registerProgressTransition(name, render) {
    registerTransition(name, () => new ProgressTransition(render));
  }
  var CutTransition = class {
    async start() {
    }
  };
  var crossfadeRender = ({ oldLayer }, progress) => {
    oldLayer.style.opacity = String(1 - progress);
  };
  var pushRender = ({ oldLayer, newLayer }, progress, params) => {
    const direction = params.reverse ? flipDir(params.direction ?? "left") : params.direction ?? "left";
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    oldLayer.style.transform = `translate${axis}(${-progress * 100 * sign}%)`;
    newLayer.style.transform = `translate${axis}(${(1 - progress) * 100 * sign}%)`;
  };
  var coverRender = ({ oldLayer }, progress, params) => {
    const direction = params.direction ?? "left";
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    const exitSign = params.reverse ? sign : -sign;
    oldLayer.style.transform = `translate${axis}(${exitSign * 100 * progress}%)`;
  };
  var zoomRender = ({ oldLayer, newLayer }, progress, params) => {
    const amount = params.amount ?? 0.6;
    oldLayer.style.transformOrigin = "center";
    newLayer.style.transformOrigin = "center";
    oldLayer.style.opacity = String(1 - progress);
    newLayer.style.opacity = String(progress);
    if (params.reverse) {
      oldLayer.style.transform = `scale(${1 - amount * progress})`;
      newLayer.style.transform = `scale(${1 + amount - amount * progress})`;
    } else {
      oldLayer.style.transform = `scale(${1 + amount * progress})`;
      newLayer.style.transform = `scale(${1 - amount + amount * progress})`;
    }
  };
  var SVG_NS3 = "http://www.w3.org/2000/svg";
  function makeFadeBackdrop(slideSvg2, color) {
    const layer = makeLayer();
    layer.dataset.fadeBackdrop = "1";
    const vb = parseViewBox(slideSvg2?.getAttribute("viewBox") ?? null);
    const svg = document.createElementNS(SVG_NS3, "svg");
    svg.setAttribute("viewBox", formatViewBox(vb));
    svg.setAttribute(
      "preserveAspectRatio",
      slideSvg2?.getAttribute("preserveAspectRatio") ?? "xMidYMid meet"
    );
    const rect = document.createElementNS(SVG_NS3, "rect");
    rect.setAttribute("width", String(vb.w));
    rect.setAttribute("height", String(vb.h));
    rect.setAttribute("fill", color);
    svg.appendChild(rect);
    layer.appendChild(svg);
    fitSlideToStage(layer.firstElementChild);
    return layer;
  }
  var fadeRender = ({ stage: stageElement, oldLayer, newLayer }, progress, params) => {
    const existing = newLayer.previousElementSibling;
    if (!(existing instanceof HTMLElement) || existing.dataset.fadeBackdrop !== "1") {
      const backdrop = makeFadeBackdrop(
        newLayer.querySelector("svg"),
        params.color ?? "#000000"
      );
      stageElement.insertBefore(backdrop, newLayer);
    }
    oldLayer.style.opacity = String(Math.max(0, 1 - progress * 2));
    newLayer.style.opacity = String(Math.max(0, progress * 2 - 1));
  };
  var WIPE_CLIP = {
    left: (percent) => `inset(0 0 0 ${percent}%)`,
    right: (percent) => `inset(0 ${percent}% 0 0)`,
    up: (percent) => `inset(0 0 ${percent}% 0)`,
    down: (percent) => `inset(${percent}% 0 0 0)`
  };
  var wipeRender = ({ oldLayer }, progress, params) => {
    const direction = params.reverse ? flipDir(params.direction ?? "left") : params.direction ?? "left";
    const clip = WIPE_CLIP[direction] ?? WIPE_CLIP.left;
    oldLayer.style.clipPath = clip(progress * 100);
  };
  registerTransition("cut", () => new CutTransition());
  registerProgressTransition("crossfade", crossfadeRender);
  registerProgressTransition("push", pushRender);
  registerProgressTransition("cover", coverRender);
  registerProgressTransition("zoom", zoomRender);
  registerProgressTransition("fade", fadeRender);
  registerProgressTransition("wipe", wipeRender);
  registerTransition("morph", () => new MorphTransition());
  function loadSlide(then = null, transition = null, entryPlay = false) {
    const body = () => loadSlideBody(then, transition, entryPlay);
    if (cameraIsZoomed()) {
      resetCameraThen(body);
    } else {
      cancelPendingNav();
      body();
    }
  }
  function loadSlideBody(then, transition, entryPlay) {
    resetCamera();
    settleStepRun();
    slideLeaving();
    const params = transition ?? state.transitions[state.slideIndex] ?? CUT;
    const entering = entryPlay && params.type !== "cut" && !params.reverse;
    const settleContent = () => {
      applyCurrentStepInstant();
      updateStatus();
    };
    const initialLand = entering ? () => {
      applyStepInstant(stage4, state.step - 1);
      updateStatus();
    } : settleContent;
    const swap = () => {
      stage4.innerHTML = state.slides.length ? state.slides[state.slideIndex].svg : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
      fitSlideToStage(stage4.firstElementChild);
      slideMounted();
      initialLand();
    };
    const canReverse = liveInstance?.reverse != null && liveParams != null && liveParams.type === params.type && Boolean(liveParams.reverse) !== Boolean(params.reverse);
    if (canReverse) {
      const inst2 = liveInstance;
      const ctrl2 = liveController;
      const prevSettle = liveSettle;
      ctrl2.abort();
      liveController = null;
      liveInstance = null;
      liveParams = null;
      liveSettle = null;
      prevSettle(true);
      const newCtrl = new AbortController();
      let done2 = false;
      const settle2 = (callThen) => {
        if (done2) return;
        done2 = true;
        if (liveController === newCtrl) {
          liveController = null;
          liveInstance = null;
          liveParams = null;
          liveSettle = null;
        }
        if (callThen) then?.();
      };
      liveController = newCtrl;
      liveInstance = inst2;
      liveParams = params;
      liveSettle = settle2;
      inst2.reverse({ stage: stage4, params, signal: newCtrl.signal }).then(() => {
        if (!newCtrl.signal.aborted) {
          slideMounted();
          settleContent();
        }
        settle2(true);
      }).catch((error) => {
        reportTransitionFailure(error);
        settle2(false);
      });
      return;
    }
    cancelInflight(true);
    const makeTransition = registry.get(params.type);
    if (!makeTransition) {
      swap();
      if (entering) applyCurrentStep();
      then?.();
      return;
    }
    const inst = makeTransition();
    commitStepStyles(stage4);
    inst.prepare?.({ stage: stage4, params });
    const ctrl = new AbortController();
    let done = false;
    const settle = (callThen) => {
      if (done) return;
      done = true;
      if (liveController === ctrl) {
        liveController = null;
        liveInstance = null;
        liveParams = null;
        liveSettle = null;
      }
      if (callThen) then?.();
    };
    liveController = ctrl;
    liveInstance = inst;
    liveParams = params;
    liveSettle = settle;
    swap();
    inst.start({ stage: stage4, params, signal: ctrl.signal }).then(() => {
      if (entering && !ctrl.signal.aborted) applyCurrentStep();
      settle(true);
    }).catch((error) => {
      reportTransitionFailure(error);
      settle(false);
    });
  }

  // src/ts/presenter/websocket.ts
  var wsDot = document.getElementById("ws-dot");
  var overviewEl2 = document.getElementById("overview");
  var overviewGridEl = document.getElementById("overview-grid");
  var SYNC_MODE_KEY = "inkflow-sync-mode";
  function isSyncMode(v2) {
    return v2 === "two-way" || v2 === "present" || v2 === "follow" || v2 === "solo";
  }
  function sends() {
    return state.syncMode === "two-way" || state.syncMode === "present";
  }
  function receives() {
    return state.syncMode === "two-way" || state.syncMode === "follow";
  }
  function loadSyncMode() {
    let stored = null;
    try {
      stored = sessionStorage.getItem(SYNC_MODE_KEY);
    } catch (_2) {
    }
    if (isSyncMode(stored)) state.syncMode = stored;
  }
  function applySyncMode(mode) {
    state.syncMode = mode;
    try {
      sessionStorage.setItem(SYNC_MODE_KEY, mode);
    } catch (_2) {
    }
    if (receives()) requestSync();
  }
  function postToPeer(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    } else if (state.windowLink && !state.windowLink.closed) {
      state.windowLink.postMessage(msg, "*");
    }
  }
  function requestSync() {
    postToPeer({ type: "sync-request" });
  }
  function sendNav(transition) {
    if (state._syncingFromServer || !sends()) return;
    postToPeer({
      type: "nav",
      slideIndex: state.slideIndex,
      step: state.step,
      ...transition ? { transition } : {}
    });
  }
  function sendInk(msg) {
    if (msg.op === "request" ? !receives() : !sends()) return;
    postToPeer(msg);
  }
  function applyPeerInk(msg) {
    if (msg.op === "request" ? sends() : receives()) applyIncomingInk(msg);
  }
  function sendSnap() {
    if (state._syncingFromServer || !sends()) return;
    postToPeer({
      type: "nav",
      slideIndex: state.slideIndex,
      step: state.step,
      snap: true
    });
  }
  function currentNavMessage() {
    return { type: "nav", slideIndex: state.slideIndex, step: state.step };
  }
  function applyIncomingPosition(msg) {
    if (!receives()) return;
    if (msg.snap) {
      snapInflight();
      snapStepRun();
      return;
    }
    const newIndex = Math.min(
      Math.max(0, msg.slideIndex | 0),
      Math.max(0, state.slides.length - 1)
    );
    const newStep = Math.max(0, msg.step | 0);
    if (newIndex === state.slideIndex && newStep === state.step) return;
    if (newIndex === state.slideIndex) {
      const prevStep = state.step;
      state._syncingFromServer = true;
      state.step = newStep;
      if (Math.abs(newStep - prevStep) === 1) applyCurrentStep();
      else applyCurrentStepInstant();
      state._syncingFromServer = false;
      renderPvNext();
      updatePvInfo();
      return;
    }
    state._syncingFromServer = true;
    state.slideIndex = newIndex;
    state.step = newStep;
    loadSlide(() => {
      if (state.step > 0) applyCurrentStep();
      state._syncingFromServer = false;
    }, msg.transition ?? null);
    renderPv();
  }
  function connectWS(wsPort, authoritative) {
    if (!wsPort) return;
    state.ws = new WebSocket(`ws://localhost:${wsPort}`);
    let firstPositionPending = false;
    state.ws.onopen = () => {
      wsDot.className = "connected";
      wsDot.dataset.tooltip = "Connected";
      const assert = authoritative && sends();
      firstPositionPending = assert;
      if (assert) sendNav();
      requestInk();
    };
    state.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_2) {
        return;
      }
      if (msg.type === "update") {
        applyDeckStyles(msg);
        state.slides = msg.slides;
        state.transitions = msg.transitions;
        hideError();
        showLogs(msg.logs ?? []);
        if (overviewEl2.classList.contains("visible")) {
          overviewEl2.classList.remove("visible");
          overviewGridEl.innerHTML = "";
        }
        state.slideIndex = Math.min(
          state.slideIndex,
          Math.max(0, state.slides.length - 1)
        );
        state.step = Math.min(state.step, maxStep2());
        loadSlide(null, CUT);
        renderPv();
      } else if (msg.type === "error") {
        showError(msg.message);
      } else if (msg.type === "ink") {
        applyPeerInk(msg);
      } else if (msg.type === "edit-result") {
        inkSaveResult(msg);
      } else if (msg.type === "notify") {
        showNotify(msg.message, msg.style);
      } else if (msg.type === "position") {
        if (receives() && !msg.snap && firstPositionPending) {
          firstPositionPending = false;
          return;
        }
        applyIncomingPosition(msg);
      }
    };
    state.ws.onclose = () => {
      wsDot.className = "";
      wsDot.dataset.tooltip = "Disconnected";
      state.ws = null;
      setTimeout(() => connectWS(wsPort, true), 2e3);
    };
    state.ws.onerror = () => state.ws?.close();
  }

  // src/ts/presenter/syncmenu.ts
  var btnSync = document.getElementById("btn-sync");
  var syncMenu = document.getElementById("sync-menu");
  var SYNC_ORDER = ["two-way", "present", "follow", "solo"];
  var SYNC_LABELS = {
    "two-way": "Two-way (send + receive)",
    present: "Present (send only)",
    follow: "Follow (receive only)",
    solo: "Solo (no sync)"
  };
  function renderSyncButton() {
    btnSync.dataset.mode = state.syncMode;
    const label = SYNC_LABELS[state.syncMode];
    btnSync.dataset.tooltip = `Sync: ${label} (s)`;
    btnSync.setAttribute("aria-label", `Sync mode: ${label}`);
    for (const row of syncMenu.querySelectorAll(".sync-row")) {
      const active2 = row.dataset.mode === state.syncMode;
      row.classList.toggle("active", active2);
      row.setAttribute("aria-checked", String(active2));
    }
  }
  function setSyncMode(mode) {
    applySyncMode(mode);
    renderSyncButton();
    closeMenu2();
  }
  function cycleSyncMode() {
    const i2 = SYNC_ORDER.indexOf(state.syncMode);
    setSyncMode(SYNC_ORDER[(i2 + 1) % SYNC_ORDER.length]);
  }
  function onDocClick2(e2) {
    const t2 = e2.target;
    if (!btnSync.contains(t2) && !syncMenu.contains(t2)) closeMenu2();
  }
  function onKeydown(e2) {
    if (e2.key === "Escape") {
      closeMenu2();
      btnSync.focus();
    }
  }
  function openMenu2() {
    syncMenu.classList.add("open");
    btnSync.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick2);
    document.addEventListener("keydown", onKeydown);
    menuOpened(closeMenu2);
  }
  function closeMenu2() {
    if (!syncMenu.classList.contains("open")) return;
    syncMenu.classList.remove("open");
    btnSync.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick2);
    document.removeEventListener("keydown", onKeydown);
    menuClosed(closeMenu2);
  }
  function toggleMenu2() {
    if (syncMenu.classList.contains("open")) closeMenu2();
    else openMenu2();
  }
  function initSyncMenu() {
    btnSync.addEventListener("click", (e2) => {
      e2.stopPropagation();
      toggleMenu2();
    });
    for (const row of syncMenu.querySelectorAll(".sync-row"))
      row.addEventListener(
        "click",
        () => setSyncMode(row.dataset.mode)
      );
    renderSyncButton();
  }

  // src/ts/presenter/toeditor.ts
  var served = false;
  function backToEditor() {
    if (!served) return;
    const hash = `#slide=${state.slideIndex + 1}`;
    const opener = window.opener;
    try {
      if (opener && !opener.closed && opener.location.origin === location.origin && opener.location.pathname.startsWith("/edit")) {
        opener.location.hash = hash;
        opener.focus();
        window.close();
        if (window.closed) return;
      }
    } catch {
    }
    location.href = `/edit${hash}`;
  }
  function initToEditor(wsPort) {
    const button3 = document.getElementById("btn-to-editor");
    served = wsPort != null;
    if (!button3) return;
    if (!served) {
      button3.style.display = "none";
      return;
    }
    button3.addEventListener("click", backToEditor);
  }

  // src/ts/presenter/windowsync.ts
  var statusDot = document.getElementById("ws-dot");
  var btnPresenterView = document.getElementById("btn-presenter-view");
  var POLL_INTERVAL_MS = 300;
  var POPUP_BLOCKED_MESSAGE = "Pop-up blocked \u2014 allow pop-ups for this page to open the presenter view.";
  function isSyncPayload(data) {
    if (typeof data !== "object" || data === null) return false;
    const msg = data;
    return msg.type === "nav" && typeof msg.slideIndex === "number" && typeof msg.step === "number";
  }
  function isSyncRequest(data) {
    return typeof data === "object" && data !== null && data.type === "sync-request";
  }
  function isInkPayload(data) {
    return typeof data === "object" && data !== null && data.type === "ink" && typeof data.op === "string";
  }
  var linkHandler;
  var linkPoll;
  function attachLink(win, requestCatchUp = false) {
    state.windowLink = win;
    statusDot.className = "connected";
    btnPresenterView.style.display = "none";
    linkHandler = (e2) => {
      if (e2.source !== win || e2.origin !== window.origin) return;
      if (isSyncRequest(e2.data)) {
        win.postMessage(currentNavMessage(), "*");
        return;
      }
      if (isSyncPayload(e2.data)) applyIncomingPosition(e2.data);
      else if (isInkPayload(e2.data)) applyPeerInk(e2.data);
    };
    window.addEventListener("message", linkHandler);
    linkPoll = setInterval(() => {
      if (win.closed) detachLink();
    }, POLL_INTERVAL_MS);
    if (requestCatchUp) {
      requestSync();
      requestInk();
    }
  }
  function detachLink() {
    state.windowLink = null;
    statusDot.className = "";
    btnPresenterView.style.display = "";
    if (linkHandler) window.removeEventListener("message", linkHandler);
    linkHandler = void 0;
    clearInterval(linkPoll);
    linkPoll = void 0;
  }
  var _wsPort = null;
  function openSyncedWindow() {
    if (_wsPort === null && state.windowLink) return;
    const child = window.open(location.href);
    if (!child) {
      showNotify(POPUP_BLOCKED_MESSAGE, "yellow");
      return;
    }
    if (_wsPort === null) attachLink(child);
  }
  function initWindowSync(wsPort) {
    _wsPort = wsPort;
    btnPresenterView.addEventListener("click", openSyncedWindow);
    if (wsPort !== null) return;
    if (window.opener) attachLink(window.opener, true);
  }

  // src/ts/presenter/laser.ts
  var SVG_NS4 = "http://www.w3.org/2000/svg";
  var stageWrap3 = document.getElementById("stage-wrap");
  var overlay = document.getElementById(
    "laser-overlay"
  );
  var dot = document.getElementById("laser-dot");
  var DOT_RADIUS = 8;
  var isDrawing = false;
  var currentPath = null;
  var currentPoints = [];
  var pendingClientX = 0;
  var pendingClientY = 0;
  var rafId = null;
  var stageRect = stageWrap3.getBoundingClientRect();
  new ResizeObserver(() => {
    stageRect = stageWrap3.getBoundingClientRect();
  }).observe(stageWrap3);
  function flushFrame() {
    rafId = null;
    const x2 = pendingClientX - stageRect.left;
    const y2 = pendingClientY - stageRect.top;
    dot.style.transform = `translate(${x2 - DOT_RADIUS}px, ${y2 - DOT_RADIUS}px)`;
    if (isDrawing && currentPath && currentPoints.length > 0) {
      currentPath.setAttribute("d", currentPoints.join(" "));
    }
  }
  stageWrap3.addEventListener("pointermove", (e2) => {
    if (!state._laserMode) return;
    pendingClientX = e2.clientX;
    pendingClientY = e2.clientY;
    if (isDrawing) {
      const x2 = e2.clientX - stageRect.left;
      const y2 = e2.clientY - stageRect.top;
      currentPoints.push(`L ${x2} ${y2}`);
    }
    if (rafId === null) rafId = requestAnimationFrame(flushFrame);
  });
  stageWrap3.addEventListener("pointerdown", (e2) => {
    if (!state._laserMode) return;
    if (isCameraGesture(e2)) return;
    if (e2.target.closest("#overview")) return;
    stageWrap3.setPointerCapture(e2.pointerId);
    const x2 = e2.clientX - stageRect.left;
    const y2 = e2.clientY - stageRect.top;
    currentPath = document.createElementNS(SVG_NS4, "path");
    currentPoints = [`M ${x2} ${y2}`];
    currentPath.classList.add("laser-trail");
    overlay.appendChild(currentPath);
    isDrawing = true;
  });
  stageWrap3.addEventListener("pointerup", finalizeDraw);
  stageWrap3.addEventListener("pointercancel", finalizeDraw);
  function finalizeDraw() {
    if (!isDrawing || !currentPath) return;
    isDrawing = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      flushFrame();
    }
    currentPath.classList.add("trail");
    const path = currentPath;
    path.addEventListener("animationend", () => path.remove(), { once: true });
    currentPath = null;
    currentPoints = [];
  }
  function abortDraw() {
    if (!isDrawing) return;
    isDrawing = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    currentPath?.remove();
    currentPath = null;
    currentPoints = [];
  }
  onTouchCancel(abortDraw);
  function toggleLaser() {
    state._laserMode = !state._laserMode;
    document.body.classList.toggle("laser-mode", state._laserMode);
    if (!state._laserMode) finalizeDraw();
  }

  // src/ts/presenter/navigation.ts
  function gotoId(id) {
    const idx = state.slides.findIndex((s2) => s2.id === id);
    if (idx < 0) return false;
    history.pushState(null, "", window.location.href);
    state.slideIndex = idx;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
    return true;
  }
  function advance() {
    const runDir = inflightStepDirection();
    if (runDir === "forward") {
      snapStepRun();
      sendSnap();
      return;
    }
    if (runDir === "backward") {
      if (reverseStepRun()) {
        renderPvNext();
        updatePvInfo();
        sendNav();
      } else {
        snapStepRun();
        sendSnap();
      }
      return;
    }
    if (inflightDirection() === "forward") {
      snapInflight();
      sendSnap();
      return;
    }
    if (state.step < maxStep2()) {
      state.step++;
      applyCurrentStep();
      renderPvNext();
      updatePvInfo();
    } else if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide(null, null, true);
      renderPv();
    }
    sendNav();
  }
  function retreat() {
    const runDir = inflightStepDirection();
    if (runDir === "backward") {
      snapStepRun();
      sendSnap();
      return;
    }
    if (runDir === "forward") {
      if (reverseStepRun()) {
        renderPvNext();
        updatePvInfo();
        sendNav();
      } else {
        snapStepRun();
        sendSnap();
      }
      return;
    }
    if (inflightDirection() === "backward") {
      snapInflight();
      sendSnap();
      return;
    }
    if (state.step > 0) {
      state.step--;
      applyCurrentStep();
      renderPvNext();
      updatePvInfo();
    } else if (state.slideIndex > 0) {
      const t2 = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = maxStep2();
      const tReversed = t2 ? { ...t2, reverse: true } : null;
      loadSlide(null, tReversed);
      renderPv();
      sendNav(tReversed);
      return;
    }
    sendNav();
  }
  function nextSlide() {
    if (state.slideIndex < state.slides.length - 1) {
      state.slideIndex++;
      state.step = 0;
      loadSlide(null, null, true);
      renderPv();
    }
    sendNav();
  }
  function prevSlide() {
    if (state.slideIndex > 0) {
      const t2 = state.transitions[state.slideIndex];
      state.slideIndex--;
      state.step = maxStep2();
      const tReversed = t2 ? { ...t2, reverse: true } : null;
      loadSlide(null, tReversed);
      renderPv();
      sendNav(tReversed);
      return;
    }
    sendNav();
  }
  function gotoFirst() {
    history.pushState(null, "", window.location.href);
    state.slideIndex = 0;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }
  function gotoLast() {
    history.pushState(null, "", window.location.href);
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }

  // src/ts/shared/escape.ts
  function escapeHtml(s2) {
    return s2.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // src/ts/presenter/overview.ts
  var overview = document.getElementById("overview");
  var overviewGrid = document.getElementById("overview-grid");
  var stage5 = document.getElementById("stage");
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  function firstSlideViewBox() {
    const svg = state.slides[0]?.svg ?? "";
    const attr = svg.match(/viewBox="([^"]*)"/)?.[1] ?? null;
    const vb = parseViewBox(attr);
    return [vb.w, vb.h];
  }
  function scaleThumb(thumb) {
    const svg = thumb.querySelector("svg");
    if (!svg) return;
    const vb = parseViewBox(svg.getAttribute("viewBox"));
    svg.setAttribute("width", String(vb.w));
    svg.setAttribute("height", String(vb.h));
    svg.style.width = `${vb.w}px`;
    svg.style.height = `${vb.h}px`;
    const scale = Math.min(thumb.clientWidth / vb.w, thumb.clientHeight / vb.h);
    const dx = (thumb.clientWidth - vb.w * scale) / 2;
    const dy = (thumb.clientHeight - vb.h * scale) / 2;
    svg.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  }
  function cellAt(i2) {
    return overviewGrid.querySelector(
      `.overview-cell[data-index="${i2}"]`
    );
  }
  function computeCols() {
    const cols = getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length;
    state._overviewCols = cols || 1;
  }
  function applyOptimalCols() {
    const n2 = state.slides.length;
    const gap = parseFloat(getComputedStyle(overviewGrid).gap) || 28;
    const availW = overviewGrid.clientWidth;
    const availH = overview.clientHeight - parseFloat(getComputedStyle(overview).paddingTop) - parseFloat(getComputedStyle(overview).paddingBottom);
    const [vbW, vbH] = firstSlideViewBox();
    const ratio = vbH / vbW;
    const runs = sectionRuns(state.slides);
    const heading = overviewGrid.querySelector(".overview-section");
    const headings = runs.filter((r2) => r2.section).length;
    const headingH = heading ? heading.offsetHeight + gap : 0;
    const most = Math.max(n2, 8);
    let cols = most;
    for (let c2 = 1; c2 <= most; c2++) {
      const thumbW = (availW - (c2 - 1) * gap) / c2;
      const rows = gridRows(runs, c2);
      if (rows * (thumbW * ratio + gap) - gap + headings * headingH <= availH) {
        cols = Math.max(2, c2);
        break;
      }
    }
    overviewGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }
  function overviewSetActive(i2) {
    state._overviewActive = Math.max(0, Math.min(state.slides.length - 1, i2));
    overviewGrid.querySelectorAll(".overview-cell").forEach((el) => {
      el.classList.toggle(
        "active",
        Number(el.dataset.index) === state._overviewActive
      );
    });
    cellAt(state._overviewActive)?.scrollIntoView({ block: "nearest" });
  }
  function overviewMoveVertical(dir) {
    const cells = [
      ...overviewGrid.querySelectorAll(".overview-cell")
    ];
    const boxes = cells.map((el) => ({
      left: el.offsetLeft,
      top: el.offsetTop,
      width: el.offsetWidth
    }));
    const here = cells.findIndex(
      (el) => Number(el.dataset.index) === state._overviewActive
    );
    if (here === -1) return;
    const next = cells[verticalNeighbor(boxes, here, dir)];
    overviewSetActive(Number(next.dataset.index));
  }
  function overviewCommit() {
    history.pushState(null, "", window.location.href);
    state.slideIndex = state._overviewActive;
    closeOverview();
    state.step = maxStep2();
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }
  function computeStageFlip() {
    const activeCell = cellAt(state._overviewActive);
    if (!activeCell) return null;
    const thumb = activeCell.querySelector(".overview-thumb");
    const el = thumb ?? activeCell;
    const gr = overviewGrid.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    const sr = stage5.getBoundingClientRect();
    const sp = parseFloat(getComputedStyle(stage5).paddingLeft) || 0;
    const s2 = Math.min(
      (sr.width - 2 * sp) / cr.width,
      (sr.height - 2 * sp) / cr.height
    );
    const thumbCX = cr.left + cr.width / 2 - gr.left;
    const thumbCY = cr.top + cr.height / 2 - gr.top;
    const stageCX = sr.left + sr.width / 2 - gr.left;
    const stageCY = sr.top + sr.height / 2 - gr.top;
    const ox = (stageCX - thumbCX * s2) / (1 - s2);
    const oy = (stageCY - thumbCY * s2) / (1 - s2);
    return { s: s2, ox, oy };
  }
  var scaleDriver = new ProgressDriver();
  var fadeDriver = new ProgressDriver();
  var controller = null;
  var geometry = null;
  function paintScale(progress) {
    if (!geometry) return;
    const scale = geometry.s + (1 - geometry.s) * progress;
    overviewGrid.style.transformOrigin = `${geometry.ox}px ${geometry.oy}px`;
    overviewGrid.style.transform = `scale(${scale})`;
  }
  function setActiveHighlight(visible, durationSeconds) {
    const activeCell = cellAt(state._overviewActive);
    const thumb = activeCell?.querySelector(".overview-thumb");
    const num = activeCell?.querySelector(".overview-num");
    if (thumb) {
      thumb.style.transition = `outline-color ${durationSeconds}s ease`;
      thumb.style.outlineColor = visible ? "" : "transparent";
    }
    if (num) {
      num.style.transition = `color ${durationSeconds}s ease`;
      num.style.color = visible ? "" : "transparent";
    }
  }
  async function openOverview() {
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    const [vbW, vbH] = firstSlideViewBox();
    overview.style.setProperty("--thumb-ar", `${vbW} / ${vbH}`);
    for (const run of sectionRuns(state.slides)) {
      if (run.section) {
        const head = document.createElement("div");
        head.className = "overview-section";
        head.dataset.index = String(run.start);
        const count = run.end - run.start;
        head.innerHTML = `<span class="overview-section-name">${escapeHtml(run.section.name)}</span><span class="overview-section-count">${count} slide${count === 1 ? "" : "s"}</span>`;
        overviewGrid.appendChild(head);
      }
      for (let i2 = run.start; i2 < run.end; i2++) {
        const cell = document.createElement("div");
        cell.className = "overview-cell";
        cell.dataset.index = String(i2);
        cell.innerHTML = `<div class="overview-num">${i2 + 1}</div><div class="overview-thumb">${state.slides[i2].svg}</div>`;
        overviewGrid.appendChild(cell);
      }
    }
    state._overviewActive = state.slideIndex;
    overviewGrid.querySelectorAll(".overview-thumb").forEach((thumb) => {
      applyStepInstant(thumb, maxStep(thumb));
    });
    await nextFrame();
    applyOptimalCols();
    await nextFrame();
    overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
    computeCols();
    overviewSetActive(state._overviewActive);
    geometry = computeStageFlip();
    const activeCell = cellAt(state._overviewActive);
    const activeThumb = activeCell?.querySelector(".overview-thumb");
    const activeNum = activeCell?.querySelector(".overview-num");
    if (activeThumb) activeThumb.style.outlineColor = "transparent";
    if (activeNum) activeNum.style.color = "transparent";
    scaleDriver.value = 0;
    paintScale(0);
    await nextFrame();
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    overview.classList.add("visible");
    overview.style.opacity = "1";
    fadeDriver.value = 1;
    setActiveHighlight(true, 0.6);
    const ease = cubicBezierEasing("cubic-bezier(0.22, 1, 0.36, 1)");
    await scaleDriver.animateTo(
      1,
      0.6,
      myController.signal,
      (v2) => paintScale(ease(v2))
    );
    if (controller === myController) controller = null;
  }
  async function closeOverview() {
    state._overviewActive = state.slideIndex;
    if (controller === null) geometry = computeStageFlip();
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    const { signal } = myController;
    setActiveHighlight(false, 0.35);
    const ease = cubicBezierEasing("cubic-bezier(0.55, 0, 1, 0.45)");
    await scaleDriver.animateTo(0, 0.35, signal, (v2) => paintScale(ease(v2)));
    if (signal.aborted) return;
    await fadeDriver.animateTo(0, 0.28, signal, (v2) => {
      overview.style.opacity = String(v2);
    });
    if (signal.aborted) return;
    overview.classList.remove("visible");
    overview.style.opacity = "";
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    if (controller === myController) controller = null;
  }
  function toggleOverview() {
    overview.classList.contains("visible") ? closeOverview() : openOverview();
  }
  overview.addEventListener("click", (e2) => {
    const cell = e2.target.closest(
      ".overview-cell, .overview-section"
    );
    if (cell) {
      state._overviewActive = +cell.dataset.index;
      overviewCommit();
    } else if (e2.target === overview) {
      closeOverview();
    }
  });
  window.addEventListener("resize", () => {
    if (!overview.classList.contains("visible")) return;
    applyOptimalCols();
    requestAnimationFrame(() => {
      overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
      computeCols();
    });
  });

  // src/ts/presenter/picker.ts
  var picker = document.getElementById("picker");
  var pickerInput = document.getElementById("picker-input");
  var pickerList = document.getElementById("picker-list");
  function openPicker() {
    picker.classList.add("visible");
    pickerInput.value = "";
    filterPicker("");
    pickerInput.focus();
  }
  function closePicker() {
    picker.classList.remove("visible");
  }
  function fuzzy(text, q) {
    let ti = 0;
    for (let qi = 0; qi < q.length; qi++) {
      ti = text.indexOf(q[qi], ti);
      if (ti === -1) return false;
      ti++;
    }
    return true;
  }
  function filterPicker(query) {
    const q = query.trim();
    let matches;
    const sectionRows = /* @__PURE__ */ new Map();
    if (q === "") {
      matches = state.slides.map((_2, i2) => i2);
    } else if (/^\d+$/.test(q)) {
      matches = state.slides.reduce((acc, _2, i2) => {
        if (String(i2 + 1).startsWith(q)) acc.push(i2);
        return acc;
      }, []);
    } else {
      const lq = q.toLowerCase();
      matches = [];
      for (const run of sectionRuns(state.slides)) {
        if (run.section && fuzzy(run.section.name.toLowerCase(), lq)) {
          sectionRows.set(matches.length, run.section.name);
          matches.push(run.start);
        }
      }
      state.slides.forEach((s2, i2) => {
        if (fuzzy((s2.title || "").toLowerCase(), lq)) matches.push(i2);
      });
    }
    state._pickerMatches = matches;
    state._pickerActive = 0;
    pickerList.innerHTML = matches.map((idx, pos) => {
      const active3 = pos === 0 ? " active" : "";
      const section = sectionRows.get(pos);
      if (section != null) {
        return `<div role="option" data-pos="${pos}" class="pk-section-row${active3}"><span class="pk-num">\xA7</span><span class="pk-title">${escapeHtml(section)}</span><span class="pk-section">section \xB7 ${idx + 1}</span></div>`;
      }
      const name = state.slides[idx].section?.name;
      return `<div role="option" data-pos="${pos}" class="${active3.trim()}"><span class="pk-num">${idx + 1}</span><span class="pk-title">${escapeHtml(state.slides[idx].title || "")}</span>` + (name ? `<span class="pk-section">${escapeHtml(name)}</span>` : "") + "</div>";
    }).join("");
    const active2 = pickerList.querySelector('[role="option"].active');
    if (active2) active2.scrollIntoView({ block: "nearest" });
  }
  function pickerMoveCursor(delta) {
    if (!state._pickerMatches.length) return;
    state._pickerActive = Math.max(
      0,
      Math.min(state._pickerMatches.length - 1, state._pickerActive + delta)
    );
    pickerList.querySelectorAll('[role="option"]').forEach((opt, i2) => {
      opt.classList.toggle("active", i2 === state._pickerActive);
    });
    const active2 = pickerList.querySelector('[role="option"].active');
    if (active2) active2.scrollIntoView({ block: "nearest" });
  }
  function pickerCommit() {
    if (!state._pickerMatches.length) return;
    history.pushState(null, "", window.location.href);
    state.slideIndex = state._pickerMatches[state._pickerActive];
    closePicker();
    state.step = maxStep2();
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
  }
  pickerInput.addEventListener("input", () => filterPicker(pickerInput.value));
  pickerInput.addEventListener("keydown", (e2) => {
    const down = e2.key === "ArrowDown" || e2.key === "Tab" && !e2.shiftKey || e2.key === "j" && e2.ctrlKey;
    const up = e2.key === "ArrowUp" || e2.key === "Tab" && e2.shiftKey || e2.key === "k" && e2.ctrlKey;
    if (down) {
      e2.preventDefault();
      pickerMoveCursor(1);
    } else if (up) {
      e2.preventDefault();
      pickerMoveCursor(-1);
    } else if (e2.key === "Enter") {
      e2.preventDefault();
      pickerCommit();
    } else if (e2.key === "Escape") {
      closePicker();
    }
  });
  pickerList.addEventListener("click", (e2) => {
    const opt = e2.target.closest('[role="option"]');
    if (!opt) return;
    const pos = parseInt(opt.dataset.pos, 10);
    state._pickerActive = pos;
    pickerCommit();
  });
  picker.addEventListener("click", (e2) => {
    if (e2.target === picker) closePicker();
  });

  // src/ts/presenter/keyboard.ts
  var stageEl = document.getElementById("stage");
  var isCoarse = () => window.matchMedia("(pointer: coarse)").matches;
  stageEl.addEventListener("click", (e2) => {
    const slideLink = e2.target.closest?.("[data-inkflow-slide]");
    if (slideLink) {
      gotoId(slideLink.getAttribute("data-inkflow-slide") ?? "");
      return;
    }
    if (e2.target.closest?.("a[href]")) return;
    if (isCoarse()) {
      const ratio = e2.clientX / window.innerWidth;
      if (ratio < 0.2) retreat();
      else if (ratio > 0.8) advance();
      else toggleMobileHud();
    } else {
      advance();
    }
  });
  document.getElementById("btn-prev").addEventListener("click", retreat);
  document.getElementById("btn-next").addEventListener("click", advance);
  document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-overview").addEventListener("click", toggleOverview);
  document.getElementById("btn-presenter").addEventListener("click", togglePv);
  document.getElementById("btn-ink").addEventListener("click", switchInk);
  function switchInk() {
    if (!inkActive() && state._laserMode) toggleLaser();
    toggleInk();
  }
  function switchLaser() {
    if (!state._laserMode && inkActive()) toggleInk();
    toggleLaser();
  }
  document.getElementById("mhud-theme").addEventListener("click", toggleTheme);
  document.getElementById("mhud-fullscreen").addEventListener("click", toggleFullscreen);
  {
    const SWIPE_MIN_PX = 50;
    let startX = 0;
    let startY = 0;
    stageEl.addEventListener(
      "touchstart",
      (e2) => {
        if (e2.touches.length !== 1) return;
        startX = e2.touches[0].clientX;
        startY = e2.touches[0].clientY;
      },
      { passive: true }
    );
    stageEl.addEventListener(
      "touchmove",
      (e2) => {
        if (e2.touches.length !== 1) return;
        const dx = e2.touches[0].clientX - startX;
        const dy = e2.touches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy)) e2.preventDefault();
      },
      { passive: false }
    );
    stageEl.addEventListener("touchend", (e2) => {
      if (e2.changedTouches.length !== 1 || multiTouch()) return;
      const dx = e2.changedTouches[0].clientX - startX;
      const dy = e2.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
        e2.preventDefault();
        if (dx < 0) nextSlide();
        else prevSlide();
      }
    });
  }
  var KEYBINDINGS = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    PageDown: { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    PageUp: { action: retreat, preventDefault: true },
    h: { action: retreat, preventDefault: true },
    ArrowDown: { action: nextSlide, preventDefault: true },
    j: { action: nextSlide, preventDefault: true },
    ArrowUp: { action: prevSlide, preventDefault: true },
    k: { action: prevSlide, preventDefault: true },
    Home: { action: gotoFirst },
    "^": { action: gotoFirst },
    End: { action: gotoLast },
    $: { action: gotoLast },
    g: { action: openPicker, preventDefault: true },
    o: { action: toggleOverview, preventDefault: true },
    e: { action: toggleMenu },
    E: { action: backToEditor },
    f: { action: toggleFullscreen },
    b: { action: () => toggleCurtain("black") },
    ".": { action: switchLaser },
    i: { action: switchInk },
    w: { action: () => toggleCurtain("white") },
    "+": { action: () => keyZoom("in") },
    "=": { action: () => keyZoom("in") },
    "-": { action: () => keyZoom("out") },
    _: { action: () => keyZoom("out") },
    "0": { action: smoothResetCamera },
    // Only reached when no modal above claimed Escape; a no-op unless zoomed in.
    Escape: { action: smoothResetCamera },
    "?": { action: toggleHelp },
    t: { action: toggleTheme },
    p: { action: togglePv },
    d: { action: toggleLogs },
    m: { action: toggleNotifyHistory },
    n: { action: openSyncedWindow },
    s: { action: cycleSyncMode }
  };
  var helpEl = document.getElementById("help");
  var overviewEl3 = document.getElementById("overview");
  var pickerEl = document.getElementById("picker");
  var curtainEl = document.getElementById("curtain");
  var logBannerEl = document.getElementById("log-banner");
  var notifyHistoryEl2 = document.getElementById("notify-history");
  var editMenuEl = document.getElementById("edit-menu");
  document.addEventListener("keydown", (e2) => {
    if (helpEl.classList.contains("visible")) {
      if (e2.key === "?" || e2.key === "Escape" || e2.key === "q") {
        toggleHelp();
        return;
      }
      if (e2.key !== "t") return;
    }
    if (notifyHistoryEl2.classList.contains("visible")) {
      if (e2.key === "Escape" || e2.key === "q" || e2.key === "m") {
        toggleNotifyHistory();
      }
      return;
    }
    if (editMenuEl.classList.contains("open")) {
      if (e2.key === "Escape" || e2.key === "q" || e2.key === "e") {
        closeMenu();
        return;
      }
      if (e2.key === "ArrowDown" || e2.key === "j") {
        e2.preventDefault();
        editMenuSetActive(state._editActive + 1);
        return;
      }
      if (e2.key === "ArrowUp" || e2.key === "k") {
        e2.preventDefault();
        editMenuSetActive(state._editActive - 1);
        return;
      }
      if (e2.key === "Enter") {
        e2.preventDefault();
        editMenuCommit();
        return;
      }
      return;
    }
    if (overviewEl3.classList.contains("visible")) {
      if (e2.key === "Escape" || e2.key === "q") {
        closeOverview();
        return;
      }
      if (e2.key === "ArrowRight" || e2.key === "l") {
        e2.preventDefault();
        overviewSetActive(state._overviewActive + 1);
        return;
      }
      if (e2.key === "ArrowLeft" || e2.key === "h") {
        e2.preventDefault();
        overviewSetActive(state._overviewActive - 1);
        return;
      }
      if (e2.key === "ArrowDown" || e2.key === "j") {
        e2.preventDefault();
        overviewMoveVertical(1);
        return;
      }
      if (e2.key === "ArrowUp" || e2.key === "k") {
        e2.preventDefault();
        overviewMoveVertical(-1);
        return;
      }
      if (e2.key === "Enter") {
        e2.preventDefault();
        overviewCommit();
        return;
      }
      if (e2.key === "o") {
        toggleOverview();
        return;
      }
      if (e2.key !== "t" && e2.key !== "?") return;
    }
    if (pickerEl.classList.contains("visible")) return;
    if (curtainEl.classList.contains("visible")) {
      hideCurtain();
      return;
    }
    if ((e2.key === "Escape" || e2.key === "q") && logBannerEl.classList.contains("visible")) {
      hideLogs();
      return;
    }
    if (inkKey(e2)) return;
    const binding = KEYBINDINGS[e2.key];
    if (binding) {
      if (binding.preventDefault) e2.preventDefault();
      binding.action();
    }
  });

  // src/ts/presenter/main.ts
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var INITIAL_TRANSITIONS = __TRANSITIONS_JSON__;
  var WS_PORT = __WS_PORT__;
  var EDIT_COMMANDS = __EDIT_COMMANDS_JSON__;
  var INITIAL_ERROR = __ERROR_JSON__;
  var INITIAL_LOGS = __LOGS_JSON__;
  state.slides = INITIAL_SLIDES;
  state.transitions = INITIAL_TRANSITIONS;
  window.inkflow = {
    registerTransition,
    registerProgressTransition,
    setSyncMode
  };
  window.addEventListener("popstate", () => {
    readURL();
    loadSlide(null, CUT);
    renderPv();
  });
  loadSyncMode();
  initSyncMenu();
  initWindowSync(WS_PORT);
  initEditMenu(EDIT_COMMANDS, WS_PORT);
  initToEditor(WS_PORT);
  initInk(WS_PORT, sendInk);
  var deepLinked = readURL();
  loadSlide();
  renderPv();
  updatePvClock();
  setInterval(updatePvClock, 1e3);
  if (INITIAL_ERROR) showError(INITIAL_ERROR);
  if (INITIAL_LOGS.length) showLogs(INITIAL_LOGS);
  connectWS(WS_PORT, deepLinked);
})();
