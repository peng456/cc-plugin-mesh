#!/usr/bin/env node
/**
 * SessionStart hook：CC 会话启动时调用。
 *
 * 做两件事：
 *   1. 检查 cc-meshd 是否在跑；没在跑就 detached 拉起
 *   2. 把当前 session_id 注册给 meshd（引用计数 +1）
 *
 * CC hook 协议：从 stdin 读 JSON（包含 session_id, cwd, hook_event_name 等），
 * stdout 输出 JSON（可选，如 additionalContext）。本 hook 不需要返回上下文，
 * 只需要做事。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..");
const DAEMON_BIN = join(PLUGIN_ROOT, "daemon", "bin", "cc-meshd");
const DAEMON_PORT = Number(process.env.CC_MESH_PORT || "45921");
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

async function isDaemonUp() {
  try {
    const r = await fetch(`${DAEMON}/mesh/v1/health`, { signal: AbortSignal.timeout(500) });
    if (!r.ok) return false;
    const body = await r.json();
    return body && body.app === "cc-mesh";
  } catch {
    return false;
  }
}

async function startDaemon() {
  // detached + stdio ignore →  daemon 完全独立于本 hook 进程
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  // 等 daemon 起来
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isDaemonUp()) return true;
  }
  return false;
}

async function registerSession(input) {
  const body = {
    sessionId: input.session_id,
    cwd: input.cwd,
    pid: process.ppid,   // hook 是被 CC 拉起的，ppid 即 CC 进程
    alias: "",
  };
  if (!body.sessionId) return false;
  try {
    const r = await fetch(`${DAEMON}/mesh/api/session/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const input = await readStdin();

let daemonUp = await isDaemonUp();
if (!daemonUp) daemonUp = await startDaemon();

if (daemonUp) {
  await registerSession(input);
}

// hook 不输出任何 hookSpecificOutput —— 这次启动不需要往会话里注入上下文
process.exit(0);
