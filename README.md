English | [简体中文](README.zh.md)

# dsh-peer-message

Cross-session message delivery for DSH (DeepSeek Harness): lets one conversation (A) deliver a message to another conversation (B) inside the same DSH process, and wake B up.

> Deliver a message into another DeepSeek Harness conversation and wake it up — via the `peer_list` / `peer_send` tools. Host-only plugin, same-process only.

```text
Conversation A (the one the user is talking to)
  └─ peer_send(to: "report session", message: "take care of xxx")
        └─ agents.get(sessionId).followup(userMessage)
              └─ Conversation B receives a user message and starts a new turn
```

Typical uses: delegating or handing off work between parallel conversations, having another conversation verify something, and reporting back across conversations when a task is done.

## Tools

| Tool | Parameters | Effect |
|---|---|---|
| `peer_list` | `query?` `scope?` (`workspace`/`all`) `limit?` (default 30, max 100) | Lists deliverable conversations (id, title, working directory, whether loaded/running) and marks which one is the current conversation. Defaults to the current workspace only |
| `peer_send` | `to` (session id / id prefix / title) `message` `mode?` (`auto`/`steer`/`followup`) | Delivers the message and wakes the target; on success returns the target conversation, the mode actually used, and whether it woke it |

`mode` semantics:

- `auto` (default): target idle → `followup` starts a new turn; target running → `steer` interjects at the next step.
- `steer`: force an interjection (a step boundary only exists while the target is running).
- `followup`: force a new turn; degrades to `steer` when the target is running, so the message is not swallowed.

Limits: cannot send to yourself; a single message body is capped at 20000 characters; delivering to an unloaded conversation wakes it first.

## Installation

Prerequisites:

- DSH `>=0.2.2-rc.1 <0.3.0-0` (the 0.2.x line, prereleases included; tested on `0.2.2-rc.1`; the `0.3.0-0` upper bound blocks 0.3 prereleases)
- Node.js `>=22` (whatever matches the runtime bundled with DSH is enough)
- No npm runtime dependencies, and no build step

Installation (choose either route, depending on what your DSH version supports):

1. **Install this directory with the plugin manager**: `plugin_manager`'s `install_bundle`, with `target` set to the absolute path of this directory. This is the normal installation route for a Host-only bundle.
2. **Link it for local development**: add `"dsh-peer-message": "link:/path/to/dsh-peer-message"` to `dependencies` in the profile's `package.json`, add `dsh-peer-message` to `dsh.profile.bundles`, then let the plugin manager complete the installation (do not hand-write the profile's patch file).

After installation, **every conversation** in that profile gains the two tools `peer_list` / `peer_send`, and they are kept across restarts.

## Uninstallation

- Remove / disable the bundle with the plugin manager (`remove_bundle`, or `set_plugin` with `enabled: false`), or
- remove it from the profile `package.json`'s `dependencies` and `dsh.profile.bundles`, then restart DSH.

After uninstallation the two tools disappear and no further messages are injected in-process. Messages already delivered stay in the target conversation and are not retracted.

## Security boundaries (please read)

`peer_send` is a **side-effecting operation the model can trigger on its own**; its power is equivalent to "writing a cross-session message in-process":

1. **The AI can decide to call it.** As long as an agent is running in a conversation, it can deliver a message to any conversation in the same DSH process without human confirmation. If you want human oversight, restrict this tool through DSH's tool-approval / permission policy.
2. **The receiver gets a "user message".** The target conversation processes it exactly like input from you; the message enters the context with the user role. A compromised conversation can therefore relay instructions laterally to other conversations — this is a **prompt-injection lateral-movement path**. The `workspace` scope is only a list filter, **not a permission boundary**.
3. **Waking consumes quota.** When the target conversation is not loaded, the plugin wakes it through the host's `sessionController.resolveAgent()` and starts a new turn, which can trigger model calls and tool execution, consume tokens, and cause side effects in that conversation's own workspace.
4. **No cross-process, no cross-machine, no network.** It only acts on the current DSH app process; it makes no network requests and does not read or write your files (it only reads conversation metadata: id, title, working directory, status).
5. **Message appearance.** The body is prefixed with `【跨会话消息 · 来自 DSH 会话"标题"(id)】` so the receiver and you can recognize it in the log; the UI still renders it as an ordinary user message, with no dedicated card or source badge.

Recommendation: enable it only in a trusted single-user environment; do not expose `peer_send` to prompt sources you cannot trust (for example auto-fetched web content or external message channels).

## How it works

On the Host side the plugin uses services that already exist inside the DSH process:

1. `agents` service: `get(sessionId)` returns the agent itself, `list()` reports live status; the agent provides `status` and `followup()` / `steer()`.
2. Unloaded conversations: `sessionController.resolveAgent(sessionId)` wakes them (an internal path that carries the model selection and preset, equivalent to opening the conversation in the Web UI).
3. Conversation list: prefers `sessionQuery.listSessions()` + `readTitleSnapshots(ids)` for titles, degrading to `sessions.list()`.
4. Builds an in-process user message `{ id, role: 'user', content: [{type:'text',text}], source: { kind: 'plugin:peer-messaging', from } }` and picks `followup` / `steer` according to the target's state.

Tool registration follows DSH's Host plugin form: `export function apply(ctx, config)`, with resources registered through `ctx.inject([...])` + `scoped.effect(...)` and cleaned up together with the plugin scope.

> Note: DSH 0.2.x itself ships native message sources such as `team-message` / `agent-message`. This plugin is an independent in-process implementation: it only reads and writes the `agents` service, does not join the official team channel, and shares no state with it; the two can coexist.

## Compatibility and dependencies

- **No npm runtime dependencies**, Host-only bundle: per DSH plugin conventions, such a package needs to declare neither `dependencies` nor `peerDependencies`. This package therefore **deliberately declares no** `@deepseek-ai/dsh-*` peers (declaring them would not help either: those packages resolve from the DSH installation, not from the profile's node_modules).
- **It does depend on host-internal conventions**, which are not public API and carry no stability promise:

  | Dependency | Usage | Risk |
  |---|---|---|
  | `agents` service | `get` / `list`, plus the agent's `status` / `followup` / `steer` | Method names or status values may change between versions |
  | `sessionQuery` service | `listSessions()`, `readTitleSnapshots(ids)` | If the return shape changes, titles degrade to null (warned, does not crash) |
  | `sessions` service | `list()` as the list fallback | Same as above |
  | `sessionController` | `resolveAgent(sessionId)` wakes unloaded conversations | If the `{agent}` / `{error}` shape changes, waking fails with an explicit error |
  | In-process message structure | `UserMessage` + custom `source.kind = 'plugin:peer-messaging'` | That source type is not among DSH's built-in `MessageSourceMap`; the current version does not validate it at runtime, so it is a type-level out-of-contract usage that a future version may tighten |

- `engines.dsh` in `package.json` is declared as `>=0.2.2-rc.1 <0.3.0-0` (the 0.2.x line, prereleases included; tested on `0.2.2-rc.1`). When DSH moves to 0.3 or host behavior changes, run `test/harness.mjs` for regression first, then adjust this range.

## Known limitations

- **Only works inside the same DSH app process**: another `dsh` process or another app instance cannot see the objects; cross-process delivery requires implementing a persistent inbox yourself.
- The conversation index is global (it may span many workspaces), so `peer_list` lists only the current workspace by default and at most 30 rows; use `scope: "all"` for other workspaces and `query` to find a specific conversation.
- Title-based resolution errors out with a candidate list when titles repeat or a contains-match is ambiguous; use the conversation id or id prefix when unsure.
- Delivery is best-effort: an abnormal in-process state on the target side returns an error and is not retried.

## Development

```bash
node --check index.js      # syntax check
node test/harness.mjs      # offline unit tests: load the plugin with a fake ctx, never touching real conversations
```

The unit tests cover: listing/filtering/limiting, delivery by title, degradation to steer for a running conversation, waking an unloaded conversation via `resolveAgent`, rejecting a self-send, the candidate list when the target does not exist, id-prefix resolution, and empty-body validation.

Directory layout:

```text
index.js             Host plugin entry (apply + peer_list / peer_send)
cordis.patch.yml     bundle patch: inserts the row with id peer-messaging
locale/{zh,en}.json  plugin-manager title / description
icon.svg             plugin icon
test/harness.mjs     offline unit tests
```

## License

[MIT](./LICENSE) © 2026 respawnlife
