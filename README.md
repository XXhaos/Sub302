# Sub302-CF

一个极简 Cloudflare Worker 订阅入口管理器：

- 带 `/admin` 管理 UI
- 可新增、编辑、删除订阅入口
- 客户端访问固定入口时只返回 `302 Location`
- 不 `fetch()` 真实订阅，不解析、不合并、不转换
- 适合 Surge / Clash Party 固定订阅 URL，但真实订阅由客户端本地网络拉取

## 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create SUB_ROUTES
```

把返回的 KV namespace id 填到 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SUB_ROUTES"
id = "你的 id"
```

设置管理密码：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

部署：

```bash
npm run deploy
```

访问：

```text
https://你的域名/admin
```

## 使用方式

在后台添加：

```text
名称：Surge
路径：surge-a8k2p
目标：https://真实-surge-订阅链接
```

Surge 中固定填写：

```text
https://你的域名/surge-a8k2p
```

客户端更新时，Worker 返回：

```http
HTTP/1.1 302 Found
Location: https://真实-surge-订阅链接
```

## 验证没有服务端拉取

```bash
curl -I https://你的域名/surge-a8k2p
```

应看到 `302` 和 `Location`，而不是订阅正文。

## 配置项

- `ADMIN_PASSWORD`：管理后台密码，建议用 secret 设置
- `REDIRECT_STATUS_CODE`：默认 `302`，可设为 `307`

## 安全建议

- 不要用容易猜到的路径，例如 `/surge`、`/clash`
- 推荐使用 `/surge-a8k2p`、`/clash-x7vm3` 这类路径
- 真实订阅链接会出现在浏览器端后台列表中，不要把后台暴露给别人
