[English](README.md) | 简体中文

# dsh-peer-messaging

DSH（DeepSeek Harness）跨会话消息投递：让一个会话（A）把消息投递给同一个 DSH 进程里的另一个会话（B），并把 B 叫醒。

> Deliver a message into another DeepSeek Harness conversation and wake it up — via the `peer_list` / `peer_send` tools. Host-only plugin, same-process only.

```text
会话 A（用户只跟它说话）
  └─ peer_send(to: "报告会话", message: "把 xxx 做掉")
        └─ agents.get(sessionId).followup(userMessage)
              └─ 会话 B 收到一条 user 消息，开一个新回合
```

典型用法：并行会话之间派活/交接、让另一个会话去查证、任务完成后的跨会话回报。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `peer_list` | `query?` `scope?`(`workspace`/`all`) `limit?`（默认 30，最大 100） | 列出可投递的会话（id、标题、工作目录、是否已加载/正在运行），并标出哪个是当前会话。默认只看当前工作区 |
| `peer_send` | `to`（会话 id / id 前缀 / 标题）`message` `mode?`(`auto`/`steer`/`followup`) | 投递消息并唤醒对方；成功后返回目标会话、实际使用的模式、是否唤醒了它 |

`mode` 语义：

- `auto`（默认）：对方空闲 → `followup` 开新回合；对方正在跑 → `steer` 在下一个 step 插话。
- `steer`：强制插话（对方运行中才会有 stepper 边界）。
- `followup`：强制新回合；对方正在跑时退化为 `steer`，避免消息被吞。

限制：不能发给自己；单条正文上限 20000 字符；投递到未加载会话会先唤醒它。

## 安装

前置条件：

- DSH `>=0.2.2-rc.1 <0.3.0-0`（0.2.x，含预发布版；实测 `0.2.2-rc.1`，上界 `0.3.0-0` 用于挡住 0.3 预发布）
- Node.js `>=22`（与 DSH 内置运行时一致即可）
- 无 npm 运行时依赖，不需要构建步骤

安装方式（二选一，按你的 DSH 版本可用性选择）：

1. **用插件管理器安装本目录**：`plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径。这是 Host-only bundle 的常规安装方式。
2. **本地开发链接**：在 profile 的 `package.json` 的 `dependencies` 里加 `"dsh-peer-messaging": "link:/path/to/dsh-peer-message"`，在 `dsh.profile.bundles` 里加 `dsh-peer-messaging`，然后由插件管理器完成安装（不要手写 profile 的 patch 文件）。

安装后该 profile 下**所有会话**都会多出 `peer_list` / `peer_send` 两个工具，重启后仍然保留。

## 卸载

- 用插件管理器移除 / 禁用该 bundle（`remove_bundle`、或 `set_plugin` 置 `enabled: false`），或
- 从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中删除后重启 DSH。

卸载后两个工具消失，进程内不再注入消息。已投递的历史消息留在目标会话里，不会被撤回。

## 安全边界（请务必读）

`peer_send` 是一个**可被模型自主触发的副作用操作**，权限等价于"进程内跨会话写消息"：

1. **AI 可以自己决定调用它**。只要会话里运行着 agent，它就能在无人确认的情况下向同一 DSH 进程内任意会话投递消息。若你希望人工把关，需要在 DSH 的工具审批/权限策略里限制该工具。
2. **接收方收到的是"用户消息"**。目标会话会像收到你的输入一样处理它，消息同样以 user 角色进入上下文。因此被污染的会话可以借此把指令横向投递到别的会话——这是一条 **prompt injection 的横向移动路径**，`workspace` scope 只是列表过滤，**不是权限隔离**。
3. **唤醒会消耗额度**。投递到未加载的会话时，插件会通过宿主的 `sessionController.resolveAgent()` 唤醒它并开启新回合，可能触发模型调用和工具执行，消耗 token、在该会话自己的工作区里产生副作用。
4. **不跨进程、不跨机器、不联网**。仅作用于当前 DSH app 进程；不会发网络请求，也不会读写你的文件（只读取会话元数据：id、标题、工作目录、状态）。
5. **消息外观**：正文前面带 `【跨会话消息 · 来自 DSH 会话"标题"(id)】` 前缀，方便对方和你在记录里识别；界面仍按普通用户消息渲染，没有独立卡片或来源徽标。

建议：仅在受信任的单人环境启用；不要把 `peer_send` 暴露给你不能信任的提示来源（例如自动拉取的网页内容、外部消息通道）。

## 工作原理

插件在 Host 侧使用 DSH 进程内的既有服务：

1. `agents` 服务：`get(sessionId)` 取 agent 本体，`list()` 查在线状态；agent 提供 `status` 与 `followup()` / `steer()`。
2. 未加载的会话：`sessionController.resolveAgent(sessionId)` 唤醒（内部会带好模型选择与 preset，等价于在 Web UI 里打开会话）。
3. 会话列表：优先 `sessionQuery.listSessions()` + `readTitleSnapshots(ids)` 取标题，退化为 `sessions.list()`。
4. 构造一条进程内 user 消息 `{ id, role: 'user', content: [{type:'text',text}], source: { kind: 'plugin:peer-messaging', from } }`，按目标状态选择 `followup` / `steer`。

工具注册遵循 DSH 的 Host 插件形式：`export function apply(ctx, config)`，资源通过 `ctx.inject([...])` + `scoped.effect(...)` 注册，随插件作用域清理。

> 说明：DSH 0.2.x 自身也带有 `team-message` / `agent-message` 一类原生消息来源。本插件是独立的进程内实现，只读写 `agents` 服务，不接入官方团队通道，也不与它们共享状态；两者可以并存。

## 兼容性与依赖

- **无 npm 运行时依赖**，Host-only bundle：按 DSH 插件约定，这类包不需要声明 `dependencies` 或 `peerDependencies`。因此本包**刻意不声明** `@deepseek-ai/dsh-*` 的 peer（声明了也没用：这些包随 DSH 安装解析，不在 profile 的 node_modules 里）。
- **但依赖宿主内部约定**，不属于公开 API、没有稳定承诺：

  | 依赖项 | 用法 | 风险 |
  |---|---|---|
  | `agents` 服务 | `get` / `list`，agent 的 `status` / `followup` / `steer` | 方法名或状态值可能随版本变化 |
  | `sessionQuery` 服务 | `listSessions()`、`readTitleSnapshots(ids)` | 返回结构随版本变化时标题会退化为 null（有告警降级，不会崩） |
  | `sessions` 服务 | `list()` 作为列表兜底 | 同上 |
  | `sessionController` | `resolveAgent(sessionId)` 唤醒未加载会话 | 返回值 `{agent}` / `{error}` 形状若变化，唤醒会失败并明确报错 |
  | 进程内消息结构 | `UserMessage` + 自定义 `source.kind = 'plugin:peer-messaging'` | 该 source 类型不在 DSH 内置 `MessageSourceMap` 中；当前版本运行时不校验，属类型层面的越界用法，未来版本可能收紧 |

- `package.json` 的 `engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`（0.2.x，含预发布版；实测 `0.2.2-rc.1`）。DSH 升级到 0.3 或宿主行为有变时，请先跑 `test/harness.mjs` 回归，再调整这个范围。

## 已知限制

- **只在同一个 DSH app 进程内有效**：另一个 `dsh` 进程、另一个 app 实例拿不到对象，跨进程需要自行实现持久化 inbox。
- 会话索引是全局的（可能跨很多工作区），所以 `peer_list` 默认只列当前工作区、最多 30 条；跨工作区用 `scope: "all"`，找特定会话用 `query`。
- 按标题解析时，标题重复或包含匹配不唯一会直接报错并给出候选列表；不确定时请用会话 id 或 id 前缀。
- 投递是"尽力而为"：对方进程内状态异常时会返回错误，不会重试。

## 开发

```bash
node --check index.js      # 语法检查
node test/harness.mjs      # 离线单测：用假 ctx 加载插件，不碰真实会话
```

单测覆盖：列表/过滤/限额、按标题投递、运行中会话退化为 steer、未加载会话经 `resolveAgent` 唤醒、发给自己被拒、目标不存在时的候选列表、id 前缀解析、空正文校验。

目录结构：

```text
index.js            Host 插件入口（apply + peer_list / peer_send）
cordis.patch.yml    bundle patch：插入 id 为 peer-messaging 的 row
locale/{zh,en}.json 插件管理器的标题/描述
icon.svg            插件图标
test/harness.mjs    离线单测
```

## License

[MIT](./LICENSE) © 2026 respawnlife
