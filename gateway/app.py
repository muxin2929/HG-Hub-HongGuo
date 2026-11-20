#!/usr/bin/env python3
"""HG 重构版网关（零第三方依赖，Python 3.10+）。

一个进程替代原来的 8080 播放代理 + 8081 网页服务，并修掉它们的三处结构性问题：

  旧 /proxy/m3u8?url= 原样转发清单 → 清单里相对 `.ts` 被 hls.js 解析成
  /proxy/xxx.ts → 404，前端只能"直连 CDN 优先、代理兜底"。
  新 /media/manifest 在服务端把每个 URI 改写成 /media/{seg,key}?u=<绝对地址>，
  客户端永远只跟本网关对话（见 hgcore.rewrite_m3u8）。

路由
----
  GET  /healthz                     健康检查 + 缓存统计
  POST /api/play                    {id,ep} → 上游 playback（请求体固定发 {}）
  GET  /api/<path>?<query>          同源透传 https://<UPSTREAM>/api/<path>
  POST /api/<path>                  同上（评论等）
  GET  /img?u=<url>                 拉封面 → AES 解密 → 图片（白名单 + 磁盘缓存）
  GET  /media/manifest?u=<url>      拉 m3u8 → 改写 URI → 返回
  GET  /media/seg?u=<url>           转发分片（可选磁盘缓存）
  GET  /media/key?u=<url>           转发 AES 密钥
  GET  /                            前端静态文件（WEB_DIR，SPA 回退 index.html）

环境变量
--------
  HOST=0.0.0.0  PORT=8080  UPSTREAM=https://your-upstream.example
  WEB_DIR=../web/dist  CACHE_DIR=./.cache
  SEG_CACHE=1（分片落盘） IMG_CACHE=1  MANIFEST_CACHE=1
  API_TTL=20（/api/* 内存缓存秒数，0 关闭）
"""

from __future__ import annotations

import json
import queue
import mimetypes
import os
import posixpath
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hgcore as core  # noqa: E402
import account as acct  # noqa: E402
import catalog as cat  # noqa: E402
import upfill  # noqa: E402

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
WEB_DIR = os.path.abspath(os.environ.get(
    "WEB_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "dist")))
CACHE_DIR = os.path.abspath(os.environ.get("CACHE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")))
IMG_CACHE_ON = os.environ.get("IMG_CACHE", "1") == "1"
SEG_CACHE_ON = os.environ.get("SEG_CACHE", "1") == "1"
MANIFEST_CACHE_ON = os.environ.get("MANIFEST_CACHE", "1") == "1"
API_TTL = float(os.environ.get("API_TTL", "20"))
# 分片缓存的自我约束：超过 3GB 就按最旧的删，文件活 30 分钟
CACHE_MAX_MB = float(os.environ.get("CACHE_MAX_MB", "20000"))
SEG_TTL = float(os.environ.get("SEG_TTL", "21600"))
IMG_TTL = float(os.environ.get("IMG_TTL", str(30 * 86400)))
_FEED_STAMP: dict = {}
_FEED_STAMP_AT = 0.0
# Android 安装包路径（/app.apk 直接下载）
APP_APK = os.environ.get("APP_APK", os.path.join(os.path.dirname(CACHE_DIR), "app.apk"))
APP_WIN = os.environ.get("APP_WIN", os.path.join(os.path.dirname(CACHE_DIR), "app-win.exe"))
# 前端热更新包（App 内下载解压，重启/刷新即生效）
WEB_VERSION = os.environ.get("WEB_VERSION", "1.5.46")
WEB_ZIP = os.environ.get("WEB_ZIP", os.path.join(os.path.dirname(CACHE_DIR), "www.zip"))
# 桌面端自动更新目录（latest.yml + 安装包）
DESKTOP_DIR = os.environ.get("DESKTOP_DIR", os.path.join(os.path.dirname(CACHE_DIR), "desktop"))
# App 当前版本（客户端启动时来问一次，用来提示更新）
APP_VERSION = os.environ.get("APP_VERSION", "1.5.46")

IMG_DIR = os.path.join(CACHE_DIR, "img")
SEG_DIR = os.path.join(CACHE_DIR, "seg")

_log_lock = threading.Lock()


def log(*args) -> None:
    with _log_lock:
        print(time.strftime("%H:%M:%S"), *args, flush=True)


class TTLMap:
    """极简 TTL 内存缓存（清单 / API 列表）。"""

    def __init__(self, limit: int = 512):
        self.limit = limit
        self.data: dict[str, tuple[float, bytes, str]] = {}
        self.lock = threading.Lock()

    def get(self, key: str) -> tuple[bytes, str] | None:
        with self.lock:
            hit = self.data.get(key)
            if not hit:
                return None
            exp, body, ctype = hit
            if exp < time.time():
                self.data.pop(key, None)
                return None
            return body, ctype

    def put(self, key: str, body: bytes, ctype: str, ttl: float) -> None:
        if ttl <= 0:
            return
        with self.lock:
            if len(self.data) >= self.limit:
                self.data.pop(next(iter(self.data)), None)
            self.data[key] = (time.time() + ttl, body, ctype)


API_CACHE = TTLMap(1024)
MANIFEST_CACHE = TTLMap(256)
CATS_CACHE: dict = {}  # 分类列表长缓存（上游偶发失败时回上一份）

# 公告：手写在 data/notices.json 里；每次有新版本发布，自动补一条 release 公告（只补一次，落盘）
NOTICE_FILE = os.environ.get("NOTICE_FILE", os.path.join(os.path.dirname(CACHE_DIR), "data", "notices.json"))
_notice_lock = threading.Lock()


def _notices_data() -> dict:
    with _notice_lock:
        items: list = []
        try:
            with open(NOTICE_FILE, encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                items = raw.get("items") or []
            elif isinstance(raw, list):
                items = raw
            items = [x for x in items if isinstance(x, dict) and x.get("id")]
            # 按发布时间倒序：以前是「谁最后插进去谁在前面」，APK/网页两条版本线混着写，
            # 公告栏里就会出现 1.5.41 → 1.5.34 → 1.5.42 这种跳来跳去的顺序。
            items.sort(key=lambda x: str(x.get("at") or ""), reverse=True)
        except Exception:
            items = []

        if not any(str(x.get("version") or "") == APP_VERSION for x in items):
            items.insert(0, {
                "id": "v" + APP_VERSION,
                "kind": "release",
                "version": APP_VERSION,
                "title": "v%s 版本发布" % APP_VERSION,
                "body": "客户端已更新到 v%s：播放与体验问题修复。" % APP_VERSION,
                "at": time.strftime("%Y-%m-%d %H:%M"),
            })
            try:
                os.makedirs(os.path.dirname(NOTICE_FILE), exist_ok=True)
                tmp = NOTICE_FILE + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"items": items}, f, ensure_ascii=False, indent=1)
                os.replace(tmp, NOTICE_FILE)
            except Exception as e:
                log("notices save failed: %r" % (e,))

        items = items[:40]
        return {"items": items, "latest": items[0].get("id") if items else ""}



# ---------------------------------------------------------------- 封面预热
# 列表/详情返回后，后台把封面提前抓进磁盘缓存，浏览器来取时直接 HIT。
_warm_queue: "queue.Queue[str]" = queue.Queue(maxsize=200)
_warm_seen: set[str] = set()
_warm_lock = threading.Lock()


def _warm_worker() -> None:
    while True:
        url = _warm_queue.get()
        try:
            key = core.sha256(url)
            path = os.path.join(IMG_DIR, key[:2], key)
            if core.disk_get(path):
                continue
            status, body, _ctype, _ = core.fetch(url, timeout=12)
            if status != 200:
                continue
            img, _mime = core.decode_cover(body)
            if img:
                core.disk_put(path, img)
        except Exception:
            pass
        finally:
            _warm_queue.task_done()


def warm_covers(urls: list[str]) -> None:
    """把封面 URL 丢进后台队列预热（去重、限量）。"""
    if not IMG_CACHE_ON:
        return
    with _warm_lock:
        pending = []
        for u in urls[:24]:
            if not isinstance(u, str) or not u.startswith("http"):
                continue
            if u in _warm_seen:
                continue
            _warm_seen.add(u)
            pending.append(u)
        if len(_warm_seen) > 4000:
            _warm_seen.clear()
    for u in pending:
        try:
            _warm_queue.put_nowait(u)
        except queue.Full:
            break


def _covers_of(payload) -> list[str]:
    """从上游 JSON 里挖出封面地址（列表和详情两种结构都认）。"""
    out: list[str] = []

    def walk(node, depth=0):
        if depth > 6 or len(out) >= 24:
            return
        if isinstance(node, dict):
            c = node.get("cover")
            if isinstance(c, str) and c.startswith("http"):
                out.append(c)
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, list):
            for v in node:
                walk(v, depth + 1)

    walk(payload)
    return out


threading.Thread(target=_warm_worker, name="img-warm", daemon=True).start()


def _catalog_worker() -> None:
    """剧库每天自动更新：跨天就重建一份；失败保留上一份，半小时后再试。"""
    time.sleep(8)
    fail_at = 0.0
    while True:
        try:
            if cat.needs_refresh() and (time.time() - fail_at) > 1800:
                t0 = time.time()
                snap = cat.refresh()
                log("catalog refreshed: total=%s in %.0fs" % (snap.get("total"), time.time() - t0))
                fail_at = 0.0
        except Exception as e:  # 抓取失败绝不影响对外服务
            fail_at = time.time()
            log("catalog refresh failed: %r" % (e,))
        time.sleep(3600)


threading.Thread(target=_catalog_worker, name="catalog-daily", daemon=True).start()


_UP_RANK = {"at": 0.0, "ids": []}


def _up_rank_ids() -> list[str]:
    """上游真榜单 /api/ranks/hot（固定 20 条、带 rank、不分页也不分频道）。

    10 分钟缓存；上游抽风就沿用上一次拿到的，绝不阻塞接口。
    """
    now = time.time()
    if _UP_RANK["ids"] and now - _UP_RANK["at"] < 600:
        return _UP_RANK["ids"]
    ids: list[str] = []
    try:
        d = core.get_json(core.UPSTREAM + "/api/ranks/hot")
        for it in ((d.get("data") or {}).get("items") or []):
            if not isinstance(it, dict):
                continue
            vid = it.get("video_id")
            if vid is None:
                vid = it.get("id")
            if vid not in (None, ""):
                ids.append(str(vid))
    except Exception as e:
        log("upstream rank failed: %r" % (e,))
        return _UP_RANK["ids"]
    if ids:
        _UP_RANK.update({"at": now, "ids": ids})
    return ids


def _fill_list_covers(path: str, body: bytes, limit: int = 2) -> bytes:
    """列表里有条目封面为空时，向详情接口补一次再返回。

    上游「列表」接口对新上架剧的封面回填有延迟（详情接口一开始就有），
    不补的话前端会把最新的一两部剧显示成一排灰块。只补前几条、补不到就算了，
    绝不为了一个空封面拖慢整页。
    """
    if path != "/api/videos":
        return body
    try:
        d = json.loads(body.decode("utf-8", "ignore"))
        items = ((d.get("data") or {}).get("items") or [])
        if not items:
            return body
        n = upfill.fill(items, persist=cat.patch, limit=limit)
    except Exception:
        return body
    if not n:
        return body
    return json.dumps(d, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hg-gateway/2.0"
    # ---------------------------------------------------------------- 基础工具

    def log_message(self, fmt, *args):  # noqa: A003
        log(self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, ctype: str = "application/json",
              extra: dict[str, str] | None = None) -> None:
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        # 必须放行 Authorization：安卓壳的 WebView 从 http://localhost 发请求，
        # 属于跨域，不带这个头预检直接失败 → 登录态/收藏/点赞全被浏览器拦掉
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, authorization, x-cdn-auth")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        if getattr(self, "command", "GET") == "POST":
            self.send_header("Connection", "close")
            self.close_connection = True
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj, ensure_ascii=False), "application/json")

    def _err(self, status: int, msg: str) -> None:
        self._json(status, {"status": 0, "error": msg, "msg": msg})

    @staticmethod
    def _q(query: str, key: str) -> str:
        return (urllib.parse.parse_qs(query).get(key) or [""])[0]

    # -------------------------------------------------------------------- 路由

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, parsed.query

        if path == "/healthz":
            return self._health()
        if path == "/api/app/version":
            return self._json(200, {"status": 1, "data": {
                "version": APP_VERSION, "apk": "/app.apk", "win": "/app-win.exe",
                "web": WEB_VERSION, "web_zip": "/app/www.zip"}})
        if path == "/api/notices":
            return self._json(200, {"status": 1, "data": _notices_data()})
        if path == "/api/site/categories/video":
            return self._categories()
        if path == "/api/videos" and (self._q(query, "cate_id") or "") in ("26", "27"):
            return self._videos_kw(query)
        if path == "/api/feed/version":
            return self._feed_version()
        if path == "/api/feed/random":
            return self._feed_random(query)
        if path == "/api/catalog/meta":
            return self._json(200, {"status": 1, "data": cat.meta()})
        if path == "/api/ranks/daily":
            return self._ranks_daily(query)
        if path == "/api/app/web-version":
            return self._json(200, {"status": 1, "data": {"version": WEB_VERSION,
                                                           "zip": "/app/www.zip"}})
        if path == "/app/www.zip":
            return self._apk(WEB_ZIP, "application/zip", "www.zip")
        if path.startswith("/desktop/"):
            return self._desktop(path[len("/desktop/"):])
        if path == "/app-win.exe":
            return self._apk(APP_WIN, "application/octet-stream", "hghub-setup.exe")
        if path == "/app.apk":
            return self._apk(APP_APK, "application/vnd.android.package-archive", "hghub.apk")
        if path == "/img":
            return self._img(self._q(query, "u"), self._q(query, "w"))
        if path in ("/media/manifest", "/media/manifest.m3u8"):
            return self._manifest(self._q(query, "u"))
        if path in ("/media/seg", "/media/key", "/media/ts"):
            return self._asset(self._q(query, "u"))
        if path.startswith("/api/auth/"):
            return self._account(path, query, "POST" if self.command == "POST" else "GET")
        if path.startswith("/api/me/"):
            return self._account(path, query, "POST" if self.command == "POST" else "GET")
        if path == "/api/play":
            return self._err(405, "use POST")
        if path.startswith("/api/"):
            return self._api_get(path, query)
        return self._static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        if path == "/api/play":
            return self._play(body)
        if path == "/api/log":
            return self._applog(body)
        if path.startswith("/api/auth/") or path.startswith("/api/me/"):
            return self._account(path, parsed.query, "POST", body)
        if path.startswith("/api/"):
            return self._api_post(path, body)
        return self._err(404, "not found")

    # ------------------------------------------------------------- 账号/我的

    def _applog(self, body: bytes) -> None:
        """App 端上报（排障用）：一行一条 JSON，落到 logs/app.log，超过 1MB 轮转。"""
        try:
            line = (body or b"")[:2000].decode("utf-8", "ignore").strip()
            if not line:
                return self._json(200, {"status": 1})
            logdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
            os.makedirs(logdir, exist_ok=True)
            p = os.path.join(logdir, "app.log")
            try:
                if os.path.getsize(p) > 1024 * 1024:
                    os.replace(p, p + ".1")
            except OSError:
                pass
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            with open(p, "a", encoding="utf-8") as f:
                f.write(stamp + " " + self.client_address[0] + " " + line + "\n")
        except Exception:
            pass
        return self._json(200, {"status": 1})

    def _account(self, path: str, query: str, method: str, body: bytes = b"") -> None:
        """自建账号体系：/api/auth/* 与 /api/me/*（不会转发给上游）。"""
        q = urllib.parse.parse_qs(query)
        try:
            payload = json.loads(body or b"{}") if method == "POST" else {}
        except Exception:
            return self._json(400, {"status": 0, "msg": "invalid json"})

        token = ""
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        ip = self.client_address[0]

        def need_user():
            row = acct.user_by_token(token)
            if not row:
                raise acct.AccountError(401, "未登录")
            return row

        try:
            # ---- 注册 / 登录 / 登出
            if path == "/api/auth/register" and method == "POST":
                acct.login_guard(ip)
                data = acct.register(payload.get("username", ""), payload.get("password", ""),
                                     payload.get("nickname", ""))
                return self._json(200, {"status": 1, "data": data})
            if path == "/api/auth/login" and method == "POST":
                acct.login_guard(ip)
                try:
                    data = acct.login(payload.get("username", ""), payload.get("password", ""))
                except acct.AccountError:
                    acct.login_fail(ip)
                    raise
                acct.login_ok(ip)
                return self._json(200, {"status": 1, "data": data})
            if path == "/api/auth/logout" and method == "POST":
                acct.logout(token)
                return self._json(200, {"status": 1, "data": {"ok": True}})
            if path == "/api/auth/me":
                row = need_user()
                return self._json(200, {"status": 1, "data": acct._public(row)})
            if path == "/api/auth/profile" and method == "POST":
                row = need_user()
                data = acct.update_profile(row["id"], payload.get("nickname"), payload.get("avatar"))
                return self._json(200, {"status": 1, "data": data})

            # ---- 历史 / 续播
            if path == "/api/me/history" and method == "GET":
                row = need_user()
                return self._json(200, {"status": 1, "data": {"items": acct.history_list(row["id"])}})
            if path == "/api/me/history" and method == "POST":
                row = need_user()
                if not payload.get("video_id"):
                    raise acct.AccountError(400, "缺少 video_id")
                acct.history_upsert(row["id"], payload)
                return self._json(200, {"status": 1, "data": {"ok": True}})
            if path == "/api/me/history/delete" and method == "POST":
                row = need_user()
                acct.history_delete(row["id"], payload.get("video_id"))
                return self._json(200, {"status": 1, "data": {"ok": True}})

            # ---- 点赞 / 收藏
            if path == "/api/me/actions" and method == "GET":
                row = need_user()
                kind = (q.get("type") or [None])[0]
                return self._json(200, {"status": 1, "data": {"items": acct.action_list(row["id"], kind)}})
            if path == "/api/me/actions" and method == "POST":
                row = need_user()
                data = acct.action_toggle(row["id"], int(payload.get("video_id") or 0),
                                          payload.get("type", ""), payload.get("title", ""),
                                          payload.get("cover", ""))
                return self._json(200, {"status": 1, "data": data})
            if path == "/api/me/action" and method == "GET":
                row = need_user()
                vid = int((q.get("video_id") or ["0"])[0])
                return self._json(200, {"status": 1, "data": acct.action_state(row["id"], vid)})

            # ---- 本地评论
            if path == "/api/me/comments" and method == "GET":
                vid = int((q.get("video_id") or ["0"])[0])
                return self._json(200, {"status": 1, "data": {"items": acct.comment_list(vid)}})
            if path == "/api/me/comment" and method == "POST":
                row = need_user()
                data = acct.comment_add(row["id"], int(payload.get("video_id") or 0),
                                        payload.get("content", ""),
                                        row["nickname"] or row["username"])
                return self._json(200, {"status": 1, "data": data})

            return self._err(404, "not found")
        except acct.AccountError as e:
            return self._json(e.status, {"status": 0, "msg": e.msg})

    # ------------------------------------------------------------------ /api/*

    def _categories(self) -> None:
        """分类列表：只在成功时刷新，缓存 1 小时；上游抽风就回上一份。

        分类是最稳定的东西（就 4 个），没必要每次都打上游，
        更不能因为上游偶发超时让前端拿到空数组 —— 那会让剧场「筛选」里空空如也。
        """
        hit = CATS_CACHE.get("cats")
        if hit and time.time() - hit[2] < 3600:
            return self._send(200, hit[0], hit[1],
                              {"X-Cache": "HIT", "Cache-Control": "public, max-age=600"})
        try:
            status, body, ctype, _ = core.fetch(core.UPSTREAM + "/api/site/categories/video")
            if status == 200 and b'"items"' in body:
                CATS_CACHE["cats"] = (body, ctype, time.time())
                return self._send(200, body, ctype, {"X-Cache": "MISS",
                                                     "Cache-Control": "public, max-age=600"})
        except Exception:
            pass
        if hit:
            return self._send(200, hit[0], hit[1], {"X-Cache": "STALE"})
        return self._err(502, "categories unavailable")

    def _videos_kw(self, query: str) -> None:
        """AI换脸(26) / AI魔改(27)：上游分类页已下线、接口返回 0 条。

        请求先照常打上游；上游真没数据时，用本地剧库里按「上游搜索」筛出来的
        那几条真实条目兜底 —— 有就展示，没有就还是空态，不拿别的剧凑数。
        """
        cid = self._q(query, "cate_id") or ""
        path = "/api/videos"
        target = core.UPSTREAM + path + (("?" + query) if query else "")
        try:
            status, body, ctype, _ = core.fetch(target)
            if status == 200:
                try:
                    got = json.loads(body.decode("utf-8", "ignore"))
                    if ((got.get("data") or {}).get("items") or []):
                        return self._send(200, body, ctype, {"X-Cache": "MISS"})
                except Exception:
                    return self._send(200, body, ctype, {"X-Cache": "MISS"})
        except Exception:
            pass
        try:
            page = int(self._q(query, "page") or 1)
        except Exception:
            page = 1
        res = cat.pool_page(cid, page=page, size=20, sort=self._q(query, "sort") or "")
        if not res["items"]:
            return self._json(200, {"status": 1, "data": res})
        upfill.fill(res["items"], persist=cat.patch, wait=False)
        return self._json(200, {"status": 1, "data": res, "source": "catalog"})

    def _api_get(self, path: str, query: str) -> None:
        key = path + ("?" + query if query else "")
        if API_TTL > 0:
            hit = API_CACHE.get(key)
            if hit:
                return self._send(200, hit[0], hit[1],
                                  {"X-Cache": "HIT", "Cache-Control": "public, max-age=20"})
        target = core.UPSTREAM + path + (("?" + query) if query else "")
        try:
            status, body, ctype, _ = core.fetch(target)
        except core.UpstreamError as e:
            return self._err(502, str(e))
        if status == 200:
            body = _fill_list_covers(path, body)
            API_CACHE.put(key, body, ctype, API_TTL)
            # 列表/详情返回后，后台把封面预热进磁盘缓存（异步，失败无影响）
            try:
                warm_covers(_covers_of(json.loads(body.decode("utf-8", "ignore"))))
            except Exception:
                pass
        self._send(status, body, ctype, {"X-Cache": "MISS"})

    def _api_post(self, path: str, body: bytes) -> None:
        target = core.UPSTREAM + path
        try:
            status, rbody, ctype, _ = core.fetch(
                target, data=body or b"{}", headers={"Content-Type": "application/json"})
        except core.UpstreamError as e:
            return self._err(502, str(e))
        self._send(status, rbody, ctype)

    def _play(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
            video_id = int(payload.get("id") or payload.get("video_id"))
            ep = int(payload.get("ep") or payload.get("episode") or 1)
        except Exception as e:
            return self._err(400, f"invalid body: {e}")
        try:
            data = core.resolve_play(video_id, ep)
        except core.UpstreamError as e:
            return self._err(e.status or 502, str(e))
        streams = core.streams_of(data)
        if not streams:
            return self._err(502, "upstream returned no streams")
        # 原样返回上游结构（前端两种形状都兼容），额外给出改写后的清单地址
        # 空串（这一集没有该清晰度）不要生成清单地址，否则前端会去请求 ?u= 拿到 400
        manifest = {
            k: "/media/manifest?u=" + urllib.parse.quote(v, safe="")
            for k, v in streams.items()
            if isinstance(v, str) and v.strip()
        }
        if isinstance(data.get("data"), dict):
            data["data"]["manifest"] = manifest
        else:
            data["manifest"] = manifest
        self._json(200, data)

    # ---------------------------------------------------------------- /media/*

    def _manifest(self, url: str) -> None:
        if not url.startswith(("http://", "https://")):
            return self._err(400, "url must be http(s)")
        if not core.host_allowed(url, core.MEDIA_HOSTS, core.MEDIA_SUFFIXES):
            return self._err(403, "host not allowed: " + (urllib.parse.urlsplit(url).hostname or ""))

        cache_key = core.sha256(url)
        if MANIFEST_CACHE_ON:
            hit = MANIFEST_CACHE.get(cache_key)
            if hit:
                return self._send(200, hit[0], hit[1],
                                  {"X-Cache": "HIT", "Cache-Control": "public, max-age=20"})

        try:
            status, body, ctype, _ = core.fetch(url)
        except core.UpstreamError as e:
            return self._err(502, str(e))
        if status in (401, 403):
            # auth_key 签名过期：让前端重新 POST /api/play 拿新地址
            return self._json(409, {"status": 0, "error": "auth_expired",
                                    "msg": "播放签名已过期，请重新解析播放地址"})
        if status != 200:
            return self._err(status, f"manifest HTTP {status}")

        text = body.decode("utf-8", "ignore")
        if "#EXTM3U" not in text:
            return self._err(502, "not a m3u8 playlist")
        out = core.rewrite_m3u8(text, url).encode()
        MANIFEST_CACHE.put(cache_key, out, "application/vnd.apple.mpegurl", 30)
        self._send(200, out, "application/vnd.apple.mpegurl",
                   {"Cache-Control": "no-store"})

    def _asset(self, url: str) -> None:
        if not url.startswith(("http://", "https://")):
            return self._err(400, "url must be http(s)")
        if not core.host_allowed(url, core.MEDIA_HOSTS, core.MEDIA_SUFFIXES):
            return self._err(403, "host not allowed")

        key = core.cache_key(url)
        path = os.path.join(SEG_DIR, key[:2], key)
        if SEG_CACHE_ON:
            cached = core.disk_get(path, max_age=900)
            if cached:
                return self._send(200, cached, self._asset_ctype(url),
                                  {"X-Cache": "HIT",
                                   "Cache-Control": "public, max-age=1800, immutable"})

        headers = {}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        try:
            status, body, ctype, _ = core.fetch(url, headers=headers, timeout=30)
        except core.UpstreamError as e:
            return self._err(502, str(e))
        if status in (401, 403):
            return self._json(409, {"status": 0, "error": "auth_expired",
                                    "msg": "分片签名已过期，请重新解析播放地址"})
        if status not in (200, 206):
            return self._err(status, f"asset HTTP {status}")
        ctype = self._asset_ctype(url) or ctype
        if SEG_CACHE_ON and status == 200:
            core.disk_put(path, body)
        self._send(status, body, ctype,
                   {"Cache-Control": "public, max-age=1800, immutable"})

    @staticmethod
    def _asset_ctype(url: str) -> str:
        p = urllib.parse.urlsplit(url).path.lower()
        if p.endswith(".ts"):
            return "video/mp2t"
        if p.endswith(".m4s") or p.endswith(".mp4"):
            return "video/mp4"
        if p.endswith(".m3u8"):
            return "application/vnd.apple.mpegurl"
        if p.endswith(".key"):
            return "application/octet-stream"
        return "application/octet-stream"

    # -------------------------------------------------------------------- /img

    def _feed_version(self) -> None:
        """内容版本戳：上游最新一页的「第一条 id + 总数」，变了就说明有更新。"""
        global _FEED_STAMP, _FEED_STAMP_AT
        now = time.time()
        if _FEED_STAMP and now - _FEED_STAMP_AT < 60:
            return self._json(200, {"status": 1, "data": _FEED_STAMP})
        try:
            status, body, _ctype, _ = core.fetch(core.UPSTREAM + "/api/videos?page=1&sort=new")
            if status != 200:
                raise core.UpstreamError(status, "feed version")
            data = json.loads(body.decode("utf-8", "ignore"))
            d = data.get("data") or data
            items = d.get("items") or []
            first = items[0] if items else {}
            total = (d.get("pagination") or {}).get("total") or len(items)
            stamp = {
                "stamp": "%s-%s" % (first.get("id", 0), total),
                "latest_id": first.get("id", 0),
                "latest_title": first.get("title", ""),
                "total": total,
                "ts": int(now),
            }
            _FEED_STAMP = stamp
            _FEED_STAMP_AT = now
            return self._json(200, {"status": 1, "data": stamp})
        except Exception as e:  # 上游抖动时不要影响页面
            if _FEED_STAMP:
                return self._json(200, {"status": 1, "data": _FEED_STAMP, "stale": 1})
            return self._json(200, {"status": 0, "msg": str(e)})

    # ------------------------------------------------------------ 剧库 / 发牌

    def _feed_random(self, query: str) -> None:
        """首页发牌：从每日快照里按热度加权随机，最近看过的先避开。

        ?n=12&chan=24|25&exclude=1,2,3&seed=123
        """
        q = urllib.parse.parse_qs(query)
        n = 12
        try:
            n = max(1, min(40, int((q.get("n") or ["12"])[0])))
        except Exception:
            pass
        chan = ((q.get("chan") or [""])[0] or "").strip()
        raw = (q.get("exclude") or [""])[0]
        ex = {x.strip() for x in raw.split(",") if x.strip()}
        try:
            seed = int((q.get("seed") or ["0"])[0]) or None
        except Exception:
            seed = None
        items = cat.random_items(chan, n, ex, seed)
        if not items:
            # 快照还没抓好：让前端走老的翻页兜底
            return self._json(200, {"status": 0, "msg": "catalog not ready", "data": {"items": []}})
        # 刚上架的剧可能封面还没被上游回填：后台补，不拖慢首屏
        upfill.fill(items, persist=cat.patch, wait=False)
        return self._json(200, {"status": 1, "data": {
            "items": items, "date": cat.meta().get("date"), "n": len(items)}})

    def _ranks_daily(self, query: str) -> None:
        """每日榜单：从同一份快照排，返回真实快照日期。

        ?chan=24|25&type=recommend|hot|new&limit=60
        """
        q = urllib.parse.parse_qs(query)
        chan = ((q.get("chan") or [""])[0] or "").strip()
        type_ = ((q.get("type") or ["recommend"])[0] or "recommend").strip()
        if type_ not in cat.RANK_TYPES:
            type_ = "recommend"
        try:
            limit = max(10, min(100, int((q.get("limit") or ["60"])[0])))
        except Exception:
            limit = 60
        items = cat.ranks(chan, type_, limit)
        source = "catalog"
        # 热播榜用上游真榜单打头：只取「当前频道池里真实存在」的那几条，
        # 不足的用同频道库内条目补满 —— 三个 tab 仍是三份不同榜单，不串。
        if type_ == "hot" and items:
            up = _up_rank_ids()
            if up:
                snap = cat.current()
                bag = snap.get("items") or {}
                pool = set((snap.get("pools") or {}).get(chan) or []) if chan else set()
                lead, seen = [], set()
                for vid in up:
                    if pool and vid not in pool:
                        continue
                    v = bag.get(vid)
                    if v and vid not in seen:
                        lead.append(v)
                        seen.add(vid)
                if len(lead) >= 3:
                    items = (lead + [v for v in items if str(v.get("id")) not in seen])[:limit]
                    source = "upstream"
        m = cat.meta()
        if not items:
            return self._json(200, {"status": 0, "msg": "catalog not ready",
                                    "data": {"items": [], "date": m.get("date") or ""}})
        upfill.fill(items, persist=cat.patch, wait=False)
        return self._json(200, {"status": 1, "data": {
            "chan": chan, "type": type_, "date": m.get("date"), "source": source,
            "updated_at": m.get("updated_at"), "total": m.get("pools") and m.get("total"),
            "items": items}})

    def _img(self, url: str, w: str = "") -> None:
        if not url.startswith(("http://", "https://")):
            return self._err(400, "url must be http(s)")
        if not core.host_allowed(url, core.IMG_HOSTS, core.IMG_SUFFIXES):
            return self._err(403, "image host not allowed")

        # 前端只渲染几百像素宽的卡片，原图常常 2~3MB/张，一屏就几十 MB，
        # 手机上是「转圈白块 + 越滑越卡」的主因 → 统一缩到 720 宽再发。
        try:
            want = int(w) if w else 720
        except ValueError:
            want = 720
        if want < 120 or want > 1600:
            want = 720

        base = core.cache_key(url)          # 忽略 query，签名过期不影响命中
        key = core.sha256(f"{base}#{want}")
        path = os.path.join(IMG_DIR, key[:2], key)
        if IMG_CACHE_ON:
            cached = core.disk_get(path)
            if cached:
                return self._send(200, cached, core.sniff(cached) or "image/jpeg",
                                  {"Cache-Control": "public, max-age=604800, immutable",
                                   "X-Cache": "HIT"})

        status, body, _, _ = 0, b"", None, None
        try:
            status, body, _, _ = core.fetch(url, timeout=25)
        except core.UpstreamError as e:
            return self._err(502, str(e))
        if status in (401, 403) and "?" in url:
            # 上游图床的 auth_key 有有效期。用户历史/收藏里存的是当时的地址，
            # 签名一过期就 403 —— 剥掉 query 用裸地址再取一次（实测这个图床裸地址可取）。
            try:
                s2, b2, _, _ = core.fetch(url.split("?", 1)[0], timeout=25)
                if s2 == 200:
                    status, body = s2, b2
            except core.UpstreamError:
                pass
        if status != 200:
            return self._err(status or 502, f"upstream HTTP {status}")

        img, mime = core.decode_cover(body)
        if not img:
            # 解不出图：返回 1x1 透明 PNG，避免前端 20 个破图图标
            return self._send(200, _TINY_PNG, "image/png", {"X-Cache": "BROKEN"})

        img, mime = _shrink(img, mime, want)
        if IMG_CACHE_ON:
            core.disk_put(path, img)
        self._send(200, img, mime,
                   {"Cache-Control": "public, max-age=604800, immutable",
                    "X-Cache": "MISS"})

    # ----------------------------------------------------------------- 静态页

    def _static(self, path: str) -> None:
        if not os.path.isdir(WEB_DIR):
            return self._json(200, {
                "status": 1,
                "msg": "网关已启动，但前端 dist 不存在",
                "hint": f"cd web && npm run build（期望目录 {WEB_DIR}）",
                "routes": ["/healthz", "/api/*", "/img", "/media/manifest", "/media/seg"],
            })
        rel = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        target = os.path.join(WEB_DIR, rel) if rel and rel != "." else WEB_DIR
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            target = os.path.join(WEB_DIR, "index.html")  # SPA 回退
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        cache = "no-cache" if target.endswith("index.html") else "public, max-age=604800"
        self._send(200, body, ctype, {"Cache-Control": cache})

    # ------------------------------------------------------------------ 健康检查

    def _apk(self, path: str, ctype: str, filename: str):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._err(404, "安装包还没上传")
        self._send(200, body, ctype,
                   {"Content-Disposition": 'attachment; filename="%s"' % filename,
                    "Cache-Control": "no-cache"})

    def _desktop(self, name: str):
        """桌面端自动更新文件（latest.yml / 安装包 / blockmap）"""
        safe = os.path.basename(name)
        target = os.path.join(DESKTOP_DIR, safe)
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            return self._err(404, "没有这个文件")
        if safe.endswith(".yml"):
            ctype = "text/yaml; charset=utf-8"
        elif safe.endswith(".exe"):
            ctype = "application/octet-stream"
        else:
            ctype = "application/octet-stream"
        self._send(200, body, ctype, {"Cache-Control": "no-cache"})

    def _health(self):
        self._json(200, {
            "status": "ok",
            "upstream": core.UPSTREAM,
            "web_dir": WEB_DIR,
            "web_exists": os.path.isdir(WEB_DIR),
            "cache_dir": CACHE_DIR,
            "seg_cache": SEG_CACHE_ON,
            "account_cookie": bool(core.UPSTREAM_COOKIE),
        })


def _shrink(img: bytes, mime: str | None, want: int) -> tuple[bytes, str]:
    """封面缩到 want 宽（有 Pillow 才缩；失败就原样返回，绝不阻断出图）。"""
    try:
        from PIL import Image  # noqa: PLC0415  (可选依赖)
        import io
        im = Image.open(io.BytesIO(img))
        if im.width <= want:
            return img, mime or "image/jpeg"
        h = max(1, round(im.height * want / im.width))
        im = im.convert("RGB").resize((want, h), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82, optimize=True, progressive=True)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        return img, mime or "image/jpeg"


_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


def _janitor() -> None:
    """后台清缓存：先删过期分片，再按体积从最旧的删，防止磁盘被吃满。"""
    while True:
        time.sleep(300)
        try:
            now = time.time()
            files: list[tuple[float, int, str]] = []
            # 图片缓存单独算过期（30 天），但和分片共享总预算
            for root, _dirs, names in os.walk(IMG_DIR):
                for n in names:
                    q = os.path.join(root, n)
                    try:
                        st = os.stat(q)
                    except OSError:
                        continue
                    if now - st.st_mtime > IMG_TTL:
                        try:
                            os.remove(q)
                        except OSError:
                            pass
                        continue
                    files.append((st.st_mtime, st.st_size, q))
            for root, _dirs, names in os.walk(SEG_DIR):
                for n in names:
                    p = os.path.join(root, n)
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    if now - st.st_mtime > SEG_TTL:
                        try:
                            os.remove(p)
                        except OSError:
                            pass
                        continue
                    files.append((st.st_mtime, st.st_size, p))
            total = sum(f[1] for f in files)
            limit = CACHE_MAX_MB * 1024 * 1024
            if total > limit:
                files.sort()
                for _mtime, size, p in files:
                    if total <= limit * 0.8:
                        break
                    try:
                        os.remove(p)
                        total -= size
                    except OSError:
                        pass
                log(f"cache trimmed -> {total // (1024 * 1024)}MB")
        except Exception as e:  # 清理失败不影响服务
            log("janitor error:", e)


def _catalog_daily() -> None:
    """剧库每天从上游抓一份：首页发牌、榜单都基于这份快照，日期是真的。"""
    while True:
        try:
            if cat.needs_refresh():
                t0 = time.time()
                snap = cat.refresh()
                log(f"catalog refreshed {snap.get('date')} total={snap.get('total')} "
                    f"crawled={snap.get('crawled')} in {time.time() - t0:.1f}s")
            else:
                m = cat.meta()
                log(f"catalog ok {m.get('date')} total={m.get('total')}")
        except Exception as e:  # 抓失败就留着上一份，页面不受影响
            log("catalog refresh failed:", e)
        time.sleep(1800)


NEW_REFRESH_SEC = max(300, int(getattr(cat, "NEW_REFRESH_SEC", 900)))


def _new_worker() -> None:
    """新剧高频补：只抓 sort=new，把当天上架的剧并进快照。

    整库抓取是一天一次（榜单上的「更新日期」必须是真实的整库日期），
    但当天上架的剧不可能等到明天凌晨才出现 —— 这一路专门补新剧，
    顺带把它们的封面/集数等字段也按最新值刷一遍。失败就等下一轮。
    """
    time.sleep(30)
    while True:
        try:
            r = cat.refresh_new()
            if r.get("added") or r.get("updated"):
                log("new refreshed: added=%s updated=%s pool=%s"
                    % (r.get("added"), r.get("updated"), r.get("new_total")))
        except Exception as e:
            log("new refresh failed: %r" % (e,))
        time.sleep(NEW_REFRESH_SEC)


def main() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        acct.init_db()
        log(f"account db ready: {acct.DB_PATH}")
    except Exception as e:
        log("account db init failed:", e)
    threading.Thread(target=_janitor, daemon=True).start()
    # 剧库快照稍微晚一点点启动，别和首屏请求抢带宽
    threading.Timer(6.0, _catalog_daily).start()
    threading.Thread(target=_new_worker, name="new-refresh", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"gateway on http://{HOST}:{PORT}  upstream={core.UPSTREAM}")
    log(f"web_dir={WEB_DIR} (exists={os.path.isdir(WEB_DIR)}) cache={CACHE_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
