// ═══════════════════════════════════════
// Format helpers — number / price / volume / date / badge formatters.
// Pure, self-contained. Dùng chung app + module khác.
// ═══════════════════════════════════════
window.__SSI_FMT__ = (function () {
  "use strict";

  // ── Formatters ──
  function fp(n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    // Round to 4 decimals to absorb float artifacts, then trim trailing zeros via locale
    return n.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
  }

  function fmtVol(n) {
    if (!n || isNaN(n)) return "--";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  function fmtFlow(v) {
    if (v === null || v === undefined) return '<span class="flow-neu">--</span>';
    const cls = v > 0 ? "flow-pos" : v < 0 ? "flow-neg" : "flow-neu";
    const sign = v > 0 ? "+" : "";
    const bil = v / 1e9;
    const text = Math.abs(bil) >= 1
      ? `${sign}${bil.toFixed(2)} tỷ`
      : `${sign}${(v / 1e6).toFixed(1)} tr`;
    return `<span class="${cls}">${text}</span>`;
  }

  function peBadge(pe) {
    if (!pe) return "";
    if (pe < 10 && pe > 0) return '<span class="badge badge-cheap">Rẻ</span>';
    if (pe > 25) return '<span class="badge badge-exp">Đắt</span>';
    return '<span class="badge badge-fair">Hợp lý</span>';
  }

  function pbBadge(pb) {
    if (!pb) return "";
    if (pb < 1) return '<span class="badge badge-cheap">Dưới BV</span>';
    if (pb > 3) return '<span class="badge badge-exp">Đắt</span>';
    return '<span class="badge badge-fair">Hợp lý</span>';
  }

  function fmtTime(d) {
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  }

  function row(label, value, tip, valueStyle) {
    if (tip) {
      const safeTip = tip.replace(/"/g, "&quot;");
      const safeLabel = label.replace(/"/g, "&quot;");
      return `
        <div class="an-row">
          <span class="label has-tip" data-tip-title="${safeLabel}" data-tip-body="${safeTip}">
            ${label} <span class="info-icon">i</span>
          </span>
          <span class="value" style="${valueStyle || ""}">${value}</span>
        </div>`;
    }
    return `
      <div class="an-row">
        <span class="label">${label}</span>
        <span class="value" style="${valueStyle || ""}">${value}</span>
      </div>`;
  }

  function signedPct(v) {
    if (v === null || v === undefined) return "--";
    return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  }

  function perfPills(perf) {
    if (!perf) return "";
    const labels = { "1t": "1t", "1th": "1th", "3th": "3th", "1n": "1n" };
    const pill = (lbl, v) => {
      if (v === null || v === undefined) return `<span class="perf-pill"><span class="lbl">${lbl}</span>--</span>`;
      const color = v >= 0 ? "#4CAF50" : "#ff4444";
      const sign = v >= 0 ? "+" : "";
      return `<span class="perf-pill"><span class="lbl">${lbl}</span><span style="color:${color}">${sign}${v.toFixed(1)}%</span></span>`;
    };
    return `
      <div class="an-row">
        <span class="label has-tip" data-tip-title="Hiệu suất" data-tip-body="Thay đổi giá theo các khoảng thời gian: 1 tuần, 1 tháng, 3 tháng, 1 năm.">Hiệu suất <span class="info-icon">i</span></span>
        <span class="perf-pills">
          ${pill("1t", perf["1t"])}
          ${pill("1th", perf["1th"])}
          ${pill("3th", perf["3th"])}
          ${pill("1n", perf["1n"])}
        </span>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function fmtTimeShort(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) +
      " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  }

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 5) return "Khuya rồi";
    if (h < 12) return "Chào buổi sáng";
    if (h < 14) return "Chào buổi trưa";
    if (h < 18) return "Chào buổi chiều";
    if (h < 22) return "Chào buổi tối";
    return "Khuya rồi";
  }

  function fmtFullDate(d = new Date()) {
    const days = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${days[d.getDay()]}, ${dd}/${mm}/${d.getFullYear()}`;
  }

  function fmtDM(d) {
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function fmtMoney(vnd) {
    if (vnd === null || vnd === undefined || isNaN(vnd)) return "0đ";
    const sign = vnd < 0 ? "-" : "";
    const abs = Math.abs(vnd);
    // Treat near-whole VND as whole (avoid float artifacts like 484000.0000001)
    const rounded = Math.round(abs);
    const isEffectivelyWhole = Math.abs(abs - rounded) < 0.001;
    const display = isEffectivelyWhole ? rounded : abs;
    return sign + display.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: isEffectivelyWhole ? 0 : 3,
    }) + "đ";
  }

  function fmtPriceK(price) {
    // Price in k-VND (display) — full precision, trim trailing zeros
    if (!price || isNaN(price)) return "--";
    return price.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
  }

  return { fp, fmtVol, fmtFlow, peBadge, pbBadge, fmtTime, signedPct, perfPills, escapeHtml, fmtTimeShort, fmtDM, fmtMoney, fmtPriceK, fmtFullDate, getGreeting, row };
})();
