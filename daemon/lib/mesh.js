/**
 * Mesh 核心：把 discovery / state / 任务队列 / 会话注册 串起来。
 *
 * 职责：
 *   - 维护本机身份（instanceId、machineName、pairingCode）
 *   - 跑 MeshDiscovery（组播心跳 + 注册表）
 *   - 提供 publicState() / selfRecord() / taskHistory()
 *   - acceptInboundTask：入站任务入口（来自远端 HTTP）
 *   - dispatchToPeer：出站任务入口（CLI/MCP 调）
 *   - 会话注册表：sessions 维护（hook 调 register/unregister）
 *   - 零会话宽限期自杀
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import { MeshDiscovery, lanIPv4Addresses, preferredAddress, PROTOCOL_VERSION, peerOnline } from "./discovery.js";
import { scanForPeers, candidateAddresses } from "./scan.js";
import { machineFingerprint } from "./identity.js";
import { conversationKey } from "./conversation.js";
import { loadState, saveState, registerSession, unregisterSession, findSession, meshHomeDir } from "./state.js";
import { loadTaskHistory, saveTaskHistory, loadPeerSnapshot, savePeerSnapshot } from "./persist.js";
import { randomBytes } from "node:crypto";

const APP_VERSION = "0.1.0";

export class Mesh extends EventEmitter {
  constructor({
    port,
    machineName = "",
    useMulticast = true,
    scanOnStart = true,
    scanIntervalMs = 60000,
    pingIntervalMs = 10000,
    announceIntervalMs = 5000,
    peerTtlMs = 20000,
    homeDir = meshHomeDir(),
    idleTimeoutMs = 30_000,    // 零会话宽限期
    dispatchFn = null,          // 注入：dispatcher (task) => Promise<result>
  } = {}) {
    super();
    this.port = port;
    this.homeDir = homeDir;
    this.idleTimeoutMs = idleTimeoutMs;
    this.dispatchFn = dispatchFn;

    this.state = loadState(homeDir);
    if (machineName) this.state.machineName = machineName;
    if (!this.state.machineName) this.state.machineName = os.hostname();
    saveState(homeDir, this.state);

    // 任务历史
    const history = loadTaskHistory(homeDir);
    this.inbox = history.inbound;
    this.outbox = history.outbound;

    // 节流（极简版）
    this.throttle = new Map();  // threadKey -> [ts, ...]

    // 会话宽限期计时器
    this._idleTimer = null;

    // 发现
    this.discovery = new MeshDiscovery({
      id: this.state.instanceId,
      port: this.port,
      meta: {
        machine: this.state.machineName,
        hostname: os.hostname(),
        os: `${os.platform()}/${os.arch()}`,
        user: os.userInfo().username,
        version: APP_VERSION,
        fingerprint: machineFingerprint(),
      },
      intervalMs: announceIntervalMs,
      ttlMs: peerTtlMs,
    });

    this.discovery.on("change", () => this.emit("peers"));
    this.discovery.on("diagnostic", (msg) => this.emit("diagnostic", msg));

    // 配置
    this.useMulticast = useMulticast;
    this.scanOnStart = scanOnStart;
    this.scanIntervalMs = scanIntervalMs;
    this.pingIntervalMs = pingIntervalMs;
    this._timers = [];
  }

  pairingCode() { return this.state.pairingCode; }
  requirePairing() { return this.state.requirePairing === true; }

  selfRecord() {
    return {
      app: "cc-mesh",
      proto: "cc-mesh",
      v: PROTOCOL_VERSION,
      id: this.state.instanceId,
      machine: this.state.machineName,
      hostname: os.hostname(),
      os: `${os.platform()}/${os.arch()}`,
      user: os.userInfo().username,
      version: APP_VERSION,
      port: this.port,
      host: preferredAddress(),
      fingerprint: machineFingerprint(),
      ts: Date.now(),
    };
  }

  publicState() {
    const peers = this.discovery.peers().map((p) => ({
      id: p.id,
      machine: p.machine,
      hostname: p.hostname,
      os: p.os,
      user: p.user,
      version: p.version,
      online: p.online,
      restored: p.restored === true,
      lastSeen: p.lastSeen,
      host: p.host,
      port: p.port,
      transport: p.transport,
      endpoints: (p.endpoints ?? []).map((e) => ({
        transport: e.transport,
        host: e.host,
        port: e.port,
        lastSeen: e.lastSeen,
      })),
    }));
    return {
      ok: true,
      self: this.selfRecord(),
      sessions: this.state.sessions,
      peers,
      inboxSize: this.inbox.length,
      outboxSize: this.outbox.length,
      requirePairing: this.requirePairing(),
      pairingCode: this.pairingCode(),
    };
  }

  taskHistory() {
    return { inbound: this.inbox, outbound: this.outbox };
  }

  registerSession(sessionId, info) {
    const isNew = registerSession(this.state, sessionId, info);
    saveState(this.homeDir, this.state);
    this._cancelIdleTimer();
    this.emit("sessions");
    return isNew;
  }

  unregisterSession(sessionId) {
    const ok = unregisterSession(this.state, sessionId);
    if (ok) {
      saveState(this.homeDir, this.state);
      this.emit("sessions");
      this._maybeScheduleIdleExit();
    }
    return ok;
  }

  findSession(key) {
    return findSession(this.state, key);
  }

  _cancelIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  _maybeScheduleIdleExit() {
    this._cancelIdleTimer();
    if (Object.keys(this.state.sessions).length > 0) return;
    if (this.idleTimeoutMs <= 0) return;
    this._idleTimer = setTimeout(() => {
      if (Object.keys(this.state.sessions).length === 0) {
        this.emit("idle-exit");
      }
    }, this.idleTimeoutMs);
  }

  async start() {
    if (this.useMulticast) this.discovery.start({ multicast: true });
    else this.discovery.start({ multicast: false });
    if (this.scanOnStart) {
      this.scanNow().catch(() => {});
    }
    if (this.scanIntervalMs > 0) {
      this._timers.push(setInterval(() => this.scanNow().catch(() => {}), this.scanIntervalMs));
    }
    const snap = loadPeerSnapshot(this.homeDir);
    for (const p of snap.peers) {
      const ep = (p.endpoints ?? [])[0];
      if (ep) this.discovery.note(p.record, ep.host, { transport: ep.transport ?? "lan", probe: false });
    }
    this._maybeScheduleIdleExit();
  }

  async stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this._cancelIdleTimer();
    this.discovery.stop();
    saveTaskHistory(this.homeDir, this.inbox, this.outbox);
    savePeerSnapshot(this.homeDir, this.discovery.peers());
    saveState(this.homeDir, this.state);
  }

  async scanNow() {
    const found = await scanForPeers({ port: this.port });
    for (const peer of found) {
      this.discovery.note(peer, peer.sourceAddress, { transport: "lan", probe: true });
    }
    return { found: found.length };
  }

  /** 远端任务入站。 */
  async acceptInboundTask(body) {
    const task = {
      id: randomBytes(6).toString("hex"),
      task: String(body?.task ?? ""),
      fromMachine: String(body?.fromMachine ?? body?.from ?? ""),
      originSession: String(body?.originSession ?? ""),
      thread: String(body?.thread ?? ""),
      noWake: body?.noWake === true,
      targetSession: String(body?.targetSession ?? ""),
      receivedAt: Date.now(),
      status: "inbox",
    };
    if (!task.task) return { ok: false, error: "task required" };
    this.inbox.push(task);
    if (this.inbox.length > 200) this.inbox.splice(0, this.inbox.length - 200);
    saveTaskHistory(this.homeDir, this.inbox, this.outbox);
    this.emit("task-in", task);

    // 异步派发（不阻塞 HTTP 响应）
    if (!task.noWake && this.dispatchFn) {
      setImmediate(async () => {
        try {
          task.status = "running";
          const result = await this.dispatchFn(task, this);
          task.status = "done";
          task.result = result;
        } catch (err) {
          task.status = "error";
          task.error = String(err?.message ?? err);
        }
        saveTaskHistory(this.homeDir, this.inbox, this.outbox);
        this.emit("task-done", task);
      });
    }
    return { ok: true, taskId: task.id };
  }

  /** 出站派发。 */
  async dispatchToPeer({ peerKey, task, thread = "", targetSession = "", noWake = false }) {
    const peer = this._findPeer(peerKey);
    if (!peer) return { ok: false, error: `peer not found: ${peerKey}` };
    const host = peer.host;
    const port = peer.port;
    if (!host || !port) return { ok: false, error: "peer has no reachable endpoint" };
    const url = `http://${host}:${port}/mesh/v1/tasks`;
    const body = {
      task,
      thread,
      targetSession,
      fromMachine: this.state.machineName,
      originSession: "",
      noWake,
    };
    const headers = { "content-type": "application/json" };
    if (this.requirePairing()) headers["x-mesh-pairing"] = this.pairingCode();
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      const record = {
        id: randomBytes(6).toString("hex"),
        peer: peer.machine,
        task,
        thread,
        sentAt: Date.now(),
        ok: res.ok,
        response: json,
      };
      this.outbox.push(record);
      if (this.outbox.length > 200) this.outbox.splice(0, this.outbox.length - 200);
      saveTaskHistory(this.homeDir, this.inbox, this.outbox);
      return { ok: res.ok, ...json };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  _findPeer(key) {
    if (!key) return null;
    for (const p of this.discovery.peers()) {
      if (p.id === key) return p;
      if (p.machine === key) return p;
      if (`${p.host}:${p.port}` === key) return p;
      for (const ep of p.endpoints ?? []) {
        if (`${ep.host}:${ep.port}` === key) return p;
      }
    }
    return null;
  }
}
