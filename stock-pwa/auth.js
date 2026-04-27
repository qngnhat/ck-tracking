// ═══════════════════════════════════════
// Supabase Auth + DB wrapper
// ═══════════════════════════════════════
//
// Tải Supabase JS SDK qua CDN (đã include trong index.html).
// Module exposes: window.__SSI_AUTH__ với các method cho auth + DB sync.
//
// Guest mode: nếu chưa configure SUPABASE_URL/KEY HOẶC user chưa login,
// app vẫn chạy bình thường với localStorage. Khi login, sync localStorage
// → DB và switch sang DB-backed storage.

window.__SSI_AUTH__ = (function () {
  "use strict";

  const cfg = window.__SSI_CONFIG__ || {};
  const URL = cfg.SUPABASE_URL || "";
  const KEY = cfg.SUPABASE_ANON_KEY || "";

  let client = null;
  let currentSession = null;
  const stateListeners = [];

  function isConfigured() {
    return URL && KEY && typeof window.supabase !== "undefined";
  }

  function getClient() {
    if (!isConfigured()) return null;
    if (!client) {
      client = window.supabase.createClient(URL, KEY, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      });
    }
    return client;
  }

  // ── Session management ──
  async function init() {
    const c = getClient();
    if (!c) return null;

    // Get current session (from localStorage)
    const { data, error } = await c.auth.getSession();
    if (error) {
      console.warn("[auth] getSession error:", error);
      return null;
    }
    currentSession = data.session;

    // Listen for auth changes
    c.auth.onAuthStateChange((event, session) => {
      currentSession = session;
      stateListeners.forEach((fn) => {
        try { fn(event, session); } catch (e) { console.warn("[auth] listener error:", e); }
      });
    });

    return currentSession;
  }

  function getSession() {
    return currentSession;
  }

  function getUser() {
    return currentSession?.user || null;
  }

  function isLoggedIn() {
    return !!currentSession?.user;
  }

  function onAuthChange(fn) {
    stateListeners.push(fn);
    return () => {
      const i = stateListeners.indexOf(fn);
      if (i >= 0) stateListeners.splice(i, 1);
    };
  }

  async function signInWithGoogle() {
    const c = getClient();
    if (!c) {
      alert("Chưa cấu hình Supabase. Đọc supabase-setup.md.");
      return;
    }
    const { error } = await c.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (error) console.warn("[auth] signin error:", error);
  }

  async function signOut() {
    const c = getClient();
    if (!c) return;
    await c.auth.signOut();
    currentSession = null;
  }

  // ── DB helpers (auto user_id from session) ──
  function userId() {
    return currentSession?.user?.id || null;
  }

  async function dbSelect(table, query = {}) {
    const c = getClient();
    if (!c || !isLoggedIn()) return null;
    let q = c.from(table).select(query.columns || "*");
    if (query.eq) {
      for (const [k, v] of Object.entries(query.eq)) q = q.eq(k, v);
    }
    if (query.order) q = q.order(query.order.column, { ascending: !!query.order.ascending });
    if (query.limit) q = q.limit(query.limit);
    const { data, error } = await q;
    if (error) {
      console.warn(`[auth] select ${table} error:`, error);
      return null;
    }
    return data;
  }

  async function dbInsert(table, row) {
    const c = getClient();
    if (!c || !isLoggedIn()) return null;
    const withUser = Array.isArray(row)
      ? row.map((r) => ({ ...r, user_id: userId() }))
      : { ...row, user_id: userId() };
    const { data, error } = await c.from(table).insert(withUser).select();
    if (error) {
      console.warn(`[auth] insert ${table} error:`, error);
      return null;
    }
    return data;
  }

  async function dbUpsert(table, row, opts = {}) {
    const c = getClient();
    if (!c || !isLoggedIn()) return null;
    const withUser = Array.isArray(row)
      ? row.map((r) => ({ ...r, user_id: userId() }))
      : { ...row, user_id: userId() };
    const { data, error } = await c.from(table).upsert(withUser, opts).select();
    if (error) {
      console.warn(`[auth] upsert ${table} error:`, error);
      return null;
    }
    return data;
  }

  async function dbDelete(table, query) {
    const c = getClient();
    if (!c || !isLoggedIn()) return null;
    let q = c.from(table).delete();
    if (query?.eq) {
      for (const [k, v] of Object.entries(query.eq)) q = q.eq(k, v);
    }
    const { error } = await q;
    if (error) {
      console.warn(`[auth] delete ${table} error:`, error);
      return false;
    }
    return true;
  }

  async function dbUpdate(table, updates, query) {
    const c = getClient();
    if (!c || !isLoggedIn()) return null;
    let q = c.from(table).update(updates);
    if (query?.eq) {
      for (const [k, v] of Object.entries(query.eq)) q = q.eq(k, v);
    }
    const { error } = await q;
    if (error) {
      console.warn(`[auth] update ${table} error:`, error);
      return false;
    }
    return true;
  }

  return {
    isConfigured,
    init,
    getSession,
    getUser,
    isLoggedIn,
    onAuthChange,
    signInWithGoogle,
    signOut,
    // DB helpers
    dbSelect, dbInsert, dbUpsert, dbDelete, dbUpdate,
  };
})();
