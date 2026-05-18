# Sub302

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

## 快速开始

### 前置要求

- Cloudflare 账号
- GitHub 账号
- 已 Fork 或拥有本项目仓库

### 推荐部署方式：Cloudflare 连接 GitHub

本项目已经包含 `wrangler.toml`，推荐直接用 Cloudflare Workers Builds 连接 GitHub 仓库。这样以后只要向 GitHub 推送代码，Cloudflare 就会自动重新部署；本地不需要执行 `wrangler deploy`。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 `Workers & Pages`
3. 点击 `Create application`
4. 选择 `Import a repository`
5. 连接 GitHub，并选择你的 `Sub302` 仓库
6. 配置项目：
   - Project name：`sub302`
   - Production branch：`main`
   - Root directory：`/`
   - Build command：留空
   - Deploy command：`npx wrangler deploy`
7. 点击 `Save and Deploy`

> 注意：这里的 `Deploy command` 是 Cloudflare 构建环境内部执行的命令，不是让你在本地手动部署。Worker 名称建议保持为 `sub302`，需要和 `wrangler.toml` 里的 `name` 一致。

## 部署指南

### 1. 创建 KV 命名空间（必需）

Sub302 使用 Cloudflare KV 保存后台配置、机场订阅、手动节点、订阅组和登录会话。

1. 打开 Cloudflare Dashboard
2. 进入 `Workers & Pages` -> `KV`
3. 点击 `Create namespace`
4. 命名建议：`sub302`
5. 创建后复制这个 KV namespace 的 `Namespace ID`

### 2. 写入 KV binding（必需）

因为本项目使用 GitHub 自动部署，并且部署命令是 `npx wrangler deploy`，最终绑定会以仓库里的 `wrangler.toml` 为准。只在 Cloudflare Dashboard 里点绑定不够，下一次 GitHub 自动部署可能会被 `wrangler.toml` 覆盖。

把下面配置加入 `wrangler.toml`，并把 `id` 换成你自己的 KV namespace id：

```toml
[[kv_namespaces]]
binding = "SUB302_KV"
id = "你的 KV namespace id"
```

绑定名必须是：

```text
SUB302_KV
```

改完后提交并推送到 GitHub，触发 Cloudflare 自动部署。

### 3. 设置环境变量（必需）

进入 Worker 项目的 `Settings` -> `Variables and Secrets`，添加生产环境变量：

| 变量名 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| `SUB302_ADMIN_PASSWORD` | Secret | 后台登录密码 | `your_secure_password` |

可选变量：

| 变量名 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `SUB302_REDIRECT_STATUS_CODE` | Variable | 默认重定向状态码 | `302` |

`SUB302_ADMIN_PASSWORD` 必须设置，否则后台无法登录。

### 4. 重新部署

KV binding 写入 `wrangler.toml` 并推送后，在 Cloudflare 的 `Deployments` 页面确认最新部署成功。

部署完成后访问：

```text
https://你的 worker 域名/admin
```

也可以直接打开 Worker 根域名，Sub302 会自动跳转到 `/admin`。

### 5. 绑定自定义域名（可选）

如果你不想使用 `workers.dev` 域名：

1. 进入 Worker 项目
2. 打开 `Settings` -> `Domains & Routes`
3. 添加自定义域名或路由
4. 在 Sub302 后台的 `设置` 中把 `公开基址` 填为你的正式域名

示例：

```text
https://sub.example.com
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

## 本地开发（可选）

只有本地调试时才需要安装依赖和使用 Wrangler：

```bash
npm install
npm run dev
```

本地开发需要在 `.dev.vars` 中设置：

```text
SUB302_ADMIN_PASSWORD=your_dev_password
```

## 配置项

- `SUB302_KV`：Cloudflare KV namespace binding，必需
- `SUB302_ADMIN_PASSWORD`：后台管理密码，必需，建议使用 Secret
- `SUB302_REDIRECT_STATUS_CODE`：默认重定向状态码，默认 `302`
- `wrangler.toml`：Cloudflare Worker 配置文件，供 Cloudflare GitHub 自动部署读取
