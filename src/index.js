const DATA_KEY = "sub302:data:v2";
const LEGACY_ROUTES_KEY = "routes:v1";
const SESSION_COOKIE = "sub302_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const DEFAULT_SETTINGS = {
  siteName: "Sub302",
  publicBaseUrl: "",
  redirectStatusCode: "302",
  profilePrefix: "p",
  profileListEncoding: "base64",
  accessToken: "",
  adminPath: "admin",
  allowLegacyRootRoutes: true,
};

const REDIRECT_STATUS_CODES = new Set([302, 303, 307, 308]);
const RESERVED_ROOT_SLUGS = new Set([
  "api",
  "assets",
  "favicon.ico",
  "favicon.png",
  "favicon.svg",
  "logo.png",
  "p",
  "profile",
  "r",
  "sub",
  "token",
]);

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png" || url.pathname === "/favicon.svg") {
        return redirectToLogo();
      }

      if (url.pathname === "/logo.png") {
        return await serveStaticAsset(context);
      }

      const adminPath = await getAdminPath(env);

      if (isAdminPath(url.pathname, adminPath)) {
        return html(adminHtml(adminPath));
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }

      if (url.pathname === "/") {
        return new Response("Not found", { status: 404, headers: noStoreHeaders() });
      }

      return await handlePublicRequest(request, env, url);
    } catch (err) {
      return json({ ok: false, error: err?.message || "Internal error" }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const adminAccess = await requireAdminPathAccess(request, env);
  if (!adminAccess.ok) return json({ ok: false, error: "Not found" }, 404);

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
  if (slug.toLowerCase() === store.settings.adminPath.toLowerCase()) {
    return json({ ok: false, error: "Slug conflicts with the admin path" }, 400);
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
  const access = resolvePublicAccess(url, store.settings);
  if (!access.ok) {
    return new Response("Not found", { status: 404, headers: noStoreHeaders() });
  }

  url = access.url;
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
  const encoding = resolveProfileListEncoding(url, store.settings);
  const responseBody = encoding === "base64" ? base64EncodeUtf8(body) : body;
  return new Response(request.method === "HEAD" ? null : responseBody, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Sub302-Mode": encoding === "base64" ? "reference-list-base64" : "reference-list-raw",
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
    if (item?.enabled && item.uri) items.push(renameNodeUri(item.uri, item.name));
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
  let profilePrefix = normalizeSlug(source.profilePrefix || DEFAULT_SETTINGS.profilePrefix) || DEFAULT_SETTINGS.profilePrefix;
  const adminPath = normalizeAdminPath(source.adminPath || DEFAULT_SETTINGS.adminPath);
  const accessToken = normalizeAccessToken(source.accessToken || source.publicToken || "");
  const profileListEncoding = ["raw", "base64"].includes(source.profileListEncoding) ? source.profileListEncoding : DEFAULT_SETTINGS.profileListEncoding;
  if (profilePrefix === adminPath) profilePrefix = DEFAULT_SETTINGS.profilePrefix;

  return {
    siteName: String(source.siteName || DEFAULT_SETTINGS.siteName).trim().slice(0, 48) || DEFAULT_SETTINGS.siteName,
    publicBaseUrl: isHttpUrl(publicBaseUrl) ? publicBaseUrl : "",
    redirectStatusCode: String(REDIRECT_STATUS_CODES.has(status) ? status : 302),
    profilePrefix: RESERVED_ROOT_SLUGS.has(profilePrefix) && profilePrefix !== "p" ? "p" : profilePrefix,
    profileListEncoding,
    accessToken,
    adminPath,
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

function normalizeAdminPath(value) {
  const path = normalizeSlug(value) || DEFAULT_SETTINGS.adminPath;
  return RESERVED_ROOT_SLUGS.has(path.toLowerCase()) ? DEFAULT_SETTINGS.adminPath : path;
}

function normalizeAccessToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._~-]+/g, "")
    .slice(0, 96);
}

function isAdminPath(pathname, adminPath) {
  return normalizeSlug(pathname) === adminPath;
}

async function getAdminPath(env) {
  try {
    if (!env.SUB302_KV) return DEFAULT_SETTINGS.adminPath;
    const raw = await env.SUB302_KV.get(DATA_KEY);
    if (!raw) return DEFAULT_SETTINGS.adminPath;
    const parsed = JSON.parse(raw);
    return sanitizeSettings(parsed?.settings || {}).adminPath;
  } catch {
    return DEFAULT_SETTINGS.adminPath;
  }
}

async function requireAdminPathAccess(request, env) {
  const adminPath = await getAdminPath(env);
  const headerPath = request.headers.get("X-Sub302-Admin-Path") || "";
  const refererPath = getRefererPath(request.headers.get("Referer") || "");
  const candidate = headerPath || refererPath;
  return { ok: normalizeSlug(candidate) === adminPath };
}

function getRefererPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueStrings(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function resolveProfileListEncoding(url, settings) {
  const explicit = String(url.searchParams.get("format") || url.searchParams.get("target") || "").toLowerCase();
  if (["raw", "plain", "nodes", "list"].includes(explicit) || url.searchParams.get("raw") === "1") return "raw";
  if (["base64", "v2ray"].includes(explicit) || url.searchParams.has("base64")) return "base64";
  return settings.profileListEncoding === "raw" ? "raw" : "base64";
}

function renameNodeUri(uri, name) {
  const nodeUri = String(uri || "").trim();
  const nodeName = String(name || "").trim();
  if (!nodeUri || !nodeName) return nodeUri;

  const scheme = (nodeUri.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] || "").toLowerCase();
  if (scheme === "vmess") return renameVmessUri(nodeUri, nodeName);
  if (scheme === "ssr") return renameSsrUri(nodeUri, nodeName);
  return setNodeUriFragment(nodeUri, nodeName);
}

function renameVmessUri(uri, name) {
  try {
    const payload = uri.slice("vmess://".length).split(/[?#]/)[0];
    const config = JSON.parse(base64DecodeUtf8(payload));
    config.ps = name;
    return `vmess://${base64EncodeUtf8(JSON.stringify(config))}`;
  } catch {
    return setNodeUriFragment(uri, name);
  }
}

function renameSsrUri(uri, name) {
  try {
    const payload = uri.slice("ssr://".length).split("#")[0];
    const decoded = base64DecodeUtf8(payload);
    const marker = "/?";
    const markerIndex = decoded.indexOf(marker);
    if (markerIndex === -1) return setNodeUriFragment(uri, name);

    const base = decoded.slice(0, markerIndex + marker.length);
    const params = new URLSearchParams(decoded.slice(markerIndex + marker.length));
    params.set("remarks", base64UrlEncodeUtf8(name));
    return `ssr://${base64UrlEncodeUtf8(base + params.toString())}`;
  } catch {
    return setNodeUriFragment(uri, name);
  }
}

function setNodeUriFragment(uri, name) {
  const hashIndex = uri.lastIndexOf("#");
  const base = hashIndex === -1 ? uri : uri.slice(0, hashIndex);
  return `${base}#${encodeURIComponent(name)}`;
}

function normalizeBase64(value) {
  let normalized = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding) normalized += "=".repeat(4 - padding);
  return normalized;
}

function base64DecodeUtf8(value) {
  const binary = atob(normalizeBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64UrlEncodeUtf8(value) {
  return base64EncodeUtf8(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || ""));
}

function buildAirportPublicUrl(request, settings, item) {
  const path = settings.allowLegacyRootRoutes === false ? `r/${item.slug}` : item.slug;
  return `${publicBaseUrl(request, settings)}${buildPublicPath(settings, path)}`;
}

function buildProfilePublicUrl(request, settings, item) {
  const prefix = normalizeSlug(settings.profilePrefix) || DEFAULT_SETTINGS.profilePrefix;
  return `${publicBaseUrl(request, settings)}${buildPublicPath(settings, `${prefix}/${item.slug}`)}`;
}

function publicBaseUrl(request, settings) {
  return settings.publicBaseUrl || new URL(request.url).origin;
}

function buildPublicPath(settings, routePath) {
  const cleanPath = String(routePath || "").replace(/^\/+/, "");
  const token = normalizeAccessToken(settings.accessToken);
  return token ? `/token=${encodeURIComponent(token)}?${cleanPath}` : `/${cleanPath}`;
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

function redirectToLogo() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/logo.png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function serveStaticAsset(context) {
  if (context && typeof context.next === "function") {
    const response = await context.next();
    if (response && response.status !== 404) return response;
  }
  return new Response("Not found", { status: 404, headers: noStoreHeaders() });
}

function resolvePublicAccess(url, settings) {
  const token = normalizeAccessToken(settings.accessToken);
  if (!token) return { ok: true, url };

  const parsed = parseTokenizedPublicUrl(url);
  if (!parsed || parsed.token !== token) return { ok: false };
  return { ok: true, url: parsed.url };
}

function parseTokenizedPublicUrl(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || !segments[0].startsWith("token=")) return null;

  const token = normalizeAccessToken(segments[0].slice("token=".length));
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
  if (!token || !rawQuery) return null;

  try {
    const parts = rawQuery.split("&");
    const route = decodeURIComponent(parts.shift() || "").replace(/^\/+/, "");
    if (!route) return null;

    const next = new URL(url.toString());
    next.pathname = `/${route}`;
    next.search = parts.length ? `?${parts.join("&")}` : "";
    return { token, url: next };
  } catch {
    return null;
  }
}

function uiIcon(name) {
  const icons = {
    logo: '<svg class="brand-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.8 6.2h7.8a4.4 4.4 0 0 1 0 8.8H8.7"/><path d="M11 8.8 5.8 12.6 11 16.4"/><path d="M8.8 12.6h9.5"/><path d="M7 20h10"/></svg>',
    dashboard: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v5A1.5 1.5 0 0 1 9.5 12h-4A1.5 1.5 0 0 1 4 10.5v-5ZM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v2A1.5 1.5 0 0 1 18.5 9h-4A1.5 1.5 0 0 1 13 7.5v-2ZM13 13.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-5ZM4 16.5A1.5 1.5 0 0 1 5.5 15h4a1.5 1.5 0 0 1 1.5 1.5v2A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-2Z"/></svg>',
    cloud: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 18.5h10.1a4.2 4.2 0 0 0 .5-8.4 6.2 6.2 0 0 0-11.7 1.6 3.4 3.4 0 0 0 1.1 6.8Z"/></svg>',
    node: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.1 8.3l5.8 7.4M9.5 17.5h5"/></svg>',
    layers: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m4 12 8 4.5 8-4.5M4 16l8 4.5 8-4.5"/></svg>',
    settings: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 13.5.1-1.5-.1-1.5 2-1.5-2-3.5-2.4 1a8.3 8.3 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8.3 8.3 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5-.1 1.5.1 1.5-2 1.5 2 3.5 2.4-1a8.3 8.3 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8.3 8.3 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z"/></svg>',
    login: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7V5.8A2.8 2.8 0 0 1 12.8 3h4.4A2.8 2.8 0 0 1 20 5.8v12.4a2.8 2.8 0 0 1-2.8 2.8h-4.4a2.8 2.8 0 0 1-2.8-2.8V17"/><path d="M4 12h10M10.5 8.5 14 12l-3.5 3.5"/></svg>',
    copy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10.5A1.5 1.5 0 0 1 20 9.5v9A1.5 1.5 0 0 1 18.5 20h-9A1.5 1.5 0 0 1 8 18.5V8Z"/><path d="M5 16H4.5A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4h9A1.5 1.5 0 0 1 15 5.5V6"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    logout: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 7V5.8A2.8 2.8 0 0 0 11.2 3H6.8A2.8 2.8 0 0 0 4 5.8v12.4A2.8 2.8 0 0 0 6.8 21h4.4a2.8 2.8 0 0 0 2.8-2.8V17"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5"/></svg>',
    save: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5V4Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/></svg>',
    reset: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10a6 6 0 1 1-5.2 9"/><path d="M4 7l4-4M4 7l4 4"/></svg>',
    download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 20h14"/></svg>',
    upload: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V10"/><path d="m8 14 4-4 4 4"/><path d="M5 4h14"/></svg>',
    shield: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5.6c0 4.6-3 7.8-8 9.4-5-1.6-8-4.8-8-9.4V6l8-3Z"/><path d="m9 12 2 2 4-5"/></svg>',
    route: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h8a4 4 0 0 1 0 8H9"/><path d="m9 11-4 4 4 4"/><path d="M16 15h3"/></svg>',
    sun: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>',
    moon: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.4A7.8 7.8 0 0 1 9.6 4 8 8 0 1 0 20 14.4Z"/></svg>',
    monitor: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H4V5Z"/><path d="M8 21h8M12 15v6"/></svg>',
  };
  return icons[name] || "";
}

function adminHtml(adminPath) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sub302 控制台</title>
  <link rel="icon" href="/logo.png" type="image/png" sizes="any" />
  <link rel="apple-touch-icon" href="/logo.png" />
  <meta name="theme-color" content="#030712" />
  <script>
    (function () {
      try {
        var mode = localStorage.getItem("sub302_theme") || "system";
        var dark = mode === "dark" || (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.dataset.themeMode = mode;
        document.documentElement.dataset.theme = dark ? "dark" : "light";
      } catch (error) {
        document.documentElement.dataset.theme = "dark";
      }
    })();
  </script>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #eef3f8;
      --bg-elevated: rgba(255, 255, 255, .82);
      --panel: rgba(255, 255, 255, .88);
      --panel-strong: rgba(255, 255, 255, .96);
      --panel-soft: rgba(248, 250, 252, .78);
      --text: #0f172a;
      --muted: #64748b;
      --line: rgba(148, 163, 184, .38);
      --line-soft: rgba(148, 163, 184, .22);
      --primary: #2563eb;
      --primary-strong: #1d4ed8;
      --primary-soft: rgba(37, 99, 235, .12);
      --accent: #0d9488;
      --accent-soft: rgba(13, 148, 136, .13);
      --warning: #d97706;
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, .1);
      --shadow: 0 18px 48px rgba(15, 23, 42, 0.1);
      --shadow-soft: 0 10px 26px rgba(15, 23, 42, 0.07);
      --radius: 8px;
      --radius-sm: 6px;
      --pill: 999px;
    }

    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #030712;
      --bg-elevated: rgba(3, 7, 18, .86);
      --panel: rgba(15, 23, 42, .76);
      --panel-strong: rgba(17, 24, 39, .92);
      --panel-soft: rgba(255, 255, 255, .045);
      --text: #f8fafc;
      --muted: #9ca3af;
      --line: rgba(255, 255, 255, .1);
      --line-soft: rgba(255, 255, 255, .07);
      --primary: #60a5fa;
      --primary-strong: #93c5fd;
      --primary-soft: rgba(96, 165, 250, .13);
      --accent: #2dd4bf;
      --accent-soft: rgba(45, 212, 191, .13);
      --warning: #f59e0b;
      --danger: #fb7185;
      --danger-soft: rgba(244, 63, 94, .13);
      --shadow: 0 24px 70px rgba(0, 0, 0, .36);
      --shadow-soft: 0 18px 44px rgba(0, 0, 0, .24);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(37, 99, 235, .12), transparent 30rem),
        linear-gradient(135deg, rgba(13, 148, 136, .08), transparent 38rem),
        var(--bg);
      color: var(--text);
      transition: background-color .2s ease, color .2s ease;
    }
    html[data-theme="dark"] body {
      background:
        linear-gradient(180deg, rgba(37, 99, 235, .24), transparent 34rem),
        linear-gradient(135deg, rgba(20, 184, 166, .12), transparent 40rem),
        var(--bg);
    }
    body:before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(148, 163, 184, .08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(148, 163, 184, .08) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: linear-gradient(to bottom, black, transparent 70%);
    }
    button, input, textarea, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--panel-soft);
      color: var(--text);
      padding: 11px 12px;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
    }
    textarea { min-height: 90px; resize: vertical; line-height: 1.55; }
    input:focus, textarea:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 22%, transparent); }
    button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 70%, transparent); outline-offset: 2px; }
    label { display: block; font-size: 12px; color: var(--muted); font-weight: 700; margin: 0 0 7px; }
    code { padding: 2px 5px; border-radius: 7px; background: var(--panel-soft); color: var(--text); word-break: break-all; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 32%, transparent); border: 3px solid transparent; border-radius: var(--pill); background-clip: padding-box; }
    ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--muted) 48%, transparent); border: 3px solid transparent; background-clip: padding-box; }

    .hidden { display: none !important; }
    .auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .auth-card { width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 24px; backdrop-filter: blur(18px); }
    .brand-row { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
    .auth-card .surface-head { align-items: center; margin-bottom: 22px; }
    .auth-card .brand-row { margin-bottom: 0; }
    .brand-mark { width: 44px; height: 44px; display: grid; place-items: center; border-radius: var(--radius); background: var(--panel-soft); color: #fff; box-shadow: 0 16px 36px rgba(37, 99, 235, .18); border: 1px solid var(--line-soft); position: relative; overflow: hidden; }
    .brand-mark:after { content: ""; position: absolute; inset: 1px; border-radius: 7px; box-shadow: inset 0 1px 0 rgba(255,255,255,.34); pointer-events: none; }
    .brand-logo { width: 100%; height: 100%; display: block; object-fit: cover; position: relative; z-index: 1; }
    html[data-theme="dark"] .brand-mark { box-shadow: 0 18px 42px rgba(37, 99, 235, .28); }
    .icon, .brand-icon { width: 18px; height: 18px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .brand-icon { width: 25px; height: 25px; stroke-width: 1.9; }
    h1, h2, h3, p { margin: 0; }
    .brand-row h1 { font-size: 24px; }
    .brand-row p, .muted { color: var(--muted); }
    .muted { font-size: 13px; line-height: 1.55; }
    .auth-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; }

    .app-shell { min-height: 100vh; display: flex; flex-direction: column; }
    .sidebar {
      position: sticky;
      top: 0;
      z-index: 10;
      min-height: 76px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 18px;
      padding: 12px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--bg-elevated);
      backdrop-filter: blur(18px);
      box-shadow: 0 1px 0 rgba(255,255,255,.08);
    }
    .sidebar .brand-row { margin-bottom: 0; }
    .sidebar .brand-row h1 { font-size: 19px; }
    .nav { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; overflow-x: auto; border: 1px solid var(--line); background: var(--panel-soft); border-radius: var(--pill); padding: 5px; box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
    .nav button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 38px;
      border-radius: var(--pill);
      padding: 0 14px;
      background: transparent;
      color: var(--muted);
      font-weight: 700;
      text-align: left;
      white-space: nowrap;
      transition: color .16s ease, background-color .16s ease, transform .16s ease;
    }
    .nav button:hover { background: var(--panel-strong); color: var(--text); }
    .nav button.active { background: var(--panel-strong); color: var(--primary-strong); box-shadow: var(--shadow-soft); }
    .sidebar-footer { display: flex; gap: 8px; align-items: center; justify-content: flex-end; min-width: 0; }
    .main { width: min(1280px, 100%); min-width: 0; margin: 0 auto; padding: 24px 24px 48px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow-soft); backdrop-filter: blur(18px); position: relative; overflow: hidden; }
    .topbar:before { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, var(--primary), var(--accent), var(--warning)); }
    .topbar h2 { font-size: 26px; letter-spacing: 0; }
    .topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border-radius: 999px; background: var(--panel-soft); border: 1px solid var(--line-soft); color: var(--muted); font-size: 12px; font-weight: 800; }
    .panel { display: none; }
    .panel.active { display: grid; gap: 16px; }

    .grid { display: grid; gap: 14px; }
    .grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .surface, .metric, .item-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(16px);
      transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
    }
    .surface { padding: 18px; }
    .surface:hover, .item-card:hover, .metric:hover { border-color: color-mix(in srgb, var(--primary) 28%, var(--line)); box-shadow: var(--shadow); transform: translateY(-1px); }
    .surface-head, .item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
    .surface-head h3, .item-head h3 { font-size: 16px; }
    .metric { padding: 16px; min-height: 148px; display: flex; flex-direction: column; justify-content: space-between; position: relative; overflow: hidden; text-align: left; color: var(--text); }
    .metric-link { cursor: pointer; }
    .metric-link:hover .metric-open { color: var(--primary-strong); }
    .metric:before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, var(--accent), var(--primary), var(--warning)); }
    .metric-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .metric-icon, .card-avatar { width: 34px; height: 34px; display: grid; place-items: center; border-radius: var(--radius-sm); background: linear-gradient(135deg, var(--primary-soft), var(--accent-soft)); color: var(--primary-strong); border: 1px solid var(--line-soft); box-shadow: inset 0 1px 0 rgba(255,255,255,.1); }
    .metric span { color: var(--muted); font-size: 12px; font-weight: 800; }
    .metric strong { font-size: 30px; line-height: 1; letter-spacing: 0; }
    .metric-main { display: grid; gap: 10px; }
    .metric-preview { display: grid; gap: 6px; margin-top: 4px; }
    .metric-preview-item { min-width: 0; padding: 6px 8px; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); background: var(--panel-soft); color: var(--text); font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .metric-preview-item.empty { color: var(--muted); font-weight: 700; }
    .metric-open { margin-top: 10px; color: var(--muted); font-size: 12px; font-weight: 800; transition: color .16s ease; }
    .form-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field-full { grid-column: 1 / -1; }
    .check-row { display: flex; align-items: center; gap: 9px; min-height: 38px; color: var(--text); font-weight: 700; }
    .check-row input { width: auto; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .input-action { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: stretch; }
    .field-note { margin-top: 7px; }

    .btn {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border-radius: var(--radius-sm);
      padding: 0 13px;
      font-weight: 800;
      background: var(--primary);
      color: #fff;
      box-shadow: 0 10px 24px color-mix(in srgb, var(--primary) 20%, transparent);
      transition: transform .16s ease, background-color .16s ease, box-shadow .16s ease;
    }
    .btn:hover { background: var(--primary-strong); transform: translateY(-1px); }
    .btn.secondary { background: var(--panel-soft); color: var(--text); border: 1px solid var(--line-soft); box-shadow: none; }
    .btn.secondary:hover { background: color-mix(in srgb, var(--panel-soft) 76%, var(--primary-soft)); }
    .btn.danger { background: var(--danger-soft); color: var(--danger); }
    .btn.danger:hover { background: color-mix(in srgb, var(--danger-soft) 78%, var(--danger)); }
    .btn.ghost { background: transparent; color: var(--muted); box-shadow: none; }
    .btn.ghost:hover { background: var(--panel-soft); color: var(--text); }
    .btn.small { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .theme-switcher { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: var(--pill); background: var(--panel-soft); }
    .theme-switcher button { width: 34px; height: 30px; display: grid; place-items: center; border-radius: var(--pill); background: transparent; color: var(--muted); }
    .theme-switcher button:hover { color: var(--text); }
    .theme-switcher button.active { background: var(--primary); color: #fff; box-shadow: 0 8px 18px color-mix(in srgb, var(--primary) 26%, transparent); }
    .status { display: inline-flex; align-items: center; border-radius: 999px; min-height: 24px; padding: 0 8px; font-size: 12px; font-weight: 800; }
    .status.on { color: #047857; background: #dcfce7; }
    html[data-theme="dark"] .status.on { color: #86efac; background: rgba(34, 197, 94, .14); }
    .status.off { color: #9a3412; background: #ffedd5; }
    html[data-theme="dark"] .status.off { color: #fdba74; background: rgba(249, 115, 22, .14); }
    .list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; align-items: start; }
    #subscriptionOverview { grid-template-columns: 1fr; }
    .item-card { padding: 16px; min-height: 176px; }
    .item-card .actions { justify-content: flex-end; }
    .overview-row { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); background: var(--panel-soft); cursor: pointer; transition: border-color .16s ease, background-color .16s ease, transform .16s ease; }
    .overview-row:hover { border-color: color-mix(in srgb, var(--primary) 26%, var(--line)); background: var(--panel-strong); transform: translateY(-1px); }
    .overview-row:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 70%, transparent); outline-offset: 2px; }
    .overview-row .item-head { margin-bottom: 0; }
    .overview-link { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .copy-hint { color: var(--primary-strong); font-size: 12px; font-weight: 800; white-space: nowrap; }
    .item-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .item-title-row h3 { min-width: 0; overflow-wrap: anywhere; }
    .item-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 7px; }
    .item-body { display: grid; gap: 9px; }
    .mono-line { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; line-height: 1.55; padding: 10px 11px; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); background: var(--panel-soft); word-break: break-all; max-height: 112px; overflow: auto; }
    .choice-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .choice {
      display: flex;
      gap: 9px;
      align-items: flex-start;
      padding: 10px;
      border: 1px solid var(--line-soft);
      border-radius: var(--radius-sm);
      background: var(--panel-soft);
    }
    .choice:hover { border-color: color-mix(in srgb, var(--primary) 26%, var(--line)); background: var(--panel-strong); }
    .choice input:checked + span strong { color: var(--primary-strong); }
    .choice input { width: auto; margin-top: 2px; }
    .choice strong { display: block; font-size: 13px; }
    .choice span { display: block; color: var(--muted); font-size: 12px; line-height: 1.45; word-break: break-all; }
    .empty { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: var(--radius); background: var(--panel-soft); grid-column: 1 / -1; }
    .toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; min-width: 220px; max-width: 360px; background: #111827; color: #fff; border-radius: var(--radius-sm); padding: 11px 13px; box-shadow: var(--shadow); }
    .toast.error { background: #7f1d1d; }
    .modal { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 18px; background: rgba(2, 6, 23, .68); backdrop-filter: blur(10px); }
    .modal-panel { width: min(720px, 100%); max-height: min(860px, calc(100vh - 36px)); overflow: auto; background: var(--panel-strong); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; }
    .modal-fields { display: contents; }
    .modal-actions { margin-top: 14px; display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { text-align: left; border-bottom: 1px solid var(--line-soft); padding: 10px 8px; vertical-align: top; }
    .table th { color: var(--muted); font-size: 12px; }

    @media (max-width: 980px) {
      .sidebar { grid-template-columns: 1fr; align-items: stretch; position: static; }
      .sidebar-footer { justify-content: flex-start; flex-wrap: wrap; }
      .nav { justify-content: flex-start; overflow-x: auto; }
      .nav button { justify-content: center; white-space: nowrap; }
      .main { padding: 16px; }
      .grid.cols-4, .grid.cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 680px) {
      .topbar, .surface-head, .item-head { display: grid; }
      .form-grid, .grid.cols-2, .grid.cols-3, .grid.cols-4, .choice-list { grid-template-columns: 1fr; }
      .input-action { grid-template-columns: 1fr; }
      .nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .nav button { min-width: 0; }
      .nav button:last-child { grid-column: 1 / -1; }
      .actions, .topbar-actions { justify-content: stretch; }
      .btn { width: 100%; }
      .btn.small { width: auto; }
      .item-card .actions .btn.small { flex: 1 1 auto; }
    }
  </style>
</head>
<body>
  <section id="loginView" class="auth-screen">
    <div class="auth-card">
      <div class="surface-head">
        <div class="brand-row">
          <div class="brand-mark"><img class="brand-logo" src="/logo.png" alt="" /></div>
          <div>
            <h1>Sub302</h1>
            <p class="muted">订阅重定向控制台</p>
          </div>
        </div>
        <div class="theme-switcher" data-theme-switcher aria-label="主题模式">
          <button data-theme-mode="system" type="button" title="跟随系统" aria-label="跟随系统">${uiIcon("monitor")}</button>
          <button data-theme-mode="light" type="button" title="浅色" aria-label="浅色">${uiIcon("sun")}</button>
          <button data-theme-mode="dark" type="button" title="深色" aria-label="深色">${uiIcon("moon")}</button>
        </div>
      </div>
      <form id="loginForm">
        <label for="password">管理密码</label>
        <input id="password" type="password" autocomplete="current-password" placeholder="输入密码" />
        <div class="auth-actions">
          <button class="btn" type="submit">${uiIcon("login")}登录</button>
          <span id="loginMsg" class="muted"></span>
        </div>
      </form>
    </div>
  </section>

  <section id="appView" class="app-shell hidden">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark"><img class="brand-logo" src="/logo.png" alt="" /></div>
        <div>
          <h1 id="brandTitle">Sub302</h1>
        </div>
      </div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-tab="dashboard" type="button">${uiIcon("dashboard")}仪表盘</button>
        <button data-tab="airports" type="button">${uiIcon("cloud")}机场订阅</button>
        <button data-tab="nodes" type="button">${uiIcon("node")}手动节点</button>
        <button data-tab="profiles" type="button">${uiIcon("layers")}我的订阅</button>
        <button data-tab="settings" type="button">${uiIcon("settings")}设置</button>
      </nav>
      <div class="sidebar-footer">
        <button id="logoutBtn" class="btn secondary" type="button">${uiIcon("logout")}退出登录</button>
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
          <div class="theme-switcher" data-theme-switcher aria-label="主题模式">
            <button data-theme-mode="system" type="button" title="跟随系统" aria-label="跟随系统">${uiIcon("monitor")}</button>
            <button data-theme-mode="light" type="button" title="浅色" aria-label="浅色">${uiIcon("sun")}</button>
            <button data-theme-mode="dark" type="button" title="深色" aria-label="深色">${uiIcon("moon")}</button>
          </div>
        </div>
      </header>

      <section id="panel-dashboard" class="panel active">
        <div class="grid cols-3">
          <button class="metric metric-link" data-tab="airports" type="button" aria-label="打开机场订阅"><div class="metric-head"><span>机场订阅</span><span class="metric-icon">${uiIcon("cloud")}</span></div><div class="metric-main"><strong id="metricAirports">0</strong><div id="previewAirports" class="metric-preview"></div></div><div class="metric-open">进入机场订阅</div></button>
          <button class="metric metric-link" data-tab="nodes" type="button" aria-label="打开手动节点"><div class="metric-head"><span>手动节点</span><span class="metric-icon">${uiIcon("node")}</span></div><div class="metric-main"><strong id="metricNodes">0</strong><div id="previewNodes" class="metric-preview"></div></div><div class="metric-open">进入手动节点</div></button>
          <button class="metric metric-link" data-tab="profiles" type="button" aria-label="打开我的订阅"><div class="metric-head"><span>我的订阅</span><span class="metric-icon">${uiIcon("layers")}</span></div><div class="metric-main"><strong id="metricProfiles">0</strong><div id="previewProfiles" class="metric-preview"></div></div><div class="metric-open">进入我的订阅</div></button>
        </div>
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>订阅总览</h3>
              <p class="muted">机场订阅和我的订阅的固定入口。</p>
            </div>
          </div>
          <div id="subscriptionOverview" class="list"></div>
        </section>
      </section>

      <section id="panel-airports" class="panel">
        <section class="surface">
          <div class="surface-head">
            <div>
              <h3>机场订阅</h3>
              <p class="muted">每条记录会生成一个固定 Sub302 链接，访问时只 302 到真实订阅 URL。</p>
            </div>
              <button class="btn secondary small" data-action="reset-airport" type="button">${uiIcon("reset")}清空表单</button>
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
              <button class="btn" type="submit">${uiIcon("save")}保存机场订阅</button>
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
              <p class="muted">手动节点会进入订阅组清单，输出时按名称写回节点名。</p>
            </div>
            <button class="btn secondary small" data-action="reset-node" type="button">${uiIcon("reset")}清空表单</button>
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
              <button class="btn" type="submit">${uiIcon("save")}保存手动节点</button>
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
            <button class="btn secondary small" data-action="reset-profile" type="button">${uiIcon("reset")}清空表单</button>
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
              <button class="btn" type="submit">${uiIcon("save")}保存订阅组</button>
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
              <label for="adminPath">控制台安全路径</label>
              <input id="adminPath" placeholder="admin 或 token123456" />
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
            <div>
              <label for="profileListEncoding">订阅组清单输出</label>
              <select id="profileListEncoding">
                <option value="base64">Base64（默认）</option>
                <option value="raw">明文</option>
              </select>
            </div>
            <div class="field-full">
              <label for="accessToken">订阅 Token</label>
              <div class="input-action">
                <input id="accessToken" autocomplete="off" spellcheck="false" placeholder="留空则不启用 token" />
                <button class="btn secondary small" data-action="generate-token" type="button">${uiIcon("shield")}自动生成</button>
              </div>
              <p class="muted field-note">设置后公开链接会变成 <code>/token=xxxx?IPLC</code>，更换 token 后旧链接失效。</p>
            </div>
            <label class="check-row field-full"><input id="allowLegacyRootRoutes" type="checkbox" checked />允许根路径固定入口</label>
            <div class="actions field-full">
              <button class="btn" type="submit">${uiIcon("save")}保存设置</button>
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
              <button class="btn secondary small" data-action="export-backup" type="button">${uiIcon("download")}导出</button>
              <button class="btn danger small" data-action="import-backup" type="button">${uiIcon("upload")}导入</button>
            </div>
          </div>
          <textarea id="backupBox" placeholder="导出的 JSON 会显示在这里"></textarea>
        </section>
      </section>
    </main>
  </section>

  <div id="editModal" class="modal hidden" aria-hidden="true">
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="editModalTitle">
      <div class="surface-head">
        <div>
          <h3 id="editModalTitle">编辑</h3>
          <p id="editModalSubtitle" class="muted"></p>
        </div>
        <button class="btn secondary small" data-action="close-edit-modal" type="button">关闭</button>
      </div>
      <form id="editModalForm" class="form-grid">
        <div id="editModalFields" class="modal-fields"></div>
        <div class="modal-actions field-full">
          <button class="btn secondary" data-action="close-edit-modal" type="button">取消</button>
          <button class="btn" type="submit">${uiIcon("save")}保存修改</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>

<script>
window.SUB302_ADMIN_PATH = ${JSON.stringify(`/${adminPath}`)};

const state = {
  activeTab: "dashboard",
  data: null,
  edit: { kind: "", id: "" },
  themeMode: "system"
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

function initTheme() {
  try {
    state.themeMode = localStorage.getItem("sub302_theme") || "system";
  } catch (error) {
    state.themeMode = "system";
  }
  applyTheme();
  if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = function () {
      if (state.themeMode === "system") applyTheme();
    };
    if (media.addEventListener) media.addEventListener("change", handler);
    else if (media.addListener) media.addListener(handler);
  }
}

function setThemeMode(mode) {
  state.themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  try {
    localStorage.setItem("sub302_theme", state.themeMode);
  } catch (error) {}
  applyTheme();
}

function applyTheme() {
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = state.themeMode === "dark" || (state.themeMode === "system" && prefersDark);
  document.documentElement.dataset.themeMode = state.themeMode;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute("content", dark ? "#030712" : "#eef3f8");
  document.querySelectorAll("button[data-theme-mode]").forEach(function (button) {
    button.classList.toggle("active", button.getAttribute("data-theme-mode") === state.themeMode);
  });
}

function closestElement(target, selector) {
  const element = target && target.nodeType === 1 ? target : target?.parentElement;
  return element?.closest ? element.closest(selector) : null;
}

function currentAdminPath() {
  const configured = state.data?.settings?.adminPath || "";
  return configured ? "/" + configured.replace(new RegExp("^/+|/+$", "g"), "") : window.SUB302_ADMIN_PATH;
}

async function api(path, options) {
  const init = options || {};
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Sub302-Admin-Path": currentAdminPath(), ...(init.headers || {}) },
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
  $("metricAirports").textContent = data.airports.length;
  $("metricNodes").textContent = data.manualNodes.length;
  $("metricProfiles").textContent = data.profiles.length;
  $("previewAirports").innerHTML = metricPreview(data.airports, "还没有机场订阅");
  $("previewNodes").innerHTML = metricPreview(data.manualNodes, "还没有手动节点");
  $("previewProfiles").innerHTML = metricPreview(data.profiles, "还没有我的订阅");

  const overview = data.airports.map(function (item) {
    return { type: "机场订阅", name: item.name, date: item.updatedAt, link: airportUrl(item), enabled: item.enabled !== false, icon: "cloud" };
  }).concat(data.profiles.map(function (item) {
    return { type: "我的订阅", name: item.name, date: item.updatedAt, link: profileUrl(item), enabled: item.enabled !== false, icon: "layers" };
  })).sort(function (a, b) {
    return String(b.date || "").localeCompare(String(a.date || ""));
  });

  $("subscriptionOverview").innerHTML = overview.length ? overview.map(function (item) {
    return '<article class="overview-row" data-copy-value="' + attr(item.link) + '" role="button" tabindex="0" title="点击复制">' +
      '<div class="item-head"><div class="item-title-row"><span class="card-avatar">' + clientIcon(item.icon) + '</span><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="badge">' + esc(item.type) + '</span><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "禁用") + '</span><span class="muted">' + fmtDate(item.date) + '</span></div></div></div></div>' +
      '<div class="overview-link"><div class="mono-line">' + esc(item.link) + '</div><span class="copy-hint">点击复制</span></div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有订阅链接</div>';
}

function metricPreview(items, emptyText) {
  const sorted = items.slice().sort(function (a, b) {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  }).slice(0, 2);
  if (!sorted.length) return '<div class="metric-preview-item empty">' + esc(emptyText) + '</div>';
  return sorted.map(function (item) {
    return '<div class="metric-preview-item">' + esc(item.name || item.slug || "未命名") + '</div>';
  }).join("");
}

function renderAirports() {
  const list = state.data.airports;
  $("airportList").innerHTML = list.length ? list.map(function (item) {
    const fixed = airportUrl(item);
    return '<article class="item-card">' +
      '<div class="item-head"><div class="item-title-row"><span class="card-avatar">' + clientIcon("cloud") + '</span><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "禁用") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(fixed) + '" type="button">' + clientIcon("copy") + '复制链接</button><button class="btn secondary small" data-action="toggle-airport" data-id="' + attr(item.id) + '" type="button">' + (item.enabled ? "禁用" : "启用") + '</button><button class="btn secondary small" data-action="edit-airport" data-id="' + attr(item.id) + '" type="button">' + clientIcon("edit") + '编辑</button><button class="btn danger small" data-action="delete-airport" data-id="' + attr(item.id) + '" type="button">' + clientIcon("trash") + '删除</button></div></div>' +
      '<div class="item-body"><div class="mono-line">' + esc(fixed) + '</div><div class="mono-line">' + esc(item.url) + '</div>' + (item.remark ? '<p class="muted">' + esc(item.remark) + '</p>' : '') + '</div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有机场订阅</div>';
}

function renderNodes() {
  const list = state.data.manualNodes;
  $("nodeList").innerHTML = list.length ? list.map(function (item) {
    return '<article class="item-card">' +
      '<div class="item-head"><div class="item-title-row"><span class="card-avatar">' + clientIcon("node") + '</span><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "禁用") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(renameNodeUri(item.uri, item.name)) + '" type="button">' + clientIcon("copy") + '复制节点</button><button class="btn secondary small" data-action="toggle-node" data-id="' + attr(item.id) + '" type="button">' + (item.enabled ? "禁用" : "启用") + '</button><button class="btn secondary small" data-action="edit-node" data-id="' + attr(item.id) + '" type="button">' + clientIcon("edit") + '编辑</button><button class="btn danger small" data-action="delete-node" data-id="' + attr(item.id) + '" type="button">' + clientIcon("trash") + '删除</button></div></div>' +
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
      '<div class="item-head"><div class="item-title-row"><span class="card-avatar">' + clientIcon("layers") + '</span><div><h3>' + esc(item.name) + '</h3><div class="item-meta"><span class="status ' + (item.enabled ? "on" : "off") + '">' + (item.enabled ? "启用" : "禁用") + '</span><span class="badge">' + (item.output === "redirect" ? "302 聚合地址" : "引用清单") + '</span><span class="muted">' + fmtDate(item.updatedAt) + '</span></div></div></div>' +
      '<div class="actions"><button class="btn secondary small" data-action="copy" data-value="' + attr(link) + '" type="button">' + clientIcon("copy") + '复制链接</button><button class="btn secondary small" data-action="copy-profile-items" data-id="' + attr(item.id) + '" type="button">' + clientIcon("copy") + '复制成员</button><button class="btn secondary small" data-action="toggle-profile" data-id="' + attr(item.id) + '" type="button">' + (item.enabled ? "禁用" : "启用") + '</button><button class="btn secondary small" data-action="edit-profile" data-id="' + attr(item.id) + '" type="button">' + clientIcon("edit") + '编辑</button><button class="btn danger small" data-action="delete-profile" data-id="' + attr(item.id) + '" type="button">' + clientIcon("trash") + '删除</button></div></div>' +
      '<div class="item-body"><div class="mono-line">' + esc(link) + '</div>' +
      (item.output === "redirect" ? '<div class="mono-line">' + esc(item.redirectTarget) + '</div>' : '<p class="muted">成员数量：' + items.length + '</p>') +
      (item.remark ? '<p class="muted">' + esc(item.remark) + '</p>' : '') + '</div>' +
    '</article>';
  }).join("") : '<div class="empty">还没有我的订阅</div>';
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
  $("adminPath").value = settings.adminPath || "admin";
  $("publicBaseUrl").value = settings.publicBaseUrl || "";
  $("redirectStatusCode").value = settings.redirectStatusCode || "302";
  $("profilePrefix").value = settings.profilePrefix || "p";
  $("profileListEncoding").value = settings.profileListEncoding || "base64";
  $("accessToken").value = settings.accessToken || "";
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
    adminPath: $("adminPath").value,
    publicBaseUrl: $("publicBaseUrl").value,
    redirectStatusCode: $("redirectStatusCode").value,
    profilePrefix: $("profilePrefix").value,
    profileListEncoding: $("profileListEncoding").value,
    accessToken: $("accessToken").value,
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
  openEditModal("airport", item);
}

function editNode(id) {
  const item = state.data.manualNodes.find(function (entry) { return entry.id === id; });
  if (!item) return;
  openEditModal("node", item);
}

function editProfile(id) {
  const item = state.data.profiles.find(function (entry) { return entry.id === id; });
  if (!item) return;
  openEditModal("profile", item);
}

function openEditModal(kind, item) {
  state.edit = { kind, id: item.id };
  const titles = {
    airport: ["编辑机场订阅", "保存后当前公开链接会立即使用新配置。"],
    node: ["编辑手动节点", "保存后引用它的我的订阅会使用新节点内容。"],
    profile: ["编辑我的订阅", "保存后当前订阅链接会立即使用新成员和输出方式。"]
  };
  $("editModalTitle").textContent = titles[kind][0];
  $("editModalSubtitle").textContent = titles[kind][1];
  $("editModalFields").innerHTML = renderEditFields(kind, item);
  $("editModal").classList.remove("hidden");
  $("editModal").setAttribute("aria-hidden", "false");
  if (kind === "profile") updateModalProfileOutput();
  setTimeout(function () {
    const first = $("editModal").querySelector("input, textarea, select, button");
    if (first) first.focus();
  }, 0);
}

function closeEditModal() {
  state.edit = { kind: "", id: "" };
  $("editModal").classList.add("hidden");
  $("editModal").setAttribute("aria-hidden", "true");
  $("editModalFields").innerHTML = "";
}

function renderEditFields(kind, item) {
  if (kind === "airport") {
    return '<div><label for="modalAirportName">名称</label><input id="modalAirportName" value="' + attr(item.name) + '" /></div>' +
      '<div><label for="modalAirportSlug">固定路径 slug</label><input id="modalAirportSlug" value="' + attr(item.slug) + '" /></div>' +
      '<div class="field-full"><label for="modalAirportUrl">真实订阅 URL</label><input id="modalAirportUrl" value="' + attr(item.url) + '" /></div>' +
      '<div class="field-full"><label for="modalAirportRemark">备注</label><textarea id="modalAirportRemark">' + esc(item.remark || "") + '</textarea></div>' +
      '<label class="check-row field-full"><input id="modalAirportEnabled" type="checkbox"' + (item.enabled !== false ? " checked" : "") + ' />启用这条订阅</label>';
  }

  if (kind === "node") {
    return '<div><label for="modalNodeName">名称</label><input id="modalNodeName" value="' + attr(item.name) + '" /></div>' +
      '<div><label>状态</label><label class="check-row"><input id="modalNodeEnabled" type="checkbox"' + (item.enabled !== false ? " checked" : "") + ' />启用</label></div>' +
      '<div class="field-full"><label for="modalNodeUri">节点 URI</label><textarea id="modalNodeUri">' + esc(item.uri) + '</textarea></div>' +
      '<div class="field-full"><label for="modalNodeRemark">备注</label><textarea id="modalNodeRemark">' + esc(item.remark || "") + '</textarea></div>';
  }

  return '<div><label for="modalProfileName">名称</label><input id="modalProfileName" value="' + attr(item.name) + '" /></div>' +
    '<div><label for="modalProfileSlug">我的订阅 slug</label><input id="modalProfileSlug" value="' + attr(item.slug) + '" /></div>' +
    '<div><label for="modalProfileOutput">输出方式</label><select id="modalProfileOutput"><option value="list"' + ((item.output || "list") !== "redirect" ? " selected" : "") + '>引用清单</option><option value="redirect"' + (item.output === "redirect" ? " selected" : "") + '>302 到聚合地址</option></select></div>' +
    '<label class="check-row"><input id="modalProfileEnabled" type="checkbox"' + (item.enabled !== false ? " checked" : "") + ' />启用我的订阅</label>' +
    '<div id="modalProfileRedirectField" class="field-full hidden"><label for="modalProfileRedirectTarget">聚合订阅地址</label><input id="modalProfileRedirectTarget" value="' + attr(item.redirectTarget || "") + '" /></div>' +
    '<div class="field-full"><label>选择机场订阅</label><div class="choice-list">' + modalChoiceHtml("airport", state.data.airports, item.subscriptionIds || []) + '</div></div>' +
    '<div class="field-full"><label>选择手动节点</label><div class="choice-list">' + modalChoiceHtml("node", state.data.manualNodes, item.nodeIds || []) + '</div></div>' +
    '<div class="field-full"><label for="modalProfileRemark">备注</label><textarea id="modalProfileRemark">' + esc(item.remark || "") + '</textarea></div>';
}

function modalChoiceHtml(kind, items, selectedIds) {
  const selected = new Set(selectedIds || []);
  if (!items.length) return '<div class="empty">' + (kind === "airport" ? "先添加机场订阅" : "没有手动节点也可以保存") + '</div>';
  const inputName = kind === "airport" ? "modalProfileAirport" : "modalProfileNode";
  return items.map(function (item) {
    const detail = kind === "airport" ? airportUrl(item) : item.uri;
    return '<label class="choice"><input type="checkbox" name="' + inputName + '" value="' + attr(item.id) + '"' + (selected.has(item.id) ? " checked" : "") + ' /><span><strong>' + esc(item.name) + '</strong><span>' + esc(detail) + '</span></span></label>';
  }).join("");
}

function updateModalProfileOutput() {
  const field = $("modalProfileRedirectField");
  const output = $("modalProfileOutput");
  if (field && output) field.classList.toggle("hidden", output.value !== "redirect");
}

async function saveEditModal(event) {
  event.preventDefault();
  const payload = currentModalPayload();
  if (!payload) return;
  const paths = { airport: "/api/airports", node: "/api/manual-nodes", profile: "/api/profiles" };
  try {
    const result = await api(paths[state.edit.kind], { method: "POST", body: JSON.stringify(payload) });
    state.data = result.data || state.data;
    closeEditModal();
    renderAll();
    toast("已保存");
  } catch (error) {
    toast(error.message, true);
  }
}

function currentModalPayload() {
  if (state.edit.kind === "airport") {
    return {
      id: state.edit.id,
      name: $("modalAirportName").value,
      slug: $("modalAirportSlug").value,
      url: $("modalAirportUrl").value,
      remark: $("modalAirportRemark").value,
      enabled: $("modalAirportEnabled").checked
    };
  }

  if (state.edit.kind === "node") {
    return {
      id: state.edit.id,
      name: $("modalNodeName").value,
      uri: $("modalNodeUri").value,
      remark: $("modalNodeRemark").value,
      enabled: $("modalNodeEnabled").checked
    };
  }

  if (state.edit.kind === "profile") {
    return {
      id: state.edit.id,
      name: $("modalProfileName").value,
      slug: $("modalProfileSlug").value,
      output: $("modalProfileOutput").value,
      redirectTarget: $("modalProfileRedirectTarget").value,
      subscriptionIds: Array.from(document.querySelectorAll('input[name="modalProfileAirport"]:checked')).map(function (input) { return input.value; }),
      nodeIds: Array.from(document.querySelectorAll('input[name="modalProfileNode"]:checked')).map(function (input) { return input.value; }),
      remark: $("modalProfileRemark").value,
      enabled: $("modalProfileEnabled").checked
    };
  }

  return null;
}

async function deleteEntity(kind, id) {
  const labels = { airport: "机场订阅", node: "手动节点", profile: "我的订阅" };
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

async function toggleEntity(kind, id) {
  const item = findEntity(kind, id);
  if (!item) return;
  const enabled = item.enabled === false;
  const payload = entityPayload(kind, item, enabled);
  const paths = { airport: "/api/airports", node: "/api/manual-nodes", profile: "/api/profiles" };
  try {
    const result = await api(paths[kind], { method: "POST", body: JSON.stringify(payload) });
    state.data = result.data || state.data;
    renderAll();
    toast(enabled ? "已启用" : "已禁用");
  } catch (error) {
    toast(error.message, true);
  }
}

function findEntity(kind, id) {
  const collections = { airport: "airports", node: "manualNodes", profile: "profiles" };
  return state.data[collections[kind]].find(function (item) { return item.id === id; });
}

function entityPayload(kind, item, enabled) {
  if (kind === "airport") {
    return { id: item.id, name: item.name, slug: item.slug, url: item.url, remark: item.remark || "", enabled };
  }
  if (kind === "node") {
    return { id: item.id, name: item.name, uri: item.uri, remark: item.remark || "", enabled };
  }
  return {
    id: item.id,
    name: item.name,
    slug: item.slug,
    output: item.output || "list",
    redirectTarget: item.redirectTarget || "",
    subscriptionIds: item.subscriptionIds || [],
    nodeIds: item.nodeIds || [],
    remark: item.remark || "",
    enabled
  };
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
  const path = state.data.settings.allowLegacyRootRoutes === false ? "r/" + item.slug : item.slug;
  return baseUrl() + publicPath(path);
}

function profileUrl(item) {
  const prefix = state.data.settings.profilePrefix || "p";
  return baseUrl() + publicPath(prefix + "/" + item.slug);
}

function baseUrl() {
  return (state.data && state.data.settings.publicBaseUrl) || location.origin;
}

function publicPath(routePath) {
  const cleanPath = String(routePath || "").replace(new RegExp("^/+", "g"), "");
  const token = String(state.data?.settings?.accessToken || "").trim();
  return token ? "/token=" + encodeURIComponent(token) + "?" + cleanPath : "/" + cleanPath;
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
    if (item && item.enabled) items.push(renameNodeUri(item.uri, item.name));
  });
  return Array.from(new Set(items));
}

function renameNodeUri(uri, name) {
  const nodeUri = String(uri || "").trim();
  const nodeName = String(name || "").trim();
  if (!nodeUri || !nodeName) return nodeUri;
  const match = nodeUri.match(/^([a-z][a-z0-9+.-]*):\\/\\//i);
  const scheme = match ? match[1].toLowerCase() : "";
  if (scheme === "vmess") return renameVmessUri(nodeUri, nodeName);
  if (scheme === "ssr") return renameSsrUri(nodeUri, nodeName);
  return setNodeUriFragment(nodeUri, nodeName);
}

function renameVmessUri(uri, name) {
  try {
    const payload = uri.slice("vmess://".length).split(/[?#]/)[0];
    const config = JSON.parse(base64DecodeUtf8(payload));
    config.ps = name;
    return "vmess://" + base64EncodeUtf8(JSON.stringify(config));
  } catch (err) {
    return setNodeUriFragment(uri, name);
  }
}

function renameSsrUri(uri, name) {
  try {
    const payload = uri.slice("ssr://".length).split("#")[0];
    const decoded = base64DecodeUtf8(payload);
    const marker = "/?";
    const markerIndex = decoded.indexOf(marker);
    if (markerIndex === -1) return setNodeUriFragment(uri, name);
    const base = decoded.slice(0, markerIndex + marker.length);
    const params = new URLSearchParams(decoded.slice(markerIndex + marker.length));
    params.set("remarks", base64UrlEncodeUtf8(name));
    return "ssr://" + base64UrlEncodeUtf8(base + params.toString());
  } catch (err) {
    return setNodeUriFragment(uri, name);
  }
}

function setNodeUriFragment(uri, name) {
  const hashIndex = uri.lastIndexOf("#");
  const base = hashIndex === -1 ? uri : uri.slice(0, hashIndex);
  return base + "#" + encodeURIComponent(name);
}

function normalizeBase64(value) {
  let normalized = String(value || "").trim().replace(/\\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding) normalized += "=".repeat(4 - padding);
  return normalized;
}

function base64DecodeUtf8(value) {
  const binary = atob(normalizeBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64UrlEncodeUtf8(value) {
  return base64EncodeUtf8(value).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function generateAccessToken() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes).map(function (value) { return alphabet[value % alphabet.length]; }).join("");
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    toast("已复制");
  } catch (error) {
    try {
      fallbackCopyText(text);
      toast("已复制");
    } catch (fallbackError) {
      toast("复制失败，请手动复制", true);
    }
  }
}

function fallbackCopyText(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed");
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

function clientIcon(name) {
  const icons = {
    cloud: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 18.5h10.1a4.2 4.2 0 0 0 .5-8.4 6.2 6.2 0 0 0-11.7 1.6 3.4 3.4 0 0 0 1.1 6.8Z"/></svg>',
    node: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9.1 8.3l5.8 7.4M9.5 17.5h5"/></svg>',
    layers: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m4 12 8 4.5 8-4.5M4 16l8 4.5 8-4.5"/></svg>',
    copy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10.5A1.5 1.5 0 0 1 20 9.5v9A1.5 1.5 0 0 1 18.5 20h-9A1.5 1.5 0 0 1 8 18.5V8Z"/><path d="M5 16H4.5A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4h9A1.5 1.5 0 0 1 15 5.5V6"/></svg>',
    edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>'
  };
  return icons[name] || "";
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
  $("editModalForm").addEventListener("submit", saveEditModal);
  $("profileOutput").addEventListener("change", updateProfileOutput);

  document.addEventListener("change", function (event) {
    if (event.target && event.target.id === "modalProfileOutput") updateModalProfileOutput();
  });

  document.addEventListener("click", async function (event) {
    const copyTarget = closestElement(event.target, "[data-copy-value]");
    if (copyTarget) {
      event.preventDefault();
      return copyText(copyTarget.getAttribute("data-copy-value"));
    }

    const tabButton = closestElement(event.target, "[data-tab]");
    if (tabButton) {
      setTab(tabButton.getAttribute("data-tab"));
      return;
    }

    const themeButton = closestElement(event.target, "button[data-theme-mode]");
    if (themeButton) {
      setThemeMode(themeButton.getAttribute("data-theme-mode"));
      return;
    }

    const actionButton = closestElement(event.target, "[data-action]");
    if (!actionButton) return;
    const action = actionButton.getAttribute("data-action");
    const id = actionButton.getAttribute("data-id");

    if (action === "copy") return copyText(actionButton.getAttribute("data-value"));
    if (action === "edit-airport") return editAirport(id);
    if (action === "edit-node") return editNode(id);
    if (action === "edit-profile") return editProfile(id);
    if (action === "toggle-airport") return toggleEntity("airport", id);
    if (action === "toggle-node") return toggleEntity("node", id);
    if (action === "toggle-profile") return toggleEntity("profile", id);
    if (action === "delete-airport") return deleteEntity("airport", id);
    if (action === "delete-node") return deleteEntity("node", id);
    if (action === "delete-profile") return deleteEntity("profile", id);
    if (action === "close-edit-modal") return closeEditModal();
    if (action === "reset-airport") return resetAirportForm();
    if (action === "reset-node") return resetNodeForm();
    if (action === "reset-profile") return resetProfileForm();
    if (action === "generate-token") {
      $("accessToken").value = generateAccessToken();
      $("settingsMsg").textContent = "已生成，保存后生效";
      return;
    }
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

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !$("editModal").classList.contains("hidden")) {
      closeEditModal();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const copyTarget = closestElement(event.target, "[data-copy-value]");
    if (!copyTarget) return;
    event.preventDefault();
    copyText(copyTarget.getAttribute("data-copy-value"));
  });
}

initTheme();
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
