---
description: 把任务派给另一台机器的 Claude Code 会话执行
---

用户输入格式：`/mesh:run <目标机器> <任务描述>` 或 `/mesh:run <目标机器> [thread=xxx] [target=<session>] <任务描述>`。

调用 `mesh_run` 工具派发任务。

参数：
- `peer` = 目标机器（机器名、实例 id、或 host:port）
- `task` = 任务文本
- `thread` = 可选，相同 thread 的多次调用会在对端复用同一个 CC 会话
- `targetSession` = 可选，指定对端的某个具体 CC 会话（session id 或 alias）

派发是异步的，立即返回 taskId；任务进度用 `mesh_tasks` 查询。
