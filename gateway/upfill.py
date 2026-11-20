"""upfill.py —— 读时补齐：条目字段缺了，就去详情接口补一次。

由来：上游「列表/聚合」接口对新上架的剧，cover 字段要过一阵才回填，
但「详情」接口（/api/videos/<id>）一开始就有图。于是列表里出现空封面，
前端只能显示占位 —— 不是我们抓漏，是上游聚合延迟。

策略：
  * 只在字段真缺（cover 空 / 简介空 / 集数为 0）时才请求详情，一次最多几条，
    不阻塞响应太久；失败的条目 RETRY_SEC 内不再重试，别把上游打烦。
  * 补到的值立刻用于本次响应；有 persist 回调时顺手写回剧库快照，
    下次直接从快照出，不用再问上游。
"""

from __future__ import annotations

import os
import threading
import time

import hgcore as core

# 只补真正影响展示的字段；hot/like 这类随热度变化的以列表为准，不拿详情覆盖
FIELDS = ("cover", "description", "episode_count", "total_episodes",
          "duration", "tags", "is_finished", "score")

RETRY_SEC = float(os.environ.get("UPFILL_RETRY", "600"))
MAX_PER_CALL = int(os.environ.get("UPFILL_MAX", "3"))
TIMEOUT = float(os.environ.get("UPFILL_TIMEOUT", "6"))

_lock = threading.Lock()
_next_try: dict[str, float] = {}
_memo: dict[str, dict] = {}


def _blank(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip()) or v == [] or v == {}


def _missing(v: dict) -> list[str]:
    """返回这条缺哪些字段（只关乎展示的那几个）。"""
    out = []
    if _blank(v.get("cover")):
        out.append("cover")
    if _blank(v.get("description")):
        out.append("description")
    try:
        if int(v.get("episode_count") or 0) <= 0:
            out.append("episode_count")
    except Exception:
        out.append("episode_count")
    return out


def _detail(vid: str) -> dict:
    d = core.get_json(core.api_url("videos/" + str(vid)), timeout=TIMEOUT)
    data = d.get("data") or {}
    return {k: data.get(k) for k in FIELDS if not _blank(data.get(k))}


def _allowed(vid: str) -> bool:
    with _lock:
        return time.time() >= _next_try.get(vid, 0)


def _mark(vid: str, ok: bool) -> None:
    with _lock:
        _next_try[vid] = 0 if ok else (time.time() + RETRY_SEC)


def fill(items: list[dict], persist=None, limit: int | None = None,
         wait: bool = True) -> int:
    """把 items 里缺字段的条目补上，返回补齐了几条。

    persist: callable(dict) -> None，形如 {"14674": {"cover": "...", ...}}；
             给了就顺手把补到的值写回快照（catalog.patch）。
    wait=False 时不阻塞：丢到后台线程处理（首页发牌这种不能拖慢首屏）。
    """
    if not items:
        return 0

    def _run() -> int:
        bag: dict[str, dict] = {}
        n = 0
        cap = MAX_PER_CALL if limit is None else max(0, limit)
        for v in items:
            if n >= cap:
                break
            if not isinstance(v, dict):
                continue
            vid = str(v.get("id") or "").strip()
            if not vid:
                continue
            miss = _missing(v)
            if not miss:
                continue
            got = _memo.get(vid)
            if got is None:
                if not _allowed(vid):
                    continue
                try:
                    got = _detail(vid)
                except Exception:
                    _mark(vid, False)
                    continue
                _mark(vid, True)
                _memo[vid] = got
            applied = False
            for k in miss:
                val = got.get(k)
                if not _blank(val):
                    v[k] = val
                    bag.setdefault(vid, {})[k] = val
                    applied = True
            if applied:
                n += 1
        if bag and persist:
            try:
                persist(bag)
            except Exception:
                pass
        return n

    if wait:
        return _run()
    threading.Thread(target=_run, name="upfill", daemon=True).start()
    return 0
