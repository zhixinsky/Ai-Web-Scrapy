# AI Web Scraper（采集后台）

基于 **Node.js + Express + SQLite** 的后台 API，配套 **React（Vite）管理端** 与 **Chrome 扩展**，用于配置 XPath 采集规则、上报采集数据、管理图片与导出（含 **亚马逊变体扁平方 Excel** 等）。可选集成 **Pixian 去背景**、**小米 MiMo** 等能力。

## 仓库结构

- `server/`：后端 API（`better-sqlite3`、JWT 鉴权、采集数据与图片存储、导出填表）
- `admin-ui/`：管理后台前端（开发态通过 Vite 代理 `/api`）
- `chrome-extension/`：Chrome 扩展（侧栏登录、选择规则、页面采集与上报）
- `shared/`：前后端共用的平台提示词等（如 `platformPrompts/`）
- `deploy/nginx/`：生产环境 Nginx 配置（同路径 API 反代）
- `docker-compose.yml`：一键部署：API 容器 + Nginx 静态站点

## 系统模块

下面按 4 个核心模块介绍系统能力与典型流程。

### 数据采集管理

- **列表与筛选**：按采集时间、平台等查看采集记录；支持标记（如导出/待定/丢弃）与筛选。
- **详情编辑**：展开单条记录进行编辑（与列表“标记”联动）。
- **导出数据**：在列表中导出单条/批量采集数据；导出类型来自服务端注册的 `GET /api/export/types`。
  - 若勾选了“隐藏共享模板”（见下方“导出映射配置”），导出弹窗中也不会显示其它用户的共享模板导出类型。
- **导出映射草稿**：导出时可使用服务端保存的映射草稿（若未传草稿，服务端可按 `exportTypeId` 自动套用已保存草稿）。

### 图片资源管理

- **按采集记录管理图片**：展示采集记录对应的主图/副图等文件情况。
- **下载/重试/替换**：对图片下载失败或需替换的场景提供管理入口（具体能力以页面按钮为准）。
- **可选去背景**：可集成 Pixian 去背景（需在 `server/.env` 配置相关变量）。

### 采集规则管理

- **规则配置**：配置 XPath 等采集规则，用于扩展在页面中执行采集并上报数据。
- **规则权限**：管理员可为非管理员用户配置可用模块/权限（以系统页面与后端鉴权逻辑为准）。

### 导出映射配置

该模块用于为“用户上传的空模板 Excel”配置列映射，并保存到服务端，供导出时自动套用。

- **上传空模板**：解析 Excel 表头，生成一个模板与对应 `exportTypeId`。
- **共享模板（公开模板）**：
  - 下拉列表会在模板最左侧显示 **「共享」** 标识。
  - 共享模板的映射配置为**只读**（不可编辑/保存/导入/清空）。
  - 可点击 **复制** 快速创建一份**自己的私有模板**（并复制映射草稿）。
- **重命名（仅自己的模板）**：下拉项右侧提供 **重命名**（居中弹窗）。
- **隐藏共享模板**：在「上传空模板」按钮左侧提供勾选框
  - 勾选后只显示**自己创建的模板**（不显示其它用户的共享模板）。
  - 该开关同时影响：
    - 「导出映射配置」页的模板下拉
    - 「数据采集管理 → 导出数据」弹窗的导出类型下拉

#### 模板命名规则（按用户隔离）

模板名称允许**不同用户重名**；仅在**同一用户**名下限制重名。

### 浏览器插件（Chrome 扩展）

- **侧栏登录**：使用后台账号登录后，将 Token 用于后续上报请求。
- **选择采集规则**：从后台读取并选择规则，在当前页面按规则执行采集（例如 XPath 提取字段）。
- **上报采集数据**：将采集结果提交到后端，生成采集记录，后续可在「数据采集管理」中查看、编辑、导出。
- **与图片/导出联动**：采集记录可在「图片资源管理」进行图片下载/替换，在「数据采集管理」或「导出映射配置」完成映射后导出。

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
# 按需编辑 .env（Pixian / MiMo / 亚马逊模板路径等见文件内注释）
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

主要路由示例：`/collections`（采集与导出）、`/data-export`（数据导出相关）、`/images`、`/rules`、`/users`。

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

## 亚马逊 Excel 导出（`target=amazon`）

- 服务端按 **磁盘上的空表 xlsx** 与 **列映射** 写入，不向客户端索要整本模板 Base64。  
- 内置导出类型 **coat（大衣）**、**shirt（衬衫）**，固定 UUID（与 `GET /api/export/types` 一致）：  
  - coat：`00000000-0000-4000-8000-000000000001`  
  - shirt：`00000000-0000-4000-8000-000000000002`  
- 列映射与英文表头行定义在 `server/src/export/builtinExportTemplates/`（如 `coatAmazon.js`、`shirtAmazon.js`）及 `server/src/export/data/*_amazon_header_row.txt`；空表示例见 `server/export/data/amazon_*_empty.xlsx`。  
- **必填环境变量**：在 `server/.env` 中配置 `AMAZON_EXPORT_SERVER_TEMPLATE_PATH`（单模板 xlsx）或 `AMAZON_EXPORT_SERVER_TEMPLATE_INDEX`（JSON，按 `exportTypeId` 指向不同 xlsx）。详见 `server/.env.example`。  
- 多模板索引文件与空表 xlsx 一并放在 **`server/export/data/`**（默认 `amazon_export_template_index.json`）；书写格式示例：`server/src/export/data/amazon_export_template_index.example.json`。  
- 导出表格中的图片 URL 依赖 **`PUBLIC_ORIGIN`**（或请求头推导）；若需匿名直链，可配置 **`PUBLIC_IMAGE_SIGNING_SECRET`**（见 `.env.example`）。

## 环境变量说明

复制 `server/.env.example` 为 `server/.env`。除 JWT、数据库、端口外，常见项包括：

| 变量 | 说明 |
|------|------|
| **PIXIAN_*** | Pixian 去背景 API（可选） |
| **MIMO_*** | 小米 MiMo OpenAI 兼容接口（可选，用于标题/描述等） |
| **JWT_SECRET** | JWT 签名密钥（生产必填） |
| **PUBLIC_ORIGIN** | 导出中图片完整 URL 的站点根（生产建议 `https://你的域名`） |
| **PUBLIC_IMAGE_SIGNING_SECRET** | 采集图匿名访问签名（可选） |
| **AMAZON_EXPORT_SERVER_TEMPLATE_PATH** | 亚马逊导出用空表 xlsx 路径（与索引二选一或作回退） |
| **AMAZON_EXPORT_SERVER_TEMPLATE_INDEX** | 按导出类型 id 映射到不同 xlsx 的 JSON 路径 |
| **AMAZON_EXPORT_SERVER_TEMPLATE_HEADER_ROW** / **DATA_START_ROW** / **SHEET_NAME** | 覆盖模板表头行、数据起始行、工作表名（可选） |
| **DB_PATH** | SQLite 文件路径（可选，默认 `server/data.db`） |
| **PORT** | API 端口（默认 `3780`） |

其余说明（如 `COLLECTIONS_UPLOAD_LOG`、`MIMO_AUTO_ENRICH` 等）以 `.env.example` 内注释为准。

## Docker 部署

1. 先构建管理端静态文件（`docker-compose` 注释中已说明）：

   ```bash
   cd admin-ui
   npm install
   npm run build
   ```

2. 准备 `server/.env`（与本地一致；**需包含亚马逊模板路径等生产必填项**；Compose 会只读挂载进容器）。

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

## 许可证

若需对外分发，请在本仓库补充许可证文件（如 `LICENSE`）。
