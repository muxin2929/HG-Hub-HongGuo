#!/usr/bin/env bash
# 本机 → 服务器：构建前端 + 上传 + 装服务 + 验证（在 Windows 的 Git Bash / WSL 里也能跑）
#
#   SERVER=root@YOUR_SERVER_IP bash deploy/deploy.sh
#   SERVER=root@YOUR_SERVER_IP PORT=18080 bash deploy/deploy.sh
#
# 需要本机有: node/npm（构建）、ssh（传文件，脚本会自动选 rsync 或 tar-over-ssh）
set -euo pipefail

SERVER="${SERVER:?用法: SERVER=root@你的服务器IP bash deploy/deploy.sh}"
PORT="${PORT:-8080}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hg}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"     # 仓库根目录
SSH="ssh -o StrictHostKeyChecking=accept-new"

echo "==> 1/5 构建前端"
cd "$ROOT/web"
[ -d node_modules ] || npm install --no-audit --no-fund
npm run build

echo "==> 2/5 准备上传目录"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/gateway" "$STAGE/web"
cp "$ROOT/gateway/"{app.py,hgcore.py,aes.py,probe.py,selftest.py} "$STAGE/gateway/"
cp -r "$ROOT/web/dist" "$STAGE/web/dist"
mkdir -p "$STAGE/deploy"
cp "$ROOT/deploy/hg-gateway.service" "$STAGE/deploy/"

echo "==> 3/5 上传到 $SERVER:$REMOTE_DIR"
$SSH "$SERVER" "mkdir -p '$REMOTE_DIR' '$REMOTE_DIR/cache'"
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete "$STAGE/gateway/" "$SERVER:$REMOTE_DIR/gateway/"
  rsync -az --delete "$STAGE/web/dist/" "$SERVER:$REMOTE_DIR/web/dist/"
  rsync -az "$STAGE/deploy/hg-gateway.service" "$SERVER:$REMOTE_DIR/deploy/"
else
  ( cd "$STAGE" && tar czf - gateway web deploy ) | $SSH "$SERVER" "tar xzf - -C '$REMOTE_DIR'"
fi
rm -rf "$STAGE"

echo "==> 4/5 安装 systemd 服务（端口 $PORT）"
$SSH "$SERVER" "set -e
  sed -i 's#Environment=PORT=.*#Environment=PORT=$PORT#' $REMOTE_DIR/deploy/hg-gateway.service
  sed -i 's#/opt/hg#$REMOTE_DIR#g' $REMOTE_DIR/deploy/hg-gateway.service
  cp $REMOTE_DIR/deploy/hg-gateway.service /etc/systemd/system/hg-gateway.service
  systemctl daemon-reload
  systemctl enable --now hg-gateway >/dev/null 2>&1 || true
  systemctl restart hg-gateway
"

echo "==> 5/5 验证"
sleep 1
$SSH "$SERVER" "curl -s --max-time 8 http://127.0.0.1:$PORT/healthz; echo;
  systemctl is-active hg-gateway"

echo
echo "完成。浏览器打开:  http://${SERVER#*@}:$PORT/"
echo "看日志:            ssh $SERVER 'journalctl -u hg-gateway -f'"
echo "跑内容源勘察:      ssh $SERVER 'cd $REMOTE_DIR/gateway && python3 probe.py'"
