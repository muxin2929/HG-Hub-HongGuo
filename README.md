# HG-Hub-HongGuo

> **三端短剧客户端复刻项目：React 前端 + Python 内容网关 + Android / Windows 壳。**
>
> 本项目仅用于 **UI / 交互 / 架构的学习与技术研究**，不提供、不托管、不分发任何影视内容。
> 与红果短剧、抖音、字节跳动及任何内容平台均无关联。请只使用你有权访问的合法内容源。

---

## 下载

- Release 页面：<https://github.com/muxin2929/HG-Hub-HongGuo/releases/latest>
- Android：`HG-1.5.46.apk`
- Windows：`HG-Setup-1.3.2.exe`
- 文件校验：同页 `SHA256SUMS.txt`

> 安装包按作者自用环境构建，内含公开站点域名与更新源；**不含**生产服务器 IP、SSH 端口、面板地址、密码、证书或用户数据。源码本身不含任何真实地址。

---

## 一、项目是什么

HG-Hub-HongGuo 是一个「短剧类 App」的三端复刻实现，参考红果免费短剧的公开界面与交互，用一套自建代码把手机端、桌面端和内容网关串起来：

| 端 | 技术 | 作用 |
|---|---|---|
| Web / 手机页面 | React 19 + Vite + TypeScript | 首页沉浸式信息流、剧场、详情、播放器、评论、搜索、我的 |
| 内容网关 | Python 3.10+（标准库，零第三方依赖） | 统一内容源接口、HLS 清单改写、封面解码、磁盘缓存、自建账号 |
| Android App | 原生 Java + ExoPlayer(Media3) + WebView | WebView 画 UI，原生播放器解码 H.264/HEVC，支持应用内更新 |
| Windows 桌面端 | Electron + electron-updater | 加载网页版，托盘常驻、自动更新 |

项目不是简单套壳：首页滑到哪播哪、原生播放器与网页浮层的对齐、HLS 分片同源化、封面解密、账号与观看历史、应用内热更新，都是完整跑通的。

> 仓库里 **没有** 影视文件、图片素材、字体、商标资源、服务器凭据、用户数据库或签名证书。
> 所有域名、包名、服务地址均为占位符，部署时请替换成你自己的环境。

---

## 二、功能一览

### 手机端（Web / Android）

- **首页推荐流**：黑色沉浸式全屏；顶栏汉堡菜单 + 频道切换 + 搜索；两行弹幕；滑到哪自动播哪；静音起播、点按暂停、双击点赞；右侧收藏 / 评论 / 点赞 / 分享；底部进度条与「观看完整剧情」；滑到底自动加载下一页。
- **剧场**：搜索框、识剧入口、频道行、筛选 / 排序、双列卡片、原创 / 新剧角标、热度与标签。
- **详情页**：封面、标题、集数、热度、评分、分类、简介展开 / 收起、选集分段（如 1-30 / 31-47）、猜你喜欢。
- **播放器**：竖屏沉浸播放、全屏横屏、进度预览、选集切换、倍速、静音、自动下一集；Android 端使用原生 ExoPlayer 解码，WebView 只画浮层。
- **评论**：底部抽屉、分页、回复展开、点赞、本地评论与上游评论合并展示。
- **搜索**：热搜词、结果双列、上拉分页、空结果提示。
- **我的**：薄荷渐变头部、历史 / 收藏 / 追更 / 点赞、三列封面、金币 / 订单 / 消息 / 提现入口。
- **账号**：自建注册 / 登录 / 登出、观看历史与续播、点赞 / 收藏、本地评论；未登录自动退回 localStorage，不阻断播放。
- **分享与深链**：复制链接、系统分享、`?v=<id>&ep=<n>` 直接定位。
- **抽屉与设置**：检查更新、反馈、关于、主题、关闭行为、下载与钱包入口。

### 桌面端（Windows）

- 左侧导航 + 宽屏布局，和手机端共用一套设计变量与业务代码。
- 托盘常驻：关窗口默认隐藏到托盘，可从托盘退出。
- 自动更新：`electron-updater` + `latest.yml`，支持后台下载、重启安装。
- 支持 `--url=https://...` 或 `HG_URL` 环境变量指向任意自建站点。

### 网关

| 路由 | 说明 |
|---|---|
| `GET /healthz` | 健康检查、缓存统计 |
| `POST /api/play` | `{id, ep}` → 上游播放信息（请求体固定 `{}`） |
| `GET/POST /api/<path>` | 同源透传上游 `/api/<path>`，查询串保留 |
| `GET /img?u=<封面>` | 封面解密 → JPEG/PNG，域名白名单 + 磁盘缓存 |
| `GET /media/manifest?u=<m3u8>` | 把清单内所有 URI 改写成 `/media/seg|key?u=<绝对地址>` |
| `GET /media/seg` / `/media/key` | 分片 / 密钥转发，支持 Range 与磁盘缓存 |
| `GET /` | 托管 `web/dist`，SPA 回退 |

其他能力：

- `/api/auth/*`：注册、登录、登出、当前用户、改昵称/头像；
- `/api/me/history`：观看历史与续播（按 `video_id` upsert）；
- `/api/me/actions`：点赞 / 收藏幂等 toggle；
- `/api/me/comments`：本地评论；
- 账号库使用 SQLite（WAL）+ `hashlib.scrypt`，token 随机会话，30 天过期；
- `/api/*` 内存缓存、封面永久磁盘缓存、分片 TTL 缓存；
- 上游鉴权过期时返回 409，前端只需判断一次。

---

## 三、架构

```
┌──────────────────────────────────────────────────────────────┐
│  Android App (Java)                                          │
│  ┌───────────────────────┐   ┌────────────────────────────┐  │
│  │ WebView (React UI)    │   │ ExoPlayer (Media3)         │  │
│  │ appassets 虚拟域名     │◄──│ 原生视频层，垫在 WebView 下 │  │
│  └──────────┬────────────┘   └─────────────┬──────────────┘  │
└─────────────┼──────────────────────────────┼─────────────────┘
              │ HTTPS                        │ HLS
              ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│  内容网关（Python，单进程）                                    │
│  /api/* 透传 · /img 解密 · /media/manifest 改写 · /media/seg   │
│  SQLite 账号 · 内存/磁盘缓存 · 静态站点托管                    │
└─────────────┬────────────────────────────────────────────────┘
              │ 你配置的合法上游
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Upstream（自备 / 已授权的内容源）                              │
└──────────────────────────────────────────────────────────────┘

Windows: Electron BrowserWindow ──► 同一个 Web 前端 ──► 同一个网关
```

设计要点：

1. **客户端只跟网关说话**：HLS 清单在服务端改写，播放器不再需要「直连 / 代理」切换。
2. **一套 CSS 变量控制三端**：颜色、字号、圆角、动效集中在 `web/src/styles.css`。
3. **原生播放器与 WebView 分层**：Android 端视频画面由 ExoPlayer 渲染，网页只保留透明浮层与控制条。
4. **配置与代码分离**：域名、包名、更新地址全部走占位符 / 环境变量，仓库不携带作者线上环境。

---

## 四、目录结构

```
HG-Hub-HongGuo/
├─ web/                    React + Vite + TS 前端
│  ├─ src/pages/           首页 / 剧场 / 详情 / 搜索 / 我的 / 排行 / 下载
│  ├─ src/components/      TabBar / Drawer / 播放器 / 评论 / 分享 / 图标
│  ├─ src/core/            播放、账号、设置、更新、原生桥、缓存
│  ├─ src/data/            API 封装、类型、mock 数据、封面
│  ├─ src/styles.css       设计令牌 + 全部样式
│  ├─ Dockerfile
│  └─ .env.production.example
├─ gateway/                Python 内容网关
│  ├─ app.py               HTTP 服务与路由
│  ├─ hgcore.py            上游解析、清单改写、封面解码、数据归一
│  ├─ account.py           SQLite 账号体系
│  ├─ catalog.py           剧库快照
│  ├─ upfill.py            封面 / 元数据补齐
│  ├─ aes.py               纯 Python AES-128-CBC 兜底
│  ├─ probe.py             内容源勘察器
│  ├─ selftest*.py         端到端自测
│  └─ Dockerfile
├─ android/                Android 壳（无 Gradle，aapt2 + javac + d8 + apksigner）
│  ├─ src/                 Java 源码（MainActivity / HgPlayer / HgTabBar / UpdateReceiver）
│  ├─ res/                 Manifest 资源、图标、FileProvider 路径
│  ├─ vendor/              Media3 / AndroidX 依赖 jar
│  └─ build-apk.ps1        Windows 构建脚本
├─ desktop/                Electron 桌面壳
│  ├─ main.js              窗口 / 托盘 / 菜单 / 自动更新
│  ├─ preload.js           IPC 桥
│  └─ package.json
├─ deploy/                 通用部署脚本、systemd、Nginx 示例
├─ docker-compose.yml
├─ version.json            三端版本号
├─ SECURITY.md
└─ README.md
```

---

## 五、快速开始

### 1. 只跑前端（演示数据，无需后端）

```bash
cd web
npm install
npm run dev
```

`web/.env.development` 默认 `VITE_MOCK=1`，页面使用内置的虚构演示数据。
打开 `http://localhost:5173`，按 F12 切到 iPhone 尺寸即可。

接真实网关时，把 `web/.env.development` 改成 `VITE_MOCK=0`（或删除该文件）。

### 2. 跑网关 + 前端（接你自己的内容源）

```bash
# 终端 1
cd gateway
UPSTREAM=https://your-upstream.example python app.py

# 终端 2
cd web
npm install
npm run dev
```

Vite 已把 `/api`、`/img`、`/media` 代理到 `127.0.0.1:8080`。

### 3. Docker

```bash
docker compose up -d --build
```

- 网关：`http://localhost:8080`
- 前端容器：`http://localhost:8081`

---

## 六、配置

| 变量 | 位置 | 说明 |
|---|---|---|
| `UPSTREAM` | 网关 | 内容源根地址，**必须换成你有权访问的地址** |
| `HOST` / `PORT` | 网关 | 默认 `0.0.0.0:8080` |
| `WEB_DIR` | 网关 | 前端 `dist` 目录 |
| `CACHE_DIR` | 网关 | 封面 / 分片缓存目录 |
| `ACCOUNT_DB` | 网关 | 账号 SQLite 路径，默认 `../data/account.db` |
| `API_TTL` | 网关 | `/api/*` 内存缓存秒数，默认 20 |
| `SEG_CACHE` / `IMG_CACHE` / `MANIFEST_CACHE` | 网关 | 各类缓存开关 |
| `IMG_KEY` / `IMG_IV` | 网关 | 封面解密参数（16 字节 hex）；不同内容源不同，留空则只处理明文封面 |
| `IMG_HOSTS` / `MEDIA_HOSTS` | 网关 | 允许的图床 / 媒体域名，逗号分隔；默认只放行 `UPSTREAM` 自身域名 |
| `EXTRA_HOSTS` | 网关 | 额外放行的图片 / 媒体域名，逗号分隔 |
| `VITE_MOCK` | 前端 | `1` 使用内置演示数据 |
| `VITE_API_BASE` | 前端 | 生产构建的网关绝对地址 |
| `VITE_PUBLIC_ORIGIN` | 前端 | 分享链接使用的公开站点地址 |
| `HG_URL` | 桌面端 | 启动时加载的站点地址，也可用 `--url=` |

生产构建示例：

```bash
cd web
cp .env.production.example .env.production
# 编辑 .env.production，填入你自己的 HTTPS 域名
npm run build
```

> `.env.production` 已被 `.gitignore` 忽略，不会被提交。

---

## 七、三端构建

### Web

```bash
cd web
npm ci
npm run typecheck
npm run build          # 产物 dist/
```

### Android

前置条件：

- JDK 17+；
- Android SDK：`build-tools;36.0.0`、`platforms;android-34`；
- `aapt2`、`javac`、`d8`、`zipalign`、`apksigner` 可用；
- `android/vendor/` 下的 Media3 / AndroidX jar（仓库已带）。

步骤：

1. 构建前端并复制到 APK 内置资源目录：

```bash
cd web
npm run build
rm -rf ../android/assets/www
cp -r dist ../android/assets/www
```

2. 修改 `android/src/io/github/muxin2929/hghub/MainActivity.java`：

```java
private static final String API_BASE = "https://your-domain.example";
```

3. 构建：

```powershell
cd android
powershell -ExecutionPolicy Bypass -File build-apk.ps1
```

脚本会用 `debug.keystore` 生成调试签名；首次运行会自动创建。正式分发请替换成你自己的签名证书，并妥善保管，**不要提交到仓库**。

> `android/build-apk.ps1` 里的 SDK 路径默认是 `C:\Android\sdk`，可按自己的安装位置修改。

### Windows 桌面端

```bash
cd desktop
npm install
npm start                    # 开发运行
npm start -- --url=https://your-domain.example/
npm run build                # electron-builder --win nsis，产物在 release/
```

桌面端默认加载 `https://your-domain.example/`。正式打包前请把 `desktop/main.js` 里的 `DEFAULT_URL` 改成你的站点；运行时也可以用 `HG_URL` 环境变量或 `--url=` 覆盖。
`package.json` 的 `publish` 指向 GitHub Releases；发布时把 `latest.yml`、安装包和 `.blockmap` 一起上传，自动更新才能工作。

---

## 八、部署

完整步骤见 [`deploy/README.md`](deploy/README.md)。最短路径：

```bash
SERVER=root@YOUR_SERVER_IP bash deploy/deploy.sh
```

默认安装到 `/opt/hg`，systemd 服务名 `hg-gateway`，端口 8080。脚本只使用占位符，不会写入任何真实服务器信息。

---

## 九、复刻说明

### 9.1 参考对象与边界

- 参考对象：**红果免费短剧** 公开客户端的界面布局、信息层级、交互反馈与视觉风格。
- 复刻方式：基于公开截图与可见交互做 **界面级 / 交互级** 还原，不反编译原 App，不复制其私有代码、图片、字体、图标或文案资源。
- 复刻范围：首页推荐流、剧场、详情、播放器、评论、搜索、消息、分享、抽屉、我的等页面，以及滑播、双击点赞、进度预览、选集、返回栈等交互。
- 不包含：会员 / 付费解锁、账号破解、风控绕过、任何付费内容获取逻辑。
- 图标：除第三方库自带图标外，界面图标为自制 SVG；字体使用系统字体。

### 9.2 逐页面还原点

| 页面 | 还原内容 |
|---|---|
| 首页 | 黑色沉浸背景；汉堡 + 频道 + 搜索顶栏；两行弹幕；右侧竖栏；底部「观看完整剧情」；滑播与自动下一页 |
| 剧场 | 搜索框、识剧、频道行、筛选/排序、双列卡片、角标、热度、标签 |
| 详情 | 棕色沉浸头部、封面、标题、集数、评分、分类、简介展开、选集分段、猜你喜欢 |
| 播放器 | 竖屏沉浸、横屏全屏、进度预览、选集、倍速、静音、自动下一集 |
| 评论 | 底部抽屉、分页、回复展开、点赞、输入框 |
| 我的 | 薄荷渐变头部、金币/订单/消息/提现、历史/收藏/追更/点赞、三列封面 |
| 搜索 | 热搜词、双列结果、上拉分页、空结果 |
| 消息 | 全部/回复/赞和收藏、角标、引用内容、剧集缩略图 |
| 抽屉 | 检查更新、反馈、关于、下载、钱包等入口 |

### 9.3 设计系统

- 所有颜色、字号、间距、圆角、动效集中在 `web/src/styles.css` 的 CSS 变量里；
- 同一套变量同时服务手机竖屏、横屏播放器与桌面宽屏；
- 主题通过 `html.dark` / `html.light` 切换，桌面端同步 Electron 原生标题栏；
- 动效以 CSS transition / transform 为主，避免阻塞播放线程。

### 9.4 技术复刻路线

1. 先用 mock 数据把 UI 定下来（`web/src/data/mock.ts`）；
2. 网关把上游接口归一成稳定字段（`gateway/hgcore.py`）；
3. 前端只依赖 `web/src/data/api.ts`，切换真实/演示数据不改页面代码；
4. Android 用原生 ExoPlayer 补齐 WebView 不支持的 HEVC / 高码率；
5. Electron 复用同一套前端，补托盘、菜单、自动更新。

### 9.5 与「原版」的差异

- 内容、账号、评论、点赞、历史全部来自你自己的网关 / 本地存储，与原 App 无关；
- 没有原 App 的推荐算法、风控、会员体系、广告体系；
- 视觉上追求「像」，但不使用原 App 的商标、图标、字体与素材；
- 代码结构、接口封装、缓存策略、原生播放器方案均为独立实现。

---

## 十、安全与隐私

- 仓库不包含服务器 IP、SSH 端口、面板地址、Cookie、Token、证书、数据库、签名证书；
- 所有线上地址均为 `your-domain.example` / `your-upstream.example` 占位符；
- `.gitignore` 已排除 `.env.production`、`local.properties`、`*.jks`、`*.keystore`、`*.apk`、`*.exe`、缓存、测试库、日志等；
- 自建账号库只存你自己的用户数据，部署时请把 `data/account.db` 放在 Git 之外并定期备份；
- 如果发现敏感信息泄露或安全漏洞，请按 [`SECURITY.md`](SECURITY.md) 的方式私下报告，不要开公开 Issue。

> 官方 Release 中的 APK / EXE 按作者自用环境构建，内含公开站点域名与更新源；**不包含**生产服务器 IP、SSH 端口、面板地址、密码、证书或用户数据。源码与文档中的地址均为占位符；若你不希望公开自己的站点，请从源码构建并替换成你自己的环境。

---

## 十一、免责声明

1. **本项目仅用于个人学习、UI/交互研究与技术交流**，不是红果短剧、抖音、字节跳动或任何内容平台的官方项目，也不代表其立场。
2. **本项目不提供、不托管、不分发任何影视内容、图片、字体、商标或账号资源。** 仓库中的接口路径、字段名、示例数据仅用于说明协议结构与界面渲染，不构成内容分发。
3. **使用者必须自行确保内容来源合法。** 请只接入你拥有版权、授权或合法访问权的内容源；不得将本项目用于盗版、付费内容绕过、会员破解、商业分发或其他违反《著作权法》《网络安全法》及所在地法律的行为。
4. **因使用本项目产生的任何直接或间接损失、法律责任、平台封禁、数据泄露，由使用者自行承担。** 作者不对内容的合法性、服务的可用性、数据的完整性作任何明示或暗示担保。
5. **请勿将本项目用于违反任何平台服务条款的行为**，包括但不限于批量抓取、绕过访问控制、去除水印/DRM、二次分发付费内容。
6. 本项目按 **「现状」（AS IS）** 提供，不保证适用于任何特定用途；发布前请自行进行安全审计、兼容性测试与合规审查。
7. 若权利人认为本项目中的任何内容侵犯其合法权益，请通过仓库 Issue 或 GitHub 私下联系，作者会在核实后尽快删除或调整相关内容。
8. 使用本项目即视为你已阅读、理解并同意以上条款。如果你不同意，请立即停止使用并删除相关文件。

---

## 十二、AI 声明

本项目在 **AI 编程助手（豆包 / Doubao）** 的辅助下完成，特此说明：

- **AI 参与范围**：代码生成与重构、React 组件与样式、Python 网关逻辑、Android / Electron 壳代码、构建脚本、文档初稿与排版。
- **作者负责**：需求定义、产品与视觉决策、接口联调、真机测试、版本发布、合规审查与最终取舍。
- **AI 的局限**：AI 可能产生错误、遗漏或不安全的实现；作者已进行人工审查与实测，但不对 AI 生成内容的准确性、完整性或适用性作额外担保。使用前请自行审计。
- **立场**：本项目及其文档不代表任何 AI 模型提供方的立场，也不构成其对内容合法性或使用方式的认可。
- **第三方代码**：`android/vendor/` 下的 Media3、AndroidX、Guava、Kotlin 等 jar 归各自版权方所有，遵循其原始许可证；前端依赖 React、Vite、hls.js 等同样遵循各自许可证。

---

## 十三、第三方组件与致谢

- [React](https://react.dev/) / [Vite](https://vite.dev/) / [TypeScript](https://www.typescriptlang.org/)
- [hls.js](https://github.com/video-dev/hls.js/)
- [AndroidX Media3 / ExoPlayer](https://github.com/androidx/media)
- [Electron](https://www.electronjs.org/) / [electron-builder](https://www.electron.build/) / [electron-updater](https://www.electron.build/auto-update)
- 界面参考：红果免费短剧（仅作为学习对象，无关联、无授权关系）

---

## 十四、版本

当前仓库版本（见 [`version.json`](version.json)）：

| 端 | 版本 |
|---|---|
| Web | 1.5.46 |
| Android | 1.5.46（versionCode 124） |
| Windows | 1.3.2 |

Release 中的安装包版本以对应 Release 说明为准。
