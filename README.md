# Sub302

Sub302 是一个部署在 Cloudflare Pages Functions 上的订阅入口管理器。它的核心原则很简单：

- 单条机场订阅入口只返回 `302/307/308/303 Location`
- 不在 Cloudflare 端 `fetch()` 真实订阅
- 不解析、不合并、不转换订阅内容
- 本地 Sub-Store 负责订阅拉取、转换和聚合处理

## 功能

- 仪表盘：查看机场订阅、手动节点、订阅组和启用入口数量
- 机场订阅：维护真实订阅 URL，生成固定 Sub302 入口
- 手动节点：保存单条节点 URI，供订阅组清单引用；输出订阅组时会把“名称”写回节点名
- 我的订阅：创建订阅组，支持“引用清单”或“302 到聚合地址”
- 设置：公开基址、控制台安全路径、重定向状态码、订阅组前缀、数据备份
- 兼容旧版 `routes:v1` 数据，会自动迁移到 `sub302:data:v2`

## 推荐部署方式：Cloudflare Pages 连接 GitHub

Sub302 现在参考 MiSub 的方式使用 Cloudflare Pages Functions 部署。KV 绑定、环境变量和 Secret 都放在 Cloudflare Pages 项目的 Dashboard 里配置，不写进仓库配置文件。这样以后每次向 GitHub 推送代码时，Pages 只更新代码和函数，不会把 Dashboard 里的 KV 绑定覆盖掉。

### 1. 创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 `Workers & Pages`
3. 点击 `Create application`
4. 选择 `Pages`
5. 选择 `Connect to Git`
6. 连接 GitHub，并选择你的 `Sub302` 仓库
7. 配置项目：
   - Project name：`sub302`
   - Production branch：`main`
   - Root directory：`/`
   - Framework preset：`None`
   - Build command：留空，或填写 `npm run build`
   - Build output directory：`public`
8. 点击 `Save and Deploy`

> 不要再把 Deploy command 配成 `npx wrangler deploy`。那是 Workers 部署方式，会重新用仓库配置覆盖 Worker 设置，也是之前 KV 绑定反复失效的原因。

### 2. 绑定 KV 命名空间（必需）

第一次部署完成后，进入刚创建的 Pages 项目：

1. 打开 `Settings`
2. 进入 `Functions`
3. 找到 `KV namespace bindings`
4. 点击 `Add binding`
5. Variable name 填写：

```text
SUB302_KV
```

6. KV namespace 选择已有命名空间，或新建一个命名空间
7. 保存

只有 Variable name 必须固定为 `SUB302_KV`。KV namespace 的显示名称可以叫 `sub302`，也可以使用你已有的命名空间。

### 3. 设置环境变量（必需）

仍然在 Pages 项目的 `Settings` 中，进入 `Environment variables`，添加生产环境变量：

| 变量名 | 类型 | 说明 | 示例 |
| --- | --- | --- | --- |
| `SUB302_ADMIN_PASSWORD` | Secret | 后台登录密码 | `your_secure_password` |

可选变量：

| 变量名 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `SUB302_REDIRECT_STATUS_CODE` | Variable | 默认重定向状态码 | `302` |

`SUB302_ADMIN_PASSWORD` 必须设置，否则后台无法登录。

### 4. 重新部署一次

KV 和环境变量保存后，回到 Pages 项目的 `Deployments`，对最新的生产部署点击 `Retry deployment` 或重新向 GitHub 推送一次提交。

这一步只需要在第一次添加绑定和变量后做一次。后续正常更新代码时，继续直接 push 到 GitHub 即可，`SUB302_KV` 绑定不会掉。

## 访问后台

Pages 默认域名类似：

```text
https://sub302.pages.dev
```

默认后台地址：

```text
https://你的 Pages 域名/admin
```

进入后台后，可以在 `设置` -> `控制台安全路径` 中把 `admin` 改成类似 `token123456` 的路径。保存后，后台地址会变成：

```text
https://你的 Pages 域名/token123456
```

改成自定义路径后，根路径 `/` 和旧的 `/admin` 都不会打开控制台。

## 绑定自定义域名（可选）

如果你不想使用 `pages.dev` 域名：

1. 进入 Pages 项目
2. 打开 `Custom domains`
3. 添加你的自定义域名
4. 在 Sub302 后台的 `设置` 中把 `公开基址` 填为你的正式域名

示例：

```text
https://sub.example.com
```

如果你之前已经把本地 Sub-Store 指向了旧的 `workers.dev` 地址，切换到 Pages 后建议绑定一个自定义域名，并把 Sub-Store 里的固定入口改成这个自定义域名。之后再更新 Sub302 代码，域名和 KV 绑定都不会被影响。

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

客户端更新时，Cloudflare 只返回：

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

注意：引用清单只组合“链接引用”和“手动节点文本”，不会抓取真实订阅，也不会做节点转换。手动节点会在输出时按后台名称改写节点名，例如 `vmess://` 会更新 Base64 JSON 里的 `ps`，常见 URL 节点会更新 `#` 后面的名称。真正的订阅拉取和转换仍交给本地 Sub-Store。

## 验证 302

```bash
curl -I https://你的域名/main-sub
```

应该看到 `302` 和 `Location`，而不是订阅正文。

## 本地开发（可选）

只有本地调试时才需要安装依赖和使用 Wrangler：

```bash
npm install
```

创建 `.dev.vars`：

```text
SUB302_ADMIN_PASSWORD=your_dev_password
SUB302_REDIRECT_STATUS_CODE=302
```

启动 Pages Functions 本地服务：

```bash
npm run dev
```

本地开发会使用 Wrangler 的本地 KV，绑定名同样是 `SUB302_KV`。

## 配置项

- `SUB302_KV`：固定的 Cloudflare Pages Functions KV binding 变量名，必需
- `SUB302_ADMIN_PASSWORD`：后台管理密码，必需，建议使用 Secret
- `SUB302_REDIRECT_STATUS_CODE`：默认重定向状态码，默认 `302`
