// ═══════════════════════════════════════
// Market session + VN holiday calendar + trading-days math.
// Giờ giao dịch HOSE: 9:00-11:30, 13:00-14:45 (Mon-Fri, skip lễ).
// KEEP IN SYNC với stock-pwa-bot/worker.js (holiday list).
// ═══════════════════════════════════════
window.__SSI_MARKET__ = (function () {
  "use strict";

  // ── Market hours (Vietnam: Mon-Fri, 9:00-11:30 & 13:00-14:45) ──
  function isMarketOpen() {
    const vnTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vnTime.getDay();
    if (day === 0 || day === 6) return false;
    const min = vnTime.getHours() * 60 + vnTime.getMinutes();
    if (min >= 540 && min <= 690) return true;   // 9:00 - 11:30
    if (min >= 780 && min <= 885) return true;   // 13:00 - 14:45
    return false;
  }

  // ── VN trading session + holidays (shared logic) ──
  // Format YYYY-MM-DD. Cập nhật theo lịch nghỉ chính thức + ngày bù.
  // KEEP IN SYNC với stock-pwa-bot/worker.js (worker dùng duplicate cho cron skip).
  const VN_HOLIDAYS = new Set([
    // 2025
    "2025-01-01",
    "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03", // Tết AL 2025
    "2025-04-07", // Giỗ Tổ
    "2025-04-30", "2025-05-01",
    "2025-09-02",
    // 2026
    "2026-01-01",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // Tết AL (Mùng 1=17/2)
    "2026-04-27", // Giỗ Tổ
    "2026-04-30", "2026-05-01",
    "2026-09-02",
    // 2027
    "2027-01-01",
    "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12", // Tết AL (Mùng 1=6/2/27)
    "2027-04-15", // Giỗ Tổ approx
    "2027-04-30", "2027-05-01",
    "2027-09-02",
  ]);

  function vnDateString(d = new Date()) {
    const vn = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const y = vn.getFullYear();
    const m = String(vn.getMonth() + 1).padStart(2, "0");
    const dd = String(vn.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function isVnHoliday(d = new Date()) {
    return VN_HOLIDAYS.has(vnDateString(d));
  }

  function nextVnHoliday(maxDays = 5) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ms = 24 * 3600 * 1000;
    let nearest = null;
    for (const h of VN_HOLIDAYS) {
      const d = new Date(h + "T00:00:00");
      const diff = Math.round((d - today) / ms);
      if (diff >= 0 && diff <= maxDays && (!nearest || diff < nearest.daysAway)) {
        nearest = { date: h, daysAway: diff };
      }
    }
    return nearest;
  }

  function isMarketOpenNow() {
    const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vn.getDay();
    if (day === 0 || day === 6) return false;
    if (isVnHoliday(vn)) return false;
    const min = vn.getHours() * 60 + vn.getMinutes();
    if (min >= 540 && min <= 690) return true;
    if (min >= 780 && min <= 885) return true;
    return false;
  }

  // Session state với countdown — phục vụ Today Briefing
  // VN trading: 9:00-11:30 (sáng) + 13:00-14:45 (chiều), Mon-Fri (skip holiday)
  function getSessionInfo() {
    const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vn.getDay();
    const min = vn.getHours() * 60 + vn.getMinutes();
    if (day === 0 || day === 6) {
      return { state: "weekend", label: "Cuối tuần", icon: "🌴", color: "#888", countdown: null };
    }
    if (isVnHoliday(vn)) {
      return { state: "holiday", label: "Nghỉ lễ — TT đóng cửa", icon: "🎉", color: "#FF9800", countdown: null };
    }
    if (min < 540) {
      return {
        state: "pre", label: "Phiên sáng mở trong", icon: "🌅", color: "#FF9800",
        countdown: 540 - min, hint: "Chuẩn bị plan ATO",
      };
    }
    if (min >= 540 && min <= 690) {
      return {
        state: "morning", label: "Phiên sáng — còn", icon: "🟢", color: "#4CAF50",
        countdown: 690 - min, hint: "Đang giao dịch",
      };
    }
    if (min > 690 && min < 780) {
      return {
        state: "lunch", label: "Nghỉ trưa — phiên chiều mở trong", icon: "🍱", color: "#FF9800",
        countdown: 780 - min,
      };
    }
    if (min >= 780 && min <= 885) {
      return {
        state: "afternoon", label: "Phiên chiều — còn", icon: "🟢", color: "#4CAF50",
        countdown: 885 - min, hint: "Đang giao dịch",
      };
    }
    return {
      state: "post", label: "Phiên đã đóng — chuẩn bị mai", icon: "🌙", color: "#888",
      countdown: null,
    };
  }

  function addTradingDays(date, n) {
    const d = new Date(date);
    let added = 0;
    while (added < n) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d;
  }

  // Đếm số phiên (weekday) giữa 2 ngày, EXCLUSIVE both ends.
  // tradingDaysBetween("2026-05-12", today=2026-05-14) = 1 (chỉ T4 13/05 ở giữa)
  // Dùng cho T+ position: signal day = T+0, hôm sau = T+1, ...
  function tradingDaysBetween(fromDateStr, toDate) {
    const start = new Date(fromDateStr);
    const end = new Date(toDate);
    // Strip time
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    if (end <= start) return 0;
    let count = 0;
    const d = new Date(start);
    while (d < end) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  return { isMarketOpen, vnDateString, isVnHoliday, nextVnHoliday, isMarketOpenNow, getSessionInfo, addTradingDays, tradingDaysBetween };
})();
