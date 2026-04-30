# AI Web Scraper（采集后台）

基于 **Node.js + Express + SQLite** 的后台 API，配套 **React（Vite）管理端** 与 **Chrome 扩展**，用于配置 XPath 采集规则、上报采集数据、管理图片与导出（含 **亚马逊变体扁平方 Excel** 等）。

系统支持在浏览器中完成采集图的 **下载、替换、裁剪、去背景、AI 涂抹消除、矩形区域图像修复、千问图像编辑/生成** 等在线处理；文本侧可选集成 **小米 MiMo / OpenAI 兼容接口** 做标题与描述润色。各能力是否可用取决于服务端是否配置对应第三方密钥，以及账号套餐中的 **去背景 / AI 消除 / 图片生成** 额度。

## 仓库结构

- `server/`：后端 API（`better-sqlite3`、JWT 鉴权、采集数据与图片存储、导出填表、图片处理与 AI 调用转发）
- `admin-ui/`：管理后台前端（开发态通过 Vite 代理 `/api`）
- `chrome-extension/`：Chrome 扩展（侧栏登录、选择规则、页面采集与上报）
- `deploy/nginx/`：生产环境 Nginx 配置（同路径 API 反代）
- `docker-compose.yml`：一键部署：API 容器 + Nginx 静态站点
- `scripts/`：调试与运维辅助脚本（按需使用）

## 图片在线处理

管理端路由 **`/images`（图片资源管理）** 是采集图在线处理的主入口：按采集记录列出已下载的 **主图 / 副图**（及去背景后的 **`main-nobg` / `gallery-nobg`** 等角色），缩略图通过带鉴权的 `GET /api/collections/:id/image/:role/:filename` 拉取，避免把 Token 写死在公开 URL 中。启用 **阿里云 OSS** 时，还可通过 STS 由浏览器直传对象，再通知服务端登记 manifest。

### 1. 基础管理

- **重试下载**：远端图失败时，可针对单条采集记录触发重新拉取。
- **替换 / 新增**：覆盖某槽位原图，或追加副图；替换后同槽位的去背景结果会按规则清空或需重跑（见接口注释行为）。
- **裁剪（前端）**：使用 **Cropper.js** 在弹窗中框选，确认后作为新文件上传并写回当前槽位（处理在浏览器完成，不单独占用「图片生成」类云端额度）。

### 2. 去背景（Pixian）

- 调用 **Pixian** API，支持对整组主图+副图批量去背景，或对 **单个槽位** 单独重跑（例如用户手动换图后只处理那一张）。
- 需在 `server/.env` 配置 `PIXIAN_USER`、`PIXIAN_SECRET` 等（见 `server/.env.example`）。
- 消耗账号套餐中的 **去背景额度**（`nobg_credits`）；下载完成后也可按策略自动排队去背景（见服务端逻辑）。

### 3. AI 涂抹消除（inpainting 擦除）

- 管理端在图片上涂抹生成 **mask PNG**（黑=保留，白=擦除），提交到 **`POST /api/collections/:id/image/ai-erase`**。
- 服务端按 `AI_ERASE_PROVIDER` 选择通道并调用第三方，支持 **阿里云百炼 DashScope**（默认）、**火山引擎**、**腾讯云 AI 图像修复/消除类能力**、**Stability.ai** 等；可通过 **`AI_ERASE_FALLBACK=1`** 在主通道失败时尝试其它已配置通道。
- 对应环境变量包括 `DASHSCOPE_API_KEY`、`VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`、`TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`、`STABILITY_API_KEY` 等（详见 `server/.env.example`）。
- 消耗 **AI 消除额度**（`ai_erase_credits`）。对 **去背景图** 做消除时，要求该条采集已完成去背景流程。

### 4. 图像修复（百度 inpainting）

- 在管理端框选 **矩形区域**，提交到 **`POST /api/collections/:id/image/repair`**，由 **百度图像修复（inpainting）** 按区域修补并写回当前槽位。
- 需配置 **`BAIDU_API_KEY` / `BAIDU_SECRET_KEY`**（或文档中说明的 Bearer 类变量）。未配置时接口返回 503 提示。
- 与 AI 消除类似，对 **去背景通道** 的修复同样要求 **`images_nobg_status=done`**。

### 5. 千问图像编辑 / 生成

- **`POST /api/ai/image/generate`**：以当前槽位图片为输入，结合自然语言 **prompt**，调用 **阿里云 DashScope 多模态生成**（默认模型可通过 `QWEN_IMAGE_MODEL` 配置，如 `qwen-image-edit`），返回编辑后的位图供前端展示或保存。
- 需 **`DASHSCOPE_API_KEY`**；消耗 **图片生成额度**（`image_gen_credits`）。单张输入图大小等限制以接口校验为准（例如过大时会提示先裁剪压缩）。

### 6. 与导出、公网访问的关系

- 导出到 Excel 等场景时，图片列中的 URL 依赖 **`PUBLIC_ORIGIN`**（或由请求头推导）；若需未登录访问采集图，可配置 **`PUBLIC_IMAGE_SIGNING_SECRET`** 生成带过期时间与签名的链接（见 `.env.example`）。
- 部分导出模式在存在去背景结果时，可优先使用 **去背景后的文件**（与 `GET /api/collections/:id/images-zip` 等行为一致，具体以后端实现为准）。

## 系统模块

### 数据采集管理

- **列表与筛选**：按采集时间、平台等查看采集记录；支持标记（如导出/待定/丢弃）与筛选。
- **详情编辑**：展开单条记录进行编辑（与列表「标记」联动）。
- **导出数据**：导出类型来自服务端注册的 `GET /api/export/types`。
  - 若勾选「隐藏共享模板」，导出弹窗中也可隐藏其它用户的共享模板类型。
- **导出映射草稿**：导出时可使用服务端保存的映射草稿。

### 图片资源管理

- 与上文 **「图片在线处理」** 一致：在 **`/images`** 集中完成下载状态查看、替换、裁剪、去背景、AI 消除、修复与千问编辑等操作（具体按钮与可用性以前端与权限为准）。

### 采集规则管理

- **规则配置**：配置 XPath 等采集规则，供扩展在页面中执行采集并上报。
- **规则权限**：管理员可为非管理员用户配置可用模块/权限。

### 导出映射配置

- **上传空模板**：解析 Excel 表头，生成模板与 `exportTypeId`。
- **共享模板**：带「共享」标识；映射只读，可复制为私有模板。
- **重命名**：仅自己的模板可重命名。
- **隐藏共享模板**：影响本页与数据采集导出弹窗中的模板下拉。

#### 模板命名规则（按用户隔离）

模板名称允许不同用户重名；仅在同一用户名下限制重名。

### 浏览器插件（Chrome 扩展）

- **侧栏登录**、**选择规则**、**上报采集数据**。
- 采集记录可在「图片资源管理」继续处理图片，在「导出映射配置」保存映射后导出。

## 环境要求

- Node.js 18+（建议 LTS）
- npm
- 构建 Docker 镜像时需本机已安装 Docker / Docker Compose

## 本地开发

### 1. 后端

```bash
cd server
npm install
copy .env.example .env   # Windows；Linux/macOS: cp .env.example .env
# 按需编辑 .env：Pixian、DashScope、去背景/AI 消除/千问图生、亚马逊模板路径等见文件内注释
npm run dev
```

默认监听 **3780**；数据库文件默认在 `server/data.db`（可通过环境变量 `DB_PATH` 指定）。

### 2. 管理端

```bash
cd admin-ui
npm install
npm run dev
```

开发服务器为 **http://127.0.0.1:5173**，已将 `/api` 代理到 `http://127.0.0.1:3780`。

主要路由示例：`/collections`（采集与导出）、`/data-export`、`/images`、`/rules`、`/users`。

### 3. Chrome 扩展

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本仓库下的 `chrome-extension/`
3. 在扩展侧栏中配置后台地址（与上述管理端或生产域名一致）

### 4. 后端测试

```bash
cd server
npm test
```

## 首次登录

空库首次启动会自动创建默认管理员（见 `server/src/db.js`）：

- 用户名：`admin`
- 密码：`admin123`

**部署到公网前务必修改密码，并设置强 `JWT_SECRET`。**

## 常见问题（Troubleshooting）

### 1) 后端一直重启 / 前端提示 Internal Server Error

若看到 `better-sqlite3` 类似报错（Node 模块版本不匹配），执行：

```bash
cd server
npm rebuild better-sqlite3
```

然后重新 `npm run dev`。

### 2) 端口被占用（EADDRINUSE :3780）

说明 `3780` 端口已有进程在监听。结束占用端口的进程后再启动后端。

### 3) 管理端 HTTPS、OSS 使用 HTTP 域名时图片不显示

若静态站为 HTTPS、OSS 绑定域仅为 HTTP，浏览器可能把图片请求升级为 HTTPS 导致失败。可优先使用同源带 Token 的 API 拉图（本仓库图片管理已做兼容），并保证 `OSS_PUBLIC_ORIGIN` 与前端构建变量协议一致（见 `server/.env.example` 说明）。

## 亚马逊等平台 Excel 导出

- **导出类型目录**：`GET /api/export/types` 返回用户在「导出映射配置」中上传空模板后写入数据库的记录（每条含 `exportTypeId`、`destPlatformId` 等）；**导出目标平台**列表见 `GET /api/export/platforms`（内置平台 ID 与 `server/src/export/exportPlatformCatalog.js` 一致，例如亚马逊为 `00000000-0000-4000-8000-000000000001`，Temu、Shopee 等为后续固定 UUID）。
- **填表逻辑**：服务端按 **持久化到磁盘的 xlsx 模板**（默认在 `server/uploads/export-templates/`，见 `server/.env.example` 说明）与保存的 **列映射草稿** 写入；通用填表与表头处理见 `server/src/export/fillExportTemplate.js`，**亚马逊变体扁平方** 等专用逻辑见 `server/src/export/amazonFlatExport.js`（占位列、父/子 SKU 等以代码为准）。
- 导出表格中的图片 URL 依赖 **`PUBLIC_ORIGIN`**（或请求头推导）；若需匿名直链，可配置 **`PUBLIC_IMAGE_SIGNING_SECRET`**（见 `server/.env.example`）。

## 环境变量说明

复制 `server/.env.example` 为 `server/.env`。除 JWT、数据库、端口外，常见项包括：

| 变量 | 说明 |
|------|------|
| **PIXIAN_*** | Pixian 去背景 API（可选；与去背景额度配合） |
| **DASHSCOPE_API_KEY** | 百炼：AI 涂抹消除（默认通道）、千问图像编辑/生成 |
| **AI_ERASE_PROVIDER** / **AI_ERASE_FALLBACK** | AI 消除通道与是否跨通道回退 |
| **VOLC_*** / **TENCENT_*** / **STABILITY_API_KEY** | 其它 AI 消除可选通道 |
| **BAIDU_API_KEY** / **BAIDU_SECRET_KEY** | 百度图像修复（矩形 inpainting） |
| **QWEN_IMAGE_MODEL** | 千问图像编辑模型名（可选，默认 `qwen-image-edit`） |
| **MIMO_*** / **OPENAI_*** | 文本大模型（MiMo 或 OpenAI；用于标题/描述等，与 `AI_PROVIDER` 配合） |
| **JWT_SECRET** | JWT 签名密钥（生产必填） |
| **PUBLIC_ORIGIN** | 导出中图片完整 URL 的站点根（生产建议 `https://你的域名`） |
| **PUBLIC_IMAGE_SIGNING_SECRET** | 采集图匿名访问签名（可选） |
| **OSS_*** | 阿里云 OSS：服务端写对象、STS 直传（可选） |
| **DB_PATH** | SQLite 文件路径（可选，默认 `server/data.db`） |
| **PORT** | API 端口（默认 `3780`） |

其余说明（如 `COLLECTIONS_UPLOAD_LOG`、`MIMO_AUTO_ENRICH` 等）以 `server/.env.example` 内注释为准。

## Docker 部署

1. 先构建管理端静态文件（`docker-compose` 注释中已说明）：

   ```bash
   cd admin-ui
   npm install
   npm run build
   ```

2. 准备 `server/.env`（与本地一致；**含 JWT、第三方 API、PUBLIC_ORIGIN、导出与图片相关等生产必填项**；Compose 会只读挂载进容器）。

3. **修改** `docker-compose.yml` 中的 `JWT_SECRET` 与对外端口映射（示例为宿主 `8806:80`），勿把容器内 Nginx 监听端口改成宿主端口。

4. 启动：

   ```bash
   docker compose up -d --build
   ```

5. 浏览器访问 `http://<宿主IP>:8806`（端口以你修改后的为准）。

持久化数据在命名卷 `scraper_data`（容器内数据库路径为 `/data/data.db`）。

## 安全与隐私

- 不要将 `server/.env`、数据库文件、真实 `JWT_SECRET` 提交到 Git（仓库已提供 `.gitignore`）。
- `server/images/` 与本地 `*.db` 为运行期数据，默认已忽略。
- 图片处理会将原图与 mask 发往所配置的第三方云服务，请在隐私政策与用户协议中如实说明，并妥善保管各云平台密钥。

## 许可证

若需对外分发，请在本仓库补充许可证文件（如 `LICENSE`）。
