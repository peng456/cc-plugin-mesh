/**
 * 持久状态（state.json）：instanceId、machineName、requirePairing、pairingCode、
 * 会话注册表。
 *
 * 与 dsh-mesh 的差异：
 *   - state 目录是 ~/.cc-mesh/，不再依赖 DSH_HOME
 *   - 多一个 sessions 字段：{session_id → {alias, cwd, pid, registeredAt, lastSeenAt}}
 *     用来支持"mesh_run 派到指定会话"
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export function meshHomeDir() {
  return process.env.CC_MESH_HOME || join(homedir(), ".cc-mesh");
}

export function stateFilePath(dir) {
  return join(dir ?? meshHomeDir(), "state.json");
}

function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, path);
}

export function loadState(dir) {
  const path = stateFilePath(dir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return normalizeState(raw);
  } catch {
    return normalizeState({});
  }
}

export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    instanceId: typeof s.instanceId === "string" && s.instanceId ? s.instanceId : randomBytes(8).toString("hex"),
    machineName: typeof s.machineName === "string" ? s.machineName : "",
    requirePairing: s.requirePairing === true,
    pairingCode: typeof s.pairingCode === "string" && s.pairingCode ? s.pairingCode : randomBytes(4).toString("hex"),
    sessions: s.sessions && typeof s.sessions === "object" ? s.sessions : {},
    savedAt: Number(s.savedAt) || 0,
  };
}

export function saveState(dir, state) {
  const path = stateFilePath(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = { ...state, savedAt: Date.now() };
  atomicWrite(path, JSON.stringify(body, null, 2));
  return path;
}

/** 注册一个 CC 会话；返回是否新增（false=已存在则只刷新 lastSeenAt）。 */
export function registerSession(state, sessionId, { alias = "", cwd = "", pid = 0 } = {}) {
  if (!sessionId) return false;
  const existing = state.sessions[sessionId];
  const isNew = !existing;
  state.sessions[sessionId] = {
    alias: String(alias || existing?.alias || ""),
    cwd: String(cwd || existing?.cwd || ""),
    pid: Number(pid) || existing?.pid || 0,
    registeredAt: existing?.registeredAt || Date.now(),
    lastSeenAt: Date.now(),
  };
  return isNew;
}

export function unregisterSession(state, sessionId) {
  if (!sessionId || !state.sessions[sessionId]) return false;
  delete state.sessions[sessionId];
  return true;
}

export function findSession(state, key) {
  if (!key) return null;
  if (state.sessions[key]) return { sessionId: key, ...state.sessions[key] };
  // 按 alias 找
  for (const [sid, info] of Object.entries(state.sessions)) {
    if (info.alias === key) return { sessionId: sid, ...info };
  }
  return null;
}
