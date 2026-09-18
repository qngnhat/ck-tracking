import { FULL_UNIVERSE } from "./full_universe_data.js";

/**
 * Cloudflare Worker — Stock PWA Telegram Bot
 *
 * 2 entry points:
 *  1. fetch() — handle webhook từ Telegram bot (/start command)
 *  2. scheduled() — cron triggers, check trigger watches every 15 min
 *
 * Required env vars (set via `wrangler secret put`):
 *  - BOT_TOKEN: Telegram bot token (từ @BotFather)
 *  - SUPABASE_URL: vd https://xxx.supabase.co
 *  - SUPABASE_SERVICE_ROLE_KEY: từ Supabase Settings → API → service_role
 *  - WEBHOOK_SECRET: random string để validate webhook (optional, prevent abuse)
 *
 * Telegram bot setup (1 lần):
 *   POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/webhook
 */

const VND_HISTORY_URL = "https://dchart-api.vndirect.com.vn/dchart/history";
// dchart trả 406 nếu Accept là "application/json" thuần — phải có text/plain hoặc */*.
// Dùng chung cho mọi call dchart để khỏi lệch header giữa các hàm.
const VND_CHART_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
  "Origin": "https://dchart.vndirect.com.vn",
  "Referer": "https://dchart.vndirect.com.vn/",
};

// ── VN trading session + holidays ──
// KEEP IN SYNC danh sách ngày với stock-pwa/market-session.js VN_HOLIDAYS
// (bên đó là Set, bên này Map vì cần tên lễ để hiển thị). Update khi có lịch
// nghỉ chính thức.
const VN_HOLIDAYS = new Map([
  ["2025-01-01", "Tết Dương lịch"],
  ["2025-01-27", "Tết Nguyên đán"],
  ["2025-01-28", "Tết Nguyên đán"], ["2025-01-29", "Tết Nguyên đán"],
  ["2025-01-30", "Tết Nguyên đán"], ["2025-01-31", "Tết Nguyên đán"],
  ["2025-04-07", "Giỗ Tổ Hùng Vương"],
  ["2025-04-30", "Giải phóng miền Nam"], ["2025-05-01", "Quốc tế Lao động"],
  ["2025-05-02", "Quốc tế Lao động"],
  ["2025-09-01", "Quốc khánh"], ["2025-09-02", "Quốc khánh"],
  ["2026-01-01", "Tết Dương lịch"], ["2026-01-02", "Tết Dương lịch"],
  ["2026-02-16", "Tết Nguyên đán"], ["2026-02-17", "Tết Nguyên đán"],
  ["2026-02-18", "Tết Nguyên đán"], ["2026-02-19", "Tết Nguyên đán"],
  ["2026-02-20", "Tết Nguyên đán"],
  ["2026-04-27", "Giỗ Tổ Hùng Vương"],
  ["2026-04-30", "Giải phóng miền Nam"], ["2026-05-01", "Quốc tế Lao động"],
  ["2026-08-31", "Quốc khánh"], ["2026-09-01", "Quốc khánh"],
  ["2026-09-02", "Quốc khánh"],
  ["2027-01-01", "Tết Dương lịch"],
  ["2027-02-08", "Tết Nguyên đán"], ["2027-02-09", "Tết Nguyên đán"],
  ["2027-02-10", "Tết Nguyên đán"], ["2027-02-11", "Tết Nguyên đán"],
  ["2027-02-12", "Tết Nguyên đán"],
  ["2027-04-15", "Giỗ Tổ Hùng Vương"],
  ["2027-04-30", "Giải phóng miền Nam"], ["2027-05-01", "Quốc tế Lao động"],
  ["2027-09-02", "Quốc khánh"],
]);

const VN_WEEKDAY_NAMES = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

// Worker chạy UTC → mọi thứ liên quan "hôm nay" phải quy về Asia/Ho_Chi_Minh,
// nếu không 0:00-7:00 giờ VN sẽ lùi 1 ngày.
function vnNow(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
}

function vnDateString(d = new Date()) {
  const vn = vnNow(d);
  const y = vn.getFullYear();
  const m = String(vn.getMonth() + 1).padStart(2, "0");
  const dd = String(vn.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// "2026-08-03" → "03/08"
function fmtVnDM(dateStr) {
  const [, m, dd] = dateStr.split("-");
  return `${dd}/${m}`;
}

// "2026-08-03" → "03/08/2026"
function fmtVnDMY(dateStr) {
  const [y, m, dd] = dateStr.split("-");
  return `${dd}/${m}/${y}`;
}

// "03/08/2026" theo giờ VN
function vnDayLabel(d = new Date()) {
  return fmtVnDMY(vnDateString(d));
}

function isVnHoliday(d = new Date()) {
  return VN_HOLIDAYS.has(vnDateString(d));
}

// Phiên giao dịch: T2-T6, không lễ. Nhận Date hoặc "YYYY-MM-DD".
function isVnTradingDay(d = new Date()) {
  const dateStr = typeof d === "string" ? d : vnDateString(d);
  if (VN_HOLIDAYS.has(dateStr)) return false;
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

// signal_date phải là một PHIÊN, không phải "hôm nay". Scan chạy tay vào T7/CN
// (recovery) hoặc finalize sau 0h giờ VN sẽ đóng dấu ngày không có nến →
// resolveClassicalPicks không tìm được bar, lệnh kẹt unresolved đủ 30 ngày.
function lastVnTradingDay(d = new Date()) {
  let s = vnDateString(d);
  // Tết nghỉ tới ~9 phiên liên tiếp, cộng 2 cuối tuần kẹp hai đầu.
  for (let i = 0; i < 15 && !isVnTradingDay(s); i++) {
    const prev = new Date(`${s}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    s = prev.toISOString().slice(0, 10);
  }
  return s;
}

// Phiên giao dịch liền trước `dateStr` (không tính chính nó).
function prevVnTradingDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 15; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (isVnTradingDay(s)) return s;
  }
  return d.toISOString().slice(0, 10);
}

// Cộng n phiên giao dịch (bỏ T7/CN + lễ). In/out đều "YYYY-MM-DD".
function addVnTradingDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isVnTradingDay(d.toISOString().slice(0, 10))) added++;
  }
  return d.toISOString().slice(0, 10);
}

// Đếm số phiên giữa 2 ngày, EXCLUSIVE đầu, INCLUSIVE cuối.
// signal day = T+0, phiên kế tiếp = T+1. Bỏ T7/CN + lễ.
function vnTradingDaysBetween(fromDateStr, toDateStr) {
  const start = new Date(`${fromDateStr}T00:00:00Z`);
  const end = new Date(`${toDateStr}T00:00:00Z`);
  if (!(end > start)) return 0;
  let count = 0;
  const d = new Date(start);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isVnTradingDay(d.toISOString().slice(0, 10))) count++;
  }
  return count;
}

// Lễ gần nhất trong `withinDays` ngày tới (kể cả hôm nay) — để nhắc "mai nghỉ lễ".
function nextVnHoliday(fromDateStr, withinDays = 5) {
  const d = new Date(`${fromDateStr}T00:00:00Z`);
  for (let i = 0; i <= withinDays; i++) {
    const key = d.toISOString().slice(0, 10);
    if (VN_HOLIDAYS.has(key)) return { date: key, name: VN_HOLIDAYS.get(key), daysAway: i };
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

// Ngữ cảnh 1 ngày theo giờ VN — nguồn sự thật cho mọi label ngày + prompt tử vi.
// Trước đây prompt chỉ đưa "3/8" nên Gemini tự bịa thứ → sai.
function vnDayContext(d = new Date()) {
  const dateStr = vnDateString(d);
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  const weekday = VN_WEEKDAY_NAMES[dow];
  const holidayName = VN_HOLIDAYS.get(dateStr) || null;
  const isWeekend = dow === 0 || dow === 6;
  const upcoming = nextVnHoliday(dateStr, 5);
  return {
    dateStr,
    dayLabel: vnDayLabel(d),
    weekday,
    fullLabel: `${weekday}, ${vnDayLabel(d)}`,
    isTradingDay: !isWeekend && !holidayName,
    closedReason: holidayName ? `nghỉ lễ ${holidayName}` : (isWeekend ? "cuối tuần" : null),
    // Lễ sắp tới (bỏ qua lễ của chính hôm nay để không tự nhắc lại)
    upcomingHoliday: upcoming && upcoming.daysAway > 0 ? upcoming : null,
  };
}

// Actively trading right now? Mon-Fri 9:00-11:30 hoặc 13:00-14:45 VN time, skip holidays.
function isVnTradingNow(d = new Date()) {
  const vn = vnNow(d);
  const day = vn.getDay();
  if (day === 0 || day === 6) return false;
  // Truyền `d` (instant gốc), KHÔNG truyền `vn` — vn đã shift sang wall-clock VN,
  // đưa lại vào vnDateString sẽ shift lần 2 và lệch ngày sau 17:00 VN.
  if (isVnHoliday(d)) return false;
  const min = vn.getHours() * 60 + vn.getMinutes();
  if (min >= 540 && min <= 690) return true;   // 9:00 - 11:30
  if (min >= 780 && min <= 885) return true;   // 13:00 - 14:45
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }
    // Watch app (Huawei Watch Stock): pull portfolio + watchlist symbols.
    // Secret-protected; uses service_role to read the user's data (bypasses RLS).
    if (url.pathname === "/watch/symbols" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (key !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const sb = sbClient(env);
      const wlRows = (await sbQuery(sb, "watchlist", { select: "symbol" })) || [];
      // Dùng chung loadHoldingsIndex để endpoint này và /pos không lệch nguồn.
      const { portfolio: held } = await loadHoldingsIndex(sb);
      const portfolio = [...held.keys()].sort();
      const watchlist = [...new Set(wlRows.map((r) => r.symbol))].sort();
      return new Response(JSON.stringify({ portfolio, watchlist }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/portfolio/sync" && request.method === "POST") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      return handlePortfolioSync(request, env);
    }
    if (url.pathname === "/cron-test" && request.method === "POST") {
      // Manual trigger cron logic (testing only — protect by secret)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(checkAllWatches(env));
      return new Response("Cron triggered", { status: 200 });
    }
    if (url.pathname === "/climax-test" && request.method === "POST") {
      // Manual trigger market digest (legacy name kept for backward compat)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(sendMarketDigest(env));
      return new Response("Market digest triggered", { status: 200 });
    }
    if (url.pathname === "/exit-alert-test" && request.method === "POST") {
      // Manual trigger exit alert check (testing)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(checkExitAlerts(env));
      return new Response("Exit alert check triggered", { status: 200 });
    }
    if (url.pathname === "/digest-test" && request.method === "POST") {
      // Same as climax-test but clearer name
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(sendMarketDigest(env));
      return new Response("Market digest triggered", { status: 200 });
    }
    if (url.pathname === "/morning-test" && request.method === "POST") {
      // Manual trigger morning briefing (gồm tử vi) — gửi Telegram thật
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(sendMorningBriefing(env));
      return new Response("Morning briefing triggered", { status: 200 });
    }
    if (url.pathname === "/climax-dryrun" && request.method === "GET") {
      // Scan + return matches as JSON (no Telegram broadcast) — debug only
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const matches = await scanVolClimaxMatches();
      return new Response(JSON.stringify({ count: matches.length, matches }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/horoscope-test" && request.method === "GET") {
      // Preview tử vi (KHÔNG gửi Telegram) — debug
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const horo = await buildHoroscope(env);
      return new Response(horo, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/active-picks" && request.method === "GET") {
      // Public read: climax active picks (Bắt đáy T+ holding window).
      // Used by PWA portfolio tab to detect climax positions per-holding.
      // Data non-sensitive (same info derivable from VND public data).
      const sb = sbClient(env);
      const picks = await sbQuery(sb, "climax_active_picks", {
        select: "symbol,signal_date,entry_price,target_price,tier,expires_at,nn_net_5d_bn,is_premium,peak_price,peak_date",
      });
      const active = (picks || []).filter((p) =>
        !p.expires_at || new Date(p.expires_at) > new Date()
      );
      return new Response(JSON.stringify({ picks: active, fetched_at: new Date().toISOString() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",  // 5min CDN cache
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/mid-term-picks" && request.method === "GET") {
      // Public read: mid-term active picks (Base Breakout hold ~30 phiên).
      // PWA reads this to render Tab Trung hạn.
      const sb = sbClient(env);
      const picks = await sbQuery(sb, "mid_term_active_picks", {
        select: "symbol,signal_date,entry_price,pattern_type,init_sl_price,trail_pct,max_hold_days,expires_at,peak_price,peak_date,ma200_at_signal,vol_ratio_at_signal,base_range_pct",
      });
      const active = (picks || []).filter((p) =>
        !p.expires_at || new Date(p.expires_at) > new Date()
      );
      return new Response(JSON.stringify({ picks: active, fetched_at: new Date().toISOString() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/mid-term-dryrun" && request.method === "GET") {
      // Scan + return Base Breakout matches as JSON (no persist) — debug only
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const matches = [];
      const batchSize = 10;
      for (let i = 0; i < VOL_CLIMAX_UNIVERSE.length; i += batchSize) {
        const batch = VOL_CLIMAX_UNIVERSE.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (sym) => {
          try {
            const data = await fetchVndHistory(sym, 365);
            const r = detectBaseBreakout(data);
            return r ? { symbol: sym, ...r } : null;
          } catch { return null; }
        }));
        for (const r of results) if (r) matches.push(r);
      }
      matches.sort((a, b) => (b.breakStrength || 0) - (a.breakStrength || 0));
      return new Response(JSON.stringify({ count: matches.length, matches }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/mid-term-quick-scan" && request.method === "POST") {
      // User-triggered scan: large+mid cap (~45 mã) - subset Phase 1 backtest
      // universe. Detect cả Base Breakout (mid-term) + FBO (oversold + NN buy).
      // Persist matches. Full 1411 scan vẫn auto qua EOD cron.
      const bbMatches = [];
      const fboMatches = [];
      const batchSize = 15;
      for (let i = 0; i < MID_TERM_QUICK_UNIVERSE.length; i += batchSize) {
        const batch = MID_TERM_QUICK_UNIVERSE.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (sym) => {
          try {
            const data = await fetchVndHistory(sym, 365);
            const baseBreakout = detectBaseBreakout(data);
            const fboBase = detectForeignBackedOversoldBase(data);
            let fbo = null;
            if (fboBase) {
              const foreign = await fetchForeignDaily(sym, 7).catch(() => null);
              const nnNet5d = foreign ? computeNnNet5d(foreign) : null;
              if (nnNet5d != null && nnNet5d > 0) {
                fbo = { ...fboBase, nn_net_5d_bn: +(nnNet5d / 1e9).toFixed(2) };
              }
            }
            return { symbol: sym, baseBreakout, fbo };
          } catch { return null; }
        }));
        for (const r of results) {
          if (!r) continue;
          if (r.baseBreakout) bbMatches.push({ symbol: r.symbol, ...r.baseBreakout });
          if (r.fbo) fboMatches.push({ symbol: r.symbol, ...r.fbo });
        }
      }
      bbMatches.sort((a, b) => (b.breakStrength || 0) - (a.breakStrength || 0));
      fboMatches.sort((a, b) => (a.ret3d || 0) - (b.ret3d || 0));
      await persistMidTermMatches(env, bbMatches);
      await persistFBOMatches(env, fboMatches);
      return new Response(JSON.stringify({
        scanned: MID_TERM_QUICK_UNIVERSE.length,
        matched: bbMatches.length + fboMatches.length,
        base_breakout: bbMatches.map((m) => m.symbol),
        fbo: fboMatches.map((m) => m.symbol),
        symbols: [...bbMatches.map((m) => m.symbol), ...fboMatches.map((m) => m.symbol)],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (url.pathname === "/spike-test" && request.method === "POST") {
      // Manual trigger spike alert check
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(checkSpikeAlerts(env));
      return new Response("Spike alert check triggered", { status: 200 });
    }
    if (url.pathname === "/presignal-test" && request.method === "POST") {
      // Manual trigger cảnh báo sớm. Vẫn tôn trọng cửa sổ 13:30-14:45 VN.
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(checkPreSignalAlerts(env));
      return new Response("Pre-signal check triggered", { status: 200 });
    }
    if (url.pathname === "/presignal-watch" && request.method === "GET") {
      // Soi ứng viên đang theo dõi (debug, không gửi Telegram).
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const rows = await sbQuery(sbClient(env), "presignal_watch", {
        select: "symbol,watch_date,snapshot_date,ret3d_at_scan,rsi_at_scan,vol_avg20,alerted_at",
      });
      return new Response(JSON.stringify(rows ?? { error: "query fail — chạy sql/012 chưa?" }, null, 2), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/scan-init" && request.method === "POST") {
      // Manual trigger full-universe scan init
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(initScan(env));
      return new Response("Scan init triggered (will take ~40 min)", { status: 200 });
    }
    if (url.pathname === "/scan-chunk" && request.method === "POST") {
      // Manual trigger next chunk
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(processScanChunk(env));
      return new Response("Scan chunk triggered", { status: 200 });
    }
    if (url.pathname === "/clear-test-data" && request.method === "POST") {
      // Clean up all manually-seeded test data
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const sb = sbClient(env);
      // 1. Delete fake FPT from active picks (signal_date 2026-05-19, was test seed)
      const r1 = await fetch(
        `${sb.url}/rest/v1/climax_active_picks?symbol=eq.FPT&signal_date=eq.2026-05-19`,
        { method: "DELETE", headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
      );
      // 2. Delete fake trade_log entries (test seeds)
      const testSymbols = "(VCB,HPG,MWG,DGC,PDR,SHS,MOM_FPT,GVR)";
      const r2 = await fetch(
        `${sb.url}/rest/v1/trade_log?symbol=in.${testSymbols}&signal_date=lt.2026-05-20`,
        { method: "DELETE", headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
      );
      return new Response(JSON.stringify({
        active_picks_clear: r1.ok,
        trade_log_clear: r2.ok,
      }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/seed-test-premium" && request.method === "POST") {
      // TEST ONLY: seed a fake Premium pick to verify UI/digest
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const symbol = url.searchParams.get("symbol") || "FPT";
      const entry = parseFloat(url.searchParams.get("entry") || "100");
      const sb = sbClient(env);
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const row = {
        symbol,
        signal_date: new Date().toISOString().slice(0, 10),
        entry_price: entry,
        target_price: +(entry * 1.03).toFixed(4),
        tier: "Premium",
        nn_net_5d_bn: 125.5,
        is_premium: true,
        expires_at: expiresAt,
        above_threshold: false,
        last_alert_at: null,
      };
      const ok = await sbUpsert(sb, "climax_active_picks", row, "symbol");
      return new Response(JSON.stringify({ ok, row }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/scan-restart" && request.method === "POST") {
      // Force restart scan — useful sau code change hoặc khi scan stuck
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(initScan(env));
      return new Response("Scan restart initiated", { status: 200 });
    }
    if (url.pathname === "/scan-full-init" && request.method === "POST") {
      // Public: PWA user-trigger full 1411 scan.
      // KHÔNG dùng initScan() (vì nó auto-step → 40+ subrequests trong 1 call).
      // Chỉ init state, PWA loop /scan-full-step để process chunks.
      const sb = sbClient(env);
      let vniRegime = "neutral", vniRet20 = null;
      try {
        const vni = await fetchVndHistory("VNINDEX", 35);
        const cs = vni.closes;
        if (cs.length >= 21) {
          vniRet20 = ((cs[cs.length - 1] - cs[cs.length - 21]) / cs[cs.length - 21]) * 100;
          if (vniRet20 < -5) vniRegime = "correction";
          else if (vniRet20 > 3) vniRegime = "bull";
        }
      } catch {}
      await setScanState(env, {
        status: "in_progress",
        scan_date: new Date().toISOString().slice(0, 10),
        current_offset: 0,
        total_universe: FULL_UNIVERSE.length,
        ...emptyScanPartials(),
        market_stats: JSON.stringify({ upCount: 0, downCount: 0, totalTurnover: 0, totalChange: 0, totalScanned: 0 }),
        vni_regime: vniRegime,
        vni_ret20: vniRet20,
        started_at: new Date().toISOString(),
        completed_at: null,
        error_count: 0,
      });
      const state = await getScanState(env);
      return new Response(JSON.stringify({
        status: state?.status || "unknown",
        total_universe: state?.total_universe || 0,
        current_offset: state?.current_offset || 0,
        started_at: state?.started_at,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (url.pathname === "/scan-full-step" && request.method === "POST") {
      // Public: PWA loops calling this to advance scan 1 chunk.
      // Try/catch wrapping để CORS header luôn set khi error (PWA fetch không
      // báo "Failed to fetch").
      try {
      const safeJsonLen = (s) => {
        if (!s || s === "" || s === "null") return 0;
        try { return JSON.parse(s).length; } catch { return 0; }
      };
      const stateBefore = await getScanState(env);
      const offsetBefore = stateBefore?.current_offset || 0;
      await processScanChunk(env);
      const state = await getScanState(env);
      const climaxCount = safeJsonLen(state?.climax_partial);
      const momentumCount = safeJsonLen(state?.momentum_partial);
      const baseBreakoutCount = safeJsonLen(state?.base_breakout_partial);
      const fboCount = safeJsonLen(state?.fbo_partial);
      const offsetAfter = state?.current_offset || 0;
      // Diagnostic: nếu offset không advance + status vẫn in_progress → setScanState
      // có thể fail silently (column missing trong scan_state). Báo PWA biết.
      const stuck = offsetAfter === offsetBefore && state?.status === "in_progress";
      return new Response(JSON.stringify({
        status: state?.status || "unknown",
        current_offset: offsetAfter,
        total_universe: state?.total_universe || 0,
        climax_count: climaxCount,
        momentum_count: momentumCount,
        base_breakout_count: baseBreakoutCount,
        fbo_count: fboCount,
        completed: state?.status === "completed",
        stuck: stuck,
        error: stuck ? "Offset không advance — có thể column base_breakout_partial/fbo_partial chưa tồn tại trong scan_state (chạy SQL 009 + 010)." : null,
      }), {
        status: stuck ? 500 : 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
      } catch (err) {
        console.warn("[scan-full-step] exception:", err.message);
        return new Response(JSON.stringify({
          error: `Worker exception: ${err.message}`,
          completed: false,
          stuck: true,
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }
    if (url.pathname === "/scan-orchestrator" && request.method === "POST") {
      // Internal: chained orchestrator. Process 1 chunk + self-spawn next.
      // Each invocation = ~40 subreq within Cloudflare 50 limit.
      // Total: ~57 chunks chained = ~3-5 phút real time.
      const chatId = url.searchParams.get("chat");
      const iter = parseInt(url.searchParams.get("iter") || "0");

      // Safety stop after 100 iterations (sanity)
      if (iter > 100) {
        if (chatId) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `⚠️ Scan orchestrator hit safety limit (iter ${iter}). Có thể chunk stuck. Check /scan-full-status manually.`);
        }
        return new Response("safety limit", { status: 200 });
      }

      // Process 1 chunk
      try {
        await processScanChunk(env);
      } catch (e) {
        console.warn(`[orchestrator iter=${iter}] processChunk failed:`, e.message);
        if (chatId) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `❌ Scan orchestrator lỗi iter ${iter}: ${e.message}`);
        }
        return new Response("error", { status: 500 });
      }

      // Check state
      const state = await getScanState(env);
      const offset = state?.current_offset || 0;
      const total = state?.total_universe || 0;
      const completed = state?.status === "completed";

      // Progress update every 10 iterations
      if (chatId && iter > 0 && iter % 10 === 0) {
        const pct = total > 0 ? Math.round((offset / total) * 100) : 0;
        await tgSendMessage(env.BOT_TOKEN, chatId,
          `⏳ Scan progress: ${offset}/${total} (${pct}%)`);
      }

      if (completed) {
        // Send completion notification
        const safeJsonLen = (s) => {
          if (!s || s === "" || s === "null") return 0;
          try { return JSON.parse(s).length; } catch { return 0; }
        };
        const bbCount = safeJsonLen(state?.base_breakout_partial);
        const fboCount = safeJsonLen(state?.fbo_partial);
        const climaxCount = safeJsonLen(state?.climax_partial);
        const momentumCount = safeJsonLen(state?.momentum_partial);
        if (chatId) {
          await tgSendMessage(env.BOT_TOKEN, chatId,
            `✅ *Scan full 1411 mã xong* (${iter} chunks)\n\n` +
            `🔍 Base Breakout: *${bbCount}*\n` +
            `🌊 FBO: *${fboCount}*\n` +
            `🔻 Climax: *${climaxCount}*\n` +
            `🚀 Momentum: *${momentumCount}*\n\n` +
            `Gõ /picks để xem chi tiết.`);
        }
        return new Response("done", { status: 200 });
      }

      // Spawn next iteration (fire and forget)
      const workerUrl = new URL(request.url).origin;
      ctx.waitUntil(fetch(`${workerUrl}/scan-orchestrator?chat=${chatId || ""}&iter=${iter + 1}`,
        { method: "POST" }));
      return new Response(`iter ${iter} done, spawned next`, { status: 200 });
    }
    if (url.pathname === "/scan-full-status" && request.method === "GET") {
      // Public: read current scan state cho PWA progress bar
      const state = await getScanState(env);
      if (!state) {
        return new Response(JSON.stringify({ status: "idle" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      return new Response(JSON.stringify({
        status: state.status,
        current_offset: state.current_offset,
        total_universe: state.total_universe,
        completed: state.status === "completed",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (url.pathname === "/chunk-step" && request.method === "POST") {
      // Manually advance scan by one chunk (for debug when chunked cron stalled)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(processScanChunk(env));
      return new Response("Chunk step triggered", { status: 200 });
    }
    if (url.pathname === "/heartbeat" && request.method === "GET") {
      // Read recent cron heartbeats (debug — verify cron actually fired)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const sb = sbClient(env);
      // 50 fire gần nhất, mới nhất trước. ?limit= & ?since= để soi ngược lại trong
      // ngày — mặc định 50 chỉ trải ~19 phút vì chunk cron đập mỗi phút.
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1000);
      const since = url.searchParams.get("since");
      const nameFilter = url.searchParams.get("cron_name");
      let q = `${sb.url}/rest/v1/cron_heartbeat?select=*&order=fired_at.desc&limit=${limit}`;
      if (since) q += `&fired_at=gte.${encodeURIComponent(since)}`;
      if (nameFilter) q += `&cron_name=eq.${encodeURIComponent(nameFilter)}`;
      const r = await fetch(q, {
        headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` },
      });
      const data = r.ok ? await r.json() : [];
      return new Response(JSON.stringify(data, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/scan-status" && request.method === "GET") {
      // Read scan state (debug)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const state = await getScanState(env);
      if (state) {
        // Trim partial JSONs cho readability
        const compact = { ...state };
        try {
          compact.climax_count = JSON.parse(state.climax_partial || "[]").length;
          compact.momentum_count = JSON.parse(state.momentum_partial || "[]").length;
          delete compact.climax_partial;
          delete compact.momentum_partial;
        } catch {}
        return new Response(JSON.stringify(compact, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("No scan state", { status: 404 });
    }
    if (url.pathname === "/seed-trade-log-test" && request.method === "POST") {
      // TEST ONLY: seed fake resolved trades for UI dashboard demo
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const sb = sbClient(env);
      const today = new Date();
      const ago = (days) => new Date(today.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
      // All rows must have EXACTLY same keys (PGRST102 constraint)
      const mkTrade = (sym, daysAgo, tier, entry, isPremium, nn, exitOpts) => ({
        symbol: sym,
        signal_date: ago(daysAgo),
        tier,
        entry_price: entry,
        target_price: +(entry * 1.03).toFixed(4),
        sl_price: +(entry * 0.92).toFixed(4),
        nn_net_5d_bn: nn,
        is_premium: isPremium,
        resolved_at: exitOpts ? new Date().toISOString() : null,
        exit_price: exitOpts?.exitPrice ?? null,
        exit_day: exitOpts?.exitDay ?? null,
        exit_reason: exitOpts?.exitReason ?? null,
        net_ret: exitOpts?.netRet ?? null,
        is_win: exitOpts?.isWin ?? null,
      });
      const fakeTrades = [
        mkTrade("VCB", 20, "Premium", 60, true, 85, { exitPrice: 61.8, exitDay: 3, exitReason: "target", netRet: 0.026, isWin: true }),
        mkTrade("HPG", 15, "Premium", 26, true, 120, { exitPrice: 26.78, exitDay: 4, exitReason: "target", netRet: 0.026, isWin: true }),
        mkTrade("MWG", 12, "Premium", 55, true, 42, { exitPrice: 53.5, exitDay: 5, exitReason: "force", netRet: -0.031, isWin: false }),
        mkTrade("DGC", 18, "A", 90, false, null, { exitPrice: 92.7, exitDay: 3, exitReason: "target", netRet: 0.026, isWin: true }),
        mkTrade("PDR", 14, "A", 18, false, null, { exitPrice: 16.56, exitDay: 4, exitReason: "sl", netRet: -0.084, isWin: false }),
        mkTrade("SHS", 10, "B", 18, false, null, { exitPrice: 18.2, exitDay: 5, exitReason: "force", netRet: 0.007, isWin: true }),
        mkTrade("MOM_FPT", 8, "Momentum", 75, false, null, { exitPrice: 77.6, exitDay: 4, exitReason: "target", netRet: 0.031, isWin: true }),
        mkTrade("GVR", 3, "Premium", 37, true, 56, null),  // unresolved
      ];
      // Direct INSERT for debug
      const insertUrl = `${sb.url}/rest/v1/trade_log?on_conflict=symbol,signal_date`;
      const insertRes = await fetch(insertUrl, {
        method: "POST",
        headers: {
          apikey: sb.key,
          authorization: `Bearer ${sb.key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(fakeTrades),
      });
      const respText = await insertRes.text();
      return new Response(JSON.stringify({
        status: insertRes.status,
        ok: insertRes.ok,
        response: respText.substring(0, 1500),
        count: fakeTrades.length,
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/morning-test" && request.method === "POST") {
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(sendMorningBriefing(env));
      return new Response("Morning briefing triggered", { status: 200 });
    }
    if (url.pathname === "/drawdown-status" && request.method === "GET") {
      // Public read: drawdown circuit breaker status per tier.
      // Premium pause = 3 consecutive losses → pause 5 trading days.
      const sb = sbClient(env);
      const result = {};
      for (const tier of ["Premium", "Elite", "A", "B", "Momentum"]) {
        result[tier] = await computeDrawdownStatus(sb, tier);
      }
      return new Response(JSON.stringify({ status: result, computed_at: new Date().toISOString() }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/trade-log" && request.method === "GET") {
      // Public read: forward-test tracker. Last 100 trades, newest first.
      const sb = sbClient(env);
      const r = await fetch(`${sb.url}/rest/v1/trade_log?select=*&order=signal_date.desc&limit=100`, {
        headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` },
      });
      const data = r.ok ? await r.json() : [];
      return new Response(JSON.stringify({ trades: data, fetched_at: new Date().toISOString() }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=120",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/resolve-picks" && request.method === "POST") {
      // Manual trigger: resolve unresolved picks (signal_date < today - 7 days)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      ctx.waitUntil(resolveExpiredPicks(env));
      return new Response("Resolve triggered", { status: 200 });
    }
    if (url.pathname === "/spike-state" && request.method === "GET") {
      // Read active picks state (debug)
      const secret = url.searchParams.get("secret");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const sb = sbClient(env);
      const picks = await sbQuery(sb, "climax_active_picks", { select: "*" });
      return new Response(JSON.stringify(picks || [], null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // ── AI analysis (Gemini Flash 2.0) ──────────────────────────────
    // /ai-explain   — diễn giải TA only (no grounding, cheap, ~1s)
    // /ai-research  — TA + fundamental + news + phốt (Google Search grounding, ~3s)
    // Cache: server-side Cache API, key = (mode, symbol, vn-date) → 1 call/ngày/mã.
    if (url.pathname === "/ai-explain" || url.pathname === "/ai-research") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      if (request.method === "POST") {
        return url.pathname === "/ai-explain"
          ? handleAiExplain(request, env, ctx)
          : handleAiResearch(request, env, ctx);
      }
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Stock PWA Bot Worker", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // Multi-cron dispatch:
    // - "*/3 2-7 * * mon-fri"    → intraday watch + spike alerts (mỗi 3 min trong phiên)
    // - "50 7 * * mon-fri"       → init multi-stage scan (14:50 VN)
    // - "* 8-9 * * mon-fri"      → chunk mỗi 1 min, 15:00-16:59 VN
    const cron = event.cron || "";
    if (cron === "50 7 * * mon-fri") {
      // EOD digest — VN holiday vẫn skip
      if (isVnHoliday()) {
        console.log("[cron-eod] skip — VN holiday");
        ctx.waitUntil(logHeartbeat(env, "eod-skip", { reason: "vn-holiday" }));
        return;
      }
      console.log("[cron-eod] EOD fired at", new Date().toISOString());
      ctx.waitUntil(logHeartbeat(env, "eod", { event_cron: cron }));
      // Cloudflare free tier = 50 subrequest/invocation, dùng CHUNG cho mọi
      // waitUntil ở đây. sendMarketDigest (quét lại 35 mã, ~40 subrequest) từng
      // nằm ở đây và ngày nào cũng chết trước khi kịp gửi — cùng lúc kéo chết
      // updatePeakPrices. Bỏ hẳn: nó chỉ là bản rút gọn của digest full-coverage
      // mà finalizeScan gửi sau khi quét đủ 1411 mã.
      ctx.waitUntil(sendEodDigest(env));
      // processFirstChunk=false: chunk đầu tốn ~40 subrequest, bật lên là nhánh
      // này lại vượt trần và kéo chết updatePeakPrices. Cron "*/2 0-7" nhặt chunk
      // đầu lúc 14:52 — chậm 2 phút, đổi lại cả 4 job dưới đây chạy đủ.
      ctx.waitUntil(initScan(env, { processFirstChunk: false }));
      // Update peak prices for active picks (trailing stop helper)
      ctx.waitUntil(updatePeakPrices(env));
      // Resolve expired trade_log entries (forward-test tracker)
      ctx.waitUntil(resolveExpiredPicks(env));
      return;
    }
    if (cron === "* 8-9 * * mon-fri") {
      // Chunked scan processing 15:00-16:59 VN
      if (isVnHoliday()) return;
      ctx.waitUntil(logHeartbeat(env, "chunk", { event_cron: cron }));
      ctx.waitUntil(processScanChunk(env));
      return;
    }
    if (cron === "30 1 * * mon-fri") {
      // Morning briefing 8:30 VN (1:30 UTC) — Telegram summary
      if (isVnHoliday()) {
        ctx.waitUntil(logHeartbeat(env, "morning-skip", { reason: "vn-holiday" }));
        return;
      }
      console.log("[cron-morning] fired at", new Date().toISOString());
      ctx.waitUntil(logHeartbeat(env, "morning", { event_cron: cron }));
      ctx.waitUntil(sendEntryReminder(env));
      ctx.waitUntil(sendMorningBriefing(env));
      return;
    }
    if (cron === "*/2 0-7,10-23 * * mon-fri") {
      // Bot-triggered /scan continuation: process chunk only if scan in_progress.
      // No-op khi state idle/completed (cheap query check).
      ctx.waitUntil((async () => {
        const state = await getScanState(env);
        if (state?.status === "in_progress") {
          console.log(`[cron-scan-cont] state in_progress offset=${state.current_offset}, processing chunk`);
          await processScanChunk(env);
        }
        // else: silent no-op
      })());
      return;
    }
    // Default: */3 intraday check triggers + spike
    if (!isVnTradingNow()) {
      console.log("[cron] skip — outside VN trading session", new Date().toISOString());
      return;
    }
    console.log("[cron] check triggers + spike + exit alerts fired at", new Date().toISOString());
    ctx.waitUntil(logHeartbeat(env, "intraday", { event_cron: cron }));
    ctx.waitUntil(checkAllWatches(env));
    ctx.waitUntil(checkSpikeAlerts(env));
    ctx.waitUntil(checkExitAlerts(env));
    ctx.waitUntil(checkPreSignalAlerts(env));   // tự no-op ngoài 13:30-14:45
  },
};

// ── Telegram Bot API helpers ──────────────────────────

// Telegram từ chối cả tin nếu quá 4096 ký tự. Để hụt vì .length đếm UTF-16
// (emoji = 2) còn markup Markdown chưa bị trừ như phía Telegram đếm.
const TG_MAX_LEN = 4000;
// Cắt ở ranh giới mục trước, không vừa mới lùi xuống đoạn rồi dòng — một mục
// bị xé đôi giữa 2 tin khó đọc hơn tin ngắn.
const TG_SPLIT_LEVELS = [
  { re: /\n+(?=━{5,})/, join: "\n\n" },
  { re: /\n{2,}/, join: "\n\n" },
  { re: /\n/, join: "\n" },
];

function splitTgText(text, max = TG_MAX_LEN, level = 0) {
  if (text.length <= max) return [text];
  if (level >= TG_SPLIT_LEVELS.length) {
    const out = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const { re, join } = TG_SPLIT_LEVELS[level];
  const out = [];
  let cur = "";
  for (const part of text.split(re)) {
    const joined = cur ? `${cur}${join}${part}` : part;
    if (joined.length <= max) {
      cur = joined;
      continue;
    }
    if (cur) out.push(cur);
    if (part.length <= max) {
      cur = part;
    } else {
      const sub = splitTgText(part, max, level + 1);
      out.push(...sub.slice(0, -1));
      cur = sub[sub.length - 1];
    }
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.trim());
}

// Tin dài được tách thành nhiều tin gửi tuần tự. Trả về response lỗi đầu tiên
// (caller chỉ xét .ok), keyboard gắn vào tin cuối.
async function tgSendMessage(token, chatId, text, parseMode = "Markdown", replyMarkup = null) {
  const parts = typeof text === "string" ? splitTgText(text) : [text];
  let resp;
  for (let i = 0; i < parts.length; i++) {
    resp = await tgSendOne(token, chatId, parts[i], parseMode, i === parts.length - 1 ? replyMarkup : null);
    if (!resp?.ok) return resp;
  }
  return resp;
}

function tgSendOne(token, chatId, text, parseMode, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));
}

// ── Webhook handler: process /start command ─────────────

async function handleTelegramWebhook(request, env, ctx) {
  const update = await request.json().catch(() => ({}));

  // Callback query (inline button tap)
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query, env);
  }

  const message = update.message;
  if (!message || !message.text) {
    return new Response("ok", { status: 200 });
  }

  const chatId = message.chat.id;
  const username = message.from?.username || null;
  const text = message.text.trim();

  // /start <link_token>
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const linkToken = parts[1];

    if (!linkToken) {
      await tgSendMessage(env.BOT_TOKEN, chatId,
        "👋 Chào mày! Đây là bot thông báo T+ entry trigger từ Stock PWA.\n\n" +
        "Để kết nối: vào app → menu user → bấm *Kết nối Telegram*. App sẽ mở bot này với token đặc biệt."
      );
      return new Response("ok");
    }

    // Find user by link_token + check expire
    const sb = sbClient(env);
    const userRows = await sbQuery(sb, "user_telegram", {
      select: "user_id,link_token_expires_at",
      eq: { link_token: linkToken },
    });

    if (!userRows || userRows.length === 0) {
      await tgSendMessage(env.BOT_TOKEN, chatId, "❌ Token không hợp lệ. Vào app → Kết nối Telegram để lấy token mới.");
      return new Response("ok");
    }

    const row = userRows[0];
    if (row.link_token_expires_at && new Date(row.link_token_expires_at) < new Date()) {
      await tgSendMessage(env.BOT_TOKEN, chatId, "⏰ Token hết hạn. Vào app → Kết nối Telegram tạo token mới.");
      return new Response("ok");
    }

    // Update chat_id + clear token
    const upd = await sbUpdate(sb, "user_telegram", {
      eq: { user_id: row.user_id },
      data: {
        chat_id: chatId,
        username,
        connected_at: new Date().toISOString(),
        link_token: null,
        link_token_expires_at: null,
      },
    });

    await tgSendMessage(env.BOT_TOKEN, chatId,
      `✅ *Đã kết nối Stock PWA*\n\n` +
      `Bot sẽ báo khi mã T+ trong watchlist đạt entry trigger (close, vol, gap up).\n\n` +
      `App sẽ check mỗi 15 phút trong giờ giao dịch.`
    );
    return new Response("ok");
  }

  // /status — show connected user
  if (text === "/status") {
    const sb = sbClient(env);
    const rows = await sbQuery(sb, "user_telegram", {
      select: "user_id,connected_at",
      eq: { chat_id: chatId },
    });
    if (rows?.length) {
      const watches = await sbQuery(sb, "tplus_watches", {
        select: "symbol,notified",
        eq: { user_id: rows[0].user_id },
      });
      const active = watches?.filter((w) => !w.notified).length || 0;
      await tgSendMessage(env.BOT_TOKEN, chatId,
        `📊 *Status*\n\nĐã kết nối từ ${rows[0].connected_at?.slice(0, 10)}\nWatches hoạt động: ${active}`
      );
    } else {
      await tgSendMessage(env.BOT_TOKEN, chatId, "Chưa kết nối. Vào app → Kết nối Telegram.");
    }
    return new Response("ok");
  }

  // /help — list available commands
  if (text === "/help" || text === "/?") {
    await tgSendMessage(env.BOT_TOKEN, chatId, buildHelpMessage());
    return new Response("ok");
  }

  // /picks — show active picks (Mid-term + FBO + Climax)
  if (text === "/picks" || text === "/p") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildPicksMessage(env));
    return new Response("ok");
  }

  // /scan — trigger FULL 1411 mã chunked scan (background via cron)
  // Cloudflare Worker không cho phép self-spawn unlimited → chunks process qua
  // cron `*/2 * * * mon-fri` (every 2 min weekdays). 57 chunks × 2 min ≈ 2 giờ total.
  // EOD slot `* 8 * * mon-fri` (15:00-15:59 VN) chạy mỗi 1 phút → faster (~57 min).
  if (text === "/scan") {
    await setScanState(env, {
      status: "in_progress",
      scan_date: new Date().toISOString().slice(0, 10),
      current_offset: 0,
      total_universe: FULL_UNIVERSE.length,
      ...emptyScanPartials(),
      market_stats: JSON.stringify({ upCount: 0, downCount: 0, totalTurnover: 0, totalChange: 0, totalScanned: 0 }),
      started_at: new Date().toISOString(),
      completed_at: null,
      error_count: 0,
    });
    // Kick off first chunk immediately để start progress
    ctx.waitUntil(processScanChunk(env));
    // Estimate time based on current UTC hour
    const utcHour = new Date().getUTCHours();
    const inEodWindow = utcHour === 8;  // 15:00-15:59 VN
    const eta = inEodWindow ? "~1 phút/chunk × 57 chunks = ~1 giờ" : "~2 phút/chunk × 57 chunks = ~2 giờ";
    await tgSendMessage(env.BOT_TOKEN, chatId,
      `🔍 *Đã trigger scan full 1411 mã*\n\n` +
      `Chunks process qua cron — ${eta} (vì Cloudflare Free limit chỉ ~25 mã/invocation).\n\n` +
      `📊 Theo dõi: gõ /scan-status để check progress.\n` +
      `🔔 Bot tự gửi digest khi xong (qua sendMarketDigest auto).\n\n` +
      `_Nếu cần kết quả ngay: gõ /quick (45 mã large+mid, ~10s)._`);
    return new Response("ok");
  }
  // /scan-status — check current scan progress
  if (text === "/scan-status" || text === "/ss") {
    const state = await getScanState(env);
    if (!state || state.status === "idle") {
      await tgSendMessage(env.BOT_TOKEN, chatId, "📊 Không có scan đang chạy. Gõ /scan để trigger full scan.");
      return new Response("ok");
    }
    const offset = state.current_offset || 0;
    const total = state.total_universe || 0;
    const pct = total > 0 ? Math.round((offset / total) * 100) : 0;
    const safeJsonLen = (s) => {
      if (!s || s === "" || s === "null") return 0;
      try { return JSON.parse(s).length; } catch { return 0; }
    };
    const bb = safeJsonLen(state.base_breakout_partial);
    const fbo = safeJsonLen(state.fbo_partial);
    const climax = safeJsonLen(state.climax_partial);
    const mom = safeJsonLen(state.momentum_partial);
    await tgSendMessage(env.BOT_TOKEN, chatId,
      `📊 *Scan progress*\n\n` +
      `Status: ${state.status}\n` +
      `Progress: ${offset}/${total} (${pct}%)\n` +
      `Started: ${state.started_at?.slice(0, 19) || "?"}\n\n` +
      `*Partial matches (so far)*:\n` +
      `🔍 Base Breakout: ${bb}\n` +
      `🌊 FBO: ${fbo}\n` +
      `🔻 Climax: ${climax}\n` +
      `🚀 Momentum: ${mom}`);
    return new Response("ok");
  }
  if (text === "/quick" || text === "/q" || text === "/s") {
    // Quick scan 45 mã large+mid cap (instant feedback)
    await tgSendMessage(env.BOT_TOKEN, chatId, "🔍 Đang quét 45 mã large+mid cap...");
    const summary = await runQuickScan(env);
    await tgSendMessage(env.BOT_TOKEN, chatId, buildScanResultMessage(summary));
    return new Response("ok");
  }

  // /signals — mã đã & đang signal trong 7 ngày
  if (text === "/signals" || text === "/sg") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildSignalsMessage(env));
    return new Response("ok");
  }

  // /stats — recent forward-test stats
  if (text === "/stats" || text === "/st") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildStatsMessage(env));
    return new Response("ok");
  }

  // /check <SYMBOL> — check pattern + tier 1 mã cụ thể
  if (text.startsWith("/check ") || text.startsWith("/c ")) {
    const sym = text.split(/\s+/)[1]?.toUpperCase();
    if (!sym) {
      await tgSendMessage(env.BOT_TOKEN, chatId, "Usage: `/check <SYMBOL>` — vd `/check VHM`");
      return new Response("ok");
    }
    await tgSendMessage(env.BOT_TOKEN, chatId, `🔍 Đang check ${sym}...`);
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildCheckSymbolMessage(env, sym));
    return new Response("ok");
  }

  // /b <SYM> <GIÁ> [SL] — ghi lệnh mua tay. Lưu ý `/s` trần vẫn là quick scan,
  // chỉ khi có tham số mới hiểu là lệnh bán.
  if (/^\/(b|buy)\s/i.test(text)) {
    await tgSendMessage(env.BOT_TOKEN, chatId, await handlePaperBuy(env, chatId, text));
    return new Response("ok");
  }
  if (/^\/(s|sell)\s/i.test(text)) {
    await tgSendMessage(env.BOT_TOKEN, chatId, await handlePaperSell(env, chatId, text));
    return new Response("ok");
  }

  // /pos — danh mục thật trong app, /pnl — tổng kết sổ /b đã đóng + so với bot
  if (text === "/pos" || text === "/positions") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildPortfolioMessage(env, chatId));
    return new Response("ok");
  }
  if (text === "/pnl") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildPaperPnlMessage(env, chatId));
    return new Response("ok");
  }

  // /morning, /eod — chạy tay đúng 2 job cron gửi hàng ngày, kết quả chỉ về
  // chat của người gõ để không spam user khác.
  if (text === "/morning" || text === "/mn") {
    await tgSendMessage(env.BOT_TOKEN, chatId, "☀️ Đang dựng briefing sáng...");
    await sendEntryReminder(env, chatId);
    await sendMorningBriefing(env, chatId);
    return new Response("ok");
  }
  if (text === "/eod" || text === "/ed") {
    // Chỉ ghi vào trade_log/active_picks khi phiên đã chốt — gõ giữa phiên thì
    // giá còn chạy, ghi vào là bẩn lịch sử forward-test.
    const vn = vnNow();
    const closed = isVnTradingDay() && vn.getHours() * 60 + vn.getMinutes() > 885;
    await tgSendMessage(env.BOT_TOKEN, chatId,
      closed
        ? "🔔 Đang dựng digest cuối phiên (35 mã)..."
        : "🔔 Đang dựng digest (35 mã) — _phiên chưa chốt nên chỉ xem, không ghi lịch sử_.");
    await sendMarketDigest(env, null, { onlyChatId: chatId, persist: closed });
    await sendEodDigest(env, chatId);
    return new Response("ok");
  }

  // /regime — show current VNI volatility regime
  if (text === "/regime" || text === "/r") {
    await tgSendMessage(env.BOT_TOKEN, chatId, await buildRegimeMessage(env));
    return new Response("ok");
  }

  // Unknown command
  await tgSendMessage(env.BOT_TOKEN, chatId,
    "Không hiểu lệnh. Gõ `/help` xem danh sách commands."
  );
  return new Response("ok");
}

// ── Bot command handlers ──────────────────────────────

function buildHelpMessage() {
  return `🤖 *Bonggnez Bot Commands*\n\n` +
    `*Quét + Picks:*\n` +
    `/scan — Quét FULL 1411 mã background (~1-2 giờ qua cron)\n` +
    `/scan-status (/ss) — Check progress full scan\n` +
    `/quick (/q, /s) — Quét nhanh 45 mã large+mid cap (instant ~10s)\n` +
    `  _(\`/s\` trần = quét nhanh; \`/s <MÃ> <giá>\` = ghi lệnh bán)_\n` +
    `/picks (/p) — Show active picks (Base Breakout + FBO + Climax)\n` +
    `/signals (/sg) — Mã đã & đang signal 7 ngày qua (T+, lãi/lỗ)\n` +
    `/check VHM (/c VHM) — Check pattern + tier 1 mã\n` +
    `\n*Danh mục:*\n` +
    `/pos — Danh mục trong app: giá vốn, T+, lãi/lỗ hiện tại\n` +
    `\n*Sổ lệnh tay:*\n` +
    `/b SHS 17.88 1000 — Ghi MUA (giá, số lượng)\n` +
    `/s SHS 18.5 400 — Ghi BÁN (bỏ SL = đóng cả lot cũ nhất)\n` +
    `/pnl — Tổng kết đã đóng + so với bot\n` +
    `\n*Stats + Regime:*\n` +
    `/stats (/st) — Forward-test stats (Win, P&L) 30 ngày\n` +
    `/regime (/r) — VNI volatility regime hiện tại\n` +
    `\n*Account:*\n` +
    `/status — Trạng thái kết nối + watches\n` +
    `/start <token> — Kết nối account (lấy token từ app)\n` +
    `/help (/?) — Show menu này\n` +
    `\n*Chạy tay 2 bản tin hàng ngày:*\n` +
    `/morning (/mn) — Briefing sáng, bất cứ lúc nào\n` +
    `/eod (/ed) — Digest cuối phiên (chưa chốt phiên thì chỉ xem)\n` +
    `\n*Bot tự bắn (không cần gõ):*\n` +
    `08:30 — Briefing sáng: tuần qua + active picks\n` +
    `13:30-14:45 — Cảnh báo sớm mã đang hình thành Climax\n` +
    `14:50 — Digest cuối phiên: signal mới + level mua\n` +
    `15:00-16:00 — Full scan 1411 mã, có gì bắn tiếp\n` +
    `Trong phiên — Spike alert (tăng mạnh) + exit alert (chạm SL/target)\n` +
    `\n_Tip: /scan chậm vì Cloudflare limit. Nếu cần nhanh → /quick (45 mã)._`;
}

async function buildPicksMessage(env) {
  const sb = sbClient(env);
  const climax = await sbQuery(sb, "climax_active_picks", {
    select: "symbol,signal_date,entry_price,tier,nn_net_5d_bn,peak_price,expires_at",
  }) || [];
  const midterm = await sbQuery(sb, "mid_term_active_picks", {
    select: "symbol,signal_date,entry_price,peak_price,expires_at",
  }) || [];

  // Filter active (expires_at > now) — sbQuery không có gte nên lọc phía client
  const now = new Date();
  const isActive = (p) => !p.expires_at || new Date(p.expires_at) > now;
  const activeClimax = climax.filter(isActive);
  const activeMidterm = midterm.filter(isActive);

  if (activeClimax.length === 0 && activeMidterm.length === 0) {
    return `📭 *Không có active picks*\n\nBot quét EOD 14:50 VN (T2-T6). Hoặc gõ /scan để quét ngay.`;
  }

  const fmtPick = (p, tag) => {
    const peakStr = p.peak_price
      ? ` · peak ${parseFloat(p.peak_price).toFixed(2)}`
      : "";
    const nnStr = p.nn_net_5d_bn != null
      ? ` · NN +${parseFloat(p.nn_net_5d_bn).toFixed(1)}B`
      : "";
    return `${tag} *${p.symbol}* @${parseFloat(p.entry_price).toFixed(2)} (${p.signal_date})${peakStr}${nnStr}`;
  };

  let text = `📋 *Active Picks*\n\n`;

  // Mid-term (Base Breakout) — primary pattern
  if (activeMidterm.length > 0) {
    text += `🔍 *Trung hạn (Base Breakout)* — hold T+30, trail 10%\n`;
    activeMidterm.slice(0, 15).forEach((p) => {
      text += fmtPick(p, "🔹") + "\n";
    });
    text += "\n";
  }

  // FBO
  const fboPicks = activeClimax.filter((p) => p.tier === "FBO");
  if (fboPicks.length > 0) {
    text += `🌊 *FBO (oversold + NN mua)* — T+5, target +3% / SL -8%\n`;
    fboPicks.slice(0, 10).forEach((p) => {
      text += fmtPick(p, "🔸") + "\n";
    });
    text += "\n";
  }

  // Climax tiers (Premium + Elite + A + B)
  const climaxTiers = activeClimax.filter((p) =>
    ["Premium", "Elite", "A", "B"].includes(p.tier)
  );
  if (climaxTiers.length > 0) {
    text += `🔻 *Bắt đáy T+5 (Climax)*\n`;
    climaxTiers.slice(0, 10).forEach((p) => {
      const tierIcon = { Premium: "💎", Elite: "⚡", A: "🟢", B: "🔵" }[p.tier] || "•";
      text += `${tierIcon} *${p.symbol}* @${parseFloat(p.entry_price).toFixed(2)} (${p.tier}, ${p.signal_date})\n`;
    });
    text += "\n";
  }

  // Momentum
  const momPicks = activeClimax.filter((p) => p.tier === "Momentum");
  if (momPicks.length > 0) {
    text += `🚀 *Momentum* — hold T+20, trail 7%\n`;
    momPicks.slice(0, 5).forEach((p) => {
      text += fmtPick(p, "⚡") + "\n";
    });
  }

  text += `\n_Reload PWA tab Rà soát để xem chi tiết._`;
  return text;
}

async function runQuickScan(env) {
  // Reuse quick-scan endpoint logic — scan 45 mã + persist
  const bbMatches = [];
  const fboMatches = [];
  const batchSize = 15;
  for (let i = 0; i < MID_TERM_QUICK_UNIVERSE.length; i += batchSize) {
    const batch = MID_TERM_QUICK_UNIVERSE.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sym) => {
      try {
        const data = await fetchVndHistory(sym, 365);
        const baseBreakout = detectBaseBreakout(data);
        const fboBase = detectForeignBackedOversoldBase(data);
        let fbo = null;
        if (fboBase) {
          const foreign = await fetchForeignDaily(sym, 7).catch(() => null);
          const nnNet5d = foreign ? computeNnNet5d(foreign) : null;
          if (nnNet5d != null && nnNet5d > 0) {
            fbo = { ...fboBase, nn_net_5d_bn: +(nnNet5d / 1e9).toFixed(2) };
          }
        }
        return { symbol: sym, baseBreakout, fbo };
      } catch { return null; }
    }));
    for (const r of results) {
      if (!r) continue;
      if (r.baseBreakout) bbMatches.push({ symbol: r.symbol, ...r.baseBreakout });
      if (r.fbo) fboMatches.push({ symbol: r.symbol, ...r.fbo });
    }
  }
  await persistMidTermMatches(env, bbMatches);
  await persistFBOMatches(env, fboMatches);
  return {
    scanned: MID_TERM_QUICK_UNIVERSE.length,
    bb: bbMatches.map((m) => m.symbol),
    fbo: fboMatches.map((m) => m.symbol),
  };
}

function buildScanResultMessage(summary) {
  const total = summary.bb.length + summary.fbo.length;
  let text = `✅ *Quét xong ${summary.scanned} mã*\n\n`;
  if (total === 0) {
    text += `📭 0 match. Pattern selective — đa số ngày 0-2 picks.\n_Full 1411 mã scan tự động qua EOD cron._`;
    return text;
  }
  if (summary.bb.length > 0) {
    text += `🔍 *Base Breakout (${summary.bb.length}):* ${summary.bb.join(", ")}\n\n`;
  }
  if (summary.fbo.length > 0) {
    text += `🌊 *FBO (${summary.fbo.length}):* ${summary.fbo.join(", ")}\n\n`;
  }
  text += `_Mở PWA tab Rà soát xem entry/SL/target chi tiết._`;
  return text;
}

async function buildStatsMessage(env) {
  const sb = sbClient(env);
  const headers = { apikey: sb.key, authorization: `Bearer ${sb.key}` };
  const sinceDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Cửa sổ tính theo resolved_at, KHÔNG theo signal_date: lệnh vào từ tháng
  // trước mà vừa chốt tuần này vẫn phải hiện, nếu không window tự giấu lỗ cũ.
  // Lệnh đang mở lấy hết, bất kể vào từ bao giờ.
  const [rWindow, rAll] = await Promise.all([
    fetch(`${sb.url}/rest/v1/trade_log?select=*&or=(resolved_at.gte.${sinceDate},resolved_at.is.null)&order=signal_date.desc&limit=200`, { headers }),
    fetch(`${sb.url}/rest/v1/trade_log?select=net_ret,is_win,exit_reason&resolved_at=not.is.null&limit=1000`, { headers }),
  ]);
  if (!rWindow.ok) return "❌ Lỗi fetch stats";
  const trades = await rWindow.json();
  const lifetime = rAll.ok
    ? (await rAll.json()).filter((t) => t.exit_reason !== "unresolved")
    : [];
  if (trades.length === 0) {
    return `📊 *Stats*\n\nKhông có lệnh nào chốt trong 30 ngày qua và cũng không có lệnh đang mở. Bot scan EOD T2-T6 — đợi signal rồi T+5 hoặc T+30 mới resolve.`;
  }
  // exit_reason='unresolved' = bỏ cuộc vì thiếu data, không có net_ret → loại
  // khỏi thống kê kẻo kéo tụt win rate bằng số 0 giả.
  const resolved = trades.filter((t) => t.resolved_at && t.exit_reason !== "unresolved");
  const giveUp = trades.filter((t) => t.exit_reason === "unresolved");
  const active = trades.filter((t) => !t.resolved_at);
  const wins = resolved.filter((t) => t.is_win).length;
  const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
  const totalRet = resolved.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);
  const avgRet = resolved.length > 0 ? (totalRet / resolved.length) * 100 : 0;
  const sign = (v) => (v >= 0 ? "+" : "");
  const px = (v) => (v == null ? "?" : parseFloat(v).toFixed(2));
  const tierTag = (t) => `${TIER_ICONS[t.tier] || "•"} ${t.tier || "?"}`;

  let text = `📊 *Stats* — chốt trong 30 ngày\n`;
  if (resolved.length > 0) {
    text += `${resolved.length} lệnh chốt · Win ${winRate.toFixed(0)}% · `;
    text += `${sign(avgRet)}${avgRet.toFixed(2)}%/lệnh · Cộng dồn ${sign(totalRet)}${(totalRet * 100).toFixed(1)}%\n`;
  } else {
    text += `Chưa chốt lệnh nào trong 30 ngày.\n`;
  }
  if (active.length > 0) text += `Đang mở ${active.length} lệnh.\n`;
  if (giveUp.length > 0) text += `_(${giveUp.length} lệnh bỏ qua — thiếu data)_\n`;
  // Không có dòng này thì lệnh chốt lỗ ngoài 30 ngày biến mất khỏi mọi con số.
  if (lifetime.length > resolved.length) {
    const lWins = lifetime.filter((t) => t.is_win).length;
    const lSum = lifetime.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);
    const lAvg = (lSum / lifetime.length) * 100;
    text += `_Toàn bộ lịch sử ${lifetime.length} lệnh: Win ${((lWins / lifetime.length) * 100).toFixed(0)}% · `;
    text += `${sign(lAvg)}${lAvg.toFixed(2)}%/lệnh · cộng dồn ${sign(lSum)}${(lSum * 100).toFixed(1)}%_\n`;
  }

  if (resolved.length > 0) {
    const rows = [...resolved].sort(
      (a, b) => parseFloat(b.net_ret || 0) - parseFloat(a.net_ret || 0)
    );
    text += `\n*✅ ĐÃ CHỐT*\n`;
    for (const t of rows.slice(0, STATS_LIST_LIMIT)) {
      const ret = parseFloat(t.net_ret || 0) * 100;
      const reason = EXIT_REASON_LABELS[t.exit_reason] || t.exit_reason || "?";
      text += `${ret >= 0 ? "🟢" : "🔴"} *${t.symbol}* ${tierTag(t)} · ${px(t.entry_price)}→${px(t.exit_price)} · `;
      text += `*${sign(ret)}${ret.toFixed(2)}%* · ${reason}${t.exit_day ? `, T+${t.exit_day}` : ""} _(${fmtVnDM(t.signal_date)})_\n`;
    }
    if (rows.length > STATS_LIST_LIMIT) {
      text += `_… và ${rows.length - STATS_LIST_LIMIT} lệnh khác_\n`;
    }
  }

  if (active.length > 0) {
    const open = [...active].sort((a, b) => b.signal_date.localeCompare(a.signal_date));
    // Cùng cách tính P&L với /signals: raw (cur-entry)/entry, chưa trừ phí —
    // hai lệnh mà lệch nhau thì user không biết tin cái nào.
    const quotes = new Map();
    await Promise.all(
      open.slice(0, SIGNALS_QUOTE_LIMIT).map(async (t) => {
        try {
          const h = await fetchVndHistory(t.symbol, 10);
          const last = h.closes[h.closes.length - 1];
          if (last > 0) quotes.set(t.symbol, last);
        } catch (e) {
          console.warn(`[stats] quote ${t.symbol}: ${e.message}`);
        }
      })
    );
    const today = vnDateString();
    text += `\n*⏳ ĐANG MỞ* _(tạm tính, chưa trừ phí)_\n`;
    for (const t of open) {
      const held = vnTradingDaysBetween(t.signal_date, today);
      const hold = t.max_hold_days || 5;
      const entry = t.entry_price != null ? parseFloat(t.entry_price) : null;
      const cur = quotes.get(t.symbol);
      let pnl = "—";
      let icon = "⏳";
      if (cur != null && entry != null) {
        const ret = ((cur - entry) / entry) * 100;
        pnl = `${px(cur)} · *${sign(ret)}${ret.toFixed(2)}%*`;
        icon = ret >= 0 ? "🟢" : "🔴";
      }
      text += `${icon} *${t.symbol}* ${tierTag(t)} · ${px(entry)}→${pnl} · T+${held}/${hold} _(${fmtVnDM(t.signal_date)})_\n`;
    }
  }

  // Per-tier breakdown
  const tiers = {};
  for (const t of resolved) {
    if (!tiers[t.tier]) tiers[t.tier] = { n: 0, wins: 0, sumRet: 0 };
    tiers[t.tier].n++;
    if (t.is_win) tiers[t.tier].wins++;
    tiers[t.tier].sumRet += parseFloat(t.net_ret || 0);
  }
  if (Object.keys(tiers).length > 0) {
    text += `\n*Theo tier:*\n`;
    for (const [tier, s] of Object.entries(tiers)) {
      const tWin = (s.wins / s.n) * 100;
      const tAvg = (s.sumRet / s.n) * 100;
      text += `• ${tier}: ${s.n} lệnh · ${tWin.toFixed(0)}% win · ${sign(tAvg)}${tAvg.toFixed(2)}%/lệnh\n`;
    }
  }

  // Regime + màu VNI phiên signal — chỉ có data từ khi bổ sung context columns
  const withCtx = resolved.filter((t) => t.vni_regime);
  if (withCtx.length > 0) {
    const agg = (rows) => {
      const n = rows.length;
      if (n === 0) return null;
      const w = rows.filter((t) => t.is_win).length;
      const avg = rows.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0) / n * 100;
      return `${n} lệnh · ${((w / n) * 100).toFixed(0)}% win · ${sign(avg)}${avg.toFixed(2)}%/lệnh`;
    };
    text += `\n*Theo regime:*\n`;
    for (const rg of ["correction", "neutral", "bull"]) {
      const line = agg(withCtx.filter((t) => t.vni_regime === rg));
      if (line) text += `• ${rg}: ${line}\n`;
    }
    const green = agg(withCtx.filter((t) => t.vni_change_pct > 0));
    const red = agg(withCtx.filter((t) => t.vni_change_pct <= 0));
    if (green || red) {
      text += `\n*Màu VNI phiên signal:*\n`;
      if (green) text += `• 🟢 xanh: ${green}\n`;
      if (red) text += `• 🔴 đỏ: ${red}\n`;
    }
  }
  return text;
}

// ── /signals — mã ĐÃ và ĐANG signal trong 7 ngày ────────────────────
// trade_log là nguồn chính (Climax tiers / FBO / MidTerm). Momentum không được
// ghi vào trade_log nên phải đọc thêm từ climax_active_picks, nếu không sẽ sót.
const SIGNALS_WINDOW_DAYS = 7;
// Mỗi mã = 1 subrequest VND; chặn trần để /signals không đụng limit của Worker
const SIGNALS_QUOTE_LIMIT = 12;
// /stats liệt kê từng lệnh; cắt bớt kẻo Telegram cụt tin khi trade_log phình.
const STATS_LIST_LIMIT = 15;

const TIER_ICONS = {
  Premium: "💎", Elite: "⚡", A: "🟢", B: "🔵",
  FBO: "🌊", MidTerm: "🔍", Momentum: "🚀",
};

const EXIT_REASON_LABELS = {
  target: "chạm target", sl: "cắt lỗ", trail: "trail stop",
  force: "hết hạn hold", unresolved: "không resolve được",
};

// ── Paper trade: nhật ký lệnh tay của user ────────────────────────────
// Sổ lệnh của USER, không phải của bot: mã nào cũng ghi được, kể cả mã bot
// không hề gợi ý. Nhãn bot_tier chỉ để lúc thống kê tách được "theo signal"
// vs "tự chế" — không phải điều kiện để ghi.
const PAPER_FEE_PCT = 0.4;      // khứ hồi, cùng mức trade_log dùng để hai bên so được
const PAPER_QUOTE_LIMIT = 12;   // mỗi mã 1 subrequest VND
const PAPER_SIGNAL_LOOKBACK = 10;  // signal cũ hơn ngần này phiên thì coi như không liên quan

// `/b MÃ GIÁ [SL]` — SL = số lượng cổ phiếu, tuỳ chọn (không có thì chỉ theo dõi %).
function parsePaperCommand(text) {
  const parts = text.trim().split(/\s+/);
  const symbol = (parts[1] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nums = parts.slice(2).map((p) => parseFloat(p));
  if (symbol.length < 3 || nums.length === 0 || nums.length > 2) return null;
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const qty = nums[1] ?? null;
  if (qty != null && !Number.isInteger(qty)) return null;
  return { symbol, price: nums[0], qty };
}

// Giá niêm yết đơn vị nghìn đồng (17.88 = 17.880đ), SL đơn vị cổ phiếu.
function paperCost(price, qty) {
  return price * qty * 1000;
}

// Luôn kèm dấu: số tiền hay nằm trong ngoặc, không có dấu thì không biết lãi hay lỗ.
function fmtVnd(amount) {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "+";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)} tỷ`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)} tr`;
  return `${sign}${Math.round(abs / 1e3)} ngh`;
}

// Vốn bỏ ra thì không có chiều lãi/lỗ — đừng gắn dấu vào.
function fmtVndAbs(amount) {
  return fmtVnd(Math.abs(amount)).slice(1);
}

function fmtQty(qty) {
  return qty.toLocaleString("en-US");
}

// Bot có bắn signal cho mã này gần đây không → tách "theo bot" vs "tự chế".
async function findRecentBotSignal(sb, symbol) {
  const rows = await sbQuery(sb, "trade_log", {
    select: "symbol,signal_date,tier",
    eq: { symbol },
  });
  if (!rows?.length) return null;
  const today = vnDateString();
  return rows
    .filter((r) => vnTradingDaysBetween(r.signal_date, today) <= PAPER_SIGNAL_LOOKBACK)
    .sort((a, b) => (a.signal_date < b.signal_date ? 1 : -1))[0] || null;
}

const PAPER_BUY_USAGE = "Usage: `/b <MÃ> <GIÁ> [SL]` — vd `/b SHS 17.88 1000`\n(SL = số lượng cổ phiếu, bỏ trống thì chỉ theo dõi %)";

async function handlePaperBuy(env, chatId, text) {
  const cmd = parsePaperCommand(text);
  if (!cmd) return PAPER_BUY_USAGE;

  const sb = sbClient(env);
  const signal = await findRecentBotSignal(sb, cmd.symbol);
  const ok = await sbUpsert(sb, "paper_trades", {
    chat_id: chatId,
    symbol: cmd.symbol,
    entry_price: cmd.price,
    entry_date: vnDateString(),
    quantity: cmd.qty,
    status: "open",
    bot_tier: signal?.tier ?? null,
    bot_signal_date: signal?.signal_date ?? null,
  });
  if (!ok) return "❌ Không ghi được lệnh (chạy `sql/013` chưa?)";

  let msg = `✅ Ghi MUA *${cmd.symbol}* @ ${cmd.price.toFixed(2)}`;
  msg += cmd.qty != null ? ` × ${fmtQty(cmd.qty)} = ${fmtVndAbs(paperCost(cmd.price, cmd.qty))}` : "";
  msg += ` · ${vnDayLabel()}\n`;
  msg += signal
    ? `   Khớp signal bot: *${signal.tier}* ${fmtVnDMY(signal.signal_date)}\n`
    : `   Bot không signal mã này ${PAPER_SIGNAL_LOOKBACK} phiên qua — lệnh tự chế\n`;
  try {
    const h = await fetchVndHistory(cmd.symbol, 5);
    const last = h.closes[h.closes.length - 1];
    if (last > 0) msg += `   Giá thị trường gần nhất ${last.toFixed(2)}\n`;
  } catch (e) {
    console.warn(`[paper] quote ${cmd.symbol}: ${e.message}`);
  }
  return `${msg}\n\`/pos\` xem lệnh đang mở · \`/s ${cmd.symbol} <giá>\` để đóng`;
}

const PAPER_SELL_USAGE = "Usage: `/s <MÃ> <GIÁ> [SL]` — vd `/s SHS 18.5 400`\n(bỏ SL = đóng nguyên lot cũ nhất · `/s` không tham số vẫn là quick scan)";

async function handlePaperSell(env, chatId, text) {
  const cmd = parsePaperCommand(text);
  if (!cmd) return PAPER_SELL_USAGE;
  const sellQty = cmd.qty;

  const sb = sbClient(env);
  const rows = await sbQuery(sb, "paper_trades", {
    select: "id,symbol,entry_price,entry_date,quantity,bot_tier,bot_signal_date",
    eq: { chat_id: chatId, symbol: cmd.symbol, status: "open" },
  });
  if (rows == null) return "❌ Lỗi đọc lệnh (chạy `sql/013` chưa?)";
  if (rows.length === 0) return `Không có lệnh *${cmd.symbol}* nào đang mở. \`/pos\` xem danh sách.`;

  const lots = [...rows].sort((a, b) => (a.entry_date < b.entry_date ? -1 : 1));  // FIFO
  const held = lots.reduce((s, l) => s + (l.quantity != null ? +l.quantity : 0), 0);

  // Chia KL bán cho từng lot TRƯỚC khi ghi, để lệnh quá tay bị chặn sạch chứ
  // không ghi được nửa chừng rồi mới lỗi.
  const plan = [];
  if (sellQty == null) {
    plan.push({ lot: lots[0], qtyOut: lots[0].quantity != null ? +lots[0].quantity : null, partial: false });
  } else {
    if (lots.some((l) => l.quantity == null)) {
      return `❌ Có lot *${cmd.symbol}* chưa ghi số lượng nên không chia phần được. Bỏ số lượng đi để đóng nguyên lot cũ nhất.`;
    }
    if (sellQty > held) return `❌ Đang giữ ${fmtQty(held)} ${cmd.symbol}, không bán được ${fmtQty(sellQty)}.`;
    let remain = sellQty;
    for (const lot of lots) {
      if (remain <= 0) break;
      const q = Math.min(+lot.quantity, remain);
      plan.push({ lot, qtyOut: q, partial: q < +lot.quantity });
      remain -= q;
    }
  }

  const today = vnDateString();
  const netRetOf = (entry) => (cmd.price / entry - 1) * 100 - PAPER_FEE_PCT;
  for (const p of plan) {
    const netRet = +netRetOf(parseFloat(p.lot.entry_price)).toFixed(2);
    if (p.partial) {
      // Bán một phần: lot gốc giữ id và teo SL lại, phần đã bán tách thành row closed.
      const okSplit = await sbUpdate(sb, "paper_trades", {
        eq: { id: p.lot.id },
        data: { quantity: +p.lot.quantity - p.qtyOut },
      });
      if (!okSplit) return "❌ Không tách được lot.";
      await sbUpsert(sb, "paper_trades", {
        chat_id: chatId, symbol: cmd.symbol,
        entry_price: p.lot.entry_price, entry_date: p.lot.entry_date,
        quantity: p.qtyOut,
        exit_price: cmd.price, exit_date: today,
        net_ret_pct: netRet, status: "closed",
        bot_tier: p.lot.bot_tier, bot_signal_date: p.lot.bot_signal_date,
      });
    } else {
      const ok = await sbUpdate(sb, "paper_trades", {
        eq: { id: p.lot.id },
        data: {
          exit_price: cmd.price, exit_date: today,
          net_ret_pct: netRet, status: "closed",
        },
      });
      if (!ok) return "❌ Không cập nhật được lệnh.";
    }
  }

  const soldQty = plan.every((p) => p.qtyOut != null)
    ? plan.reduce((s, p) => s + p.qtyOut, 0) : null;
  let msg = `✅ Ghi BÁN *${cmd.symbol}* @ ${cmd.price.toFixed(2)}`;
  msg += soldQty != null ? ` × ${fmtQty(soldQty)}\n` : `\n`;

  let pnlVnd = 0;
  for (const p of plan) {
    const entry = parseFloat(p.lot.entry_price);
    const netRet = netRetOf(entry);
    const days = vnTradingDaysBetween(p.lot.entry_date, today);
    const money = p.qtyOut != null ? paperCost(entry, p.qtyOut) * (netRet / 100) : 0;
    pnlVnd += money;
    msg += `   Mua ${entry.toFixed(2)} (${fmtVnDMY(p.lot.entry_date)}) · giữ ${days} phiên · `;
    msg += `${netRet >= 0 ? "🟢 +" : "🔴 "}${netRet.toFixed(2)}%`;
    msg += p.qtyOut != null ? ` (${fmtVnd(money)})\n` : `\n`;
  }
  if (plan.length > 1 || soldQty != null) {
    msg += `   ${pnlVnd >= 0 ? "🟢" : "🔴"} *${fmtVnd(pnlVnd)}* (đã trừ phí ${PAPER_FEE_PCT}%)\n`;
  }

  const leftQty = soldQty != null ? held - soldQty : null;
  if (leftQty != null && leftQty > 0) msg += `   Còn ${fmtQty(leftQty)} ${cmd.symbol} đang mở\n`;
  else if (leftQty == null && lots.length > 1) msg += `   Còn ${lots.length - 1} lot ${cmd.symbol} đang mở\n`;
  return `${msg}\n\`/pnl\` xem tổng kết`;
}

async function buildPaperPositionsMessage(env, chatId) {
  const sb = sbClient(env);
  const rows = await sbQuery(sb, "paper_trades", {
    select: "symbol,entry_price,entry_date,quantity,bot_tier,bot_signal_date",
    eq: { chat_id: chatId, status: "open" },
  });
  if (rows == null) return "❌ Lỗi đọc lệnh (chạy `sql/013` chưa?)";
  if (rows.length === 0) return "📭 Chưa có lệnh nào đang mở.\nGhi lệnh: `/b SHS 17.88 1000`";

  const quotes = new Map();
  await Promise.all(rows.slice(0, PAPER_QUOTE_LIMIT).map(async (r) => {
    try {
      const h = await fetchVndHistory(r.symbol, 5);
      const last = h.closes[h.closes.length - 1];
      if (last > 0) quotes.set(r.symbol, last);
    } catch (e) {
      console.warn(`[paper] quote ${r.symbol}: ${e.message}`);
    }
  }));

  const today = vnDateString();
  let sum = 0, counted = 0, capital = 0, pnlVnd = 0, body = "";
  for (const r of [...rows].sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1))) {
    const entry = parseFloat(r.entry_price);
    const qty = r.quantity != null ? +r.quantity : null;
    const held = vnTradingDaysBetween(r.entry_date, today);
    const tag = r.bot_tier ? `${r.bot_tier} ${fmtVnDMY(r.bot_signal_date)}` : "tự chế";
    body += `• *${r.symbol}* @${entry.toFixed(2)}`;
    body += qty != null ? ` ×${fmtQty(qty)} = ${fmtVndAbs(paperCost(entry, qty))}` : "";
    body += ` · ${fmtVnDMY(r.entry_date)} · T+${held} · ${tag}\n`;
    const cur = quotes.get(r.symbol);
    if (cur != null) {
      const ret = (cur / entry - 1) * 100 - PAPER_FEE_PCT;
      sum += ret;
      counted++;
      body += `   Nay ${cur.toFixed(2)} · ${ret >= 0 ? "🟢 +" : "🔴 "}${ret.toFixed(2)}%`;
      if (qty != null) {
        const money = paperCost(entry, qty) * (ret / 100);
        capital += paperCost(entry, qty);
        pnlVnd += money;
        body += ` (${fmtVnd(money)})`;
      }
      body += `\n`;
    }
  }
  let head = `📓 *Lệnh đang mở* (${rows.length})`;
  if (counted > 0) {
    const avg = sum / counted;
    head += ` — tạm tính ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%/lệnh`;
  }
  // Chỉ cộng tiền cho lot có ghi SL — lot thiếu SL vẫn tính % nhưng không kéo tổng.
  if (capital > 0) {
    head += `\nVốn ${fmtVndAbs(capital)} · ${pnlVnd >= 0 ? "🟢" : "🔴"} *${fmtVnd(pnlVnd)}* (${((pnlVnd / capital) * 100).toFixed(2)}%)`;
  }
  return `${head}\n\n${body}\n_Đã trừ phí ${PAPER_FEE_PCT}%._ \`/s <MÃ> <giá>\` _để đóng._`;
}

// /pos — danh mục thật trong app (bảng transactions).
// KHÔNG trừ phí ở đây: avgCost đã gồm phí mua vì loadHoldingsIndex dựng theo
// đúng computeHoldings() bên PWA. Trừ thêm là hai màn hình ra hai con số.
async function buildPortfolioMessage(env, chatId) {
  const sb = sbClient(env);
  const { portfolio, paperCountFor } = await loadHoldingsIndex(sb);
  // Sổ /b vẫn ghi được nhưng không còn màn nào hiện — nói ra kẻo /b thành lệnh
  // ghi rồi mất.
  const paperOpen = paperCountFor(chatId);
  const paperNote = paperOpen > 0
    ? `\n_Sổ \`/b\` còn ${paperOpen} lot mở, không hiện ở đây._`
    : "";
  if (portfolio.size === 0) {
    return `📭 Danh mục trống — chưa có giao dịch nào trong app.${paperNote}`;
  }

  const syms = [...portfolio.keys()];
  const quotes = new Map();
  await Promise.all(syms.slice(0, PAPER_QUOTE_LIMIT).map(async (s) => {
    try {
      const h = await fetchVndHistory(s, 10);
      const last = h.closes[h.closes.length - 1];
      if (last > 0) quotes.set(s, last);
    } catch (e) {
      console.warn(`[portfolio] quote ${s}: ${e.message}`);
    }
  }));

  const today = vnDateString();
  const rows = syms
    .map((s) => {
      const h = portfolio.get(s);
      const cost = paperCost(h.avgCost, h.qty);
      const cur = quotes.get(s) ?? null;
      return { sym: s, ...h, cost, cur, value: cur != null ? paperCost(cur, h.qty) : null };
    })
    .sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost));

  let totalCost = 0, pricedCost = 0, pricedValue = 0, body = "";
  for (const r of rows) {
    totalCost += r.cost;
    const held = r.firstBuyDate ? vnTradingDaysBetween(r.firstBuyDate, today) : null;
    body += `• *${r.sym}* @${r.avgCost.toFixed(2)} ×${fmtQty(r.qty)} = ${fmtVndAbs(r.cost)}`;
    body += held != null ? ` · T+${held}\n` : `\n`;
    if (r.value == null) {
      body += `   _chưa lấy được giá_\n`;
      continue;
    }
    pricedCost += r.cost;
    pricedValue += r.value;
    const ret = (r.cur / r.avgCost - 1) * 100;
    body += `   Nay ${r.cur.toFixed(2)} · ${ret >= 0 ? "🟢 +" : "🔴 "}${ret.toFixed(2)}% (${fmtVnd(r.value - r.cost)})\n`;
  }

  const priced = rows.filter((r) => r.value != null).length;
  let head = `📁 *Danh mục* (${rows.length} mã)\nVốn ${fmtVndAbs(totalCost)}`;
  if (pricedCost > 0) {
    const pnl = pricedValue - pricedCost;
    const pct = ((pnl / pricedCost) * 100).toFixed(2);
    // Mã thiếu quote không được trộn vào tổng, nếu không lãi/lỗ ra số sai.
    head += priced === rows.length
      ? ` · Nay ${fmtVndAbs(pricedValue)} · ${pnl >= 0 ? "🟢" : "🔴"} *${fmtVnd(pnl)}* (${pct}%)`
      : `\n${priced}/${rows.length} mã có giá: vốn ${fmtVndAbs(pricedCost)} · nay ${fmtVndAbs(pricedValue)} · ${pnl >= 0 ? "🟢" : "🔴"} *${fmtVnd(pnl)}* (${pct}%)`;
  }
  return `${head}\n\n${body}\n_Giá vốn gồm phí mua, chưa trừ phí bán._${paperNote}`;
}

async function buildPaperPnlMessage(env, chatId) {
  const sb = sbClient(env);
  const rows = await sbQuery(sb, "paper_trades", {
    select: "symbol,entry_price,entry_date,exit_price,exit_date,quantity,net_ret_pct,bot_tier,bot_signal_date",
    eq: { chat_id: chatId, status: "closed" },
  });
  if (rows == null) return "❌ Lỗi đọc lệnh (chạy `sql/013` chưa?)";
  if (rows.length === 0) return "📭 Chưa đóng lệnh nào. `/pos` xem lệnh đang mở.";

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const seg = (label, arr) => {
    if (arr.length === 0) return `${label}: chưa có\n`;
    const a = arr.map((r) => parseFloat(r.net_ret_pct || 0));
    const w = a.filter((x) => x > 0).length;
    return `${label}: ${arr.length} lệnh · win ${((w / arr.length) * 100).toFixed(0)}% · avg ${mean(a) >= 0 ? "+" : ""}${mean(a).toFixed(2)}%\n`;
  };

  const rets = rows.map((r) => parseFloat(r.net_ret_pct || 0));
  const wins = rets.filter((x) => x > 0).length;
  const followed = rows.filter((r) => r.bot_tier);
  let msg = `📈 *Paper trade* — ${rows.length} lệnh đã đóng\n\n`;
  msg += `Win ${wins}/${rows.length} (${((wins / rows.length) * 100).toFixed(0)}%) · avg ${mean(rets) >= 0 ? "+" : ""}${mean(rets).toFixed(2)}%/lệnh\n`;
  msg += `Cộng dồn ${rets.reduce((s, x) => s + x, 0).toFixed(2)}%\n\n`;
  msg += `*Nguồn lệnh:*\n`;
  msg += seg("Theo signal bot", followed);
  msg += seg("Tự chế", rows.filter((r) => !r.bot_tier));

  // Tiền chỉ cộng được cho lệnh có ghi SL; lệnh thiếu SL vẫn nằm trong phần % ở trên.
  const withQty = rows.filter((r) => r.quantity != null);
  if (withQty.length > 0) {
    let cap = 0, pnl = 0;
    for (const r of withQty) {
      const c = paperCost(parseFloat(r.entry_price), +r.quantity);
      cap += c;
      pnl += c * (parseFloat(r.net_ret_pct || 0) / 100);
    }
    msg += `\n*Tiền:* ${pnl >= 0 ? "🟢" : "🔴"} *${fmtVnd(pnl)}* trên vốn ${fmtVndAbs(cap)} (${((pnl / cap) * 100).toFixed(2)}%)`;
    if (withQty.length < rows.length) msg += ` — ${rows.length - withQty.length} lệnh không ghi số lượng nên không tính`;
    msg += `\n`;
  }

  // Cùng signal đó bot tự chấm ra bao nhiêu — đây mới là câu trả lời cho
  // "follow bot thì hơn hay kém tự đánh".
  if (followed.length > 0) {
    const botRows = await sbQuery(sb, "trade_log", {
      select: "symbol,signal_date,net_ret,resolved_at,exit_reason",
      in: { symbol: [...new Set(followed.map((r) => r.symbol))] },
    });
    const pairs = [];
    for (const f of followed) {
      const b = (botRows || []).find((x) =>
        x.symbol === f.symbol && x.signal_date === f.bot_signal_date &&
        x.resolved_at && x.exit_reason !== "unresolved" && x.net_ret != null);
      if (b) pairs.push({ sym: f.symbol, mine: parseFloat(f.net_ret_pct || 0), bot: parseFloat(b.net_ret) * 100 });
    }
    if (pairs.length > 0) {
      msg += `\n*Mày vs bot* (${pairs.length} lệnh bot đã chốt xong):\n`;
      for (const p of pairs) {
        msg += `  ${p.sym}: mày ${p.mine >= 0 ? "+" : ""}${p.mine.toFixed(2)}% · bot ${p.bot >= 0 ? "+" : ""}${p.bot.toFixed(2)}%\n`;
      }
      const dm = mean(pairs.map((p) => p.mine));
      const db = mean(pairs.map((p) => p.bot));
      msg += `  → mày ${dm >= 0 ? "+" : ""}${dm.toFixed(2)}% vs bot ${db >= 0 ? "+" : ""}${db.toFixed(2)}%/lệnh\n`;
    } else {
      msg += `\n_Bot chưa chốt xong lệnh nào cùng signal để so._\n`;
    }
  }
  return `${msg}\n_Mẫu còn nhỏ thì đừng vội kết luận._`;
}

async function buildSignalsMessage(env) {
  const sb = sbClient(env);
  const headers = { apikey: sb.key, authorization: `Bearer ${sb.key}` };
  const today = vnDateString();
  const since = vnDateString(new Date(Date.now() - SIGNALS_WINDOW_DAYS * 24 * 3600 * 1000));
  // KHÔNG select cột của sql/011 ở đây — migration chạy sau code thì PostgREST
  // trả 400 cho cả query và /signals chết hẳn, đổi lấy data không dùng tới.
  const cols = "symbol,signal_date,tier,pattern_type,entry_price,target_price,sl_price,max_hold_days,trail_pct,resolved_at,exit_price,exit_day,exit_reason,net_ret,is_win,is_premium";

  const [recentRes, staleRes, climaxPicks, midtermPicks] = await Promise.all([
    fetch(`${sb.url}/rest/v1/trade_log?select=${cols}&signal_date=gte.${since}&order=signal_date.desc&limit=100`, { headers }),
    // Signal cũ hơn window nhưng CHƯA đóng (MidTerm hold tới 30 phiên) — gom 1 dòng
    fetch(`${sb.url}/rest/v1/trade_log?select=symbol,signal_date,tier&resolved_at=is.null&signal_date=lt.${since}&order=signal_date.desc&limit=50`, { headers }),
    sbQuery(sb, "climax_active_picks", { select: "symbol,signal_date,entry_price,target_price,tier,expires_at" }),
    sbQuery(sb, "mid_term_active_picks", { select: "symbol,signal_date,entry_price,max_hold_days,expires_at" }),
  ]);

  if (!recentRes.ok) return "❌ Lỗi fetch signals";
  const trades = await recentRes.json();
  const stale = staleRes.ok ? await staleRes.json() : [];

  const openFromLog = trades.filter((t) => !t.resolved_at);
  const closed = trades.filter((t) => t.resolved_at);

  // Bảng active picks mới là nguồn chuẩn cho "đang mở": Momentum không được ghi
  // vào trade_log, và pick nào miss trade_log (lỗi lúc persist) vẫn phải hiện ra.
  const stillActive = (p) => !p.expires_at || new Date(p.expires_at) > new Date();
  const inLog = new Set(openFromLog.map((t) => `${t.symbol}|${t.signal_date}`));
  const extraPicks = [
    ...(climaxPicks || []).filter(stillActive).map((p) => ({
      ...p, max_hold_days: pickMaxHold(p),
    })),
    ...(midtermPicks || []).filter(stillActive).map((p) => ({
      ...p, tier: "MidTerm", max_hold_days: p.max_hold_days || 30,
    })),
  ].filter((p) => !inLog.has(`${p.symbol}|${p.signal_date}`));

  const open = [...openFromLog, ...extraPicks].sort((a, b) =>
    b.signal_date.localeCompare(a.signal_date)
  );

  if (open.length === 0 && closed.length === 0 && stale.length === 0) {
    return `📭 *Signals ${SIGNALS_WINDOW_DAYS} ngày qua*\n\n` +
      `Chưa có signal nào từ ${fmtVnDMY(since)}.\n` +
      `Pattern selective — đa số ngày 0-2 picks. Gõ /scan để quét ngay.`;
  }

  // Giá hiện tại cho lệnh đang mở — không có nó thì /signals chỉ nói "đang mở"
  // mà không nói đang lãi lỗ bao nhiêu, tức là thiếu đúng thứ cần để quyết định.
  const quotes = new Map();
  await Promise.all(
    open.slice(0, SIGNALS_QUOTE_LIMIT).map(async (t) => {
      try {
        const h = await fetchVndHistory(t.symbol, 10);
        const last = h.closes[h.closes.length - 1];
        if (last > 0) quotes.set(t.symbol, last);
      } catch (e) {
        console.warn(`[signals] quote ${t.symbol}: ${e.message}`);
      }
    })
  );

  const fmtOpen = (t) => {
    const icon = TIER_ICONS[t.tier] || "•";
    const held = vnTradingDaysBetween(t.signal_date, today);
    const hold = t.max_hold_days || 5;
    const left = hold - held;
    const status = left > 0 ? `còn ${left} phiên` : "quá hạn, chờ resolve";
    const entry = t.entry_price != null ? parseFloat(t.entry_price) : null;
    const entryTag = entry != null ? ` @${entry.toFixed(2)}` : "";
    let line = `${icon} *${t.symbol}*${entryTag} · ${t.tier} · ${fmtVnDM(t.signal_date)} — T+${held}/${hold}, ${status}\n`;

    const cur = quotes.get(t.symbol);
    if (cur == null || entry == null) return line;

    const ret = ((cur - entry) / entry) * 100;
    line += `   Nay ${cur.toFixed(2)} · *${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%*`;

    // MidTerm/Momentum chốt bằng trailing stop — target_price của chúng chỉ là
    // giá trị lấp cột NOT NULL, hiện ra như mốc chốt sẽ khiến bán sớm.
    if (t.trail_pct) {
      line += ` · trail ${t.trail_pct}% từ đỉnh`;
      return line + "\n";
    }

    const tp = t.target_price != null ? parseFloat(t.target_price) : null;
    const sl = t.sl_price != null ? parseFloat(t.sl_price) : entry * 0.92;
    if (tp != null && cur >= tp) line += ` · 🎯 chạm TP ${tp.toFixed(2)}`;
    else if (cur <= sl) line += ` · 🔴 thủng SL ${sl.toFixed(2)}`;
    else {
      if (tp != null) line += ` · TP ${tp.toFixed(2)}`;
      line += ` · SL ${sl.toFixed(2)}`;
    }
    return line + "\n";
  };

  const fmtClosed = (t) => {
    const ret = parseFloat(t.net_ret || 0) * 100;
    const icon = t.is_win ? "✅" : "❌";
    const reason = EXIT_REASON_LABELS[t.exit_reason] || t.exit_reason || "?";
    const dayTag = t.exit_day ? ` T+${t.exit_day}` : "";
    return `${icon} *${t.symbol}* · ${t.tier} · ${fmtVnDM(t.signal_date)} — ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% (${reason}${dayTag})`;
  };

  let text = `📡 *Signals ${SIGNALS_WINDOW_DAYS} ngày qua* (từ ${fmtVnDMY(since)})\n`;
  text += `${open.length} đang mở · ${closed.length} đã đóng\n\n`;

  if (open.length > 0) {
    const marked = open.filter((t) => quotes.has(t.symbol) && t.entry_price != null);
    let header = `🟡 *ĐANG MỞ*`;
    if (marked.length > 0) {
      const sum = marked.reduce((s, t) => {
        const e = parseFloat(t.entry_price);
        return s + ((quotes.get(t.symbol) - e) / e) * 100;
      }, 0);
      header += ` — tạm tính ${sum >= 0 ? "+" : ""}${sum.toFixed(2)}% (${marked.length} mã)`;
    }
    text += `${header}\n`;
    open.forEach((t) => { text += fmtOpen(t); });
    text += `\n`;
  }

  if (closed.length > 0) {
    const wins = closed.filter((t) => t.is_win).length;
    const sumRet = closed.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0) * 100;
    text += `⚪ *ĐÃ ĐÓNG* — win ${((wins / closed.length) * 100).toFixed(0)}% (${wins}/${closed.length}), tổng ${sumRet >= 0 ? "+" : ""}${sumRet.toFixed(2)}%\n`;
    closed.forEach((t) => { text += fmtClosed(t) + "\n"; });
    text += `\n`;
  }

  if (stale.length > 0) {
    const syms = stale.map((t) => t.symbol).join(", ");
    text += `➕ _${stale.length} mã đang mở từ trước ${fmtVnDMY(since)}: ${syms}_\n\n`;
  }

  text += `_/picks xem chi tiết plan · /stats xem hiệu suất 30 ngày._`;
  return text;
}

async function buildCheckSymbolMessage(env, symbol) {
  try {
    const data = await fetchVndHistory(symbol, 365);
    if (!data || !data.closes?.length) return `❌ Không fetch được data ${symbol}`;

    const climax = detectVolClimaxBounce(data);
    const momentum = detectStrengthContinuation(data);
    const baseBreakout = detectBaseBreakout(data);
    const fboBase = detectForeignBackedOversoldBase(data);

    const n = data.closes.length;
    const cur = data.closes[n - 1];

    let text = `🔍 *Check ${symbol}*\n\nGiá hiện tại: ${cur.toFixed(2)}\n\n`;

    const matches = [];
    if (climax) matches.push(`🔻 Climax Tier ${climax.tier} (drop ${climax.ret3d.toFixed(1)}%, vol ${climax.volRatio.toFixed(1)}×, RSI ${climax.rsi.toFixed(0)})`);
    if (momentum) matches.push(`🚀 Momentum (vol ${momentum.volRatio?.toFixed(1)}×)`);
    if (baseBreakout) matches.push(`🔍 Base Breakout (break +${baseBreakout.breakStrength.toFixed(1)}% above prev high, vol ${baseBreakout.volRatio.toFixed(1)}×)`);

    if (fboBase) {
      // Need foreign check
      const foreign = await fetchForeignDaily(symbol, 7).catch(() => null);
      const nnNet5d = foreign ? computeNnNet5d(foreign) : null;
      if (nnNet5d != null && nnNet5d > 0) {
        matches.push(`🌊 FBO (drop ${fboBase.ret3d.toFixed(1)}%, RSI ${fboBase.rsi.toFixed(0)}, NN 5d +${(nnNet5d/1e9).toFixed(1)}B)`);
      } else {
        matches.push(`🌊 FBO base match (drop ${fboBase.ret3d.toFixed(1)}%, RSI ${fboBase.rsi.toFixed(0)}) NHƯNG NN 5d ${nnNet5d != null ? (nnNet5d/1e9).toFixed(1) + "B" : "?"} (cần >0) ✗`);
      }
    }

    if (matches.length === 0) {
      text += `📭 Không match pattern nào (Climax / Momentum / Base Breakout / FBO).`;
    } else {
      text += `✅ *Match patterns:*\n${matches.join("\n")}`;
    }
    return text;
  } catch (e) {
    return `❌ Lỗi check ${symbol}: ${e.message}`;
  }
}

async function buildRegimeMessage(env) {
  try {
    const vni = await fetchVndHistory("VNINDEX", 60);
    const cs = vni.closes;
    const n = cs.length;
    if (n < 50) return "❌ Không đủ VNI data";

    const cur = cs[n - 1];
    const ret20 = ((cur - cs[n - 21]) / cs[n - 21]) * 100;
    const ret60 = ((cur - cs[n - 60]) / cs[n - 60]) * 100;

    // MA50
    let maSum = 0;
    for (let i = n - 50; i < n; i++) maSum += cs[i];
    const ma50 = maSum / 50;
    const aboveMa50 = cur > ma50;

    // Realized vol 20d
    let vols = [];
    for (let i = n - 20; i < n; i++) {
      vols.push((cs[i] - cs[i - 1]) / cs[i - 1]);
    }
    const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
    const stdDaily = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / vols.length) * 100;

    let trendLabel = aboveMa50 ? "📈 Uptrend (>MA50)" : "📉 Downtrend (<MA50)";
    let volLabel = stdDaily < 1.0 ? "🟢 Low" : (stdDaily < 1.5 ? "🟡 Medium" : "🔴 High");

    let text = `📊 *VNI Regime hiện tại*\n\n`;
    text += `VNI: ${cur.toFixed(2)}\n`;
    text += `Return: ${ret20 >= 0 ? "+" : ""}${ret20.toFixed(1)}% (20d) · ${ret60 >= 0 ? "+" : ""}${ret60.toFixed(1)}% (60d)\n`;
    text += `Trend: ${trendLabel}\n`;
    text += `Vol 20d realized: ${stdDaily.toFixed(2)}%/day → ${volLabel}\n\n`;
    text += `*Pattern aptitude:*\n`;
    if (aboveMa50 && stdDaily < 1.2) {
      text += `🟢 Low-vol uptrend → Base Breakout work tốt nhất\n`;
    } else if (!aboveMa50 && stdDaily > 1.2) {
      text += `🌊 High-vol downtrend → FBO (oversold + NN mua) có thể fire\n`;
    } else {
      text += `🟡 Mixed regime → cautious, đợi pattern setup rõ\n`;
    }
    return text;
  } catch (e) {
    return `❌ Lỗi fetch VNI: ${e.message}`;
  }
}

// ── Cron: check all active watches (not dismissed) ──────────────────
// Tier notification: fire khi met_count TĂNG so với last_notified_count
// (vd 0→1 = "1/3 met", 1→2 = "upgrade to 2/3"). User chỉ unsubscribe thủ
// công qua app (dismissed_by_user=true). Cron không auto-unsubscribe.

// Cooldown giữa 2 alerts cùng watch để tránh spam khi giá dao động quanh threshold
const WATCH_ALERT_COOLDOWN_MIN = 30;

async function checkAllWatches(env) {
  const sb = sbClient(env);

  // 1. Fetch all active watches (chưa dismissed_by_user)
  const watches = await sbQuery(sb, "tplus_watches", {
    select: "id,user_id,symbol,triggers,met_count,last_notified_count,notified,notified_at",
    eq: { dismissed_by_user: false },
  });
  if (!watches || watches.length === 0) {
    console.log("[cron] no active watches");
    return;
  }

  // 2. Group by symbol, fetch unique symbol prices
  const symbols = [...new Set(watches.map((w) => w.symbol))];
  console.log(`[cron] checking ${watches.length} active watches across ${symbols.length} symbols`);

  const priceData = {};
  for (const sym of symbols) {
    try {
      const data = await fetchVndHistory(sym, 5);
      priceData[sym] = data;
    } catch (e) {
      console.warn(`[cron] VND fetch ${sym} FAILED:`, e.message || e);
    }
  }

  // 3. Collect users to send messages
  const userIdsToFetch = [...new Set(watches.map((w) => w.user_id))];
  const users = await sbQuery(sb, "user_telegram", {
    select: "user_id,chat_id",
    in: { user_id: userIdsToFetch },
  });
  const chatByUser = new Map();
  for (const u of users || []) {
    if (u.chat_id) chatByUser.set(u.user_id, u.chat_id);
  }

  // 4. Process each watch — compute met_count, fire if upgraded
  let upgraded = 0;
  const checkTs = new Date().toISOString();
  for (const w of watches) {
    const data = priceData[w.symbol];
    if (!data) continue;

    const cur = data.closes[data.closes.length - 1];
    const curVol = data.volumes[data.volumes.length - 1];
    const curOpen = data.opens[data.opens.length - 1];

    // Defensive parse triggers
    let t = w.triggers || {};
    if (typeof t === "string") {
      try { t = JSON.parse(t); } catch { t = {}; }
    }

    // Đếm 3 trigger conditions + collect "met" và "waiting" reasons cho message rõ ràng
    const met = [];
    const waiting = [];
    let metCount = 0;
    let totalTriggers = 0;
    if (t.closeAbove != null) {
      totalTriggers++;
      if (cur >= t.closeAbove) {
        met.push(`✅ Giá đóng *${cur.toFixed(2)}* vượt mức *${t.closeAbove.toFixed(2)}* (xác nhận xu hướng tăng)`);
        metCount++;
      } else {
        waiting.push(`⏳ Chờ giá đóng vượt ${t.closeAbove.toFixed(2)} (hiện ${cur.toFixed(2)})`);
      }
    }
    if (t.volAbove != null) {
      totalTriggers++;
      if (curVol >= t.volAbove) {
        met.push(`✅ Khối lượng *${(curVol / 1000).toFixed(0)}K* vượt mức *${(t.volAbove / 1000).toFixed(0)}K* (có lực mua mới)`);
        metCount++;
      } else {
        waiting.push(`⏳ Chờ KL vượt ${(t.volAbove / 1000).toFixed(0)}K (hiện ${(curVol / 1000).toFixed(0)}K)`);
      }
    }
    if (t.gapAbove != null) {
      totalTriggers++;
      if (curOpen > t.gapAbove) {
        met.push(`✅ Mở cửa *${curOpen.toFixed(2)}* gap up trên *${t.gapAbove.toFixed(2)}* (sức mạnh đầu phiên)`);
        metCount++;
      } else {
        waiting.push(`⏳ Chờ mở cửa gap up trên ${t.gapAbove.toFixed(2)} (hiện ${curOpen.toFixed(2)})`);
      }
    }

    const lastNotified = w.last_notified_count || 0;
    const isUpgrade = metCount > lastNotified;

    // Cooldown: kể cả là upgrade thật, vẫn cần đủ 30 min từ alert trước để tránh
    // spam khi giá oscillate quanh threshold (vd 1→2→1→2 trong 10 min).
    const cooldownOk = !w.notified_at ||
      (new Date(checkTs).getTime() - new Date(w.notified_at).getTime()) / 60000 >= WATCH_ALERT_COOLDOWN_MIN;
    const shouldFire = isUpgrade && cooldownOk;

    // Always update last_check_at + met_count
    const updateData = {
      met_count: metCount,
      last_check_at: checkTs,
    };

    if (shouldFire) {
      upgraded++;
      const chatId = chatByUser.get(w.user_id);

      // Tier semantic: 1/3 mới khởi đầu, 2/3 sắp đủ, 3/3 đủ điều kiện vào
      let headerLine, ctaLine;
      if (metCount === totalTriggers) {
        headerLine = `🟢 *${w.symbol}* — ĐỦ ${metCount}/${totalTriggers} tín hiệu vào lệnh`;
        ctaLine =
          `💡 *Hành động*: Cân nhắc vào lệnh theo plan\n` +
          `   • Vào ATC chiều nay HOẶC LO sáng mai\n` +
          `   • Đặt SL theo plan, KHÔNG vào không có SL\n` +
          `   • Mở app Bonggnez tab Phân tích → ${w.symbol} xem plan chi tiết`;
      } else if (metCount === totalTriggers - 1 && totalTriggers >= 2) {
        headerLine = `🟡 *${w.symbol}* — ${metCount}/${totalTriggers} tín hiệu vào (sắp đủ)`;
        ctaLine =
          `💡 *Hành động*: Theo dõi sát, chưa đủ vào chắc chắn.\n` +
          `   Đợi tín hiệu cuối cùng xác nhận trước khi vào lệnh.`;
      } else {
        headerLine = `⚠️ *${w.symbol}* — ${metCount}/${totalTriggers} tín hiệu vào (mới khởi đầu)`;
        ctaLine =
          `💡 *Hành động*: CHƯA vào lệnh — chỉ là tín hiệu đầu tiên.\n` +
          `   Cần xác nhận thêm trước khi vào.`;
      }

      const parts = [headerLine, "", ...met];
      if (waiting.length > 0) {
        parts.push("", ...waiting);
      }
      parts.push("", ctaLine);
      parts.push("─────");
      parts.push("_T+ entry trigger từ watchlist của mày — bỏ theo dõi trong app nếu không cần._");

      const text = parts.join("\n");
      if (chatId) {
        await tgSendMessage(env.BOT_TOKEN, chatId, text);
      }
      updateData.last_notified_count = metCount;
      updateData.notified = true;
      updateData.notified_at = checkTs;
      updateData.notified_reason = met.join("; ").replace(/\*/g, "");
    } else if (isUpgrade && !cooldownOk) {
      // Upgrade thật nhưng đang trong cooldown → skip silent, vẫn update count
      updateData.last_notified_count = metCount;
    } else if (metCount < lastNotified) {
      // Met count giảm (vd 2→1) — không fire downgrade noti, nhưng update count
      // để next cron có thể re-fire khi tăng lại.
      updateData.last_notified_count = metCount;
    }

    await sbUpdate(sb, "tplus_watches", {
      eq: { id: w.id },
      data: updateData,
    });
  }

  console.log(`[cron] ${upgraded}/${watches.length} watches upgraded met_count`);
}

// ── Vol Climax Bounce broadcast (bắt đáy T+3) ────────────
// Cross-validated 8.5 năm (2018-2026): Win 58.9%, Avg +1.07%/lệnh, Sharpe 0.92.
// Pattern hiếm (~38 lệnh/năm) → user dễ miss nếu không nhận notification EOD.

// Universe: Top 35 mã liquid (Cloudflare Worker free tier limit ~50 subrequests
// /invocation → 199 mã exceed limit). Top 35 covers VN30 + 5 mid-cap, đủ catch
// hầu hết signal Bắt đáy T+ trong realistic scenarios.
// App PWA scan full 199 mã (browser không có limit).
// Upgrade Workers Paid ($5/mo, 1000 subrequests) → có thể expand 199 mã.
const VOL_CLIMAX_UNIVERSE = [
  "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
  "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
  "HCM", "DXG", "VRE", "VCI", "GEL", "PDR", "HDB", "NVL", "EIB", "DBC",
  "TPB", "CEO", "KBC", "CII", "PVS",
];

// Universe cho /mid-term-quick-scan — top large+mid cap HOSE, 45 mã.
// Cloudflare Workers Free subrequest limit = 50/request → keep < 50.
// Full 1411 mã scan vẫn auto qua EOD cron (chunked, không hit limit).
const MID_TERM_QUICK_UNIVERSE = [
  "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
  "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
  "HCM", "DXG", "VRE", "VCI", "HDB", "PDR", "TPB", "CEO", "KBC", "PVS",
  "VCB", "VIC", "GMD", "BID", "GVR", "VIB", "VHC", "GAS", "PLX", "PNJ",
  "REE", "SAB", "SSB", "BCM", "VCS",
];

// ── Foreign-Backed Oversold (FBO) — TẮT 28/08/2026 ──
// Pattern: drop 3d <-5% + day green + RSI<50 + NN net buy 5d > 0.
// Hold T+5, target +3%, SL -8% (same Climax flow).
//
// Con số cũ ghi ở đây (Test 2026 n=14, Sharpe +1.42) là do chọn 2024-26 làm
// test set — đúng đoạn thị trường hồi phục. Chạy lại toàn bộ 2018-2026 với
// filter đúng như production (turnover point-in-time ≥3 tỷ):
//   n=427  Win 52.9%  avg -0.60%/lệnh  PF 0.83  cộng dồn -257%
// Âm ở CẢ BA regime (correction -0.92%, neutral -0.13%, bull -0.84%) nên gate
// không cứu được. Bỏ luôn rổ crash ret20<-10% thì 287 lệnh còn lại ra
// -0.02%/lệnh — hết chảy máu chứ không có edge.
// Forward test khớp: 1 thắng / 4 thua, -2.56%/lệnh.
//
// Momentum + Base Breakout chạy qua đúng bài test này thì vẫn dương
// (+0.95% và +1.83%/lệnh, n=1269 / n=511) — chỉ mình FBO hỏng.
//
// Bật lại = đổi cờ này, nhưng phải có backtest full-period dương trước đã.
const FBO_ENABLED = false;

// Note: Worker phải call AFTER fetching foreign flow data. Detector return
// signal flags WITHOUT NN check — caller must add nn_5d > 0 filter.
function detectForeignBackedOversoldBase(data) {
  if (!FBO_ENABLED) return null;
  const closes = data.closes;
  const opens = data.opens;
  const volumes = data.volumes;
  const n = closes?.length || 0;
  if (n < 25) return null;

  // Turnover filter (≥3 tỷ — match production Climax)
  const turnovers = [];
  for (let i = n - 21; i < n - 1; i++) turnovers.push(closes[i] * volumes[i] * 1000);
  turnovers.sort((a, b) => a - b);
  const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
  if (medianTurnover < CLIMAX_TURNOVER_MIN) return null;

  const cur = closes[n - 1];
  const curOpen = opens[n - 1];
  const prev3 = closes[n - 4];
  const ret3d = ((cur - prev3) / prev3) * 100;
  const dayGreen = cur > curOpen;
  const rsi = calcRsi(closes, 14);
  if (rsi == null) return null;

  // V1 conditions (no vol filter — différentiate from Climax)
  const matched = dayGreen && ret3d < -5 && rsi < 50;
  if (!matched) return null;

  return {
    tier: "FBO",
    ret3d, rsi,
    currentPrice: cur,
    medianTurnover,
    dayGreen,
    // NN net 5d filter applied later (after fetchForeignDaily)
  };
}

function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// Turnover filter: backtest test trên universe ≥ 3 tỷ/ngày (Large+Mid).
// Universe bot 58 mã CORE_VN30+EXTENDED đều Large+Mid, nhưng vẫn áp filter
// để bảo vệ nếu mở rộng universe sau này hoặc mã đột nhiên kẹt hàng.
const CLIMAX_TURNOVER_MIN = 3e9;

// Strength Continuation pattern — Tier Momentum Swing cho bull regime.
// Backtest 8.5y bull: Win 55%, Avg +3.5%, Sharpe 1.04, PF 2.44.
function detectStrengthContinuation(data) {
  const closes = data.closes;
  const opens = data.opens;
  const highs = data.highs;
  const lows = data.lows;
  const volumes = data.volumes;
  const n = closes?.length || 0;
  if (n < 200) return null;

  // Turnover filter
  const turnovers = [];
  for (let i = n - 21; i < n - 1; i++) {
    turnovers.push(closes[i] * volumes[i] * 1000);
  }
  turnovers.sort((a, b) => a - b);
  const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
  if (medianTurnover < CLIMAX_TURNOVER_MIN) return null;

  const cur = closes[n - 1];
  const curOpen = opens[n - 1];
  const curHigh = highs[n - 1];
  const curLow = lows[n - 1];
  const curVol = volumes[n - 1];

  // MA alignment
  const ma5 = closes.slice(n - 5).reduce((a, b) => a + b, 0) / 5;
  const ma20 = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(n - 50).reduce((a, b) => a + b, 0) / 50;
  const ma200 = closes.slice(n - 200).reduce((a, b) => a + b, 0) / 200;
  if (!(ma5 > ma20 && ma20 > ma50 && ma50 > ma200)) return null;

  const rangePct = (curHigh - curLow) / cur;
  if (rangePct >= 0.025) return null;

  const volSlice = volumes.slice(n - 21, n - 1);
  const volAvg20 = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
  const volRatio = volAvg20 > 0 ? curVol / volAvg20 : 0;
  // Vol threshold 1.5 → 1.2: audit 19/05 cho thấy 0/101 mã pass v1.5; backtest
  // 8.5y v=1.2 tăng signal 59→127/năm, giữ Win 60% + Sharpe 0.60 = free lunch.
  if (volRatio <= 1.2) return null;

  if (cur <= curOpen) return null;

  const rsi = calcRsi(closes, 14);
  if (rsi == null || rsi <= 50 || rsi >= 70) return null;

  return {
    pattern: "strength_continuation",
    currentPrice: cur,
    ma20, ma50,
    volRatio, rsi, rangePct,
    medianTurnover,
    momentumStrength: volRatio * (rsi - 50),
  };
}

function detectVolClimaxBounce(data) {
  const closes = data.closes;
  const opens = data.opens;
  const highs = data.highs;
  const lows = data.lows;
  const volumes = data.volumes;
  const n = closes?.length || 0;
  if (n < 25) return null;

  // Turnover filter median 20 phiên >= 3 tỷ/ngày
  const turnovers = [];
  for (let i = n - 21; i < n - 1; i++) {
    turnovers.push(closes[i] * volumes[i] * 1000);
  }
  turnovers.sort((a, b) => a - b);
  const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
  if (medianTurnover < CLIMAX_TURNOVER_MIN) return null;

  const cur = closes[n - 1];
  const curOpen = opens[n - 1];
  const curVol = volumes[n - 1];
  const prev3 = closes[n - 4];

  const ret3d = ((cur - prev3) / prev3) * 100;
  const volSlice = volumes.slice(n - 21, n - 1);
  const volAvg20 = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
  const volRatio = volAvg20 > 0 ? curVol / volAvg20 : 0;
  const dayGreen = cur > curOpen;
  const rsi = calcRsi(closes, 14);

  if (rsi == null) return null;

  // ATR(14) for adaptive drop threshold (Phase A: stock-specific volatility)
  // Backtest 8.5y (run_atr_adaptive_threshold.py): Tier A K=3.0 Sharpe 0.67 → 1.09,
  // in-sample turnaround from -0.41 to +1.38. Volatile stocks need bigger drop.
  let atrPct = null;
  if (highs && lows && n >= 15) {
    let trSum = 0;
    for (let i = n - 14; i < n; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trSum += tr;
    }
    const atr14 = trSum / 14;
    atrPct = atr14 / cur * 100;
  }

  // Adaptive Tier A: drop < -K × ATR_pct with K=3.0
  // Fallback fixed -7% if ATR unavailable
  const dropThreshA = atrPct ? -3.0 * atrPct : -7;
  const dropThreshB = -5;  // Tier B keep fixed (ATR variants không cải thiện)

  // REVERTED 2026-05-25: no-green V1 deploy hôm qua dựa trên fixed-hold backtest
  // (assume hold đủ T+5) → Sharpe 1.58. Nhưng dynamic-exit backtest realistic
  // (TP+3%/SL-8% behavior thực tế) cho thấy KHÔNG có edge:
  //   - 18 variants TP×SL×Hold tested (run_climax_rr_grid.py)
  //   - Best Test: TP7%/SL8%/T+5 → Sharpe +0.06 avg +0.06% (break-even)
  //   - SL hit nhiều hơn TP hit ở regime 2025-26 → lỗ realistic
  // Conclusion: pattern Climax với realistic exit không có edge ở regime hiện
  // tại. User chọn "ít signal nhưng high quality" → giữ dayGreen.
  const base = dayGreen && volRatio > 2.0;
  const matchedA = base && ret3d < dropThreshA && rsi < 35;
  const matchedB = base && ret3d < dropThreshB && rsi < 50;
  const tier = matchedA ? "A" : matchedB ? "B" : null;
  if (!tier) return null;

  return {
    tier,
    ret3d, volRatio, rsi, atrPct,
    dropThreshold: tier === "A" ? dropThreshA : dropThreshB,
    currentPrice: cur,
    medianTurnover,
    bounceStrength: volRatio * Math.abs(ret3d),
  };
}

// ── Base Breakout (Mid-term) ──────────────────────────────
// Pattern verified Phase 1 backtest (run_midterm_phase1.py):
//   Test 2025-26 Sharpe +1.13, PF 2.82, avg ret +6.95%/trade, Win 51.9%
//   Best variant: max_hold=30, trail=10%, init_sl=10%
// Mid-term hold ~1 tháng (avg actual 23 days) — không phải T+ swing.
//
// Logic (mirror backtest):
//   1. Universe gate: close > MA200 + median turnover 60d ≥ 5 tỷ
//   2. Base condition: 30-phiên range high/low < 10% (consolidation tight)
//   3. Trigger: today close > max(high prev 30 days) — breakout above base
//   4. Vol confirm: vol_ratio (today / avg20) > 1.5
const BASE_BREAKOUT_TURNOVER_MIN = 5e9;      // 5 tỷ/ngày median 60d
const BASE_BREAKOUT_TRAIL_PCT = 10;
const BASE_BREAKOUT_INIT_SL_PCT = 10;
const BASE_BREAKOUT_MAX_HOLD_TRADING = 30;

function detectBaseBreakout(data) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;
  const volumes = data.volumes;
  const n = closes?.length || 0;
  if (n < 200) return null;

  const cur = closes[n - 1];
  const curVol = volumes[n - 1];

  // 1. MA200 gate (close > MA200)
  let ma200Sum = 0;
  for (let i = n - 200; i < n; i++) ma200Sum += closes[i];
  const ma200 = ma200Sum / 200;
  if (cur <= ma200) return null;

  // 2. Liquidity gate (median turnover 60d ≥ 5 tỷ)
  const turnovers = [];
  const turnStart = Math.max(0, n - 61);
  for (let i = turnStart; i < n - 1; i++) {
    turnovers.push(closes[i] * volumes[i] * 1000);
  }
  turnovers.sort((a, b) => a - b);
  const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
  if (!medianTurnover || medianTurnover < BASE_BREAKOUT_TURNOVER_MIN) return null;

  // 3. Base range (30 phiên trước, không tính hôm nay) < 10%
  let highMax = -Infinity;
  let lowMin = Infinity;
  for (let i = n - 31; i < n - 1; i++) {
    if (highs[i] > highMax) highMax = highs[i];
    if (lows[i] < lowMin) lowMin = lows[i];
  }
  if (lowMin <= 0) return null;
  const baseRange = (highMax - lowMin) / lowMin;
  if (baseRange >= 0.10) return null;

  // 4. Today break above prev high
  if (cur <= highMax) return null;

  // 5. Vol confirm > 1.5× TB20
  let volSum = 0;
  for (let i = n - 21; i < n - 1; i++) volSum += volumes[i];
  const volAvg20 = volSum / 20;
  const volRatio = volAvg20 > 0 ? curVol / volAvg20 : 0;
  if (volRatio < 1.5) return null;

  return {
    pattern: "base_breakout",
    currentPrice: cur,
    initSL: +(cur * (1 - BASE_BREAKOUT_INIT_SL_PCT / 100)).toFixed(4),
    trailPct: BASE_BREAKOUT_TRAIL_PCT,
    maxHoldDays: BASE_BREAKOUT_MAX_HOLD_TRADING,
    ma200,
    volRatio,
    medianTurnover,
    baseRangePct: baseRange * 100,
    breakStrength: ((cur - highMax) / highMax) * 100,
  };
}

// Compute per-stock daily stats (1 pass với climax detection để tiết kiệm API calls)
function computeStockStats(data) {
  const closes = data.closes;
  const volumes = data.volumes;
  const n = closes?.length || 0;
  if (n < 2) return null;
  const cur = closes[n - 1];
  const prev = closes[n - 2];
  const vol = volumes[n - 1];
  const changePct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
  const turnover = cur * vol * 1000; // VND
  return { cur, prev, vol, changePct, turnover };
}

async function scanAllSymbols() {
  // 1 pass: fetch + compute climax + market stats + VN-Index regime
  const allStocks = [];
  const batchSize = 10;
  for (let i = 0; i < VOL_CLIMAX_UNIVERSE.length; i += batchSize) {
    const batch = VOL_CLIMAX_UNIVERSE.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sym) => {
      try {
        // Need 365 ngày lịch (~250 nến) cho strength continuation (MA200)
        const data = await fetchVndHistory(sym, 365);
        const climax = detectVolClimaxBounce(data);
        const momentum = detectStrengthContinuation(data);
        const stats = computeStockStats(data);
        return { symbol: sym, climax, momentum, stats };
      } catch (e) {
        console.warn(`[scan] ${sym} fetch fail:`, e.message);
        return null;
      }
    }));
    allStocks.push(...results.filter((r) => r && r.stats));
  }

  // VN-Index regime detection (ret20 < -5% = correction = Tier Elite active)
  let vniRegime = "neutral";
  let vniRet20 = null;
  try {
    const vni = await fetchVndHistory("VNINDEX", 35);
    const cs = vni.closes;
    if (cs.length >= 21) {
      vniRet20 = ((cs[cs.length - 1] - cs[cs.length - 21]) / cs[cs.length - 21]) * 100;
      if (vniRet20 < -5) vniRegime = "correction";
      else if (vniRet20 > 3) vniRegime = "bull";
    }
  } catch (e) {
    console.warn("[scan] VN-Index fetch fail:", e.message);
  }

  // Climax matches (flag elite if VNI in correction)
  const isEliteRegime = vniRegime === "correction";
  const isMomentumRegime = vniRegime === "bull" || vniRegime === "neutral";
  const matches = allStocks
    .filter((s) => s.climax)
    .map((s) => ({
      symbol: s.symbol,
      ...s.climax,
      isElite: isEliteRegime,
    }))
    .sort((a, b) => b.bounceStrength - a.bounceStrength);

  // Momentum Swing matches (Tier Momentum cho bull/neutral regime)
  const momentumMatches = isMomentumRegime
    ? allStocks
        .filter((s) => s.momentum)
        .map((s) => ({
          symbol: s.symbol,
          ...s.momentum,
        }))
        .sort((a, b) => b.momentumStrength - a.momentumStrength)
    : [];

  // Market stats: sort by change %
  const withStats = allStocks.filter((s) => s.stats);
  const sortedByChange = [...withStats].sort((a, b) => b.stats.changePct - a.stats.changePct);
  const gainers = sortedByChange.slice(0, 5);
  const losers = sortedByChange.slice(-5).reverse();
  const topVol = [...withStats].sort((a, b) => b.stats.turnover - a.stats.turnover).slice(0, 5);

  // VN market overall: avg change + breadth
  const avgChange = withStats.reduce((sum, s) => sum + s.stats.changePct, 0) / withStats.length;
  const upCount = withStats.filter((s) => s.stats.changePct > 0).length;
  const downCount = withStats.filter((s) => s.stats.changePct < 0).length;
  const totalTurnover = withStats.reduce((sum, s) => sum + s.stats.turnover, 0);

  return {
    matches,
    momentumMatches,
    market: { avgChange, upCount, downCount, totalTurnover, totalScanned: withStats.length },
    gainers,
    losers,
    topVol,
    vniRegime,
    vniRet20,
    isEliteRegime,
    isMomentumRegime,
  };
}

// Backwards-compat wrapper (cũ dùng)
async function scanVolClimaxMatches() {
  const result = await scanAllSymbols();
  return result.matches;
}

// ── Multi-stage EOD scan: FULL_UNIVERSE (1411 mã) chunked qua nhiều cron ticks ──
// Free tier 50 subreq/invocation → chunk 35 mã. 1411/35 = ~41 chunks × 1 min = ~41 min.
// Schedule: EOD 14:50 init → process chunks 15:00-15:59 → finalize sau chunk cuối.

// Cloudflare Workers Free subrequest limit = 50/request.
// Budget per /scan-full-step: history (25) + foreign cap (10) + state/heartbeat (~5) = ~40.
const CHUNK_SIZE = 25;

// Mọi cột *_partial phải reset ở MỌI chỗ init. Thêm detector mới mà quên reset
// thì match phiên cũ sống sang phiên sau và bị persist lại với signal_date mới
// (pick tự gia hạn vô hạn — bug PNJ 08/2026, fbo_partial thiếu ở initScan).
function emptyScanPartials() {
  return {
    climax_partial: "[]",
    momentum_partial: "[]",
    base_breakout_partial: "[]",
    fbo_partial: "[]",
  };
}

async function getScanState(env) {
  const sb = sbClient(env);
  const rows = await sbQuery(sb, "scan_state", { select: "*", eq: { id: "main" } });
  return rows?.[0] || null;
}

async function setScanState(env, data) {
  const sb = sbClient(env);
  return sbUpdate(sb, "scan_state", { eq: { id: "main" }, data });
}

async function initScan(env, opts = {}) {
  const { processFirstChunk = true } = opts;
  // Fetch VNI regime trước để store
  let vniRegime = "neutral";
  let vniRet20 = null;
  try {
    const vni = await fetchVndHistory("VNINDEX", 35);
    const cs = vni.closes;
    if (cs.length >= 21) {
      vniRet20 = ((cs[cs.length - 1] - cs[cs.length - 21]) / cs[cs.length - 21]) * 100;
      if (vniRet20 < -5) vniRegime = "correction";
      else if (vniRet20 > 3) vniRegime = "bull";
    }
  } catch (e) {
    console.warn("[init-scan] VNI fetch fail:", e.message);
  }

  await setScanState(env, {
    status: "in_progress",
    scan_date: new Date().toISOString().slice(0, 10),
    current_offset: 0,
    total_universe: FULL_UNIVERSE.length,
    ...emptyScanPartials(),
    market_stats: JSON.stringify({ upCount: 0, downCount: 0, totalTurnover: 0, totalChange: 0, totalScanned: 0 }),
    vni_regime: vniRegime,
    vni_ret20: vniRet20,
    started_at: new Date().toISOString(),
    completed_at: null,
    error_count: 0,
  });
  console.log(`[init-scan] started, ${FULL_UNIVERSE.length} mã, VNI regime=${vniRegime} (ret20=${vniRet20?.toFixed?.(1)}%)`);

  // Immediately process first chunk to make progress (free tier 30s budget)
  if (processFirstChunk) await processScanChunk(env);
}

async function processScanChunk(env) {
  const state = await getScanState(env);
  if (!state || state.status !== "in_progress") {
    await logHeartbeat(env, "chunk-skip", { reason: "no-active-scan", status: state?.status });
    return;  // No active scan
  }
  const offset = state.current_offset || 0;
  const total = state.total_universe || FULL_UNIVERSE.length;
  if (offset >= total) {
    await logHeartbeat(env, "chunk-finalize", { offset, total });
    await finalizeScan(env, state);
    return;
  }

  const chunk = FULL_UNIVERSE.slice(offset, offset + CHUNK_SIZE);
  console.log(`[chunk] processing ${offset}-${offset + chunk.length}/${total}`);
  const chunkStartMs = Date.now();

  let fetchFails = 0;
  // Phase 1: fetch history + run detectors WITHOUT foreign (bounded subrequests).
  // FBO requires foreign filter — defer to phase 2 (chỉ fetch foreign cho top
  // candidates) để tránh exceed Cloudflare 50 subrequest/request limit.
  const phase1 = await Promise.all(chunk.map(async (sym) => {
    try {
      const data = await fetchVndHistory(sym, 365);
      const climax = detectVolClimaxBounce(data);
      const momentum = detectStrengthContinuation(data);
      const baseBreakout = detectBaseBreakout(data);
      const fboBase = detectForeignBackedOversoldBase(data);
      const stats = computeStockStats(data);
      const presignal = collectPreSignalCandidate(data);
      return { symbol: sym, climax, momentum, baseBreakout, fboBase, stats, presignal };
    } catch (e) {
      fetchFails++;
      return null;
    }
  }));

  // Phase 2: fetch foreign only for candidates needing it (climax + fboBase).
  // Cap total foreign fetches để stay within 50 subrequest budget.
  // CHUNK_SIZE = 35 history fetches → còn ~13 budget for foreign.
  const candidates = phase1.filter((r) => r && (r.climax || r.fboBase));
  const MAX_FOREIGN_PER_CHUNK = 10;
  const toFetchForeign = candidates.slice(0, MAX_FOREIGN_PER_CHUNK);
  const foreignResults = await Promise.all(toFetchForeign.map(async (r) => {
    const foreign = await fetchForeignDaily(r.symbol, 7).catch(() => null);
    return { symbol: r.symbol, foreign };
  }));
  const foreignBySymbol = new Map(foreignResults.map((x) => [x.symbol, x.foreign]));

  // Merge: attach foreign to results + apply FBO filter
  const results = phase1.map((r) => {
    if (!r) return null;
    const foreign = foreignBySymbol.get(r.symbol) || null;
    let fbo = null;
    if (r.fboBase && foreign) {
      const nnNet5d = computeNnNet5d(foreign);
      if (nnNet5d != null && nnNet5d > 0) {
        fbo = { ...r.fboBase, nn_net_5d_bn: +(nnNet5d / 1e9).toFixed(2) };
      }
    }
    return { ...r, fbo, foreign };
  });
  const chunkMs = Date.now() - chunkStartMs;
  await logHeartbeat(env, "chunk-processed", {
    offset, total, chunk_size: chunk.length,
    duration_ms: chunkMs,
    fetch_fails: fetchFails,
  });

  // Merge into partial state (safe parse — column có thể empty string sau migration)
  const safeParse = (s, fallback) => {
    if (!s || s === "" || s === "null") return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  const climaxPartial = safeParse(state.climax_partial, []);
  const momentumPartial = safeParse(state.momentum_partial, []);
  const baseBreakoutPartial = safeParse(state.base_breakout_partial, []);
  const fboPartial = safeParse(state.fbo_partial, []);
  const marketStats = safeParse(state.market_stats, {});
  let upCount = marketStats.upCount || 0;
  let downCount = marketStats.downCount || 0;
  let totalTurnover = marketStats.totalTurnover || 0;
  let totalChange = marketStats.totalChange || 0;
  let totalScanned = marketStats.totalScanned || 0;

  for (const r of results) {
    if (!r) continue;
    if (r.stats) {
      totalScanned++;
      totalChange += r.stats.changePct;
      totalTurnover += r.stats.turnover;
      if (r.stats.changePct > 0) upCount++;
      else if (r.stats.changePct < 0) downCount++;
    }
    if (r.climax) {
      // Enrich với NN net 5d nếu có foreign data
      const nnNet5d = computeNnNet5d(r.foreign);
      const isPremium = nnNet5d != null && nnNet5d > 0;
      climaxPartial.push({
        symbol: r.symbol, ...r.climax,
        nn_net_5d_bn: nnNet5d != null ? +(nnNet5d / 1e9).toFixed(2) : null,
        is_premium: isPremium,
      });
    }
    if (r.momentum) momentumPartial.push({ symbol: r.symbol, ...r.momentum });
    if (r.baseBreakout) baseBreakoutPartial.push({ symbol: r.symbol, ...r.baseBreakout });
    if (r.fbo) fboPartial.push({ symbol: r.symbol, ...r.fbo });
  }

  // Ứng viên cảnh báo sớm cho phiên sau. Ghi thẳng bảng riêng thay vì nhét vào
  // scan_state — sql/012 chưa chạy thì chỉ mất cảnh báo sớm, chunk scan vẫn sống.
  // Mã đã match climax hôm nay thì bỏ: mai nó là active pick rồi.
  const presignalRows = results
    .filter((r) => r?.presignal && !r.climax)
    .map((r) => ({ symbol: r.symbol, ...r.presignal }));
  await persistPreSignalCandidates(env, presignalRows, state.scan_date || vnDateString());

  const newOffset = offset + chunk.length;
  await setScanState(env, {
    current_offset: newOffset,
    climax_partial: JSON.stringify(climaxPartial),
    momentum_partial: JSON.stringify(momentumPartial),
    base_breakout_partial: JSON.stringify(baseBreakoutPartial),
    fbo_partial: JSON.stringify(fboPartial),
    market_stats: JSON.stringify({ upCount, downCount, totalTurnover, totalChange, totalScanned }),
    last_chunk_at: new Date().toISOString(),
  });

  console.log(`[chunk] done ${offset}→${newOffset} · climax+${results.filter(r => r?.climax).length} momentum+${results.filter(r => r?.momentum).length} base_breakout+${results.filter(r => r?.baseBreakout).length} fbo+${results.filter(r => r?.fbo).length}`);

  if (newOffset >= total) {
    const finalState = {
      ...state,
      current_offset: newOffset,
      climax_partial: JSON.stringify(climaxPartial),
      momentum_partial: JSON.stringify(momentumPartial),
      base_breakout_partial: JSON.stringify(baseBreakoutPartial),
      fbo_partial: JSON.stringify(fboPartial),
      market_stats: JSON.stringify({ upCount, downCount, totalTurnover, totalChange, totalScanned }),
    };
    await finalizeScan(env, finalState);
  }
}

async function finalizeScan(env, state) {
  console.log(`[finalize] scan complete, building digest`);

  const safeParse = (s, fallback) => {
    if (!s || s === "" || s === "null") return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  // Partial chỉ hợp lệ trong đúng ngày scan. State sót từ phiên trước mà lọt tới
  // đây thì persist sẽ stamp signal_date = hôm nay cho match cũ → signal ma.
  const stale = state.scan_date && state.scan_date !== new Date().toISOString().slice(0, 10);
  if (stale) {
    console.warn(`[finalize] state cũ (scan_date=${state.scan_date}) — bỏ toàn bộ partial, không persist`);
  }
  const climaxRaw = stale ? [] : safeParse(state.climax_partial, []);
  const momentumRaw = stale ? [] : safeParse(state.momentum_partial, []);
  const baseBreakoutRaw = stale ? [] : safeParse(state.base_breakout_partial, []);
  const fboRaw = stale ? [] : safeParse(state.fbo_partial, []);
  const marketStats = safeParse(state.market_stats, {});
  const isEliteRegime = state.vni_regime === "correction";
  const isMomentumRegime = state.vni_regime === "bull" || state.vni_regime === "neutral";

  const matches = climaxRaw
    .map((m) => ({ ...m, isElite: isEliteRegime }))
    .sort((a, b) => (b.bounceStrength || 0) - (a.bounceStrength || 0));
  const momentumMatches = isMomentumRegime
    ? momentumRaw.sort((a, b) => (b.momentumStrength || 0) - (a.momentumStrength || 0))
    : [];

  // Sort base breakout by breakStrength (how far above prev high)
  const baseBreakoutMatches = baseBreakoutRaw.sort(
    (a, b) => (b.breakStrength || 0) - (a.breakStrength || 0)
  );
  // Sort FBO by drop magnitude (more oversold first)
  const fboMatches = fboRaw.sort((a, b) => (a.ret3d || 0) - (b.ret3d || 0));

  // CRITICAL: set status=completed FIRST, before downstream tasks. If digest
  // or persist throws (subrequest limit, network error), state vẫn flip
  // completed → PWA loop kết thúc, không stuck.
  await setScanState(env, {
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  console.log(`[finalize] status set to completed early`);

  const avgChange = marketStats.totalScanned > 0 ? marketStats.totalChange / marketStats.totalScanned : 0;

  // Chụp context thị trường TRƯỚC khi persist — trade_log cần nó để sau này
  // group-by regime / màu VNI mà không phải replay lại detector.
  const ctxResult = {
    vniRegime: state.vni_regime,
    vniRet20: state.vni_ret20,
    market: { upCount: marketStats.upCount || 0, downCount: marketStats.downCount || 0 },
  };
  let signalCtx = buildSignalContext(ctxResult, null, null);
  try {
    const vni = await fetchVndHistory("VNINDEX", 100);
    const n = vni.closes.length;
    const vniInfo = n >= 2 ? { change: ((vni.closes[n - 1] - vni.closes[n - 2]) / vni.closes[n - 2]) * 100 } : null;
    const health = computeMarketHealth(vni.closes, marketStats.upCount || 0, marketStats.downCount || 0);
    signalCtx = buildSignalContext(ctxResult, vniInfo, health);
  } catch (e) {
    console.warn("[finalize] signal context VNI fetch fail:", e.message);
  }

  // Now run persist + digest with error tolerance
  try {
    await persistClimaxMatches(env, matches, signalCtx);
  } catch (e) { console.warn("[finalize] persistClimax fail:", e.message); }
  try {
    await persistMomentumMatches(env, momentumMatches, signalCtx);
  } catch (e) { console.warn("[finalize] persistMomentum fail:", e.message); }
  try {
    await persistMidTermMatches(env, baseBreakoutMatches);
  } catch (e) { console.warn("[finalize] persistMidTerm fail:", e.message); }
  try {
    await persistFBOMatches(env, fboMatches, signalCtx);
  } catch (e) { console.warn("[finalize] persistFBO fail:", e.message); }
  // Ứng viên cảnh báo sớm chỉ sống 1 phiên — dọn row cũ để bảng khỏi phình.
  try {
    await sbDelete(sbClient(env), "presignal_watch", { lt: { watch_date: vnDateString() } });
  } catch (e) { console.warn("[finalize] cleanup presignal fail:", e.message); }

  // Send full-coverage digest
  const fullDigestResult = {
    matches,
    momentumMatches,
    baseBreakoutMatches,
    fboMatches,
    market: {
      avgChange,
      upCount: marketStats.upCount || 0,
      downCount: marketStats.downCount || 0,
      totalTurnover: marketStats.totalTurnover || 0,
      totalScanned: marketStats.totalScanned || 0,
    },
    gainers: [],
    losers: [],
    topVol: [],
    vniRegime: state.vni_regime,
    vniRet20: state.vni_ret20,
    isEliteRegime,
    isMomentumRegime,
    fullCoverage: true,
  };
  try {
    await sendMarketDigest(env, fullDigestResult);
  } catch (e) {
    console.warn("[finalize] sendDigest fail:", e.message);
  }
  // Tách khỏi digest: digest kể bối cảnh, tin này chỉ có việc phải làm phiên tới.
  try {
    await sendEntryPlan(env);
  } catch (e) {
    console.warn("[finalize] sendEntryPlan fail:", e.message);
  }
  console.log(`[finalize] done — ${matches.length} climax, ${momentumMatches.length} momentum, ${baseBreakoutMatches.length} base_breakout, ${fboMatches.length} fbo`);
}

// ── Spike-alert state: persist climax matches to climax_active_picks ──

const SPIKE_THRESHOLD_PCT = 3.0;    // alert khi intraday return ≥ +3% từ open
const SPIKE_COOLDOWN_MIN = 10;      // tối thiểu 10 min giữa 2 alerts cùng mã

// Pick row phải sống qua phiên resolver chốt sổ (signal + maxHold + 1 phiên):
// exit alert ghi dấu đã báo vào row này, hết hạn sớm là mất alert timeout. Hạn
// 15:00 VN của phiên đó để finalize tối hôm ấy dọn luôn.
function positionExpiresAt(signalDate, maxHold) {
  return `${addVnTradingDays(signalDate, maxHold + 1)}T08:00:00.000Z`;
}

// Momentum picks hold ~20-30 phiên với trailing stop. Khác Climax (T+3-5).
// Dùng cùng table climax_active_picks với tier='Momentum' để portfolio coach
// detect đúng kế hoạch (target = entry × 1.035, init SL = entry × 0.92).
const MOMENTUM_AVG_RETURN_PCT = 3.5;  // backtest avg
// Exit params dùng cho trade_log — khớp với con số digest nói với user (T+20, trail 7%)
const MOMENTUM_MAX_HOLD_TRADING = 20;
const MOMENTUM_TRAIL_PCT = 7;
const MOMENTUM_INIT_SL_PCT = 8;

async function persistMomentumMatches(env, matches, ctx = null) {
  if (!matches || matches.length === 0) return;
  const sb = sbClient(env);
  const today = lastVnTradingDay();
  const expiresAt = positionExpiresAt(today, MOMENTUM_MAX_HOLD_TRADING);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: today,
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * (1 + MOMENTUM_AVG_RETURN_PCT / 100)).toFixed(4),
    tier: "Momentum",
    expires_at: expiresAt,
    above_threshold: false,
    last_alert_at: null,
  }));
  const ok = await sbUpsert(sb, "climax_active_picks", rows, "symbol");
  console.log(`[persist] ${ok ? "✓" : "✗"} ${rows.length} Momentum saved (expires ${expiresAt.slice(0, 10)})`);

  // climax_active_picks bị xoá khi expire → trade_log là nơi duy nhất giữ lịch sử
  await logMomentumInitialTrades(env, matches, today, ctx);
}

// ── FBO (Foreign-Backed Oversold) persist ──────────────────────
// Reuse climax_active_picks schema. Hold T+5, target +3%, SL -8% (Climax-like).
// V1 backtest: Test 2026 Sharpe +1.42, Win 71%, PF 1.61 (n=14 small sample).
async function persistFBOMatches(env, matches, ctx = null) {
  if (!matches || matches.length === 0) {
    console.log("[fbo persist] no matches");
    return;
  }
  const sb = sbClient(env);
  const today = lastVnTradingDay();
  const expiresAt = positionExpiresAt(today, CLASSICAL_EXIT.maxHold);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: today,
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * 1.03).toFixed(4),
    tier: "FBO",
    nn_net_5d_bn: m.nn_net_5d_bn ?? null,
    is_premium: false,
    expires_at: expiresAt,
    above_threshold: false,
    last_alert_at: null,
  }));
  const ok = await sbUpsert(sb, "climax_active_picks", rows, "symbol");
  console.log(`[fbo persist] ${ok ? "✓" : "✗"} ${rows.length} FBO saved`);

  // ALSO log to trade_log for forward-test tracker (resolve sau T+5)
  // tier='FBO', pattern_type='fbo_oversold' — phân biệt với Climax classic
  const logRows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: today,
    tier: "FBO",
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * 1.03).toFixed(4),
    sl_price: +(m.currentPrice * 0.92).toFixed(4),
    nn_net_5d_bn: m.nn_net_5d_bn ?? null,
    is_premium: false,
    pattern_type: "fbo_oversold",
    max_hold_days: 5,
    ...signalFeatures(m),
    ...(ctx || {}),
  }));
  const okLog = await upsertTradeLog(sb, logRows, "fbo");
  console.log(`[trade-log fbo] ${okLog ? "✓" : "✗"} ${logRows.length} FBO logged`);
}

// ── Mid-term (Base Breakout) persist ──────────────────────────
// Bảng riêng mid_term_active_picks (sql/007). Khác Climax (hold T+5) — mid-term
// hold T+30 trading, trail 10%, init SL -10%.
// Backtest Phase 1: Test 2025-26 Sharpe +1.13, PF 2.82, avg +6.95%.
async function persistMidTermMatches(env, matches) {
  const sb = sbClient(env);
  // Cleanup expired
  const nowIso = new Date().toISOString();
  await sbDelete(sb, "mid_term_active_picks", { lt: { expires_at: nowIso } });

  if (!matches || matches.length === 0) {
    console.log("[mid-term persist] no matches");
    return;
  }

  const today = lastVnTradingDay();
  const expiresAt = positionExpiresAt(today, BASE_BREAKOUT_MAX_HOLD_TRADING);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: today,
    entry_price: m.currentPrice,
    pattern_type: m.pattern || "base_breakout",
    init_sl_price: m.initSL,
    trail_pct: m.trailPct,
    max_hold_days: m.maxHoldDays,
    expires_at: expiresAt,
    ma200_at_signal: m.ma200,
    vol_ratio_at_signal: m.volRatio,
    base_range_pct: m.baseRangePct,
    above_threshold: false,
    last_alert_at: null,
  }));
  const ok = await sbUpsert(sb, "mid_term_active_picks", rows, "symbol");
  console.log(`[mid-term persist] ${ok ? "✓" : "✗"} ${rows.length} Base Breakout saved (expires ${expiresAt.slice(0, 10)})`);

  // ALSO log to trade_log for forward-test tracker (resolve sau T+30 trading)
  await logMidTermInitialTrades(env, matches, today);
}

async function persistClimaxMatches(env, matches, ctx = null) {
  const sb = sbClient(env);
  // 1. Cleanup picks đã expire
  const nowIso = new Date().toISOString();
  await sbDelete(sb, "climax_active_picks", { lt: { expires_at: nowIso } });

  if (!matches || matches.length === 0) {
    console.log("[persist] no climax matches to persist");
    return;
  }

  const today = lastVnTradingDay();
  const expiresAt = positionExpiresAt(today, CLASSICAL_EXIT.maxHold);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: today,
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * (1 + SPIKE_THRESHOLD_PCT / 100)).toFixed(4),
    // Tier hierarchy: Premium (climax + NN net buy 5d > 0, backtest Sharpe 1.90)
    // > Elite (climax + VNI correction) > A (climax strict) > B (climax relax)
    tier: m.is_premium ? "Premium" : m.isElite ? "Elite" : m.tier,
    nn_net_5d_bn: m.nn_net_5d_bn ?? null,
    is_premium: !!m.is_premium,
    expires_at: expiresAt,
    above_threshold: false,
    last_alert_at: null,
  }));
  const ok = await sbUpsert(sb, "climax_active_picks", rows, "symbol");
  const premiumCount = rows.filter((r) => r.tier === "Premium").length;
  const eliteCount = rows.filter((r) => r.tier === "Elite").length;
  console.log(`[persist] ${ok ? "✓" : "✗"} ${rows.length} matches saved (${premiumCount} Premium, ${eliteCount} Elite, expires ${expiresAt.slice(0, 10)})`);

  // ALSO log to trade_log for forward-test tracker (unresolved, resolveCron sẽ fill)
  await logInitialTrades(env, matches, today, ctx);
}

// Cột do sql/011 thêm. Nếu migration chưa chạy, PostgREST từ chối cả batch →
// mất luôn log. Upsert lại không kèm context còn hơn không có row nào.
const TRADE_LOG_CONTEXT_COLS = [
  "vni_regime", "vni_ret20", "vni_change_pct", "market_health",
  "breadth_up", "breadth_down", "ret3d", "vol_ratio", "rsi",
];

// Cùng một mã signal lại khi lệnh cũ chưa chốt vẫn là MỘT vị thế. Conflict key
// là (symbol, signal_date) nên ngày mới đẻ row mới → /stats đếm đôi một lệnh.
// Chặn ở đây vì mọi detector đều đi qua upsertTradeLog.
async function dropSymbolsAlreadyOpen(sb, rows, label) {
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=symbol,signal_date&resolved_at=is.null&symbol=in.(${symbols.join(",")})`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  // Fail-open: query hỏng thì thà ghi trùng còn hơn mất signal.
  if (!r.ok) return rows;
  const openBySymbol = new Map((await r.json()).map((o) => [o.symbol, o.signal_date]));
  const kept = rows.filter((row) => {
    const prev = openBySymbol.get(row.symbol);
    // Trùng signal_date = scan chạy lại trong ngày, vẫn để upsert ghi đè.
    return prev == null || prev === row.signal_date;
  });
  const skipped = rows.length - kept.length;
  if (skipped > 0) {
    const names = rows.filter((x) => !kept.includes(x)).map((x) => x.symbol).join(",");
    console.log(`[trade-log ${label}] bỏ ${skipped} mã đang có lệnh mở: ${names}`);
  }
  return kept;
}

async function upsertTradeLog(sb, rows, label) {
  rows = await dropSymbolsAlreadyOpen(sb, rows, label);
  if (rows.length === 0) return true;
  if (await sbUpsert(sb, "trade_log", rows, "symbol,signal_date")) return true;
  const stripped = rows.map((r) => {
    const copy = { ...r };
    for (const c of TRADE_LOG_CONTEXT_COLS) delete copy[c];
    return copy;
  });
  const ok = await sbUpsert(sb, "trade_log", stripped, "symbol,signal_date");
  console.warn(`[trade-log ${label}] retry không kèm context: ${ok ? "✓" : "✗"} (chạy sql/011 chưa?)`);
  return ok;
}

// Context thị trường lúc signal — không tái tạo được sau này (giá VND là giá đã
// điều chỉnh, data NN không có lịch sử), nên phải chụp lại ngay lúc vào lệnh.
function buildSignalContext(result, vniInfo, health) {
  return {
    vni_regime: result?.vniRegime ?? null,
    vni_ret20: result?.vniRet20 ?? null,
    vni_change_pct: vniInfo ? +vniInfo.change.toFixed(2) : null,
    market_health: health?.level ?? null,
    breadth_up: result?.market?.upCount ?? null,
    breadth_down: result?.market?.downCount ?? null,
  };
}

// Đặc trưng signal per-mã — để sau này soi ngưỡng detector nào thực sự có edge
function signalFeatures(m) {
  return {
    ret3d: m.ret3d ?? null,
    vol_ratio: m.volRatio ?? null,
    rsi: m.rsi ?? null,
  };
}

async function logInitialTrades(env, matches, signalDate, ctx = null) {
  if (!matches || matches.length === 0) return;
  const sb = sbClient(env);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: signalDate,
    tier: m.is_premium ? "Premium" : m.isElite ? "Elite" : m.tier,
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * 1.03).toFixed(4),
    sl_price: +(m.currentPrice * 0.92).toFixed(4),
    nn_net_5d_bn: m.nn_net_5d_bn ?? null,
    is_premium: !!m.is_premium,
    pattern_type: "vol_climax",
    max_hold_days: 5,
    ...signalFeatures(m),
    ...(ctx || {}),
  }));
  const ok = await upsertTradeLog(sb, rows, "climax");
  console.log(`[trade-log climax] ${ok ? "✓" : "✗"} ${rows.length} logged`);
}

// Momentum: trail stop + hold T+20, không phải target/SL fix như Climax →
// resolve bằng resolveTrailingPicks (chung với MidTerm), không phải T+5 resolver.
async function logMomentumInitialTrades(env, matches, signalDate, ctx = null) {
  if (!matches || matches.length === 0) return;
  const sb = sbClient(env);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: signalDate,
    tier: "Momentum",
    entry_price: m.currentPrice,
    target_price: +(m.currentPrice * (1 + MOMENTUM_AVG_RETURN_PCT / 100)).toFixed(4),
    sl_price: +(m.currentPrice * (1 - MOMENTUM_INIT_SL_PCT / 100)).toFixed(4),
    pattern_type: "momentum_swing",
    max_hold_days: MOMENTUM_MAX_HOLD_TRADING,
    trail_pct: MOMENTUM_TRAIL_PCT,
    init_sl_pct: MOMENTUM_INIT_SL_PCT,
    ...signalFeatures(m),
    ...(ctx || {}),
  }));
  const ok = await upsertTradeLog(sb, rows, "momentum");
  console.log(`[trade-log momentum] ${ok ? "✓" : "✗"} ${rows.length} logged`);
}

// Mid-term (Base Breakout) — pattern khác Climax: trail stop thay vì fix target,
// hold T+30 trading. Log với tier='MidTerm', pattern_type='base_breakout'.
async function logMidTermInitialTrades(env, matches, signalDate) {
  if (!matches || matches.length === 0) return;
  const sb = sbClient(env);
  const rows = matches.map((m) => ({
    symbol: m.symbol,
    signal_date: signalDate,
    tier: "MidTerm",
    entry_price: m.currentPrice,
    // Target_price + sl_price NOT NULL trong schema cũ — đặt target = entry × 1.07
    // (backtest avg ret) để satisfy constraint, nhưng logic exit là trail/SL/timeout
    // thực tế qua resolve.
    target_price: +(m.currentPrice * 1.07).toFixed(4),
    sl_price: +(m.currentPrice * (1 - BASE_BREAKOUT_INIT_SL_PCT / 100)).toFixed(4),
    pattern_type: m.pattern || "base_breakout",
    max_hold_days: BASE_BREAKOUT_MAX_HOLD_TRADING,
    trail_pct: BASE_BREAKOUT_TRAIL_PCT,
    init_sl_pct: BASE_BREAKOUT_INIT_SL_PCT,
  }));
  const ok = await upsertTradeLog(sb, rows, "midterm");
  console.log(`[trade-log midterm] ${ok ? "✓" : "✗"} ${rows.length} logged`);
}

// Luật thoát dùng chung cho resolver (chấm sổ) và exit alert (báo trong phiên) —
// lệch nhau là alert hô bán ở chỗ sổ không chốt.
const CLASSICAL_EXIT = { slPct: 8, tpPct: 3, tpFromDay: 3, maxHold: 5 };

function isTrailingTier(tier) {
  return tier === "MidTerm" || tier === "Momentum";
}

function trailingExitParams(t) {
  return { initSlPct: t.init_sl_pct || 10, trailPct: t.trail_pct || 10, maxHold: t.max_hold_days || 30 };
}

function exitMaxHold(t) {
  return isTrailingTier(t.tier) ? trailingExitParams(t).maxHold : CLASSICAL_EXIT.maxHold;
}

// Pick row khác trade_log row: climax_active_picks không có cột max_hold_days
// nên Momentum ở đó phải tra hằng số, không lấy default của trailingExitParams.
function pickMaxHold(p) {
  if (p.tier === "MidTerm") return p.max_hold_days || BASE_BREAKOUT_MAX_HOLD_TRADING;
  if (p.tier === "Momentum") return MOMENTUM_MAX_HOLD_TRADING;
  return CLASSICAL_EXIT.maxHold;
}

async function resolveExpiredPicks(env) {
  await resolveClassicalPicks(env);
  await resolveMidTermPicksResolver(env);
}

async function fetchOhlcvForResolve(symbol, sigTs, daysBuffer) {
  const to = Math.floor((sigTs + daysBuffer * 24 * 3600 * 1000) / 1000);
  const from = Math.floor((sigTs - 5 * 24 * 3600 * 1000) / 1000);
  const url = `${VND_HISTORY_URL}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: VND_CHART_HEADERS });
  if (!res.ok) {
    console.warn(`[resolve fetch] ${symbol} HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) return null;
  return data;
}

// Trade không resolve được (data lỗi, mã ngừng giao dịch, signal_date không phải
// phiên) sẽ kẹt unresolved mãi và bị quét lại mỗi lần cron. Quá hạn này thì đóng
// sổ với exit_reason='unresolved' — /stats bỏ qua, khỏi bóp méo win rate.
const RESOLVE_GIVE_UP_DAYS = 30;

async function markUnresolvable(sb, trade, why) {
  const ageDays = (Date.now() - new Date(trade.signal_date).getTime()) / 86400000;
  if (ageDays < RESOLVE_GIVE_UP_DAYS) return;
  await sbUpdate(sb, "trade_log", {
    eq: { id: trade.id },
    data: { resolved_at: new Date().toISOString(), exit_reason: "unresolved" },
  });
  console.warn(`[resolve] give up ${trade.symbol} ${trade.signal_date} (${ageDays.toFixed(0)}d): ${why}`);
}

// Classical picks (Climax/FBO) — T+5 hold, target/SL fix
async function resolveClassicalPicks(env) {
  const sb = sbClient(env);
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=is.null&tier=not.in.(MidTerm,Momentum)&signal_date=lte.${cutoff}&order=signal_date.asc&limit=50`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) {
    console.warn("[resolve classical] fetch fail");
    return;
  }
  const pending = await r.json();
  console.log(`[resolve classical] ${pending.length} trades (signal_date <= ${cutoff})`);
  if (pending.length === 0) return;

  let resolved = 0;
  for (const t of pending) {
    try {
      const sigTs = new Date(t.signal_date).getTime();
      const data = await fetchOhlcvForResolve(t.symbol, sigTs, 15);
      if (!data) { await markUnresolvable(sb, t, "no ohlcv"); continue; }
      const times = data.t.map((s) => new Date(s * 1000).toISOString().slice(0, 10));
      const sigIdx = times.indexOf(t.signal_date);
      if (sigIdx < 0) { await markUnresolvable(sb, t, "signal_date không có bar"); continue; }
      const { slPct, tpPct, tpFromDay, maxHold } = CLASSICAL_EXIT;
      if (sigIdx + maxHold + 1 >= times.length) { await markUnresolvable(sb, t, "thiếu bar sau signal"); continue; }

      const entryPrice = data.o[sigIdx + 1];
      if (!entryPrice || entryPrice <= 0) { await markUnresolvable(sb, t, "entry price rỗng"); continue; }
      const slPrice = entryPrice * (1 - slPct / 100);
      const targetPrice = entryPrice * (1 + tpPct / 100);

      let exitPrice = null, exitDay = null, exitReason = null;
      for (let h = 1; h <= maxHold; h++) {
        const idx = sigIdx + 1 + h;
        if (idx >= data.c.length) break;
        const cl = data.c[idx];
        if (cl <= slPrice) { exitPrice = cl; exitDay = h; exitReason = "sl"; break; }
        if (h >= tpFromDay && cl >= targetPrice) { exitPrice = cl; exitDay = h; exitReason = "target"; break; }
        if (h === maxHold) { exitPrice = cl; exitDay = h; exitReason = "force"; }
      }
      if (exitPrice === null) { await markUnresolvable(sb, t, "không tìm được exit"); continue; }
      const netRet = (exitPrice - entryPrice) / entryPrice - 0.004;
      await sbUpdate(sb, "trade_log", {
        eq: { id: t.id },
        data: {
          resolved_at: new Date().toISOString(),
          exit_price: +exitPrice.toFixed(4), exit_day: exitDay, exit_reason: exitReason,
          net_ret: +netRet.toFixed(6), is_win: netRet > 0,
          entry_price: +entryPrice.toFixed(4),
        },
      });
      resolved++;
      console.log(`[resolve classical] ${t.symbol} ${t.signal_date} ${t.tier}: ${exitReason} day=${exitDay} ret=${(netRet*100).toFixed(2)}%`);
    } catch (e) {
      console.warn(`[resolve classical] ${t.symbol}: ${e.message}`);
    }
  }
  console.log(`[resolve classical] ${resolved}/${pending.length}`);
}

// Trailing-stop picks — MidTerm (T+30, trail 10%) và Momentum (T+20, trail 7%).
// Exit params đọc từ row (init_sl_pct/trail_pct/max_hold_days) nên chung 1 resolver.
async function resolveMidTermPicksResolver(env) {
  const sb = sbClient(env);
  // Wait 44 calendar days (= 30 trading + buffer) trước khi resolve
  const cutoff = new Date(Date.now() - 44 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=is.null&tier=in.(MidTerm,Momentum)&signal_date=lte.${cutoff}&order=signal_date.asc&limit=50`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) {
    console.warn("[resolve midterm] fetch fail");
    return;
  }
  const pending = await r.json();
  console.log(`[resolve midterm] ${pending.length} trades (signal_date <= ${cutoff})`);
  if (pending.length === 0) return;

  let resolved = 0;
  for (const t of pending) {
    try {
      const sigTs = new Date(t.signal_date).getTime();
      // Need ~50 calendar days buffer for T+30 trading data
      const data = await fetchOhlcvForResolve(t.symbol, sigTs, 55);
      if (!data) { await markUnresolvable(sb, t, "no ohlcv"); continue; }
      const times = data.t.map((s) => new Date(s * 1000).toISOString().slice(0, 10));
      const sigIdx = times.indexOf(t.signal_date);
      if (sigIdx < 0) { await markUnresolvable(sb, t, "signal_date không có bar"); continue; }

      const entryPrice = data.o[sigIdx + 1];
      if (!entryPrice || entryPrice <= 0) { await markUnresolvable(sb, t, "entry price rỗng"); continue; }
      const { initSlPct, trailPct, maxHold } = trailingExitParams(t);
      // Cần đủ bar tới hết hold window (Momentum 20 phiên, MidTerm 30)
      if (sigIdx + maxHold + 1 >= times.length) { await markUnresolvable(sb, t, "thiếu bar sau signal"); continue; }
      const initSl = entryPrice * (1 - initSlPct / 100);

      let peak = entryPrice;
      let exitPrice = null, exitDay = null, exitReason = null;
      for (let h = 1; h <= maxHold; h++) {
        const idx = sigIdx + 1 + h;
        if (idx >= data.c.length) break;
        const cl = data.c[idx];
        const hi = data.h[idx];
        if (hi && hi > peak) peak = hi;
        const trailSl = peak * (1 - trailPct / 100);
        const effSl = Math.max(initSl, trailSl);
        if (cl <= effSl) {
          exitPrice = cl; exitDay = h;
          exitReason = (effSl === initSl) ? "sl" : "trail";
          break;
        }
        if (h === maxHold) { exitPrice = cl; exitDay = h; exitReason = "force"; }
      }
      if (exitPrice === null) { await markUnresolvable(sb, t, "không tìm được exit"); continue; }
      const netRet = (exitPrice - entryPrice) / entryPrice - 0.005;  // 0.5% round-trip cost for mid-term
      await sbUpdate(sb, "trade_log", {
        eq: { id: t.id },
        data: {
          resolved_at: new Date().toISOString(),
          exit_price: +exitPrice.toFixed(4), exit_day: exitDay, exit_reason: exitReason,
          net_ret: +netRet.toFixed(6), is_win: netRet > 0,
          entry_price: +entryPrice.toFixed(4),
        },
      });
      resolved++;
      console.log(`[resolve midterm] ${t.symbol} ${t.signal_date}: ${exitReason} day=${exitDay} ret=${(netRet*100).toFixed(2)}%`);
    } catch (e) {
      console.warn(`[resolve midterm] ${t.symbol}: ${e.message}`);
    }
  }
  console.log(`[resolve midterm] ${resolved}/${pending.length}`);
}

// Peak tính lại trọn cửa sổ mỗi lần chạy thay vì cộng dồn: pick row bị upsert đè
// khi mã bắn lại, còn job lỡ chết vài hôm thì lần chạy sau tự bù. Cửa sổ bắt đầu
// từ phiên sau phiên mua, giống peak của resolver.
async function updatePeakPrices(env) {
  const sb = sbClient(env);
  const today = vnDateString();
  const [positions, climaxPicks, midTermPicks] = await Promise.all([
    loadOpenPositions(sb),
    sbQuery(sb, "climax_active_picks", { select: "symbol,peak_price,peak_date" }),
    sbQuery(sb, "mid_term_active_picks", { select: "symbol,peak_price,peak_date" }),
  ]);
  const picksByTable = {
    climax_active_picks: new Map((climaxPicks || []).map((p) => [p.symbol, p])),
    mid_term_active_picks: new Map((midTermPicks || []).map((p) => [p.symbol, p])),
  };
  let updated = 0;
  for (const t of positions) {
    const table = pickTableFor(t.tier);
    const pick = picksByTable[table].get(t.symbol);
    const firstSession = addVnTradingDays(t.signal_date, 2);
    if (!pick || firstSession > today) continue;
    try {
      const calDays = Math.ceil((Date.now() - Date.parse(`${t.signal_date}T00:00:00Z`)) / 86400000) + 3;
      const bars = await fetchVndHistory(t.symbol, calDays);
      let peak = 0, peakDate = null;
      bars.times.forEach((s, i) => {
        const d = new Date(s * 1000).toISOString().slice(0, 10);
        if (d >= firstSession && bars.highs[i] > peak) { peak = bars.highs[i]; peakDate = d; }
      });
      if (!peakDate) continue;
      if (parseFloat(pick.peak_price) === peak && pick.peak_date === peakDate) continue;
      await sbUpdate(sb, table, {
        eq: { symbol: t.symbol },
        data: { peak_price: peak, peak_date: peakDate },
      });
      updated++;
    } catch (e) {
      console.warn(`[peak] ${t.symbol} fail:`, e.message);
    }
  }
  console.log(`[peak] updated ${updated}/${positions.length}`);
}

// Fetch intraday 5-min bars for current trading day (from 9:00 VN today)
async function fetchVndIntraday(symbol) {
  // VN open 9:00 = 02:00 UTC. Lấy from = today 01:00 UTC (buffer 1h).
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));
  const from = Math.floor(todayStart.getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const url = `${VND_HISTORY_URL}?resolution=5&symbol=${symbol}&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: VND_CHART_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) throw new Error("no intraday data");
  return {
    opens: data.o,
    highs: data.h,
    lows: data.l,
    closes: data.c,
    volumes: data.v,
    times: data.t,
  };
}

// Snapshot danh mục từ app menubar (vnstock-menubar). Body:
// {holdings: [{symbol, avg_cost, qty, first_buy_date?}]}
//
// Upsert TRƯỚC rồi mới xoá mã không còn trong payload — làm ngược lại thì một
// lỗi giữa chừng sẽ để danh mục rỗng, và bot mất luôn khái niệm "đang cầm hàng".
async function handlePortfolioSync(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "body không phải JSON" }, 400);
  }
  if (!Array.isArray(body?.holdings)) {
    return jsonResponse({ error: "thiếu mảng holdings" }, 400);
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const h of body.holdings) {
    const symbol = String(h?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const avgCost = Number(h?.avg_cost);
    const qty = Number(h?.qty);
    if (symbol.length < 3 || !(avgCost > 0) || !(qty > 0)) {
      return jsonResponse({ error: `holding không hợp lệ: ${JSON.stringify(h)}` }, 400);
    }
    rows.push({
      symbol,
      avg_cost: avgCost,
      qty,
      first_buy_date: /^\d{4}-\d{2}-\d{2}$/.test(h?.first_buy_date || "")
        ? h.first_buy_date
        : null,
      source: "menubar",
      updated_at: now,
    });
  }

  const sb = sbClient(env);
  if (rows.length > 0 && !(await sbUpsert(sb, "holdings", rows, "symbol"))) {
    return jsonResponse({ error: "upsert holdings lỗi — chạy sql/015 chưa?" }, 500);
  }
  // PostgREST chặn DELETE không filter, và `not.in.()` là cú pháp sai → luôn
  // kèm sentinel để payload rỗng vẫn xoá sạch được.
  const keep = [...rows.map((r) => r.symbol), "__NONE__"];
  if (!(await sbDelete(sb, "holdings", { notIn: { symbol: keep } }))) {
    return jsonResponse({ error: "xoá mã cũ lỗi" }, 500);
  }
  return jsonResponse({ ok: true, synced: rows.map((r) => r.symbol) });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Vị thế thật của user, để alert biết đang nói với người cầm hàng hay người ngoài.
// paper_trades gắn chat_id (sổ tay gõ /b). transactions là danh mục trong app,
// KHÔNG có chat_id — coi như của chủ app, đúng cách /watch/symbols đang đọc nó.
async function loadHoldingsIndex(sb) {
  const [lots, txs, snap] = await Promise.all([
    sbQuery(sb, "paper_trades", {
      select: "chat_id,symbol,entry_price,quantity",
      eq: { status: "open" },
    }),
    sbQuery(sb, "transactions", { select: "symbol,side,quantity,price,fee,trade_date" }),
    sbQuery(sb, "holdings", { select: "symbol,avg_cost,qty,first_buy_date,updated_at" }),
  ]);

  const agg = new Map();
  for (const l of lots || []) {
    const key = `${l.chat_id}|${l.symbol}`;
    const cur = agg.get(key) || { qty: 0, cost: 0, priceSum: 0, lots: 0 };
    const qty = Number(l.quantity) || 0;
    const price = Number(l.entry_price) || 0;
    cur.qty += qty;
    cur.cost += qty * price;
    cur.priceSum += price;
    cur.lots += 1;
    agg.set(key, cur);
  }
  const paper = new Map();
  for (const [key, v] of agg) {
    // quantity nullable (lot chỉ theo dõi %) → không có qty thì lấy trung bình giá vào
    paper.set(key, {
      qty: v.qty,
      avgCost: v.qty > 0 ? v.cost / v.qty : v.priceSum / v.lots,
      source: "sổ /b",
    });
  }

  // Holdings từ transactions: duyệt theo thời gian, avg cost gồm phí — khớp
  // computeHoldings() bên PWA để hai nơi không ra hai con số giá vốn khác nhau.
  const acc = new Map();
  const sorted = (txs || []).slice().sort(
    (a, b) => new Date(a.trade_date) - new Date(b.trade_date)
  );
  for (const t of sorted) {
    const h = acc.get(t.symbol) || { qty: 0, avgCost: 0, firstBuyDate: null };
    const qty = Number(t.quantity) || 0;
    const price = Number(t.price) || 0;
    const fee = Number(t.fee) || 0;
    if (t.side === "buy") {
      const newQty = h.qty + qty;
      h.avgCost = newQty > 0 ? (h.qty * h.avgCost + qty * price + fee) / newQty : 0;
      h.qty = newQty;
      // trade_date lưu ISO timestamp đầy đủ (PWA ghi new Date().toISOString()),
      // vnTradingDaysBetween chỉ parse được "YYYY-MM-DD".
      if (!h.firstBuyDate) h.firstBuyDate = String(t.trade_date).slice(0, 10);
    } else {
      h.qty = Math.max(0, h.qty - qty);
    }
    acc.set(t.symbol, h);
  }
  const portfolio = new Map();
  for (const [sym, h] of acc) {
    if (h.qty > 1e-9) {
      portfolio.set(sym, {
        qty: h.qty, avgCost: h.avgCost, firstBuyDate: h.firstBuyDate, source: "danh mục app",
      });
    }
  }

  // `holdings` do menubar đẩy nguyên snapshot mỗi lần sửa, và nó là writer duy
  // nhất → có row nghĩa là danh mục thật nằm ở đó, transactions chỉ còn là
  // lịch sử cũ của PWA. Thay hẳn chứ không trộn: trộn là hồi sinh mã đã bán.
  let portfolioUpdatedAt = null;
  if (snap && snap.length > 0) {
    portfolio.clear();
    for (const h of snap) {
      if (h.updated_at && (!portfolioUpdatedAt || h.updated_at > portfolioUpdatedAt)) {
        portfolioUpdatedAt = h.updated_at;
      }
      const qty = Number(h.qty) || 0;
      const avgCost = Number(h.avg_cost) || 0;
      if (qty > 1e-9 && avgCost > 0) {
        portfolio.set(h.symbol, {
          qty, avgCost, firstBuyDate: h.first_buy_date, source: "danh mục menubar",
        });
      }
    }
  }

  return {
    positionFor(chatId, symbol) {
      return paper.get(`${chatId}|${symbol}`) || portfolio.get(symbol) || null;
    },
    portfolio,
    portfolioUpdatedAt,
    paperCountFor(chatId) {
      let n = 0;
      for (const key of paper.keys()) if (key.startsWith(`${chatId}|`)) n++;
      return n;
    },
  };
}

async function checkSpikeAlerts(env) {
  const sb = sbClient(env);
  const nowIso = new Date().toISOString();
  // Read active picks (not expired)
  const picks = await sbQuery(sb, "climax_active_picks", {
    select: "symbol,entry_price,target_price,tier,above_threshold,last_alert_at,signal_date,expires_at",
  });
  if (!picks || picks.length === 0) {
    return;
  }
  // Không dựa vào cleanup của EOD persist được: nó chạy ~15:30, sớm hơn expires_at
  // của pick hết hạn cùng ngày → row chết vẫn nằm lại tới EOD hôm sau và bắn tin.
  const active = picks.filter((p) => !p.expires_at || new Date(p.expires_at) > new Date());
  if (active.length === 0) return;

  console.log(`[spike] checking ${active.length} active picks`);

  // Fetch intraday concurrently (Cloudflare limit ~50 subrequests; ~5 picks typical → safe)
  const results = await Promise.all(active.map(async (p) => {
    try {
      const bars = await fetchVndIntraday(p.symbol);
      const n = bars.opens.length;
      if (n === 0) return null;
      const openToday = bars.opens[0];
      const currentHigh = Math.max(...bars.highs);
      const currentLast = bars.closes[n - 1];
      const intradayRet = ((currentHigh - openToday) / openToday) * 100;
      const lastRet = ((currentLast - openToday) / openToday) * 100;
      return { pick: p, openToday, currentHigh, currentLast, intradayRet, lastRet };
    } catch (e) {
      console.warn(`[spike] ${p.symbol} intraday fetch fail:`, e.message);
      return null;
    }
  }));

  // State machine + fire alerts
  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  const holdings = await loadHoldingsIndex(sb);

  for (const r of results) {
    if (!r) continue;
    const p = r.pick;
    const wasAbove = p.above_threshold;
    const isAbove = r.intradayRet >= SPIKE_THRESHOLD_PCT;

    // Cooldown check
    let canFire = true;
    if (p.last_alert_at) {
      const elapsed = (Date.now() - new Date(p.last_alert_at).getTime()) / 60000;
      if (elapsed < SPIKE_COOLDOWN_MIN) canFire = false;
    }

    if (isAbove && !wasAbove && canFire) {
      // Transition false→true: FIRE alert.
      // Tiêu đề nói rõ đây là mã BOT track, không phải cơ hội vào lệnh — 🚀 +
      // "spike" cũ dễ đọc thành gợi ý mua đuổi, ngược hẳn ý đồ bắt đáy.
      const clock = new Date().toLocaleTimeString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit",
      });
      const head =
        `📈 *${p.symbol}* +${r.intradayRet.toFixed(2)}% trong phiên\n` +
        `_Mã bot đang track — Tier ${p.tier}, signal ${p.signal_date} @ ${p.entry_price}_\n\n` +
        `Open hôm nay: ${r.openToday.toFixed(2)}\n` +
        `High intraday: *${r.currentHigh.toFixed(2)}* (+${r.intradayRet.toFixed(2)}% từ open)\n` +
        `Giá hiện tại: ${r.currentLast.toFixed(2)} (+${r.lastRet.toFixed(2)}%)\n\n`;
      const tail = `⏰ ${clock} VN`;

      for (const chatId of chats) {
        const pos = holdings.positionFor(chatId, p.symbol);
        let body;
        if (pos) {
          const posRet = ((r.currentLast - pos.avgCost) / pos.avgCost) * 100;
          const qtyStr = pos.qty > 0 ? `${pos.qty.toLocaleString("vi-VN")} CP · ` : "";
          body =
            `💼 *Mày đang giữ*: ${qtyStr}vốn ${pos.avgCost.toFixed(2)} → ` +
            `${posRet >= 0 ? "+" : ""}${posRet.toFixed(2)}% _(${pos.source})_\n\n` +
            `💡 *Cân nhắc bán nốt* (manual decision) — SSI iBoard:\n` +
            `① Nếu giá vẫn quanh đỉnh → menu *Lệnh thường*, loại *LO* bán giá ${r.currentHigh.toFixed(2)}\n` +
            `② Nếu đã rớt xa khỏi đỉnh → loại *MP* bán (khớp ngay) nếu vẫn lãi\n` +
            `③ Hoặc giữ tiếp — đợi target ${parseFloat(p.target_price).toFixed(2)} của bot tự khớp\n\n` +
            `${tail}\n` +
            `─────\n` +
            `_LO = lệnh giới hạn (giá cụ thể, không khớp nếu giá thị trường xấu hơn)._\n` +
            `_MP = market price (khớp ngay theo giá hiện hành, có thể trượt)._\n` +
            `_Lệnh thường = menu đầu SSI iBoard, chứa LO/MP/ATC/ATO theo giờ phiên._`;
        } else {
          body =
            `💼 Mày *không cầm* mã này — tin để biết, không cần làm gì.\n` +
            `_Bot track nó vì signal EOD, không phải vì danh mục của mày. Giá đã chạy +${r.intradayRet.toFixed(2)}% rồi, đây không phải điểm vào._\n\n` +
            `${tail}`;
        }
        await tgSendMessage(env.BOT_TOKEN, chatId, head + body);
      }
      await sbUpdate(sb, "climax_active_picks", {
        eq: { symbol: p.symbol },
        data: { above_threshold: true, last_alert_at: nowIso },
      });
      console.log(`[spike] FIRED ${p.symbol} @ +${r.intradayRet.toFixed(2)}% → ${chats.length} chats`);
    } else if (!isAbove && wasAbove) {
      // Transition true→false: re-arm (cho phép alert lại nếu sau này lên lại)
      await sbUpdate(sb, "climax_active_picks", {
        eq: { symbol: p.symbol },
        data: { above_threshold: false },
      });
      console.log(`[spike] ${p.symbol} dropped below threshold, re-armed`);
    }
    // else: no state change, no alert
  }
}

// ── Cảnh báo sớm: mã ĐANG hình thành Climax trong phiên ───────────────
// Detector thật ăn close + volume cả phiên nên chỉ chốt được lúc EOD. Ở đây tái
// tính detector giữa phiên bằng giá hiện tại + volume chiếu về cả ngày.
//
// Đường cong dưới đo trên 616 phiên-mã (20 large/mid × ~30 phiên, bar 5 phút):
// tới mốc giờ VN đó thì median đã khớp bao nhiêu % volume cả ngày. Spread p10-p90
// lúc 11:30 rộng 32pp (chiếu lệch ±35% → báo bậy đầy) nhưng co còn 16pp lúc 14:30,
// nên chỉ bắn từ 13:30 — vẫn kịp mua trước ATC mà số đã đủ tin.
const PRESIGNAL_VOL_CURVE = [
  [13 * 60 + 30, 61.1], [14 * 60, 76.2], [14 * 60 + 30, 93.0], [14 * 60 + 45, 100],
];
// Đo cùng bộ data: mã đang xanh ở mốc đó thì bao nhiêu % đóng cửa đỏ (mất
// dayGreen = signal không thành). Bơm vào message để cảnh báo tự khai sai số.
const PRESIGNAL_FLIP_RISK = [[13 * 60 + 30, 20], [14 * 60, 16], [14 * 60 + 30, 10], [14 * 60 + 45, 0]];
const PRESIGNAL_START_MIN = 13 * 60 + 30;
const PRESIGNAL_END_MIN = 14 * 60 + 45;
// 1 subrequest/mã, dùng chung ngân sách 50/invocation với watch + spike + exit alert.
const PRESIGNAL_MAX_SYMBOLS = 12;

// Nội suy tuyến tính trên bảng mốc giờ; ngoài biên thì kẹp về đầu/cuối.
function presignalInterp(curve, vnMin) {
  if (vnMin <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (vnMin <= curve[i][0]) {
      const [x0, y0] = curve[i - 1];
      const [x1, y1] = curve[i];
      return y0 + ((y1 - y0) * (vnMin - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

function presignalVolFraction(vnMin) {
  return presignalInterp(PRESIGNAL_VOL_CURVE, vnMin) / 100;
}

// Ứng viên = đã rơi đủ sâu + chưa quá mua, chỉ còn thiếu phiên xanh + volume.
// Chạy lúc EOD khi chunk scan đang cầm sẵn 220 phiên daily; snapshot lại đúng
// những số phiên sau cần, để giữa phiên khỏi phải fetch lại history.
function collectPreSignalCandidate(data) {
  const { closes, highs, lows, volumes } = data;
  const n = closes?.length || 0;
  if (n < 62 || !highs || !lows) return null;

  const turnovers = [];
  for (let i = n - 20; i < n; i++) turnovers.push(closes[i] * volumes[i] * 1000);
  turnovers.sort((a, b) => a - b);
  const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
  if (medianTurnover < CLIMAX_TURNOVER_MIN) return null;

  const cur = closes[n - 1];
  const ret3d = ((cur - closes[n - 4]) / closes[n - 4]) * 100;
  const rsi = calcRsi(closes, 14);
  // -5 / 50 = ngưỡng Tier B (lỏng nhất) — lọc rộng ở đây, siết lại lúc bắn.
  if (rsi == null || rsi >= 50 || ret3d >= -5) return null;

  // ATR14 phiên sau trượt cửa sổ sang [n-13 .. n]: 13 phiên này chốt được ngay,
  // TR của chính phiên sau ghép vào lúc chạy (cần high/low intraday).
  let trSum13 = 0;
  for (let i = n - 13; i < n; i++) {
    trSum13 += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  const volSlice = volumes.slice(n - 20);
  return {
    // Phiên sau mảng thành [...closes, cur] nên ret3d lấy mẫu số closes[n-3],
    // vol_avg20 / median_turnover là 20 phiên gần nhất kể cả hôm nay.
    prev3_close: closes[n - 3],
    prev_close: cur,
    vol_avg20: volSlice.reduce((a, b) => a + b, 0) / volSlice.length,
    tr_sum13: trSum13,
    median_turnover: medianTurnover,
    closes60: closes.slice(-60),
    ret3d_at_scan: +ret3d.toFixed(2),
    rsi_at_scan: +rsi.toFixed(1),
  };
}

async function persistPreSignalCandidates(env, candidates, snapshotDate) {
  if (!candidates.length) return;
  const watchDate = addVnTradingDays(snapshotDate, 1);
  const rows = candidates.map((c) => ({
    symbol: c.symbol,
    watch_date: watchDate,
    snapshot_date: snapshotDate,
    prev3_close: c.prev3_close,
    prev_close: c.prev_close,
    vol_avg20: c.vol_avg20,
    tr_sum13: c.tr_sum13,
    median_turnover: c.median_turnover,
    closes60: c.closes60,
    ret3d_at_scan: c.ret3d_at_scan,
    rsi_at_scan: c.rsi_at_scan,
    alerted_at: null,
  }));
  const ok = await sbUpsert(sbClient(env), "presignal_watch", rows, "symbol,watch_date");
  if (!ok) console.warn(`[presignal] upsert ${rows.length} ứng viên fail (chạy sql/012 chưa?)`);
}

async function checkPreSignalAlerts(env) {
  const vn = vnNow();
  const min = vn.getHours() * 60 + vn.getMinutes();
  if (min < PRESIGNAL_START_MIN || min > PRESIGNAL_END_MIN) return;

  const sb = sbClient(env);
  const today = vnDateString();
  const rows = await sbQuery(sb, "presignal_watch", {
    select: "symbol,prev3_close,prev_close,vol_avg20,tr_sum13,closes60,ret3d_at_scan,alerted_at",
    eq: { watch_date: today },
  });
  if (!rows || rows.length === 0) return;

  // Rơi sâu nhất trước — cắt theo ngân sách subrequest.
  const pending = rows
    .filter((r) => !r.alerted_at)
    .sort((a, b) => parseFloat(a.ret3d_at_scan ?? 0) - parseFloat(b.ret3d_at_scan ?? 0))
    .slice(0, PRESIGNAL_MAX_SYMBOLS);
  if (pending.length === 0) return;

  const frac = presignalVolFraction(min);
  console.log(`[presignal] check ${pending.length} ứng viên, volume chiếu từ ${(frac * 100).toFixed(0)}%`);

  const hits = [];
  await Promise.all(pending.map(async (r) => {
    try {
      const bars = await fetchVndIntraday(r.symbol);
      const n = bars.closes.length;
      if (!n || !bars.volumes) return;
      const cur = bars.closes[n - 1];
      const openToday = bars.opens[0];
      if (cur <= openToday) return;                       // dayGreen — điều kiện cứng của detector

      const volAvg20 = parseFloat(r.vol_avg20);
      const volSoFar = bars.volumes.reduce((a, b) => a + b, 0);
      const volRatio = volAvg20 > 0 ? volSoFar / frac / volAvg20 : 0;
      if (volRatio <= 2.0) return;

      const rsi = calcRsi([...(r.closes60 || []), cur], 14);
      if (rsi == null) return;
      const prev3 = parseFloat(r.prev3_close);
      const ret3d = ((cur - prev3) / prev3) * 100;
      // Ghép TR phiên đang chạy vào 13 phiên đã chốt cho khớp ATR của detector EOD.
      const prevClose = parseFloat(r.prev_close);
      const hiToday = Math.max(...bars.highs);
      const loToday = Math.min(...bars.lows);
      const trToday = Math.max(hiToday - loToday, Math.abs(hiToday - prevClose), Math.abs(loToday - prevClose));
      const trSum13 = r.tr_sum13 != null ? parseFloat(r.tr_sum13) : null;
      const atr14 = trSum13 != null ? (trSum13 + trToday) / 14 : null;
      const dropThreshA = atr14 ? -3.0 * ((atr14 / cur) * 100) : -7;
      const tier = ret3d < dropThreshA && rsi < 35 ? "A" : ret3d < -5 && rsi < 50 ? "B" : null;
      if (!tier) return;

      hits.push({
        symbol: r.symbol, tier, cur, ret3d, volRatio, rsi,
        intradayPct: (cur / openToday - 1) * 100,
      });
    } catch (e) {
      console.warn(`[presignal] ${r.symbol}: ${e.message}`);
    }
  }));
  if (hits.length === 0) return;

  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (chats.length === 0) return;

  const minsLeft = PRESIGNAL_END_MIN - min;
  let msg = `⏳ *ĐANG HÌNH THÀNH* — chưa xác nhận\n\n`;
  for (const h of hits) {
    msg += `🔍 *${h.symbol}* ${h.cur.toFixed(2)} (+${h.intradayPct.toFixed(1)}% trong phiên)\n`;
    msg += `   Tier ${h.tier} tạm đạt · vol ~${h.volRatio.toFixed(1)}× · 3p ${h.ret3d.toFixed(1)}% · RSI ${h.rsi.toFixed(0)}\n`;
  }
  const flipRisk = presignalInterp(PRESIGNAL_FLIP_RISK, min);
  msg += `\nCòn ${minsLeft} phút tới 14:45. Volume mới khớp ${(frac * 100).toFixed(0)}% phiên nên còn chiếu.\n`;
  msg += `Ở mốc này ~${flipRisk.toFixed(0)}% mã đang xanh sẽ đóng cửa đỏ — khi đó signal không thành.\n`;
  msg += `⚠️ Đây KHÔNG phải lệnh mua. Backtest realistic exit của pattern Climax đang âm.`;

  for (const chatId of chats) await tgSendMessage(env.BOT_TOKEN, chatId, msg);
  await sbUpdate(sb, "presignal_watch", {
    eq: { watch_date: today },
    in: { symbol: hits.map((h) => h.symbol) },
    data: { alerted_at: new Date().toISOString() },
  });
  console.log(`[presignal] alert ${hits.map((h) => h.symbol).join(",")}`);
}

// ── Auto-exit alert: discipline enforcer ──────────────────────────────
// Vị thế lấy từ trade_log (đúng row resolver sẽ chấm), không lấy từ bảng pick:
// pick bị upsert đè signal_date/tier mỗi lần mã bắn lại, còn trade_log giữ vị
// thế gốc. Bảng pick chỉ còn vai trò chứa peak_price + dấu đã báo.
async function checkExitAlerts(env) {
  const sb = sbClient(env);
  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (!chats.length) {
    console.log("[exit-alert] no Telegram users linked");
    return;
  }

  const today = vnDateString();
  // held = số phiên sau phiên mua, cùng nghĩa exit_day của resolver. Phiên mua
  // resolver chưa xét thoát nên alert bỏ qua. Quá maxHold là sổ đã chốt theo luật,
  // row chỉ còn chờ cron resolver ghi — báo lúc đó là báo trễ.
  const positions = (await loadOpenPositions(sb))
    .map((t) => ({ ...t, held: vnTradingDaysBetween(t.signal_date, today) - 1 }))
    .filter((t) => t.held >= 1 && t.held <= exitMaxHold(t));
  if (!positions.length) return;

  const [climaxPicks, midTermPicks] = await Promise.all([
    sbQuery(sb, "climax_active_picks", { select: "symbol,peak_price,exit_alerted_at" }),
    sbQuery(sb, "mid_term_active_picks", { select: "symbol,peak_price,exit_alerted_at" }),
  ]);
  const picksByTable = {
    climax_active_picks: new Map((climaxPicks || []).map((p) => [p.symbol, p])),
    mid_term_active_picks: new Map((midTermPicks || []).map((p) => [p.symbol, p])),
  };

  const candidates = [];
  for (const t of positions) {
    const pick = picksByTable[pickTableFor(t.tier)].get(t.symbol);
    // Không có row thì không có chỗ ghi dấu đã báo → sẽ bắn lại mỗi 3 phút.
    if (!pick) continue;
    // Upsert pick không đụng exit_alerted_at, nên dấu của vị thế cũ cùng mã còn
    // nằm lại — dấu trước signal_date không phải của vị thế này.
    if (pick.exit_alerted_at && pick.exit_alerted_at.slice(0, 10) >= t.signal_date) continue;
    candidates.push({ t, pick });
  }
  if (!candidates.length) return;
  console.log(`[exit-alert] checking ${candidates.length}/${positions.length} positions`);

  const results = await Promise.all(candidates.map(async ({ t, pick }) => {
    try {
      const bars = await fetchVndIntraday(t.symbol);
      const cur = bars.closes[bars.closes.length - 1];
      const peak = Math.max(parseFloat(pick.peak_price) || 0, ...bars.highs);
      const hit = evaluateExit(t, cur, peak);
      return hit ? { t, cur, ...hit } : null;
    } catch (e) {
      console.warn(`[exit-alert] ${t.symbol} fail:`, e.message);
      return null;
    }
  }));

  let alerted = 0;
  for (const r of results) {
    if (!r) continue;
    const msg = buildExitAlertMessage(r);
    for (const chatId of chats) {
      try {
        await tgSendMessage(env.BOT_TOKEN, chatId, msg);
      } catch (e) {
        console.warn(`[exit-alert] tg send fail chat=${chatId}:`, e.message);
      }
    }
    await sbUpdate(sb, pickTableFor(r.t.tier), {
      eq: { symbol: r.t.symbol },
      data: {
        exit_alerted_at: new Date().toISOString(),
        exit_alert_reason: r.reason,
      },
    });
    alerted++;
  }
  console.log(`[exit-alert] sent ${alerted} alerts`);
}

async function loadOpenPositions(sb) {
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=symbol,signal_date,tier,entry_price,sl_price,target_price,max_hold_days,trail_pct,init_sl_pct&resolved_at=is.null`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) {
    console.warn("[open-positions] fetch fail", r.status);
    return [];
  }
  return r.json();
}

function pickTableFor(tier) {
  return tier === "MidTerm" ? "mid_term_active_picks" : "climax_active_picks";
}

// Luật của resolver áp lên giá trong phiên. Resolver chấm theo giá đóng cửa nên
// alert chỉ là cảnh báo sớm. Entry là close ngày signal chứ không phải open phiên
// mua như resolver: lấy open cần thêm 1 subrequest/mã ở mỗi lượt cron 3 phút.
function evaluateExit(t, cur, peak) {
  const entry = parseFloat(t.entry_price);
  if (!(entry > 0) || !(cur > 0)) return null;
  const ret = ((cur - entry) / entry) * 100;

  if (isTrailingTier(t.tier)) {
    const { initSlPct, trailPct, maxHold } = trailingExitParams(t);
    const top = Math.max(entry, peak || 0);
    const initSl = entry * (1 - initSlPct / 100);
    const trailSl = top * (1 - trailPct / 100);
    const stop = Math.max(initSl, trailSl);
    if (cur <= stop) {
      return stop === initSl
        ? { reason: "sl_hit", ret, stop, rulePct: initSlPct, held: t.held, maxHold }
        : { reason: "trail_hit", ret, stop, top, rulePct: trailPct, held: t.held, maxHold };
    }
    if (t.held >= maxHold) return { reason: "timeout", ret, held: t.held, maxHold };
    return null;
  }

  const { slPct, tpPct, tpFromDay, maxHold } = CLASSICAL_EXIT;
  const slPrice = entry * (1 - slPct / 100);
  const targetPrice = entry * (1 + tpPct / 100);
  if (cur <= slPrice) {
    return { reason: "sl_hit", ret, stop: slPrice, rulePct: slPct, held: t.held, maxHold };
  }
  if (t.held >= tpFromDay && cur >= targetPrice) {
    return { reason: "target_hit", ret, target: targetPrice, held: t.held, maxHold };
  }
  if (t.held >= maxHold) return { reason: "timeout", ret, held: t.held, maxHold };
  return null;
}

function buildExitAlertMessage(r) {
  const { t } = r;
  const px = (v) => v.toFixed(2);
  const retFmt = `${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}%`;
  const timeStr = new Date().toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit",
  });
  const head = (icon) => `${icon} *EXIT ALERT — ${t.symbol}* (${t.tier})\n\n`;
  const position =
    `• Signal ${fmtVnDM(t.signal_date)} @${px(parseFloat(t.entry_price))} → hiện *${px(r.cur)}* (${retFmt})\n` +
    `• Đã giữ ${r.held}/${r.maxHold} phiên\n\n`;
  const tail = `_Sổ theo dõi chốt theo giá đóng cửa — giá trong phiên còn chạy._\n⏰ ${timeStr} VN`;

  if (r.reason === "sl_hit") {
    return head("⛔") +
      `📉 Thủng stop lỗ *${px(r.stop)}* (−${r.rulePct}% so giá signal)\n` + position +
      `*👉 Cân nhắc BÁN để cắt lỗ.*\n` + tail;
  }
  if (r.reason === "trail_hit") {
    const dropPct = ((r.top - r.cur) / r.top) * 100;
    return head("📉") +
      `📊 Rớt *${dropPct.toFixed(1)}%* từ đỉnh ${px(r.top)} — thủng trailing stop *${px(r.stop)}* (−${r.rulePct}% từ đỉnh)\n` + position +
      `*👉 Cân nhắc BÁN — kế hoạch thoát ở đây.*\n` + tail;
  }
  if (r.reason === "target_hit") {
    return head("🎯") +
      `✅ Chạm mục tiêu *${px(r.target)}* (+${CLASSICAL_EXIT.tpPct}%)\n` + position +
      `*👉 Cân nhắc CHỐT lời theo plan.*\n` + tail;
  }
  if (r.reason === "timeout") {
    return head("⏰") +
      `📅 Hết ${r.maxHold} phiên giữ theo plan\n` + position +
      `*👉 Cân nhắc BÁN trong phiên hôm nay.*\n` + tail;
  }
  return `⚠️ *${t.symbol}* — Exit reason không xác định: ${r.reason}`;
}

// ── Entry alert: nhắc vào lệnh đúng phiên sổ bot tính giá vào ─────────
// Sổ bot vào bằng giá MỞ CỬA phiên kế tiếp phiên signal, nên tin phải tới
// trước 9:00 mới đặt được ATO. Hai nhịp: ngay sau scan (biết trước để chuẩn bị)
// và 8:30 hôm sau (chỉ mã chưa thấy trong danh mục thật). Hết phiên vào lệnh là
// thôi nhắc — mua trễ thì kết quả thật lệch hẳn con số bot báo trong /stats.

// Lấy đúng mức size digest đang nói, không tự chế con số mới.
const TIER_SIZE_HINT = {
  Premium: "size 20% NAV", Elite: "size 18% NAV", A: "size 15% NAV", B: "size 10% NAV",
  Momentum: "size 12% NAV", MidTerm: "size 10M/lệnh", FBO: "size nhỏ hơn Climax",
};
const ENTRY_MAX_PREMIUM_PCT = 2;    // digest vẫn nói MUA ≤ giá signal +2%
const ENTRY_ALERT_MAX_SYMBOLS = 8;  // mỗi tin 1 subrequest/chat — chặn trần cho chắc

// trade_log mới là thứ quyết định bot có vào lệnh hay không: mã đang mở bị
// dropSymbolsAlreadyOpen loại nên có pick row mà không có vị thế mới.
async function loadEntryPlan(sb, signalDate) {
  const positions = (await loadOpenPositions(sb)).filter((t) => t.signal_date === signalDate);
  if (!positions.length) return [];

  const [climaxPicks, midTermPicks] = await Promise.all([
    sbQuery(sb, "climax_active_picks", { select: "symbol,entry_alerted_at" }),
    sbQuery(sb, "mid_term_active_picks", { select: "symbol,entry_alerted_at" }),
  ]);
  const picksByTable = {
    climax_active_picks: new Map((climaxPicks || []).map((p) => [p.symbol, p])),
    mid_term_active_picks: new Map((midTermPicks || []).map((p) => [p.symbol, p])),
  };

  return positions.map((t) => ({
    t,
    pick: picksByTable[pickTableFor(t.tier)].get(t.symbol) || null,
    entry: parseFloat(t.entry_price),
    sl: parseFloat(t.sl_price),
    target: parseFloat(t.target_price),
    maxHold: exitMaxHold(t),
  }));
}

function entryPlanLine(item) {
  const { t } = item;
  const px = (v) => v.toFixed(2);
  const icon = TIER_ICONS[t.tier] || "•";
  const entryMax = item.entry * (1 + ENTRY_MAX_PREMIUM_PCT / 100);
  const size = TIER_SIZE_HINT[t.tier] ? ` · ${TIER_SIZE_HINT[t.tier]}` : "";
  const plan = isTrailingTier(t.tier)
    ? `giữ tối đa ${item.maxHold} phiên · trail ${trailingExitParams(t).trailPct}% từ đỉnh`
    : `CHỐT ≥ ${px(item.target)} (T+${CLASSICAL_EXIT.tpFromDay}→T+${item.maxHold})`;
  return `${icon} *${t.symbol}* (${t.tier}) @ ${px(item.entry)}\n` +
    `   MUA ≤ ${px(entryMax)} · CẮT < ${px(item.sl)} · ${plan}${size}\n`;
}

function entryPlanBody(items) {
  let text = "";
  for (const item of items.slice(0, ENTRY_ALERT_MAX_SYMBOLS)) text += entryPlanLine(item);
  if (items.length > ENTRY_ALERT_MAX_SYMBOLS) {
    text += `\n_+${items.length - ENTRY_ALERT_MAX_SYMBOLS} mã nữa — xem digest EOD._\n`;
  }
  return text;
}

function fmtVnDateTime(iso) {
  const vn = vnNow(new Date(iso));
  const hh = String(vn.getHours()).padStart(2, "0");
  const mm = String(vn.getMinutes()).padStart(2, "0");
  return `${fmtVnDM(vnDateString(new Date(iso)))} ${hh}:${mm}`;
}

function holdingsFreshnessNote(holdings) {
  if (!holdings.portfolioUpdatedAt) {
    return `📒 Chưa có danh mục menubar nào đẩy lên — bot đang coi như mày chưa cầm mã nào.`;
  }
  return `📒 Danh mục menubar cập nhật ${fmtVnDateTime(holdings.portfolioUpdatedAt)} — mua rồi thì sync lại cho bot khỏi nhắc thừa.`;
}

// Nhịp 1 — ngay sau scan EOD, tách khỏi digest dài để không phải cuộn tìm giá mua.
async function sendEntryPlan(env) {
  const sb = sbClient(env);
  const signalDate = lastVnTradingDay();
  const items = await loadEntryPlan(sb, signalDate);
  if (!items.length) return;

  const chats = await resolveBroadcastChats(env, null);
  if (!chats.length) return;

  const entrySession = addVnTradingDays(signalDate, 1);
  let text = `🟢 *VÀO LỆNH PHIÊN ${fmtVnDM(entrySession)}* — ${items.length} mã\n\n`;
  text += `_Sổ bot tính giá vào bằng giá mở cửa phiên đó: đặt ATO hoặc mua đầu phiên, đừng đuổi giá._\n\n`;
  text += entryPlanBody(items);
  text += `\n⏰ 8:30 mai bot nhắc lại mã nào chưa thấy trong danh mục.`;

  let sent = 0;
  for (const chatId of chats) {
    try {
      const resp = await tgSendMessage(env.BOT_TOKEN, chatId, text);
      if (resp?.ok) sent++;
    } catch (e) {
      console.warn(`[entry-plan] send fail ${chatId}:`, e.message);
    }
  }
  console.log(`[entry-plan] ${items.length} symbols → ${sent}/${chats.length} chats`);
}

// Nhịp 2 — 8:30 phiên vào lệnh, chỉ những mã sổ thật chưa có. Im khi đã mua đủ.
async function sendEntryReminder(env, onlyChatId = null) {
  const sb = sbClient(env);
  const today = vnDateString();
  if (!isVnTradingDay(today)) return;

  const signalDate = prevVnTradingDay(today);
  const items = await loadEntryPlan(sb, signalDate);
  if (!items.length) return;

  const chats = await resolveBroadcastChats(env, onlyChatId);
  if (!chats.length) return;
  const holdings = await loadHoldingsIndex(sb);

  const alerted = new Set();
  for (const chatId of chats) {
    // Dấu đã nhắc nằm trên pick row (khoá theo mã) nên nó chung cho mọi chat.
    // Gọi tay từ /briefing thì bỏ qua dấu — user hỏi lại thì phải trả lời.
    const pending = items.filter((item) => {
      if (holdings.positionFor(chatId, item.t.symbol)) return false;
      if (onlyChatId) return true;
      const at = item.pick?.entry_alerted_at;
      return !(at && at.slice(0, 10) >= signalDate);
    });
    if (!pending.length) continue;

    let text = `⏰ *CHƯA VÀO LỆNH — phiên hôm nay ${fmtVnDM(today)}*\n\n`;
    text += `_Signal ${fmtVnDM(signalDate)}. Sổ bot vào bằng giá mở cửa hôm nay, hết phiên này bot thôi nhắc._\n\n`;
    text += entryPlanBody(pending);
    text += `\n${holdingsFreshnessNote(holdings)}`;
    try {
      await tgSendMessage(env.BOT_TOKEN, chatId, text);
      for (const item of pending) alerted.add(item);
    } catch (e) {
      console.warn(`[entry-remind] send fail ${chatId}:`, e.message);
    }
  }

  if (onlyChatId) return;
  for (const item of alerted) {
    if (!item.pick) continue;
    await sbUpdate(sb, pickTableFor(item.t.tier), {
      eq: { symbol: item.t.symbol },
      data: { entry_alerted_at: new Date().toISOString() },
    });
  }
  console.log(`[entry-remind] ${alerted.size}/${items.length} symbols nhắc lại`);
}

// ── Market Digest: VN-Index + top gainers/losers/vol + Bắt đáy ──
// Top 2 — Daily morning briefing 8:30 VN
// Concise Telegram summary: last 5d performance + active picks countdown + day expectation.
// ── Tử vi lướt sóng (morning briefing, cho vui) ───────────────────────
// Gemini sinh 1 lá tử vi CK hài hước, pha market mood từ VNI. Fallback template.
async function getVniMood() {
  try {
    const vni = await fetchVndHistory("VNINDEX", 100);
    const cs = vni.closes;
    const n = cs.length;
    if (n < 50) return "sideways";
    const cur = cs[n - 1];
    const ma20 = cs.slice(n - 20).reduce((a, b) => a + b, 0) / 20;
    const ma50 = cs.slice(n - 50).reduce((a, b) => a + b, 0) / 50;
    const ret5 = ((cur - cs[n - 6]) / cs[n - 6]) * 100;
    if (cur < ma50 && ret5 < -2) return "weak";
    if (cur > ma20 && ret5 > 1) return "strong";
    return "sideways";
  } catch (e) {
    console.warn("[horoscope] vni mood fail:", e.message);
    return "unknown";
  }
}

const HOROSCOPE_FALLBACK = {
  weak: [
    "Sao Thái Bạch chiếu mệnh, cung Tài Bạch nhuốm màu đỏ quạch, tài khoản dễ bị 'quét vôi' như tường nhà mới. Thần Tài hôm nay bận đi... nhặt rác dưới đáy, chưa rảnh ghé thăm ai.\n\nViệc nên làm: ngồi im giữ tiền, pha ấm trà, xem người khác đua lệnh bắt dao. Đại kỵ: nghe phím hàng rồi múc đuổi giữa phiên rơi — coi chừng gồng lỗ tới Tết.\n\nThầy phán: kiên nhẫn là một loại vị thế. Chờ chợ tạo đáy rồi hãy tính.\n🍀 Số may mắn: 0 (số lệnh nên vào). Màu may mắn: xanh — màu của tiền mặt trong tài khoản.",
    "Cung Tài Bạch động, mà động theo chiều... lao dốc. 'Tay to' đang bày mâm gom hàng của mấy bạn hoảng loạn, đừng vội làm 'lá cải' cho họ xào.\n\nViệc nên làm: hạ tỷ trọng, giữ tâm lý vững, đừng để 'lái' dắt mũi. Đại kỵ: trung bình giá xuống theo kiểu 'càng giảm càng múc' khi xu hướng chưa gãy phe bán.\n\nThầy phán: bảo toàn vốn hôm nay, để mai còn cửa đánh.\n🍀 Số may mắn: 3 (số phiên nên đứng ngoài). Màu may mắn: trắng — cho tâm hồn thanh tịnh.",
  ],
  strong: [
    "Cát tinh chiếu mệnh, Thần Tài gõ cửa ba tiếng, dòng tiền hưng phấn chảy như suối tháng Ba. Sóng đang lên, cung Quan Lộc rạng rỡ.\n\nViệc nên làm: cưỡi sóng nhưng nhớ đội mũ bảo hiểm (stop-loss), ăn đủ no thì buông đũa. Đại kỵ: 'fomo đu đỉnh', tham một miếng cuối rồi kẹp cả mâm.\n\nThầy phán: tham thì thâm, chốt lời không bao giờ là sai.\n🍀 Số may mắn: 7. Màu may mắn: vàng — màu áo Thần Tài.",
    "Sao Hồng Loan gặp cổ phiếu, duyên tài lộc phơi phới, tài khoản có cửa xanh lè. Nhưng phúc bất trùng lai.\n\nViệc nên làm: gồng lãi cho khéo, dời stop theo giá. Đại kỵ: nhô hào 'all-in' rồi khoe lãi sớm — chợ ghét nhất kẻ tự tin quá đà.\n\nThầy phán: kỷ luật giữ lãi khó hơn cắt lỗ, ai làm được người đó thắng.\n🍀 Số may mắn: 5. Màu may mắn: xanh lá.",
  ],
  sideways: [
    "Thị trường lình xình như lòng người chưa quyết, sao chiếu mệnh hôm nay là sao... Chờ. Biển lặng, sóng không, cần câu chưa giật.\n\nViệc nên làm: quan sát, ghi watchlist, tỉa cỏ danh mục. Đại kỵ: ép sóng khi biển lặng, giao dịch cho đỡ buồn tay rồi mất phí oan.\n\nThầy phán: không giao dịch cũng là một quyết định khôn ngoan.\n🍀 Số may mắn: 2 (cốc cà phê để tỉnh táo). Màu may mắn: xám — như tâm trạng cái chợ.",
    "Cung Tài Bạch đang 'buffering', vạn sự chờ nạp. Âm dương giằng co, phe mua phe bán ngang tài.\n\nViệc nên làm: giữ tiền, giữ sức, đợi tín hiệu rõ. Đại kỵ: vào lệnh theo cảm xúc lúc chợ vô định.\n\nThầy phán: người biết chờ mới là tay to thật sự.\n🍀 Số may mắn: 4. Màu may mắn: be — trung tính như thị trường.",
  ],
  unknown: [
    "Thiên cơ bất khả lộ (VNI hôm nay bói mãi không ra 😅), sao trời khuất mây, thầy cũng chịu.\n\nViệc nên làm: bám nguyên tắc — quản trị rủi ro trước, lợi nhuận sau. Đại kỵ: đánh lớn khi chính mình còn mù mờ.\n\nThầy phán: khi không chắc, cỡ lệnh nhỏ lại là thượng sách.\n🍀 Số may mắn: 8. Màu may mắn: xanh.",
  ],
  // Ngày chợ đóng (T7/CN/lễ) — không bói chuyện múc/xúc, chỉ nghỉ ngơi + chuẩn bị.
  closed: [
    "Hôm nay bảng điện tắt đèn, sao Thiên Nhàn chiếu mệnh, cung Tài Bạch được nghỉ phép có lương. Tay to cũng đi nhậu, 'lái' cũng về quê, chợ vắng như đình giữa trưa.\n\nViệc nên làm: đóng app, ngủ nướng, ngó lại nhật ký giao dịch tuần qua xem mình sai ở đâu. Đại kỵ: mở bảng giá cũ ra ngắm rồi tự dằn vặt, hoặc lên hội nhóm nghe phím hàng cho phiên tới.\n\nThầy phán: nghỉ đúng lúc cũng là một kỹ năng. Tài khoản không cháy vào ngày chợ đóng.\n🍀 Số may mắn: 0 (số lệnh khớp hôm nay). Màu may mắn: xanh — màu của tiền nằm im.",
    "Chợ nghỉ, thầy cũng gác quẻ, bàn tính xếp xó. Sao Thái Bạch hôm nay bận đi chơi, chưa kịp quét vôi tài khoản ai.\n\nViệc nên làm: nạp lại năng lượng, lọc watchlist cho phiên tới, xem lại kế hoạch cắt lỗ đã đặt chưa. Đại kỵ: ngồi tính lãi tưởng tượng rồi hưng phấn, phiên mở cửa lại all-in.\n\nThầy phán: người thắng lâu dài là người biết khi nào không cần đánh.\n🍀 Số may mắn: 6 (số giờ nên ngủ thêm). Màu may mắn: trắng — cho đầu óc trống trải.",
  ],
};

async function buildHoroscope(env) {
  const mood = await getVniMood();
  const day = vnDayContext();
  const moodDesc = {
    weak: "thị trường đang điều chỉnh, phe bán mạnh, VNI dưới MA50",
    strong: "thị trường khỏe, dòng tiền hưng phấn, VNI trên MA20",
    sideways: "thị trường lình xình đi ngang chờ hướng",
    unknown: "",
  }[mood];

  if (env.GEMINI_API_KEY) {
    try {
      // Prompt PHẢI nêu rõ thứ + ngày, nếu chỉ đưa "3/8" thì model tự suy ra thứ và bịa sai.
      const nextClose = day.upcomingHoliday;
      const sessionLine = day.isTradingDay
        ? `Hôm nay CÓ phiên giao dịch (HOSE mở 9:00-11:30 và 13:00-14:45).`
        : `Hôm nay thị trường ĐÓNG CỬA (${day.closedReason}), không có phiên giao dịch.`;
      const prompt =
        `Bạn là "thầy bói chứng khoán" hài hước. Viết 1 lá tử vi DÀI DẶN, có chiều sâu (khoảng 6-9 câu, ` +
        `chia 3 đoạn ngắn: (1) vận thị trường chung hôm nay, (2) việc NÊN làm & ĐẠI KỴ hôm nay, ` +
        `(3) lời thầy phán chốt hạ) cho dân lướt sóng chứng khoán Việt Nam, phong cách ` +
        `vui nhộn lầy lội, dùng ẩn dụ tử vi/phong thủy pha thuật ngữ chứng khoán (sao Thái Bạch, Thần Tài, ` +
        `cung Tài Bạch, bắt đáy, cắt lỗ, tay to, đu đỉnh, gồng lãi, gồng lỗ, múc, xúc, bay màu...).\n` +
        `DỮ KIỆN NGÀY (dùng đúng, KHÔNG được suy diễn hay nhắc bất kỳ thứ/ngày nào khác):\n` +
        `- Hôm nay là ${day.weekday}, ngày ${day.dayLabel}.\n` +
        `- ${sessionLine}\n` +
        (nextClose
          ? `- Sắp tới nghỉ ${nextClose.name} ngày ${fmtVnDMY(nextClose.date)}` +
            ` (còn ${nextClose.daysAway} ngày) — nhắc khéo 1 câu về kỳ nghỉ này.\n`
          : "") +
        (day.isTradingDay
          ? ""
          : `Vì chợ đóng cửa: TUYỆT ĐỐI KHÔNG viết như thể hôm nay có giao dịch (không "phiên hôm nay", ` +
            `không xui múc/bắt đáy/chốt lời trong ngày). Hãy nói về nghỉ ngơi, nhìn lại danh mục, ` +
            `chuẩn bị tinh thần cho phiên kế tiếp.\n`) +
        (moodDesc
          ? `Tâm trạng thị trường ${day.isTradingDay ? "hôm nay" : "phiên gần nhất"}: ${moodDesc}. ` +
            `Để lá tử vi phản ánh RÕ tâm trạng này.\n`
          : "") +
        `TUYỆT ĐỐI KHÔNG khuyến nghị mua/bán mã cụ thể, KHÔNG hứa lợi nhuận. ` +
        `Kết bằng "Số may mắn" và "Màu may mắn" kèm 1 câu bông đùa. ` +
        `Viết văn xuôi thuần, KHÔNG thêm tiêu đề, KHÔNG dùng ký hiệu markdown (* ** # _). ` +
        `Chỉ trả về nội dung lá tử vi, không giải thích thêm.`;
      const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.95, maxOutputTokens: 800 },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          ],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        let t = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (t) {
          // Strip markdown: Telegram legacy Markdown vỡ với **/#/_ từ Gemini
          t = t.replace(/[*#`_]/g, "").replace(/\n{3,}/g, "\n\n").trim();
          return t;
        }
      } else {
        console.warn("[horoscope] gemini", r.status);
      }
    } catch (e) {
      console.warn("[horoscope] gemini fail:", e.message);
    }
  }
  // Fallback template — ngày chợ đóng dùng bộ riêng, còn lại chọn theo mood.
  // Xoay theo ngày VN (getDate() của Worker là UTC → lệch ngày lúc rạng sáng VN).
  const key = day.isTradingDay ? mood : "closed";
  const arr = HOROSCOPE_FALLBACK[key] || HOROSCOPE_FALLBACK.unknown;
  const body = arr[Number(day.dateStr.slice(8, 10)) % arr.length];
  return `${day.fullLabel}${day.isTradingDay ? "" : ` — ${day.closedReason}`}.\n\n${body}`;
}

// Cron gửi cho mọi user; lệnh gõ tay chỉ gửi cho đúng người gõ.
async function resolveBroadcastChats(env, onlyChatId) {
  if (onlyChatId) return [onlyChatId];
  const users = await sbQuery(sbClient(env), "user_telegram", { select: "chat_id" });
  return (users || []).map((u) => u.chat_id).filter(Boolean);
}

async function sendMorningBriefing(env, onlyChatId = null) {
  const sb = sbClient(env);

  // 1. Fetch last 30 days resolved trades
  const fiveDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=not.is.null&signal_date=gte.${fiveDaysAgo}&order=signal_date.desc&limit=20`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  const recentTrades = r.ok ? await r.json() : [];

  // 2. Lệnh đang mở lấy từ trade_log như /stats và exit alert. Bảng pick bị
  // upsert đè signal_date mỗi lần mã bắn lại, còn 2 bảng chồng nhau khi một mã
  // bắn ở cả 2 nhóm → đọc từ đó là đếm đôi và đếm ngược sai.
  const [openPositions, climaxPicks, midTermPicks] = await Promise.all([
    loadOpenPositions(sb),
    sbQuery(sb, "climax_active_picks", { select: "symbol,peak_price" }),
    sbQuery(sb, "mid_term_active_picks", { select: "symbol,peak_price" }),
  ]);
  const activePicks = [...openPositions].sort((a, b) => b.signal_date.localeCompare(a.signal_date));
  const peakByTable = {
    climax_active_picks: new Map((climaxPicks || []).map((p) => [p.symbol, p.peak_price])),
    mid_term_active_picks: new Map((midTermPicks || []).map((p) => [p.symbol, p.peak_price])),
  };

  // 3. Drawdown status
  const drawdown = {};
  for (const tier of ["Premium", "A", "B"]) {
    drawdown[tier] = await computeDrawdownStatus(sb, tier);
  }

  // 4. Fetch users
  const chats = await resolveBroadcastChats(env, onlyChatId);
  if (chats.length === 0) {
    console.log("[morning] no connected users");
    return;
  }

  // 5. Build message
  const day = vnDayContext();
  let text = `☀️ *Sáng ${day.fullLabel}*\n\n`;
  if (!day.isTradingDay) {
    text += `🌴 _Hôm nay ${day.closedReason} — không có phiên giao dịch._\n\n`;
  }

  // Performance tuần qua
  if (recentTrades.length > 0) {
    const wins = recentTrades.filter((t) => t.is_win).length;
    const totalRet = recentTrades.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);
    const winRate = (wins / recentTrades.length) * 100;
    text += `📊 *Tuần qua* (${recentTrades.length} trade resolved):\n`;
    text += `  · Win ${winRate.toFixed(0)}% (${wins}/${recentTrades.length})\n`;
    text += `  · Cumulative ${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(2)}%\n\n`;
  } else {
    text += `📊 _Chưa có trade resolved trong tuần qua. App vẫn track signal._\n\n`;
  }

  // Drawdown warnings
  const pausedTiers = Object.entries(drawdown).filter(([_, d]) => d.isPaused);
  const warnTiers = Object.entries(drawdown).filter(([_, d]) => !d.isPaused && d.consecLosses >= 2);
  if (pausedTiers.length > 0) {
    text += `🚫 *Drawdown alert*: `;
    text += pausedTiers.map(([t, d]) => `${t} PAUSED đến ${d.pausedUntil}`).join(", ") + "\n\n";
  } else if (warnTiers.length > 0) {
    text += `⚠️ *Drawdown warn*: `;
    text += warnTiers.map(([t, d]) => `${t} ${d.consecLosses}/3 losses`).join(", ") + "\n\n";
  }

  // Active picks countdown
  if (activePicks.length > 0) {
    text += `💼 *Lệnh đang mở* (${activePicks.length} mã):\n`;
    for (const p of activePicks) {
      // Đếm phiên thật (bỏ T7/CN + lễ) thay vì áng chừng daysHeld × 5/7
      const tradingDays = vnTradingDaysBetween(p.signal_date, day.dateStr);
      const maxHold = exitMaxHold(p);
      const remainingDays = Math.max(0, maxHold - tradingDays);
      const icon = TIER_ICONS[p.tier] ? `${TIER_ICONS[p.tier]} ` : "";
      const peak = peakByTable[pickTableFor(p.tier)].get(p.symbol);
      const peakTag = peak ? ` · peak ${parseFloat(peak).toFixed(2)}` : "";
      text += `  · ${icon}*${p.symbol}* (${p.tier}) — T+${tradingDays}/${maxHold}, còn ${remainingDays} phiên${peakTag}\n`;
    }
    text += `\n`;
  }

  // Đối soát sổ bot với danh mục thật. Sổ bot chấm mọi signal, mày chỉ mua một
  // phần — chỗ lệch này chính là phần hiệu suất thật khác hiệu suất /stats.
  try {
    const holdings = await loadHoldingsIndex(sb);
    const botSyms = [...new Set(openPositions.map((t) => t.symbol))];
    const mySyms = [...holdings.portfolio.keys()];
    const missing = botSyms.filter((sym) => !holdings.portfolio.has(sym));
    const extra = mySyms.filter((sym) => !botSyms.includes(sym));
    text += `📒 *Đối soát sổ*: bot mở ${botSyms.length} · mày cầm ${mySyms.length}\n`;
    if (missing.length > 0) text += `  · Bot có, danh mục chưa có: ${missing.join(", ")}\n`;
    if (extra.length > 0) text += `  · Mày cầm, không phải signal đang mở: ${extra.join(", ")}\n`;
    if (missing.length === 0 && extra.length === 0) text += `  · Khớp hết.\n`;
    text += `\n`;
  } catch (e) {
    console.warn("[morning] reconcile fail:", e.message);
  }

  // Today expectation — ngày nghỉ thì không hứa hẹn scan/alert
  text += `📅 *Hôm nay*:\n`;
  if (day.isTradingDay) {
    text += `  · Chờ EOD scan 14:50 cho signal mới\n`;
    text += `  · Intraday spike alerts mỗi 3 phút cho active picks\n`;
    text += `  · Check tab Hiệu suất trong app để xem equity curve\n`;
  } else {
    const nextSession = addVnTradingDays(day.dateStr, 1);
    text += `  · Chợ đóng cửa — không scan, không alert\n`;
    text += `  · Phiên kế tiếp: ${fmtVnDMY(nextSession)}\n`;
  }
  if (day.upcomingHoliday) {
    const h = day.upcomingHoliday;
    text += `  · 🎉 Sắp nghỉ ${h.name} (${fmtVnDMY(h.date)}, còn ${h.daysAway} ngày)\n`;
  }

  // Tử vi lướt sóng (cho vui, cuối briefing)
  try {
    const horo = await buildHoroscope(env);
    if (horo) text += `\n━━━━━━━━━━━━━━━\n🔮 *Tử vi lướt sóng hôm nay*\n${horo}\n\n_(bói cho vui thôi, tiền của bạn do bạn quyết 😄)_\n`;
  } catch (e) {
    console.warn("[morning] horoscope fail:", e.message);
  }

  let sent = 0;
  for (const chatId of chats) {
    try {
      const resp = await tgSendMessage(env.BOT_TOKEN, chatId, text);
      if (resp?.ok) sent++;
    } catch (e) {
      console.warn(`[morning] send fail ${chatId}:`, e.message);
    }
  }
  console.log(`[morning] briefing sent to ${sent}/${chats.length}`);
  await logHeartbeat(env, "morning-sent", { sent, total: chats.length });
}

// Forward-test Elite: replay detector + exit rules lên OHLCV thật, 07/2025 → 08/2026.
// KHÔNG phải backtest gốc 7.4y — số này để so tương quan Elite vs Climax ngoài regime.
const ELITE_FWD_STATS = { trades: 18, winPct: 56, avgPct: 0.8, baseWinPct: 24, baseAvgPct: -5.3 };
// Split theo màu VNI phiên signal. In-sample, mẫu 9 vs 9 lệnh — chỉ cảnh báo, không lọc.
const ELITE_VNI_SPLIT = { greenWin: 67, greenAvg: 3.7, redWin: 44, redAvg: -2.1 };
const ELITE_RULE = "━━━━━━━━━━━━━━━━━━";

async function sendMarketDigest(env, precomputedResult = null, opts = {}) {
  const { onlyChatId = null, persist = true } = opts;
  let result;
  const freshScan = !precomputedResult;
  if (precomputedResult) {
    console.log(`[digest] using precomputed (full coverage ${precomputedResult.fullCoverage ? "yes" : "no"})`);
    result = precomputedResult;
  } else {
    console.log("[digest] scanning universe + market stats...");
    result = await scanAllSymbols();
    // Persist dời xuống sau khi tính xong VNI/health — trade_log cần context đó
  }
  const { matches, market, gainers, losers, topVol } = result;
  console.log(`[digest] ${matches.length} climax · ${market.upCount}↑/${market.downCount}↓ · avg ${market.avgChange.toFixed(2)}%`);

  // Fetch VN-Index để có index data + market health (MA20/MA50 cần ≥50 phiên)
  let vniInfo = null;
  let vniCloses = null;
  try {
    const vni = await fetchVndHistory("VNINDEX", 100);
    vniCloses = vni.closes;
    const n = vni.closes.length;
    if (n >= 2) {
      const cur = vni.closes[n - 1];
      const prev = vni.closes[n - 2];
      vniInfo = {
        cur,
        change: ((cur - prev) / prev) * 100,
        vol: vni.volumes[n - 1],
      };
    }
  } catch (e) {
    console.warn("[digest] VN-Index fetch fail:", e.message);
  }

  // Market health — phân biệt correction bounce-able vs falling-knife (breadth + VNI MA)
  const health = computeMarketHealth(vniCloses || [], market.upCount, market.downCount);
  const weakFlag = health.level === "weak" ? " ⚠️" : "";
  console.log(`[digest] market health=${health.level} breadth=${market.upCount}↑/${market.downCount}↓`);

  // Quét fresh (chunked scan đã persist trong finalizeScan) — persist ở đây để
  // trade_log kèm được context regime/VNI/breadth vừa tính xong.
  // persist=false khi gõ tay giữa phiên: giá chưa chốt, ghi vào là bẩn trade_log.
  if (freshScan && persist) {
    const signalCtx = buildSignalContext(result, vniInfo, health);
    await persistClimaxMatches(env, result.matches, signalCtx);
    await persistMomentumMatches(env, result.momentumMatches || [], signalCtx);
  }

  // Fetch all connected users
  const sb = sbClient(env);
  const chats = await resolveBroadcastChats(env, onlyChatId);
  if (chats.length === 0) {
    console.log("[digest] no connected users");
    return;
  }

  // Mã bắn lại khi lệnh cũ chưa chốt không được dropSymbolsAlreadyOpen mở vị thế
  // mới → in dòng MUA là dắt user vào một lệnh sổ bot không chấm.
  const signalDate = lastVnTradingDay();
  const openBefore = new Map(
    (await loadOpenPositions(sb))
      .filter((t) => t.signal_date !== signalDate)
      .map((t) => [t.symbol, t])
  );
  const alreadyOpenLine = (sym, indent) => {
    const t = openBefore.get(sym);
    return t
      ? `${indent}⏸ Đang mở từ ${fmtVnDM(t.signal_date)} (${t.tier}) — sổ bot không mở lệnh mới, không mua thêm\n`
      : null;
  };

  // ── Compose comprehensive market digest ──
  function fmtBn(n) {
    return (n / 1e9).toFixed(0);
  }

  const day = vnDayContext();
  // Label phiên T+n theo phiên giao dịch thật (bỏ T7/CN + lễ)
  const tLabel = (n) => fmtVnDM(addVnTradingDays(day.dateStr, n));

  let text = `📊 *Tổng kết phiên ${day.fullLabel}*\n\n`;

  // ── Market verdict lên đầu: "có nên giao dịch không" > "mua mã nào" ──
  const verdictLine = health.level === "weak"
    ? `🔴 *Hạn chế bắt đáy* — thị trường yếu, ưu tiên giữ tiền / chờ phiên xác nhận lực bán suy yếu.`
    : health.level === "caution"
    ? `🟡 *Thận trọng* — vào nhỏ, ưu tiên mã khỏe nhất (NN mua ròng).`
    : `🟢 *Điều kiện bắt đáy chấp nhận được* — theo tín hiệu, tuân thủ size + SL.`;
  const isEliteRegime = result.isEliteRegime;
  const premiumMatches = matches.filter((m) => m.is_premium);
  const tierA = matches.filter((m) => m.tier === "A" && !m.is_premium);
  const tierB = matches.filter((m) => m.tier === "B" && !m.is_premium);

  text += `🚦 *Giao dịch hôm nay?*\n${verdictLine}\n`;
  if (health.banner) text += `\n${health.banner}`;  // banner luôn kết thúc bằng blank line
  // Elite block ngay dưới tự mở khung → khỏi kẻ 2 vạch liền nhau
  if (!isEliteRegime) text += `━━━━━━━━━━━━━━━\n\n`;
  else if (!health.banner) text += `\n`;

  // ── ⚡ ELITE lên đầu ──
  // Regime hiếm + edge cao hơn hẳn Climax thường → đọc phát thấy ngay, không phải scroll.
  // Premium ưu tiên lên trước trong list (khỏi bị cắt bởi slice) và skip section riêng ở dưới.
  const eliteShow = isEliteRegime
    ? [...premiumMatches, ...matches.filter((m) => !m.is_premium)].slice(0, 5)
    : [];
  if (isEliteRegime) {
    const f = ELITE_FWD_STATS;
    text += `${ELITE_RULE}\n`;
    text += matches.length > 0
      ? `⚡ *ELITE — ${matches.length} MÃ HÔM NAY* ⚡\n`
      : `⚡ *ELITE REGIME ACTIVE* ⚡\n`;
    text += `${ELITE_RULE}\n`;
    if (result.vniRet20 != null) {
      text += `_VN-Index 20 phiên ${result.vniRet20.toFixed(1)}% → correction._\n`;
    }
    text += `_Forward ${f.trades} lệnh: win ${f.winPct}% · +${f.avgPct}%/lệnh_\n`;
    text += `_(Climax ngoài regime: win ${f.baseWinPct}% · ${f.baseAvgPct}%/lệnh)_\n`;
    // Cảnh báo màu VNI: rule in-sample nên chỉ nhắc, vẫn hiện đủ mã để user tự quyết
    if (vniInfo && vniInfo.change < 0) {
      const s = ELITE_VNI_SPLIT;
      text += `\n⚠️ _VNI phiên nay đỏ. Elite vào phiên đỏ: win ${s.redWin}% · ${s.redAvg}%/lệnh — so với phiên xanh win ${s.greenWin}% · +${s.greenAvg}%. Cân nhắc chờ phiên xanh._\n`;
    }

    if (matches.length === 0) {
      text += `\n📭 Không có mã Elite hôm nay.\n`;
    } else {
      const t1Label = tLabel(1);
      for (const m of eliteShow) {
        const cur = m.currentPrice;
        const entryMax = cur * 1.02;
        const entryMid = (entryMax + cur * 0.99) / 2;
        const sl = entryMid * 0.92;
        const target = entryMid * 1.03;
        const icon = m.is_premium ? "💎" : "⚡";
        const nnTag = m.is_premium && m.nn_net_5d_bn != null ? ` · NN +${m.nn_net_5d_bn}B/5d` : "";
        text += `\n${icon} *${m.symbol}* @ ${cur.toFixed(2)}${weakFlag}\n`;
        text += `   3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)}${nnTag}\n`;
        const openLine = alreadyOpenLine(m.symbol, "   ");
        if (openLine) {
          text += openLine;
        } else if (health.level === "weak") {
          text += `   ⏸ WATCHLIST — chờ VNI xanh + đóng gần high + breadth>1\n`;
          text += `   🟢 rồi MUA ≤ ${entryMax.toFixed(2)} · 🔴 CẮT < ${sl.toFixed(2)}\n`;
        } else {
          text += `   🟢 MUA ${t1Label} ≤ ${entryMax.toFixed(2)}\n`;
          text += `   🔴 CẮT < ${sl.toFixed(2)}\n`;
          text += `   🎯 BÁN T+3→T+5 ≥ ${target.toFixed(2)} (+3%)\n`;
        }
      }
      if (matches.length > eliteShow.length) {
        text += `\n_+${matches.length - eliteShow.length} mã Elite khác — mở app để xem đủ._\n`;
      }
      text += premiumMatches.length > 0
        ? `\n💰 Size: 20% NAV/💎 Premium · 18% NAV/⚡ Elite. Max 2-3 lệnh.\n`
        : `\n💰 Size: 18% NAV/lệnh. Max 2-3 lệnh đồng thời.\n`;
    }
    text += `${ELITE_RULE}\n\n`;
  }

  // VN-Index
  if (vniInfo) {
    const arrow = vniInfo.change >= 0 ? "🟢" : "🔴";
    const sign = vniInfo.change >= 0 ? "+" : "";
    text += `${arrow} *VN-Index*: ${vniInfo.cur.toFixed(2)} (${sign}${vniInfo.change.toFixed(2)}%)\n\n`;
  }

  // Market breadth
  const breadthArrow = market.upCount > market.downCount ? "🟢" : "🔴";
  text += `*Breadth* (${market.totalScanned} mã Large+Mid):\n`;
  text += `  ${breadthArrow} ${market.upCount}↑ / ${market.downCount}↓ · avg ${market.avgChange >= 0 ? "+" : ""}${market.avgChange.toFixed(2)}%\n`;
  text += `  💧 Thanh khoản: ${fmtBn(market.totalTurnover)} tỷ\n\n`;

  // Top gainers/losers/vol — skip nếu chunked scan (không track per-mã top5)
  if (gainers && gainers.length > 0) {
    text += `🟢 *Top 5 tăng*:\n`;
    for (const g of gainers) {
      text += `  ${g.symbol}  +${g.stats.changePct.toFixed(1)}% @ ${g.stats.cur.toFixed(2)}\n`;
    }
    text += `\n🔴 *Top 5 giảm*:\n`;
    for (const l of losers) {
      text += `  ${l.symbol}  ${l.stats.changePct.toFixed(1)}% @ ${l.stats.cur.toFixed(2)}\n`;
    }
    text += `\n💧 *Top thanh khoản*:\n`;
    for (const t of topVol) {
      const sign = t.stats.changePct >= 0 ? "+" : "";
      text += `  ${t.symbol}  ${fmtBn(t.stats.turnover)}tỷ (${sign}${t.stats.changePct.toFixed(1)}%)\n`;
    }
  } else if (result.fullCoverage) {
    text += `🌐 *Full coverage scan*: ${market.totalScanned} mã HOSE+HNX+UPCOM\n`;
    text += `_(Top gainers/losers skip để fit Cloudflare free tier limits)_\n`;
  }

  // Banner bull — correction/Elite đã lên đầu message
  if (result.vniRegime === "bull" && result.vniRet20 != null) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `🐂 _VN-Index bull (+${result.vniRet20.toFixed(1)}% 20p) — Climax edge thấp hơn correction regime._\n`;
  }

  // 💎 Premium section (NN net buy confirmed, Sharpe 1.90 vs base 0.36)
  // Elite regime: premium đã nằm trong khối Elite đầu message → khỏi in lại
  if (premiumMatches.length > 0 && !isEliteRegime) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `💎 *Premium picks* (${premiumMatches.length}) — Climax + NN net mua\n`;
    text += `_Backtest 7.4y: Win 61%, Sharpe 1.90 vs Tier A base Sharpe 0.36._\n`;
    text += `_Khác Elite: Premium = Climax + NN mua ròng 5d xác nhận; Elite = Climax khi VNI correction (chưa cần NN)._\n\n`;
    const t1Label = tLabel(1);
    for (const m of premiumMatches.slice(0, 5)) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const target = cur * 1.03 * 0.995;
      const sl = cur * 0.92;
      const nnTag = m.nn_net_5d_bn != null ? `NN +${m.nn_net_5d_bn}B/5d` : "";
      text += `💎 *${m.symbol}*${weakFlag} @ ${cur.toFixed(2)} · 3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)} · ${nnTag} · _hist Win 61%_\n`;
      const openLine = alreadyOpenLine(m.symbol, "  ");
      if (openLine) {
        text += `${openLine}\n`;
      } else if (health.level === "weak") {
        text += `  ⏸ WATCHLIST — chờ: VNI xanh + đóng gần high + breadth>1, rồi MUA ≤ ${entryMax.toFixed(2)} (SL < ${sl.toFixed(2)})\n\n`;
      } else {
        text += `  MUA ${t1Label} ≤ ${entryMax.toFixed(2)} · SL < ${sl.toFixed(2)} · TP T+3→T+5 ${target.toFixed(2)} (+3%)\n\n`;
      }
    }
    text += `💰 *Size khuyến nghị Premium*: 20% NAV/lệnh (Kelly-adjusted, Sharpe 1.90 justifies bigger size)\n`;
  }

  text += `\n━━━━━━━━━━━━━━━\n`;
  text += `🔻 *Bắt đáy T+ (Vol Climax Bounce)*\n`;
  const eliteRendered = isEliteRegime && matches.length > 0;
  if (eliteRendered) {
    text += `⚡ ${matches.length} Tier Elite — _xem khối ⚡ đầu message._\n`;
  } else if (!isEliteRegime) {
    text += `${premiumMatches.length} Premium · ${tierA.length} Tier A · ${tierB.length} Tier B\n`;
  }

  if (eliteRendered) {
    // đã render đầu message
  } else if (matches.length === 0) {
    text += `\n📭 Không có signal hôm nay.\n`;
    text += `Pattern hiếm ~80-95/năm = ~2 lệnh/tuần avg.\n`;
  } else {
    text += `\n`;
    const t1Label = tLabel(1);
    const t3Label = tLabel(4);  // entry + 3 phiên
    const t5Label = tLabel(6);

    const showMatches = [...tierA.slice(0, 3), ...tierB.slice(0, 3)].slice(0, 5);
    for (const m of showMatches) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const entryMid = (entryMax + cur * 0.99) / 2;
      const sl = entryMid * 0.92;
      const target = entryMid * 1.03;

      const tierTag = (m.tier === "A" ? "🟢 A" : "🔵 B") + weakFlag;
      const hist = m.tier === "A" ? "hist Win 59%" : "edge vừa";
      text += `${tierTag} *${m.symbol}* @ ${cur.toFixed(2)} · 3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)} · _${hist}_\n`;
      const openLine = alreadyOpenLine(m.symbol, "  ");
      if (openLine) {
        text += `${openLine}\n`;
      } else if (health.level === "weak") {
        text += `  ⏸ WATCHLIST — chờ: VNI xanh + đóng gần high + breadth>1, rồi MUA ≤ ${entryMax.toFixed(2)} (CẮT < ${sl.toFixed(2)})\n\n`;
      } else {
        text += `  MUA ${t1Label} ≤ ${entryMax.toFixed(2)} · CẮT < ${sl.toFixed(2)} · BÁN T+3→T+5 target ${target.toFixed(2)} (+3%)\n\n`;
      }
    }
    text += `💰 Size: 15% NAV Tier A · 10% NAV Tier B. Max 2-3 lệnh.\n`;
  }

  // ── FBO (Foreign-Backed Oversold) section ──
  // FBO ghi thẳng vào climax_active_picks nên đẻ spike/exit alert y như Climax.
  // Không announce ở đây thì mã lạ tự nhiên nhảy ra trong alert vài phiên sau,
  // user không biết nó vào danh sách track từ lúc nào.
  const fboMatches = result.fboMatches || [];
  if (fboMatches.length > 0) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `🌊 *Bắt đáy FBO (oversold + NN mua)*\n`;
    text += `${fboMatches.length} mã rơi >5%/3 phiên + nến xanh + RSI<50 + NN mua ròng 5 phiên\n`;
    text += `_Test 2026: n=14, Win 71%, Sharpe +1.42, PF 1.61._\n\n`;
    for (const m of fboMatches.slice(0, 5)) {
      const cur = m.currentPrice;
      text += `🌊 *${m.symbol}* @ ${cur.toFixed(2)} · rơi ${Math.abs(m.ret3d).toFixed(1)}%/3 phiên · RSI ${m.rsi.toFixed(0)} · NN +${m.nn_net_5d_bn}B\n`;
      text += `  Target ${(cur * 1.03).toFixed(2)} (+3%) · SL ${(cur * 0.92).toFixed(2)} (-8%) · hold T+5\n\n`;
    }
    text += `⚠️ Sample nhỏ (n=14) — size nhỏ hơn Climax, coi như forward-test.\n`;
  }

  // Momentum Swing section (chỉ khi bull/neutral regime + có matches)
  const momentumMatches = result.momentumMatches || [];
  if (result.isMomentumRegime && momentumMatches.length > 0) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `🚀 *Momentum Swing (Tier Momentum)*\n`;
    text += `${momentumMatches.length} mã trend mạnh + consolidation + vol confirm\n`;
    text += `_Backtest 8.5y bull: Win 55%, Avg +3.5%, Sharpe 1.04, PF 2.44._\n\n`;
    const showMomentum = momentumMatches.slice(0, 3);
    for (const m of showMomentum) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const initSL = cur * 0.92;
      const expectedExit = cur * 1.035;
      text += `⚡ *${m.symbol}* @ ${cur.toFixed(2)} · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)}\n`;
      const openLine = alreadyOpenLine(m.symbol, "  ");
      text += openLine
        ? `${openLine}\n`
        : `  MUA ≤ ${entryMax.toFixed(2)} · init SL ${initSL.toFixed(2)} · trail 7% từ đỉnh\n` +
          `  Hold ~20 phiên · expected ~${expectedExit.toFixed(2)} (+3.5%)\n\n`;
    }
    text += `💰 Size: 12% NAV/Momentum (hold ~20 phiên trailing). Max 1-2 lệnh.\n`;
    text += `⚠️ Khi VNI chuyển correction → cắt sớm Momentum, switch sang Climax Elite.\n`;
  }

  // ── Mid-term (Base Breakout) section ──
  // Phase 1 verified: Test 2025-26 Sharpe +1.13, PF 2.82, Win 52%, avg +6.95%/trade.
  // App pivoted sang mid-term — focus pattern này, T+ swing dormant.
  const baseBreakoutMatches = result.baseBreakoutMatches || [];
  if (baseBreakoutMatches.length > 0) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `🔍 *Rà soát Trung hạn (Base Breakout)*\n`;
    text += `${baseBreakoutMatches.length} mã tích lũy ≥30 phiên + breakout + vol confirm\n`;
    text += `_Backtest Test 2025-26: Win 52%, Sharpe +1.13, PF 2.82, avg +6.95%/trade._\n\n`;
    const showMidTerm = baseBreakoutMatches.slice(0, 5);
    for (const m of showMidTerm) {
      const cur = m.currentPrice;
      const initSL = m.initSL;
      const breakStr = m.breakStrength ? `${m.breakStrength.toFixed(1)}%` : "?";
      text += `🔍 *${m.symbol}* @ ${cur.toFixed(2)} · break +${breakStr} above prev high · vol ${m.volRatio.toFixed(1)}×\n`;
      const openLine = alreadyOpenLine(m.symbol, "  ");
      text += openLine
        ? `${openLine}\n`
        : `  MUA ${tLabel(1)} ≤ ${(cur * 1.02).toFixed(2)} · Init SL ${initSL.toFixed(2)} (-10%) · trail 10% từ peak · hold tối đa T+30\n\n`;
    }
    text += `💰 Backtest sizing 10M VND/signal → +29.8%/năm trên 200M vốn.\n`;
    text += `⏰ Hold ~1 tháng calendar. Edge từ asymmetric R:R (Win 52% nhưng PF 2.82).\n`;
  }

  text += `\n_Update mỗi 14:50 EOD. Reload app để xem chi tiết._`;

  // Heartbeat trước khi send để xác nhận tới đoạn này
  await logHeartbeat(env, precomputedResult ? "digest-finalize" : "digest-quick", {
    matches: matches.length,
    momentum: (result.momentumMatches || []).length,
    vniRegime: result.vniRegime,
    chats: chats.length,
    fullCoverage: !!result.fullCoverage,
    text_length: text.length,
  });

  let sent = 0;
  const sendErrors = [];
  for (const chatId of chats) {
    try {
      const resp = await tgSendMessage(env.BOT_TOKEN, chatId, text);
      if (resp?.ok) {
        sent++;
      } else {
        sendErrors.push({ chatId, resp });
        console.warn(`[digest] send fail ${chatId}:`, JSON.stringify(resp));
      }
    } catch (e) {
      sendErrors.push({ chatId, error: e.message });
      console.warn(`[digest] send fail ${chatId}:`, e.message);
    }
  }
  console.log(`[digest] market digest sent to ${sent}/${chats.length} users`);
  // Log delivery result để verify lần sau
  await logHeartbeat(env, "digest-sent", {
    sent,
    total: chats.length,
    errors: sendErrors,
  });
}

// ── Market health cho climax alert ────────────────────────────────
// Climax = mean-reversion bắt oversold TRONG correction. Nhưng correction có
// 2 loại: bounce-able (breadth chưa sụp) vs falling-knife (breadth sập, mọi
// nhịp hồi bị bán ngược). Lớp này phân biệt để CẢNH BÁO, không chặn pick (giữ
// mềm — user tự quyết). breadth = up/down trên 35 mã Large+Mid của scan.
// Fail-open: thiếu VNI data hoặc breadth sample quá nhỏ → coi như "ok".
function computeMarketHealth(vniCloses, upCount, downCount) {
  const up = upCount || 0;
  const down = downCount || 0;
  const breadthRatio = up / Math.max(down, 1);
  const n = vniCloses?.length || 0;
  if (n < 50 || up + down < 5) {
    return { level: "ok", breadthRatio, banner: "" };
  }
  const cur = vniCloses[n - 1];
  const ma20 = vniCloses.slice(n - 20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = vniCloses.slice(n - 50).reduce((a, b) => a + b, 0) / 50;
  const aboveMa20 = cur >= ma20;
  const aboveMa50 = cur >= ma50;

  // WEAK (dao rơi): VNI thủng MA50 VÀ phe giảm áp đảo ~2:1
  // CAUTION (chớm yếu): dưới MA20 HOẶC breadth lệch
  const level = (!aboveMa50 && breadthRatio < 0.5) ? "weak"
              : (!aboveMa20 || breadthRatio < 0.6) ? "caution"
              : "ok";

  let banner = "";
  const breadthStr = `${up}↑/${down}↓`;
  if (level === "weak") {
    banner =
      `🔴 *Thị trường YẾU — cẩn thận dao rơi*\n` +
      `VNI ${cur.toFixed(1)} thủng MA50 (${ma50.toFixed(1)}) · breadth ${breadthStr}\n` +
      `Setup bắt đáy dưới đây rủi ro cao. Cân nhắc chờ 1 phiên xác nhận lực bán suy yếu (VNI hồi, đóng gần đỉnh ngày) trước khi vào.\n\n`;
  } else if (level === "caution") {
    const reason = !aboveMa20
      ? `VNI ${cur.toFixed(1)} dưới MA20 (${ma20.toFixed(1)})`
      : `breadth lệch ${breadthStr}`;
    banner =
      `🟡 *Thị trường chớm yếu* — ${reason}\n` +
      `Vào nhỏ, ưu tiên mã NN mua ròng.\n\n`;
  }
  return { level, breadthRatio, cur, ma20, ma50, aboveMa20, aboveMa50, banner };
}

async function sendClimaxAlerts(env) {
  console.log("[climax] scanning universe...");
  const matches = await scanVolClimaxMatches();
  console.log(`[climax] ${matches.length} matches found`);

  // Fetch all connected users (luôn gửi EOD tổng kết, kể cả 0 matches)
  const sb = sbClient(env);
  const users = await sbQuery(sb, "user_telegram", {
    select: "chat_id",
  });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (chats.length === 0) {
    console.log("[climax] no connected users");
    return;
  }

  // 0 matches → gửi empty digest (user biết app alive + không có signal)
  if (matches.length === 0) {
    const emptyText = `🔻 *Bắt đáy T+ — ${vnDayContext().fullLabel}*\n\n` +
      `📭 *Không có signal hôm nay* (cả Tier A + Tier B đều rỗng).\n\n` +
      `Đã scan ${VOL_CLIMAX_UNIVERSE.length} mã Large+Mid cap. Không mã nào match pattern:\n` +
      `• Tier A: drop >7% + vol >2× + RSI <35\n` +
      `• Tier B: drop >5% + vol >2× + RSI <50\n\n` +
      `Pattern hiếm ~80-95/năm = ~2 lệnh/tuần avg. Đừng FOMO.\n` +
      `Ngày mai 14:50 sẽ scan tiếp.`;

    let sent = 0;
    for (const chatId of chats) {
      try {
        await tgSendMessage(env.BOT_TOKEN, chatId, emptyText);
        sent++;
      } catch (e) {
        console.warn(`[climax] empty digest fail ${chatId}:`, e.message);
      }
    }
    console.log(`[climax] empty digest sent to ${sent}/${chats.length} users`);
    return;
  }

  // Compose message — 3 phần MUA/CẮT/BÁN cho mỗi mã (actionable)
  const day = vnDayContext();
  const todayLabel = day.fullLabel;
  // T+ convention VN: T+0 = entry day (mua T+1 sau signal)
  // T+1 = next trading day = entry day. T+3, T+4, T+5 = 3, 4, 5 phiên sau
  const t1Label = fmtVnDM(addVnTradingDays(day.dateStr, 1));
  const t3Label = fmtVnDM(addVnTradingDays(day.dateStr, 4)); // entry + 3 phiên
  const t4Label = fmtVnDM(addVnTradingDays(day.dateStr, 5));
  const t5Label = fmtVnDM(addVnTradingDays(day.dateStr, 6));

  // Split tiers
  const tierA = matches.filter((m) => m.tier === "A");
  const tierB = matches.filter((m) => m.tier === "B");

  let text = `🔻 *Bắt đáy T+ — ${todayLabel}*\n`;
  text += `*${tierA.length}* Tier A (Edge cao) · *${tierB.length}* Tier B (Edge vừa)\n\n`;

  // Show Tier A first (priority), then Tier B
  const showMatches = [...tierA.slice(0, 3), ...tierB.slice(0, 3)];
  for (const m of showMatches.slice(0, 5)) {
    const cur = m.currentPrice;
    const entryMax = cur * 1.02;
    const entryMin = cur * 0.99;
    const entryMid = (entryMax + entryMin) / 2;
    const sl = entryMid * 0.92; // -8% close-based (backtest: -4% intraday destroy edge)
    const target = entryMid * 1.03; // +3% early exit threshold

    const tierTag = m.tier === "A" ? "🟢 Tier A" : "🔵 Tier B";
    text += `━━━━━━━━━━━━━━━\n`;
    text += `${tierTag} · *${m.symbol}*  @ ${cur.toFixed(2)}\n`;
    text += `📉 3p: ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)}\n\n`;

    text += `🟢 *MUA ${t1Label}*\n`;
    text += `   Limit ≤ *${entryMax.toFixed(2)}* (cap +2% gap)\n\n`;

    text += `🔴 *CẮT nếu close < ${sl.toFixed(2)}*\n`;
    text += `   (-8% close-only, KHÔNG cắt intraday)\n\n`;

    text += `🟢 *BÁN T+3 → T+5 ATC*\n`;
    text += `   Target *${target.toFixed(2)}* (+3%)\n`;
    text += `   ${t3Label}: ATC nếu ≥ target\n`;
    text += `   ${t4Label}: ATC nếu ≥ target\n`;
    text += `   ${t5Label}: ATC force\n\n`;
  }

  if (matches.length > 3) {
    text += `━━━━━━━━━━━━━━━\n`;
    text += `_+${matches.length - 3} mã khác trong app_\n\n`;
  }

  text += `💰 Size: 15% NAV/lệnh, max 2-3 lệnh\n`;
  text += `⚠️ Backtest 8.5y dynamic exit: Win 60-63%, Avg +1%/lệnh. Vẫn có 3-4/10 thua.`;

  let sent = 0;
  for (const chatId of chats) {
    try {
      await tgSendMessage(env.BOT_TOKEN, chatId, text);
      sent++;
    } catch (e) {
      console.warn(`[climax] send fail ${chatId}:`, e.message);
    }
  }
  console.log(`[climax] alerts sent to ${sent}/${chats.length} users`);
}

// ── VNDirect data fetch ─────────────────────────────────

async function fetchVndHistory(symbol, days = 5) {
  const to = Math.floor(Date.now() / 1000);
  // days = ngày LỊCH chứ không phải số nến. 220 chỉ trả ~150 nến (trừ cuối tuần
  // + lễ Tết) — dưới ngưỡng 200 mà detectStrengthContinuation và
  // detectBaseBreakout đòi, nên hai detector đó null vĩnh viễn. Cần N nến thì
  // xin ~N × 1.45.
  const from = to - days * 24 * 3600;
  const url = `${VND_HISTORY_URL}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`;
  // VND blocks Cloudflare Worker default fetch (no UA, custom origin) → 403.
  // Giả browser headers cho qua. dchart endpoint chính là widget chart VNDirect.
  const res = await fetch(url, { headers: VND_CHART_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) throw new Error("no data");
  return {
    times: data.t,
    opens: data.o,
    highs: data.h,
    lows: data.l,
    closes: data.c,
    volumes: data.v,
  };
}

// ── Foreign flow (NN net buy/sell) ───────────────────
// API: VND finfo trả về net buy/sell per day. Schema từ ranking.js fetchForeignDaily.
async function fetchForeignDaily(symbol, daysBack = 7) {
  const toDate = new Date().toISOString().split("T")[0];
  const fromDate = new Date(Date.now() - daysBack * 24 * 3600 * 1000)
    .toISOString().split("T")[0];
  const url = `https://api-finfo.vndirect.com.vn/v4/foreigns?q=code:${symbol}~tradingDate:gte:${fromDate}~tradingDate:lte:${toDate}&size=200&sort=tradingDate:asc`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json.data || [];
}

function computeNnNet5d(foreign) {
  if (!foreign || foreign.length === 0) return null;
  // Schema: each entry có { tradingDate, code, buyVal, sellVal, netVal, ... }
  // netVal đơn vị: VND. Lấy 5 ngày gần nhất sum.
  const sorted = [...foreign].sort((a, b) =>
    new Date(b.tradingDate).getTime() - new Date(a.tradingDate).getTime()
  );
  const last5 = sorted.slice(0, 5);
  if (last5.length === 0) return null;
  return last5.reduce((sum, x) => sum + (x.netVal || 0), 0);
}

// ── Telegram callback_query (inline button tap) ──────────
async function handleCallbackQuery(cq, env) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";
  const cqId = cq.id;

  // Answer callback to remove loading state on button
  const answerUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  const sendAnswer = (text = "") => fetch(answerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cqId, text }),
  }).catch(() => {});

  if (data.startsWith("dismiss:")) {
    const symbol = data.slice(8);
    if (!symbol || !chatId) {
      await sendAnswer("Invalid request");
      return new Response("ok");
    }
    // Find user by chat_id, then dismiss watch
    const sb = sbClient(env);
    const userRows = await sbQuery(sb, "user_telegram", {
      select: "user_id",
      eq: { chat_id: chatId },
    });
    if (!userRows || userRows.length === 0) {
      await sendAnswer("Chưa kết nối Telegram");
      return new Response("ok");
    }
    const userId = userRows[0].user_id;
    const updated = await sbUpdate(sb, "tplus_watches", {
      eq: { user_id: userId, symbol },
      data: { dismissed_by_user: true },
    });
    if (updated) {
      await sendAnswer(`✓ Đã bỏ ${symbol}`);
      await tgSendMessage(env.BOT_TOKEN, chatId, `✅ Đã bỏ theo dõi *${symbol}*. Có thể subscribe lại từ app.`);
    } else {
      await sendAnswer("Lỗi update DB");
    }
    return new Response("ok");
  }

  await sendAnswer("Unknown action");
  return new Response("ok");
}

// ── EOD Digest (14:50 VN) ──────────────────────────────
// Cuối phiên gửi summary tất cả active watches per user qua Telegram + inline
// buttons. Skip user nếu watch không có gì notable (0 met + chưa near-miss).

async function sendEodDigest(env, onlyChatId = null) {
  const sb = sbClient(env);

  // 1. Fetch all active watches (not dismissed)
  const watches = await sbQuery(sb, "tplus_watches", {
    select: "id,user_id,symbol,triggers,met_count,notified,notified_at",
    eq: { dismissed_by_user: false },
  });
  if (!watches || watches.length === 0) {
    console.log("[eod] no active watches");
    return;
  }

  // 2. Group watches by user
  const byUser = new Map();
  for (const w of watches) {
    if (!byUser.has(w.user_id)) byUser.set(w.user_id, []);
    byUser.get(w.user_id).push(w);
  }

  // 3. Fetch chat_ids
  const userIds = [...byUser.keys()];
  const users = await sbQuery(sb, "user_telegram", {
    select: "user_id,chat_id",
    in: { user_id: userIds },
  });
  const chatByUser = new Map();
  for (const u of users || []) {
    if (u.chat_id) chatByUser.set(u.user_id, u.chat_id);
  }

  // 4. Fetch today's price data cho mọi unique symbol
  const symbols = [...new Set(watches.map((w) => w.symbol))];
  const priceData = {};
  for (const sym of symbols) {
    try {
      priceData[sym] = await fetchVndHistory(sym, 5);
    } catch (e) {
      console.warn(`[eod] VND fetch ${sym} fail:`, e.message);
    }
  }

  // 5. Compose + send digest per user
  let sent = 0;
  for (const [userId, userWatches] of byUser.entries()) {
    const chatId = chatByUser.get(userId);
    // Telegram-connected users mới nhận digest qua bot. In-app digest sẽ
    // handled bằng cách store summary trong Supabase + frontend đọc lên.
    if (!chatId) continue;
    if (onlyChatId && String(chatId) !== String(onlyChatId)) continue;

    // Compose digest content
    const met = [];   // {symbol, metCount, reasons}
    const pending = [];
    const failed = []; // setup fail signals
    for (const w of userWatches) {
      const data = priceData[w.symbol];
      if (!data) continue;
      const cur = data.closes[data.closes.length - 1];
      const curVol = data.volumes[data.volumes.length - 1];
      const curOpen = data.opens[data.opens.length - 1];
      const prevClose = data.closes[data.closes.length - 2];
      const dayChange = prevClose ? ((cur - prevClose) / prevClose) * 100 : 0;

      let t = w.triggers || {};
      if (typeof t === "string") {
        try { t = JSON.parse(t); } catch { t = {}; }
      }

      const reasons = [];
      let metCount = 0;
      if (t.closeAbove && cur >= t.closeAbove) { metCount++; reasons.push("close ✓"); }
      if (t.volAbove && curVol >= t.volAbove) { metCount++; reasons.push("vol ✓"); }
      if (t.gapAbove && curOpen > t.gapAbove) { metCount++; reasons.push("gap ✓"); }

      // Setup fail: day giảm mạnh (-3%+) kèm vol cao
      const setupFail = dayChange <= -3 && t.volAbove && curVol >= t.volAbove;

      if (setupFail) {
        failed.push({ symbol: w.symbol, dayChange, reason: "rơi -3%+ kèm vol cao (distribution)" });
      } else if (metCount > 0) {
        met.push({ symbol: w.symbol, metCount, reasons: reasons.join(", ") });
      } else {
        pending.push({ symbol: w.symbol, dayChange });
      }
    }

    // Skip nếu không có gì notable (no met + no failed)
    if (met.length === 0 && failed.length === 0) {
      console.log(`[eod] skip user ${userId}: nothing notable`);
      continue;
    }

    // Build message
    let text = `📊 *EOD ${vnDayContext().fullLabel}*\n\n`;
    if (met.length > 0) {
      text += `🎯 *Met today (${met.length} mã):*\n`;
      for (const m of met) {
        text += `• ${m.symbol} *${m.metCount}/3* — ${m.reasons}\n`;
      }
      text += "\n";
    }
    if (failed.length > 0) {
      text += `⚠️ *Setup fail (${failed.length} mã):*\n`;
      for (const f of failed) {
        text += `• ${f.symbol} ${f.dayChange.toFixed(1)}% — ${f.reason}\n`;
      }
      text += "\n";
    }
    if (pending.length > 0) {
      text += `⏳ Pending: ${pending.map((p) => p.symbol).join(", ")}\n\n`;
    }
    text += `📅 Total ${userWatches.length} watches active. Mở app để xem plan chi tiết.`;

    // Inline buttons: bỏ theo dõi mỗi mã met/failed
    const dismissButtons = [...met, ...failed].slice(0, 6).map((x) => [
      { text: `✕ Bỏ ${x.symbol}`, callback_data: `dismiss:${x.symbol}` },
    ]);
    const keyboard = dismissButtons.length > 0 ? { inline_keyboard: dismissButtons } : null;

    await tgSendMessage(env.BOT_TOKEN, chatId, text, "Markdown", keyboard);
    sent++;
  }

  console.log(`[eod] sent ${sent}/${byUser.size} digests`);
}

// ── Supabase REST helpers (service_role key bypass RLS) ──

function sbClient(env) {
  return {
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function sbQuery(sb, table, opts = {}) {
  const params = new URLSearchParams();
  if (opts.select) params.set("select", opts.select);
  if (opts.eq) {
    for (const [k, v] of Object.entries(opts.eq)) {
      params.append(k, `eq.${v}`);
    }
  }
  if (opts.in) {
    for (const [k, v] of Object.entries(opts.in)) {
      params.append(k, `in.(${v.join(",")})`);
    }
  }
  const url = `${sb.url}/rest/v1/${table}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      apikey: sb.key,
      authorization: `Bearer ${sb.key}`,
    },
  });
  if (!res.ok) {
    console.warn(`[sb] query ${table} failed:`, res.status, await res.text());
    return null;
  }
  return res.json();
}

async function sbUpdate(sb, table, opts) {
  const params = new URLSearchParams();
  if (opts.eq) {
    for (const [k, v] of Object.entries(opts.eq)) {
      params.append(k, `eq.${v}`);
    }
  }
  // Gộp nhiều row vào 1 PATCH — tiết kiệm ngân sách subrequest của Worker.
  if (opts.in) {
    for (const [k, v] of Object.entries(opts.in)) {
      params.append(k, `in.(${v.join(",")})`);
    }
  }
  const url = `${sb.url}/rest/v1/${table}?${params.toString()}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: sb.key,
      authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(opts.data),
  });
  if (!res.ok) {
    console.warn(`[sb] update ${table} failed:`, res.status, await res.text());
    return false;
  }
  return true;
}

async function sbUpsert(sb, table, rows, onConflict) {
  const params = new URLSearchParams();
  if (onConflict) params.set("on_conflict", onConflict);
  const url = `${sb.url}/rest/v1/${table}?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: sb.key,
      authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  if (!res.ok) {
    console.warn(`[sb] upsert ${table} failed:`, res.status, await res.text());
    return false;
  }
  return true;
}

async function sbDelete(sb, table, opts) {
  const params = new URLSearchParams();
  if (opts.lt) {
    for (const [k, v] of Object.entries(opts.lt)) params.append(k, `lt.${v}`);
  }
  if (opts.eq) {
    for (const [k, v] of Object.entries(opts.eq)) params.append(k, `eq.${v}`);
  }
  if (opts.notIn) {
    for (const [k, v] of Object.entries(opts.notIn)) {
      params.append(k, `not.in.(${v.join(",")})`);
    }
  }
  const url = `${sb.url}/rest/v1/${table}?${params.toString()}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: sb.key,
      authorization: `Bearer ${sb.key}`,
      Prefer: "return=minimal",
    },
  });
  if (!res.ok) {
    console.warn(`[sb] delete ${table} failed:`, res.status, await res.text());
    return false;
  }
  return true;
}

// C1 Drawdown circuit breaker: count consecutive losses per tier.
// Premium 3 losses → pause 5 trading days (prevent emotional spiral).
const DRAWDOWN_THRESHOLD = 3;
const DRAWDOWN_COOLDOWN_TRADING_DAYS = 5;

async function computeDrawdownStatus(sb, tier) {
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=symbol,signal_date,is_win,net_ret&tier=eq.${tier}&resolved_at=not.is.null&order=signal_date.desc&limit=10`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) {
    return { tier, consecLosses: 0, isPaused: false, pausedUntil: null, recent: 0 };
  }
  const trades = await r.json();
  // Count consecutive losses from most recent
  let consec = 0;
  for (const t of trades) {
    if (t.is_win === false) consec++;
    else break;
  }
  const isPaused = consec >= DRAWDOWN_THRESHOLD;
  let pausedUntil = null;
  if (isPaused && trades.length > 0) {
    // Cooldown tính theo phiên thật (bỏ cả lễ), không chỉ bỏ T7/CN
    pausedUntil = addVnTradingDays(trades[0].signal_date, DRAWDOWN_COOLDOWN_TRADING_DAYS);
    // Re-check: if today already past pausedUntil, not paused anymore
    const today = vnDateString();
    if (today > pausedUntil) {
      return { tier, consecLosses: consec, isPaused: false, pausedUntil: null, recent: trades.length };
    }
  }
  return { tier, consecLosses: consec, isPaused, pausedUntil, recent: trades.length };
}

async function logHeartbeat(env, cronName, detail = {}) {
  try {
    const sb = sbClient(env);
    const url = `${sb.url}/rest/v1/cron_heartbeat`;
    await fetch(url, {
      method: "POST",
      headers: {
        apikey: sb.key,
        authorization: `Bearer ${sb.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ cron_name: cronName, detail }),
    });
  } catch (e) {
    console.warn("[heartbeat] log fail:", e.message);
  }
}

// ── AI analysis (Gemini Flash 2.0) ─────────────────────────────────────
// Two modes:
//   explain  — diễn giải TA (rule-based output từ tab Kỹ thuật) bằng tiếng Việt
//   research — explain + Google Search grounding cho fundamental, news 30d, phốt
//
// Cache: Cloudflare Cache API, key = mode+symbol+vn-date → 1 call/ngày/mã.
// Free tier Gemini Flash: 1500/day non-grounded + 500/day grounded.

// 2.5-flash-lite: rẻ nhất trong họ flash (input $0.10/1M, output $0.40/1M),
// vẫn support Google Search grounding cho research mode.
// $1 prepay credit ≈ 1700 request. Đủ xài nhiều tháng.
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function vnDateKey() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 3600 * 1000);
  return vn.toISOString().slice(0, 10);
}

function aiJsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=86400",
    },
  });
}

async function handleAiExplain(request, env, ctx) {
  if (!env.GEMINI_API_KEY) {
    return aiJsonResp({ error: "GEMINI_API_KEY not configured" }, 503);
  }
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || !body.symbol || !body.ta) {
    return aiJsonResp({ error: "missing symbol or ta" }, 400);
  }
  const sym = String(body.symbol).toUpperCase();
  const date = vnDateKey();

  // Cache lookup
  const cache = caches.default;
  const cacheKey = new Request(`https://ai-cache.local/v2/explain/${sym}/${date}`, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const j = await hit.json();
    j.cached = true;
    return aiJsonResp(j);
  }

  const prompt = buildExplainPrompt(sym, body.ta);
  let result;
  try {
    result = await callGemini(env.GEMINI_API_KEY, prompt, { grounding: false });
  } catch (e) {
    return aiJsonResp({ error: `Gemini fail: ${e.message}` }, 502);
  }
  const out = { symbol: sym, mode: "explain", date, response: result.text, citations: [], cached: false };
  ctx.waitUntil(cache.put(cacheKey, aiJsonResp(out)));
  return aiJsonResp(out);
}

async function handleAiResearch(request, env, ctx) {
  if (!env.GEMINI_API_KEY) {
    return aiJsonResp({ error: "GEMINI_API_KEY not configured" }, 503);
  }
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || !body.symbol || !body.ta) {
    return aiJsonResp({ error: "missing symbol or ta" }, 400);
  }
  const sym = String(body.symbol).toUpperCase();
  const date = vnDateKey();

  const cache = caches.default;
  const cacheKey = new Request(`https://ai-cache.local/v3/research/${sym}/${date}`, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const j = await hit.json();
    j.cached = true;
    return aiJsonResp(j);
  }

  const prompt = buildResearchPrompt(sym, body.ta);
  let result;
  try {
    result = await callGemini(env.GEMINI_API_KEY, prompt, { grounding: true });
  } catch (e) {
    return aiJsonResp({ error: `Gemini fail: ${e.message}` }, 502);
  }
  const out = { symbol: sym, mode: "research", date, response: result.text, citations: result.citations, cached: false };
  ctx.waitUntil(cache.put(cacheKey, aiJsonResp(out)));
  return aiJsonResp(out);
}

function buildExplainPrompt(symbol, ta) {
  return `Mày là chuyên gia phân tích kỹ thuật chứng khoán Việt Nam, hỗ trợ swing trader T+ (giữ 3-10 phiên).

Diễn giải các chỉ báo dưới đây CHO RIÊNG mã ${symbol}. Output tiếng Việt thuần, ngắn gọn, dễ đọc cho người mới.

=== DỮ LIỆU TA (đã tính sẵn) ===
${JSON.stringify(ta, null, 2)}

=== YÊU CẦU ===
1. CHỈ diễn giải dữ liệu cho trong JSON. KHÔNG bịa thêm chỉ báo / số liệu.
2. Trả lời ≤ 350 chữ, format markdown đúng theo template dưới.
3. Tone: thân thiện, dùng "mày/tao" OK, hoặc "anh/chị" lịch sự — chọn nhất quán.
4. KHÔNG kết luận chắc chắn "sẽ tăng/giảm". Dùng "nhiều khả năng", "có xác suất".
5. Nếu signals mâu thuẫn → nói rõ "tín hiệu chưa thống nhất, nên đứng ngoài".

=== TEMPLATE ===
**📊 Tổng quan**
{1-2 câu — verdict + xu hướng chính}

**✅ Tín hiệu tích cực**
- {signal 1 + nghĩa thực tế là gì}
- {signal 2}

**⚠️ Rủi ro / cảnh báo**
- {signal tiêu cực hoặc lo ngại}

**🎯 Hành động đề xuất**
{2-3 câu — Mua/Giữ/Theo dõi/Tránh + entry/SL gợi ý NẾU setup OK. Nhắc đây là gợi ý, không phải lời khuyên đầu tư.}`;
}

function buildResearchPrompt(symbol, ta) {
  const today = vnDateKey();
  const d30Ago = new Date(Date.now() + 7 * 3600 * 1000 - 30 * 86400 * 1000)
    .toISOString().slice(0, 10);
  return `Mày là chuyên gia phân tích chứng khoán Việt Nam. Phân tích TOÀN DIỆN mã ${symbol} cho swing trader.

=== NGÀY HÔM NAY (Việt Nam) ===
${today}

=== TA (đã tính sẵn, chính xác) ===
${JSON.stringify(ta, null, 2)}

=== QUY TRÌNH ===
1. Tóm tắt TA (dùng data trên, KHÔNG bịa).
2. Google Search các nội dung sau:
   a) Sức khỏe tài chính ${symbol}: P/E, P/B, ROE, EPS, doanh thu, lợi nhuận Q gần nhất, tăng trưởng YoY.
   b) **Tin tức ${symbol} TỪ NGÀY ${d30Ago} ĐẾN NAY** (cửa sổ 30 ngày gần nhất).
   c) **Sự kiện sắp tới**: ĐHCĐ, chốt quyền cổ tức, công bố BCTC quý tới, phát hành thêm, niêm yết bổ sung, M&A đang chờ phê duyệt.
   d) **PHỐT/CỜ ĐỎ**: UBCKNN xử phạt, vi phạm CBTT, lãnh đạo bị bắt/từ chức, gian lận BCTC, kiểm toán ngoại trừ, bị cảnh báo/kiểm soát/đình chỉ giao dịch — **TRONG 90 NGÀY GẦN NHẤT THÔI**.

=== QUY TẮC CỰC QUAN TRỌNG ===
1. **HARD FILTER NEWS**: Trước khi đưa tin vào output, tự check ngày tin. Nếu ngày tin TRƯỚC ${d30Ago} → BỎ HOÀN TOÀN. Không bù tin cũ vào để cho có. Thà ghi "Chỉ tìm thấy 1 tin trong cửa sổ này" còn hơn report tin >30d.
2. **HARD FILTER PHỐT**: Phốt có ngày trước (today - 90d) → BỎ. Không lôi tin phạt cũ vào.
3. **Sự kiện sắp tới**: chỉ event chưa xảy ra hoặc xảy ra ≤7 ngày trước (vẫn còn relevant). Event >7d quá khứ → bỏ qua, không liệt kê.
4. Nếu cửa sổ thực sự trống → ghi rõ "Không có tin tức đáng chú ý trong 30 ngày qua" / "Không phát hiện cảnh báo nào trong 90 ngày qua" / "Chưa thấy sự kiện đáng chú ý sắp tới".
5. **KHÔNG bịa** fundamental/news/phốt. Mọi claim PHẢI có nguồn URL từ kết quả search.
6. Mỗi tin/phốt/event PHẢI ghi rõ NGÀY (dd/mm/yyyy) lên trước nội dung để dễ verify.
7. Tin chung thị trường (VN-Index, vĩ mô) KHÔNG liên quan riêng ${symbol} → BỎ. Chỉ tin/event đặc thù ${symbol}.

=== OUTPUT (tiếng Việt, ≤ 600 chữ, markdown) ===
**📊 TA tóm tắt**
{50 chữ — verdict + xu hướng + tín hiệu mạnh nhất}

**💰 Sức khỏe tài chính**
{P/E, P/B, ROE, EPS, doanh thu/LN Q gần nhất, growth YoY. Đánh giá "rẻ/đắt/hợp lý" so với ngành. Không tra được → ghi rõ.}

**📰 Tin tức 30 ngày gần đây** (từ ${d30Ago} đến ${today})
{2-3 tin trong cửa sổ này, mỗi tin 1 dòng + ngày dd/mm/yyyy + link. Nếu không có → ghi "Không có tin tức đáng chú ý trong 30 ngày qua".}

**📅 Sự kiện sắp tới**
{ĐHCĐ, chốt cổ tức, BCTC quý tới, các catalysts đã công bố. Nếu không có → ghi "Chưa thấy sự kiện đáng chú ý sắp tới".}

**🚨 Cờ đỏ / phốt** (90 ngày gần nhất)
{Nếu có trong 90 ngày: liệt kê + ngày + link. Không có → "Không phát hiện cảnh báo nào trong 90 ngày qua".}

**🎯 Hành động đề xuất**
{Kết luận tổng hợp: Mua/Giữ/Theo dõi/Tránh + lý do tổng hợp TA + fundamental + news + sự kiện. Entry/SL gợi ý nếu OK. Nhắc đây là phân tích tham khảo, không phải lời khuyên đầu tư.}`;
}

async function callGemini(apiKey, prompt, { grounding }) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const reqBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: grounding ? 1200 : 800,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };
  if (grounding) {
    reqBody.tools = [{ google_search: {} }];
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Gemini ${r.status}: ${errText.slice(0, 300)}`);
  }
  const data = await r.json();
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    throw new Error(`Empty response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const gm = cand?.groundingMetadata;
  const citations = (gm?.groundingChunks || [])
    .map((c) => ({ title: c.web?.title || "", uri: c.web?.uri || "" }))
    .filter((c) => c.uri);
  return { text, citations };
}
