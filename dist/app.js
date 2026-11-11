/* ============================================================
   POS Desktop Client — frontend logic
   Vanilla ES2020 · no build step · no external dependencies.
   Talks to the Actix-web REST API at `${apiBase}/api/v1`
   with JWT bearer authentication. Fully offline UI (no CDNs).
   ============================================================ */
"use strict";

/* ============================================================
   1. Small generic helpers
   ============================================================ */

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* rust_decimal serialises money as JSON strings like "12.50" */
function num(v) {
  var n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}
function fmtQty(v) {
  var n = num(v);
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

function fmtMoney(v) {
  var n = num(v);
  var cur = (state.meta && state.meta.currency) || "$";
  if (/^[A-Za-z]{3}$/.test(cur)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur,
      }).format(n);
    } catch (e) {
      /* fall through */
    }
  }
  var sign = n < 0 ? "-" : "";
  return sign + cur + Math.abs(n).toFixed(2);
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}
function inputToday(offsetDays) {
  var d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
  );
}
function fmtDateTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || "—");
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes())
  );
}
function relTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || "");
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 7) return Math.floor(s / 86400) + "d ago";
  return fmtDateTime(iso);
}

function debounce(fn, ms) {
  var t = null;
  return function () {
    var args = arguments,
      self = this;
    clearTimeout(t);
    t = setTimeout(function () {
      fn.apply(self, args);
    }, ms);
  };
}

function qs(params) {
  var parts = [];
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k];
    if (v === undefined || v === null || v === "") return;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  });
  return parts.length ? "?" + parts.join("&") : "";
}

/* DOM builder: h('div', {class:'x', onClick: fn}, 'text', childNode, ...) */
function h(tag, attrs) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      var val = attrs[key];
      if (val === null || val === undefined || val === false) return;
      if (key.indexOf("on") === 0 && typeof val === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), val);
        return;
      }
      if (key === "class") {
        node.className = val;
        return;
      }
      if (key === "value") {
        node.value = val;
        return;
      }
      if (
        key === "checked" ||
        key === "disabled" ||
        key === "selected" ||
        key === "hidden" ||
        key === "required"
      ) {
        node[key] = !!val;
        return;
      }
      node.setAttribute(key, String(val));
    });
  }
  for (var i = 2; i < arguments.length; i++) {
    var child = arguments[i];
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return node;
}

function itemsOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}
function totalOf(data, items) {
  if (data && typeof data.total === "number") return data.total;
  return (items || []).length;
}
function storeName(id) {
  var s = (state.stores || []).find(function (x) {
    return String(x.id) === String(id);
  });
  if (s) return s.name + (s.code ? " (" + s.code + ")" : "");
  return id != null && id !== "" ? "#" + id : "—";
}
function errorBox(err) {
  return h(
    "div",
    { class: "empty error" },
    err && err.message ? err.message : "Something went wrong.",
  );
}

/* ============================================================
   2. State & persistence
   ============================================================ */

var LS_AUTH = "backpos_auth";
var LS_API = "backpos_api_base";
var API_PREFIX = "/api/v1";
var ROLES = ["ADMIN", "MANAGER", "INVENTORY_MANAGER", "CASHIER", "SUPPLIER"];

var state = {
  apiBase: "http://127.0.0.1:8080",
  storeName: "POS Desktop Client",
  token: null,
  refreshToken: null,
  user: null,
  meta: null, // {store_name, currency, default_tax_rate, receipt_prefix}
  stores: [],
  storeId: null, // active store id (number)
  section: null, // current nav key
  cart: [], // POS cart lines
  posDiscount: 0, // sale-level absolute discount
  notifTimer: null,
  posProducts: {}, // id -> product map for the current POS tile set
  posCustomerId: null, // customer attached to the current sale (uuid)
  posCustomerName: null, // display name of the attached customer
};

function loadAuth() {
  try {
    var raw = localStorage.getItem(LS_AUTH);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveAuth() {
  try {
    if (state.token) {
      localStorage.setItem(
        LS_AUTH,
        JSON.stringify({
          access_token: state.token,
          refresh_token: state.refreshToken,
          user: state.user,
        }),
      );
    } else {
      localStorage.removeItem(LS_AUTH);
    }
  } catch (e) {
    /* storage unavailable */
  }
}
function clearAuth() {
  state.token = null;
  state.refreshToken = null;
  state.user = null;
  try {
    localStorage.removeItem(LS_AUTH);
  } catch (e) {
    /* noop */
  }
}
function role() {
  return state.user && state.user.role ? state.user.role : "";
}
function isStaff() {
  return role() === "ADMIN" || role() === "MANAGER";
}
function saveApiBase(v) {
  try {
    localStorage.setItem(LS_API, v);
  } catch (e) {
    /* noop */
  }
}

/* ============================================================
   3. Startup configuration (Tauri get_config / fallbacks)
   ============================================================ */

async function loadConfig() {
  var base = null,
    name = null;
  try {
    var t = window.__TAURI__;
    var invoke = null;
    if (t) {
      if (t.core && typeof t.core.invoke === "function") invoke = t.core.invoke;
      else if (typeof t.invoke === "function") invoke = t.invoke;
    }
    if (invoke) {
      var cfg = await invoke("get_config");
      if (cfg) {
        base = cfg.apiBaseUrl || cfg.api_base_url || null;
        name = cfg.storeName || cfg.store_name || null;
      }
    }
  } catch (e) {
    /* not inside Tauri — fall back below */
  }

  try {
    var params = new URLSearchParams(window.location.search);
    if (!base && params.get("api")) base = params.get("api");
  } catch (e) {
    /* noop */
  }

  if (!base) {
    try {
      base = localStorage.getItem(LS_API) || null;
    } catch (e) {
      /* noop */
    }
  }
  if (!base) base = "http://127.0.0.1:8080";

  state.apiBase = String(base).replace(/\/+$/, "");
  if (name) state.storeName = name;
  saveApiBase(state.apiBase);
}

/* ============================================================
   4. API layer (JWT bearer, auto-refresh once on 401)
   ============================================================ */

function apiError(message, status) {
  var e = new Error(message);
  e.status = status;
  return e;
}

async function apiFetch(path, opts) {
  opts = opts || {};
  var method = opts.method || "GET";
  var auth = opts.auth !== false;
  var headers = { Accept: "application/json" };
  var body;
  if (opts.body !== undefined && opts.body !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (auth && state.token) headers["Authorization"] = "Bearer " + state.token;

  var resp,
    data = null;
  try {
    resp = await fetch(state.apiBase + API_PREFIX + path, {
      method: method,
      headers: headers,
      body: body,
    });
  } catch (err) {
    throw apiError(
      "Cannot reach the backend at " +
        state.apiBase +
        ". Make sure the API server is running.",
      0,
    );
  }

  try {
    var text = await resp.text();
    if (text) data = JSON.parse(text);
  } catch (e) {
    data = null;
  }

  if (resp.ok) return data;

  var message =
    (data && (data.error || data.message)) ||
    "Request failed (HTTP " + resp.status + ")";
  if (resp.status === 401 && auth && !opts._retried) {
    var refreshed = await tryRefresh();
    if (refreshed)
      return apiFetch(path, Object.assign({}, opts, { _retried: true }));
    logout("Your session expired. Please sign in again.");
    throw apiError("Session expired", 401);
  }
  throw apiError(message, resp.status);
}

async function tryRefresh() {
  if (!state.refreshToken) return false;
  try {
    var data = await apiFetch("/auth/refresh", {
      method: "POST",
      auth: false,
      body: { refresh_token: state.refreshToken },
    });
    if (data && data.access_token) {
      state.token = data.access_token;
      state.refreshToken = data.refresh_token || state.refreshToken;
      saveAuth();
      return true;
    }
  } catch (e) {
    /* fall through */
  }
  return false;
}

/* ============================================================
   5. Toast / modal / confirm helpers
   ============================================================ */

function toast(kind, message) {
  var wrap = $("#toast");
  if (!wrap) {
    window.alert(message);
    return;
  }
  var item = h(
    "div",
    { class: "toast-item toast-" + kind },
    String(message || ""),
  );
  wrap.appendChild(item);
  setTimeout(
    function () {
      item.classList.add("out");
      setTimeout(function () {
        if (item.parentNode) item.remove();
      }, 260);
    },
    kind === "error" ? 5500 : 3200,
  );
}
function toastError(err) {
  toast("error", err && err.message ? err.message : "Something went wrong");
}

/* openModal({title, bodyNode | bodyHTML, footer?, wide?}) → {body, foot, close} */
function openModal(opts) {
  var root = $("#modal-root");
  var overlay = h("div", { class: "modal-overlay" });
  var dialog = h("div", { class: "modal" + (opts.wide ? " wide" : "") });
  var closed = false;
  function keyHandler(ev) {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", keyHandler);
    if (overlay.parentNode) overlay.remove();
  }
  document.addEventListener("keydown", keyHandler);
  overlay.addEventListener("mousedown", function (ev) {
    if (ev.target === overlay) close();
  });

  dialog.appendChild(
    h(
      "div",
      { class: "modal-head" },
      h("h3", { class: "modal-title" }, opts.title || ""),
      h(
        "button",
        { class: "modal-close", title: "Close", onClick: close },
        "✕",
      ),
    ),
  );
  var body = h("div", { class: "modal-body" });
  if (opts.bodyNode) body.appendChild(opts.bodyNode);
  else if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;
  dialog.appendChild(body);
  var foot = null;
  if (opts.footer) {
    foot = h("div", { class: "modal-foot" });
    dialog.appendChild(foot);
  }
  overlay.appendChild(dialog);
  root.appendChild(overlay);
  return { body: body, foot: foot, close: close };
}

function confirmDialog(opts) {
  return new Promise(function (resolve) {
    var m = openModal({ title: opts.title || "Please confirm", footer: true });
    m.body.appendChild(
      h("p", { class: "confirm-msg" }, opts.message || "Are you sure?"),
    );
    var ok = h(
      "button",
      { class: "btn " + (opts.danger ? "danger" : "primary") },
      opts.okLabel || "Confirm",
    );
    var cancel = h("button", { class: "btn ghost" }, "Cancel");
    ok.addEventListener("click", function () {
      m.close();
      resolve(true);
    });
    cancel.addEventListener("click", function () {
      m.close();
      resolve(false);
    });
    m.foot.appendChild(cancel);
    m.foot.appendChild(ok);
    ok.focus();
  });
}

/* Reason prompt (void / refund). Resolves with a string or null. */
function promptReason(opts) {
  return new Promise(function (resolve) {
    var m = openModal({ title: opts.title || "Reason required", footer: true });
    var area = h("textarea", {
      class: "textarea input",
      rows: "3",
      placeholder: opts.placeholder || "Describe the reason (required)",
    });
    var err = h(
      "div",
      { class: "field-error", hidden: true },
      "Please enter a reason.",
    );
    m.body.appendChild(
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, opts.prompt || "Reason"),
        area,
        err,
      ),
    );
    var ok = h(
      "button",
      { class: "btn " + (opts.danger ? "danger" : "primary") },
      opts.okLabel || "Confirm",
    );
    var cancel = h("button", { class: "btn ghost" }, "Cancel");
    function submit() {
      var v = area.value.trim();
      if (!v) {
        err.hidden = false;
        area.focus();
        return;
      }
      m.close();
      resolve(v);
    }
    ok.addEventListener("click", submit);
    area.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        submit();
      }
    });
    cancel.addEventListener("click", function () {
      m.close();
      resolve(null);
    });
    m.foot.appendChild(cancel);
    m.foot.appendChild(ok);
    area.focus();
  });
}

/* Status / role badges */
function stClass(s) {
  var v = String(s || "").toUpperCase();
  if (!v) return "st-muted";
  if (/COMPLET|PAID|SUCCESS|ACTIVE|APPROVED|RECEIVED/.test(v))
    return "st-success";
  if (/VOID|CANCEL|FAIL|SUSPEND/.test(v)) return "st-danger";
  if (/REFUND|PENDING|SUBMITTED|LOW/.test(v)) return "st-warning";
  if (/DRAFT|INACTIVE/.test(v)) return "st-muted";
  return "st-info";
}
function stBadge(s) {
  return '<span class="badge ' + stClass(s) + '">' + esc(s || "—") + "</span>";
}
function badgeNode(s) {
  var sp = h("span", { class: "badge " + stClass(s) });
  sp.textContent = s || "—";
  return sp;
}
function roleBadgeHTML(r) {
  var v = String(r || "");
  return (
    '<span class="badge role-' +
    esc(v.toLowerCase()) +
    '">' +
    esc(v || "—") +
    "</span>"
  );
}

/* ============================================================
   6. Navigation map (role-gated)
   ============================================================ */

var NAV = [
  {
    key: "pos",
    label: "Point of Sale",
    icon: "🛒",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER", "CASHIER"],
  },
  {
    key: "transactions",
    label: "Transactions",
    icon: "🧾",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER", "CASHIER"],
  },
  {
    key: "products",
    label: "Products",
    icon: "📦",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER"],
  },
  {
    key: "categories",
    label: "Categories",
    icon: "🗂️",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER"],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: "🏬",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER"],
  },
  {
    key: "purchases",
    label: "Purchase Orders",
    icon: "🚚",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER", "SUPPLIER"],
  },
  { key: "deliveries", label: "Deliveries", icon: "📨", roles: ["SUPPLIER"] },
  {
    key: "suppliers",
    label: "Suppliers",
    icon: "🤝",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER"],
  },
  {
    key: "customers",
    label: "Customers",
    icon: "👥",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER", "CASHIER"],
  },
  {
    key: "reports",
    label: "Reports",
    icon: "📈",
    roles: ["ADMIN", "MANAGER", "INVENTORY_MANAGER"],
  },
  { key: "users", label: "Users", icon: "🛡️", roles: ["ADMIN", "MANAGER"] },
  { key: "notifications", label: "Notifications", icon: "🔔", roles: ROLES },
];

var SCREENS = {
  pos: renderPos,
  transactions: renderTransactions,
  products: renderProducts,
  categories: renderCategories,
  inventory: renderInventory,
  purchases: renderPurchases,
  deliveries: renderDeliveries,
  suppliers: renderSuppliers,
  customers: renderCustomers,
  reports: renderReports,
  users: renderUsers,
  notifications: renderNotifications,
};

function defaultSection() {
  var allowed = NAV.filter(function (n) {
    return n.roles.indexOf(role()) !== -1;
  });
  var pref =
    role() === "SUPPLIER"
      ? "purchases"
      : role() === "INVENTORY_MANAGER"
        ? "inventory"
        : "pos";
  if (
    !allowed.some(function (n) {
      return n.key === pref;
    })
  )
    pref = allowed.length ? allowed[0].key : "notifications";
  return pref;
}

function renderNav() {
  var nav = $("#nav");
  if (!nav) return;
  nav.innerHTML = "";
  NAV.forEach(function (item) {
    if (item.roles.indexOf(role()) === -1) return;
    nav.appendChild(
      h(
        "button",
        {
          type: "button",
          class: "nav-item" + (state.section === item.key ? " active" : ""),
          onClick: function () {
            navigate(item.key);
          },
        },
        h("span", { class: "nav-ic" }, item.icon),
        h("span", { class: "nav-label" }, item.label),
      ),
    );
  });
}

function navigate(section) {
  var allowed = NAV.some(function (n) {
    return n.key === section && n.roles.indexOf(role()) !== -1;
  });
  if (!allowed) section = defaultSection();
  state.section = section;
  renderNav();
  var item = NAV.find(function (n) {
    return n.key === section;
  });
  var title = $("#screen-title");
  if (title) title.textContent = item ? item.label : "BackPOS";
  var content = $("#content");
  if (!content) return;
  content.innerHTML = '<div class="loading">Loading…</div>';
  var fn = SCREENS[section] || SCREENS.notifications;
  Promise.resolve(fn(content)).catch(function (err) {
    if (err && err.status === 401 && !state.token)
      return; /* logged out mid-flight */
    content.innerHTML = "";
    var box = h("div", { class: "panel" });
    box.appendChild(errorBox(err));
    box.appendChild(
      h(
        "button",
        {
          class: "btn primary",
          onClick: function () {
            navigate(section);
          },
        },
        "Retry",
      ),
    );
    content.appendChild(box);
  });
}

/* ============================================================
   7. Login view (Password + PIN keypad tabs)
   ============================================================ */

function showLogin(notice) {
  stopNotifPolling();
  var appView = $("#app-view");
  appView.hidden = true;
  appView.innerHTML = "";
  var view = $("#login-view");
  view.hidden = false;
  view.innerHTML = "";

  var wrap = h("div", { class: "login-wrap" });
  var card = h("div", { class: "login-card" });
  wrap.appendChild(card);
  view.appendChild(wrap);
  if (notice) toast("error", notice);

  card.appendChild(
    h(
      "div",
      { class: "login-brand" },
      h("span", { class: "brand-mark" }, "B"),
      h(
        "div",
        {},
        h("div", { class: "brand-name" }, "BackPOS"),
        h("div", { class: "login-sub" }, state.storeName),
      ),
    ),
  );

  var tabs = h("div", { class: "login-tabs" });
  var tabPass = h(
    "button",
    { type: "button", class: "tab active" },
    "Password",
  );
  var tabPin = h("button", { type: "button", class: "tab" }, "PIN login");
  tabs.appendChild(tabPass);
  tabs.appendChild(tabPin);
  card.appendChild(tabs);

  var pane = h("div", {});
  card.appendChild(pane);

  card.appendChild(
    h(
      "div",
      { class: "login-api" },
      h("label", { class: "label" }, "API server"),
      h("input", {
        class: "input",
        value: state.apiBase,
        placeholder: "http://127.0.0.1:8080",
      }),
    ),
  );
  var apiInput = card.querySelector(".login-api .input");
  apiInput.addEventListener("change", function () {
    var v = apiInput.value.trim().replace(/\/+$/, "");
    if (v && v !== state.apiBase) {
      state.apiBase = v;
      saveApiBase(v);
      toast("info", "API server updated: " + v);
    }
  });

  function setMode(pinMode) {
    tabPass.classList.toggle("active", !pinMode);
    tabPin.classList.toggle("active", pinMode);
    pane.innerHTML = "";
    pane.appendChild(pinMode ? buildPinPane() : buildPasswordPane());
  }
  tabPass.addEventListener("click", function () {
    setMode(false);
  });
  tabPin.addEventListener("click", function () {
    setMode(true);
  });
  pane.appendChild(buildPasswordPane());

  function buildPasswordPane() {
    var email = h("input", {
      class: "input",
      type: "email",
      autocomplete: "username",
      placeholder: "you@store.com",
    });
    var pass = h("input", {
      class: "input",
      type: "password",
      autocomplete: "current-password",
      placeholder: "••••••••",
    });
    var submit = h(
      "button",
      { type: "button", class: "btn primary block" },
      "Sign in",
    );
    submit.addEventListener("click", function () {
      if (!email.value.trim() || !pass.value) {
        toast("error", "Enter your email and password.");
        return;
      }
      submit.disabled = true;
      submit.textContent = "Signing in…";
      apiFetch("/auth/login", {
        method: "POST",
        auth: false,
        body: { email: email.value.trim(), password: pass.value },
      })
        .then(function (data) {
          adoptAuth(data);
        })
        .catch(function (err) {
          toastError(err);
          submit.disabled = false;
          submit.textContent = "Sign in";
        });
    });
    pass.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") submit.click();
    });
    email.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") pass.focus();
    });
    return h(
      "div",
      {},
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Email"),
        email,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Password"),
        pass,
      ),
      h(
        "div",
        { class: "field" },
        submit,
        h(
          "div",
          { class: "hint" },
          "Sign in with email + password, or switch to PIN login.",
        ),
      ),
    );
  }

  function buildPinPane() {
    var pinBuf = "";
    var dots = h("div", { class: "pin-dots" });
    var msg = h("div", { class: "login-hint" }, "Enter your 4–8 digit PIN");

    function renderDots() {
      dots.innerHTML = "";
      for (var i = 0; i < Math.max(4, pinBuf.length); i++) {
        dots.appendChild(
          h("span", {
            class: "pin-dot" + (i < pinBuf.length ? " filled" : ""),
          }),
        );
      }
    }
    function press(k) {
      if (k === "C") {
        pinBuf = "";
        renderDots();
        return;
      }
      if (k === "E") {
        if (pinBuf.length < 4 || pinBuf.length > 8) {
          msg.textContent = "PIN must be 4–8 digits.";
          return;
        }
        apiFetch("/auth/pin", {
          method: "POST",
          auth: false,
          body: { pin: pinBuf },
        })
          .then(function (data) {
            adoptAuth(data);
          })
          .catch(function (err) {
            pinBuf = "";
            renderDots();
            toastError(err);
          });
        return;
      }
      if (pinBuf.length < 8) {
        pinBuf += k;
        renderDots();
        msg.textContent = "Enter your 4–8 digit PIN";
      }
    }
    var pad = h("div", { class: "keypad" });
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "E"].forEach(
      function (k) {
        var cls = "key" + (k === "C" ? " danger" : k === "E" ? " accent" : "");
        pad.appendChild(
          h(
            "button",
            {
              type: "button",
              class: cls,
              onClick: function () {
                press(k);
              },
            },
            k === "C" ? "✕" : k === "E" ? "⏎" : k,
          ),
        );
      },
    );
    renderDots();
    return h("div", {}, dots, pad, msg);
  }
}

function adoptAuth(data) {
  if (!data || !data.access_token) {
    toast("error", "Login response was invalid.");
    return;
  }
  state.token = data.access_token;
  state.refreshToken = data.refresh_token || null;
  state.user = data.user || null;
  saveAuth();
  startApp();
}

function logout(msg) {
  clearAuth();
  stopNotifPolling();
  state.cart = [];
  state.posDiscount = 0;
  state.posCustomerId = null;
  state.posCustomerName = null;
  state.meta = null;
  state.stores = [];
  state.storeId = null;
  state.section = null;
  showLogin(msg || null);
}

/* ============================================================
   8. App shell (sidebar + topbar + content)
   ============================================================ */

async function loadMeta() {
  try {
    var data = await apiFetch("/meta", { auth: false });
    if (data) state.meta = data;
  } catch (e) {
    state.meta = {
      store_name: state.storeName,
      currency: "USD",
      default_tax_rate: 0,
      receipt_prefix: "RCP",
    };
  }
}

async function loadStores() {
  try {
    var data = await apiFetch("/stores");
    state.stores = itemsOf(data) || [];
  } catch (e) {
    state.stores = [];
  }
}

async function startApp() {
  var view = $("#login-view");
  view.hidden = true;
  view.innerHTML = "";
  $("#app-view").hidden = false;
  renderShell();
  await Promise.all([loadMeta(), loadStores()]);
  var own =
    state.user && state.user.store_id != null
      ? String(state.user.store_id)
      : null;
  state.storeId =
    own != null && own !== ""
      ? own
      : (state.stores[0] && state.stores[0].id) || null;
  syncHeaderStore();
  startNotifPolling();
  navigate(defaultSection());
}

function renderShell() {
  var appView = $("#app-view");
  appView.innerHTML = "";

  var storeSel = h("select", {
    id: "header-store",
    class: "select",
    title: "Active store",
    hidden: true,
  });
  storeSel.addEventListener("change", function () {
    state.storeId = storeSel.value || null;
    if (state.section === "pos" && state.cart.length) {
      confirmDialog({
        title: "Switch store",
        message:
          "Changing the active store will clear the current cart. Continue?",
        okLabel: "Switch",
      }).then(function (ok) {
        if (ok) {
          state.cart = [];
          navigate("pos");
        } else syncHeaderStore();
      });
    }
  });

  var bellBtn = h(
    "button",
    {
      id: "bell",
      class: "btn ghost icon-btn bell-btn",
      title: "Notifications",
    },
    "🔔",
    h("span", { id: "bell-badge", class: "bell-badge", hidden: true }, ""),
  );
  bellBtn.addEventListener("click", function () {
    navigate("notifications");
  });

  var topbar = h(
    "header",
    { class: "topbar" },
    h("div", {}, h("h1", { id: "screen-title" }, "BackPOS")),
    h(
      "div",
      { class: "topbar-right" },
      storeSel,
      bellBtn,
      h(
        "div",
        { class: "user-chip" },
        h(
          "span",
          { class: "user-name" },
          (state.user && state.user.name) || "User",
        ),
        h(
          "span",
          { class: "badge role-" + esc(String(role()).toLowerCase()) },
          role() || "—",
        ),
      ),
      h("button", { id: "logout-btn", class: "btn ghost small" }, "Sign out"),
    ),
  );

  var sidebar = h(
    "aside",
    { class: "sidebar" },
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark" }, "B"),
      h("span", { class: "brand-name" }, "BackPOS"),
    ),
    h("nav", { id: "nav", class: "nav" }),
    h("div", { class: "sidebar-foot" }, "BackPOS Desktop v0.1.0"),
  );

  var shell = h(
    "div",
    { class: "shell" },
    sidebar,
    h(
      "div",
      { class: "app-main" },
      topbar,
      h("main", { id: "content", class: "content" }),
    ),
  );
  appView.appendChild(shell);

  $("#logout-btn").addEventListener("click", function () {
    logout();
  });
  renderNav();
}

function syncHeaderStore() {
  var sel = $("#header-store");
  if (!sel) return;
  var showStore = state.stores.length > 0 && role() !== "SUPPLIER";
  sel.hidden = !showStore;
  if (!showStore) return;
  sel.innerHTML = "";
  state.stores.forEach(function (s) {
    sel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  sel.value = state.storeId != null ? String(state.storeId) : "";
}

/* ============================================================
   9. Product picker (search dropdown for form dialogs)
   ============================================================ */

function attachProductPicker(input, onPick) {
  /* Works for inputs that are still detached (dialog fields are built first). */
  function wire() {
    if (!input.parentNode) return;
    var wrap = h("div", { class: "picker-box" });
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var menu = h("div", { class: "picker-menu", hidden: true });
    wrap.appendChild(menu);

    function hide() {
      menu.hidden = true;
    }
    function renderItems(items) {
      menu.innerHTML = "";
      if (!items.length) {
        hide();
        return;
      }
      items.forEach(function (p) {
        var btn = h(
          "button",
          { type: "button", class: "picker-item" },
          h("span", { class: "picker-name" }, p.name),
          h(
            "span",
            { class: "picker-meta" },
            (p.sku || "") + " · cost " + fmtMoney(p.cost_price),
          ),
        );
        btn.addEventListener("click", function () {
          input.value = p.name + " — " + (p.sku || "");
          hide();
          onPick(p);
        });
        menu.appendChild(btn);
      });
      menu.hidden = false;
    }
    var run = debounce(async function () {
      var q = input.value.trim();
      if (!q) {
        hide();
        return;
      }
      try {
        var data = await apiFetch(
          "/products" + qs({ search: q, per_page: 12 }),
        );
        renderItems(itemsOf(data));
      } catch (err) {
        hide();
      }
    }, 220);

    input.addEventListener("input", run);
    input.addEventListener("focus", function () {
      if (!input.value.trim()) hide();
    });
    input.addEventListener("blur", function () {
      setTimeout(hide, 160);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        var first = menu.querySelector(".picker-item");
        if (first && !menu.hidden) first.click();
      }
    });
  }
  if (input.parentNode) wire();
  else requestAnimationFrame(wire);
}

/* ============================================================
   10. POS screen
   ============================================================ */

function renderPos(content) {
  content.innerHTML = "";
  var layout = h("div", { class: "pos-layout" });
  var left = h("div", { class: "pos-left" });
  var right = h("div", { class: "pos-right" });
  layout.appendChild(left);
  layout.appendChild(right);
  content.appendChild(layout);

  /* --- left column: store selector + scan + product tiles --- */
  var storeSel = h("select", { class: "select" });
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  storeSel.value = state.storeId != null ? String(state.storeId) : "";
  if (!state.stores.length) storeSel.hidden = true;
  storeSel.addEventListener("change", function () {
    var chosen = storeSel.value || null;
    if (chosen === state.storeId) return;
    if (state.cart.length) {
      confirmDialog({
        title: "Switch store",
        message: "Changing the store will clear the current cart. Continue?",
        okLabel: "Switch",
      }).then(function (ok) {
        if (!ok) {
          storeSel.value = state.storeId != null ? String(state.storeId) : "";
          return;
        }
        state.cart = [];
        state.posDiscount = 0;
        state.storeId = chosen;
        syncHeaderStore();
        renderCartLines();
        loadPosTiles(searchInput.value.trim());
      });
    } else {
      state.storeId = chosen;
      syncHeaderStore();
      renderCartLines();
      loadPosTiles(searchInput.value.trim());
    }
  });

  var scanWrap = h("div", { class: "scan-wrap" });
  var scanInput = h("input", {
    class: "input scan-input",
    placeholder: "Scan barcode / type code, then press Enter…",
  });
  scanInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      var code = scanInput.value;
      scanInput.value = "";
      attemptPosScan(code, scanWrap);
    }
  });
  scanWrap.appendChild(scanInput);

  var searchInput = h("input", {
    class: "input",
    placeholder: "Filter products…",
  });
  searchInput.addEventListener(
    "input",
    debounce(function () {
      loadPosTiles(searchInput.value.trim());
    }, 250),
  );

  var tilesGrid = h("div", { class: "tiles" });
  tilesGrid.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".tile");
    if (!btn) return;
    if (btn.classList.contains("out")) {
      toast("error", "That product is out of stock here.");
      return;
    }
    var p = state.posProducts[btn.dataset.id];
    if (p) addToCart(p);
  });

  left.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field grow" },
        h("label", { class: "label" }, "Search"),
        searchInput,
      ),
    ),
  );
  left.appendChild(scanWrap);
  left.appendChild(tilesGrid);

  /* --- right column: cart, totals, payment --- */
  var cartLines = h("div", { class: "cart-slots" });
  var totalsBox = h("div", { class: "totals" });
  var methodSel = h("select", { class: "select" });
  ["CASH", "CARD", "DIGITAL_WALLET"].forEach(function (m) {
    methodSel.appendChild(
      h(
        "option",
        { value: m },
        m === "DIGITAL_WALLET"
          ? "Digital wallet"
          : m.charAt(0) + m.slice(1).toLowerCase(),
      ),
    );
  });
  var tenderedInput = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "0.01",
    placeholder: "Cash tendered",
  });
  var tenderQuick = h("div", { class: "tender-quick" });
  var checkoutBtn = h(
    "button",
    { class: "btn primary block", disabled: true },
    "Charge",
  );

  methodSel.addEventListener("change", function () {
    var cash = methodSel.value === "CASH";
    tenderedInput.hidden = !cash;
    tenderQuick.hidden = !cash;
  });
  tenderedInput.hidden = true;
  tenderQuick.hidden = true;
  [
    ["Exact", null],
    ["+ 5", 5],
    ["+ 10", 10],
    ["+ 20", 20],
    ["+ 50", 50],
    ["+ 100", 100],
  ].forEach(function (pair) {
    var b = h(
      "button",
      { type: "button", class: "btn ghost small quick-btn" },
      pair[0],
    );
    b.addEventListener("click", function () {
      var t = posTotals();
      tenderedInput.value =
        pair[1] == null ? t.grand.toFixed(2) : (t.grand + pair[1]).toFixed(2);
    });
    tenderQuick.appendChild(b);
  });

  var clearBtn = h("button", { class: "btn ghost small" }, "Clear");
  var customerBtn = h(
    "button",
    { class: "btn ghost small" },
    "👤 Attach customer",
  );
  var customerChip = h("span", { class: "customer-chip", hidden: true });
  clearBtn.addEventListener("click", function () {
    if (!state.cart.length) return;
    state.cart = [];
    state.posDiscount = 0;
    renderCartLines();
  });
  customerBtn.addEventListener("click", function () {
    openCustomerPicker();
  });
  checkoutBtn.addEventListener("click", function () {
    checkout();
  });

  right.appendChild(
    h(
      "div",
      { class: "panel cart-panel" },
      h(
        "div",
        { class: "panel-head" },
        h("h3", {}, "Cart"),
        h("div", { class: "cart-head-actions" }, customerBtn, clearBtn),
      ),
      h("div", { class: "cart-customer" }, customerChip),
      cartLines,
      totalsBox,
      h("div", { class: "pay-row" }, methodSel, tenderedInput),
      tenderQuick,
      checkoutBtn,
    ),
  );

  function syncCustomerChip() {
    if (state.posCustomerId) {
      customerChip.hidden = false;
      customerChip.innerHTML = "";
      customerChip.appendChild(
        h(
          "span",
          { class: "cl-name" },
          "👤 " + (state.posCustomerName || "Customer"),
        ),
      );
      var clear = h(
        "button",
        {
          type: "button",
          class: "cl-remove",
          title: "Detach customer",
          onClick: function () {
            state.posCustomerId = null;
            state.posCustomerName = null;
            syncCustomerChip();
          },
        },
        "✕",
      );
      customerChip.appendChild(clear);
    } else {
      customerChip.hidden = true;
      customerChip.innerHTML = "";
    }
  }

  /* Customer search + attach (drives the customer_id field of the sale). */
  function openCustomerPicker() {
    var m = openModal({
      title: "Attach customer",
      footer: true,
    });
    var search = h("input", {
      class: "input",
      placeholder: "Search name / phone / email…",
    });
    var list = h("div", { class: "notif-list" });
    m.body.appendChild(
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Search"),
        search,
      ),
    );
    m.body.appendChild(list);
    m.foot.appendChild(
      h("button", { class: "btn ghost", onClick: m.close }, "Close"),
    );

    function renderList(items) {
      list.innerHTML = "";
      if (!items.length) {
        list.appendChild(h("div", { class: "empty" }, "No customers found."));
        return;
      }
      items.forEach(function (c) {
        var row = h(
          "button",
          { type: "button", class: "picker-item block" },
          h("span", { class: "picker-name" }, c.name),
          h(
            "span",
            { class: "picker-meta" },
            (c.phone || "—") + " · " + num(c.loyalty_points) + " pts",
          ),
        );
        row.addEventListener("click", function () {
          state.posCustomerId = c.id;
          state.posCustomerName = c.name;
          syncCustomerChip();
          m.close();
        });
        list.appendChild(row);
      });
    }
    var run = debounce(async function () {
      try {
        var data = await apiFetch(
          "/customers" +
            qs({ search: search.value.trim() || undefined, per_page: 100 }),
        );
        renderList(itemsOf(data));
      } catch (err) {
        list.innerHTML = "";
        list.appendChild(errorBox(err));
      }
    }, 220);
    search.addEventListener("input", run);
    run();
  }

  /* Discount input lives inside the totals block (re-rendered with totals). */
  /* Totals mirror the backend pricing exactly:
     line_base = round2(price × qty) → per-line discount (clamped to the line)
     → line tax = round2(net × rate / 100) per line
     → grand = round2(subtotal − Σdiscount + Σtax). */
  function posTotals() {
    var lines = state.cart.map(function (l) {
      return { l: l, base: round2(l.unit_price * l.quantity), disc: 0 };
    });
    var subtotal = round2(
      lines.reduce(function (s, x) {
        return s + x.base;
      }, 0),
    );
    var saleDiscount = Math.min(
      Math.max(0, round2(state.posDiscount)),
      subtotal,
    );
    if (saleDiscount > 0 && subtotal > 0) {
      /* spread the sale-level discount across lines, proportional to value */
      var allocated = 0;
      lines.forEach(function (x, i) {
        if (i === lines.length - 1) {
          x.disc = Math.min(x.base, round2(saleDiscount - allocated));
        } else {
          x.disc = Math.min(x.base, round2((saleDiscount * x.base) / subtotal));
          allocated = round2(allocated + x.disc);
        }
      });
    }
    var tax = 0;
    var discount = 0;
    lines.forEach(function (x) {
      var net = round2(x.base - x.disc);
      x.tax = round2((net * num(x.l.tax_rate)) / 100);
      tax = round2(tax + x.tax);
      discount = round2(discount + x.disc);
    });
    return {
      lines: lines,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      grand: round2(subtotal - discount + tax),
    };
  }

  function renderCartLines() {
    var t = posTotals();
    if (!state.cart.length) {
      cartLines.innerHTML =
        '<div class="cart-empty">Cart is empty — scan or tap a product.</div>';
    } else {
      cartLines.innerHTML = state.cart
        .map(function (l, i) {
          var maxed = l.stock != null && l.quantity >= l.stock;
          return (
            '<div class="cart-line">' +
            '<div><div class="cl-name">' +
            esc(l.name) +
            '</div><div class="cl-sku">' +
            esc(l.sku || "") +
            "</div></div>" +
            '<div class="cl-qty">' +
            '<button type="button" class="qty-btn" data-act="dec" data-i="' +
            i +
            '">−</button>' +
            '<span class="cl-qty-val">' +
            fmtQty(l.quantity) +
            "</span>" +
            '<button type="button" class="qty-btn" data-act="inc" data-i="' +
            i +
            '"' +
            (maxed ? " disabled" : "") +
            ">+</button>" +
            "</div>" +
            '<div class="cl-total">' +
            fmtMoney(l.unit_price * l.quantity) +
            "</div>" +
            '<button type="button" class="cl-remove" data-act="rm" data-i="' +
            i +
            '" title="Remove">✕</button>' +
            "</div>"
          );
        })
        .join("");
    }
    renderTotals(t);
  }

  cartLines.addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    var i = Number(btn.dataset.i);
    var l = state.cart[i];
    if (!l) return;
    if (btn.dataset.act === "inc") {
      if (l.stock != null && l.quantity + 1 > l.stock) {
        toast(
          "error",
          "Only " + fmtQty(l.stock) + ' of "' + l.name + '" available.',
        );
        return;
      }
      l.quantity += 1;
    } else if (btn.dataset.act === "dec") {
      l.quantity -= 1;
      if (l.quantity <= 0) state.cart.splice(i, 1);
    } else if (btn.dataset.act === "rm") {
      state.cart.splice(i, 1);
    }
    renderCartLines();
  });

  function renderTotals(t) {
    totalsBox.innerHTML =
      '<div class="t-row"><span>Subtotal</span><span class="t-val">' +
      fmtMoney(t.subtotal) +
      "</span></div>" +
      '<div class="t-row"><span class="t-inline">Discount' +
      '<input id="pos-discount" class="input" type="number" min="0" step="0.01" value="' +
      esc(state.posDiscount || "0") +
      '">' +
      '</span><span class="t-val">− ' +
      fmtMoney(t.discount) +
      "</span></div>" +
      '<div class="t-row"><span>Tax</span><span class="t-val">' +
      fmtMoney(t.tax) +
      "</span></div>" +
      '<div class="t-row grand"><span>Total</span><span class="t-val">' +
      fmtMoney(t.grand) +
      "</span></div>";
    var dIn = $("#pos-discount", totalsBox);
    if (dIn) {
      dIn.addEventListener("input", function () {
        state.posDiscount = Math.max(0, num(dIn.value));
        var tt = posTotals();
        var rows = totalsBox.querySelectorAll(".t-row .t-val");
        if (rows[1]) rows[1].textContent = "− " + fmtMoney(tt.discount);
        if (rows[2]) rows[2].textContent = fmtMoney(tt.tax);
        if (rows[3]) rows[3].textContent = fmtMoney(tt.grand);
        checkoutBtn.textContent = "Charge " + fmtMoney(tt.grand);
      });
    }
    checkoutBtn.disabled = !state.cart.length;
    checkoutBtn.textContent = "Charge " + fmtMoney(t.grand);
  }

  async function checkout() {
    if (!state.cart.length) return;
    var t = posTotals();
    var method = methodSel.value;
    var tendered = method === "CASH" ? round2(num(tenderedInput.value)) : 0;
    var payloadItems = t.lines.map(function (x) {
      var it = { product_id: x.l.product_id, quantity: x.l.quantity };
      if (x.disc > 0)
        it.line_discount = x.disc; /* proportional share of the sale discount */
      return it;
    });
    /* One payment of the exact server-computed grand total: sending
       `payment_method` (instead of an explicit payments array) makes the
       backend record a payment equal to its own grand_total, so a cent of
       rounding difference or over-tendered cash can never 400 the sale. */
    var body = { items: payloadItems, payment_method: method };
    if (state.storeId) body.store_id = String(state.storeId);
    if (state.posCustomerId) body.customer_id = state.posCustomerId;

    checkoutBtn.disabled = true;
    checkoutBtn.textContent = "Processing…";
    try {
      var sale = await apiFetch("/transactions", {
        method: "POST",
        body: body,
      });
      var change =
        method === "CASH" && tendered > num(sale.grand_total)
          ? round2(tendered - num(sale.grand_total))
          : 0;
      state.cart = [];
      state.posDiscount = 0;
      state.posCustomerId = null;
      state.posCustomerName = null;
      syncCustomerChip();
      tenderedInput.value = "";
      renderCartLines();
      loadPosTiles(searchInput.value.trim());
      toast(
        "success",
        "Sale " +
          (sale.receipt_number || "") +
          " completed." +
          (change > 0 ? " Change due: " + fmtMoney(change) : ""),
      );
      openReceiptModal(sale, change);
    } catch (err) {
      toastError(err);
    } finally {
      checkoutBtn.disabled = !state.cart.length;
      checkoutBtn.textContent = "Charge " + fmtMoney(posTotals().grand);
    }
  }

  function attemptPosScan(code, wrapNode) {
    var q = String(code || "").trim();
    if (!q) return;
    apiFetch("/products/barcode/" + encodeURIComponent(q))
      .then(function (p) {
        addToCart(p);
      })
      .catch(function (err) {
        if (err.status === 404) showScanMenu(q, wrapNode);
        else toastError(err);
      });
  }

  function closeScanMenus(wrapNode) {
    Array.prototype.slice
      .call(wrapNode.querySelectorAll(".scan-menu"))
      .forEach(function (n) {
        n.remove();
      });
  }

  async function showScanMenu(query, wrapNode) {
    closeScanMenus(wrapNode);
    var items = [];
    try {
      var data = await apiFetch(
        "/products" +
          qs({
            search: query,
            store_id: state.storeId || undefined,
            active: "true",
            per_page: 12,
          }),
      );
      items = itemsOf(data);
    } catch (err) {
      if (err.status !== 401) toastError(err);
      return;
    }
    if (!items.length) {
      toast("error", 'No product matched "' + query + '"');
      return;
    }
    var menu = h("div", { class: "scan-menu" });
    items.forEach(function (p) {
      menu.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "scan-item",
            onClick: function () {
              addToCart(p);
              closeScanMenus(wrapNode);
            },
          },
          h(
            "span",
            { class: "scan-item-name" },
            p.name + "  (" + (p.sku || "—") + ")",
          ),
          h("span", { class: "scan-item-price" }, fmtMoney(p.selling_price)),
        ),
      );
    });
    wrapNode.appendChild(menu);
    var closer = function (ev) {
      if (!menu.isConnected) {
        document.removeEventListener("mousedown", closer);
        return;
      }
      if (!wrapNode.contains(ev.target)) {
        closeScanMenus(wrapNode);
        document.removeEventListener("mousedown", closer);
      }
    };
    document.addEventListener("mousedown", closer);
  }

  function addToCart(p) {
    if (!p) return;
    var stock = p.stock == null ? null : num(p.stock);
    if (stock !== null && stock <= 0) {
      toast("error", p.name + " is out of stock here.");
      return;
    }
    var line = state.cart.find(function (l) {
      return l.product_id === p.id;
    });
    if (line) {
      if (stock !== null && line.quantity + 1 > stock) {
        toast(
          "error",
          "Only " + fmtQty(stock) + ' of "' + p.name + '" available.',
        );
        return;
      }
      line.quantity += 1;
    } else {
      state.cart.push({
        product_id: p.id,
        sku: p.sku || "",
        name: p.name,
        unit_price: num(p.selling_price),
        tax_rate: num(
          p.tax_rate_override != null
            ? p.tax_rate_override
            : (state.meta && state.meta.default_tax_rate) || 0,
        ),
        quantity: 1,
        stock: stock,
      });
    }
    renderCartLines();
  }

  async function loadPosTiles(searchVal) {
    tilesGrid.innerHTML = '<div class="loading">Loading products…</div>';
    try {
      var data = await apiFetch(
        "/products" +
          qs({
            search: searchVal || undefined,
            store_id: state.storeId || undefined,
            active: "true",
            per_page: 100,
          }),
      );
      var items = itemsOf(data);
      state.posProducts = {};
      items.forEach(function (p) {
        state.posProducts[p.id] = p;
      });
      if (!items.length) {
        tilesGrid.innerHTML = '<div class="empty">No products found.</div>';
        return;
      }
      tilesGrid.innerHTML = items
        .map(function (p) {
          var stock = p.stock == null ? null : num(p.stock);
          var out = stock !== null && stock <= 0;
          var low = stock !== null && !out && stock <= num(p.reorder_threshold);
          return (
            '<button type="button" class="tile' +
            (out ? " out" : "") +
            '" data-id="' +
            esc(p.id) +
            '">' +
            '<span class="tile-name">' +
            esc(p.name) +
            "</span>" +
            '<span class="tile-meta">' +
            esc(p.sku || "") +
            "</span>" +
            '<span class="tile-price">' +
            fmtMoney(p.selling_price) +
            "</span>" +
            '<span class="tile-stock' +
            (out ? " zero" : low ? " low" : "") +
            '">' +
            (stock === null
              ? ""
              : out
                ? "Out of stock"
                : fmtQty(stock) + " in stock") +
            "</span>" +
            "</button>"
          );
        })
        .join("");
    } catch (err) {
      tilesGrid.innerHTML = "";
      tilesGrid.appendChild(errorBox(err));
    }
  }

  renderCartLines();
  loadPosTiles("");
}

/* Receipt modal — authoritative totals come from the POST /transactions response */
function openReceiptModal(t, changeDue) {
  var m = openModal({
    title: "Receipt " + (t.receipt_number || t.id || ""),
    footer: true,
  });
  var body = receiptNode(t);
  if (changeDue > 0) {
    var line = h(
      "div",
      { class: "r-row" },
      h("span", {}, "Change due"),
      h("span", { class: "r-amt" }, fmtMoney(changeDue)),
    );
    var sep = body.querySelector(".r-thanks");
    body.insertBefore(line, sep);
  }
  m.body.appendChild(h("div", { class: "receipt-scroll" }, body));
  m.foot.appendChild(
    h("button", { class: "btn ghost", onClick: m.close }, "Close"),
  );
  m.foot.appendChild(
    h(
      "button",
      {
        class: "btn primary",
        onClick: function () {
          window.print();
        },
      },
      "🖨 Print",
    ),
  );
}

function receiptNode(t) {
  var meta = state.meta || {};
  var r = h("div", { class: "receipt" });
  r.appendChild(
    h(
      "div",
      { class: "r-store" },
      meta.store_name || state.storeName || "BackPOS",
    ),
  );
  r.appendChild(
    h(
      "div",
      { class: "r-meta" },
      "Receipt #" + (t.receipt_number || t.id || "—"),
    ),
  );
  r.appendChild(
    h(
      "div",
      { class: "r-meta" },
      fmtDateTime(t.created_at) + (t.store_name ? " · " + t.store_name : ""),
    ),
  );
  r.appendChild(h("div", { class: "r-sep" }));

  (t.items || []).forEach(function (it) {
    r.appendChild(
      h(
        "div",
        { class: "r-line" },
        h(
          "span",
          { class: "r-name" },
          (it.name || it.sku || "Item") +
            (num(it.quantity) !== 1 ? " × " + fmtQty(it.quantity) : ""),
        ),
        h("span", { class: "r-amt" }, fmtMoney(it.line_total)),
      ),
    );
    if (num(it.quantity) !== 1 || num(it.line_discount) > 0) {
      r.appendChild(
        h(
          "div",
          { class: "r-sub" },
          "  " +
            fmtQty(it.quantity) +
            " × " +
            fmtMoney(it.unit_price) +
            (num(it.line_discount) > 0
              ? " − " + fmtMoney(it.line_discount)
              : ""),
        ),
      );
    }
  });

  r.appendChild(h("div", { class: "r-sep" }));
  r.appendChild(
    h(
      "div",
      { class: "r-row" },
      h("span", {}, "Subtotal"),
      h("span", { class: "r-amt" }, fmtMoney(t.subtotal)),
    ),
  );
  if (num(t.discount_total) > 0)
    r.appendChild(
      h(
        "div",
        { class: "r-row" },
        h("span", {}, "Discount"),
        h("span", { class: "r-amt" }, "− " + fmtMoney(t.discount_total)),
      ),
    );
  r.appendChild(
    h(
      "div",
      { class: "r-row" },
      h("span", {}, "Tax"),
      h("span", { class: "r-amt" }, fmtMoney(t.tax_total)),
    ),
  );
  r.appendChild(
    h(
      "div",
      { class: "r-row grand" },
      h("span", {}, "TOTAL"),
      h("span", { class: "r-amt" }, fmtMoney(t.grand_total)),
    ),
  );

  if ((t.payments || []).length) {
    r.appendChild(h("div", { class: "r-sep" }));
    (t.payments || []).forEach(function (p) {
      r.appendChild(
        h(
          "div",
          { class: "r-row" },
          h(
            "span",
            {},
            String(p.method || "PAYMENT").replace("_", " ") +
              (p.reference ? " · " + p.reference : ""),
          ),
          h("span", { class: "r-amt" }, fmtMoney(p.amount)),
        ),
      );
    });
  }
  r.appendChild(h("div", { class: "r-sep" }));
  r.appendChild(
    h("div", { class: "r-meta" }, "Cashier: " + (t.cashier_name || "—")),
  );
  if (t.customer_name)
    r.appendChild(
      h("div", { class: "r-meta" }, "Customer: " + t.customer_name),
    );
  r.appendChild(h("div", { class: "r-thanks" }, "Thank you for your visit!"));
  return r;
}

/* ============================================================
   11. Transactions screen
   ============================================================ */

function renderTransactions(content) {
  content.innerHTML = "";
  var from = h("input", { class: "input", type: "date" });
  var to = h("input", { class: "input", type: "date" });
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "All stores"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  var statusSel = h("select", { class: "select" });
  ["", "COMPLETED", "VOIDED", "REFUNDED"].forEach(function (s) {
    statusSel.appendChild(
      h(
        "option",
        { value: s },
        s === "" ? "All statuses" : s.charAt(0) + s.slice(1).toLowerCase(),
      ),
    );
  });
  var search = h("input", {
    class: "input",
    placeholder: "Receipt #…",
  });
  var loadBtn = h("button", { class: "btn primary" }, "Load");
  var tableBox = h("div", {});

  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "From"),
        from,
      ),
      h("div", { class: "field" }, h("label", { class: "label" }, "To"), to),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Status"),
        statusSel,
      ),
      h(
        "div",
        { class: "field grow" },
        h("label", { class: "label" }, "Receipt #"),
        search,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "‎"),
        loadBtn,
      ),
    ),
  );
  content.appendChild(tableBox);

  loadBtn.addEventListener("click", load);
  from.addEventListener("change", load);
  to.addEventListener("change", load);
  storeSel.addEventListener("change", load);
  statusSel.addEventListener("change", load);
  search.addEventListener("input", debounce(load, 300));

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading transactions…</div>';
    try {
      var data = await apiFetch(
        "/transactions" +
          qs({
            from: from.value || undefined,
            to: to.value || undefined,
            store_id: storeSel.value || undefined,
            status: statusSel.value || undefined,
            search: search.value.trim() || undefined,
            per_page: 100,
          }),
      );
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No transactions found.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Receipt</th><th>Date</th><th>Cashier</th><th>Customer</th><th class="num-cell">Items</th><th class="num-cell">Total</th><th>Status</th><th></th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (t) {
            return (
              '<tr class="clickable" data-id="' +
              esc(t.id) +
              '">' +
              '<td class="num-cell">' +
              esc(t.receipt_number || t.id) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(fmtDateTime(t.created_at)) +
              "</td>" +
              "<td>" +
              esc(t.cashier_name || "—") +
              "</td>" +
              "<td>" +
              esc(t.customer_name || "—") +
              "</td>" +
              '<td class="num-cell">' +
              num(t.item_count) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(t.grand_total) +
              "</td>" +
              "<td>" +
              stBadge(t.status) +
              "</td>" +
              '<td class="cell-actions"><span class="badge st-info">View</span></td>' +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div>" +
        '<div class="hint">' +
        items.length +
        " of " +
        totalOf(data, items) +
        " shown</div></div>";

      tableBox.querySelector("tbody").addEventListener("click", function (ev) {
        var row = ev.target.closest("tr[data-id]");
        if (row) openTransactionDetail(row.dataset.id, load);
      });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

async function openTransactionDetail(id, onChanged) {
  var m = openModal({ title: "Transaction", footer: true, wide: true });
  m.body.innerHTML = '<div class="loading">Loading…</div>';
  var t;
  try {
    t = await apiFetch("/transactions/" + id);
  } catch (err) {
    m.body.innerHTML = "";
    m.body.appendChild(errorBox(err));
    m.foot.appendChild(
      h("button", { class: "btn ghost", onClick: m.close }, "Close"),
    );
    return;
  }
  var headNode = document.querySelector("#modal-root .modal-title");
  if (headNode)
    headNode.textContent = "Transaction " + (t.receipt_number || t.id);

  m.body.innerHTML = "";
  m.body.appendChild(
    h(
      "div",
      { class: "meta-grid" },
      h(
        "div",
        { class: "meta-item" },
        h("div", { class: "meta-label" }, "Date"),
        h("div", { class: "meta-value" }, fmtDateTime(t.created_at)),
      ),
      h(
        "div",
        { class: "meta-item" },
        h("div", { class: "meta-label" }, "Store"),
        h(
          "div",
          { class: "meta-value" },
          t.store_name || storeName(t.store_id),
        ),
      ),
      h(
        "div",
        { class: "meta-item" },
        h("div", { class: "meta-label" }, "Cashier"),
        h("div", { class: "meta-value" }, t.cashier_name || "—"),
      ),
      h(
        "div",
        { class: "meta-item" },
        h("div", { class: "meta-label" }, "Customer"),
        h("div", { class: "meta-value" }, t.customer_name || "—"),
      ),
      h(
        "div",
        { class: "meta-item" },
        h("div", { class: "meta-label" }, "Status"),
        h("div", { class: "meta-value" }, badgeNode(t.status)),
      ),
    ),
  );

  m.body.appendChild(h("div", { class: "panel-head" }, h("h3", {}, "Items")));
  m.body.appendChild(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Product"),
            h("th", {}, "SKU"),
            h("th", {}, "Qty"),
            h("th", {}, "Unit"),
            h("th", {}, "Discount"),
            h("th", {}, "Tax"),
            h("th", {}, "Line total"),
          ),
        ),
        h("tbody", {}),
      ),
    ),
  );
  m.body.querySelector("tbody").innerHTML = (t.items || [])
    .map(function (it) {
      return (
        "<tr>" +
        "<td>" +
        esc(it.name || "") +
        "</td>" +
        '<td class="muted-cell num-cell">' +
        esc(it.sku || "") +
        "</td>" +
        '<td class="num-cell">' +
        fmtQty(it.quantity) +
        "</td>" +
        '<td class="num-cell">' +
        fmtMoney(it.unit_price) +
        "</td>" +
        '<td class="num-cell">' +
        (num(it.line_discount) > 0 ? "− " + fmtMoney(it.line_discount) : "—") +
        "</td>" +
        '<td class="num-cell">' +
        (num(it.tax_rate) > 0 ? num(it.tax_rate) + "%" : "—") +
        "</td>" +
        '<td class="num-cell">' +
        fmtMoney(it.line_total) +
        "</td>" +
        "</tr>"
      );
    })
    .join("");

  m.body.appendChild(
    h("div", { class: "panel-head" }, h("h3", {}, "Payments")),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Method"),
            h("th", {}, "Amount"),
            h("th", {}, "Reference"),
          ),
        ),
        h("tbody", {}),
      ),
    ),
  );
  m.body.querySelectorAll("tbody")[1].innerHTML = (t.payments || []).length
    ? (t.payments || [])
        .map(function (p) {
          return (
            "<tr><td>" +
            esc(String(p.method || "").replace("_", " ")) +
            "</td>" +
            '<td class="num-cell">' +
            fmtMoney(p.amount) +
            "</td>" +
            '<td class="muted-cell">' +
            esc(p.reference || "—") +
            "</td></tr>"
          );
        })
        .join("")
    : '<tr><td colspan="3" class="muted-cell">No payment records.</td></tr>';

  m.foot.innerHTML = "";
  m.foot.appendChild(
    h("button", { class: "btn ghost", onClick: m.close }, "Close"),
  );
  if (isStaff() && String(t.status || "").toUpperCase() === "COMPLETED") {
    var refundBtn = h("button", { class: "btn warning" }, "Refund");
    var voidBtn = h("button", { class: "btn danger" }, "Void");
    refundBtn.addEventListener("click", async function () {
      var reason = await promptReason({
        title: "Refund " + (t.receipt_number || ""),
        okLabel: "Refund transaction",
      });
      if (reason === null) return;
      refundBtn.disabled = true;
      try {
        await apiFetch("/transactions/" + t.id + "/refund", {
          method: "POST",
          body: { reason: reason },
        });
        toast("success", "Transaction refunded.");
        m.close();
        if (onChanged) onChanged();
      } catch (err) {
        toastError(err);
        refundBtn.disabled = false;
      }
    });
    voidBtn.addEventListener("click", async function () {
      var reason = await promptReason({
        title: "Void " + (t.receipt_number || ""),
        danger: true,
        okLabel: "Void transaction",
      });
      if (reason === null) return;
      voidBtn.disabled = true;
      try {
        await apiFetch("/transactions/" + t.id + "/void", {
          method: "POST",
          body: { reason: reason },
        });
        toast("success", "Transaction voided.");
        m.close();
        if (onChanged) onChanged();
      } catch (err) {
        toastError(err);
        voidBtn.disabled = false;
      }
    });
    m.foot.appendChild(refundBtn);
    m.foot.appendChild(voidBtn);
  }
}

/* ============================================================
   12. Products screen
   ============================================================ */

async function loadCategoriesList() {
  try {
    var data = await apiFetch("/categories");
    return itemsOf(data);
  } catch (e) {
    return [];
  }
}

function renderProducts(content) {
  content.innerHTML = "";
  var search = h("input", {
    class: "input",
    placeholder: "Search name / SKU / barcode…",
  });
  var categorySel = h("select", { class: "select" });
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "All stores"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  storeSel.value = state.storeId != null ? String(state.storeId) : "";
  var lowStock = h("input", { type: "checkbox" });
  var inclInactive = h("input", { type: "checkbox" });
  var addBtn = h("button", { class: "btn primary" }, "+ Add product");
  var tableBox = h("div", {});

  categorySel.appendChild(h("option", { value: "" }, "All categories"));
  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field grow" },
        h("label", { class: "label" }, "Search"),
        search,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Category"),
        categorySel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Filters"),
        h("label", { class: "checkbox-row" }, lowStock, "Low stock"),
        h("label", { class: "checkbox-row" }, inclInactive, "Include inactive"),
      ),
      addBtn,
    ),
  );
  content.appendChild(tableBox);

  search.addEventListener("input", debounce(load, 250));
  categorySel.addEventListener("change", load);
  storeSel.addEventListener("change", load);
  lowStock.addEventListener("change", load);
  inclInactive.addEventListener("change", load);
  addBtn.addEventListener("click", function () {
    openProductModal(null, load);
  });

  loadCategoriesList().then(function (cats) {
    cats.forEach(function (c) {
      categorySel.appendChild(h("option", { value: String(c.id) }, c.name));
    });
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading products…</div>';
    try {
      var data = await apiFetch(
        "/products" +
          qs({
            search: search.value.trim() || undefined,
            category_id: categorySel.value || undefined,
            store_id: storeSel.value || undefined,
            low_stock: lowStock.checked ? "true" : undefined,
            active: inclInactive.checked ? undefined : "true",
            per_page: 100,
          }),
      );
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No products found.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>SKU</th><th>Name</th><th>Barcode</th><th>Category</th><th class="num-cell">Cost</th><th class="num-cell">Price</th><th class="num-cell">Stock</th><th class="num-cell">Threshold</th><th>Status</th><th></th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (p) {
            var stock = p.stock == null ? "—" : fmtQty(p.stock);
            return (
              '<tr data-id="' +
              esc(p.id) +
              '">' +
              '<td class="num-cell">' +
              esc(p.sku || "") +
              "</td>" +
              "<td>" +
              esc(p.name) +
              "</td>" +
              '<td class="muted-cell num-cell">' +
              esc(p.barcode || "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(p.category_name || "—") +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(p.cost_price) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(p.selling_price) +
              "</td>" +
              '<td class="num-cell">' +
              esc(stock) +
              "</td>" +
              '<td class="num-cell muted-cell">' +
              esc(
                p.reorder_threshold == null ? "—" : fmtQty(p.reorder_threshold),
              ) +
              "</td>" +
              "<td>" +
              stBadge(p.is_active === false ? "INACTIVE" : "ACTIVE") +
              "</td>" +
              '<td class="cell-actions">' +
              '<button class="btn ghost small" data-act="edit">Edit</button>' +
              (p.is_active === false
                ? ""
                : '<button class="btn danger small" data-act="del">Deactivate</button>') +
              "</td>" +
              "</tr>"
            );
          })
          .join("") +
        '</tbody></table></div><div class="hint">' +
        items.length +
        " of " +
        totalOf(data, items) +
        " shown</div></div>";

      tableBox
        .querySelector("tbody")
        .addEventListener("click", async function (ev) {
          var btn = ev.target.closest("button[data-act]");
          if (!btn) return;
          var row = btn.closest("tr[data-id]");
          var p = items.find(function (x) {
            return String(x.id) === row.dataset.id;
          });
          if (!p) return;
          if (btn.dataset.act === "edit") {
            openProductModal(p, load);
            return;
          }
          var ok = await confirmDialog({
            title: "Deactivate product",
            message:
              'Deactivate "' + p.name + '"? It will no longer be sellable.',
            danger: true,
            okLabel: "Deactivate",
          });
          if (!ok) return;
          try {
            await apiFetch("/products/" + p.id, { method: "DELETE" });
            toast("success", "Product deactivated.");
            load();
          } catch (err) {
            toastError(err);
          }
        });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function openProductModal(existing, onSaved) {
  var isNew = !existing;
  var m = openModal({
    title: isNew ? "Add product" : "Edit product",
    footer: true,
    wide: true,
  });
  var form = h("div", { class: "form-grid" });

  var sku = h("input", {
    class: "input",
    value: existing ? existing.sku || "" : "",
  });
  var name = h("input", {
    class: "input",
    value: existing ? existing.name || "" : "",
  });
  var barcode = h("input", {
    class: "input",
    value: existing ? existing.barcode || "" : "",
  });
  var barcodeType = h("select", { class: "select" });
  ["", "UPC-A", "EAN-13", "EAN-8", "CODE39"].forEach(function (v) {
    barcodeType.appendChild(
      h("option", { value: v }, v === "" ? "Auto-detect" : v),
    );
  });
  if (existing && existing.barcode_type)
    barcodeType.value = String(existing.barcode_type);
  var categorySel = h("select", { class: "select" });
  var cost = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: existing ? String(num(existing.cost_price)) : "",
  });
  var price = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value: existing ? String(num(existing.selling_price)) : "",
  });
  var unit = h("select", { class: "select" });
  ["PIECE", "KG", "L", "BOX", "PACK"].forEach(function (u) {
    unit.appendChild(h("option", { value: u }, u));
  });
  if (existing && existing.unit) unit.value = String(existing.unit);
  var threshold = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "1",
    value: existing ? String(num(existing.reorder_threshold)) : "0",
  });
  var taxRate = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "0.01",
    value:
      existing && existing.tax_rate_override != null
        ? String(num(existing.tax_rate_override))
        : "",
  });
  var initStock = h("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "1",
    value: "0",
  });
  var initStore = h("select", { class: "select" });
  state.stores.forEach(function (s) {
    initStore.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  if (state.storeId != null) initStore.value = String(state.storeId);

  categorySel.appendChild(h("option", { value: "" }, "— None —"));
  loadCategoriesList().then(function (cats) {
    cats.forEach(function (c) {
      categorySel.appendChild(h("option", { value: String(c.id) }, c.name));
    });
    if (existing && existing.category_id != null)
      categorySel.value = String(existing.category_id);
  });

  function field(labelText, node, cls) {
    form.appendChild(
      h(
        "div",
        { class: "field" + (cls ? " " + cls : "") },
        h("label", { class: "label" }, labelText),
        node,
      ),
    );
  }
  field("SKU", sku);
  field("Name", name);
  field("Barcode", barcode);
  field("Barcode type", barcodeType);
  field("Category", categorySel);
  field("Unit", unit);
  field("Cost price", cost);
  field("Selling price", price);
  field("Reorder threshold", threshold);
  field("Tax rate override %", taxRate);
  if (isNew) {
    field("Initial stock", initStock);
    field("Stock store", initStore);
  } else {
    form.appendChild(
      h(
        "div",
        { class: "field full" },
        h(
          "div",
          { class: "hint" },
          "Quantities after creation are managed in Inventory → Adjust stock / Transfer.",
        ),
      ),
    );
  }

  m.body.appendChild(form);

  m.foot.innerHTML = "";
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  var save = h(
    "button",
    { class: "btn primary" },
    isNew ? "Create product" : "Save changes",
  );
  cancel.addEventListener("click", m.close);
  save.addEventListener("click", async function () {
    if (!sku.value.trim() || !name.value.trim()) {
      toast("error", "SKU and name are required.");
      return;
    }
    if (price.value === "") {
      toast("error", "Selling price is required.");
      return;
    }
    var body = {
      sku: sku.value.trim(),
      name: name.value.trim(),
      barcode: barcode.value.trim() || undefined,
      barcode_type: barcode.value.trim()
        ? barcodeType.value || undefined
        : undefined,
      category_id: categorySel.value ? String(categorySel.value) : undefined,
      cost_price: round2(cost.value),
      selling_price: round2(price.value),
      unit: unit.value,
      reorder_threshold: Math.max(0, Math.round(num(threshold.value))),
    };
    if (taxRate.value !== "") body.tax_rate_override = num(taxRate.value);
    if (isNew) {
      var n = Math.max(0, Math.round(num(initStock.value)));
      if (n > 0) {
        body.initial_stock = n;
        body.store_id = initStore.value ? String(initStore.value) : undefined;
      }
    }
    save.disabled = true;
    try {
      if (isNew) {
        await apiFetch("/products", { method: "POST", body: body });
        toast("success", "Product created.");
      } else {
        await apiFetch("/products/" + existing.id, {
          method: "PATCH",
          body: body,
        });
        toast("success", "Product updated.");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
    }
    save.disabled = false;
  });
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

/* ============================================================
   13. Categories screen
   ============================================================ */

function renderCategories(content) {
  content.innerHTML = "";
  var addBtn = h("button", { class: "btn primary" }, "+ Add category");
  var tableBox = h("div", {});
  content.appendChild(
    h("div", { class: "toolbar" }, h("div", { class: "spacer" }), addBtn),
  );
  content.appendChild(tableBox);
  addBtn.addEventListener("click", function () {
    openCategoryModal(null, load);
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading categories…</div>';
    try {
      var data = await apiFetch("/categories");
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No categories yet.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Name</th><th>Description</th><th class="num-cell">Products</th><th></th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (c) {
            return (
              '<tr data-id="' +
              esc(c.id) +
              '">' +
              "<td>" +
              esc(c.name) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(c.description || "—") +
              "</td>" +
              '<td class="num-cell">' +
              num(c.product_count) +
              "</td>" +
              '<td class="cell-actions">' +
              '<button class="btn ghost small" data-act="edit">Edit</button>' +
              '<button class="btn danger small" data-act="del">Delete</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div></div>";

      tableBox
        .querySelector("tbody")
        .addEventListener("click", async function (ev) {
          var btn = ev.target.closest("button[data-act]");
          if (!btn) return;
          var row = btn.closest("tr[data-id]");
          var c = items.find(function (x) {
            return String(x.id) === row.dataset.id;
          });
          if (!c) return;
          if (btn.dataset.act === "edit") {
            openCategoryModal(c, load);
            return;
          }
          var ok = await confirmDialog({
            title: "Delete category",
            message:
              'Delete "' +
              c.name +
              '"? Categories that still have products cannot be deleted.',
            danger: true,
            okLabel: "Delete",
          });
          if (!ok) return;
          try {
            await apiFetch("/categories/" + c.id, { method: "DELETE" });
            toast("success", "Category deleted.");
            load();
          } catch (err) {
            toastError(err);
          } /* 409 when still in use */
        });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function openCategoryModal(existing, onSaved) {
  var isNew = !existing;
  var m = openModal({
    title: isNew ? "Add category" : "Edit category",
    footer: true,
  });
  var name = h("input", {
    class: "input",
    value: existing ? existing.name || "" : "",
  });
  var desc = h("input", {
    class: "input",
    value: existing ? existing.description || "" : "",
  });
  m.body.appendChild(
    h("div", { class: "field" }, h("label", { class: "label" }, "Name"), name),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Description (optional)"),
      desc,
    ),
  );
  var save = h("button", { class: "btn primary" }, isNew ? "Create" : "Save");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    if (!name.value.trim()) {
      toast("error", "Name is required.");
      return;
    }
    var body = {
      name: name.value.trim(),
      description: desc.value.trim() || undefined,
    };
    save.disabled = true;
    try {
      if (isNew) {
        await apiFetch("/categories", { method: "POST", body: body });
        toast("success", "Category created.");
      } else {
        await apiFetch("/categories/" + existing.id, {
          method: "PATCH",
          body: body,
        });
        toast("success", "Category updated.");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
    }
    save.disabled = false;
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
  name.focus();
}

/* ============================================================
   14. Inventory screen
   ============================================================ */

function renderInventory(content) {
  content.innerHTML = "";
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "All stores"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  storeSel.value = state.storeId != null ? String(state.storeId) : "";
  var lowStock = h("input", { type: "checkbox" });
  var adjustBtn = h("button", { class: "btn warning" }, "⚖ Adjust stock");
  var transferBtn = h("button", { class: "btn primary" }, "⇄ Transfer");
  var movesBtn = h("button", { class: "btn ghost" }, "📜 Movements log");
  var tableBox = h("div", {});

  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Filters"),
        h("label", { class: "checkbox-row" }, lowStock, "Low stock only"),
      ),
      h("div", { class: "spacer" }),
      movesBtn,
      adjustBtn,
      transferBtn,
    ),
  );
  content.appendChild(tableBox);

  storeSel.addEventListener("change", load);
  lowStock.addEventListener("change", load);
  adjustBtn.addEventListener("click", function () {
    openAdjustDialog(load);
  });
  transferBtn.addEventListener("click", function () {
    openTransferDialog(load);
  });
  movesBtn.addEventListener("click", function () {
    openMovementsLog(storeSel.value);
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading inventory…</div>';
    try {
      var data = await apiFetch(
        "/inventory" +
          qs({
            store_id: storeSel.value || undefined,
            low_stock: lowStock.checked ? "true" : undefined,
            per_page: 100,
          }),
      );
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No inventory rows.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Product</th><th>SKU</th><th>Store</th><th class="num-cell">Quantity</th><th class="num-cell">Threshold</th><th>Status</th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (it) {
            var low =
              num(it.reorder_threshold) > 0 &&
              num(it.quantity) <= num(it.reorder_threshold);
            return (
              "<tr>" +
              "<td>" +
              esc(it.name || "") +
              "</td>" +
              '<td class="num-cell muted-cell">' +
              esc(it.sku || "") +
              "</td>" +
              "<td>" +
              esc(it.store_name || storeName(it.store_id)) +
              "</td>" +
              '<td class="num-cell">' +
              fmtQty(it.quantity) +
              "</td>" +
              '<td class="num-cell muted-cell">' +
              fmtQty(it.reorder_threshold) +
              "</td>" +
              "<td>" +
              (low
                ? '<span class="badge st-warning">LOW</span>'
                : '<span class="badge st-success">OK</span>') +
              "</td>" +
              "</tr>"
            );
          })
          .join("") +
        '</tbody></table></div><div class="hint">' +
        items.length +
        " of " +
        totalOf(data, items) +
        " rows shown</div></div>";
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function openAdjustDialog(onDone) {
  var m = openModal({ title: "Adjust stock", footer: true });
  var picker = h("input", { class: "input", placeholder: "Search product…" });
  var picked = h("div", { class: "hint" }, "No product selected.");
  var product = null;
  attachProductPicker(picker, function (p) {
    product = p;
    picked.textContent = "Selected: " + p.name + " (" + (p.sku || "") + ")";
  });

  var storeSel = h("select", { class: "select" });
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  if (state.storeId != null) storeSel.value = String(state.storeId);
  var typeSel = h("select", { class: "select" });
  ["SHRINKAGE", "DAMAGE", "RETURN", "CORRECTION"].forEach(function (v) {
    typeSel.appendChild(h("option", { value: v }, v));
  });
  var delta = h("input", {
    class: "input",
    type: "number",
    step: "1",
    placeholder: "e.g. −2 or 3",
  });
  var reason = h("input", { class: "input", placeholder: "Reason (required)" });
  var err = h("div", { class: "field-error", hidden: true }, "");

  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Product"),
      picker,
      picked,
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Adjustment type"),
        typeSel,
      ),
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Delta (signed quantity)"),
      delta,
      h(
        "div",
        { class: "hint" },
        "Negative reduces stock (shrinkage / damage); positive adds stock (return / correction).",
      ),
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Reason"),
      reason,
      err,
    ),
  );

  var save = h("button", { class: "btn primary" }, "Post adjustment");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    err.hidden = true;
    var d = Math.round(num(delta.value));
    if (!product) {
      err.textContent = "Pick a product.";
      err.hidden = false;
      return;
    }
    if (!storeSel.value) {
      err.textContent = "Pick a store.";
      err.hidden = false;
      return;
    }
    if (!d) {
      err.textContent = "Delta cannot be zero.";
      err.hidden = false;
      return;
    }
    if (!reason.value.trim()) {
      err.textContent = "Reason is required.";
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      await apiFetch("/inventory/adjustments", {
        method: "POST",
        body: {
          product_id: product.id,
          store_id: String(storeSel.value),
          adjustment_type: typeSel.value,
          delta: d,
          reason: reason.value.trim(),
        },
      });
      toast("success", "Stock adjusted.");
      m.close();
      if (onDone) onDone();
    } catch (e) {
      toastError(e);
      save.disabled = false;
    }
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

function openTransferDialog(onDone) {
  var m = openModal({ title: "Transfer stock", footer: true });
  var picker = h("input", { class: "input", placeholder: "Search product…" });
  var picked = h("div", { class: "hint" }, "No product selected.");
  var product = null;
  attachProductPicker(picker, function (p) {
    product = p;
    picked.textContent = "Selected: " + p.name + " (" + (p.sku || "") + ")";
  });

  function storeSelect() {
    var sel = h("select", { class: "select" });
    sel.appendChild(h("option", { value: "" }, "— Store —"));
    state.stores.forEach(function (s) {
      sel.appendChild(
        h(
          "option",
          { value: String(s.id) },
          (s.code ? s.code + " — " : "") + s.name,
        ),
      );
    });
    return sel;
  }
  var fromSel = storeSelect();
  var toSel = storeSelect();
  if (state.storeId != null) fromSel.value = String(state.storeId);
  var qty = h("input", {
    class: "input",
    type: "number",
    min: "1",
    step: "1",
    placeholder: "Quantity",
  });
  var reason = h("input", { class: "input", placeholder: "Reason (optional)" });
  var err = h("div", { class: "field-error", hidden: true }, "");

  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Product"),
      picker,
      picked,
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "From store"),
        fromSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "To store"),
        toSel,
      ),
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Quantity"),
        qty,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Reason"),
        reason,
      ),
    ),
  );
  m.body.appendChild(err);

  var save = h("button", { class: "btn primary" }, "Transfer");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    err.hidden = true;
    if (!product) {
      err.textContent = "Pick a product.";
      err.hidden = false;
      return;
    }
    if (!fromSel.value || !toSel.value) {
      err.textContent = "Pick both stores.";
      err.hidden = false;
      return;
    }
    if (fromSel.value === toSel.value) {
      err.textContent = "Source and destination must differ.";
      err.hidden = false;
      return;
    }
    var q = Math.round(num(qty.value));
    if (q <= 0) {
      err.textContent = "Quantity must be at least 1.";
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      await apiFetch("/inventory/transfers", {
        method: "POST",
        body: {
          product_id: product.id,
          from_store_id: String(fromSel.value),
          to_store_id: String(toSel.value),
          quantity: q,
          reason: reason.value.trim() || undefined,
        },
      });
      toast("success", "Transfer recorded.");
      m.close();
      if (onDone) onDone();
    } catch (e) {
      toastError(e);
      save.disabled = false;
    }
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

async function openMovementsLog(storeId) {
  var m = openModal({
    title: "Stock movements (latest 100)",
    wide: true,
    footer: true,
  });
  m.body.innerHTML = '<div class="loading">Loading movements…</div>';
  var movements = [];
  try {
    movements = itemsOf(
      await apiFetch(
        "/inventory/movements" +
          qs({ store_id: storeId || undefined, per_page: 100 }),
      ),
    );
  } catch (err) {
    m.body.innerHTML = "";
    m.body.appendChild(errorBox(err));
    m.foot.appendChild(
      h("button", { class: "btn ghost", onClick: m.close }, "Close"),
    );
    return;
  }

  m.body.innerHTML = "";
  if (!movements.length) {
    m.body.appendChild(h("div", { class: "empty" }, "No movements recorded."));
  } else {
    m.body.innerHTML =
      '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th>When</th><th>Product</th><th>Type</th><th class="num-cell">Delta</th><th class="num-cell">Unit cost</th><th>Reason</th><th>By</th></tr></thead>' +
      "<tbody>" +
      movements
        .map(function (mv) {
          return (
            "<tr>" +
            '<td class="muted-cell">' +
            esc(fmtDateTime(mv.created_at)) +
            "</td>" +
            "<td>" +
            esc(mv.product_name || mv.sku || "#" + mv.product_id) +
            "</td>" +
            "<td>" +
            stBadge(mv.adjustment_type) +
            "</td>" +
            '<td class="num-cell">' +
            (num(mv.quantity_delta) > 0 ? "+" : "") +
            fmtQty(mv.quantity_delta) +
            "</td>" +
            '<td class="num-cell">' +
            (mv.unit_cost != null && mv.unit_cost !== ""
              ? fmtMoney(mv.unit_cost)
              : "—") +
            "</td>" +
            '<td class="muted-cell">' +
            esc(mv.reason || "—") +
            "</td>" +
            '<td class="muted-cell">' +
            esc(mv.created_by_name || "—") +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";
  }
  m.foot.appendChild(
    h("button", { class: "btn ghost", onClick: m.close }, "Close"),
  );
}

/* ============================================================
   15. Purchase orders screen (+ supplier "Deliveries" view)
   ============================================================ */

function renderPurchases(content, opts) {
  opts = opts || {};
  var deliveriesMode = !!opts.deliveriesMode;
  content.innerHTML = "";

  var statusSel = h("select", { class: "select" });
  ["", "DRAFT", "SUBMITTED", "APPROVED", "RECEIVED", "CANCELLED"].forEach(
    function (s) {
      statusSel.appendChild(
        h(
          "option",
          { value: s },
          s === "" ? "All statuses" : s.charAt(0) + s.slice(1).toLowerCase(),
        ),
      );
    },
  );
  var supplierSel = h("select", { class: "select" });
  supplierSel.appendChild(h("option", { value: "" }, "All suppliers"));
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "All stores"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  if (!deliveriesMode && state.storeId != null)
    storeSel.value = String(state.storeId);

  var isSupplier = role() === "SUPPLIER";
  /* Backend gates: create/submit/cancel/receive = ADMIN|MANAGER|INVENTORY_MANAGER */
  var canManage = !isSupplier;
  if (isSupplier && state.user && state.user.supplier_id != null) {
    supplierSel.value = String(state.user.supplier_id);
    supplierSel.disabled = true;
  }

  var newBtn = h("button", { class: "btn primary" }, "+ New purchase order");
  if (deliveriesMode || isSupplier) newBtn.hidden = true;
  var tableBox = h("div", {});

  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Status"),
        statusSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Supplier"),
        supplierSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h("div", { class: "spacer" }),
      newBtn,
    ),
  );
  content.appendChild(tableBox);

  statusSel.addEventListener("change", load);
  supplierSel.addEventListener("change", load);
  storeSel.addEventListener("change", load);
  newBtn.addEventListener("click", function () {
    openNewPoModal(load);
  });

  loadSuppliers();
  load();

  async function loadSuppliers() {
    try {
      var data = await apiFetch("/suppliers");
      itemsOf(data).forEach(function (s) {
        if (
          isSupplier &&
          state.user.supplier_id != null &&
          String(s.id) !== String(state.user.supplier_id)
        )
          return;
        supplierSel.appendChild(h("option", { value: String(s.id) }, s.name));
      });
    } catch (e) {
      /* filter stays as-is */
    }
  }

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading purchase orders…</div>';
    try {
      var data = await apiFetch(
        "/purchase-orders" +
          qs({
            status: statusSel.value || undefined,
            supplier_id: supplierSel.value || undefined,
            store_id: storeSel.value || undefined,
            per_page: 100,
          }),
      );
      var items = itemsOf(data);
      if (deliveriesMode) {
        items = items.filter(function (po) {
          var st = String(po.status || "").toUpperCase();
          return st === "APPROVED" || st === "RECEIVED";
        });
      }
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">' +
          (deliveriesMode
            ? "No deliveries awaiting receipt."
            : "No purchase orders found.") +
          "</div></div>";
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>PO #</th><th>Supplier</th><th>Store</th><th>Status</th><th class="num-cell">Items</th><th class="num-cell">Total</th><th>Expected</th><th>Created</th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (po) {
            return (
              '<tr class="clickable" data-id="' +
              esc(po.id) +
              '">' +
              '<td class="num-cell">' +
              esc(po.po_number || po.id) +
              "</td>" +
              "<td>" +
              esc(po.supplier_name || "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(po.store_name || storeName(po.store_id)) +
              "</td>" +
              "<td>" +
              stBadge(po.status) +
              "</td>" +
              '<td class="num-cell">' +
              num(po.item_count) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(po.total) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(po.expected_at ? fmtDateTime(po.expected_at) : "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(fmtDateTime(po.created_at)) +
              "</td>" +
              "</tr>"
            );
          })
          .join("") +
        '</tbody></table></div><div class="hint">' +
        items.length +
        " of " +
        totalOf(data, items) +
        " shown</div></div>";

      tableBox.querySelector("tbody").addEventListener("click", function (ev) {
        var row = ev.target.closest("tr[data-id]");
        if (row) openPoDetail(row.dataset.id, load);
      });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function renderDeliveries(content) {
  /* Suppliers deliver against their own approved POs — same data, focused view. */
  renderPurchases(content, { deliveriesMode: true });
}

async function openPoDetail(id, onChanged) {
  var m = openModal({ title: "Purchase order", footer: true, wide: true });

  async function refreshDetail() {
    m.body.innerHTML = '<div class="loading">Loading…</div>';
    var po;
    try {
      po = await apiFetch("/purchase-orders/" + id);
    } catch (err) {
      m.body.innerHTML = "";
      m.body.appendChild(errorBox(err));
      return;
    }
    var st = String(po.status || "").toUpperCase();
    var manage =
      ["ADMIN", "MANAGER", "INVENTORY_MANAGER"].indexOf(role()) !== -1;
    var staff = role() === "ADMIN" || role() === "MANAGER";
    /* The backend only accepts deliveries while the order is APPROVED —
       a fully RECEIVED order (or DRAFT/SUBMITTED) cannot receive stock. */
    var canReceive = st === "APPROVED" && manage;

    m.body.innerHTML = "";
    m.body.appendChild(
      h(
        "div",
        { class: "meta-grid" },
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "PO"),
          h("div", { class: "meta-value" }, po.po_number || po.id),
        ),
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "Status"),
          h("div", { class: "meta-value" }, badgeNode(po.status)),
        ),
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "Supplier"),
          h("div", { class: "meta-value" }, po.supplier_name || "—"),
        ),
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "Store"),
          h(
            "div",
            { class: "meta-value" },
            po.store_name || storeName(po.store_id),
          ),
        ),
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "Expected"),
          h(
            "div",
            { class: "meta-value" },
            po.expected_at ? fmtDateTime(po.expected_at) : "—",
          ),
        ),
        h(
          "div",
          { class: "meta-item" },
          h("div", { class: "meta-label" }, "Total"),
          h("div", { class: "meta-value" }, fmtMoney(po.total)),
        ),
      ),
    );
    if (po.notes)
      m.body.appendChild(h("p", { class: "hint" }, "Notes: " + po.notes));

    m.body.appendChild(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", {}, "Product"),
              h("th", {}, "Ordered"),
              h("th", {}, "Received"),
              h("th", {}, "Remaining"),
              h("th", {}, "Unit cost"),
              h("th", {}, "Line total"),
            ),
          ),
          h("tbody", {}),
        ),
      ),
    );
    m.body.querySelector("tbody").innerHTML = (po.items || [])
      .map(function (it) {
        var rem = Math.max(
          0,
          num(it.quantity_ordered) - num(it.quantity_received),
        );
        return (
          "<tr>" +
          "<td>" +
          esc(it.product_name || "#" + it.product_id) +
          "</td>" +
          '<td class="num-cell">' +
          fmtQty(it.quantity_ordered) +
          "</td>" +
          '<td class="num-cell">' +
          fmtQty(it.quantity_received) +
          "</td>" +
          '<td class="num-cell">' +
          (rem > 0
            ? '<span class="badge st-warning">' + fmtQty(rem) + " left</span>"
            : '<span class="badge st-success">done</span>') +
          "</td>" +
          '<td class="num-cell">' +
          fmtMoney(it.unit_cost) +
          "</td>" +
          '<td class="num-cell">' +
          fmtMoney(
            it.line_total != null
              ? it.line_total
              : num(it.quantity_ordered) * num(it.unit_cost),
          ) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    m.foot.innerHTML = "";
    m.foot.appendChild(
      h("button", { class: "btn ghost", onClick: m.close }, "Close"),
    );

    function action(label, cls, path) {
      var btn = h("button", { class: "btn " + cls }, label);
      btn.addEventListener("click", async function () {
        var ok = await confirmDialog({
          title: label + " PO",
          message: label + " purchase order " + (po.po_number || po.id) + "?",
          okLabel: label,
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await apiFetch("/purchase-orders/" + po.id + "/" + path, {
            method: "POST",
          });
          toast("success", "Purchase order " + path + ".");
          if (onChanged) onChanged();
          refreshDetail();
        } catch (err) {
          toastError(err);
          btn.disabled = false;
        }
      });
      return btn;
    }

    if (st === "DRAFT" && manage)
      m.foot.appendChild(action("Submit", "primary", "submit"));
    if (st === "SUBMITTED" && staff)
      m.foot.appendChild(action("Approve", "success", "approve"));
    if ((st === "DRAFT" || st === "SUBMITTED") && manage)
      m.foot.appendChild(action("Cancel", "danger", "cancel"));
    if (canReceive) {
      var rx = h("button", { class: "btn primary" }, "📦 Receive delivery");
      rx.addEventListener("click", function () {
        renderReceiveForm(po);
      });
      m.foot.appendChild(rx);
    }
  }

  function renderReceiveForm(po) {
    m.body.innerHTML = "";
    m.body.appendChild(
      h(
        "p",
        { class: "confirm-msg" },
        "Enter the quantities received for each item, then confirm.",
      ),
    );
    var inputs = [];
    var list = h("div", {});
    (po.items || []).forEach(function (it) {
      var rem = Math.max(
        0,
        num(it.quantity_ordered) - num(it.quantity_received),
      );
      if (rem <= 0) return;
      var inp = h("input", {
        class: "input",
        type: "number",
        min: "0",
        max: String(rem),
        step: "1",
        value: String(rem),
      });
      inputs.push({ item: it, input: inp });
      list.appendChild(
        h(
          "div",
          { class: "po-item-row", style: "grid-template-columns:1fr 110px" },
          h(
            "div",
            {},
            h(
              "div",
              { class: "cl-name" },
              it.product_name || "#" + it.product_id,
            ),
            h(
              "div",
              { class: "cl-sku" },
              "ordered " +
                fmtQty(it.quantity_ordered) +
                " · received " +
                fmtQty(it.quantity_received),
            ),
          ),
          inp,
        ),
      );
    });
    var notes = h("input", {
      class: "input",
      placeholder: "Delivery notes (optional)",
    });
    if (inputs.length) {
      m.body.appendChild(list);
      m.body.appendChild(
        h(
          "div",
          { class: "field", style: "margin-top:10px" },
          h("label", { class: "label" }, "Notes"),
          notes,
        ),
      );
    } else {
      m.body.appendChild(
        h("div", { class: "empty" }, "Nothing left to receive on this order."),
      );
    }

    m.foot.innerHTML = "";
    var back = h("button", { class: "btn ghost" }, "← Back");
    back.addEventListener("click", refreshDetail);
    m.foot.appendChild(back);
    if (inputs.length) {
      var confirmBtn = h(
        "button",
        { class: "btn primary" },
        "Confirm delivery",
      );
      confirmBtn.addEventListener("click", async function () {
        var delivered = inputs
          .map(function (rec) {
            return {
              purchase_order_item_id: rec.item.id,
              quantity_received: Math.max(0, Math.round(num(rec.input.value))),
            };
          })
          .filter(function (d) {
            return d.quantity_received > 0;
          });
        if (!delivered.length) {
          toast("error", "Enter at least one received quantity.");
          return;
        }
        confirmBtn.disabled = true;
        try {
          await apiFetch("/purchase-orders/" + po.id + "/deliveries", {
            method: "POST",
            body: {
              deliveries: [
                { items: delivered, notes: notes.value.trim() || undefined },
              ],
            },
          });
          toast("success", "Delivery recorded.");
          if (onChanged) onChanged();
          refreshDetail();
        } catch (err) {
          toastError(err);
          confirmBtn.disabled = false;
        }
      });
      m.foot.appendChild(confirmBtn);
    }
  }

  await refreshDetail();
}

function openNewPoModal(onSaved) {
  var m = openModal({ title: "New purchase order", footer: true, wide: true });

  var supplierSel = h("select", { class: "select" });
  supplierSel.appendChild(h("option", { value: "" }, "— Supplier —"));
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "— Store —"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  if (state.storeId != null) storeSel.value = String(state.storeId);
  var expected = h("input", { class: "input", type: "date" });
  var notes = h("input", { class: "input", placeholder: "Notes (optional)" });

  apiFetch("/suppliers")
    .then(function (data) {
      itemsOf(data).forEach(function (s) {
        supplierSel.appendChild(h("option", { value: String(s.id) }, s.name));
      });
    })
    .catch(function (e) {
      toastError(e);
    });

  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Supplier"),
        supplierSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Destination store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Expected date"),
        expected,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Notes"),
        notes,
      ),
    ),
  );

  var rows = [];
  var rowsBox = h("div", {});
  var addRowBtn = h("button", { class: "btn ghost small" }, "+ Add item");
  addRowBtn.addEventListener("click", function () {
    addRow();
  });
  m.body.appendChild(
    h(
      "div",
      { class: "panel-head" },
      h("h3", {}, "Items"),
      h(
        "span",
        { class: "hint" },
        "Unit cost defaults to the product cost price",
      ),
    ),
  );
  m.body.appendChild(rowsBox);
  m.body.appendChild(h("div", { style: "margin-top:8px" }, addRowBtn));

  function addRow() {
    var row = h("div", { class: "po-item-row" });
    var picker = h("input", { class: "input", placeholder: "Search product…" });
    var qty = h("input", {
      class: "input",
      type: "number",
      min: "1",
      step: "1",
      value: "1",
    });
    var cost = h("input", {
      class: "input",
      type: "number",
      min: "0",
      step: "0.01",
      placeholder: "Unit cost",
    });
    var del = h(
      "button",
      { type: "button", class: "btn icon-btn", title: "Remove item" },
      "✕",
    );
    row.appendChild(picker);
    row.appendChild(qty);
    row.appendChild(cost);
    row.appendChild(del);
    rowsBox.appendChild(row);
    var rec = { product: null, qty: qty, cost: cost, row: row };
    rows.push(rec);
    attachProductPicker(picker, function (p) {
      rec.product = p;
      cost.value = p.cost_price != null ? String(round2(p.cost_price)) : "";
    });
    del.addEventListener("click", function () {
      var i = rows.indexOf(rec);
      if (i > -1) rows.splice(i, 1);
      row.remove();
    });
  }
  addRow();

  m.foot.innerHTML = "";
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  var save = h("button", { class: "btn primary" }, "Create purchase order");
  cancel.addEventListener("click", m.close);
  save.addEventListener("click", async function () {
    if (!supplierSel.value) {
      toast("error", "Pick a supplier.");
      return;
    }
    var items = rows
      .map(function (r) {
        if (!r.product) return null;
        var q = Math.round(num(r.qty.value));
        if (q <= 0) return null;
        var it = { product_id: r.product.id, quantity: q };
        if (r.cost.value !== "") it.unit_cost = round2(r.cost.value);
        return it;
      })
      .filter(Boolean);
    if (!items.length) {
      toast("error", "Add at least one item with a product and quantity.");
      return;
    }
    var body = { supplier_id: String(supplierSel.value), items: items };
    if (storeSel.value) body.store_id = String(storeSel.value);
    if (expected.value) body.expected_at = expected.value + "T00:00:00";
    if (notes.value.trim()) body.notes = notes.value.trim();
    save.disabled = true;
    try {
      await apiFetch("/purchase-orders", { method: "POST", body: body });
      toast("success", "Purchase order created.");
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
      save.disabled = false;
    }
  });
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

/* ============================================================
   16. Suppliers screen
   ============================================================ */

function renderSuppliers(content) {
  content.innerHTML = "";
  var search = h("input", { class: "input", placeholder: "Search suppliers…" });
  var addBtn = h("button", { class: "btn primary" }, "+ Add supplier");
  var tableBox = h("div", {});
  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field grow" },
        h("label", { class: "label" }, "Search"),
        search,
      ),
      h("div", { class: "spacer" }),
      addBtn,
    ),
  );
  content.appendChild(tableBox);
  search.addEventListener("input", debounce(load, 250));
  addBtn.addEventListener("click", function () {
    openSupplierModal(null, load);
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading suppliers…</div>';
    try {
      var data = await apiFetch("/suppliers");
      var items = itemsOf(data).filter(function (s) {
        var q = search.value.trim().toLowerCase();
        if (!q) return true;
        return (
          String(s.name || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(s.contact_name || "")
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(s.email || "")
            .toLowerCase()
            .indexOf(q) !== -1
        );
      });
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No suppliers found.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        "<thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Address</th><th></th></tr></thead>" +
        "<tbody>" +
        items
          .map(function (s) {
            return (
              '<tr data-id="' +
              esc(s.id) +
              '">' +
              "<td>" +
              esc(s.name) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(s.contact_name || "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(s.email || "—") +
              "</td>" +
              '<td class="muted-cell num-cell">' +
              esc(s.phone || "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(s.address || "—") +
              "</td>" +
              '<td class="cell-actions"><button class="btn ghost small" data-act="edit">Edit</button></td>' +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div></div>";

      tableBox.querySelector("tbody").addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        var row = btn.closest("tr[data-id]");
        var s = items.find(function (x) {
          return String(x.id) === row.dataset.id;
        });
        if (s) openSupplierModal(s, load);
      });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function openSupplierModal(existing, onSaved) {
  var isNew = !existing;
  var m = openModal({
    title: isNew ? "Add supplier" : "Edit supplier",
    footer: true,
  });
  var name = h("input", {
    class: "input",
    value: existing ? existing.name || "" : "",
  });
  var contact = h("input", {
    class: "input",
    value: existing ? existing.contact_name || "" : "",
  });
  var email = h("input", {
    class: "input",
    type: "email",
    value: existing ? existing.email || "" : "",
  });
  var phone = h("input", {
    class: "input",
    value: existing ? existing.phone || "" : "",
  });
  var address = h("input", {
    class: "input",
    value: existing ? existing.address || "" : "",
  });
  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Name *"),
      name,
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Contact person"),
        contact,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Email"),
        email,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Phone"),
        phone,
      ),
      h(
        "div",
        { class: "field full" },
        h("label", { class: "label" }, "Address"),
        address,
      ),
    ),
  );
  var save = h("button", { class: "btn primary" }, isNew ? "Create" : "Save");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    if (!name.value.trim()) {
      toast("error", "Name is required.");
      return;
    }
    var body = {
      name: name.value.trim(),
      contact_name: contact.value.trim() || undefined,
      email: email.value.trim() || undefined,
      phone: phone.value.trim() || undefined,
      address: address.value.trim() || undefined,
    };
    save.disabled = true;
    try {
      if (isNew) {
        await apiFetch("/suppliers", { method: "POST", body: body });
        toast("success", "Supplier created.");
      } else {
        await apiFetch("/suppliers/" + existing.id, {
          method: "PATCH",
          body: body,
        });
        toast("success", "Supplier updated.");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
    }
    save.disabled = false;
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
  name.focus();
}

/* ============================================================
   17. Customers screen
   ============================================================ */

function renderCustomers(content) {
  content.innerHTML = "";
  var search = h("input", {
    class: "input",
    placeholder: "Search name / phone…",
  });
  var addBtn = h("button", { class: "btn primary" }, "+ Add customer");
  var tableBox = h("div", {});
  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field grow" },
        h("label", { class: "label" }, "Search"),
        search,
      ),
      h("div", { class: "spacer" }),
      addBtn,
    ),
  );
  content.appendChild(tableBox);
  search.addEventListener("input", debounce(load, 250));
  addBtn.addEventListener("click", function () {
    openCustomerModal(null, load);
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading customers…</div>';
    try {
      var data = await apiFetch(
        "/customers" +
          qs({ search: search.value.trim() || undefined, per_page: 100 }),
      );
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No customers found.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="num-cell">Loyalty points</th><th class="num-cell">Total spent</th><th></th></tr></thead>' +
        "<tbody>" +
        items
          .map(function (c) {
            return (
              '<tr data-id="' +
              esc(c.id) +
              '">' +
              "<td>" +
              esc(c.name) +
              "</td>" +
              '<td class="num-cell muted-cell">' +
              esc(c.phone || "—") +
              "</td>" +
              '<td class="muted-cell">' +
              esc(c.email || "—") +
              "</td>" +
              '<td class="num-cell">' +
              num(c.loyalty_points != null ? c.loyalty_points : c.points) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(c.total_spent) +
              "</td>" +
              '<td class="cell-actions"><button class="btn ghost small" data-act="edit">Edit</button></td>' +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div></div>";

      tableBox.querySelector("tbody").addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        var row = btn.closest("tr[data-id]");
        var c = items.find(function (x) {
          return String(x.id) === row.dataset.id;
        });
        if (c) openCustomerModal(c, load);
      });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

function openCustomerModal(existing, onSaved) {
  var isNew = !existing;
  var m = openModal({
    title: isNew ? "Add customer" : "Edit customer",
    footer: true,
  });
  var name = h("input", {
    class: "input",
    value: existing ? existing.name || "" : "",
  });
  var phone = h("input", {
    class: "input",
    value: existing ? existing.phone || "" : "",
  });
  var email = h("input", {
    class: "input",
    type: "email",
    value: existing ? existing.email || "" : "",
  });
  m.body.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "label" }, "Name *"),
      name,
    ),
  );
  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Phone"),
        phone,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Email"),
        email,
      ),
    ),
  );
  var save = h("button", { class: "btn primary" }, isNew ? "Create" : "Save");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    if (!name.value.trim()) {
      toast("error", "Name is required.");
      return;
    }
    var body = {
      name: name.value.trim(),
      phone: phone.value.trim() || undefined,
      email: email.value.trim() || undefined,
    };
    save.disabled = true;
    try {
      if (isNew) {
        await apiFetch("/customers", { method: "POST", body: body });
        toast("success", "Customer created.");
      } else {
        await apiFetch("/customers/" + existing.id, {
          method: "PATCH",
          body: body,
        });
        toast("success", "Customer updated.");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
    }
    save.disabled = false;
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
  name.focus();
}

/* ============================================================
   18. Reports screen
   ============================================================ */

function renderReports(content) {
  content.innerHTML = "";
  var from = h("input", {
    class: "input",
    type: "date",
    value: inputToday(-6),
  });
  var to = h("input", { class: "input", type: "date", value: inputToday(0) });
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "All stores"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  storeSel.value = state.storeId != null ? String(state.storeId) : "";
  var loadBtn = h("button", { class: "btn primary" }, "Load reports");

  var cards = h("div", { class: "cards" });
  var dailyBox = h("div", {});
  var topBox = h("div", {});
  var profitBox = h("div", {});
  var empBox = h("div", {});
  var lowBox = h("div", {});
  var invBox = h("div", {});

  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "From"),
        from,
      ),
      h("div", { class: "field" }, h("label", { class: "label" }, "To"), to),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      loadBtn,
    ),
  );
  content.appendChild(cards);
  content.appendChild(
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Daily sales")),
        dailyBox,
      ),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Profit summary")),
        profitBox,
      ),
    ),
  );
  content.appendChild(
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Top products")),
        topBox,
      ),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Employee performance")),
        empBox,
      ),
    ),
  );
  content.appendChild(
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Low stock")),
        lowBox,
      ),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-head" }, h("h3", {}, "Inventory value")),
        invBox,
      ),
    ),
  );

  loadBtn.addEventListener("click", load);
  from.addEventListener("change", load);
  to.addEventListener("change", load);
  storeSel.addEventListener("change", load);

  load();

  async function load() {
    dailyBox.innerHTML = '<div class="loading">…</div>';
    topBox.innerHTML = '<div class="loading">…</div>';
    profitBox.innerHTML = '<div class="loading">…</div>';
    empBox.innerHTML = '<div class="loading">…</div>';
    lowBox.innerHTML = '<div class="loading">…</div>';
    invBox.innerHTML = '<div class="loading">…</div>';
    var f = from.value || inputToday(-6);
    var t = to.value || inputToday(0);
    var sid = storeSel.value || undefined;
    var sidLow = sid || (state.storeId != null ? state.storeId : undefined);

    var results = await Promise.allSettled([
      apiFetch("/reports/daily-sales" + qs({ from: f, to: t, store_id: sid })),
      apiFetch(
        "/reports/top-products" +
          qs({ from: f, to: t, store_id: sid, limit: 10 }),
      ),
      apiFetch("/reports/profit" + qs({ from: f, to: t, store_id: sid })),
      apiFetch("/reports/employee-performance" + qs({ from: f, to: t })),
      apiFetch("/reports/low-stock" + qs({ store_id: sidLow })),
      apiFetch("/reports/inventory-value" + qs({ store_id: sidLow })),
    ]);

    var daily =
      results[0].status === "fulfilled" ? itemsOf(results[0].value) : null;
    var profit = results[2].status === "fulfilled" ? results[2].value : null;
    var txCount = daily
      ? daily.reduce(function (s, d) {
          return s + num(d.transactions);
        }, 0)
      : 0;
    var revenue = profit
      ? num(profit.revenue)
      : daily
        ? daily.reduce(function (s, d) {
            return s + num(d.revenue);
          }, 0)
        : 0;
    var cardsData = [
      { label: "Transactions", value: String(txCount), sub: f + " → " + t },
      { label: "Revenue", value: fmtMoney(revenue), sub: "period total" },
      {
        label: "Gross profit",
        value: profit ? fmtMoney(profit.profit) : "—",
        sub: profit ? "margin " + round2(profit.margin_pct) + "%" : "",
      },
      {
        label: "Tax collected",
        value: daily
          ? fmtMoney(
              daily.reduce(function (s, d) {
                return s + num(d.tax);
              }, 0),
            )
          : "—",
        sub: "period total",
      },
      {
        label: "Discounts",
        value: daily
          ? fmtMoney(
              daily.reduce(function (s, d) {
                return s + num(d.total_discount);
              }, 0),
            )
          : "—",
        sub: "period total",
      },
    ];
    cards.innerHTML = cardsData
      .map(function (c) {
        return (
          '<div class="stat-card"><div class="stat-label">' +
          esc(c.label) +
          "</div>" +
          '<div class="stat-value">' +
          esc(c.value) +
          "</div>" +
          (c.sub ? '<div class="stat-sub">' + esc(c.sub) + "</div>" : "") +
          "</div>"
        );
      })
      .join("");

    if (daily === null) {
      dailyBox.innerHTML = "";
      dailyBox.appendChild(errorBox(results[0].reason));
    } else if (!daily.length)
      dailyBox.innerHTML = '<div class="empty">No sales in this period.</div>';
    else
      dailyBox.innerHTML =
        '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Day</th><th class="num-cell">Tx</th><th class="num-cell">Revenue</th><th class="num-cell">Tax</th><th class="num-cell">Discounts</th></tr></thead>' +
        "<tbody>" +
        daily
          .map(function (d) {
            return (
              "<tr><td>" +
              esc(String(d.day).slice(0, 10)) +
              "</td>" +
              '<td class="num-cell">' +
              num(d.transactions) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(d.revenue) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(d.tax) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(d.total_discount) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>";

    if (results[1].status !== "fulfilled") {
      topBox.innerHTML = "";
      topBox.appendChild(errorBox(results[1].reason));
    } else {
      var tops = itemsOf(results[1].value);
      topBox.innerHTML = tops.length
        ? '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>#</th><th>Product</th><th class="num-cell">Sold</th><th class="num-cell">Revenue</th><th class="num-cell">Profit</th></tr></thead>' +
          "<tbody>" +
          tops
            .map(function (p, i) {
              return (
                '<tr><td class="muted-cell">' +
                (i + 1) +
                "</td><td>" +
                esc(p.name) +
                "</td>" +
                '<td class="num-cell">' +
                fmtQty(p.quantity_sold) +
                "</td>" +
                '<td class="num-cell">' +
                fmtMoney(p.revenue) +
                "</td>" +
                '<td class="num-cell">' +
                fmtMoney(p.profit) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<div class="empty">No product sales in this period.</div>';
    }

    if (results[2].status !== "fulfilled") {
      profitBox.innerHTML = "";
      profitBox.appendChild(errorBox(results[2].reason));
    } else {
      var pr = results[2].value;
      profitBox.innerHTML =
        '<div class="cards" style="margin-bottom:0">' +
        '<div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">' +
        fmtMoney(pr.revenue) +
        "</div></div>" +
        '<div class="stat-card"><div class="stat-label">Cost of goods</div><div class="stat-value">' +
        fmtMoney(pr.cost) +
        "</div></div>" +
        '<div class="stat-card"><div class="stat-label">Profit</div><div class="stat-value">' +
        fmtMoney(pr.profit) +
        "</div></div>" +
        '<div class="stat-card"><div class="stat-label">Margin</div><div class="stat-value">' +
        round2(pr.margin_pct) +
        "%</div></div>" +
        "</div>";
    }

    if (results[3].status !== "fulfilled") {
      empBox.innerHTML = "";
      empBox.appendChild(errorBox(results[3].reason));
    } else {
      var emps = itemsOf(results[3].value);
      empBox.innerHTML = emps.length
        ? '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Cashier</th><th class="num-cell">Tx</th><th class="num-cell">Revenue</th><th class="num-cell">Avg ticket</th></tr></thead>' +
          "<tbody>" +
          emps
            .map(function (e) {
              /* The API returns revenue + tx count; average ticket is derived. */
              var avg =
                num(e.transactions) > 0
                  ? round2(num(e.revenue) / num(e.transactions))
                  : 0;
              return (
                "<tr><td>" +
                esc(e.name) +
                "</td>" +
                '<td class="num-cell">' +
                num(e.transactions) +
                "</td>" +
                '<td class="num-cell">' +
                fmtMoney(e.revenue) +
                "</td>" +
                '<td class="num-cell">' +
                fmtMoney(avg) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<div class="empty">No cashier activity.</div>';
    }

    if (results[4].status !== "fulfilled") {
      lowBox.innerHTML = "";
      lowBox.appendChild(errorBox(results[4].reason));
    } else {
      var lows = itemsOf(results[4].value);
      lowBox.innerHTML = lows.length
        ? '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>SKU</th><th>Product</th><th class="num-cell">Qty</th><th class="num-cell">Threshold</th></tr></thead>' +
          "<tbody>" +
          lows
            .map(function (p) {
              return (
                '<tr><td class="num-cell muted-cell">' +
                esc(p.sku || "") +
                "</td><td>" +
                esc(p.name) +
                "</td>" +
                '<td class="num-cell"><span class="badge st-warning">' +
                fmtQty(p.quantity) +
                "</span></td>" +
                '<td class="num-cell muted-cell">' +
                fmtQty(p.reorder_threshold) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<div class="empty">Nothing below reorder point. 🎉</div>';
    }

    if (results[5].status !== "fulfilled") {
      invBox.innerHTML = "";
      invBox.appendChild(errorBox(results[5].reason));
    } else {
      var inv = results[5].value;
      var invItems = inv && inv.items ? inv.items : [];
      invBox.innerHTML =
        '<div class="stat-card" style="margin-bottom:10px"><div class="stat-label">Total inventory value</div>' +
        '<div class="stat-value">' +
        fmtMoney(inv.total_value) +
        "</div></div>" +
        '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>SKU</th><th>Product</th><th class="num-cell">Qty</th><th class="num-cell">Cost</th><th class="num-cell">Value</th></tr></thead>' +
        "<tbody>" +
        invItems
          .slice(0, 15)
          .map(function (p) {
            return (
              '<tr><td class="num-cell muted-cell">' +
              esc(p.sku || "") +
              "</td><td>" +
              esc(p.name) +
              "</td>" +
              '<td class="num-cell">' +
              fmtQty(p.quantity) +
              "</td>" +
              '<td class="num-cell">' +
              fmtMoney(p.cost_price) +
              "</td>" +
              '<td class="num-cell">' +
              /* the API sends quantity + cost only — value is derived */
              fmtMoney(round2(num(p.quantity) * num(p.cost_price))) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>" +
        (invItems.length > 15
          ? '<div class="hint">Showing 15 of ' +
            invItems.length +
            " items.</div>"
          : "");
    }
  }
}

/* ============================================================
   19. Users screen (admin / manager)
   ============================================================ */

function renderUsers(content) {
  content.innerHTML = "";
  var roleSel = h("select", { class: "select" });
  roleSel.appendChild(h("option", { value: "" }, "All roles"));
  ROLES.forEach(function (r) {
    roleSel.appendChild(h("option", { value: r }, r.replace("_", " ")));
  });
  var addBtn = h("button", { class: "btn primary" }, "+ Add user");
  var tableBox = h("div", {});
  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Role"),
        roleSel,
      ),
      h("div", { class: "spacer" }),
      addBtn,
    ),
  );
  content.appendChild(tableBox);
  roleSel.addEventListener("change", load);
  addBtn.addEventListener("click", function () {
    openUserCreateModal(load);
  });

  load();

  async function load() {
    tableBox.innerHTML = '<div class="loading">Loading users…</div>';
    try {
      var data = await apiFetch(
        "/users" + qs({ role: roleSel.value || undefined, per_page: 100 }),
      );
      var items = itemsOf(data);
      if (!items.length) {
        tableBox.innerHTML =
          '<div class="panel"><div class="empty">No users found.</div></div>';
        return;
      }
      tableBox.innerHTML =
        '<div class="panel"><div class="table-wrap"><table class="table">' +
        "<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th>Store</th><th></th></tr></thead>" +
        "<tbody>" +
        items
          .map(function (u) {
            var isAdminTarget = String(u.role).toUpperCase() === "ADMIN";
            var canEdit =
              role() === "ADMIN" || (role() === "MANAGER" && !isAdminTarget);
            return (
              '<tr data-id="' +
              esc(u.id) +
              '">' +
              "<td>" +
              esc(u.name) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(u.email || "—") +
              "</td>" +
              '<td class="num-cell muted-cell">' +
              esc(u.phone || "—") +
              "</td>" +
              "<td>" +
              roleBadgeHTML(u.role) +
              "</td>" +
              "<td>" +
              stBadge(u.account_status) +
              "</td>" +
              '<td class="muted-cell">' +
              esc(u.store_id != null ? storeName(u.store_id) : "—") +
              "</td>" +
              '<td class="cell-actions">' +
              (canEdit
                ? '<button class="btn ghost small" data-act="edit">Edit</button>'
                : "") +
              (role() === "ADMIN" && u.id !== state.user.id
                ? '<button class="btn danger small" data-act="del">Suspend</button>'
                : "") +
              "</td>" +
              "</tr>"
            );
          })
          .join("") +
        "</tbody></table></div></div>";

      tableBox
        .querySelector("tbody")
        .addEventListener("click", async function (ev) {
          var btn = ev.target.closest("button[data-act]");
          if (!btn) return;
          var row = btn.closest("tr[data-id]");
          var u = items.find(function (x) {
            return String(x.id) === row.dataset.id;
          });
          if (!u) return;
          if (btn.dataset.act === "edit") {
            openUserEditModal(u, load);
            return;
          }
          /* DELETE /users/{id} is a soft delete — the account is suspended. */
          var ok = await confirmDialog({
            title: "Suspend user",
            message:
              'Suspend "' +
              u.name +
              '"? They will no longer be able to sign in.',
            danger: true,
            okLabel: "Suspend",
          });
          if (!ok) return;
          try {
            await apiFetch("/users/" + u.id, { method: "DELETE" });
            toast("success", "User suspended.");
            load();
          } catch (err) {
            toastError(err);
          }
        });
    } catch (err) {
      tableBox.innerHTML = "";
      tableBox.appendChild(h("div", { class: "panel" }, errorBox(err)));
    }
  }
}

/* Create user → POST /auth/register (admin/manager only per backend). */
function openUserCreateModal(onSaved) {
  var m = openModal({ title: "Add user", footer: true, wide: true });
  var name = h("input", { class: "input" });
  var email = h("input", { class: "input", type: "email" });
  var phone = h("input", { class: "input" });
  var password = h("input", { class: "input", type: "password" });
  var pin = h("input", {
    class: "input",
    inputmode: "numeric",
    maxlength: "8",
    placeholder: "4–8 digits (optional)",
  });
  var roleSel = h("select", { class: "select" });
  ROLES.forEach(function (r) {
    roleSel.appendChild(h("option", { value: r }, r.replace("_", " ")));
  });
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "— None —"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  var supplierSel = h("select", { class: "select" });
  supplierSel.appendChild(h("option", { value: "" }, "— None —"));
  apiFetch("/suppliers")
    .then(function (data) {
      itemsOf(data).forEach(function (s) {
        supplierSel.appendChild(h("option", { value: String(s.id) }, s.name));
      });
    })
    .catch(function (e) {
      /* supplier list optional */
    });

  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Name *"),
        name,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Email *"),
        email,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Phone"),
        phone,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Password *"),
        password,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "PIN (optional)"),
        pin,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Role"),
        roleSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Supplier (for SUPPLIER role)"),
        supplierSel,
      ),
    ),
  );

  var save = h("button", { class: "btn primary" }, "Create user");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    if (!name.value.trim() || !email.value.trim() || !password.value) {
      toast("error", "Name, email and password are required.");
      return;
    }
    if (pin.value && !/^\d{4,8}$/.test(pin.value)) {
      toast("error", "PIN must be 4–8 digits.");
      return;
    }
    var body = {
      name: name.value.trim(),
      email: email.value.trim(),
      phone: phone.value.trim() || undefined,
      password: password.value,
      role: roleSel.value,
    };
    if (pin.value) body.pin = pin.value;
    if (storeSel.value) body.store_id = String(storeSel.value);
    if (roleSel.value === "SUPPLIER" && supplierSel.value)
      body.supplier_id = String(supplierSel.value);
    save.disabled = true;
    try {
      await apiFetch("/auth/register", { method: "POST", body: body });
      toast("success", "User created.");
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
      save.disabled = false;
    }
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

/* Edit user → PATCH /users/{id} (status, role, password/pin resets). */
function openUserEditModal(u, onSaved) {
  var m = openModal({
    title: "Edit user — " + u.name,
    footer: true,
    wide: true,
  });
  var name = h("input", { class: "input", value: u.name || "" });
  var phone = h("input", { class: "input", value: u.phone || "" });
  var roleSel = h("select", { class: "select" });
  ROLES.forEach(function (r) {
    var opt = h("option", { value: r }, r.replace("_", " "));
    roleSel.appendChild(opt);
  });
  roleSel.value = u.role || "CASHIER";
  var statusSel = h("select", { class: "select" });
  ["ACTIVE", "SUSPENDED"].forEach(function (s) {
    statusSel.appendChild(h("option", { value: s }, s));
  });
  statusSel.value = u.account_status || "ACTIVE";
  var password = h("input", {
    class: "input",
    type: "password",
    placeholder: "Leave blank to keep current",
  });
  var pin = h("input", {
    class: "input",
    inputmode: "numeric",
    maxlength: "8",
    placeholder: "New PIN — blank to keep",
  });
  var storeSel = h("select", { class: "select" });
  storeSel.appendChild(h("option", { value: "" }, "— None —"));
  state.stores.forEach(function (s) {
    storeSel.appendChild(
      h(
        "option",
        { value: String(s.id) },
        (s.code ? s.code + " — " : "") + s.name,
      ),
    );
  });
  if (u.store_id != null) storeSel.value = String(u.store_id);
  var supplierSel = h("select", { class: "select" });
  supplierSel.appendChild(h("option", { value: "" }, "— None —"));
  apiFetch("/suppliers")
    .then(function (data) {
      itemsOf(data).forEach(function (s) {
        supplierSel.appendChild(h("option", { value: String(s.id) }, s.name));
      });
      if (u.supplier_id != null) supplierSel.value = String(u.supplier_id);
    })
    .catch(function (e) {
      /* optional */
    });

  m.body.appendChild(
    h(
      "div",
      { class: "form-grid" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Name"),
        name,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Phone"),
        phone,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Role"),
        roleSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Status"),
        statusSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Reset password"),
        password,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Reset PIN"),
        pin,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Store"),
        storeSel,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Supplier"),
        supplierSel,
      ),
    ),
  );

  var save = h("button", { class: "btn primary" }, "Save changes");
  var cancel = h("button", { class: "btn ghost" }, "Cancel");
  save.addEventListener("click", async function () {
    if (pin.value && !/^\d{4,8}$/.test(pin.value)) {
      toast("error", "PIN must be 4–8 digits.");
      return;
    }
    var body = {
      name: name.value.trim(),
      phone: phone.value.trim() || undefined,
      role: roleSel.value,
      account_status: statusSel.value,
      store_id: storeSel.value ? String(storeSel.value) : undefined,
      supplier_id: supplierSel.value ? String(supplierSel.value) : undefined,
    };
    if (password.value) body.password = password.value;
    if (pin.value) body.pin = pin.value;
    save.disabled = true;
    try {
      await apiFetch("/users/" + u.id, { method: "PATCH", body: body });
      toast("success", "User updated.");
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      toastError(err);
      save.disabled = false;
    }
  });
  cancel.addEventListener("click", m.close);
  m.foot.appendChild(cancel);
  m.foot.appendChild(save);
}

/* ============================================================
   20. Notifications screen + header bell polling
   ============================================================ */

async function refreshBellCount() {
  try {
    var data = await apiFetch("/notifications" + qs({ per_page: 5 }));
    var count =
      data && typeof data.unread_count === "number"
        ? data.unread_count
        : itemsOf(data).filter(function (n) {
            return !n.is_read;
          }).length;
    var badge = $("#bell-badge");
    if (badge) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = !count;
    }
  } catch (e) {
    /* silent — polling must never spam toasts */
  }
}

function startNotifPolling() {
  stopNotifPolling();
  refreshBellCount();
  state.notifTimer = setInterval(refreshBellCount, 30000);
}
function stopNotifPolling() {
  if (state.notifTimer) {
    clearInterval(state.notifTimer);
    state.notifTimer = null;
  }
}

function renderNotifications(content) {
  content.innerHTML = "";
  var unreadOnly = h("input", { type: "checkbox" });
  var refreshBtn = h("button", { class: "btn ghost" }, "↻ Refresh");
  var markAllBtn = h("button", { class: "btn primary" }, "Mark all read");
  var listBox = h("div", { class: "notif-list" });

  content.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Filters"),
        h("label", { class: "checkbox-row" }, unreadOnly, "Unread only"),
      ),
      h("div", { class: "spacer" }),
      refreshBtn,
      markAllBtn,
    ),
  );
  content.appendChild(listBox);

  unreadOnly.addEventListener("change", load);
  refreshBtn.addEventListener("click", load);
  markAllBtn.addEventListener("click", async function () {
    markAllBtn.disabled = true;
    try {
      await apiFetch("/notifications/read-all", { method: "POST" });
      toast("success", "All notifications marked read.");
      refreshBellCount();
      load();
    } catch (err) {
      toastError(err);
      markAllBtn.disabled = false;
    }
  });

  load();

  async function load() {
    listBox.innerHTML = '<div class="loading">Loading notifications…</div>';
    try {
      var data = await apiFetch(
        "/notifications" +
          qs({
            unread: unreadOnly.checked ? "true" : undefined,
            per_page: 50,
          }),
      );
      var items = itemsOf(data);
      refreshBellCount();
      if (!items.length) {
        listBox.innerHTML =
          '<div class="panel"><div class="empty">No notifications. 🔕</div></div>';
        return;
      }
      listBox.innerHTML = "";
      items.forEach(function (n) {
        var item = h(
          "div",
          { class: "notif" + (n.is_read ? "" : " unread") },
          h("span", { class: "notif-dot" + (n.is_read ? " read" : "") }),
          h(
            "div",
            { class: "notif-main" },
            h(
              "div",
              { class: "notif-title-row" },
              h("span", { class: "badge st-info" }, n.type || "INFO"),
              h("span", { class: "notif-title" }, n.title || ""),
            ),
            h("div", { class: "notif-msg" }, n.message || ""),
            h("div", { class: "notif-time" }, relTime(n.created_at)),
          ),
          h("div", { class: "notif-side" }),
        );
        if (!n.is_read) {
          var btn = h("button", { class: "btn ghost small" }, "Mark read");
          btn.addEventListener("click", async function () {
            btn.disabled = true;
            try {
              await apiFetch("/notifications/" + n.id + "/read", {
                method: "POST",
              });
              refreshBellCount();
              load();
            } catch (err) {
              toastError(err);
              btn.disabled = false;
            }
          });
          item.querySelector(".notif-side").appendChild(btn);
        }
        listBox.appendChild(item);
      });
    } catch (err) {
      listBox.innerHTML = "";
      listBox.appendChild(errorBox(err));
    }
  }
}

/* ============================================================
   21. Boot
   ============================================================ */

async function init() {
  await loadConfig();
  var saved = loadAuth();
  if (saved && saved.access_token) {
    state.token = saved.access_token;
    state.refreshToken = saved.refresh_token || null;
    state.user = saved.user || null;
    try {
      var me = await apiFetch("/auth/me");
      state.user = me && me.user ? me.user : me;
      saveAuth();
      await startApp();
      return;
    } catch (err) {
      if (err.status === 401 && (await tryRefresh())) {
        try {
          var me2 = await apiFetch("/auth/me");
          state.user = me2 && me2.user ? me2.user : me2;
          saveAuth();
          await startApp();
          return;
        } catch (err2) {
          logout(err2.message);
          return;
        }
      }
      logout("Session expired. Please sign in again.");
      return;
    }
  }
  showLogin();
}

init().catch(function (err) {
  console.error(err);
  toast("error", (err && err.message) || "Initialisation failed");
  showLogin();
});
