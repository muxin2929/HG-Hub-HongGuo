# 部署说明（通用版）

> 本文只使用占位符，不包含任何真实服务器 IP、SSH 端口、面板地址或证书路径。
> 部署前请先确认：你有权在该服务器上运行本项目，并且内容源的使用符合当地法律与平台条款。

目标环境：Debian 12 / Ubuntu 22.04+，Python 3.10+，能访问你配置的上游内容源。
服务器上不需要 Node：前端在本机构建成 `dist/` 再上传。

---

## 0. 先确认

```bash
ssh root@YOUR_SERVER_IP
python3 --version
curl -s -o /dev/null -w '%{http_code}\n' https://your-upstream.example/api/health
ss -lntp | grep -E ':(8080|8081)\b' || echo "8080/8081 空闲"
```

如果 8080 已被其他服务占用，换一个端口，后面所有 `PORT=` 一起改。

---

## 1. 上传与安装（推荐一键脚本）

在仓库根目录执行（Windows 用 Git Bash / WSL）：

```bash
SERVER=root@YOUR_SERVER_IP bash deploy/deploy.sh
# 换端口：
SERVER=root@YOUR_SERVER_IP PORT=18080 bash deploy/deploy.sh
```

脚本会：构建前端 → 上传 `gateway/` 与 `web/dist/` → 写 systemd 并重启 → 打印 `/healthz`。

默认安装目录是 `/opt/hg`，可用 `REMOTE_DIR` 覆盖：

```bash
SERVER=root@YOUR_SERVER_IP REMOTE_DIR=/srv/hg bash deploy/deploy.sh
```

---

## 2. 手动方式

本机：

```bash
cd web && npm ci && npm run build
cd ..
scp -r gateway root@YOUR_SERVER_IP:/opt/hg/gateway
scp -r web/dist root@YOUR_SERVER_IP:/opt/hg/web/dist
scp deploy/hg-gateway.service root@YOUR_SERVER_IP:/opt/hg/
```

服务器：

```bash
mkdir -p /opt/hg/cache
cp /opt/hg/hg-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hg-gateway
```

`gateway/` 只需要这些文件：`app.py hgcore.py aes.py catalog.py upfill.py account.py probe.py selftest.py`。
`.cache/`、`.test/`、`__pycache__/` 不用传。

---

## 3. 配置

systemd 文件里的环境变量按需修改：

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 监听地址与端口，默认 `0.0.0.0:8080` |
| `UPSTREAM` | 内容源根地址，必须换成你自己的合法来源 |
| `WEB_DIR` | 前端 `dist` 目录 |
| `CACHE_DIR` | 封面 / 分片磁盘缓存目录 |
| `ACCOUNT_DB` | 账号 SQLite 路径，默认 `../data/account.db` |
| `APP_APK` / `APP_WIN` | 可选的安装包下载路径 |
| `WEB_ZIP` | 可选的网页热更新包路径 |
| `DESKTOP_DIR` | 可选的桌面端更新目录 |

**不要把真实 IP、Cookie、Token 写进 systemd 文件后提交到仓库。**

---

## 4. 验证

```bash
curl -s http://127.0.0.1:8080/healthz
curl -s -X POST -H 'Content-Type: application/json' -d '{"id":12,"ep":1}' \
  http://127.0.0.1:8080/api/play | head -c 300
curl -s http://127.0.0.1:8080/ | head -c 120
```

浏览器打开 `http://YOUR_SERVER_IP:8080/`，页面不应出现「演示数据」角标（出现说明构建时带了 `VITE_MOCK`）。

---

## 5. 可选：域名 + HTTPS

参考 `deploy/nginx-site.conf.example`，把 `your-domain.example` 换成你的域名，证书路径按实际修改。
如果 80/443 已被其他服务占用，不要动它们：继续用 `IP:端口`，或在 Cloudflare 上给子域做 Tunnel 指到 `127.0.0.1:8080`。

---

## 6. 常用运维

```bash
systemctl status hg-gateway
journalctl -u hg-gateway -f
systemctl restart hg-gateway
du -sh /opt/hg/cache
```

清理旧缓存（按需，别误删账号库）：

```bash
find /opt/hg/cache -type f -mtime +1 -delete
```

---

## 7. 安全清单

- 只开放实际需要的端口；SSH 建议改端口 + 密钥登录 + 禁用密码。
- 网关不要以 root 运行；用独立用户，目录权限最小化。
- 不要在公开仓库、Issue、截图中出现服务器 IP、面板地址、Cookie、数据库。
- 定期备份 `data/account.db`，但不要把它提交到 Git。
- 如果使用第三方内容源，请自行确认授权范围；本项目不提供任何内容源或授权。
