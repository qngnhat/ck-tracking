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
    // Cron: chạy mỗi 15 phút trong giờ giao dịch VN (config trong wrangler.toml)
    console.log("[cron] check triggers fired at", new Date().toISOString());
    ctx.waitUntil(checkAllWatches(env));
  },
};

// ── Telegram Bot API helpers ──────────────────────────

async function tgSendMessage(token, chatId, text, parseMode = "Markdown") {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));
}

// ── Webhook handler: process /start command ─────────────

async function handleTelegramWebhook(request, env) {
  const update = await request.json().catch(() => ({}));
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

// ── Cron: check all unnotified watches ──────────────────

async function checkAllWatches(env) {
  const sb = sbClient(env);

  // 1. Fetch all unnotified watches with user telegram
  const watches = await sbQuery(sb, "tplus_watches", {
    select: "id,user_id,symbol,triggers",
    eq: { notified: false },
  });
  if (!watches || watches.length === 0) {
    console.log("[cron] no unnotified watches");
    return;
  }

  // 2. Group by symbol, fetch unique symbol prices
  const symbols = [...new Set(watches.map((w) => w.symbol))];
  console.log(`[cron] checking ${watches.length} watches across ${symbols.length} symbols`);

  const priceData = {};
  for (const sym of symbols) {
    const data = await fetchVndHistory(sym, 5).catch(() => null);
    if (data) priceData[sym] = data;
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

  // 4. Process each watch
  let triggered = 0;
  for (const w of watches) {
    const data = priceData[w.symbol];
    if (!data) continue;
    const chatId = chatByUser.get(w.user_id);
    if (!chatId) continue; // user chưa connect telegram

    const cur = data.closes[data.closes.length - 1];
    const curVol = data.volumes[data.volumes.length - 1];
    const curOpen = data.opens[data.opens.length - 1];

    const t = w.triggers || {};
    const reasons = [];
    if (t.closeAbove && cur >= t.closeAbove) {
      reasons.push(`close *${cur.toFixed(2)}* ≥ ${t.closeAbove.toFixed(2)}`);
    }
    if (t.volAbove && curVol >= t.volAbove) {
      reasons.push(`vol *${(curVol / 1000).toFixed(0)}K* ≥ ${(t.volAbove / 1000).toFixed(0)}K`);
    }
    if (t.gapAbove && curOpen > t.gapAbove) {
      reasons.push(`open *${curOpen.toFixed(2)}* > ${t.gapAbove.toFixed(2)} (gap up)`);
    }

    if (reasons.length === 0) continue;

    // Trigger met — send message + mark notified
    triggered++;
    const text = `🔔 *${w.symbol}* — T+ entry trigger met!\n\n` +
      reasons.map((r) => `• ${r}`).join("\n") +
      `\n\nMở app Stock PWA → tab Top picks → ${w.symbol} để xem plan.`;
    await tgSendMessage(env.BOT_TOKEN, chatId, text);

    // Mark notified in DB
    await sbUpdate(sb, "tplus_watches", {
      eq: { id: w.id },
      data: {
        notified: true,
        notified_at: new Date().toISOString(),
        notified_reason: reasons.join("; ").replace(/\*/g, ""),
      },
    });
  }

  console.log(`[cron] triggered ${triggered}/${watches.length} watches`);
}

// ── VNDirect data fetch ─────────────────────────────────

async function fetchVndHistory(symbol, days = 5) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 3600;
  const url = `${VND_HISTORY_URL}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`;
  const res = await fetch(url);
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
