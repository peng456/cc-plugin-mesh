---
name: mesh-coordination
description: 与其它 Claude Code 实例协作完成跨机器任务。当用户想"让另一台机器做某事"、"看看局域网里有哪些机器"、"把任务派给 X"时使用。
---

# Mesh 协作

你有 4 个 mesh 工具可用：`mesh_peers`、`mesh_scan`、`mesh_run`、`mesh_tasks`。

## 工作流

1. **先列机器**：用户说"派给 B 机器"但没说全名时，先 `mesh_peers` 找到目标机器的准确名字 / id。
2. **重名怎么办**：如果有两台同名，`mesh_run` 会失败并列出候选，让用户用 `host:port` 精确指定。
3. **派发用 thread**：需要持续多轮交互的任务（如"部署-看日志-再改"），用同一个 `thread` 字符串，对端会复用同一个会话，不会每轮从零探索。
4. **回执别唤醒**：纯粹告知结果（"已完成"、"收到"）时传 `noWake: true`，避免在远端空开一个 agent 会话。
5. **看进度**：派发是异步的。用 `mesh_tasks` 看任务是否完成、有没有报错。

## 默认权限

远端任务在对端机器上以 `permission_mode=plan` 跑（最保守）。如果用户希望"直接执行不再确认"，需要用户自己去对端机器改 `CC_MESH_PERMISSION_MODE` 环境变量或在配置里调整。

## 跨网段

第一版只支持局域网（UDP 组播 + 主动扫描）。如果目标机器在另一个网段，让它显式配置 `scanRanges`。Tailscale 跨互联网支持是后续工作。
