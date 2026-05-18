# Sub302-CF

Sub302 是一个部署在 Cloudflare Workers 上的订阅入口管理器。它的核心原则很简单：

- 单条机场订阅入口只返回 `302/307/308/303 Location`
- 不在 Worker 端 `fetch()` 真实订阅
- 不解析、不合并、不转换订阅内容
- 本地 Sub-Store 负责订阅拉取、转换和聚合处理

## 功能

- 仪表盘：查看机场订阅、手动节点、订阅组和启用入口数量
- 机场订阅：维护真实订阅 URL，生成固定 Sub302 入口
- 手动节点：保存单条节点 URI，供订阅组清单引用
- 我的订阅：创建订阅组，支持“引用清单”或“302 到聚合地址”
- 设置：公开基址、重定向状态码、订阅组前缀、数据备份
- 兼容旧版 `routes:v1` 数据，会自动迁移到 `sub302:data:v2`

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
id = "你的 namespace id"
```

设置管理密码：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

部署：

```bash
npm run deploy
```

访问后台：

```text
https://你的域名/admin
```

## 使用方式

在“机场订阅”里添加：

```text
名称：主力机场
路径：main-sub
真实订阅：https://真实订阅地址
```

本地 Sub-Store 中填写固定入口：

```text
https://你的域名/main-sub
```

客户端更新时，Worker 只返回：

```http
HTTP/1.1 302 Found
Location: https://真实订阅地址
```

如果在设置中关闭“允许根路径固定入口”，固定入口会变成：

```text
https://你的域名/r/main-sub
```

## 订阅组

“我的订阅”提供两种输出方式：

- 引用清单：`/p/组slug` 返回文本清单，内容是选中的 Sub302 固定入口和手动节点 URI
- 302 到聚合地址：`/p/组slug` 直接重定向到你填写的聚合订阅地址

注意：引用清单只组合“链接引用”和“手动节点文本”，不会抓取真实订阅，也不会做节点转换。真正的订阅拉取和转换仍交给本地 Sub-Store。

## 验证 302

```bash
curl -I https://你的域名/main-sub
```

应该看到 `302` 和 `Location`，而不是订阅正文。

## 配置项

- `ADMIN_PASSWORD`：后台管理密码，建议使用 Cloudflare secret
- `REDIRECT_STATUS_CODE`：默认重定向状态码，未在后台设置时使用，默认 `302`
- `SUB_ROUTES`：Cloudflare KV namespace binding
