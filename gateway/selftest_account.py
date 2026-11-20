import json
import os
import sys
import time
import urllib.error
import urllib.request

B = "http://127.0.0.1:18090"


def call(method, path, body=None, token=None):
    data = None
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(B + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


ok = True


def check(name, cond, extra=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {extra}")


st, r = call("POST", "/api/auth/register", {"username": "tester1", "password": "abc12345", "nickname": "测试员"})
check("注册", st == 200 and r.get("data", {}).get("token"), str(st))
token = (r.get("data") or {}).get("token", "")

st, r = call("POST", "/api/auth/register", {"username": "tester1", "password": "abc12345"})
check("重复注册被拒", st == 409, str(st))

st, r = call("POST", "/api/auth/login", {"username": "tester1", "password": "wrong-pass"})
check("错误密码 401", st == 401, str(st))

st, r = call("POST", "/api/auth/login", {"username": "tester1", "password": "abc12345"})
check("登录", st == 200 and r["data"]["token"], str(st))
token = r["data"]["token"]

st, r = call("GET", "/api/auth/me", token=token)
check("me", st == 200 and r["data"]["username"] == "tester1", str(r.get("data")))

st, r = call("POST", "/api/me/history", {"video_id": 12, "ep": 3, "position": 42.5, "duration": 207,
                                         "title": "神瞳觉醒", "cover": "http://x/y.jpg", "total": 21}, token=token)
check("写历史", st == 200, str(st))
st, r = call("GET", "/api/me/history", token=token)
check("读历史", st == 200 and r["data"]["items"][0]["ep"] == 3, str(r["data"]["items"][:1]))

st, r = call("POST", "/api/me/actions", {"video_id": 12, "type": "collect", "title": "神瞳觉醒"}, token=token)
check("收藏 toggle on", st == 200 and r["data"]["active"] is True, str(r.get("data")))
st, r = call("GET", "/api/me/actions?type=collect", token=token)
check("收藏列表", len(r["data"]["items"]) == 1)
st, r = call("POST", "/api/me/actions", {"video_id": 12, "type": "collect"}, token=token)
check("收藏 toggle off", r["data"]["active"] is False)
st, r = call("GET", "/api/me/action?video_id=12", token=token)
check("收藏状态", r["data"]["collect"] is False)

st, r = call("POST", "/api/me/comment", {"video_id": 12, "content": "本地评论测试"}, token=token)
check("发评论", st == 200 and r["data"]["content"], str(st))
st, r = call("GET", "/api/me/comments?video_id=12")
check("评论列表", len(r["data"]["items"]) == 1)

st, r = call("GET", "/api/me/history")
check("未登录访问被拒", st == 401, str(st))

st, r = call("POST", "/api/auth/logout", token=token)
check("登出", st == 200)
st, r = call("GET", "/api/auth/me", token=token)
check("登出后 token 失效", st == 401, str(st))

print("\n" + ("全部通过" if ok else "有失败项"))
sys.exit(0 if ok else 1)
