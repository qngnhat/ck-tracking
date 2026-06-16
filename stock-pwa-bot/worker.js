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

// ── VN trading session + holidays ──
// KEEP IN SYNC với stock-pwa/app.js VN_HOLIDAYS. Update khi có lịch nghỉ chính thức.
const VN_HOLIDAYS = new Set([
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03",
  "2025-04-07",
  "2025-04-30", "2025-05-01",
  "2025-09-02",
  "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
  "2026-04-27",
  "2026-04-30", "2026-05-01",
  "2026-09-02",
  "2027-01-01",
  "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12",
  "2027-04-15",
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

// Actively trading right now? Mon-Fri 9:00-11:30 hoặc 13:00-14:45 VN time, skip holidays.
function isVnTradingNow(d = new Date()) {
  const vn = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const day = vn.getDay();
  if (day === 0 || day === 6) return false;
  if (isVnHoliday(vn)) return false;
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
      const txRows = (await sbQuery(sb, "transactions", { select: "symbol,side,quantity" })) || [];
      // Holdings = net qty per symbol (buy +, sell -), keep qty > 0.
      const net = {};
      for (const t of txRows) {
        const q = Number(t.quantity) || 0;
        net[t.symbol] = (net[t.symbol] || 0) + (t.side === "buy" ? q : -q);
      }
      const portfolio = Object.keys(net).filter((s) => net[s] > 1e-9).sort();
      const watchlist = [...new Set(wlRows.map((r) => r.symbol))].sort();
      return new Response(JSON.stringify({ portfolio, watchlist }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
            const data = await fetchVndHistory(sym, 220);
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
            const data = await fetchVndHistory(sym, 220);
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
        climax_partial: "[]",
        momentum_partial: "[]",
        base_breakout_partial: "[]",
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
      // Last 50 fires, newest first
      const r = await fetch(`${sb.url}/rest/v1/cron_heartbeat?select=*&order=fired_at.desc&limit=50`, {
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
    // - "*/3 2-7 * * 1-5" → intraday watch + spike alerts (mỗi 3 min trong phiên)
    // - "50 7 * * 1-5"   → EOD digest (14:50 VN) + init multi-stage scan
    // - "* 8 * * 1-5"    → process scan chunks (mỗi 1 min, 15:00-15:59 VN)
    const cron = event.cron || "";
    if (cron === "50 7 * * 1-5") {
      // EOD digest — VN holiday vẫn skip
      if (isVnHoliday()) {
        console.log("[cron-eod] skip — VN holiday");
        ctx.waitUntil(logHeartbeat(env, "eod-skip", { reason: "vn-holiday" }));
        return;
      }
      console.log("[cron-eod] EOD fired at", new Date().toISOString());
      ctx.waitUntil(logHeartbeat(env, "eod", { event_cron: cron }));
      // Per-user watchlist digest (cho user có watches active)
      ctx.waitUntil(sendEodDigest(env));
      // Quick 35-mã digest (sent immediately, ~30s after market close)
      ctx.waitUntil(sendMarketDigest(env));
      // Init multi-stage full-universe scan (sẽ finalize ~15:30 VN)
      ctx.waitUntil(initScan(env));
      // Update peak prices for active picks (trailing stop helper)
      ctx.waitUntil(updatePeakPrices(env));
      // Resolve expired trade_log entries (forward-test tracker)
      ctx.waitUntil(resolveExpiredPicks(env));
      return;
    }
    if (cron === "* 8 * * 1-5") {
      // Chunked scan processing during 15:00-15:59 VN
      if (isVnHoliday()) return;
      ctx.waitUntil(logHeartbeat(env, "chunk", { event_cron: cron }));
      ctx.waitUntil(processScanChunk(env));
      return;
    }
    if (cron === "30 1 * * 1-5") {
      // Morning briefing 8:30 VN (1:30 UTC) — Telegram summary
      if (isVnHoliday()) {
        ctx.waitUntil(logHeartbeat(env, "morning-skip", { reason: "vn-holiday" }));
        return;
      }
      console.log("[cron-morning] fired at", new Date().toISOString());
      ctx.waitUntil(logHeartbeat(env, "morning", { event_cron: cron }));
      ctx.waitUntil(sendMorningBriefing(env));
      return;
    }
    if (cron === "*/2 * * * 1-5") {
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
  },
};

// ── Telegram Bot API helpers ──────────────────────────

async function tgSendMessage(token, chatId, text, parseMode = "Markdown", replyMarkup = null) {
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
  // cron `*/2 * * * 1-5` (every 2 min weekdays). 57 chunks × 2 min ≈ 2 giờ total.
  // EOD slot `* 8 * * 1-5` (15:00-15:59 VN) chạy mỗi 1 phút → faster (~57 min).
  if (text === "/scan") {
    await setScanState(env, {
      status: "in_progress",
      scan_date: new Date().toISOString().slice(0, 10),
      current_offset: 0,
      total_universe: FULL_UNIVERSE.length,
      climax_partial: "[]",
      momentum_partial: "[]",
      base_breakout_partial: "[]",
      fbo_partial: "[]",
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
    `/picks (/p) — Show active picks (Base Breakout + FBO + Climax)\n` +
    `/check VHM (/c VHM) — Check pattern + tier 1 mã\n` +
    `\n*Stats + Regime:*\n` +
    `/stats (/st) — Forward-test stats (Win, P&L) 30 ngày\n` +
    `/regime (/r) — VNI volatility regime hiện tại\n` +
    `\n*Account:*\n` +
    `/status — Trạng thái kết nối + watches\n` +
    `/start <token> — Kết nối account (lấy token từ app)\n` +
    `/help (/?) — Show menu này\n` +
    `\n_Tip: /scan chậm vì Cloudflare limit. Nếu cần nhanh → /quick (45 mã)._`;
}

async function buildPicksMessage(env) {
  const sb = sbClient(env);
  const climax = await sbQuery(sb, "climax_active_picks", {
    select: "symbol,signal_date,entry_price,tier,nn_net_5d_bn,peak_price",
  }) || [];
  const midterm = await sbQuery(sb, "mid_term_active_picks", {
    select: "symbol,signal_date,entry_price,peak_price",
  }) || [];

  // Filter active (expires_at > now)
  const now = new Date();
  const activeClimax = climax.filter((p) => true);  // sbQuery không support gte trên timestamp
  const activeMidterm = midterm.filter((p) => true);

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
        const data = await fetchVndHistory(sym, 220);
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
  const sinceDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&signal_date=gte.${sinceDate}&order=signal_date.desc&limit=200`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) return "❌ Lỗi fetch stats";
  const trades = await r.json();
  if (trades.length === 0) {
    return `📊 *Stats 30 ngày*\n\nChưa có trade nào được resolve trong window. Bot scan EOD T2-T6 — đợi sau khi có signal + T+5 hoặc T+30 resolve.`;
  }
  const resolved = trades.filter((t) => t.resolved_at);
  const active = trades.filter((t) => !t.resolved_at);
  const wins = resolved.filter((t) => t.is_win).length;
  const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
  const totalRet = resolved.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);
  const avgRet = resolved.length > 0 ? (totalRet / resolved.length) * 100 : 0;

  // Per-tier breakdown
  const tiers = {};
  for (const t of resolved) {
    if (!tiers[t.tier]) tiers[t.tier] = { n: 0, wins: 0, sumRet: 0 };
    tiers[t.tier].n++;
    if (t.is_win) tiers[t.tier].wins++;
    tiers[t.tier].sumRet += parseFloat(t.net_ret || 0);
  }

  let text = `📊 *Stats 30 ngày qua*\n\n`;
  text += `*Resolved:* ${resolved.length}/${trades.length} (${active.length} đang chờ)\n`;
  text += `*Win rate:* ${winRate.toFixed(1)}% (${wins}/${resolved.length})\n`;
  text += `*Avg return:* ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%/trade\n`;
  text += `*Cumulative:* ${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(1)}%\n`;

  if (Object.keys(tiers).length > 0) {
    text += `\n*Per tier:*\n`;
    for (const [tier, s] of Object.entries(tiers)) {
      const tWin = (s.wins / s.n) * 100;
      const tAvg = (s.sumRet / s.n) * 100;
      text += `• ${tier}: ${s.n} trade · ${tWin.toFixed(0)}% win · ${tAvg >= 0 ? "+" : ""}${tAvg.toFixed(2)}%/trade\n`;
    }
  }
  return text;
}

async function buildCheckSymbolMessage(env, symbol) {
  try {
    const data = await fetchVndHistory(symbol, 220);
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

// ── Foreign-Backed Oversold (FBO) — V1 verified Sharpe +1.42 Test 2026 ──
// Backtest run_foreign_flow_deep.py:
//   Train 2024-25: n=38, Win 63%, avg +1.61%, Sharpe +1.62, PF 1.81
//   Test  2026   : n=14, Win 71%, avg +1.28%, Sharpe +1.42, PF 1.61
// Pattern: drop 3d <-5% + day green + RSI<50 + NN net buy 5d > 0.
// Hold T+5, target +3%, SL -8% (same Climax flow).
// Smaller sample → flag experimental, monitor forward perf.
//
// Note: Worker phải call AFTER fetching foreign flow data. Detector return
// signal flags WITHOUT NN check — caller must add nn_5d > 0 filter.
function detectForeignBackedOversoldBase(data) {
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
const BASE_BREAKOUT_HOLD_CAL_DAYS = 42;       // ~30 trading days
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
        // Need 220 days cho strength continuation (MA200)
        const data = await fetchVndHistory(sym, 220);
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

async function getScanState(env) {
  const sb = sbClient(env);
  const rows = await sbQuery(sb, "scan_state", { select: "*", eq: { id: "main" } });
  return rows?.[0] || null;
}

async function setScanState(env, data) {
  const sb = sbClient(env);
  return sbUpdate(sb, "scan_state", { eq: { id: "main" }, data });
}

async function initScan(env) {
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
    climax_partial: "[]",
    momentum_partial: "[]",
    market_stats: JSON.stringify({ upCount: 0, downCount: 0, totalTurnover: 0, totalChange: 0, totalScanned: 0 }),
    vni_regime: vniRegime,
    vni_ret20: vniRet20,
    started_at: new Date().toISOString(),
    completed_at: null,
    error_count: 0,
  });
  console.log(`[init-scan] started, ${FULL_UNIVERSE.length} mã, VNI regime=${vniRegime} (ret20=${vniRet20?.toFixed?.(1)}%)`);

  // Immediately process first chunk to make progress (free tier 30s budget)
  await processScanChunk(env);
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
      const data = await fetchVndHistory(sym, 220);
      const climax = detectVolClimaxBounce(data);
      const momentum = detectStrengthContinuation(data);
      const baseBreakout = detectBaseBreakout(data);
      const fboBase = detectForeignBackedOversoldBase(data);
      const stats = computeStockStats(data);
      return { symbol: sym, climax, momentum, baseBreakout, fboBase, stats };
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
  const climaxRaw = safeParse(state.climax_partial, []);
  const momentumRaw = safeParse(state.momentum_partial, []);
  const baseBreakoutRaw = safeParse(state.base_breakout_partial, []);
  const fboRaw = safeParse(state.fbo_partial, []);
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

  // Now run persist + digest with error tolerance
  try {
    await persistClimaxMatches(env, matches);
  } catch (e) { console.warn("[finalize] persistClimax fail:", e.message); }
  try {
    await persistMomentumMatches(env, momentumMatches);
  } catch (e) { console.warn("[finalize] persistMomentum fail:", e.message); }
  try {
    await persistMidTermMatches(env, baseBreakoutMatches);
  } catch (e) { console.warn("[finalize] persistMidTerm fail:", e.message); }
  try {
    await persistFBOMatches(env, fboMatches);
  } catch (e) { console.warn("[finalize] persistFBO fail:", e.message); }

  // Send full-coverage digest
  const avgChange = marketStats.totalScanned > 0 ? marketStats.totalChange / marketStats.totalScanned : 0;
  const fullDigestResult = {
    matches,
    momentumMatches,
    baseBreakoutMatches,
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
  console.log(`[finalize] done — ${matches.length} climax, ${momentumMatches.length} momentum, ${baseBreakoutMatches.length} base_breakout, ${fboMatches.length} fbo`);
}

// ── Spike-alert state: persist climax matches to climax_active_picks ──

const SPIKE_HOLD_DAYS = 7;          // calendar days ~ 5 trading days
const SPIKE_THRESHOLD_PCT = 3.0;    // alert khi intraday return ≥ +3% từ open
const SPIKE_COOLDOWN_MIN = 10;      // tối thiểu 10 min giữa 2 alerts cùng mã

// Momentum picks hold ~20-30 phiên với trailing stop. Khác Climax (T+3-5).
// Dùng cùng table climax_active_picks với tier='Momentum' để portfolio coach
// detect đúng kế hoạch (target = entry × 1.035, init SL = entry × 0.92).
const MOMENTUM_HOLD_DAYS = 45;  // 30 phiên ~ 45 calendar days
const MOMENTUM_AVG_RETURN_PCT = 3.5;  // backtest avg

async function persistMomentumMatches(env, matches) {
  if (!matches || matches.length === 0) return;
  const sb = sbClient(env);
  const expiresAt = new Date(Date.now() + MOMENTUM_HOLD_DAYS * 24 * 3600 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
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
}

// ── FBO (Foreign-Backed Oversold) persist ──────────────────────
// Reuse climax_active_picks schema. Hold T+5, target +3%, SL -8% (Climax-like).
// V1 backtest: Test 2026 Sharpe +1.42, Win 71%, PF 1.61 (n=14 small sample).
async function persistFBOMatches(env, matches) {
  if (!matches || matches.length === 0) {
    console.log("[fbo persist] no matches");
    return;
  }
  const sb = sbClient(env);
  const expiresAt = new Date(Date.now() + SPIKE_HOLD_DAYS * 24 * 3600 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
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
  }));
  const okLog = await sbUpsert(sb, "trade_log", logRows, "symbol,signal_date");
  console.log(`[trade-log fbo] ${okLog ? "✓" : "✗"} ${logRows.length} FBO logged`);
}

// ── Mid-term (Base Breakout) persist ──────────────────────────
// Bảng riêng mid_term_active_picks (sql/007). Khác Climax (hold T+5) — mid-term
// hold T+30 trading (~42 calendar), trail 10%, init SL -10%.
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

  const expiresAt = new Date(
    Date.now() + BASE_BREAKOUT_HOLD_CAL_DAYS * 24 * 3600 * 1000
  ).toISOString();
  const today = new Date().toISOString().slice(0, 10);
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

async function persistClimaxMatches(env, matches) {
  const sb = sbClient(env);
  // 1. Cleanup picks đã expire
  const nowIso = new Date().toISOString();
  await sbDelete(sb, "climax_active_picks", { lt: { expires_at: nowIso } });

  if (!matches || matches.length === 0) {
    console.log("[persist] no climax matches to persist");
    return;
  }

  const expiresAt = new Date(Date.now() + SPIKE_HOLD_DAYS * 24 * 3600 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
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
  console.log(`[persist] ${ok ? "✓" : "✗"} ${rows.length} matches saved (${premiumCount} Premium, ${eliteCount} Elite, expires ${expiresAt.slice(0, 10)})`);

  // ALSO log to trade_log for forward-test tracker (unresolved, resolveCron sẽ fill)
  await logInitialTrades(env, matches, today);
}

async function logInitialTrades(env, matches, signalDate) {
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
  }));
  const ok = await sbUpsert(sb, "trade_log", rows, "symbol,signal_date");
  console.log(`[trade-log climax] ${ok ? "✓" : "✗"} ${rows.length} logged`);
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
  const ok = await sbUpsert(sb, "trade_log", rows, "symbol,signal_date");
  console.log(`[trade-log midterm] ${ok ? "✓" : "✗"} ${rows.length} logged`);
}

async function resolveExpiredPicks(env) {
  // 2 tier groups:
  //   Climax/Trend/Momentum: T+5 hold, target +3% / SL -8% / force exit T+5
  //   MidTerm: T+30 trading hold, trail 10% từ peak / init SL -10% / force exit T+30
  await resolveClassicalPicks(env);
  await resolveMidTermPicksResolver(env);
}

async function fetchOhlcvForResolve(symbol, sigTs, daysBuffer) {
  const to = Math.floor((sigTs + daysBuffer * 24 * 3600 * 1000) / 1000);
  const from = Math.floor((sigTs - 5 * 24 * 3600 * 1000) / 1000);
  const url = `${VND_HISTORY_URL}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Origin": "https://dchart.vndirect.com.vn",
      "Referer": "https://dchart.vndirect.com.vn/",
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) return null;
  return data;
}

// Classical picks (Climax/Trend/Momentum) — T+5 hold, target/SL fix
async function resolveClassicalPicks(env) {
  const sb = sbClient(env);
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=is.null&tier=neq.MidTerm&signal_date=lte.${cutoff}&order=signal_date.asc&limit=50`,
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
      if (!data) continue;
      const times = data.t.map((s) => new Date(s * 1000).toISOString().slice(0, 10));
      const sigIdx = times.indexOf(t.signal_date);
      if (sigIdx < 0 || sigIdx + 6 >= times.length) continue;

      const entryPrice = data.o[sigIdx + 1];
      if (!entryPrice || entryPrice <= 0) continue;
      const slPrice = entryPrice * 0.92;
      const targetPrice = entryPrice * 1.03;

      let exitPrice = null, exitDay = null, exitReason = null;
      for (let h = 1; h <= 5; h++) {
        const idx = sigIdx + 1 + h;
        if (idx >= data.c.length) break;
        const cl = data.c[idx];
        if (cl <= slPrice) { exitPrice = cl; exitDay = h; exitReason = "sl"; break; }
        if (h >= 3 && cl >= targetPrice) { exitPrice = cl; exitDay = h; exitReason = "target"; break; }
        if (h === 5) { exitPrice = cl; exitDay = h; exitReason = "force"; }
      }
      if (exitPrice === null) continue;
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

// Mid-term picks (Base Breakout) — T+30 trading hold (~44 calendar), trail 10% peak / SL -10%
async function resolveMidTermPicksResolver(env) {
  const sb = sbClient(env);
  // Wait 44 calendar days (= 30 trading + buffer) trước khi resolve
  const cutoff = new Date(Date.now() - 44 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=is.null&tier=eq.MidTerm&signal_date=lte.${cutoff}&order=signal_date.asc&limit=50`,
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
      if (!data) continue;
      const times = data.t.map((s) => new Date(s * 1000).toISOString().slice(0, 10));
      const sigIdx = times.indexOf(t.signal_date);
      if (sigIdx < 0 || sigIdx + 32 >= times.length) continue;

      const entryPrice = data.o[sigIdx + 1];
      if (!entryPrice || entryPrice <= 0) continue;
      const initSlPct = (t.init_sl_pct || 10) / 100;
      const trailPct = (t.trail_pct || 10) / 100;
      const maxHold = t.max_hold_days || 30;
      const initSl = entryPrice * (1 - initSlPct);

      let peak = entryPrice;
      let exitPrice = null, exitDay = null, exitReason = null;
      for (let h = 1; h <= maxHold; h++) {
        const idx = sigIdx + 1 + h;
        if (idx >= data.c.length) break;
        const cl = data.c[idx];
        const hi = data.h[idx];
        if (hi && hi > peak) peak = hi;
        const trailSl = peak * (1 - trailPct);
        const effSl = Math.max(initSl, trailSl);
        if (cl <= effSl) {
          exitPrice = cl; exitDay = h;
          exitReason = (effSl === initSl) ? "sl" : "trail";
          break;
        }
        if (h === maxHold) { exitPrice = cl; exitDay = h; exitReason = "force"; }
      }
      if (exitPrice === null) continue;
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

async function updatePeakPrices(env) {
  // Update peak_price cho cả climax + mid_term active picks. Used by trailing
  // stop check trong checkExitAlerts (peak từ entry day → now).
  const sb = sbClient(env);
  for (const table of ["climax_active_picks", "mid_term_active_picks"]) {
    await updatePeakForTable(env, sb, table);
  }
}

async function updatePeakForTable(env, sb, table) {
  const picks = await sbQuery(sb, table, {
    select: "id,symbol,entry_price,peak_price,signal_date",
  });
  if (!picks || picks.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;
  for (const p of picks) {
    if (p.signal_date >= today) continue;  // chưa entry, không có peak
    try {
      const data = await fetchVndHistory(p.symbol, 3);
      const curHigh = Math.max(...(data.highs || []));
      if (!curHigh) continue;
      const newPeak = Math.max(p.peak_price || 0, curHigh);
      if (newPeak > (p.peak_price || 0)) {
        await sbUpdate(sb, table, {
          eq: { id: p.id },
          data: { peak_price: newPeak, peak_date: today },
        });
        updated++;
      }
    } catch {}
  }
  console.log(`[peak ${table}] updated ${updated}/${picks.length}`);
}

// Fetch intraday 5-min bars for current trading day (from 9:00 VN today)
async function fetchVndIntraday(symbol) {
  // VN open 9:00 = 02:00 UTC. Lấy from = today 01:00 UTC (buffer 1h).
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));
  const from = Math.floor(todayStart.getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const url = `${VND_HISTORY_URL}?resolution=5&symbol=${symbol}&from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      "Origin": "https://dchart.vndirect.com.vn",
      "Referer": "https://dchart.vndirect.com.vn/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.s !== "ok" || !data.c?.length) throw new Error("no intraday data");
  return {
    opens: data.o,
    highs: data.h,
    lows: data.l,
    closes: data.c,
    times: data.t,
  };
}

async function checkSpikeAlerts(env) {
  const sb = sbClient(env);
  const nowIso = new Date().toISOString();
  // Read active picks (not expired)
  const picks = await sbQuery(sb, "climax_active_picks", {
    select: "symbol,entry_price,target_price,tier,above_threshold,last_alert_at,signal_date",
  });
  if (!picks || picks.length === 0) {
    return;
  }
  const active = picks.filter((p) => true); // already filtered by expires_at >= now? sbQuery doesn't filter, do manual
  // Note: sbQuery không support .gte → cleanup chạy ở EOD persist nên active = current rows
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
      // Transition false→true: FIRE alert
      const msg =
        `🚀 *${p.symbol}* spike intraday\n\n` +
        `Entry signal: ${p.entry_price} (${p.signal_date}, Tier ${p.tier})\n` +
        `Open hôm nay: ${r.openToday.toFixed(2)}\n` +
        `High intraday: *${r.currentHigh.toFixed(2)}* (+${r.intradayRet.toFixed(2)}% từ open)\n` +
        `Giá hiện tại: ${r.currentLast.toFixed(2)} (+${r.lastRet.toFixed(2)}%)\n\n` +
        `💡 *Cân nhắc bán nốt* (manual decision) — SSI iBoard:\n` +
        `① Nếu giá vẫn quanh đỉnh → menu *Lệnh thường*, loại *LO* bán giá ${r.currentHigh.toFixed(2)}\n` +
        `② Nếu đã rớt xa khỏi đỉnh → loại *MP* bán (khớp ngay) nếu vẫn lãi\n` +
        `③ Hoặc giữ tiếp — vẫn còn lãi an toàn, đợi target +3% tự khớp\n\n` +
        `⏰ ${new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })} VN\n` +
        `─────\n` +
        `_LO = lệnh giới hạn (giá cụ thể, không khớp nếu giá thị trường xấu hơn)._\n` +
        `_MP = market price (khớp ngay theo giá hiện hành, có thể trượt)._\n` +
        `_Lệnh thường = menu đầu SSI iBoard, chứa LO/MP/ATC/ATO theo giờ phiên._`;
      for (const chatId of chats) {
        await tgSendMessage(env.BOT_TOKEN, chatId, msg);
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

// ── Auto-exit alert: discipline enforcer ──────────────────────────────
// Per-tier config:
//   Climax (climax_active_picks):   SL -8%,  Trail -6%,  Timeout T+10 calendar
//   Mid-term (mid_term_active_picks): SL -10%, Trail -10%, Timeout T+42 calendar
//                                     (~30 trading days, backtest verified)
// Mỗi pick chỉ alert 1 lần (dedupe qua exit_alerted_at).
const EXIT_CONFIG = {
  climax: {
    table: "climax_active_picks",
    label: "Climax",
    sl_pct: -8,
    trail_pct: -6,
    timeout_days: 10,
  },
  mid_term: {
    table: "mid_term_active_picks",
    label: "Mid-term",
    sl_pct: -10,
    trail_pct: -10,
    timeout_days: 42,
  },
};

async function checkExitAlerts(env) {
  const sb = sbClient(env);
  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (!chats.length) {
    console.log("[exit-alert] no Telegram users linked");
    return;
  }
  // Check each tier table với config riêng
  for (const cfg of Object.values(EXIT_CONFIG)) {
    await checkExitAlertsForTable(env, sb, cfg, chats);
  }
}

async function checkExitAlertsForTable(env, sb, cfg, chats) {
  const selectCols = cfg.table === "mid_term_active_picks"
    ? "id,symbol,entry_price,signal_date,peak_price,pattern_type,exit_alerted_at"
    : "id,symbol,entry_price,signal_date,peak_price,tier,exit_alerted_at";
  const picks = await sbQuery(sb, cfg.table, { select: selectCols });
  if (!picks?.length) return;

  const candidates = picks.filter((p) => !p.exit_alerted_at);
  if (!candidates.length) {
    console.log(`[exit-alert ${cfg.label}] all alerted, skip`);
    return;
  }
  console.log(`[exit-alert ${cfg.label}] checking ${candidates.length} candidates`);

  const todayDt = new Date();

  const results = await Promise.all(candidates.map(async (p) => {
    try {
      const bars = await fetchVndIntraday(p.symbol);
      const n = bars.closes.length;
      if (n === 0) return null;
      const cur = bars.closes[n - 1];
      const signalDt = new Date(p.signal_date);
      const daysHeld = Math.floor((todayDt - signalDt) / (24 * 3600 * 1000));
      const entryPrice = parseFloat(p.entry_price);
      const peakPrice = parseFloat(p.peak_price || 0);
      const entryRet = ((cur - entryPrice) / entryPrice) * 100;

      // Priority: SL > trail > timeout
      if (entryRet <= cfg.sl_pct) {
        return { pick: p, reason: "sl_hit", cur, daysHeld, entryRet, trailRet: null };
      }
      if (peakPrice > entryPrice) {
        const trailRet = ((cur - peakPrice) / peakPrice) * 100;
        if (trailRet <= cfg.trail_pct) {
          return { pick: p, reason: "trail_hit", cur, daysHeld, entryRet, trailRet };
        }
      }
      if (daysHeld >= cfg.timeout_days) {
        return { pick: p, reason: "timeout", cur, daysHeld, entryRet, trailRet: null };
      }
      return null;
    } catch (e) {
      console.warn(`[exit-alert ${cfg.label}] ${p.symbol} fail:`, e.message);
      return null;
    }
  }));

  let alerted = 0;
  for (const r of results) {
    if (!r) continue;
    const msg = buildExitAlertMessage(r.pick, r, cfg);
    for (const chatId of chats) {
      try {
        await tgSendMessage(env.BOT_TOKEN, chatId, msg);
      } catch (e) {
        console.warn(`[exit-alert ${cfg.label}] tg send fail chat=${chatId}:`, e.message);
      }
    }
    await sbUpdate(sb, cfg.table, {
      eq: { id: r.pick.id },
      data: {
        exit_alerted_at: new Date().toISOString(),
        exit_alert_reason: r.reason,
      },
    });
    alerted++;
  }
  console.log(`[exit-alert ${cfg.label}] sent ${alerted} alerts`);
}

function buildExitAlertMessage(pick, r, cfg) {
  const sym = pick.symbol;
  const tierLabel = cfg ? cfg.label : (pick.tier || "?");
  const entryFmt = parseFloat(pick.entry_price).toFixed(2);
  const curFmt = r.cur.toFixed(2);
  const entryRetSign = r.entryRet >= 0 ? "+" : "";
  const entryRetFmt = `${entryRetSign}${r.entryRet.toFixed(1)}`;
  const slRule = cfg ? cfg.sl_pct : -8;
  const trailRule = cfg ? cfg.trail_pct : -6;
  const timeoutRule = cfg ? cfg.timeout_days : 10;
  const timeStr = new Date().toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit",
  });

  if (r.reason === "sl_hit") {
    return `⛔ *EXIT ALERT — ${sym}* (${tierLabel})\n\n` +
           `📉 Hit Stop Loss *${entryRetFmt}%* (rule: ≤ ${slRule}%)\n` +
           `• Entry: ${entryFmt} → Hiện: *${curFmt}*\n` +
           `• Đã hold: ${r.daysHeld} ngày\n\n` +
           `*👉 Cân nhắc BÁN ngay để cắt lỗ.*\n` +
           `_Rule SL ${slRule}%: chấp nhận lỗ nhỏ, tránh hold mã thua quá lâu._\n` +
           `⏰ ${timeStr} VN`;
  }
  if (r.reason === "trail_hit") {
    const trailFmt = r.trailRet.toFixed(1);
    const peakFmt = parseFloat(pick.peak_price).toFixed(2);
    return `📉 *EXIT ALERT — ${sym}* (${tierLabel})\n\n` +
           `📊 Trailing stop: rớt *${trailFmt}%* từ peak (rule: ≤ ${trailRule}%)\n` +
           `• Peak: ${peakFmt} → Hiện: *${curFmt}* (${entryRetFmt}% so entry)\n` +
           `• Entry: ${entryFmt} · Đã hold: ${r.daysHeld} ngày\n\n` +
           `*👉 Cân nhắc CHỐT lời — đã giảm hơn ${Math.abs(trailRule)}% từ đỉnh.*\n` +
           `_Rule trailing ${Math.abs(trailRule)}%: khoá lãi, không để lãi thành lỗ._\n` +
           `⏰ ${timeStr} VN`;
  }
  if (r.reason === "timeout") {
    return `⏰ *EXIT ALERT — ${sym}* (${tierLabel})\n\n` +
           `📅 Đã hold *T+${r.daysHeld}* (rule timeout: T+${timeoutRule})\n` +
           `• Entry: ${entryFmt} → Hiện: *${curFmt}* (${entryRetFmt}%)\n\n` +
           `*👉 Cân nhắc BÁN theo plan — pattern hết shelf-life.*\n` +
           `_Rule T+${timeoutRule}: pattern không nên hold quá ngưỡng đã verify._\n` +
           `⏰ ${timeStr} VN`;
  }
  return `⚠️ *${sym}* — Exit reason không xác định: ${r.reason}`;
}

// ── Market Digest: VN-Index + top gainers/losers/vol + Bắt đáy ──
// Top 2 — Daily morning briefing 8:30 VN
// Concise Telegram summary: last 5d performance + active picks countdown + day expectation.
async function sendMorningBriefing(env) {
  const sb = sbClient(env);

  // 1. Fetch last 30 days resolved trades
  const fiveDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fetch(
    `${sb.url}/rest/v1/trade_log?select=*&resolved_at=not.is.null&signal_date=gte.${fiveDaysAgo}&order=signal_date.desc&limit=20`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  const recentTrades = r.ok ? await r.json() : [];

  // 2. Active picks not yet expired
  const todayStr = new Date().toISOString().slice(0, 10);
  const activePicksRes = await fetch(
    `${sb.url}/rest/v1/climax_active_picks?select=*&expires_at=gte.${new Date().toISOString()}&order=signal_date.desc&limit=20`,
    { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } }
  );
  const activePicks = activePicksRes.ok ? await activePicksRes.json() : [];

  // 3. Drawdown status
  const drawdown = {};
  for (const tier of ["Premium", "A", "B"]) {
    drawdown[tier] = await computeDrawdownStatus(sb, tier);
  }

  // 4. Fetch users
  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (chats.length === 0) {
    console.log("[morning] no connected users");
    return;
  }

  // 5. Build message
  const today = new Date();
  const todayLabel = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
  let text = `☀️ *Sáng ${todayLabel}*\n\n`;

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
    text += `💼 *Active T+ picks* (${activePicks.length} mã):\n`;
    for (const p of activePicks.slice(0, 5)) {
      const sigDate = new Date(p.signal_date);
      const daysHeld = Math.floor((today.getTime() - sigDate.getTime()) / (24 * 3600 * 1000));
      const tradingDays = Math.max(0, Math.floor(daysHeld * 5 / 7));  // approx trading days
      const remainingDays = Math.max(0, 5 - tradingDays);
      const premiumTag = p.is_premium ? "💎 " : "";
      const peakTag = p.peak_price ? ` · peak ${parseFloat(p.peak_price).toFixed(2)}` : "";
      text += `  · ${premiumTag}*${p.symbol}* (${p.tier}) — T+${tradingDays}, còn ${remainingDays} phiên${peakTag}\n`;
    }
    text += `\n`;
  }

  // Today expectation
  text += `📅 *Hôm nay*:\n`;
  text += `  · Chờ EOD scan 14:50 cho signal mới\n`;
  text += `  · Intraday spike alerts mỗi 3 phút cho active picks\n`;
  text += `  · Check tab Hiệu suất trong app để xem equity curve\n`;

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

async function sendMarketDigest(env, precomputedResult = null) {
  let result;
  if (precomputedResult) {
    console.log(`[digest] using precomputed (full coverage ${precomputedResult.fullCoverage ? "yes" : "no"})`);
    result = precomputedResult;
  } else {
    console.log("[digest] scanning universe + market stats...");
    result = await scanAllSymbols();
    // Persist khi quét fresh (chunked scan đã persist trong finalizeScan)
    await persistClimaxMatches(env, result.matches);
    await persistMomentumMatches(env, result.momentumMatches || []);
  }
  const { matches, market, gainers, losers, topVol } = result;
  console.log(`[digest] ${matches.length} climax · ${market.upCount}↑/${market.downCount}↓ · avg ${market.avgChange.toFixed(2)}%`);

  // Fetch VN-Index để có index data
  let vniInfo = null;
  try {
    const vni = await fetchVndHistory("VNINDEX", 5);
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

  // Fetch all connected users
  const sb = sbClient(env);
  const users = await sbQuery(sb, "user_telegram", { select: "chat_id" });
  const chats = (users || []).map((u) => u.chat_id).filter(Boolean);
  if (chats.length === 0) {
    console.log("[digest] no connected users");
    return;
  }

  // ── Compose comprehensive market digest ──
  function addTradingDays(date, n) {
    const d = new Date(date);
    let added = 0;
    while (added < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d;
  }
  function fmtDM(d) {
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  function fmtBn(n) {
    return (n / 1e9).toFixed(0);
  }

  const today = new Date();
  const todayLabel = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;

  let text = `📊 *Tổng kết phiên ${todayLabel}*\n\n`;

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

  // VN-Index regime banner cho Tier Elite
  if (result.vniRegime === "correction" && result.vniRet20 != null) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `⚡ *Tier Elite regime ACTIVE*\n`;
    text += `VN-Index 20 phiên: ${result.vniRet20.toFixed(1)}% → thị trường correction.\n`;
    text += `Backtest: regime này Win 61% / Sharpe 1.71 vs baseline Win 56% / Sharpe 0.70.\n`;
    text += `Tất cả match Climax dưới đây = *Tier Elite*.\n`;
  } else if (result.vniRegime === "bull" && result.vniRet20 != null) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `🐂 _VN-Index bull (+${result.vniRet20.toFixed(1)}% 20p) — Climax edge thấp hơn correction regime._\n`;
  }

  // Bắt đáy T+ section
  const isEliteRegime = result.isEliteRegime;
  const premiumMatches = matches.filter((m) => m.is_premium);
  const tierA = matches.filter((m) => m.tier === "A" && !m.is_premium);
  const tierB = matches.filter((m) => m.tier === "B" && !m.is_premium);

  // 💎 Premium section đầu tiên (NN net buy confirmed, Sharpe 1.90 vs base 0.36)
  if (premiumMatches.length > 0) {
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `💎 *Premium picks* (${premiumMatches.length}) — Climax + NN net mua\n`;
    text += `_Backtest 7.4y: Win 61%, Sharpe 1.90 vs Tier A base Sharpe 0.36._\n\n`;
    const t1 = addTradingDays(today, 1);
    const t3 = addTradingDays(today, 4);
    const t5 = addTradingDays(today, 6);
    for (const m of premiumMatches.slice(0, 5)) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const target = cur * 1.03 * 0.995;
      const sl = cur * 0.92;
      const nnTag = m.nn_net_5d_bn != null ? `NN +${m.nn_net_5d_bn}B/5d` : "";
      text += `💎 *${m.symbol}* @ ${cur.toFixed(2)} · 3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)} · ${nnTag}\n`;
      text += `  MUA ${fmtDM(t1)} ≤ ${entryMax.toFixed(2)} · SL < ${sl.toFixed(2)} · TP T+3→T+5 ${target.toFixed(2)} (+3%)\n\n`;
    }
    text += `💰 *Size khuyến nghị Premium*: 20% NAV/lệnh (Kelly-adjusted, Sharpe 1.90 justifies bigger size)\n`;
  }

  text += `\n━━━━━━━━━━━━━━━\n`;
  text += `🔻 *Bắt đáy T+ (Vol Climax Bounce)*\n`;
  if (isEliteRegime) {
    text += `⚡ ${matches.length} Tier Elite (đã bao gồm Premium ở trên)\n`;
  } else {
    text += `${premiumMatches.length} Premium · ${tierA.length} Tier A · ${tierB.length} Tier B\n`;
  }

  if (matches.length === 0) {
    text += `\n📭 Không có signal hôm nay.\n`;
    text += `Pattern hiếm ~80-95/năm = ~2 lệnh/tuần avg.\n`;
  } else {
    text += `\n`;
    const t1 = addTradingDays(today, 1);
    const t3 = addTradingDays(today, 4);
    const t5 = addTradingDays(today, 6);
    const t1Label = fmtDM(t1);
    const t3Label = fmtDM(t3);
    const t5Label = fmtDM(t5);

    const showMatches = isEliteRegime
      ? matches.slice(0, 5)
      : [...tierA.slice(0, 3), ...tierB.slice(0, 3)].slice(0, 5);
    for (const m of showMatches) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const entryMid = (entryMax + cur * 0.99) / 2;
      const sl = entryMid * 0.92;
      const target = entryMid * 1.03;

      const tierTag = isEliteRegime ? "⚡ Elite" : m.tier === "A" ? "🟢 A" : "🔵 B";
      text += `${tierTag} *${m.symbol}* @ ${cur.toFixed(2)} · 3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)}\n`;
      text += `  MUA ${t1Label} ≤ ${entryMax.toFixed(2)} · CẮT < ${sl.toFixed(2)} · BÁN T+3→T+5 target ${target.toFixed(2)} (+3%)\n\n`;
    }
    text += isEliteRegime
      ? `💰 Size: 18% NAV/Elite. Max 2-3 lệnh đồng thời.\n`
      : `💰 Size: 15% NAV Tier A · 10% NAV Tier B. Max 2-3 lệnh.\n`;
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
      text += `  MUA ≤ ${entryMax.toFixed(2)} · init SL ${initSL.toFixed(2)} · trail 7% từ đỉnh\n`;
      text += `  Hold ~20 phiên · expected ~${expectedExit.toFixed(2)} (+3.5%)\n\n`;
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
      text += `  Init SL ${initSL.toFixed(2)} (-10%) · trail 10% từ peak · hold tối đa T+30\n\n`;
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
    const today = new Date();
    const todayLabel = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
    const emptyText = `🔻 *Bắt đáy T+ — ${todayLabel}*\n\n` +
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
  function addTradingDays(date, n) {
    const d = new Date(date);
    let added = 0;
    while (added < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d;
  }
  function fmtDM(d) {
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const today = new Date();
  const todayLabel = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
  // T+ convention VN: T+0 = entry day (mua T+1 sau signal)
  // T+1 = next trading day = entry day. T+3, T+4, T+5 = 3, 4, 5 phiên sau
  const t1 = addTradingDays(today, 1);
  const t3 = addTradingDays(today, 4); // entry + 3 phiên
  const t4 = addTradingDays(today, 5);
  const t5 = addTradingDays(today, 6);
  const t1Label = fmtDM(t1);
  const t3Label = fmtDM(t3);
  const t4Label = fmtDM(t4);
  const t5Label = fmtDM(t5);

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
  const from = to - days * 24 * 3600;
  const url = `${VND_HISTORY_URL}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`;
  // VND blocks Cloudflare Worker default fetch (no UA, custom origin) → 403.
  // Giả browser headers cho qua. dchart endpoint chính là widget chart VNDirect.
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      "Origin": "https://dchart.vndirect.com.vn",
      "Referer": "https://dchart.vndirect.com.vn/",
    },
  });
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

async function sendEodDigest(env) {
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
    const today = new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    let text = `📊 *EOD ${today}*\n\n`;
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
    const lastLoss = new Date(trades[0].signal_date);
    const end = new Date(lastLoss);
    let added = 0;
    while (added < DRAWDOWN_COOLDOWN_TRADING_DAYS) {
      end.setDate(end.getDate() + 1);
      if (end.getDay() !== 0 && end.getDay() !== 6) added++;
    }
    pausedUntil = end.toISOString().slice(0, 10);
    // Re-check: if today already past pausedUntil, not paused anymore
    const today = new Date().toISOString().slice(0, 10);
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
