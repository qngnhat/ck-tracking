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
      // Per-user watchlist digest (cho user có watches active)
      ctx.waitUntil(sendEodDigest(env));
      // Market digest (VN-Index + top gainers/losers/vol + Bắt đáy T+)
      // Gửi cho tất cả user connected, kể cả không có watch
      ctx.waitUntil(sendMarketDigest(env));
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

function detectVolClimaxBounce(data) {
  const closes = data.closes;
  const opens = data.opens;
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

  // 2-tier system
  const base = dayGreen && volRatio > 2.0;
  const matchedA = base && ret3d < -7 && rsi < 35;
  const matchedB = base && ret3d < -5 && rsi < 50;
  const tier = matchedA ? "A" : matchedB ? "B" : null;
  if (!tier) return null;

  return {
    tier,
    ret3d, volRatio, rsi,
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
  // 1 pass: fetch + compute climax + market stats
  const allStocks = [];
  const batchSize = 10;
  for (let i = 0; i < VOL_CLIMAX_UNIVERSE.length; i += batchSize) {
    const batch = VOL_CLIMAX_UNIVERSE.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (sym) => {
      try {
        const data = await fetchVndHistory(sym, 60);
        const climax = detectVolClimaxBounce(data);
        const stats = computeStockStats(data);
        return { symbol: sym, climax, stats };
      } catch (e) {
        console.warn(`[scan] ${sym} fetch fail:`, e.message);
        return null;
      }
    }));
    allStocks.push(...results.filter((r) => r && r.stats));
  }

  // Climax matches
  const matches = allStocks
    .filter((s) => s.climax)
    .map((s) => ({ symbol: s.symbol, ...s.climax }))
    .sort((a, b) => b.bounceStrength - a.bounceStrength);

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
    market: { avgChange, upCount, downCount, totalTurnover, totalScanned: withStats.length },
    gainers,
    losers,
    topVol,
  };
}

// Backwards-compat wrapper (cũ dùng)
async function scanVolClimaxMatches() {
  const result = await scanAllSymbols();
  return result.matches;
}

// ── Market Digest: VN-Index + top gainers/losers/vol + Bắt đáy ──
async function sendMarketDigest(env) {
  console.log("[digest] scanning universe + market stats...");
  const result = await scanAllSymbols();
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

  // Top gainers
  text += `🟢 *Top 5 tăng*:\n`;
  for (const g of gainers) {
    text += `  ${g.symbol}  +${g.stats.changePct.toFixed(1)}% @ ${g.stats.cur.toFixed(2)}\n`;
  }

  // Top losers
  text += `\n🔴 *Top 5 giảm*:\n`;
  for (const l of losers) {
    text += `  ${l.symbol}  ${l.stats.changePct.toFixed(1)}% @ ${l.stats.cur.toFixed(2)}\n`;
  }

  // Top vol
  text += `\n💧 *Top thanh khoản*:\n`;
  for (const t of topVol) {
    const sign = t.stats.changePct >= 0 ? "+" : "";
    text += `  ${t.symbol}  ${fmtBn(t.stats.turnover)}tỷ (${sign}${t.stats.changePct.toFixed(1)}%)\n`;
  }

  // Bắt đáy T+ section
  const tierA = matches.filter((m) => m.tier === "A");
  const tierB = matches.filter((m) => m.tier === "B");

  text += `\n━━━━━━━━━━━━━━━\n`;
  text += `🔻 *Bắt đáy T+ (Vol Climax Bounce)*\n`;
  text += `${tierA.length} Tier A · ${tierB.length} Tier B\n`;

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

    const showMatches = [...tierA.slice(0, 3), ...tierB.slice(0, 3)];
    for (const m of showMatches.slice(0, 5)) {
      const cur = m.currentPrice;
      const entryMax = cur * 1.02;
      const entryMid = (entryMax + cur * 0.99) / 2;
      const sl = entryMid * 0.92;
      const target = entryMid * 1.03;

      const tierTag = m.tier === "A" ? "🟢 A" : "🔵 B";
      text += `${tierTag} *${m.symbol}* @ ${cur.toFixed(2)} · 3p ${m.ret3d.toFixed(1)}% · vol ${m.volRatio.toFixed(1)}× · RSI ${m.rsi.toFixed(0)}\n`;
      text += `  MUA ${t1Label} ≤ ${entryMax.toFixed(2)} · CẮT < ${sl.toFixed(2)} · BÁN T+3→T+5 target ${target.toFixed(2)} (+3%)\n\n`;
    }
    text += `Size: 15% NAV Tier A, 10% Tier B. Max 2-3 lệnh.\n`;
  }

  text += `\n_Update mỗi 14:50 EOD. Reload app để xem chi tiết._`;

  let sent = 0;
  for (const chatId of chats) {
    try {
      await tgSendMessage(env.BOT_TOKEN, chatId, text);
      sent++;
    } catch (e) {
      console.warn(`[digest] send fail ${chatId}:`, e.message);
    }
  }
  console.log(`[digest] market digest sent to ${sent}/${chats.length} users`);
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
