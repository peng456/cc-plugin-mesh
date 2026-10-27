/**
 * Dispatcher：把入站任务注入到目标 CC 会话。
 *
 * 实现：起 `claude` CLI 子进程，用 `--resume <session-id> -p <task>`。
 *
 * 为什么不直接用 Agent SDK：
 *   - daemon 跑在 CC 之外的独立进程，没有 SDK 的认证上下文
 *   - `claude` CLI 已经装好且已认证，是最低依赖
 *   - resume-by-id 是官方支持的路径
 *
 * 关键约束：
 *   - 目标会话必须是本机已存在的 session id（在 ~/.claude/projects/<cwd-slug>/<id>.jsonl）
 *   - 若目标会话**正在另一个终端运行**，`--resume` 会**复制**那个 session
 *     起一个新的 headless 副本，而不是注入到那个活进程 —— 这是 CC 的固有限制。
 *     接受这一点：任务"接续到那个会话的上下文"目标已达成。
 *   - 权限模式：默认 plan（最保守），可在配置里改成 acceptEdits / bypassPermissions
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const CLAUDE_BIN = process.env.CC_MESH_CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PERMISSION_MODE = process.env.CC_MESH_PERMISSION_MODE || "plan";

/** 把 cwd 转成 ~/.claude/projects/ 下的目录名（CC 的约定：把 / 换成 -）。 */
function cwdSlug(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

/** 校验 sessionId 在本机真的存在（任一 project 下）。 */
export function sessionExistsLocally(sessionId) {
  if (!sessionId) return false;
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    for (const dir of readdirSync(projectsDir)) {
      if (existsSync(join(projectsDir, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch {}
  return false;
}

/**
 * 派发一条任务到目标 CC 会话。
 *
 * @param task mesh 任务对象（含 targetSession / task / thread）
 * @param mesh Mesh 实例（用于查会话注册表）
 * @returns {Promise<{sessionId, exitCode, stdout, stderr, durationMs}>}
 */
export async function dispatchTask(task, mesh) {
  const startedAt = Date.now();
  const target = resolveTarget(task, mesh);
  if (!target.sessionId) {
    throw new Error(`no target session: ${target.reason}`);
  }

  const args = [
    "--resume", target.sessionId,
    "-p", task.task,
    "--permission-mode", DEFAULT_PERMISSION_MODE,
    "--output-format", "json",
  ];
  if (target.cwd) args.push("--cwd", target.cwd);

  const result = await runClaude(args, DEFAULT_TIMEOUT_MS);
  return {
    sessionId: target.sessionId,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
  };
}

/** 决定本次任务派到哪个会话。 */
function resolveTarget(task, mesh) {
  // 1. 显式指定 targetSession（可以是 session_id 或 alias）
  if (task.targetSession) {
    const hit = mesh.findSession(task.targetSession);
    if (hit) return { sessionId: hit.sessionId, cwd: hit.cwd };
    // 没找到注册记录时也允许直接当 session id 用
    return { sessionId: task.targetSession, cwd: "" };
  }
  // 2. thread 路由：同 thread 复用同一个会话
  if (task.thread) {
    const key = `${task.fromMachine}#${task.thread}`;
    const hit = mesh.findSession(key);
    if (hit) return { sessionId: hit.sessionId, cwd: hit.cwd };
  }
  // 3. 唯一活跃会话兜底
  const sessions = Object.entries(mesh.state.sessions);
  if (sessions.length === 1) {
    const [sid, info] = sessions[0];
    return { sessionId: sid, cwd: info.cwd };
  }
  if (sessions.length === 0) return { sessionId: null, reason: "no active CC sessions registered on this machine" };
  return { sessionId: null, reason: `ambiguous: ${sessions.length} sessions active, please specify targetSession` };
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: stderr + "\n[killed: timeout]" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err?.message ?? err) });
    });
  });
}
