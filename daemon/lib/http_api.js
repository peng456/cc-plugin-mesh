/**
 * HTTP API 层。
 *
 * 路由：
 *   GET  /mesh/v1/health            —— 自述（发现/扫描用），不需要鉴权
 *   GET  /mesh/v1/state             —— 完整状态（面板用），需配对码（若开启）
 *   POST /mesh/v1/task              —— 远端派发任务入站，需配对码
 *   GET  /mesh/v1/tasks             —— 任务记录，需配对码
 *
 *   POST /mesh/api/session/register   —— CC 会话注册（本机 hook 用，不需要配对）
 *   POST /mesh/api/session/unregister —— CC 会话注销
 *   GET  /mesh/api/state            —— 本机 CLI/面板用
 *
 *   GET  /panel                     —— 内嵌 HTML 面板
 *
 * 安全模型：本机回路（127.0.0.1）的请求不需要配对码；非回路地址在
 * requirePairing 开启时必须带 X-Mesh-Pairing 头。
 */
import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function safeEq(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function normalizeIp(addr) {
  const s = String(addr ?? "");
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}
function isLoopback(addr) {
  const ip = normalizeIp(addr);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += chunks.push(c) && c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function createHttpServer({ mesh }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const remoteIp = normalizeIp(req.socket.remoteAddress);
    const loopback = isLoopback(remoteIp);

    try {
      // 面板静态资源（本机回路即可）
      if (path === "/panel" || path === "/panel/") {
        const htmlPath = join(__dirname, "..", "..", "panel", "index.html");
        if (existsSync(htmlPath)) return sendHtml(res, 200, readFileSync(htmlPath, "utf8"));
        return sendHtml(res, 200, `<html><body><h1>cc-mesh panel</h1><p>panel/index.html not found</p></html>`);
      }

      // 健康检查：发现用，公开
      if (path === "/mesh/v1/health" && req.method === "GET") {
        return sendJson(res, 200, mesh.selfRecord());
      }

      // 会话注册/注销：本机 hook 用，**只接受 loopback**
      if (path === "/mesh/api/session/register" && req.method === "POST") {
        if (!loopback) return sendJson(res, 403, { ok: false, error: "loopback only" });
        const body = JSON.parse(await readBody(req));
        const { sessionId, alias, cwd, pid } = body ?? {};
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
        const isNew = mesh.registerSession(sessionId, { alias, cwd, pid });
        return sendJson(res, 200, { ok: true, isNew });
      }
      if (path === "/mesh/api/session/unregister" && req.method === "POST") {
        if (!loopback) return sendJson(res, 403, { ok: false, error: "loopback only" });
        const body = JSON.parse(await readBody(req));
        const { sessionId } = body ?? {};
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
        mesh.unregisterSession(sessionId);
        return sendJson(res, 200, { ok: true });
      }

      // 以下接口在 requirePairing 开启时都要带配对码；本机回路豁免
      if (mesh.requirePairing() && !loopback) {
        const token = req.headers["x-mesh-pairing"] ?? url.searchParams.get("pairing");
        if (!safeEq(token, mesh.pairingCode())) {
          return sendJson(res, 401, { ok: false, error: "pairing required" });
        }
      }

      if (path === "/mesh/api/state" && req.method === "GET") {
        return sendJson(res, 200, mesh.publicState());
      }

      if (path === "/mesh/v1/state" && req.method === "GET") {
        return sendJson(res, 200, mesh.publicState());
      }

      if (path === "/mesh/v1/task" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const result = await mesh.acceptInboundTask(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (path === "/mesh/v1/tasks" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...mesh.taskHistory() });
      }

      if (path === "/mesh/api/scan" && req.method === "POST") {
        const result = await mesh.scanNow();
        return sendJson(res, 200, { ok: true, ...result });
      }

      // 本机出站派发：CLI / MCP server 用；只接受 loopback
      if (path === "/mesh/api/dispatch" && req.method === "POST") {
        if (!loopback) return sendJson(res, 403, { ok: false, error: "loopback only" });
        const body = JSON.parse(await readBody(req));
        const result = await mesh.dispatchToPeer(body ?? {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      return sendJson(res, 404, { ok: false, error: "not found", path });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });

  return server;
}
