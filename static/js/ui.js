"use strict";

(function () {
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function initConfirm() {
    if (typeof document.querySelectorAll !== "function") return;
    var forms = document.querySelectorAll("form[data-confirm]");
    if (!forms || forms.length === 0) return;
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener("submit", function (event) {
        var message = form.getAttribute("data-confirm");
        if (!message) return;
        if (typeof window.confirm !== "function") return;
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      });
    });
  }

  function toNumber(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function initRubricSum() {
    if (typeof document.querySelectorAll !== "function") return;
    var outputs = document.querySelectorAll("[data-output]");
    if (!outputs || outputs.length === 0) return;
    Array.prototype.forEach.call(outputs, function (output) {
      var key = output.getAttribute("data-output");
      if (!key) return;
      var fields = document.querySelectorAll(
        '[data-criteria="' + key + '"]'
      );
      if (!fields || fields.length === 0) return;
      var update = function () {
        var total = 0;
        Array.prototype.forEach.call(fields, function (field) {
          total += toNumber(field.value);
        });
        output.textContent = String(total);
      };
      Array.prototype.forEach.call(fields, function (field) {
        field.addEventListener("input", update);
        field.addEventListener("change", update);
      });
      update();
    });
  }

  function initComposite() {
    if (typeof document.querySelectorAll !== "function") return;
    var forms = document.querySelectorAll("form[data-composite-form]");
    if (!forms || forms.length === 0) return;
    Array.prototype.forEach.call(forms, function (form) {
      var output = form.querySelector("[data-composite-output]");
      var fields = form.querySelectorAll("[data-criterion]");
      if (!output || !fields || fields.length === 0) return;
      var update = function () {
        var total = 0;
        Array.prototype.forEach.call(fields, function (field) {
          var weight = toNumber(field.getAttribute("data-weight"));
          total += (weight / 100) * toNumber(field.value);
        });
        // Mirror the server composite (compositeFor): round to 2dp, clamp 0..100.
        total = Math.round(total * 100) / 100;
        if (total < 0) total = 0;
        if (total > 100) total = 100;
        output.textContent = String(total);
      };
      Array.prototype.forEach.call(fields, function (field) {
        field.addEventListener("input", update);
        field.addEventListener("change", update);
      });
      update();
    });
  }

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function initTrackHint() {
    if (typeof document.querySelectorAll !== "function") return;
    var hint = document.querySelector("[data-track-hint]");
    var field = document.getElementById("track");
    if (!hint || !field) return;
    var update = function () {
      var v = field.value || "";
      // Mirror the server guard in src/routes/gallery.ts: only UUID-typed
      // track values reach the DB; anything else is ignored server-side.
      // The form works without JS; this hint only makes that visible.
      hint.hidden = v === "" || UUID_RE.test(v);
    };
    field.addEventListener("input", update);
    field.addEventListener("change", update);
    update();
  }

  function initPendingState() {
    if (typeof document.querySelectorAll !== "function") return;
    var forms = document.querySelectorAll('form[method="post"]');
    if (!forms || forms.length === 0) return;
    var release = function (form) {
      form.removeAttribute("aria-busy");
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = false;
    };
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener("submit", function (event) {
        // A cancelled confirm dialog also fires submit listeners; never
        // lock the form when another handler already prevented submission.
        if (event.defaultPrevented) return;
        var btn = form.querySelector('[type="submit"]');
        if (btn) btn.disabled = true;
        form.setAttribute("aria-busy", "true");
      });
      // Restores the button when returning via back/forward cache.
      window.addEventListener("pageshow", function () {
        release(form);
      });
    });
  }

  function formatRemaining(ms) {
    if (ms <= 0) return "Closed";
    var totalSeconds = Math.floor(ms / 1000);
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    function pad(n) {
      return (n < 10 ? "0" : "") + n;
    }
    if (days > 0) {
      return days + "d " + pad(hours) + "h " + pad(minutes) + "m";
    }
    return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
  }

  function initCountdown() {
    if (typeof document.querySelectorAll !== "function") return;
    var nodes = document.querySelectorAll("[data-deadline]");
    if (!nodes || nodes.length === 0) return;
    Array.prototype.forEach.call(nodes, function (node) {
      var iso = node.getAttribute("data-deadline");
      if (!iso) return;
      var target = Date.parse(iso);
      if (isNaN(target)) return;
      var render = function () {
        var remaining = target - Date.now();
        node.textContent = formatRemaining(remaining);
        if (remaining <= 0) {
          node.classList.add("countdown--urgent");
        }
      };
      render();
      window.setInterval(render, 1000);
    });
  }

  function initSlugAuto() {
    if (typeof document.querySelectorAll !== "function") return;
    var sources = document.querySelectorAll("[data-slug-source]");
    if (!sources || sources.length === 0) return;
    Array.prototype.forEach.call(sources, function (source) {
      var targetId = source.getAttribute("data-slug-source");
      var target = document.getElementById(targetId);
      if (!target) return;
      var userEdited = target.value.trim().length > 0;
      target.addEventListener("input", function () {
        userEdited = target.value.trim().length > 0;
      });
      source.addEventListener("input", function () {
        if (userEdited) return;
        var slug = source.value
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .substring(0, 100);
        target.value = slug;
      });
    });
  }

  function initUserDropdown() {
    if (typeof document.querySelectorAll !== "function") return;
    var roots = document.querySelectorAll("[data-dropdown]");
    if (!roots || roots.length === 0) return;
    Array.prototype.forEach.call(roots, function (root) {
      var toggle = root.querySelector("[data-dropdown-toggle]");
      var menu = root.querySelector("[data-dropdown-menu]");
      if (!toggle || !menu) return;
      var close = function () {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      };
      var open = function () {
        menu.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      };
      toggle.addEventListener("click", function (event) {
        event.stopPropagation();
        if (menu.hidden) {
          open();
        } else {
          close();
        }
      });
      document.addEventListener("click", function (event) {
        if (!menu.hidden && !root.contains(event.target)) {
          close();
        }
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !menu.hidden) {
          close();
          toggle.focus();
        }
      });
      menu.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          close();
          toggle.focus();
        }
      });
    });
  }

  function initSearchShortcut() {
    var input = document.querySelector("[data-global-search]");
    if (!input) return;
    document.addEventListener("keydown", function (event) {
      var isMac = typeof navigator !== "undefined" && navigator.platform &&
        navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      var mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  function initMobileNav() {
    var toggle = document.querySelector("[data-mobile-toggle]");
    var nav = document.querySelector("[data-mobile-nav]");
    if (!toggle || !nav) return;
    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      var expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      nav.hidden = expanded;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !nav.hidden) {
        nav.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  onReady(function () {
    initConfirm();
    initRubricSum();
    initComposite();
    initCountdown();
    initTrackHint();
    initPendingState();
    initSlugAuto();
    initUserDropdown();
    initSearchShortcut();
    initMobileNav();
  });
})();

