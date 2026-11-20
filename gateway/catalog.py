"""catalog.py —— 剧库快照（每日从上游整库抓一份，落盘 data/catalog.json）。

存在意义：
  * 首页「来来回回那几个」的根因是每次随机翻一页、第一页那 20 部权重过高；
    本地有一份全集快照，就能按「热度加权 + 最近看过的不再出现」发牌。
  * 榜单要「每日更新、日期是真实的」：榜单不再由前端临时算，而是从这份
    每日快照里排，返回里带着快照的真实抓取日期。
  * 剧库自动更新：后台线程每天抓一次，失败就保留上一份快照，页面不受影响。

数据只来自上游真实接口（/api/videos），不做任何编造。
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
import urllib.parse

import hgcore as core

DATA_DIR = os.path.abspath(os.environ.get(
    "DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")))
PATH = os.path.join(DATA_DIR, "catalog.json")

# 抓取规模：
#   * 全站片库（/api/videos 不带 cate）整库 90 页 ≈ 1789 部，这是「上游片库」的来源；
#   * 分类池按上游 pagination.pages 抓到底（0 = 到底：短剧 84 页、漫剧 6 页）；
#   * 新剧 8 页（sort=new）。
PAGES_ALL = int(os.environ.get("CATALOG_PAGES", "90"))
PAGES_CATE = int(os.environ.get("CATALOG_PAGES_CATE", "0"))
PAGES_NEW = int(os.environ.get("CATALOG_PAGES_NEW", "8"))
# 新剧增量刷新间隔（秒）。整库一天一次，新剧这块单独高频补，
# 否则当天上架的剧要等到明天凌晨才进得来看不到的池子。
NEW_REFRESH_SEC = int(os.environ.get("NEW_REFRESH_SEC", "900"))
NEW_PAGES = int(os.environ.get("NEW_REFRESH_PAGES", "3"))

_lock = threading.Lock()
_mem: dict = {}
_mem_at = 0.0


# --------------------------------------------------------------------------- #
# 抓取
# --------------------------------------------------------------------------- #

def _crawl(pages: int, cate_id=None, sort=None, size=None, path="videos",
           limit_s: float = 480.0) -> dict:
    """翻上游列表；pages<=0 表示按上游 pagination.pages 抓到底。

    任一页失败就停（保住已抓到的），整库不断更。
    size 传给上游每页条数（实测 size=100 生效，整库 1793 部 18 页就能抓完）。
    path 默认 videos；上游的「片库」是 videos/long（实测与 videos 同源同量）。
    """
    got: dict[str, dict] = {}
    t0 = time.time()
    limit = pages if pages and pages > 0 else 10 ** 6
    p = 1
    while p <= limit:
        if time.time() - t0 > limit_s:
            break
        try:
            d = core.get_json(core.api_url(path, page=p, cate_id=cate_id,
                                           sort=sort, size=size))
        except Exception:
            break
        dd = d.get("data") or {}
        items = dd.get("items") or []
        if not items:
            break
        for it in items:
            if not isinstance(it, dict) or not it.get("id"):
                continue
            got[str(it["id"])] = it
        pag = dd.get("pagination") or {}
        last = int(pag.get("pages") or p)
        if len(items) < int(pag.get("size") or 20):
            break
        if p >= last:
            break
        p += 1
    return got


def _by_keyword(queries: list[str], must: tuple[str, ...], max_pages: int = 3) -> dict:
    """上游分类 26/27 的接口是 0 条（分类页已 410），但库里确实有相关内容。

    用上游自己的搜索接口（/api/search?q=）取真实条目，只留标题/标签里真的含关键词的，
    既不造假，也不至于让这两个分类永远空着。上游上了正经分类后，_crawl 那路会自动接手。
    """
    got: dict[str, dict] = {}
    for q in queries:
        for p in range(1, max_pages + 1):
            try:
                d = core.get_json(core.api_url("search", q=q, page=p))
            except Exception:
                break
            items = (d.get("data") or {}).get("items") or []
            for it in items:
                if not isinstance(it, dict) or not it.get("id"):
                    continue
                title = str(it.get("title") or "")
                tags = " ".join(str(t) for t in (it.get("tags") or []))
                if any(k in title or k in tags for k in must):
                    got[str(it["id"])] = it
            if len(items) < 20:
                break
    return got


def _topics(limit_s: float = 300.0) -> dict:
    """上游的「AI 短剧」专题（/api/topics + /api/topics/:slug）。

    实测 2026-11：11 个专题（精品高分 / 家庭伦理 / 灵异 / 校园青春 / 末世重生 /
    百合女同 / 乡村 / 古风穿越 / 仙侠 / 天菜男同 / 欧美），去重 367 部，
    全部是上游真实条目（和整库里的剧是同一批，不是另一套片源）。
    上游的「AI换脸(26)」「AI魔改(27)」分类页已经 410 下线，
    这批专题就是那两个入口背后的内容本体 —— 用它补 27 的池，不编造任何东西。
    """
    got: dict[str, dict] = {}
    t0 = time.time()
    try:
        d = core.get_json(core.api_url("topics", size=100))
    except Exception:
        return got
    for t in ((d.get("data") or {}).get("items") or []):
        if time.time() - t0 > limit_s:
            break
        slug = str(t.get("slug") or "").strip()
        if not slug:
            continue
        p = 1
        while p <= 12:
            try:
                dd = core.get_json(core.api_url("topics/" + urllib.parse.quote(slug),
                                                page=p, size=100))
            except Exception:
                break
            vd = ((dd.get("data") or {}).get("videos") or {})
            items = vd.get("items") or []
            if not items:
                break
            for it in items:
                if isinstance(it, dict) and it.get("id"):
                    got[str(it["id"])] = it
            if p >= int((vd.get("pagination") or {}).get("pages") or 1):
                break
            p += 1
    return got


def _slim(it: dict) -> dict:
    """只留前端要用的字段，快照文件小一点。"""
    keep = ("id", "title", "cover", "description", "duration", "episode_count",
            "total_episodes", "hot", "like_count", "collect_count", "score",
            "created_at", "is_finished", "is_hot", "tags", "author", "preview_url")
    return {k: it.get(k) for k in keep if k in it}


def build() -> dict:
    now = int(time.time())
    # 上游「片库」（/api/videos/long）整库抓到底：实测 total=1793、size=100 时 18 页。
    all_items = _crawl(0, size=100, path="videos/long")
    if not all_items:  # long 接口抽风就退回普通列表
        all_items = _crawl(PAGES_ALL, size=100)
    fresh = _crawl(PAGES_NEW, sort="new", size=50)
    all_items.update(fresh)                      # 新剧也进总池
    c24 = _crawl(0, cate_id=24, size=100)
    c25 = _crawl(0, cate_id=25, size=100)
    # 上游另有「AI换脸(26)」「AI魔改(27)」两个分类：
    # 实测 2026-11 分类列表 0 条、/api/videos/category/<route> 直接 410「内容已下线」，
    # 是上游自己下架了这两个栏目（不是我们接口用错）。照样抓一遍：
    # 上游哪天恢复，第二天自动进库、剧场也就有了，不用改代码。
    c26 = _crawl(0, cate_id=26, size=100)
    c27 = _crawl(0, cate_id=27, size=100)
    # 分类接口 0 条时，用上游搜索兜底（只收标题/标签真含关键词的条目）
    kw26 = _by_keyword(["AI换脸", "换脸", "换脸术"], ("换脸",))
    kw27 = _by_keyword(["AI魔改", "魔改", "魔改版"], ("魔改",))
    c26.update(kw26)
    c27.update(kw27)
    # 27(AI魔改) 的真正内容来自上游「AI 短剧」专题（367 部真实条目）。
    # 26(AI换脸) 按用户决定保持空态，不接这批内容。
    tp27 = _topics()
    c27.update(tp27)

    items = {k: _slim(v) for k, v in all_items.items()}
    # cate 桶里的条目也要补齐进 items（保证返回的字段是全的）
    for bucket in (c24, c25, c26, c27):
        for k, v in bucket.items():
            items.setdefault(k, _slim(v))

    ordered = sorted(
        items.items(),
        key=lambda kv: -(float(kv[1].get("hot") or 0) or float(kv[1].get("like_count") or 0)),
    )
    snap = {
        "updated_at": now,
        "date": time.strftime("%Y-%m-%d", time.localtime(now)),
        "total": len(items),
        "crawled": {"all": len(all_items), "new": len(fresh), "c24": len(c24),
                    "c25": len(c25), "c26": len(c26), "c27": len(c27),
                    "kw26": len(kw26), "kw27": len(kw27), "topic27": len(tp27)},
        "pools": {
            "all": [k for k, _ in ordered],
            "24": list(c24.keys()),
            "25": list(c25.keys()),
            "26": list(c26.keys()),
            "27": list(c27.keys()),
            "new": list(fresh.keys()),
        },
        "items": items,
    }
    return snap


def save(snap: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, PATH)


def load() -> dict:
    global _mem, _mem_at
    try:
        mt = os.path.getmtime(PATH)
    except OSError:
        return {}
    if _mem and _mem_at >= mt:
        return _mem
    try:
        with open(PATH, encoding="utf-8") as f:
            _mem = json.load(f)
        _mem_at = mt
    except Exception:
        return {}
    return _mem


def current() -> dict:
    with _lock:
        return load() or {}


def refresh() -> dict:
    """抓一份新快照并落盘；失败抛异常，调用方决定要不要重试。"""
    snap = build()
    if not snap.get("items"):
        raise RuntimeError("catalog empty")
    save(snap)
    global _mem, _mem_at
    with _lock:
        _mem = snap
        _mem_at = os.path.getmtime(PATH)
    return snap


def needs_refresh() -> bool:
    snap = current()
    if not snap:
        return True
    today = time.strftime("%Y-%m-%d", time.localtime())
    return snap.get("date") != today


# --------------------------------------------------------------------------- #
# 增量：新剧高频补齐 + 字段回写
# --------------------------------------------------------------------------- #

def patch(bag: dict) -> int:
    """把「读时补齐」拿到的字段写回快照（内存 + 落盘），返回改动条数。

    bag 形如 {"14674": {"cover": "https://...", "description": "..."}}。
    只往空字段里填，绝不拿空值/旧值盖掉已有的东西。
    """
    if not bag:
        return 0
    snap = current()
    items = snap.get("items") or {}
    if not items:
        return 0
    changed = 0
    for vid, fields in bag.items():
        it = items.get(str(vid))
        if not isinstance(it, dict):
            continue
        touched = False
        for k, v in (fields or {}).items():
            if v is None or v == "" or v == [] or v == {}:
                continue
            if it.get(k) is None or it.get(k) == "" or it.get(k) == []:
                it[k] = v
                touched = True
        if touched:
            changed += 1
    if changed:
        save(snap)
    return changed


def refresh_new(pages: int = 0, size: int = 50) -> dict:
    """只抓「新剧」（sort=new）并 upsert 进现有快照，热度/榜单那部分不动。

    一日一次的整库抓取会把当天上架的剧甩在门外（快照凌晨生成，
    下午上架的剧一整天都进不来剧场/榜单/随机池）。这个方法高频跑，专门补这块。
    返回 {"added": n, "updated": m, "new_total": k}。
    """
    fresh = _crawl(pages or NEW_PAGES, sort="new", size=size)
    if not fresh:
        raise RuntimeError("upstream new list empty")
    snap = current()
    if not snap.get("items"):
        return {"added": 0, "updated": 0, "new_total": 0, "cold": True}

    items = snap.get("items") or {}
    pools = snap.get("pools") or {}
    added, updated = [], 0
    for k, v in fresh.items():
        new = _slim(v)
        old = items.get(k)
        if not isinstance(old, dict):
            items[k] = new
            added.append(k)
            continue
        touched = False
        for f, val in new.items():
            if val is None or val == "" or val == []:
                continue                      # 上游返回空值时不覆盖已有的
            if old.get(f) != val:
                old[f] = val
                touched = True
        if touched:
            updated += 1

    # 新剧池：按上游真实上架时间倒序（新抓到的先并进来）
    newids = set(pools.get("new") or []) | set(fresh.keys())
    newids = [i for i in newids if i in items]
    newids.sort(key=lambda i: str(items[i].get("created_at") or ""), reverse=True)
    pools["new"] = newids[:400]
    # 总池也放进来，首页随机才有机会抽到刚刚上架的剧
    allids = list(pools.get("all") or [])
    known = set(allids)
    for k in reversed(list(fresh.keys())):
        if k not in known:
            allids.append(k)
            known.add(k)
    pools["all"] = allids

    snap["items"] = items
    snap["pools"] = pools
    snap["total"] = len(items)
    snap["new_at"] = int(time.time())
    # 注意：不动 updated_at / date —— 榜单上的「更新日期」必须还是整库抓取那天
    save(snap)

    global _mem, _mem_at
    with _lock:
        _mem = snap
        try:
            _mem_at = os.path.getmtime(PATH)
        except OSError:
            _mem_at = 0.0
    return {"added": len(added), "updated": updated, "new_total": len(pools["new"])}


# --------------------------------------------------------------------------- #
# 发牌 / 榜单
# --------------------------------------------------------------------------- #

def _pool(snap: dict, chan: str, merge: bool = True) -> list[str]:
    pools = snap.get("pools") or {}
    key = chan if chan in pools else "all"
    ids = pools.get(key) or []
    if not ids:
        return list(pools.get("all") or [])
    # 26/27（AI换脸/AI魔改）本身条目就少，绝不能拿全站剧去凑，否则等于造假
    if merge and key != "all" and chan not in ("26", "27") and len(ids) < 40:
        ids = list(ids) + [x for x in (pools.get("all") or []) if x not in ids]
    return ids


def pool_page(chan: str, page: int = 1, size: int = 20, sort: str = "") -> dict:
    """按池分页取完整条目（给「上游分类为空时」的前端兜底用）。"""
    snap = current()
    items = snap.get("items") or {}
    ids = [i for i in (snap.get("pools") or {}).get(chan) or [] if i in items]
    if sort == "new":
        ids.sort(key=lambda i: str(items[i].get("created_at") or ""), reverse=True)
    elif sort == "hot":
        ids.sort(key=lambda i: -float(items[i].get("hot") or 0))
    total = len(ids)
    start = max(0, (page - 1) * size)
    return {
        "items": [items[i] for i in ids[start:start + size]],
        "pagination": {"page": page, "pages": max(1, -(-total // size)), "size": size, "total": total},
    }


def _weight(v: dict, max_hot: float, max_like: float) -> float:
    hot = float(v.get("hot") or 0)
    like = float(v.get("like_count") or 0)
    collect = float(v.get("collect_count") or 0)
    w = 1.0
    if max_hot > 0:
        w += 3.0 * (hot / max_hot)          # 热门权重最高 4x
    if max_like > 0:
        w += 1.2 * (like / max_like)
    if max_like > 0:
        w += 0.8 * (collect / max_like)
    if v.get("is_hot"):
        w += 0.6
    return w


def random_items(chan: str = "", n: int = 12, exclude: set[str] | None = None,
                 seed: int | None = None) -> list[dict]:
    snap = current()
    items = snap.get("items") or {}
    ids = _pool(snap, chan)
    if not items or not ids:
        return []
    rnd = random.Random(seed) if seed else random.Random()

    pool = [i for i in ids if i in items]
    ex = exclude or set()
    strict = [i for i in pool if i not in ex]
    # 排除太狠（几乎都看过了）就放宽，宁可重复也不能没内容
    if len(strict) < n * 2:
        strict = pool

    max_hot = max((float(items[i].get("hot") or 0) for i in strict), default=0.0)
    max_like = max((float(items[i].get("like_count") or 0) for i in strict), default=0.0)

    picked: list[str] = []
    cand = list(strict)
    weights = [_weight(items[i], max_hot, max_like) for i in cand]
    while cand and len(picked) < n:
        idx = rnd.choices(range(len(cand)), weights=weights, k=1)[0]
        picked.append(cand.pop(idx))
        weights.pop(idx)
    return [items[i] for i in picked]


RANK_TYPES = ("recommend", "hot", "new")


def ranks(chan: str = "", type_: str = "recommend", limit: int = 60) -> list[dict]:
    snap = current()
    items = snap.get("items") or {}
    ids = [i for i in _pool(snap, chan, merge=False) if i in items]
    if not ids:
        return []

    def key_recommend(i: str) -> float:
        v = items[i]
        return -((float(v.get("like_count") or 0)) + float(v.get("collect_count") or 0))

    def key_hot(i: str) -> float:
        return -(float(items[i].get("hot") or 0))

    def key_new(i: str) -> str:
        return str(items[i].get("created_at") or "")

    if type_ == "hot":
        ids.sort(key=key_hot)
    elif type_ == "new":
        ids.sort(key=key_new, reverse=True)
    else:
        ids.sort(key=key_recommend)
    out = []
    for n, i in enumerate(ids[:limit], 1):
        v = dict(items[i])
        v["rank"] = n
        out.append(v)
    return out


def meta() -> dict:
    snap = current()
    return {
        "total": snap.get("total") or 0,
        "date": snap.get("date") or "",
        "updated_at": snap.get("updated_at") or 0,
        "pools": {k: len(v) for k, v in (snap.get("pools") or {}).items()},
    }
