const STORE_KEY = "routes:v1";
const SESSION_COOKIE = "sub302_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return html(adminHtml(), { request });
      }

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

      if (url.pathname === "/api/routes") {
        const auth = await requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: "Unauthorized" }, 401);

        if (request.method === "GET") return listRoutes(env);
        if (request.method === "POST") return upsertRoute(request, env);
      }

      if (url.pathname.startsWith("/api/routes/")) {
        const auth = await requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: "Unauthorized" }, 401);

        const id = decodeURIComponent(url.pathname.slice("/api/routes/".length));
        if (request.method === "DELETE") return deleteRoute(id, env);
      }

      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        return new Response("Not found", { status: 404, headers: noStoreHeaders() });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: noStoreHeaders() });
      }

      return redirectBySlug(url.pathname, env);
    } catch (err) {
      return json({ ok: false, error: err?.message || "Internal error" }, 500);
    }
  },
};

async function handleLogin(request, env) {
  const body = await safeJson(request);
  const password = String(body.password || "");
  const expected = env.ADMIN_PASSWORD;

  if (!expected || expected === "change-me") {
    return json({ ok: false, error: "ADMIN_PASSWORD is not configured" }, 500);
  }

  if (password !== expected) {
    return json({ ok: false, error: "Invalid password" }, 401);
  }

  const token = crypto.randomUUID() + "." + Date.now();
  await env.SUB_ROUTES.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      ...noStoreHeaders(),
    },
  });
}

async function requireAuth(request, env) {
  const token = getCookie(request.headers.get("Cookie") || "", SESSION_COOKIE);
  if (!token) return { ok: false };
  const exists = await env.SUB_ROUTES.get(`session:${token}`);
  return { ok: exists === "1" };
}

async function listRoutes(env) {
  const routes = await getRoutes(env);
  return json({ ok: true, routes });
}

async function upsertRoute(request, env) {
  const body = await safeJson(request);
  const id = normalizeId(body.id || body.slug || body.name);
  const slug = normalizeSlug(body.slug || body.id || body.name);
  const name = String(body.name || slug).trim();
  const target = String(body.target || "").trim();
  const enabled = body.enabled !== false;

  if (!id) return json({ ok: false, error: "Missing id/name" }, 400);
  if (!slug) return json({ ok: false, error: "Missing slug" }, 400);
  if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: "Target must start with http:// or https://" }, 400);

  const routes = await getRoutes(env);
  const now = new Date().toISOString();
  const existing = routes.find((r) => r.id === id);
  const item = {
    id,
    name,
    slug,
    target,
    enabled,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };

  const next = existing ? routes.map((r) => (r.id === id ? item : r)) : [...routes, item];
  await putRoutes(env, next);
  return json({ ok: true, route: item });
}

async function deleteRoute(id, env) {
  const cleanId = normalizeId(id);
  const routes = await getRoutes(env);
  const next = routes.filter((r) => r.id !== cleanId);
  await putRoutes(env, next);
  return json({ ok: true });
}

async function redirectBySlug(pathname, env) {
  const slug = normalizeSlug(pathname);
  const routes = await getRoutes(env);
  const route = routes.find((r) => r.slug === slug && r.enabled);

  if (!route) {
    return new Response("Not found", { status: 404, headers: noStoreHeaders() });
  }

  const code = Number(env.REDIRECT_STATUS_CODE || 302);
  const status = [302, 303, 307, 308].includes(code) ? code : 302;

  return new Response(null, {
    status,
    headers: {
      Location: route.target,
      ...noStoreHeaders(),
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

async function getRoutes(env) {
  const raw = await env.SUB_ROUTES.get(STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function putRoutes(env, routes) {
  await env.SUB_ROUTES.put(STORE_KEY, JSON.stringify(routes, null, 2));
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
    .slice(0, 120);
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getCookie(cookieHeader, name) {
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const part of parts) {
    const [k, ...rest] = part.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
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
  <title>Sub302 管理后台</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7fb; color: #121212; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 28px 16px 60px; }
    .card { background: #fff; border: 1px solid #e8e8ef; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.04); padding: 18px; margin: 14px 0; }
    h1 { margin: 0 0 6px; font-size: 28px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { color: #666; line-height: 1.7; }
    label { display: block; font-weight: 650; margin: 12px 0 6px; }
    input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #d8d8e2; border-radius: 10px; font-size: 15px; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; font-weight: 700; cursor: pointer; background: #2454ff; color: white; }
    button.secondary { background: #eef1ff; color: #2454ff; }
    button.danger { background: #fff0f0; color: #c51f1f; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .hidden { display: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 10px 8px; vertical-align: top; }
    code { background: #f1f2f6; border-radius: 6px; padding: 2px 5px; word-break: break-all; }
    .muted { color: #777; font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .ok { color: #137333; }
    .err { color: #c5221f; }
    @media (prefers-color-scheme: dark) {
      body { background: #111318; color: #eee; }
      .card { background: #181b22; border-color: #2a2e39; }
      p, .muted { color: #aaa; }
      input { background: #111318; color: #eee; border-color: #333948; }
      th, td { border-color: #2a2e39; }
      code { background: #222631; }
      button.secondary { background: #202a55; color: #b9c5ff; }
      button.danger { background: #3a1d1d; color: #ffb4b4; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Sub302</h1>
        <p>只管理订阅入口，只返回 302/307，不服务端拉取真实订阅。</p>
      </div>
      <button id="logout" class="secondary hidden">退出</button>
    </div>

    <section id="loginCard" class="card">
      <h2>登录</h2>
      <label>管理密码</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD" />
      <p><button id="login">登录</button></p>
      <p id="loginMsg" class="muted"></p>
    </section>

    <section id="app" class="hidden">
      <section class="card">
        <h2>新增 / 更新订阅入口</h2>
        <div class="row">
          <div>
            <label>名称</label>
            <input id="name" placeholder="Surge" />
          </div>
          <div>
            <label>路径 slug</label>
            <input id="slug" placeholder="surge-a8k2p" />
          </div>
        </div>
        <label>真实订阅链接</label>
        <input id="target" placeholder="https://example.com/api/sub?..." />
        <p class="muted">保存后，客户端固定访问 <code>/<span id="slugPreview">slug</span></code>，Worker 只返回 Location，不 fetch 目标链接。</p>
        <p><button id="save">保存</button> <span id="saveMsg" class="muted"></span></p>
      </section>

      <section class="card">
        <h2>订阅入口</h2>
        <div id="routes"></div>
      </section>
    </section>
  </div>

<script>
const $ = (id) => document.getElementById(id);
const state = { routes: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function login() {
  $("loginMsg").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
    await load();
  } catch (e) {
    $("loginMsg").textContent = e.message;
    $("loginMsg").className = "err";
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  location.reload();
}

async function load() {
  const data = await api("/api/routes");
  state.routes = data.routes || [];
  $("loginCard").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("logout").classList.remove("hidden");
  render();
}

function render() {
  if (!state.routes.length) {
    $("routes").innerHTML = '<p class="muted">还没有订阅入口。</p>';
    return;
  }
  const origin = location.origin;
  $("routes").innerHTML = '<table><thead><tr><th>名称</th><th>固定入口</th><th>目标</th><th>操作</th></tr></thead><tbody>' +
    state.routes.map(r => '<tr>' +
      '<td>' + esc(r.name) + '<div class="muted">' + esc(r.updatedAt || '') + '</div></td>' +
      '<td><code>' + esc(origin + '/' + r.slug) + '</code></td>' +
      '<td><code>' + esc(r.target) + '</code></td>' +
      '<td><div class="actions"><button class="secondary" onclick="editRoute(\'' + escAttr(r.id) + '\')">编辑</button><button class="danger" onclick="delRoute(\'' + escAttr(r.id) + '\')">删除</button></div></td>' +
    '</tr>').join('') + '</tbody></table>';
}

function editRoute(id) {
  const r = state.routes.find(x => x.id === id);
  if (!r) return;
  $("name").value = r.name;
  $("slug").value = r.slug;
  $("target").value = r.target;
  updateSlugPreview();
  scrollTo({ top: 0, behavior: "smooth" });
}

async function delRoute(id) {
  if (!confirm("确定删除这个入口？")) return;
  await api('/api/routes/' + encodeURIComponent(id), { method: "DELETE" });
  await load();
}

async function save() {
  $("saveMsg").textContent = "";
  try {
    await api("/api/routes", {
      method: "POST",
      body: JSON.stringify({ name: $("name").value, slug: $("slug").value, target: $("target").value })
    });
    $("saveMsg").textContent = "已保存";
    $("saveMsg").className = "ok";
    $("name").value = "";
    $("slug").value = "";
    $("target").value = "";
    updateSlugPreview();
    await load();
  } catch (e) {
    $("saveMsg").textContent = e.message;
    $("saveMsg").className = "err";
  }
}

function updateSlugPreview() { $("slugPreview").textContent = $("slug").value || "slug"; }
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s) { return esc(s).replace(/`/g, '&#96;'); }

$("login").onclick = login;
$("logout").onclick = logout;
$("save").onclick = save;
$("slug").oninput = updateSlugPreview;
$("password").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
load().catch(() => {});
</script>
</body>
</html>`;
}
