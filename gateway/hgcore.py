#!/usr/bin/env python3
"""hgcore —— 上游解析内核（零第三方依赖，app.py / probe.py 共用）。

这里放"内容来源"最核心的五件事：

  1. fetch()          统一的上游 HTTP 客户端（UA / Referer / 超时 / 重试 / 并发安全）
  2. resolve_play()   POST /api/videos/:id/episodes/:ep/playback，**请求体必须是 {}**
  3. rewrite_m3u8()   把清单里所有 URI 改写成 /media/seg|key?u=<绝对地址>
  4. decode_cover()   封面 AES-128-CBC / NoPadding 解密 + 文件头嗅探
  5. normalize()      上游返回结构归一（data/items/pagination 各种包装）

设计原则：本文件不依赖 web 框架，命令行、探针、正式服务、单元测试都用同一份逻辑。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #

UPSTREAM = os.environ.get("UPSTREAM", "https://your-upstream.example").rstrip("/")
UA = os.environ.get(
    "UA",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
)
REFERER = os.environ.get("REFERER", UPSTREAM + "/")
TIMEOUT = float(os.environ.get("TIMEOUT", "20"))
# 可选：你自己的上游账号 Cookie。填上之后 /api/account/me、点赞、收藏这些
# 需要登录态的接口就能用（网关会把它加到每个上游请求里）。
# 格式：直接粘贴你自己上游站点的整条 Cookie 字符串。
UPSTREAM_COOKIE = os.environ.get("UPSTREAM_COOKIE", "").strip()

# 封面解密参数：按你自己的内容源设置（16 字节，hex 字符串）。
# 不同内容源参数不同；留空时只处理明文封面，不会尝试解密。
IMG_KEY = os.environ.get("IMG_KEY", "").encode()
IMG_IV = os.environ.get("IMG_IV", "").encode()

# /img、/media 允许的域名白名单（防止被当成任意代理用）。
# 不内置任何第三方站点：默认只放行 UPSTREAM 自己的域名，
# CDN / 图床域名用 IMG_HOSTS、MEDIA_HOSTS 或 EXTRA_HOSTS（逗号分隔）追加。
_up_host = (urllib.parse.urlparse(UPSTREAM).hostname or "").lower()
IMG_HOSTS = {h.strip().lower() for h in os.environ.get("IMG_HOSTS", "").split(",") if h.strip()}
MEDIA_HOSTS = {h.strip().lower() for h in os.environ.get("MEDIA_HOSTS", "").split(",") if h.strip()}
if _up_host:
    IMG_HOSTS.add(_up_host)
    MEDIA_HOSTS.add(_up_host)

# 额外放行的域名（逗号分隔）：自测、换 CDN 域名、走自有中转时用
for _h in os.environ.get("EXTRA_HOSTS", "").split(","):
    _h = _h.strip().lower()
    if _h:
        IMG_HOSTS.add(_h)
        MEDIA_HOSTS.add(_h)

# 后缀白名单由上面的 host 自动生成（允许这些域名的子域）
IMG_SUFFIXES = tuple("." + h for h in IMG_HOSTS)
MEDIA_SUFFIXES = tuple("." + h for h in MEDIA_HOSTS)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class UpstreamError(RuntimeError):
    def __init__(self, status: int, msg: str, body: bytes = b""):
        super().__init__(f"upstream {status}: {msg}")
        self.status = status
        self.body = body


def _request(url: str, data: bytes | None, headers: dict[str, str] | None,
             method: str | None = None) -> urllib.request.Request:
    req = urllib.request.Request(
        url, data=data, method=method or ("POST" if data is not None else "GET")
    )
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "*/*")
    req.add_header("Referer", REFERER)
    if UPSTREAM_COOKIE:
        req.add_header("Cookie", UPSTREAM_COOKIE)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    return req


def fetch(url: str, data: bytes | None = None, headers: dict[str, str] | None = None,
          timeout: float | None = None, retries: int = 1) -> tuple[int, bytes, str, dict]:
    """返回 (status, body, content_type, resp_headers)。4xx/5xx 也返回而不抛异常。"""
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(
                _request(url, data, headers), timeout=timeout or TIMEOUT
            ) as resp:
                body = resp.read()
                return (resp.status, body,
                        resp.headers.get_content_type() or "application/octet-stream",
                        dict(resp.headers))
        except urllib.error.HTTPError as e:
            return (e.code, e.read(),
                    (e.headers.get_content_type() if e.headers else "text/plain"),
                    dict(e.headers or {}))
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            last = e
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))
    raise UpstreamError(0, f"network error: {last}")


def get_json(url: str, **kw) -> Any:
    status, body, _, _ = fetch(url, **kw)
    if status >= 400:
        raise UpstreamError(status, body[:300].decode("utf-8", "ignore"))
    try:
        return json.loads(body)
    except Exception as e:
        raise UpstreamError(status, f"non-json: {body[:120]!r} ({e})")


# --------------------------------------------------------------------------- #
# 上游业务接口
# --------------------------------------------------------------------------- #

def api_url(path: str, **params) -> str:
    """拼上游 API 地址；params 里值为 None 的跳过。"""
    url = f"{UPSTREAM}/api/{path.lstrip('/')}"
    clean = {k: v for k, v in params.items() if v is not None and v != ""}
    if clean:
        url += "?" + urllib.parse.urlencode(clean)
    return url


def resolve_play(video_id: int | str, ep: int | str = 1) -> dict:
    """取播放流。

    上游要求：URL 里带 id 和集数，**请求体必须是空 JSON `{}`**。
    体里带 id/ep 会被判 `播放参数无效`。
    """
    url = f"{UPSTREAM}/api/videos/{video_id}/episodes/{ep}/playback"
    payload = get_json(
        url, data=b"{}", headers={"Content-Type": "application/json"}, retries=1
    )
    if isinstance(payload, dict) and payload.get("status") == 0:
        raise UpstreamError(200, payload.get("msg") or "playback rejected")
    return payload


def streams_of(payload: dict) -> dict:
    d = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(d, dict) and isinstance(d.get("streams"), dict):
        return d["streams"]
    if isinstance(payload, dict) and isinstance(payload.get("streams"), dict):
        return payload["streams"]
    return {}


def normalize(payload: Any) -> tuple[list, dict]:
    """把 {data:{items,pagination}} / {items} / [...] 统一成 (items, pagination)。"""
    d = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
    if isinstance(d, list):
        return d, {"page": 1, "pages": 1, "size": len(d), "total": len(d)}
    if not isinstance(d, dict):
        return [], {"page": 1, "pages": 1, "size": 0, "total": 0}
    for key in ("items", "list", "videos", "records", "data"):
        if isinstance(d.get(key), list):
            items = d[key]
            break
    else:
        items = []
    p = d.get("pagination") or d.get("page_info") or {}
    pagination = {
        "page": int(p.get("page") or p.get("current_page") or 1),
        "pages": int(p.get("pages") or p.get("total_pages") or 1),
        "size": int(p.get("size") or p.get("page_size") or (len(items) or 20)),
        "total": int(p.get("total") or p.get("total_count") or len(items)),
    }
    return items, pagination


# --------------------------------------------------------------------------- #
# HLS 清单改写
# --------------------------------------------------------------------------- #

URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


def media_url(kind: str, target: str, base: str) -> str:
    absolute = urllib.parse.urljoin(base, target.strip())
    return f"/media/{kind}?u={urllib.parse.quote(absolute, safe='')}"


def _key_kind(url: str) -> str:
    path = urllib.parse.urlsplit(url).path.lower()
    if path.endswith(".key") or "crypt.key" in url.lower() or "/key" in path:
        return "key"
    return "seg"


def rewrite_m3u8(text: str, base: str) -> str:
    """把清单里所有资源地址改写成同源的 /media/*。

    hls.js 用清单 URL 作为基准解析相对路径。原方案把清单原样代理到
    /proxy/m3u8?url=...，相对 .ts 就会被解析成 /proxy/xxx.ts → 404，
    只能靠"直连 CDN"兜底。这里在服务端把 URI 全部换成绝对的本站地址，
    客户端从此只认识本站，iOS/Android/WebView2 行为一致。
    """
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            out.append("")
            continue
        if line.startswith("#"):
            if line.startswith(("#EXT-X-KEY", "#EXT-X-MAP", "#EXT-X-MEDIA", "#EXT-X-I-FRAME")):
                def sub(m: re.Match) -> str:
                    kind = _key_kind(m.group(1))
                    return f'URI="{media_url(kind, m.group(1), base)}"'
                line = URI_ATTR_RE.sub(sub, line)
            out.append(line)
            continue
        out.append(media_url("seg", line, base))
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# 封面解密
# --------------------------------------------------------------------------- #

def sniff(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"\x00\x00\x00\x0c" or data[:4] == b"ftyp":
        return "image/avif"
    return None


_AES_BACKEND: str | None = None


def _openssl_bin() -> str | None:
    """找可用的 openssl 可执行文件（服务器一般都有；Windows 开发机多半没有）。"""
    for cand in (os.environ.get("OPENSSL_BIN"), "openssl",
                 r"C:\Program Files\Git\usr\bin\openssl.exe",
                 r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
        if not cand:
            continue
        try:
            subprocess.run([cand, "version"], capture_output=True, timeout=5, check=True)
            return cand
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            continue
    return None


def _aes_cbc_nopad(data: bytes) -> bytes | None:
    """AES-128-CBC / NoPadding 解密。

    三种后端按速度降级：cryptography → openssl 命令行 → 纯 Python(aes.py)。
    只要有一种可用就能解密，不强制服务器装依赖。
    """
    global _AES_BACKEND
    if not data or len(data) % 16:
        return None

    if _AES_BACKEND in (None, "cryptography"):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            dec = Cipher(algorithms.AES(IMG_KEY), modes.CBC(IMG_IV)).decryptor()
            _AES_BACKEND = "cryptography"
            return dec.update(data) + dec.finalize()
        except Exception:
            pass

    if _AES_BACKEND in (None, "openssl"):
        binary = _openssl_bin()
        if binary:
            try:
                proc = subprocess.run(
                    [binary, "enc", "-d", "-aes-128-cbc", "-nopad",
                     "-K", IMG_KEY.hex(), "-iv", IMG_IV.hex()],
                    input=data, capture_output=True, timeout=20,
                )
                if proc.returncode == 0:
                    _AES_BACKEND = "openssl"
                    return proc.stdout
            except (OSError, subprocess.SubprocessError):
                pass

    try:
        import aes as _aes
        _AES_BACKEND = "python"
        return _aes.cbc_decrypt(IMG_KEY, IMG_IV, data)
    except Exception:
        return None


def aes_encrypt(data: bytes) -> bytes:
    """仅供自测/造数据：用同一套 key/iv 加密。"""
    if len(data) % 16:
        data = data + b"\x00" * (16 - len(data) % 16)
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        enc = Cipher(algorithms.AES(IMG_KEY), modes.CBC(IMG_IV)).encryptor()
        return enc.update(data) + enc.finalize()
    except Exception:
        import aes as _aes
        return _aes.cbc_encrypt(IMG_KEY, IMG_IV, data)


def decode_cover(data: bytes) -> tuple[bytes | None, str | None]:
    """返回 (图片字节, mime)。已经是明文就原样返回；解不出图返回 (None, None)。"""
    # 先看明文：绝大多数封面本来就是 jpg/png，直接返回，省掉整张图的 AES 解密
    hit = sniff(data)
    if hit:
        return data, hit
    plain = _aes_cbc_nopad(data)
    if plain:
        hit = sniff(plain)
        if hit:
            return plain, hit
    return None, None


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #

def host_allowed(url: str, hosts: set[str], suffixes: tuple[str, ...] = ()) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in hosts or any(host.endswith(s) for s in suffixes)


def sha256(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def cache_key(url: str) -> str:
    """缓存键：忽略 query（auth_key/时间戳每次都变），只用 host+path。"""
    p = urllib.parse.urlsplit(url)
    return sha256((p.hostname or "") + p.path)


def disk_get(path: str, max_age: float | None = None) -> bytes | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    if max_age is not None and time.time() - st.st_mtime > max_age:
        return None
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def disk_put(path: str, data: bytes) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.{int(time.time()*1000)}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except OSError:
        pass


def b64img(data: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode()


if __name__ == "__main__":  # 自检：解密算法与清单改写不联网也能测
    demo = (
        "#EXTM3U\n#EXT-X-VERSION:3\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/x/crypt.key?auth_key=1"\n'
        "#EXTINF:4.0,\nseg-1.ts\n#EXTINF:4.0,\nhttps://cdn.example/x/seg-2.ts\n"
    )
    print(rewrite_m3u8(demo, "https://upstream.example/a/b.m3u8?auth_key=9"))
    print("aes module:", "cryptography" if _aes_cbc_nopad(b"\x00" * 16) is not None else "openssl-fallback")
