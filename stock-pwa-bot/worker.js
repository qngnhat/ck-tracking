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
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
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
        select: "symbol,signal_date,entry_price,target_price,tier,expires_at,nn_net_5d_bn,is_premium",
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
      return;
    }
    if (cron === "* 8 * * 1-5") {
      // Chunked scan processing during 15:00-15:59 VN
      if (isVnHoliday()) return;
      ctx.waitUntil(logHeartbeat(env, "chunk", { event_cron: cron }));
      ctx.waitUntil(processScanChunk(env));
      return;
    }
    // Default: */3 intraday check triggers + spike
    if (!isVnTradingNow()) {
      console.log("[cron] skip — outside VN trading session", new Date().toISOString());
      return;
    }
    console.log("[cron] check triggers + spike alerts fired at", new Date().toISOString());
    ctx.waitUntil(logHeartbeat(env, "intraday", { event_cron: cron }));
    ctx.waitUntil(checkAllWatches(env));
    ctx.waitUntil(checkSpikeAlerts(env));
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

async function handleTelegramWebhook(request, env) {
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

  // Unknown command
  await tgSendMessage(env.BOT_TOKEN, chatId,
    "Commands: `/start <token>` để kết nối, `/status` xem trạng thái."
  );
  return new Response("ok");
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

const CHUNK_SIZE = 35;

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
  const results = await Promise.all(chunk.map(async (sym) => {
    try {
      const data = await fetchVndHistory(sym, 220);
      const climax = detectVolClimaxBounce(data);
      const momentum = detectStrengthContinuation(data);
      const stats = computeStockStats(data);
      // ENRICH climax matches với foreign flow (NN net buy filter).
      // Backtest 7.4y: Tier A + NN net>0 Sharpe 0.36 → 1.90 (5×).
      // Chỉ fetch khi mã match → tránh subrequest pressure (matches hiếm).
      let foreign = null;
      if (climax) {
        foreign = await fetchForeignDaily(sym, 7).catch(() => null);
      }
      return { symbol: sym, climax, momentum, stats, foreign };
    } catch (e) {
      fetchFails++;
      return null;
    }
  }));
  const chunkMs = Date.now() - chunkStartMs;
  await logHeartbeat(env, "chunk-processed", {
    offset, total, chunk_size: chunk.length,
    duration_ms: chunkMs,
    fetch_fails: fetchFails,
  });

  // Merge into partial state
  const climaxPartial = JSON.parse(state.climax_partial || "[]");
  const momentumPartial = JSON.parse(state.momentum_partial || "[]");
  const marketStats = JSON.parse(state.market_stats || "{}");
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
  }

  const newOffset = offset + chunk.length;
  await setScanState(env, {
    current_offset: newOffset,
    climax_partial: JSON.stringify(climaxPartial),
    momentum_partial: JSON.stringify(momentumPartial),
    market_stats: JSON.stringify({ upCount, downCount, totalTurnover, totalChange, totalScanned }),
    last_chunk_at: new Date().toISOString(),
  });

  console.log(`[chunk] done ${offset}→${newOffset} · climax+${results.filter(r => r?.climax).length} momentum+${results.filter(r => r?.momentum).length}`);

  if (newOffset >= total) {
    const finalState = {
      ...state,
      current_offset: newOffset,
      climax_partial: JSON.stringify(climaxPartial),
      momentum_partial: JSON.stringify(momentumPartial),
      market_stats: JSON.stringify({ upCount, downCount, totalTurnover, totalChange, totalScanned }),
    };
    await finalizeScan(env, finalState);
  }
}

async function finalizeScan(env, state) {
  console.log(`[finalize] scan complete, building digest`);

  const climaxRaw = JSON.parse(state.climax_partial || "[]");
  const momentumRaw = JSON.parse(state.momentum_partial || "[]");
  const marketStats = JSON.parse(state.market_stats || "{}");
  const isEliteRegime = state.vni_regime === "correction";
  const isMomentumRegime = state.vni_regime === "bull" || state.vni_regime === "neutral";

  const matches = climaxRaw
    .map((m) => ({ ...m, isElite: isEliteRegime }))
    .sort((a, b) => (b.bounceStrength || 0) - (a.bounceStrength || 0));
  const momentumMatches = isMomentumRegime
    ? momentumRaw.sort((a, b) => (b.momentumStrength || 0) - (a.momentumStrength || 0))
    : [];

  // Persist to active_picks
  await persistClimaxMatches(env, matches);
  await persistMomentumMatches(env, momentumMatches);

  // Send full-coverage digest
  const avgChange = marketStats.totalScanned > 0 ? marketStats.totalChange / marketStats.totalScanned : 0;
  const fullDigestResult = {
    matches,
    momentumMatches,
    market: {
      avgChange,
      upCount: marketStats.upCount || 0,
      downCount: marketStats.downCount || 0,
      totalTurnover: marketStats.totalTurnover || 0,
      totalScanned: marketStats.totalScanned || 0,
    },
    gainers: [],   // chunked scan không track per-mã, skip top gainers
    losers: [],
    topVol: [],
    vniRegime: state.vni_regime,
    vniRet20: state.vni_ret20,
    isEliteRegime,
    isMomentumRegime,
    fullCoverage: true,
  };
  await sendMarketDigest(env, fullDigestResult);

  await setScanState(env, {
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  console.log(`[finalize] done — ${matches.length} climax, ${momentumMatches.length} momentum, sent digest`);
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

// ── Market Digest: VN-Index + top gainers/losers/vol + Bắt đáy ──
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
    text += `Size Premium: có thể x1.5 NAV vs Tier A/B thông thường.\n`;
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
      ? `Size Elite: 15% NAV. Max 2-3 lệnh đồng thời.\n`
      : `Size: 15% NAV Tier A, 10% Tier B. Max 2-3 lệnh.\n`;
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
    text += `Size: 10% NAV (hold lâu hơn Climax). Max 1-2 lệnh.\n`;
    text += `⚠️ Khi VNI chuyển correction → cắt sớm Momentum, switch sang Climax Elite.\n`;
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
