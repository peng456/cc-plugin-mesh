#!/bin/bash
# cc-mesh 端到端冒烟测试
#
# 用法：
#   1. 终端 A：node daemon/bin/cc-meshd &       (daemon-1，端口 45921)
#   2. 终端 B：./scripts/smoke-test.sh
#
# 脚本会：
#   a. 验证 daemon-1 在跑
#   b. 起 daemon-2（端口 45922，独立 home）模拟对端
#   c. 等组播互发现（最多 10s）
#   d. 在 daemon-1 上查 peers，应该看到 daemon-2
#   e. 注册一个假 CC 会话到 daemon-1
#   f. 在 daemon-2 上派任务给 daemon-1
#   g. 验证 daemon-1 收到了任务（in inbox）
#   h. 清理（杀 daemon-2）
#   i. 报告结果

set -u
cd "$(dirname "$0")/.."
PORT1=45921
PORT2=45922
HOME2=/tmp/cc-mesh-peer2-$$
DAEMON1="http://127.0.0.1:$PORT1"
DAEMON2="http://127.0.0.1:$PORT2"
PASS=0
FAIL=0

say()  { printf "%s\n" "$*"; }
ok()   { PASS=$((PASS+1)); printf "  ✅ %s\n" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf "  ❌ %s\n" "$*"; }
head() { printf "\n=== %s ===\n" "$*"; }

cleanup() {
  if [ -n "${PID2:-}" ] && kill -0 "$PID2" 2>/dev/null; then
    kill "$PID2" 2>/dev/null
  fi
  rm -rf "$HOME2"
}
trap cleanup EXIT

head "1. daemon-1 alive?"
if curl -s --max-time 2 "$DAEMON1/mesh/v1/health" | grep -q '"app":"cc-mesh"'; then
  ok=1
  SELF_ID=$(curl -s "$DAEMON1/mesh/v1/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  ok "daemon-1 is up (id=$SELF_ID)"
else
  bad "daemon-1 not reachable on $DAEMON1 — start it first: node daemon/bin/cc-meshd &"
  exit 1
fi

head "2. start daemon-2 (peer)"
mkdir -p "$HOME2"
CC_MESH_HOME="$HOME2" node daemon/bin/cc-meshd --port $PORT2 --idle-timeout-ms 600000 > /tmp/cc-meshd-2.log 2>&1 &
PID2=$!
sleep 1.5
if curl -s --max-time 2 "$DAEMON2/mesh/v1/health" | grep -q '"app":"cc-mesh"'; then
  PEER2_ID=$(curl -s "$DAEMON2/mesh/v1/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  ok "daemon-2 is up (id=$PEER2_ID)"
else
  bad "daemon-2 failed to start"
  cat /tmp/cc-meshd-2.log
  exit 1
fi

head "3. multicast discovery (waiting up to 12s)"
FOUND=0
for i in $(seq 1 12); do
  sleep 1
  COUNT=$(curl -s "$DAEMON1/mesh/api/state" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len([p for p in d.get("peers",[]) if p.get("online")]))' 2>/dev/null || echo 0)
  if [ "$COUNT" -ge 1 ]; then FOUND=1; break; fi
done
if [ "$FOUND" = "1" ]; then
  ok "daemon-1 discovered daemon-2 via multicast (online peers: $COUNT)"
else
  bad "daemon-1 did NOT discover daemon-2 within 12s"
  say "  daemon-1 state:"
  curl -s "$DAEMON1/mesh/api/state" | python3 -m json.tool | head -20
fi

head "4. register a fake CC session on daemon-1"
FAKE_SID="smoke-test-session-$$"
R=$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$FAKE_SID\",\"cwd\":\"/tmp\",\"pid\":$$}" \
  "$DAEMON1/mesh/api/session/register")
if echo "$R" | grep -q '"ok":true'; then
  ok "session registered"
else
  bad "session register failed: $R"
fi

head "5. dispatch task from daemon-2 → daemon-1"
# 用 daemon-2 的 dispatch API（loopback only），目标写 daemon-1 的 lan 地址
DAEMON1_LAN=$(curl -s "$DAEMON1/mesh/v1/health" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(str(d["host"])+":"+str(d["port"]))')
R=$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"peerKey\":\"$DAEMON1_LAN\",\"task\":\"echo hello-from-daemon-2\",\"thread\":\"smoke\",\"noWake\":true}" \
  "$DAEMON2/mesh/api/dispatch")
if echo "$R" | grep -q '"ok":true'; then
  ok "task dispatched"
else
  bad "dispatch failed: $R"
fi

sleep 1
head "6. verify task arrived in daemon-1 inbox"
INBOX_COUNT=$(curl -s "$DAEMON1/mesh/v1/tasks" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get("inbound",[])))' 2>/dev/null || echo 0)
if [ "$INBOX_COUNT" -ge 1 ]; then
  ok "inbox has $INBOX_COUNT task(s)"
  curl -s "$DAEMON1/mesh/v1/tasks" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for t in d.get("inbound",[])[-3:]:
  print("    - from=%s status=%s task=%s" % (t.get("fromMachine"), t.get("status"), (t.get("task") or "")[:60]))'
else
  bad "inbox is empty"
fi

head "7. unregister session"
R=$(curl -s -X POST -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$FAKE_SID\"}" \
  "$DAEMON1/mesh/api/session/unregister")
if echo "$R" | grep -q '"ok":true'; then
  ok "session unregistered"
else
  bad "unregister failed: $R"
fi

head "8. cleanup: kill daemon-2"
cleanup
sleep 1
if curl -s --max-time 1 "$DAEMON2/mesh/v1/health" > /dev/null 2>&1; then
  bad "daemon-2 still running"
else
  ok "daemon-2 stopped"
fi

head "RESULT"
say "  passed: $PASS"
say "  failed: $FAIL"
[ "$FAIL" = "0" ] && say "  🎉 all good" || say "  ⚠️  some checks failed"
exit "$FAIL"
