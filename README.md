# cc-plugin-mesh

> 在多台机器的 Claude Code 之间互派任务。**装上即可用**：UDP 组播自动发现同网段的其它 CC，无需配对码（默认对局域网开放，可改）。

```
┌──────── A 机器 (CC) ────────┐          ┌──────── B 机器 (CC) ────────┐
│  cc-meshd  :45921            │          │  cc-meshd  :45921            │
│   ├ UDP 组播心跳  ◀───────────┼──────────┼──▶  被动发现                │
│   ├ 主动扫本网段  ────────────┼──────────┼──▶  兜底发现                │
│   ├ 面板 /panel               │          │                              │
│   └ MCP server (4 tools)      │          │                              │
│                               │──任务──▶│  claude --resume 注入会话   │
└───────────────────────────────┘          └─────────────────────────────┘
```

## 上手（30 秒）

```bash
# 1. 装插件（在 CC 里）
claude plugin install peng456/cc-plugin-mesh

# 2. 打开一个 CC 会话
#    SessionStart hook 会自动：
#      - 拉起 cc-meshd（detached 进程）
#      - 把这个会话注册进 mesh 注册表
#
# 3. 在 CC 里说：
#    /mesh:peers
#    看看局域网里有哪些机器

# 4. 派任务
#    /mesh:run livingroom-mac 把 web 服务重启一下，跑完告诉我
```

## 生命周期

- **CC 启动** → SessionStart hook 拉起 cc-meshd（如果还没跑）
- **CC 关闭所有会话** → cc-meshd 5 分钟宽限期后自动退出（可用 `--idle-timeout-ms` 调整）
- **不开机自启、不后台常驻**：跟着 CC 走

## 工具

| MCP tool | 用途 |
|---|---|
| `mesh_peers` | 列出发现的机器 |
| `mesh_scan` | 主动扫本网段 |
| `mesh_run` | 派任务到对端会话（异步） |
| `mesh_tasks` | 看任务记录 |

| Slash 命令 | 用途 |
|---|---|
| `/mesh:peers` | 列机器 |
| `/mesh:run <target> <task>` | 派任务 |
| `/mesh:tasks` | 看任务记录 |

| CLI | 用途 |
|---|---|
| `cc-mesh status` | 本机 mesh 概览 |
| `cc-mesh peers` | 列机器 |
| `cc-mesh sessions` | 本机已注册会话 |
| `cc-mesh register <session-id> <alias>` | 给会话起别名 |
| `cc-mesh run <peer> <task>` | 派任务 |
| `cc-mesh panel` | 打印面板 URL |

## 面板

打开 `http://127.0.0.1:45921/panel`：
- 本机状态、配对码
- 发现的机器（在线/离线、地址、最后心跳）
- 已注册会话（id ↔ alias ↔ cwd）
- 派发任务表单
- 最近任务记录

## 安全

- **配对码默认关闭**（同局域网零配置）。在不可信网络（合租、公司、宿舍）请打开：
  ```bash
  # 编辑 ~/.cc-mesh/state.json，把 requirePairing 改成 true
  ```
- 远端任务在目标机器上以 `permission_mode=plan` 跑（最保守）。改 `CC_MESH_PERMISSION_MODE` 环境变量可调。
- 跨不可信网络不要直接暴露 45921 端口。第一版只支持局域网。

## 给会话起别名

`mesh_run` 可以派到对端**具体的 CC 会话**（默认走"唯一活跃会话"或"thread 路由"）：

```bash
# 在目标机器上
cc-mesh sessions                                  # 看 session id
cc-mesh register abc123def456 diet-web           # 起别名 diet-web

# 之后从其它机器就可以指定
/mesh:run livingroom-mac target=diet-web 把数据库 migrate 跑一下
```

## 架构

```
cc-plugin-mesh/
├── .claude-plugin/plugin.json   # 插件清单
├── .mcp.json                    # MCP server 注册（stdio，转发给 daemon）
├── commands/                    # /mesh:peers /mesh:run /mesh:tasks
├── skills/mesh-coordination/    # 协作提示词
├── agents/mesh-runner.md        # 子 agent（最小权限）
├── hooks/
│   ├── hooks.json
│   ├── session-start.mjs        # 拉起 daemon + 注册会话
│   └── session-end.mjs          # 注销会话
├── bin/
│   ├── cc-mesh                  # CLI
│   └── cc-mesh-mcp              # MCP stdio server
├── daemon/
│   ├── bin/cc-meshd             # 守护进程入口
│   └── lib/
│       ├── mesh.js              # 编排：discovery + state + tasks
│       ├── http_api.js          # HTTP 路由
│       ├── dispatcher.js        # claude --resume 注入
│       ├── state.js             # 持久状态（instanceId / sessions / pairingCode）
│       ├── discovery.js         # UDP 组播 + 注册表（沿用 dsh-mesh）
│       ├── scan.js              # 主动扫网段
│       ├── identity.js          # 持久 UUID + 机器指纹
│       ├── persist.js           # 任务/peer 落盘
│       ├── capabilities.js      # 能力采集
│       ├── osinfo.js
│       ├── conversation.js      # 会话路由键
│       └── pairing.js           # 配对码
└── panel/index.html             # 内嵌 web 面板
```

## 端口

| 端口 | 用途 |
|---|---|
| 45921 (TCP) | daemon HTTP（health/state/tasks/panel） |
| 45893 (UDP) | 组播心跳（239.255.42.100） |

跟 dsh-plugin-mesh（45917/45892）错开，两者可同机共存。

## 已知限制

- 第一版只支持局域网；Tailscale 跨互联网留待 P1
- 任务派发是异步"尽力送达"，对端离线时直接失败，**没有离线排队**
- 会话注入走 `claude --resume <id>`：如果目标会话正在另一个终端运行，会复制一个 headless 副本接续上下文，而不是把消息塞进那个活进程
- 同机多 daemon 实例不支持（端口冲突）

## License

MIT
