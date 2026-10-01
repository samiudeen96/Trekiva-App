/*! Welcome popup storefront script. Vanilla JS, no dependencies, loaded with `defer`. */
(function () {
  "use strict";

  var DAY = 86400000;

  // ---- Pure helpers (unit-tested) --------------------------------------------------
  function matchPath(patterns, path) {
    var p = path.length > 1 ? path.replace(/\/+$/, "") : path;
    return patterns.some(function (raw) {
      var pat = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
      if (pat.slice(-1) === "*") return p.indexOf(pat.slice(0, -1)) === 0;
      return p === pat;
    });
  }

  /**
   * Decides whether a campaign may be shown right now.
   * env: { now, path, isMobile, pageViews, isReload, preview }
   * state: persisted per-campaign { claimed, lastShown } ; session: { shown }
   */
  function qualifies(rules, env, state, session) {
    if (env.preview) return true;
    if (rules.device === "DESKTOP" && env.isMobile) return false;
    if (rules.device === "MOBILE" && !env.isMobile) return false;
    if (rules.pages === "SELECTED" && !matchPath(rules.paths || [], env.path)) return false;
    if (rules.stopAfterClaim && state.claimed) return false;
    if (env.pageViews < rules.minPageViews) return false;
    switch (rules.frequency) {
      case "EVERY_PAGE_LOAD":
      case "UNTIL_CLAIMED":
        return true;
      case "EVERY_REFRESH":
        return env.isReload || !session.shown;
      case "ONCE_PER_SESSION":
        return !session.shown;
      case "ONCE_EVERY_X_DAYS":
        return !state.lastShown || env.now - state.lastShown >= rules.frequencyDays * DAY;
      default:
        return true;
    }
  }

  /* istanbul ignore next */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { matchPath: matchPath, qualifies: qualifies };
    return;
  }

  // ---- Browser runtime -------------------------------------------------------------
  var script = document.getElementById("twp-script");
  if (!script || window.__twpLoaded) return;
  window.__twpLoaded = true;

  var d = script.dataset;
  var params = new URLSearchParams(location.search);
  var preview = params.get("twp_preview");
  var inEditor = d.designMode === "true";
  var forceInEditor = inEditor && d.disableInEditor !== "true";

  function store(area) {
    return {
      get: function (k) {
        try { return JSON.parse(window[area].getItem(k)) || {}; } catch (e) { return {}; }
      },
      set: function (k, v) {
        try { window[area].setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
      },
    };
  }
  var local = store("localStorage");
  var sess = store("sessionStorage");

  // Page views this session (no network; counted before anything is fetched).
  var pv = (sess.get("twp:pv").n || 0) + 1;
  sess.set("twp:pv", { n: pv });

  var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  var isReload = !!nav && nav.type === "reload";
  var root = d.root && d.root !== "/" ? d.root.replace(/\/+$/, "") : "";
  var path = location.pathname;
  if (root && path.indexOf(root) === 0) path = path.slice(root.length) || "/";

  function isMobile() {
    return window.matchMedia("(max-width: 749px)").matches;
  }

  function api(name) {
    return d.proxy + "/" + name + "?shop=" + encodeURIComponent(d.shop);
  }

  function pick(campaigns) {
    var env = { now: Date.now(), path: path, isMobile: isMobile(), pageViews: pv, isReload: isReload };
    for (var i = 0; i < campaigns.length; i++) {
      var c = campaigns[i];
      env.preview = preview === c.id || forceInEditor;
      if (qualifies(c.rules, env, local.get("twp:" + c.id), sess.get("twp:s:" + c.id))) return c;
    }
    return null;
  }

  function schedule(c, env) {
    var r = c.rules;
    var showNow = function () { show(c); };
    if (env.force) return showNow();
    if (r.trigger === "EXIT_INTENT" && !isMobile()) {
      var armedAt = Date.now();
      var onOut = function (e) {
        if (!e.relatedTarget && e.clientY <= 0 && Date.now() - armedAt > 1500) {
          document.removeEventListener("mouseout", onOut);
          showNow();
        }
      };
      document.addEventListener("mouseout", onOut);
      return;
    }
    setTimeout(showNow, Math.max(0, r.delaySeconds) * 1000);
  }

  function loadCss() {
    return new Promise(function (resolve) {
      if (document.querySelector("link[data-twp-css]")) return resolve();
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = d.css;
      l.setAttribute("data-twp-css", "");
      l.onload = l.onerror = function () { resolve(); };
      document.head.appendChild(l);
      setTimeout(resolve, 2500); // never block the popup on a slow stylesheet
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent only: merchant text is never parsed as HTML
    return n;
  }

  // Per-visitor countdown: starts the first time the popup is shown, then runs to zero.
  function countdown(body, c) {
    var hours = c.content.countdownHours;
    if (!hours) return function () {};
    var key = "twp:cd:" + c.id;
    var end = Number(local.get(key).end);
    if (!end) {
      end = Date.now() + hours * 3600000;
      local.set(key, { end: end });
    }
    var wrap = el("div", "twp__cd");
    wrap.setAttribute("role", "timer"); // announced on demand only, not every tick
    var cells = [0, 1, 2, 3].map(function () { return el("span", "twp__cd-cell", "00"); });
    cells.forEach(function (cell, i) {
      if (i) wrap.appendChild(el("span", "twp__cd-sep", ":"));
      wrap.appendChild(cell);
    });
    body.appendChild(wrap);
    function tick() {
      var left = Math.max(0, end - Date.now());
      var parts = [Math.floor(left / 86400000), Math.floor(left / 3600000) % 24, Math.floor(left / 60000) % 60, Math.floor(left / 1000) % 60];
      cells.forEach(function (cell, i) { cell.textContent = (parts[i] < 10 ? "0" : "") + parts[i]; });
      wrap.setAttribute("aria-label", parts[0] + " d " + parts[1] + " h " + parts[2] + " min " + parts[3] + " s");
    }
    tick();
    var id = setInterval(tick, 1000);
    return function () { clearInterval(id); };
  }

  var shown = false;
  function show(c) {
    if (shown || document.querySelector("dialog.twp")) return;
    shown = true;
    loadCss().then(function () { render(c); });
  }

  function render(c) {
    var tpl = c.template || "CLASSIC";
    var dlg = el("dialog", "twp twp--" + tpl.toLowerCase());
    dlg.setAttribute("aria-labelledby", "twp-title");
    dlg.setAttribute("aria-describedby", "twp-desc");
    var st = c.style;
    dlg.style.setProperty("--twp-bg", st.backgroundColor);
    dlg.style.setProperty("--twp-fg", st.textColor);
    dlg.style.setProperty("--twp-btn", st.buttonColor);
    dlg.style.setProperty("--twp-btn-fg", st.buttonTextColor);

    var panel = el("div", "twp__panel");
    if (tpl !== "CLASSIC" || c.content.imageUrl) {
      var img = el("div", "twp__img has-img");
      if (c.content.imageUrl && /^https:\/\//.test(c.content.imageUrl)) {
        img.style.backgroundImage = 'url("' + c.content.imageUrl.replace(/["\\\n\r]/g, "") + '")';
      } else {
        img.classList.add("twp__img--fallback"); // gradient so split templates never look broken without an image
      }
      img.setAttribute("aria-hidden", "true");
      panel.appendChild(img);
    }

    var body = el("div", "twp__body");
    var no = null;
    var close = el("button", "twp__close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", d.closeLabel || "Close");

    var form = el("form", "twp__form");
    form.noValidate = true;
    var title = el("h2", "twp__title", c.content.title);
    title.id = "twp-title";
    var desc = el("p", "twp__desc", c.content.description);
    desc.id = "twp-desc";
    var label = el("label", "twp__sr", d.emailLabel || "Email address");
    label.htmlFor = "twp-email";
    var email = el("input", "twp__input");
    email.type = "email";
    email.id = "twp-email";
    email.name = "email";
    email.required = true;
    email.autocomplete = "email";
    email.inputMode = "email";
    email.maxLength = 254;
    email.placeholder = c.content.emailPlaceholder || "";
    var hp = el("input", "twp__hp"); // honeypot: invisible to people, tempting to bots
    hp.type = "text";
    hp.name = "website";
    hp.tabIndex = -1;
    hp.autocomplete = "off";
    hp.setAttribute("aria-hidden", "true");
    var btn = el("button", "twp__btn", c.content.buttonText);
    btn.type = "submit";
    var msg = el("p", "twp__msg");
    msg.setAttribute("role", "status");
    msg.setAttribute("aria-live", "polite");

    form.append(label, email, hp, btn);
    body.append(title);
    if (c.content.subtitle) body.appendChild(el("p", "twp__sub", c.content.subtitle));
    body.appendChild(desc);
    var stopTimer = countdown(body, c);
    body.append(form, msg);
    if (c.content.declineText) {
      no = el("button", "twp__decline", c.content.declineText);
      no.type = "button";
      no.addEventListener("click", function () { dlg.close(); });
      body.appendChild(no);
    }
    if (c.content.privacyNote) body.appendChild(el("p", "twp__note", c.content.privacyNote));
    panel.append(body, close);
    dlg.appendChild(panel);
    document.body.appendChild(dlg);

    // Record the showing before anything can fail.
    var key = "twp:" + c.id;
    var state = local.get(key);
    state.lastShown = Date.now();
    local.set(key, state);
    sess.set("twp:s:" + c.id, { shown: true });

    function done(text) {
      form.hidden = true;
      if (no) no.hidden = true;
      msg.dataset.state = "done";
      msg.textContent = text;
      var s = local.get(key);
      s.claimed = true;
      local.set(key, s);
      close.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (btn.disabled) return;
      if (!email.value.trim() || !email.checkValidity()) {
        msg.dataset.state = "error";
        msg.textContent = d.invalidEmail || "Please enter a valid email address.";
        email.setAttribute("aria-invalid", "true");
        email.focus();
        return;
      }
      email.removeAttribute("aria-invalid");
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      var original = btn.textContent;
      btn.textContent = d.sending || "Sending...";
      msg.dataset.state = "";
      msg.textContent = "";

      fetch(d.proxy + "/welcome-claim?shop=" + encodeURIComponent(d.shop), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: d.shop,
          campaignId: c.id,
          email: email.value,
          token: c.token,
          website: hp.value,
        }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (res) {
          // Server is the source of truth; this only decides what to display.
          if (res.status === "success" || res.status === "already_claimed" || res.status === "not_eligible") {
            return done(res.message);
          }
          throw new Error(res.message || c.content.errorMessage);
        })
        .catch(function (err) {
          msg.dataset.state = "error";
          msg.textContent = (err && err.message) || c.content.errorMessage;
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          btn.textContent = original;
          email.focus();
        });
    });

    function dismiss() {
      dlg.close();
    }
    close.addEventListener("click", dismiss);
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) dismiss(); // backdrop click
    });
    dlg.addEventListener("close", function () {
      stopTimer();
      dlg.remove(); // <dialog> restores focus to the previously focused element
    });

    dlg.showModal(); // focus trap, inert background and ESC-to-close come from the platform
    email.focus();

    try {
      var payload = new Blob([JSON.stringify({ shop: d.shop, campaignId: c.id, type: "view" })], { type: "application/json" });
      if (!navigator.sendBeacon(api("welcome-event"), payload)) throw 0;
    } catch (e) {
      fetch(api("welcome-event"), {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: d.shop, campaignId: c.id, type: "view" }),
      }).catch(function () {});
    }
  }

  function start() {
    // Runs after load + idle, so it never competes with LCP/INP work.
    fetch(api("welcome-config"), { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : { campaigns: [] }; })
      .then(function (cfg) {
        var c = pick(cfg.campaigns || []);
        if (c) schedule(c, { force: preview === c.id || forceInEditor });
      })
      .catch(function () { /* popup is optional; fail silently */ });
  }

  function whenIdle() {
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1200);
  }
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
})();
