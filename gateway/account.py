"""account.py —— 自建账号体系（零第三方依赖：sqlite3 + hashlib.scrypt + secrets）。

设计取舍：
  * SQLite（WAL）单文件，读多写少场景足够；不引入 Redis/Postgres，2G 内存机器友好。
  * 密码用 hashlib.scrypt（标准库自带），不依赖 bcrypt；单次 ~40ms，天然抗爆破。
  * 会话用随机 token 存表，30 天过期；前端放 localStorage，走 Authorization: Bearer。
  * 只存"我们自己的用户数据"：账号、收藏、历史续播、本地评论；不碰上游账号。

表结构见 SCHEMA；每次启动幂等建表，旧库自动兼容。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

DB_PATH = os.environ.get(
    "ACCOUNT_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "account.db"))

SESSION_DAYS = 7   # 一周；每次带 token 的请求都会顺延，活跃用户不会被踢下线
SCRYPT_N = 2 ** 14
MAX_LOGIN_FAILS = 10          # 每 IP 5 分钟内最多失败次数
LOGIN_WINDOW = 300

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history(
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  ep INTEGER DEFAULT 1,
  position REAL DEFAULT 0,
  duration REAL DEFAULT 0,
  title TEXT,
  cover TEXT,
  total INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS actions(
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  cover TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, video_id, type)
);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  nickname TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_user ON actions(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at DESC);
"""


class AccountError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status
        self.msg = msg


def _conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA busy_timeout=5000")
    return c


def init_db() -> None:
    with _conn() as c:
        c.executescript(SCHEMA)


# --------------------------------------------------------------------------- #
# 密码 / 会话
# --------------------------------------------------------------------------- #

def _hash(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=8, p=1, dklen=32)
    return dk.hex(), salt.hex()


def _check(username: str, password: str) -> sqlite3.Row:
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        raise AccountError(401, "账号或密码错误")
    calc, _ = _hash(password, row["salt"])
    if not hmac.compare_digest(calc, row["pass_hash"]):
        raise AccountError(401, "账号或密码错误")
    return row


def _public(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "nickname": row["nickname"] or row["username"],
        "avatar": row["avatar"] or "",
        "created_at": row["created_at"],
    }


def register(username: str, password: str, nickname: str = "") -> dict:
    username = (username or "").strip()
    if not (3 <= len(username) <= 24):
        raise AccountError(400, "账号长度需 3-24 位")
    if len(password or "") < 6:
        raise AccountError(400, "密码至少 6 位")
    pwd, salt = _hash(password)
    now = int(time.time())
    with _conn() as c:
        try:
            cur = c.execute(
                "INSERT INTO users(username, pass_hash, salt, nickname, avatar, created_at) VALUES (?,?,?,?,?,?)",
                (username, pwd, salt, nickname or username, "", now))
        except sqlite3.IntegrityError:
            raise AccountError(409, "该账号已存在")
        uid = cur.lastrowid
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                  (token, uid, now, now + SESSION_DAYS * 86400))
        row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return {"token": token, "user": _public(row)}


def login(username: str, password: str) -> dict:
    row = _check((username or "").strip(), password or "")
    now = int(time.time())
    token = secrets.token_urlsafe(32)
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        c.execute("INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                  (token, row["id"], now, now + SESSION_DAYS * 86400))
    return {"token": token, "user": _public(row)}


def logout(token: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token,))


def user_by_token(token: str) -> sqlite3.Row | None:
    if not token:
        return None
    now = int(time.time())
    with _conn() as c:
        row = c.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token=? AND s.expires_at>?", (token, now)).fetchone()
        # 滑动态续期：只要在一周内还用过，就把到期时间往后顺延，
        # 免得用户「天天在用却突然被踢下线」。
        if row:
            exp = c.execute("SELECT expires_at FROM sessions WHERE token=?", (token,)).fetchone()
            if exp and exp["expires_at"] - now < SESSION_DAYS * 86400 - 3600:
                c.execute("UPDATE sessions SET expires_at=? WHERE token=?",
                          (now + SESSION_DAYS * 86400, token))
    return row


def update_profile(uid: int, nickname: str | None, avatar: str | None) -> dict:
    with _conn() as c:
        if nickname is not None:
            c.execute("UPDATE users SET nickname=? WHERE id=?", (nickname.strip()[:24], uid))
        if avatar is not None:
            c.execute("UPDATE users SET avatar=? WHERE id=?", (avatar[:500], uid))
        row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return _public(row)


# --------------------------------------------------------------------------- #
# 历史 / 续播
# --------------------------------------------------------------------------- #

def history_upsert(uid: int, item: dict) -> None:
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO history(user_id, video_id, ep, position, duration, title, cover, total, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(user_id, video_id) DO UPDATE SET"
            " ep=excluded.ep, position=excluded.position, duration=excluded.duration,"
            " title=excluded.title, cover=excluded.cover, total=excluded.total, updated_at=excluded.updated_at",
            (uid, int(item["video_id"]), int(item.get("ep") or 1), float(item.get("position") or 0),
             float(item.get("duration") or 0), item.get("title") or "", item.get("cover") or "",
             int(item.get("total") or 0), now))


def history_list(uid: int, limit: int = 60) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM history WHERE user_id=? ORDER BY updated_at DESC LIMIT ?",
            (uid, limit)).fetchall()
    return [{
        "video_id": r["video_id"], "ep": r["ep"], "position": r["position"], "duration": r["duration"],
        "title": r["title"], "cover": r["cover"], "total": r["total"], "updated_at": r["updated_at"],
    } for r in rows]


def history_delete(uid: int, video_id: int | None = None) -> None:
    with _conn() as c:
        if video_id is None:
            c.execute("DELETE FROM history WHERE user_id=?", (uid,))
        else:
            c.execute("DELETE FROM history WHERE user_id=? AND video_id=?", (uid, int(video_id)))


# --------------------------------------------------------------------------- #
# 点赞 / 收藏
# --------------------------------------------------------------------------- #

def action_toggle(uid: int, video_id: int, type_: str, title: str, cover: str) -> dict:
    if type_ not in ("like", "collect"):
        raise AccountError(400, "type 只能是 like 或 collect")
    now = int(time.time())
    with _conn() as c:
        row = c.execute(
            "SELECT 1 FROM actions WHERE user_id=? AND video_id=? AND type=?",
            (uid, int(video_id), type_)).fetchone()
        if row:
            c.execute("DELETE FROM actions WHERE user_id=? AND video_id=? AND type=?",
                      (uid, int(video_id), type_))
            active = False
        else:
            c.execute(
                "INSERT INTO actions(user_id, video_id, type, title, cover, created_at) VALUES (?,?,?,?,?,?)",
                (uid, int(video_id), type_, title or "", cover or "", now))
            active = True
    return {"active": active, "video_id": int(video_id), "type": type_}


def action_list(uid: int, type_: str | None = None, limit: int = 200) -> list[dict]:
    sql = "SELECT * FROM actions WHERE user_id=?"
    args: list = [uid]
    if type_:
        sql += " AND type=?"
        args.append(type_)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with _conn() as c:
        rows = c.execute(sql, args).fetchall()
    return [{"video_id": r["video_id"], "type": r["type"], "title": r["title"],
             "cover": r["cover"], "created_at": r["created_at"]} for r in rows]


def action_state(uid: int, video_id: int) -> dict:
    with _conn() as c:
        rows = c.execute("SELECT type FROM actions WHERE user_id=? AND video_id=?",
                         (uid, int(video_id))).fetchall()
    kinds = {r["type"] for r in rows}
    return {"like": "like" in kinds, "collect": "collect" in kinds}


# --------------------------------------------------------------------------- #
# 本地评论（和上游评论合并展示）
# --------------------------------------------------------------------------- #

def comment_add(uid: int, video_id: int, content: str, nickname: str) -> dict:
    content = (content or "").strip()
    if not content:
        raise AccountError(400, "评论不能为空")
    if len(content) > 500:
        raise AccountError(400, "评论最多 500 字")
    now = int(time.time())
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO comments(video_id, user_id, nickname, content, created_at) VALUES (?,?,?,?,?)",
            (int(video_id), uid, nickname, content, now))
        cid = cur.lastrowid
    return {"id": cid, "video_id": int(video_id), "nickname": nickname, "content": content,
            "created_at": now, "time": "刚刚", "like_count": 0, "mine": True}


def comment_list(video_id: int, limit: int = 50) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM comments WHERE video_id=? ORDER BY created_at DESC LIMIT ?",
            (int(video_id), limit)).fetchall()
    return [{"id": r["id"], "video_id": r["video_id"], "nickname": r["nickname"],
             "content": r["content"], "created_at": r["created_at"], "time": "刚刚",
             "like_count": 0, "mine": True, "avatar": "", "avatar_color": "#4a7c8c"} for r in rows]


# --------------------------------------------------------------------------- #
# 简易登录限流（内存计数，够用且不落盘）
# --------------------------------------------------------------------------- #

_fails: dict[str, list[float]] = {}


def login_guard(ip: str) -> None:
    now = time.time()
    hits = [t for t in _fails.get(ip, []) if now - t < LOGIN_WINDOW]
    _fails[ip] = hits
    if len(hits) >= MAX_LOGIN_FAILS:
        raise AccountError(429, "尝试过于频繁，请 5 分钟后再试")


def login_fail(ip: str) -> None:
    _fails.setdefault(ip, []).append(time.time())


def login_ok(ip: str) -> None:
    _fails.pop(ip, None)


if __name__ == "__main__":
    init_db()
    r = register("demo_" + secrets.token_hex(2), "123456", "演示")
    print("register ok:", json.dumps(r, ensure_ascii=False)[:120])
    print("login ok:", json.dumps(login(r["user"]["username"], "123456"), ensure_ascii=False)[:120])
