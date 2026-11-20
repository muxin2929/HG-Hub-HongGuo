#!/usr/bin/env python3
"""probe.py —— 上游内容源勘察器（部署在你的境外服务器上跑）。

作用：把"官网到底给了什么"一次性问清楚，并把真实响应落成前端可以直接用的
fixtures。重构前端时不需要再猜字段名、不需要连不上网就卡住。

    python3 probe.py                       # 全量探查 + 落盘 fixtures
    python3 probe.py --out ../fixtures/upstream --skip-media   # 只探接口
    python3 probe.py --id 12 --ep 1        # 指定剧集验证播放链路

输出：
    <out>/<name>.json        每个接口的原始响应
    <out>/_report.md         人看的报告（状态码 / 条目数 / 字段 / 耗时）
    <out>/_cover.jpg|png     解密校验通过的一张真实封面（如果取到）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hgcore as core  # noqa: E402

GB = "\033[32m"; RB = "\033[31m"; YB = "\033[33m"; DB = "\033[2m"; RS = "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    GB = RB = YB = DB = RS = ""


class Report:
    def __init__(self):
        self.rows: list[dict[str, Any]] = []

    def add(self, name: str, ok: bool, detail: str, ms: int, **extra):
        self.rows.append({"name": name, "ok": ok, "detail": detail, "ms": ms, **extra})
        flag = f"{GB}OK  {RS}" if ok else f"{RB}FAIL{RS}"
        print(f"  [{flag}] {name:<34} {ms:>5}ms  {detail}")

    def md(self) -> str:
        bad = [r for r in self.rows if not r["ok"]]
        lines = [
            "# 上游内容源勘察报告", "",
            f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
            f"- 上游：{core.UPSTREAM}",
            f"- 结论：{len(self.rows) - len(bad)}/{len(self.rows)} 项可用" +
            ("" if not bad else f"，失败项：{', '.join(r['name'] for r in bad)}"), "",
            "| 接口 | 结果 | 耗时 | 说明 |", "| --- | --- | --- | --- |",
        ]
        for r in self.rows:
            lines.append(f"| `{r['name']}` | {'可用' if r['ok'] else '失败'} | {r['ms']}ms | {r['detail']} |")
        return "\n".join(lines) + "\n"


def save(out: str, name: str, payload: Any) -> None:
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)


def field_dict(item: dict) -> str:
    keys = []
    for k, v in item.items():
        t = "list" if isinstance(v, list) else "dict" if isinstance(v, dict) else type(v).__name__
        keys.append(f"{k}:{t}")
    return ", ".join(keys[:18])


def probe_api(rep: Report, out: str, name: str, path: str, **params) -> Any:
    url = core.api_url(path, **params)
    t0 = time.time()
    try:
        payload = core.get_json(url)
    except Exception as e:
        rep.add(name, False, str(e)[:110], int((time.time() - t0) * 1000))
        return None
    ms = int((time.time() - t0) * 1000)
    items, pg = core.normalize(payload)
    sample = items[0] if items else {}
    detail = f"{len(items)} 条 · 第{pg['page']}/{pg['pages']}页 · 共{pg['total']}"
    rep.add(name, True, detail, ms)
    save(out, name, payload)
    if sample:
        print(f"{DB}       字段: {field_dict(sample)}{RS}")
    return payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "..", "fixtures", "upstream"))
    ap.add_argument("--id", type=int, default=0, help="验证播放用的视频 id（默认取列表第一条）")
    ap.add_argument("--ep", type=int, default=1)
    ap.add_argument("--skip-media", action="store_true")
    ap.add_argument("--skip-play", action="store_true")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    rep = Report()

    print(f"\n{GB}== 1. 内容列表 =={RS}")
    first = probe_api(rep, out, "videos_p1", "videos", page=1)
    probe_api(rep, out, "videos_p2", "videos", page=2)
    cats = probe_api(rep, out, "categories", "site/categories/video")
    probe_api(rep, out, "feed_today", "feed/today")
    probe_api(rep, out, "posts_p1", "posts", page=1)

    print(f"\n{GB}== 2. 榜单 =={RS}")
    for kind in ("hot", "like", "view", "weekly", "monthly"):
        probe_api(rep, out, f"rank_{kind}", f"ranks/{kind}")

    print(f"\n{GB}== 3. 搜索 =={RS}")
    probe_api(rep, out, "search_ai", "search", q="爱", page=1)
    probe_api(rep, out, "search_hot", "search/hot")

    items, _ = core.normalize(first) if first else ([], {})
    vid = args.id or (items[0].get("id") if items else None)

    if vid:
        print(f"\n{GB}== 4. 详情 / 评论（id={vid}）=={RS}")
        probe_api(rep, out, f"video_{vid}", f"videos/{vid}")
        probe_api(rep, out, f"comments_{vid}", f"videos/{vid}/comments", page=1)

        if not args.skip_play:
            print(f"\n{GB}== 5. 播放解析 =={RS}")
            t0 = time.time()
            try:
                payload = core.resolve_play(vid, args.ep)
                streams = core.streams_of(payload)
                ms = int((time.time() - t0) * 1000)
                rep.add(f"playback id={vid} ep={args.ep}", bool(streams),
                        f"streams: {', '.join(streams) or '空'}", ms)
                save(out, f"playback_{vid}_{args.ep}", payload)
                manifest_url = streams.get("main") or next(iter(streams.values()), "")
                if streams and manifest_url and not args.skip_media:
                    _probe_media(rep, out, manifest_url)
            except Exception as e:
                rep.add(f"playback id={vid} ep={args.ep}", False, str(e)[:110],
                        int((time.time() - t0) * 1000))

    print(f"\n{GB}== 6. 封面解密 =={RS}")
    cover = next((v.get("cover") for v in items if v.get("cover")), None)
    if cover:
        t0 = time.time()
        try:
            status, body, ctype, _ = core.fetch(cover)
            img, mime = core.decode_cover(body) if status == 200 else (None, None)
            ms = int((time.time() - t0) * 1000)
            if img:
                ext = (mime or "image/jpeg").split("/")[-1].replace("jpeg", "jpg")
                path = os.path.join(out, f"_cover.{ext}")
                with open(path, "wb") as f:
                    f.write(img)
                rep.add("cover decode", True,
                        f"{len(body)}B → {mime} {len(img)}B，已存 {os.path.basename(path)}", ms)
            else:
                rep.add("cover decode", False, f"HTTP {status}，解不出图片", ms)
        except Exception as e:
            rep.add("cover decode", False, str(e)[:110], int((time.time() - t0) * 1000))
    else:
        rep.add("cover decode", False, "列表里没有 cover 字段", 0)

    md = rep.md()
    with open(os.path.join(out, "_report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    bad = [r for r in rep.rows if not r["ok"]]
    print(f"\n{GB}报告已写入 {os.path.join(out, '_report.md')}{RS}")
    print(f"fixtures 已写入 {out}")
    if bad:
        print(f"{YB}有 {len(bad)} 项失败，先排查：{', '.join(r['name'] for r in bad)}{RS}")
        return 1
    print(f"{GB}全部接口可用 —— 可以开始接前端了。{RS}")
    return 0


def _probe_media(rep: Report, out: str, manifest_url: str) -> None:
    """清单改写 → 拉 key → 拉首个分片（只取头部 4KB 验证可播）。"""
    t0 = time.time()
    try:
        status, body, _, _ = core.fetch(manifest_url)
        text = body.decode("utf-8", "ignore")
        ok = status == 200 and "#EXTM3U" in text
        rep.add("manifest fetch", ok, f"HTTP {status} {len(body)}B", int((time.time()-t0)*1000))
        if not ok:
            return
        rewritten = core.rewrite_m3u8(text, manifest_url)
        with open(os.path.join(out, "_manifest_rewritten.m3u8"), "w", encoding="utf-8") as f:
            f.write(rewritten)
        local = [ln for ln in rewritten.splitlines() if ln.startswith("/media/")]
        encrypted = "#EXT-X-KEY" in rewritten
        rep.add("manifest rewrite", bool(local),
                f"{len(local)} 个资源地址重写为同源" + ("（AES-128 加密）" if encrypted else ""), 0)

        key_line = next((ln for ln in rewritten.splitlines() if ln.startswith("#EXT-X-KEY")), "")
        if key_line:
            enc_url = urllib.parse.parse_qs(key_line.split("URI=")[1].split('"')[1].split("?")[1])["u"][0] \
                if "URI=" in key_line else ""
            if enc_url:
                t1 = time.time()
                st, kb, _, _ = core.fetch(enc_url)
                rep.add("key fetch", st == 200 and len(kb) == 16,
                        f"HTTP {st} {len(kb)}B（应为 16B）", int((time.time()-t1)*1000))

        seg = next((ln for ln in rewritten.splitlines() if ln.startswith("/media/seg")), "")
        if seg:
            seg_url = urllib.parse.parse_qs(seg.split("?")[1])["u"][0]
            t1 = time.time()
            st, sb, ct, _ = core.fetch(seg_url, headers={"Range": "bytes=0-4095"})
            rep.add("segment fetch", st in (200, 206),
                    f"HTTP {st} {len(sb)}B {ct}", int((time.time()-t1)*1000))
    except Exception as e:
        rep.add("media pipeline", False, str(e)[:110], int((time.time()-t0)*1000))


if __name__ == "__main__":
    raise SystemExit(main())
