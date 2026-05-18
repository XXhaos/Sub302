const DATA_KEY = "sub302:data:v2";
const LEGACY_ROUTES_KEY = "routes:v1";
const SESSION_COOKIE = "sub302_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const DEFAULT_SETTINGS = {
  siteName: "Sub302",
  publicBaseUrl: "",
  redirectStatusCode: "302",
  profilePrefix: "p",
  allowLegacyRootRoutes: true,
};

const REDIRECT_STATUS_CODES = new Set([302, 303, 307, 308]);
const RESERVED_ROOT_SLUGS = new Set([
  "admin",
  "api",
  "assets",
  "favicon.ico",
  "p",
  "profile",
  "r",
  "sub",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return html(adminHtml());
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }

      if (url.pathname === "/") {
        return Response.redirect(`${url.origin}/admin`, 302);
      }

      if (url.pathname === "/favicon.ico") {
        return new Response("Not found", { status: 404, headers: noStoreHeaders() });
      }

      return await handlePublicRequest(request, env, url);
    } catch (err) {
      return json({ ok: false, error: err?.message || "Internal error" }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  if (url.pathname === "/api/login" && request.method === "POST") {
    return handleLogin(request, env);
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        ...noStoreHeaders(),
      },
    });
  }

  const auth = await requireAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: "Unauthorized" }, 401);

  if (url.pathname === "/api/data" && request.method === "GET") {
    return json({ ok: true, data: await getStore(env) });
  }

  if (url.pathname === "/api/settings") {
    if (request.method === "GET") {
      const store = await getStore(env);
      return json({ ok: true, settings: store.settings });
    }
    if (request.method === "POST") return updateSettings(request, env);
  }

  if (url.pathname === "/api/backup") {
    if (request.method === "GET") return json({ ok: true, data: await getStore(env) });
    if (request.method === "POST") return importBackup(request, env);
  }

  if (url.pathname === "/api/airports") {
    if (request.method === "GET") {
      const store = await getStore(env);
      return json({ ok: true, airports: store.airports });
    }
    if (request.method === "POST") return upsertAirport(request, env);
  }

  if (url.pathname.startsWith("/api/airports/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/airports/".length));
    if (request.method === "DELETE") return deleteItem(env, "airports", id);
  }

  if (url.pathname === "/api/manual-nodes") {
    if (request.method === "GET") {
      const store = await getStore(env);
      return json({ ok: true, manualNodes: store.manualNodes });
    }
    if (request.method === "POST") return upsertManualNode(request, env);
  }

  if (url.pathname.startsWith("/api/manual-nodes/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/manual-nodes/".length));
    if (request.method === "DELETE") return deleteItem(env, "manualNodes", id);
  }

  if (url.pathname === "/api/profiles") {
    if (request.method === "GET") {
      const store = await getStore(env);
      return json({ ok: true, profiles: store.profiles });
    }
    if (request.method === "POST") return upsertProfile(request, env);
  }

  if (url.pathname.startsWith("/api/profiles/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/profiles/".length));
    if (request.method === "DELETE") return deleteItem(env, "profiles", id);
  }

  // Backward-compatible API for the original Sub302 UI/scripts.
  if (url.pathname === "/api/routes") {
    if (request.method === "GET") {
      const store = await getStore(env);
      const routes = store.airports.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        target: item.url,
        enabled: item.enabled,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
      return json({ ok: true, routes });
    }
    if (request.method === "POST") return upsertAirport(request, env);
  }

  if (url.pathname.startsWith("/api/routes/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/routes/".length));
    if (request.method === "DELETE") return deleteItem(env, "airports", id);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function handleLogin(request, env) {
  ensureKv(env);
  const body = await safeJson(request);
  const password = String(body.password ?? "").trim();
  const expected = String(env.SUB302_ADMIN_PASSWORD || "").trim();

  if (!expected || expected === "change-me") {
    return json({ ok: false, error: "SUB302_ADMIN_PASSWORD is not configured" }, 500);
  }

  if (password !== expected) {
    return json({ ok: false, error: "Invalid password" }, 401);
  }

  const token = crypto.randomUUID() + "." + Date.now();
  await env.SUB302_KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      ...noStoreHeaders(),
    },
  });
}

async function requireAuth(request, env) {
  ensureKv(env);
  const token = getCookie(request.headers.get("Cookie") || "", SESSION_COOKIE);
  if (!token) return { ok: false };
  const exists = await env.SUB302_KV.get(`session:${token}`);
  return { ok: exists === "1" };
}

async function upsertAirport(request, env) {
  const body = await safeJson(request);
  const store = await getStore(env);
  const now = new Date().toISOString();
  const id = normalizeId(body.id) || makeId("sub");
  const existing = store.airports.find((item) => item.id === id);
  const slug = normalizeSlug(body.slug || existing?.slug || body.name || id) || id;
  const name = String(body.name || existing?.name || slug).trim();
  const url = String(body.url || body.target || "").trim();
  const enabled = body.enabled !== false;

  if (!name) return json({ ok: false, error: "Missing name" }, 400);
  if (!slug) return json({ ok: false, error: "Missing slug" }, 400);
  if (RESERVED_ROOT_SLUGS.has(slug.toLowerCase())) {
    return json({ ok: false, error: "This slug is reserved" }, 400);
  }
  if (!isHttpUrl(url)) {
    return json({ ok: false, error: "Subscription URL must start with http:// or https://" }, 400);
  }
  if (store.airports.some((item) => item.slug === slug && item.id !== id)) {
    return json({ ok: false, error: "Slug is already used by another airport subscription" }, 409);
  }

  const item = {
    id,
    name,
    slug,
    url,
    enabled,
    remark: String(body.remark || "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  store.airports = upsertById(store.airports, item);
  await putStore(env, store);
  return json({ ok: true, airport: item, data: store });
}

async function upsertManualNode(request, env) {
  const body = await safeJson(request);
  const store = await getStore(env);
  const now = new Date().toISOString();
  const id = normalizeId(body.id) || makeId("node");
  const existing = store.manualNodes.find((item) => item.id === id);
  const name = String(body.name || existing?.name || "Manual Node").trim();
  const uri = String(body.uri || body.node || body.target || "").trim();
  const enabled = body.enabled !== false;

  if (!name) return json({ ok: false, error: "Missing name" }, 400);
  if (!uri) return json({ ok: false, error: "Missing node URI" }, 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
    return json({ ok: false, error: "Node URI must include a scheme, for example ss:// or vless://" }, 400);
  }

  const item = {
    id,
    name,
    uri,
    enabled,
    remark: String(body.remark || "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  store.manualNodes = upsertById(store.manualNodes, item);
  await putStore(env, store);
  return json({ ok: true, manualNode: item, data: store });
}

async function upsertProfile(request, env) {
  const body = await safeJson(request);
  const store = await getStore(env);
  const now = new Date().toISOString();
  const id = normalizeId(body.id) || makeId("profile");
  const existing = store.profiles.find((item) => item.id === id);
  const slug = normalizeSlug(body.slug || existing?.slug || body.name || id) || id;
  const name = String(body.name || existing?.name || slug).trim();
  const output = body.output === "redirect" ? "redirect" : "list";
  const redirectTarget = String(body.redirectTarget || body.target || "").trim();
  const enabled = body.enabled !== false;

  if (!name) return json({ ok: false, error: "Missing name" }, 400);
  if (!slug) return json({ ok: false, error: "Missing slug" }, 400);
  if (store.profiles.some((item) => item.slug === slug && item.id !== id)) {
    return json({ ok: false, error: "Slug is already used by another subscription group" }, 409);
  }
  if (output === "redirect" && !isHttpUrl(redirectTarget)) {
    return json({ ok: false, error: "Redirect target must start with http:// or https://" }, 400);
  }

  const item = {
    id,
    name,
    slug,
    output,
    redirectTarget: output === "redirect" ? redirectTarget : "",
    subscriptionIds: uniqueStrings(body.subscriptionIds || body.airportIds || body.sources || []),
    nodeIds: uniqueStrings(body.nodeIds || []),
    enabled,
    remark: String(body.remark || "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  store.profiles = upsertById(store.profiles, item);
  await putStore(env, store);
  return json({ ok: true, profile: item, data: store });
}

async function updateSettings(request, env) {
  const body = await safeJson(request);
  const store = await getStore(env);
  store.settings = sanitizeSettings({ ...store.settings, ...body });
  await putStore(env, store);
  return json({ ok: true, settings: store.settings, data: store });
}

async function importBackup(request, env) {
  const body = await safeJson(request);
  const next = normalizeStore(body.data || body);
  await putStore(env, next);
  return json({ ok: true, data: next });
}

async function deleteItem(env, collection, rawId) {
  const id = normalizeId(rawId);
  const store = await getStore(env);
  store[collection] = store[collection].filter((item) => item.id !== id);

  if (collection === "airports") {
    store.profiles = store.profiles.map((profile) => ({
      ...profile,
      subscriptionIds: profile.subscriptionIds.filter((itemId) => itemId !== id),
    }));
  }

  if (collection === "manualNodes") {
    store.profiles = store.profiles.map((profile) => ({
      ...profile,
      nodeIds: profile.nodeIds.filter((itemId) => itemId !== id),
    }));
  }

  await putStore(env, store);
  return json({ ok: true, data: store });
}

async function handlePublicRequest(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: noStoreHeaders() });
  }

  const store = await getStore(env);
  const segments = url.pathname.split("/").filter(Boolean);
  const profilePrefix = normalizeSlug(store.settings.profilePrefix) || DEFAULT_SETTINGS.profilePrefix;

  if (segments.length === 2 && ["p", "profile", "sub", profilePrefix].includes(segments[0])) {
    return serveProfile(request, env, store, segments[1], url);
  }

  if (segments.length === 2 && ["r", "a"].includes(segments[0])) {
    return redirectAirport(request, env, store, segments[1]);
  }

  if (segments.length === 1 && store.settings.allowLegacyRootRoutes !== false) {
    return redirectAirport(request, env, store, segments[0]);
  }

  return new Response("Not found", { status: 404, headers: noStoreHeaders() });
}

async function redirectAirport(request, env, store, rawSlug) {
  const slug = normalizeSlug(rawSlug);
  const item = store.airports.find((route) => route.slug === slug && route.enabled);

  if (!item) {
    return new Response("Not found", { status: 404, headers: noStoreHeaders() });
  }

  return redirectResponse(env, store, item.url);
}

async function serveProfile(request, env, store, rawSlug, url) {
  const slug = normalizeSlug(rawSlug);
  const profile = store.profiles.find((item) => item.slug === slug && item.enabled);

  if (!profile) {
    return new Response("Not found", { status: 404, headers: noStoreHeaders() });
  }

  if (profile.output === "redirect") {
    return redirectResponse(env, store, profile.redirectTarget);
  }

  const items = buildProfileItems(request, store, profile);
  if (url.searchParams.get("format") === "json") {
    return json({
      ok: true,
      profile: { id: profile.id, name: profile.name, slug: profile.slug },
      items,
    });
  }

  const body = items.join("\n") + (items.length ? "\n" : "");
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Sub302-Mode": "reference-list",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...noStoreHeaders(),
    },
  });
}

function buildProfileItems(request, store, profile) {
  const items = [];
  const airports = new Map(store.airports.map((item) => [item.id, item]));
  const nodes = new Map(store.manualNodes.map((item) => [item.id, item]));

  for (const id of profile.subscriptionIds || []) {
    const item = airports.get(id);
    if (item?.enabled) items.push(buildAirportPublicUrl(request, store.settings, item));
  }

  for (const id of profile.nodeIds || []) {
    const item = nodes.get(id);
    if (item?.enabled && item.uri) items.push(item.uri);
  }

  return uniqueStrings(items);
}

function redirectResponse(env, store, target) {
  const configured = Number(store.settings.redirectStatusCode || env.SUB302_REDIRECT_STATUS_CODE || 302);
  const status = REDIRECT_STATUS_CODES.has(configured) ? configured : 302;

  return new Response(null, {
    status,
    headers: {
      Location: target,
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...noStoreHeaders(),
    },
  });
}

async function getStore(env) {
  ensureKv(env);
  const raw = await env.SUB302_KV.get(DATA_KEY);
  if (raw) {
    try {
      return normalizeStore(JSON.parse(raw));
    } catch {
      return normalizeStore({});
    }
  }

  const legacy = await env.SUB302_KV.get(LEGACY_ROUTES_KEY);
  if (!legacy) return normalizeStore({});

  try {
    const routes = JSON.parse(legacy);
    const store = normalizeStore({
      airports: Array.isArray(routes)
        ? routes.map((item) => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            url: item.target || item.url,
            enabled: item.enabled,
            remark: item.remark,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }))
        : [],
    });
    await putStore(env, store);
    return store;
  } catch {
    return normalizeStore({});
  }
}

async function putStore(env, store) {
  ensureKv(env);
  await env.SUB302_KV.put(DATA_KEY, JSON.stringify(normalizeStore(store), null, 2));
}

function normalizeStore(input) {
  const store = input && typeof input === "object" ? input : {};
  return {
    settings: sanitizeSettings(store.settings || {}),
    airports: normalizeAirports(store.airports || store.routes || []),
    manualNodes: normalizeManualNodes(store.manualNodes || store.nodes || []),
    profiles: normalizeProfiles(store.profiles || store.groups || []),
  };
}

function normalizeAirports(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const id = normalizeId(item.id || item.slug || item.name) || makeId("sub");
      const slug = normalizeSlug(item.slug || item.id || item.name || id) || id;
      const url = String(item.url || item.target || "").trim();
      if (!url) return null;
      return {
        id,
        name: String(item.name || slug).trim(),
        slug,
        url,
        enabled: item.enabled !== false,
        remark: String(item.remark || "").trim(),
        createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function normalizeManualNodes(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const id = normalizeId(item.id || item.name) || makeId("node");
      const uri = String(item.uri || item.node || item.target || "").trim();
      if (!uri) return null;
      return {
        id,
        name: String(item.name || "Manual Node").trim(),
        uri,
        enabled: item.enabled !== false,
        remark: String(item.remark || "").trim(),
        createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function normalizeProfiles(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const id = normalizeId(item.id || item.slug || item.name) || makeId("profile");
    const slug = normalizeSlug(item.slug || item.id || item.name || id) || id;
    const output = item.output === "redirect" ? "redirect" : "list";
    return {
      id,
      name: String(item.name || slug).trim(),
      slug,
      output,
      redirectTarget: output === "redirect" ? String(item.redirectTarget || item.target || "").trim() : "",
      subscriptionIds: uniqueStrings(item.subscriptionIds || item.airportIds || item.sources || []),
      nodeIds: uniqueStrings(item.nodeIds || []),
      enabled: item.enabled !== false,
      remark: String(item.remark || "").trim(),
      createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    };
  });
}

function sanitizeSettings(settings) {
  const source = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const status = Number(source.redirectStatusCode || DEFAULT_SETTINGS.redirectStatusCode);
  const publicBaseUrl = String(source.publicBaseUrl || "").trim().replace(/\/+$/g, "");
  const profilePrefix = normalizeSlug(source.profilePrefix || DEFAULT_SETTINGS.profilePrefix) || DEFAULT_SETTINGS.profilePrefix;

  return {
    siteName: String(source.siteName || DEFAULT_SETTINGS.siteName).trim().slice(0, 48) || DEFAULT_SETTINGS.siteName,
    publicBaseUrl: isHttpUrl(publicBaseUrl) ? publicBaseUrl : "",
    redirectStatusCode: String(REDIRECT_STATUS_CODES.has(status) ? status : 302),
    profilePrefix: RESERVED_ROOT_SLUGS.has(profilePrefix) && profilePrefix !== "p" ? "p" : profilePrefix,
    allowLegacyRootRoutes: source.allowLegacyRootRoutes !== false,
  };
}

function upsertById(items, item) {
  const exists = items.some((entry) => entry.id === item.id);
  return exists ? items.map((entry) => (entry.id === item.id ? item : entry)) : [item, ...items];
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9._~-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueStrings(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || ""));
}

function buildAirportPublicUrl(request, settings, item) {
  const path = settings.allowLegacyRootRoutes === false ? `/r/${item.slug}` : `/${item.slug}`;
  return `${publicBaseUrl(request, settings)}${path}`;
}

function buildProfilePublicUrl(request, settings, item) {
  const prefix = normalizeSlug(settings.profilePrefix) || DEFAULT_SETTINGS.profilePrefix;
  return `${publicBaseUrl(request, settings)}/${prefix}/${item.slug}`;
}

function publicBaseUrl(request, settings) {
  return settings.publicBaseUrl || new URL(request.url).origin;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getCookie(cookieHeader, name) {
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function ensureKv(env) {
  if (!env.SUB302_KV) {
    throw new Error("SUB302_KV binding is not configured");
  }
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...noStoreHeaders() },
  });
}

function html(body) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...noStoreHeaders(),
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function adminHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sub302 控制台</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-soft: #f9fafb;
      --text: #111827;
      --muted: #667085;
      --line: #d9dee7;
      --line-soft: #eaedf2;
      --primary: #0f766e;
      --primary-strong: #115e59;
      --primary-soft: #d9f4ef;
      --accent: #b7791f;
      --danger: #c2410c;
      --danger-soft: #fff1e8;
      --shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
    }

    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    button, input, textarea, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      padding: 10px 11px;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease;
    }
    textarea { min-height: 90px; resize: vertical; line-height: 1.55; }
    input:focus, textarea:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(15, 118, 110, .14); }
    label { display: block; font-size: 12px; color: var(--muted); font-weight: 700; margin: 0 0 7px; }
    code { padding: 2px 5px; border-radius: 6px; background: #eef2f6; color: #263241; word-break: break-all; }

    .hidden { display: none !important; }
    .auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .auth-card { width: min(420px, 100%); background: var(--panel); border: 1px solid var(--line-soft); border-radius: 8px; box-shadow: var(--shadow); padding: 24px; }
    .brand-row { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
    .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 8px; background: var(--primary); color: #fff; font-weight: 900; }
    h1, h2, h3, p { margin: 0; }
    .brand-row h1 { font-size: 24px; }
    .brand-row p, .muted { color: var(--muted); }
    .muted { font-size: 13px; line-height: 1.55; }
    .auth-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; }

    .app-shell { min-height: 100vh; display: grid; grid-template-columns: 250px minmax(0, 1fr); }
    .sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 18px; padding: 18px; border-right: 1px solid var(--line-soft); background: #ffffff; }
    .nav { display: grid; gap: 6px; }
    .nav button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 38px;
      border-radius: 8px;
      padding: 0 11px;
      background: transparent;
      color: #344054;
      font-weight: 700;
      text-align: left;
    }
    .nav button:hover { background: var(--panel-soft); }
    .nav button.active { background: var(--primary-soft); color: var(--primary-strong); }
    .sidebar-footer { margin-top: auto; display: grid; gap: 10px; }
    .main { min-width: 0; padding: 20px 24px 44px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .topbar h2 { font-size: 24px; }
    .topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { display: inline-flex; align-items: center; min-height: 28px; padding: 0 9px; border-radius: 999px; background: #eef2f6; color: #475467; font-size: 12px; font-weight: 800; }
    .panel { display: none; }
    .panel.active { display: grid; gap: 16px; }

    .grid { display: grid; gap: 14px; }
    .grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .surface, .metric, .item-card {
      background: var(--panel);
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      box-shadow: 0 8px 26px rgba(15, 23, 42, 0.04);
    }
    .surface { padding: 16px; }
    .surface-head, .item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
    .surface-head h3, .item-head h3 { font-size: 16px; }
    .metric { padding: 14px; min-height: 92px; display: flex; flex-direction: column; justify-content: space-between; }
    .metric span { color: var(--muted); font-size: 12px; font-weight: 800; }
    .metric strong { font-size: 27px; line-height: 1; }
    .form-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field-full { grid-column: 1 / -1; }
    .check-row { display: flex; align-items: center; gap: 9px; min-height: 38px; color: #344054; font-weight: 700; }
    .check-row input { width: auto; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    .btn {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border-radius: 8px;
      padding: 0 13px;
      font-weight: 800;
      background: var(--primary);
      color: #fff;
    }
    .btn:hover { background: var(--primary-strong); }
    .btn.secondary { background: #eef2f6; color: #334155; }
    .btn.secondary:hover { background: #e3e8ef; }
    .btn.danger { background: var(--danger-soft); color: var(--danger); }
    .btn.danger:hover { background: #ffe1cf; }
    .btn.ghost { background: transparent; color: #475467; }
    .btn.ghost:hover { background: #eef2f6; }
    .btn.small { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .status { display: inline-flex; align-items: center; border-radius: 999px; min-height: 24px; padding: 0 8px; font-size: 12px; font-weight: 800; }
    .status.on { color: #047857; background: #dcfce7; }
    .status.off { color: #9a3412; background: #ffedd5; }
    .list { display: grid; gap: 10px; }
    .item-card { padding: 14px; }
    .item-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 7px; }
    .item-body { display: grid; gap: 9px; }
    .mono-line { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; line-height: 1.55; padding: 9px 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: #f8fafc; word-break: break-all; }
    .choice-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .choice {
      display: flex;
      gap: 9px;
      align-items: flex-start;
      padding: 10px;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: #fff;
    }
    .choice input { width: auto; margin-top: 2px; }
    .choice strong { display: block; font-size: 13px; }
    .choice span { display: block; color: var(--muted); font-size: 12px; line-height: 1.45; word-break: break-all; }
    .empty { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; background: #fff; }
    .toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; min-width: 220px; max-width: 360px; background: #111827; color: #fff; border-radius: 8px; padding: 11px 13px; box-shadow: var(--shadow); }
    .toast.error { background: #7f1d1d; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { text-align: left; border-bottom: 1px solid var(--line-soft); padding: 10px 8px; vertical-align: top; }
    .table th { color: var(--muted); font-size: 12px; }

    @media (max-width: 980px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line-soft); }
      .nav { grid-template-columns: repeat(5, minmax(0, 1fr)); overflow-x: auto; }
      .nav button { justify-content: center; white-space: nowrap; }
      .main { padding: 16px; }
      .grid.cols-4, .grid.cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 680px) {
      .topbar, .surface-head, .item-head { display: grid; }
      .form-grid, .grid.cols-2, .grid.cols-3, .grid.cols-4, .choice-list { grid-template-columns: 1fr; }
      .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .actions, .topbar-actions { justify-content: stretch; }
      .btn { width: 100%; }
      .btn.small { width: auto; }
    }
  </style>
</head>
<body>
  <section id="loginView" class="auth-screen">
    <div class="auth-card">
      <div class="brand-row">
        <div class="brand-mark">302</div>
        <div>
          <h1>Sub302</h1>
          <p class="muted">订阅重定向控制台</p>
        </div>
      </div>
      <form id="loginForm">
        <label for="password">管理密码</label>
        <input id="password" type="password" autocomplete="current-password" placeholder="SUB302_ADMIN_PASSWORD" />
        <div class="auth-actions">
          <button class="btn" type="submit">登录</button>
          <span id="loginMsg" class="muted"></span>
        </div>
      </form>
    </div>
  </section>

  <section id="appView" class="app-shell hidden">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark">302</div>
        <div>
          <h1 id="brandTitle">Sub302</h1>
          <p class="muted">Redirect only</p>
        </div>
      </div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-tab="dashboard" type="button">仪表盘</button>
        <button data-tab="airports" type="button">机场订阅</button>
        <button data-tab="nodes" type="button">手动节点</button>
        <button data-tab="profiles" type="button">我的订阅</button>
        <button data-tab="settings" type="button">设置</button>
      </nav>
      <div class="sidebar-footer">
        <span id="baseBadge" class="badge">未加载</span>
        <button id="logoutBtn" class="btn secondary" type="button">退出登录</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <h2 id="pageTitle">仪表盘</h2>
          <p id="pageSubtitle" class="muted">固定入口只返回 302，订阅处理交给本地 Sub-Store。</p>
        </div>
        <div class="topbar-actions">
          <span id="statusBadge" class="badge">Ready</span>
          <button class="btn secondary small" data-action="copy-base" type="button">复制基址</button>
        </div>
      </header>

      <section id="panel-dashboard" class="panel active">
        <div class="grid cols-4">
          <div class="metric"><span>机场订阅</span><strong id="metricAirports">0</strong></div>
          <div class="metric"><span>手动节点</span><strong id="metricNodes">0</strong></div>
          <div class="metric"><span>订阅组</span><strong id="metricProfiles">0</strong></div>
          <div class="metric"><span>启用入口</span><strong id="metricEnabled">0</strong></div>
        </div>
        <div class="grid cols-2">
          <section class="surface">
            <div class="surface-head">
              <div>
                <h3>最近更新</h3>
                <p class="muted">机场订阅和订阅组的最近变更。</p>
              </div>
            </div>
            <div id="recentList" class="list"></div>
          </section>
          <section class="surface">
            <div class="surface-head">
              <div>
                <h3>公开入口</h3>
                <p class="muted">当前 Worker 对外展示的固定链接基址。</p>
              </div>
            </div>
            <div class="mono-line" id="baseUrlLine"></div>
            <div class="actions" style="margin-top: 12px;">
              <button class="btn small" data-tab="airports" type="button">新增机场订阅</button>
              <button class="btn secondary small" data-tab="profiles" type="button">管理订阅组</button>
            </div>
          </section>
        </div>
      </section>

      <section id="panel-airports" class="panel">
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>机场订阅</h3>
              <p class="muted">每条记录会生成一个固定 Sub302 链接，访问时只 302 到真实订阅 URL。</p>
            </div>
            <button class="btn secondary small" data-action="reset-airport" type="button">清空表单</button>
          </div>
          <form id="airportForm" class="form-grid">
            <input id="airportId" type="hidden" />
            <div>
              <label for="airportName">名称</label>
              <input id="airportName" placeholder="示例：主力机场" />
            </div>
            <div>
              <label for="airportSlug">固定路径 slug</label>
              <input id="airportSlug" placeholder="main-sub" />
            </div>
            <div class="field-full">
              <label for="airportUrl">真实订阅 URL</label>
              <input id="airportUrl" placeholder="https://example.com/api/sub?token=..." />
            </div>
            <div class="field-full">
              <label for="airportRemark">备注</label>
              <textarea id="airportRemark" placeholder="可选"></textarea>
            </div>
            <label class="check-row field-full"><input id="airportEnabled" type="checkbox" checked />启用这条订阅</label>
            <div class="actions field-full">
              <button class="btn" type="submit">保存机场订阅</button>
              <span id="airportMsg" class="muted"></span>
            </div>
          </form>
        </section>
        <div id="airportList" class="list"></div>
      </section>

      <section id="panel-nodes" class="panel">
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>手动节点</h3>
              <p class="muted">手动节点会进入订阅组清单，Sub302 不解析、不改写节点内容。</p>
            </div>
            <button class="btn secondary small" data-action="reset-node" type="button">清空表单</button>
          </div>
          <form id="nodeForm" class="form-grid">
            <input id="nodeId" type="hidden" />
            <div>
              <label for="nodeName">名称</label>
              <input id="nodeName" placeholder="示例：备用节点" />
            </div>
            <div>
              <label for="nodeEnabled">状态</label>
              <label class="check-row"><input id="nodeEnabled" type="checkbox" checked />启用</label>
            </div>
            <div class="field-full">
              <label for="nodeUri">节点 URI</label>
              <textarea id="nodeUri" placeholder="vless://... 或 ss://..."></textarea>
            </div>
            <div class="field-full">
              <label for="nodeRemark">备注</label>
              <textarea id="nodeRemark" placeholder="可选"></textarea>
            </div>
            <div class="actions field-full">
              <button class="btn" type="submit">保存手动节点</button>
              <span id="nodeMsg" class="muted"></span>
            </div>
          </form>
        </section>
        <div id="nodeList" class="list"></div>
      </section>

      <section id="panel-profiles" class="panel">
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>我的订阅</h3>
              <p class="muted">订阅组可输出引用清单，或 302 到一个你指定的聚合订阅地址。</p>
            </div>
            <button class="btn secondary small" data-action="reset-profile" type="button">清空表单</button>
          </div>
          <form id="profileForm" class="form-grid">
            <input id="profileId" type="hidden" />
            <div>
              <label for="profileName">名称</label>
              <input id="profileName" placeholder="示例：Sub-Store 汇总" />
            </div>
            <div>
              <label for="profileSlug">订阅组 slug</label>
              <input id="profileSlug" placeholder="my-sub" />
            </div>
            <div>
              <label for="profileOutput">输出方式</label>
              <select id="profileOutput">
                <option value="list">引用清单</option>
                <option value="redirect">302 到聚合地址</option>
              </select>
            </div>
            <label class="check-row"><input id="profileEnabled" type="checkbox" checked />启用订阅组</label>
            <div id="profileRedirectField" class="field-full hidden">
              <label for="profileRedirectTarget">聚合订阅地址</label>
              <input id="profileRedirectTarget" placeholder="https://sub-store.example/download/collection/..." />
            </div>
            <div class="field-full">
              <label>选择机场订阅</label>
              <div id="profileAirportChoices" class="choice-list"></div>
            </div>
            <div class="field-full">
              <label>选择手动节点</label>
              <div id="profileNodeChoices" class="choice-list"></div>
            </div>
            <div class="field-full">
              <label for="profileRemark">备注</label>
              <textarea id="profileRemark" placeholder="可选"></textarea>
            </div>
            <div class="actions field-full">
              <button class="btn" type="submit">保存订阅组</button>
              <span id="profileMsg" class="muted"></span>
            </div>
          </form>
        </section>
        <div id="profileList" class="list"></div>
      </section>

      <section id="panel-settings" class="panel">
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>设置</h3>
              <p class="muted">这些设置保存在 Cloudflare KV，不影响真实订阅内容。</p>
            </div>
          </div>
          <form id="settingsForm" class="form-grid">
            <div>
              <label for="siteName">控制台名称</label>
              <input id="siteName" placeholder="Sub302" />
            </div>
            <div>
              <label for="redirectStatusCode">重定向状态码</label>
              <select id="redirectStatusCode">
                <option value="302">302 Found</option>
                <option value="307">307 Temporary Redirect</option>
                <option value="308">308 Permanent Redirect</option>
                <option value="303">303 See Other</option>
              </select>
            </div>
            <div>
              <label for="publicBaseUrl">公开基址</label>
              <input id="publicBaseUrl" placeholder="留空时使用当前域名" />
            </div>
            <div>
              <label for="profilePrefix">订阅组前缀</label>
              <input id="profilePrefix" placeholder="p" />
            </div>
            <label class="check-row field-full"><input id="allowLegacyRootRoutes" type="checkbox" checked />允许根路径固定入口</label>
            <div class="actions field-full">
              <button class="btn" type="submit">保存设置</button>
              <span id="settingsMsg" class="muted"></span>
            </div>
          </form>
        </section>
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>备份</h3>
              <p class="muted">导出或导入 Sub302 的 KV 数据。</p>
            </div>
            <div class="actions">
              <button class="btn secondary small" data-action="export-backup" type="button">导出</button>
              <button class="btn danger small" data-action="import-backup" type="button">导入</button>
            </div>
          </div>
          <textarea id="backupBox" placeholder="导出的 JSON 会显示在这里"></textarea>
        </section>
      </section>
    </main>
  </section>

  <div id="toast" class="toast hidden"></div>

<script>
const state = {
  activeTab: "dashboard",
  data: null
};

const titles = {
  dashboard: ["仪表盘", "固定入口只返回 302，订阅处理交给本地 Sub-Store。"],
  airports: ["机场订阅", "维护真实订阅 URL，并生成长期不变的 Sub302 固定入口。"],
  nodes: ["手动节点", "保存单条节点，供订阅组清单引用。"],
  profiles: ["我的订阅", "把机场订阅和手动节点组织成可复制或可访问的订阅组。"],
  settings: ["设置", "管理公开基址、重定向状态码和数据备份。"]
};

function $(id) {
  return document.getElementById(id);
}

async function api(path, options) {
  const init = options || {};
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    ...init
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const error = new Error(data.error || res.statusText || "Request failed");
    error.status = res.status;
    throw error;
  }
  return data;
}

async function loadData() {
  const result = await api("/api/data");
  state.data = result.data;
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  renderAll();
}

function renderAll() {
  renderShell();
  renderDashboard();
  renderAirports();
  renderNodes();
  renderProfiles();
  renderSettings();
}

function renderShell() {
  const settings = state.data.settings;
  const title = titles[state.activeTab] || titles.dashboard;
  $("brandTitle").textContent = settings.siteName || "Sub302";
  $("pageTitle").textContent = title[0];
  $("pageSubtitle").textContent = title[1];
  $("baseBadge").textContent = baseUrl();
  $("statusBadge").textContent = settings.redirectStatusCode + " redirect";
  document.querySelectorAll("[data-tab]").forEach(function (button) {
    const tab = button.getAttribute("data-tab");
    button.classList.toggle("active", tab === state.activeTab);
  });
  document.querySelectorAll(".panel").forEach(function (panel) {
    panel.classList.toggle("active", panel.id === "panel-" + state.activeTab);
  });
}

function renderDashboard() {
  const data = state.data;
  const enabledAirports = data.airports.filter(function (item) { return item.enabled; }).length;
  const enabledProfiles = data.profiles.filter(function (item) { return item.enabled; }).length;
  $("metricAirports").textContent = data.airports.length;
  $("metricNodes").textContent = data.manualNodes.length;
  $("metricProfiles").textContent = data.profiles.length;
  $("metricEnabled").textContent = enabledAirports + enabledProfiles;
  $("baseUrlLine").textContent = baseUrl();

  const recent = data.airports.map(function (item) {
    return { type: "机场订阅", name: item.name, date: item.updatedAt, detail: airportUrl(item) };
  }).concat(data.profiles.map(function (item) {
    return { type: "订阅组", name: item.name, date: item.updatedAt, detail: profileUrl(item) };
  })).sort(function (a, b) {
    return String(b.date || "").localeCompare(String(a.date || ""));
  }).slice(0, 5);

  $("recentList").innerHTML = recent.length ? recent.map(function (item) {
    return '<article class="item-card"><div class="item-head"><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="badge">' + esc(item.type) + '</span><span class="muted">' + fmtDate(item.date) + '</span></div></div></div><div class="mono-line">' + esc(item.detail) + '</div></article>';
  }).join("") : '<div class="empty">还没有订阅数据</div>';
}

function renderAirports() {
  const list = state.data.airports;
  $("airportList").innerHTML = list.length ? list.map(function (item) {
    const fixed = airportUrl(item);
    return '<article class="item-card">' +
      '<div class="item-head"><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "停用") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(fixed) + '" type="button">复制入口</button><button class="btn secondary small" data-action="edit-airport" data-id="' + attr(item.id) + '" type="button">编辑</button><button class="btn danger small" data-action="delete-airport" data-id="' + attr(item.id) + '" type="button">删除</button></div></div>' +
      '<div class="item-body"><div class="mono-line">' + esc(fixed) + '</div><div class="mono-line">' + esc(item.url) + '</div>' + (item.remark ? '<p class="muted">' + esc(item.remark) + '</p>' : '') + '</div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有机场订阅</div>';
}

function renderNodes() {
  const list = state.data.manualNodes;
  $("nodeList").innerHTML = list.length ? list.map(function (item) {
    return '<article class="item-card">' +
      '<div class="item-head"><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "停用") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(item.uri) + '" type="button">复制节点</button><button class="btn secondary small" data-action="edit-node" data-id="' + attr(item.id) + '" type="button">编辑</button><button class="btn danger small" data-action="delete-node" data-id="' + attr(item.id) + '" type="button">删除</button></div></div>' +
      '<div class="item-body"><div class="mono-line">' + esc(item.uri) + '</div>' + (item.remark ? '<p class="muted">' + esc(item.remark) + '</p>' : '') + '</div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有手动节点</div>';
}

function renderProfiles() {
  renderProfileChoices();
  const list = state.data.profiles;
  $("profileList").innerHTML = list.length ? list.map(function (item) {
    const link = profileUrl(item);
    const items = profileItems(item);
    return '<article class="item-card">' +
      '<div class="item-head"><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "停用") + '</span><span class="badge">' + (item.output === "redirect" ? "302 聚合地址" : "引用清单") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(link) + '" type="button">复制链接</button><button class="btn secondary small" data-action="copy-profile-items" data-id="' + attr(item.id) + '" type="button">复制成员</button><button class="btn secondary small" data-action="edit-profile" data-id="' + attr(item.id) + '" type="button">编辑</button><button class="btn danger small" data-action="delete-profile" data-id="' + attr(item.id) + '" type="button">删除</button></div></div>' +
      '<div class="item-body"><div class="mono-line">' + esc(link) + '</div>' +
      (item.output === "redirect" ? '<div class="mono-line">' + esc(item.redirectTarget) + '</div>' : '<p class="muted">成员数量：' + items.length + '</p>') +
      (item.remark ? '<p class="muted">' + esc(item.remark) + '</p>' : '') + '</div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有订阅组</div>';
}

function renderProfileChoices(selectedProfile) {
  const profile = selectedProfile || currentProfileForm();
  const selectedAirports = new Set(profile.subscriptionIds || []);
  const selectedNodes = new Set(profile.nodeIds || []);
  $("profileAirportChoices").innerHTML = state.data.airports.length ? state.data.airports.map(function (item) {
    return '<label class="choice"><input type="checkbox" name="profileAirport" value="' + attr(item.id) + '"' + (selectedAirports.has(item.id) ? " checked" : "") + ' /><span><strong>' + esc(item.name) + '</strong><span>' + esc(airportUrl(item)) + '</span></span></label>';
  }).join("") : '<div class="empty">先添加机场订阅</div>';
  $("profileNodeChoices").innerHTML = state.data.manualNodes.length ? state.data.manualNodes.map(function (item) {
    return '<label class="choice"><input type="checkbox" name="profileNode" value="' + attr(item.id) + '"' + (selectedNodes.has(item.id) ? " checked" : "") + ' /><span><strong>' + esc(item.name) + '</strong><span>' + esc(item.uri) + '</span></span></label>';
  }).join("") : '<div class="empty">没有手动节点也可以保存订阅组</div>';
}

function renderSettings() {
  const settings = state.data.settings;
  $("siteName").value = settings.siteName || "Sub302";
  $("publicBaseUrl").value = settings.publicBaseUrl || "";
  $("redirectStatusCode").value = settings.redirectStatusCode || "302";
  $("profilePrefix").value = settings.profilePrefix || "p";
  $("allowLegacyRootRoutes").checked = settings.allowLegacyRootRoutes !== false;
}

function currentProfileForm() {
  return {
    subscriptionIds: Array.from(document.querySelectorAll('input[name="profileAirport"]:checked')).map(function (input) { return input.value; }),
    nodeIds: Array.from(document.querySelectorAll('input[name="profileNode"]:checked')).map(function (input) { return input.value; })
  };
}

async function saveAirport(event) {
  event.preventDefault();
  const payload = {
    id: $("airportId").value,
    name: $("airportName").value,
    slug: $("airportSlug").value,
    url: $("airportUrl").value,
    remark: $("airportRemark").value,
    enabled: $("airportEnabled").checked
  };
  await saveEntity("/api/airports", payload, "airportMsg", resetAirportForm);
}

async function saveNode(event) {
  event.preventDefault();
  const payload = {
    id: $("nodeId").value,
    name: $("nodeName").value,
    uri: $("nodeUri").value,
    remark: $("nodeRemark").value,
    enabled: $("nodeEnabled").checked
  };
  await saveEntity("/api/manual-nodes", payload, "nodeMsg", resetNodeForm);
}

async function saveProfile(event) {
  event.preventDefault();
  const selected = currentProfileForm();
  const payload = {
    id: $("profileId").value,
    name: $("profileName").value,
    slug: $("profileSlug").value,
    output: $("profileOutput").value,
    redirectTarget: $("profileRedirectTarget").value,
    subscriptionIds: selected.subscriptionIds,
    nodeIds: selected.nodeIds,
    remark: $("profileRemark").value,
    enabled: $("profileEnabled").checked
  };
  await saveEntity("/api/profiles", payload, "profileMsg", resetProfileForm);
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    siteName: $("siteName").value,
    publicBaseUrl: $("publicBaseUrl").value,
    redirectStatusCode: $("redirectStatusCode").value,
    profilePrefix: $("profilePrefix").value,
    allowLegacyRootRoutes: $("allowLegacyRootRoutes").checked
  };
  await saveEntity("/api/settings", payload, "settingsMsg", null);
}

async function saveEntity(path, payload, msgId, afterSave) {
  const msg = $(msgId);
  msg.textContent = "";
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
    state.data = result.data || state.data;
    if (afterSave) afterSave();
    renderAll();
    msg.textContent = "已保存";
    toast("已保存");
  } catch (error) {
    msg.textContent = error.message;
    toast(error.message, true);
  }
}

function editAirport(id) {
  const item = state.data.airports.find(function (entry) { return entry.id === id; });
  if (!item) return;
  $("airportId").value = item.id;
  $("airportName").value = item.name;
  $("airportSlug").value = item.slug;
  $("airportUrl").value = item.url;
  $("airportRemark").value = item.remark || "";
  $("airportEnabled").checked = item.enabled !== false;
  setTab("airports");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function editNode(id) {
  const item = state.data.manualNodes.find(function (entry) { return entry.id === id; });
  if (!item) return;
  $("nodeId").value = item.id;
  $("nodeName").value = item.name;
  $("nodeUri").value = item.uri;
  $("nodeRemark").value = item.remark || "";
  $("nodeEnabled").checked = item.enabled !== false;
  setTab("nodes");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function editProfile(id) {
  const item = state.data.profiles.find(function (entry) { return entry.id === id; });
  if (!item) return;
  $("profileId").value = item.id;
  $("profileName").value = item.name;
  $("profileSlug").value = item.slug;
  $("profileOutput").value = item.output || "list";
  $("profileRedirectTarget").value = item.redirectTarget || "";
  $("profileRemark").value = item.remark || "";
  $("profileEnabled").checked = item.enabled !== false;
  renderProfileChoices(item);
  updateProfileOutput();
  setTab("profiles");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteEntity(kind, id) {
  const labels = { airport: "机场订阅", node: "手动节点", profile: "订阅组" };
  if (!confirm("确定删除这个" + labels[kind] + "？")) return;
  const paths = { airport: "/api/airports/", node: "/api/manual-nodes/", profile: "/api/profiles/" };
  try {
    const result = await api(paths[kind] + encodeURIComponent(id), { method: "DELETE" });
    state.data = result.data || state.data;
    renderAll();
    toast("已删除");
  } catch (error) {
    toast(error.message, true);
  }
}

function resetAirportForm() {
  $("airportForm").reset();
  $("airportId").value = "";
  $("airportEnabled").checked = true;
}

function resetNodeForm() {
  $("nodeForm").reset();
  $("nodeId").value = "";
  $("nodeEnabled").checked = true;
}

function resetProfileForm() {
  $("profileForm").reset();
  $("profileId").value = "";
  $("profileEnabled").checked = true;
  $("profileOutput").value = "list";
  $("profileRedirectTarget").value = "";
  renderProfileChoices({ subscriptionIds: [], nodeIds: [] });
  updateProfileOutput();
}

function updateProfileOutput() {
  $("profileRedirectField").classList.toggle("hidden", $("profileOutput").value !== "redirect");
}

function setTab(tab) {
  state.activeTab = tab;
  renderShell();
}

function airportUrl(item) {
  const prefix = state.data.settings.allowLegacyRootRoutes === false ? "/r/" : "/";
  return baseUrl() + prefix + item.slug;
}

function profileUrl(item) {
  const prefix = state.data.settings.profilePrefix || "p";
  return baseUrl() + "/" + prefix + "/" + item.slug;
}

function baseUrl() {
  return (state.data && state.data.settings.publicBaseUrl) || location.origin;
}

function profileItems(profile) {
  const airports = new Map(state.data.airports.map(function (item) { return [item.id, item]; }));
  const nodes = new Map(state.data.manualNodes.map(function (item) { return [item.id, item]; }));
  const items = [];
  (profile.subscriptionIds || []).forEach(function (id) {
    const item = airports.get(id);
    if (item && item.enabled) items.push(airportUrl(item));
  });
  (profile.nodeIds || []).forEach(function (id) {
    const item = nodes.get(id);
    if (item && item.enabled) items.push(item.uri);
  });
  return Array.from(new Set(items));
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  toast("已复制");
}

function fmtDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function esc(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
  });
}

function attr(value) {
  return esc(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
}

let toastTimer;
function toast(message, isError) {
  const box = $("toast");
  clearTimeout(toastTimer);
  box.textContent = message;
  box.classList.toggle("error", Boolean(isError));
  box.classList.remove("hidden");
  toastTimer = setTimeout(function () { box.classList.add("hidden"); }, 2300);
}

async function login(event) {
  event.preventDefault();
  $("loginMsg").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
    await loadData();
  } catch (error) {
    $("loginMsg").textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(function () {});
  location.reload();
}

function bindEvents() {
  $("loginForm").addEventListener("submit", login);
  $("logoutBtn").addEventListener("click", logout);
  $("airportForm").addEventListener("submit", saveAirport);
  $("nodeForm").addEventListener("submit", saveNode);
  $("profileForm").addEventListener("submit", saveProfile);
  $("settingsForm").addEventListener("submit", saveSettings);
  $("profileOutput").addEventListener("change", updateProfileOutput);

  document.addEventListener("click", async function (event) {
    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      setTab(tabButton.getAttribute("data-tab"));
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.getAttribute("data-action");
    const id = actionButton.getAttribute("data-id");

    if (action === "copy") return copyText(actionButton.getAttribute("data-value"));
    if (action === "copy-base") return copyText(baseUrl());
    if (action === "edit-airport") return editAirport(id);
    if (action === "edit-node") return editNode(id);
    if (action === "edit-profile") return editProfile(id);
    if (action === "delete-airport") return deleteEntity("airport", id);
    if (action === "delete-node") return deleteEntity("node", id);
    if (action === "delete-profile") return deleteEntity("profile", id);
    if (action === "reset-airport") return resetAirportForm();
    if (action === "reset-node") return resetNodeForm();
    if (action === "reset-profile") return resetProfileForm();
    if (action === "copy-profile-items") {
      const profile = state.data.profiles.find(function (item) { return item.id === id; });
      return copyText(profile ? profileItems(profile).join("\\n") : "");
    }
    if (action === "export-backup") {
      $("backupBox").value = JSON.stringify(state.data, null, 2);
      return toast("已导出");
    }
    if (action === "import-backup") {
      if (!confirm("导入会覆盖当前 KV 数据，确定继续？")) return;
      try {
        const parsed = JSON.parse($("backupBox").value || "{}");
        const result = await api("/api/backup", { method: "POST", body: JSON.stringify(parsed) });
        state.data = result.data;
        renderAll();
        toast("已导入");
      } catch (error) {
        toast(error.message, true);
      }
    }
  });
}

bindEvents();
loadData().catch(function (error) {
  $("loginView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  if (error.status && error.status !== 401) $("loginMsg").textContent = error.message;
});
</script>
</body>
</html>`;
}
