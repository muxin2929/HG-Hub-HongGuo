#!/usr/bin/env python3
"""selftest.py —— 网关端到端自测（不需要真实上游，也不联网）。

起一个假上游（含加密封面 / m3u8 / AES key / 分片）+ 一个网关实例，跑完整链路：

    /api/videos 透传 → /api/play 取流 → /media/manifest 改写 → /media/seg 拉分片
    /img 封面 AES 解密 → 白名单拦截

用法： python selftest.py      # 全绿说明网关逻辑没问题，可以部署到服务器
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
UP_PORT = 18081
GW_PORT = 18080

# 1x1 PNG（明文封面），补齐到 16 的倍数后用上游参数加密成"密文封面"
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000100ffff03000006000557bfabd4000000"
    "0049454e44ae426082"
)
KEY = b"f5d965df75336270"
IV = b"97b60394abc2fbe1"
PLAINTEXT = PNG + b"\x00" * (16 - len(PNG) % 16)
KEY_HEX, IV_HEX = KEY.hex(), IV.hex()


def encrypt(data: bytes) -> bytes:
    """用网关同一套 key/iv 造一张"加密封面"（不需要 openssl）。"""
    import hgcore
    return hgcore.aes_encrypt(data)


class MockUpstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, body: bytes, ctype: str, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.startswith("/api/videos/12/episodes/1/playback"):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            if body:  # 上游规则：请求体必须为空 JSON
                return self._send(json.dumps({"status": 0, "msg": "播放参数无效"}).encode(),
                                  "application/json")
            payload = {"status": 1, "data": {
                "streams": {"main": f"http://127.0.0.1:{UP_PORT}/hls/m.m3u8?auth_key=abc"},
                "cdn": {"authKey": "x-cdn-auth"}, "manifest_method": "GET"}}
            return self._send(json.dumps(payload).encode(), "application/json")
        self._send(b"{}", "application/json", 404)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/videos":
            items = [{"id": 12, "title": "测试剧", "cover": f"http://127.0.0.1:{UP_PORT}/pic.jpg",
                      "episode_count": 79, "collect_count": 275000,
                      "counts": {"hot": 39190000}, "tags": ["宫廷"]}]
            return self._send(json.dumps({"data": {"items": items, "pagination": {"page": 1, "pages": 1, "size": 1, "total": 1}}}).encode(),
                              "application/json")
        if path == "/api/videos/12":
            return self._send(json.dumps({"data": {"id": 12, "title": "测试剧", "episode_count": 79}}).encode(),
                              "application/json")
        if path == "/pic.jpg":
            return self._send(encrypt(PLAINTEXT), "binary/octet-stream")
        if path == "/hls/m.m3u8":
            text = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n"
                    '#EXT-X-KEY:METHOD=AES-128,URI="k.key?auth_key=abc"\n'
                    "#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\nseg2.ts\n#EXT-X-ENDLIST\n")
            return self._send(text.encode(), "application/vnd.apple.mpegurl")
        if path == "/hls/k.key":
            return self._send(KEY, "application/octet-stream")
        if path == "/hls/seg1.ts":
            return self._send(b"\x47" * 1880, "video/mp2t")
        self._send(b"not found", "text/plain", 404)


def http(url: str, data: bytes | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def main() -> int:
    os.environ["UPSTREAM"] = f"http://127.0.0.1:{UP_PORT}"
    os.environ["IMG_KEY"] = KEY.hex()
    os.environ["IMG_IV"] = IV.hex()
    os.environ["CACHE_DIR"] = tempfile.mkdtemp(prefix="hgcache-")
    os.environ["TIMEOUT"] = "8"
    os.environ["EXTRA_HOSTS"] = "127.0.0.1"
    sys.path.insert(0, HERE)
    import hgcore  # noqa: F401  确认 import 期读取的是上面的环境变量
    import app  # noqa: F401

    up = ThreadingHTTPServer(("127.0.0.1", UP_PORT), MockUpstream)
    gw = ThreadingHTTPServer(("127.0.0.1", GW_PORT), app.Handler)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    threading.Thread(target=gw.serve_forever, daemon=True).start()
    time.sleep(0.4)
    base = f"http://127.0.0.1:{GW_PORT}"
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        ok = ok and bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}  {detail}")

    st, body, _ = http(base + "/healthz")
    check("healthz", st == 200 and b"ok" in body)

    st, body, _ = http(base + "/api/videos?page=1")
    data = json.loads(body or b"{}")
    items = (data.get("data") or {}).get("items") or []
    check("api 透传", st == 200 and len(items) == 1, f"HTTP {st} items={len(items)}")

    # 请求体必须为空 JSON：网关内部固定发 {}，所以即便客户端传 ep 也能取到流
    st, body, _ = http(base + "/api/play", data=json.dumps({"id": 12, "ep": 1}).encode())
    play = json.loads(body or b"{}")
    streams = (play.get("data") or {}).get("streams") or {}
    manifest_map = (play.get("data") or {}).get("manifest") or play.get("manifest") or {}
    check("play 取流", st == 200 and "main" in streams, f"HTTP {st} streams={list(streams)}")
    check("manifest 映射", bool(manifest_map.get("main", "").startswith("/media/manifest?u=")))

    st, body, _ = http(base + manifest_map.get("main", "/media/manifest?u="))
    text = body.decode()
    check("m3u8 改写", st == 200 and "/media/seg?u=" in text and "/media/key?u=" in text,
          f"HTTP {st} 行数={len(text.splitlines())}")
    check("清单里不含直连 CDN",
          all(ln.startswith("#") or ln.startswith("/media/") for ln in text.splitlines() if ln.strip()),
          "所有资源地址都已同源化")

    seg_line = next((ln for ln in text.splitlines() if ln.startswith("/media/seg")), "")
    st, body, _ = http(base + seg_line)
    check("分片代理", st == 200 and len(body) == 1880, f"HTTP {st} {len(body)}B")

    cover_url = f"http://127.0.0.1:{UP_PORT}/pic.jpg"
    st, body, hdr = http(base + "/img?u=" + urllib.parse.quote(cover_url, safe=""))
    check("封面解密", st == 200 and body.startswith(b"\x89PNG"), f"HTTP {st} {hdr.get('Content-Type')} {len(body)}B")

    st, _, _ = http(base + "/img?u=" + urllib.parse.quote("http://evil.example/a.jpg", safe=""))
    check("图床白名单", st == 403, f"HTTP {st}")

    st, _, _ = http(base + "/media/manifest?u=" + urllib.parse.quote("http://evil.example/a.m3u8", safe=""))
    check("媒体白名单", st == 403, f"HTTP {st}")

    print("\n" + ("全部通过 —— 网关逻辑正确。" if ok else "有失败项，看上面输出。"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
