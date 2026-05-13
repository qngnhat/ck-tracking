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
    return new Response("Stock PWA Bot Worker", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // Multi-cron dispatch dựa trên event.cron expression match.
    // - "*/3 2-7 * * 1-5" → check triggers (mỗi 3 min trong phiên)
    // - "50 7 * * 1-5"   → EOD digest (14:50 VN cuối phiên)
    const cron = event.cron || "";
    if (cron === "50 7 * * 1-5") {
      // EOD digest — VN holiday vẫn skip
      if (isVnHoliday()) {
        console.log("[cron-eod] skip — VN holiday");
        return;
      }
      console.log("[cron-eod] EOD digest fired at", new Date().toISOString());
      ctx.waitUntil(sendEodDigest(env));
      return;
    }
    // Default: check triggers (mỗi 3 min)
    if (!isVnTradingNow()) {
      console.log("[cron] skip — outside VN trading session", new Date().toISOString());
      return;
    }
    console.log("[cron] check triggers fired at", new Date().toISOString());
    ctx.waitUntil(checkAllWatches(env));
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

    const reasons = [];
    let metCount = 0;
    if (t.closeAbove && cur >= t.closeAbove) {
      reasons.push(`✅ close *${cur.toFixed(2)}* ≥ ${t.closeAbove.toFixed(2)}`);
      metCount++;
    }
    if (t.volAbove && curVol >= t.volAbove) {
      reasons.push(`✅ vol *${(curVol / 1000).toFixed(0)}K* ≥ ${(t.volAbove / 1000).toFixed(0)}K`);
      metCount++;
    }
    if (t.gapAbove && curOpen > t.gapAbove) {
      reasons.push(`✅ open *${curOpen.toFixed(2)}* > ${t.gapAbove.toFixed(2)} (gap up)`);
      metCount++;
    }

    const lastNotified = w.last_notified_count || 0;
    const shouldFire = metCount > lastNotified;

    // Always update last_check_at + met_count
    const updateData = {
      met_count: metCount,
      last_check_at: checkTs,
    };

    if (shouldFire) {
      upgraded++;
      const chatId = chatByUser.get(w.user_id);
      const tierTxt = lastNotified === 0
        ? `🔔 *${w.symbol}* — Trigger met! (${metCount}/3)`
        : `📈 *${w.symbol}* — Tier upgrade! (${lastNotified}/3 → ${metCount}/3)`;
      const text = `${tierTxt}\n\n` +
        reasons.join("\n") +
        `\n\nMở app Bonggnez xem plan chi tiết.`;
      if (chatId) {
        await tgSendMessage(env.BOT_TOKEN, chatId, text);
      }
      updateData.last_notified_count = metCount;
      updateData.notified = true;
      updateData.notified_at = checkTs;
      updateData.notified_reason = reasons.join("; ").replace(/\*/g, "");
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
