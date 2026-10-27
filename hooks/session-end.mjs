#!/usr/bin/env node
/**
 * SessionEnd hook：CC 会话退出时调用，把 session_id 从 meshd 注销。
 * 引用计数减到 0 时，meshd 会在宽限期后自杀。
 */
const DAEMON_PORT = Number(process.env.CC_MESH_PORT || "45921");
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const input = await readStdin();
const sessionId = input.session_id;
if (!sessionId) process.exit(0);

try {
  await fetch(`${DAEMON}/mesh/api/session/unregister`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(2000),
  });
} catch {
  // daemon 已经死了/不可达 —— 那就更不用做什么了
}
process.exit(0);
