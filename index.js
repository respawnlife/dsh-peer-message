// dsh-peer-messaging Host 一半：让一个 DSH 会话给另一个会话投递消息并叫醒它。
//
// 原理：DSH 进程内有一个 agents 服务（同一 app 实例共享）。按会话 id 拿到 agent
// 本体后调 followup()（空闲会话 → 开新回合）或 steer()（运行中 → 下一 step 插话），
// 消息在对方会话里表现为一条 user 消息。未加载的会话先经 sessionController
// .resolveAgent() 唤醒（内部会带好模型选择和 preset，和 Web UI 打开会话一样）。
//
// 边界：只在同一个 DSH app 进程内有效；另一个 dsh 进程 / 另一个 app 实例拿不到。
// 兼容性：依赖宿主内部服务契约（agents / sessions / sessionQuery / sessionController）
// 以及进程内消息结构，这些不属于 DSH 公开插件 API；package.json 的 engines.dsh
// 声明了实测通过的版本范围，宿主升级后需要重新验证。
import crypto from 'node:crypto';

export const name = 'dsh-peer-messaging';

const LIST_TOOL = 'peer_list';
const SEND_TOOL = 'peer_send';
const SOURCE_KIND = 'plugin:peer-messaging';
const MAX_TEXT = 20000;
const LIST_LIMIT = 50;

const asId = (value) => (typeof value === 'string' ? value.trim() : '');

/** 消息 source 里的时区标注：取宿主进程时区，不写死某一台机器的时区。 */
function hostTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** 从工具执行上下文里取当前会话 id；不同版本字段位置不同，逐个兜底。 */
function callerSessionId(exec) {
  const candidates = [
    exec?.agent?.session?.id,
    exec?.agent?.session?.sessionId,
    exec?.session?.id,
    exec?.agentId,
    exec?.sessionId,
  ];
  for (const candidate of candidates) {
    const id = asId(candidate);
    if (id !== '') return id;
  }
  return '';
}

export function apply(ctx, config = {}) {
  const log = {
    info: (...args) => console.log('[peer-messaging]', ...args),
    warn: (...args) => console.warn('[peer-messaging]', ...args),
  };

  const getService = (serviceName) => {
    try {
      return ctx.get(serviceName);
    } catch {
      return undefined;
    }
  };

  // 用 scoped context 注入 agents：服务归属本插件作用域，插件卸载时随作用域一起清理。
  let agents = null;
  ctx.inject(['agents'], (scoped) => {
    agents = scoped.agents;
  });

  /** agents.list() → Map<sessionId, { live, status }>。 */
  function liveStatuses() {
    const map = new Map();
    try {
      for (const entry of agents?.list?.() ?? []) {
        const id = asId(entry?.session?.id ?? entry?.id);
        if (id === '') continue;
        map.set(id, { live: true, status: typeof entry?.status === 'string' ? entry.status : null });
      }
    } catch (error) {
      log.warn('读取 agents.list() 失败：', error?.message ?? error);
    }
    return map;
  }

  /**
   * 列出所有会话（含未打开的）。优先用 sessionQuery —— 它是宿主对所有会话的索引，
   * 还能批量读标题；没有就退化成 sessions.list() + agents.list()。
   */
  async function listSessions() {
    const statuses = liveStatuses();
    const rows = [];
    const seen = new Set();

    const add = (id, extra = {}) => {
      const cleanId = asId(id);
      if (cleanId === '' || seen.has(cleanId)) return;
      seen.add(cleanId);
      const live = statuses.get(cleanId);
      rows.push({
        session_id: cleanId,
        title: extra.title ?? null,
        cwd: extra.cwd ?? null,
        createdAt: typeof extra.createdAt === 'number' ? extra.createdAt : 0,
        live: live !== undefined,
        status: live?.status ?? (live ? 'idle' : 'not-loaded'),
      });
    };

    const query = getService('sessionQuery');
    if (query !== undefined && typeof query?.listSessions === 'function') {
      try {
        const records = (await query.listSessions()) ?? [];
        const ids = records.map((record) => String(record?.header?.id ?? ''));
        let snapshots = [];
        try {
          snapshots = (await query.readTitleSnapshots?.(ids)) ?? [];
        } catch (error) {
          log.warn('读取会话标题失败：', error?.message ?? error);
        }
        records.forEach((record, index) => {
          const snapshot = snapshots[index];
          const title = snapshot?.status === 'fulfilled' ? snapshot?.value?.title?.title : undefined;
          add(record?.header?.id, {
            title: typeof title === 'string' && title !== '' ? title : null,
            cwd: record?.header?.cwd ?? null,
            createdAt: record?.header?.createdAt ?? record?.createdAt ?? 0,
          });
        });
      } catch (error) {
        log.warn('sessionQuery.listSessions() 失败：', error?.message ?? error);
      }
    }

    // 兜底 / 补充：已在内存里的会话一定可投递。
    if (rows.length === 0) {
      try {
        for (const session of getService('sessions')?.list?.() ?? []) {
          add(session?.id, { cwd: session?.header?.cwd ?? null });
        }
      } catch (error) {
        log.warn('读取 sessions.list() 失败：', error?.message ?? error);
      }
    }
    for (const id of statuses.keys()) add(id);

    return rows;
  }

  /** 排序 + 过滤：正在运行的排最前，其余按创建时间倒序；可按 query 过滤、按 cwd 限定工作区。 */
  function selectSessions(rows, { query, scope, callerCwd } = {}) {
    const needle = asId(query).toLowerCase();
    let out = rows;
    if (scope === 'workspace' && typeof callerCwd === 'string' && callerCwd !== '') {
      out = out.filter((row) => row.cwd === callerCwd);
    }
    if (needle !== '') {
      out = out.filter(
        (row) =>
          row.session_id.toLowerCase().includes(needle)
          || (row.title ?? '').toLowerCase().includes(needle)
          || (row.cwd ?? '').toLowerCase().includes(needle),
      );
    }
    return out.sort((a, b) => {
      const weight = (row) => (row.status === 'running' ? 2 : row.live ? 1 : 0);
      const diff = weight(b) - weight(a);
      if (diff !== 0) return diff;
      return b.createdAt - a.createdAt;
    });
  }

  /** 目标解析：会话 id → 标题精确 → id 前缀 → 标题包含；都不唯一就报错。 */
  async function resolveTarget(raw) {
    const wanted = asId(raw);
    if (wanted === '') throw new Error('缺少目标会话：请传会话 id 或标题');

    const rows = await listSessions();
    const byId = rows.find((row) => row.session_id === wanted);
    if (byId) return byId;

    const lower = wanted.toLowerCase();
    const byTitle = rows.filter((row) => (row.title ?? '').toLowerCase() === lower);
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) {
      throw new Error(`标题「${wanted}」对应多个会话：${byTitle.map((row) => row.session_id).join(', ')}`);
    }

    const byIdPrefix = rows.filter((row) => row.session_id.startsWith(wanted));
    if (byIdPrefix.length === 1) return byIdPrefix[0];
    if (byIdPrefix.length > 1) {
      throw new Error(`id 前缀「${wanted}」不唯一：${byIdPrefix.map((row) => row.session_id).join(', ')}`);
    }

    const byTitlePart = rows.filter((row) => (row.title ?? '').toLowerCase().includes(lower));
    if (byTitlePart.length === 1) return byTitlePart[0];

    const hint = rows
      .slice(0, LIST_LIMIT)
      .map((row) => (row.title === null ? row.session_id : `${row.session_id}「${row.title}」`))
      .join(', ');
    throw new Error(`找不到会话「${wanted}」。可用：${hint}`);
  }

  /** 拿到 agent 本体；未加载的会话用 sessionController 唤醒（带模型选择和 preset）。 */
  async function ensureAgent(sessionId) {
    const live = agents?.get?.(sessionId);
    if (live !== undefined && live !== null) return { agent: live, woke: false };

    const controller = getService('sessionController');
    if (typeof controller?.resolveAgent !== 'function') return { agent: undefined, woke: false };
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved === undefined || resolved === null) return { agent: undefined, woke: false };
    if ('error' in resolved) {
      return { agent: undefined, woke: false, error: `唤醒会话失败：${String(resolved.error).slice(0, 200)}` };
    }
    const agent = 'agent' in resolved ? resolved.agent : undefined;
    return { agent, woke: agent !== undefined };
  }

  function headerText(from) {
    const title = from?.title ? `「${from.title}」` : '';
    const id = from?.session_id ? ` (${from.session_id})` : '';
    const who = from?.session_id ? `${title}${id}` : '';
    return who === '' ? '【跨会话消息 · 来自另一个 DSH 会话】' : `【跨会话消息 · 来自 DSH 会话${who}】`;
  }

  async function deliver({ sessionId, body, mode, from }) {
    const { agent, woke, error } = await ensureAgent(sessionId);
    if (agent === undefined) {
      return { ok: false, error: error ?? `会话 ${sessionId} 不可用（未加载且无法唤醒）` };
    }

    const rows = await listSessions();
    const target = rows.find((row) => row.session_id === sessionId);
    const fromTitle = from?.session_id === undefined || from?.session_id === ''
      ? undefined
      : rows.find((row) => row.session_id === from.session_id)?.title;
    const enrichedFrom = from?.session_id === undefined || from?.session_id === ''
      ? undefined
      : { session_id: from.session_id, title: fromTitle ?? undefined };

    const timeZone = hostTimeZone();
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `${headerText(enrichedFrom)}\n\n${body}` }],
      source: { kind: SOURCE_KIND, from: enrichedFrom ?? null, ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }) },
    };

    const running = agent.status === 'running';
    let used;
    if (mode === 'steer') {
      agent.steer(message);
      used = 'steer';
    } else if (mode === 'followup') {
      // 运行中的 driver 必须被 steer 进最近的 step，否则新回合会和当前回合打架。
      if (running) {
        agent.steer(message);
        used = 'steer';
      } else {
        agent.followup(message);
        used = 'followup';
      }
    } else if (running) {
      agent.steer(message);
      used = 'steer';
    } else {
      agent.followup(message);
      used = 'followup';
    }

    log.info(`投递 → ${sessionId}${target?.title ? `「${target.title}」` : ''}（${used}${woke ? '，已唤醒' : ''}，来自 ${from?.session_id ?? '未知'}）`);
    return {
      ok: true,
      session_id: sessionId,
      title: target?.title ?? null,
      mode: used,
      woke,
      was_running: running,
    };
  }

  // ---------------- Agent 工具 ----------------
  ctx.inject(['tools'], (scoped) => {
    try {
      scoped.effect(
        () =>
          scoped.tools.register({
            name: LIST_TOOL,
            description:
              '列出当前 DSH 里可以投递消息的会话（会话 id、标题、工作目录、是否已加载/正在运行），并标出哪个是当前会话。给 peer_send 找目标用。',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '可选：按会话 id / 标题 / 工作目录子串过滤' },
                scope: {
                  type: 'string',
                  enum: ['workspace', 'all'],
                  description: 'workspace=只看当前会话所在工作区（默认）；all=所有工作区',
                },
                limit: { type: 'number', description: '可选：最多返回几条，默认 30，最大 100' },
              },
              additionalProperties: false,
            },
            output: {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  self: { type: 'string' },
                  scope: { type: 'string' },
                  cwd: { type: 'string' },
                  total: { type: 'number' },
                  shown: { type: 'number' },
                  sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  error: { type: 'string' },
                },
                additionalProperties: true,
              },
              render(args, value) {
                if (value?.ok !== true) return [{ type: 'text', text: `读取会话列表失败：${value?.error ?? '未知错误'}` }];
                const rows = Array.isArray(value.sessions) ? value.sessions : [];
                const lines = rows.map((row) => {
                  const self = row.session_id === value.self ? ' ← 你自己' : '';
                  const title = row.title ? `「${row.title}」` : '';
                  return `- ${row.session_id}${title} ${row.status}${self}`;
                });
                const scopeLabel = value.scope === 'workspace' ? '当前工作区' : '全部工作区';
                const more = value.total > rows.length ? `，显示前 ${rows.length} 条（可加 query / limit / scope:"all"）` : '';
                return [
                  { type: 'text', text: [`${scopeLabel}共 ${value.total} 个会话${more}：`, ...lines].join('\n') },
                ];
              },
            },
            timeoutMs: 20_000,
            async execute(args, exec) {
              try {
                const self = callerSessionId(exec);
                const rows = await listSessions();
                const scope = args?.scope === 'all' ? 'all' : 'workspace';
                const callerCwd = scope === 'workspace'
                  ? (agents?.get?.(self)?.session?.header?.cwd ?? rows.find((row) => row.session_id === self)?.cwd)
                  : undefined;
                const requested = Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 30;
                const limit = Math.min(Math.max(requested, 1), 100);
                const filtered = selectSessions(rows, { query: args?.query, scope, callerCwd });
                return {
                  ok: true,
                  self,
                  scope,
                  cwd: callerCwd ?? null,
                  total: filtered.length,
                  shown: Math.min(filtered.length, limit),
                  sessions: filtered.slice(0, limit),
                };
              } catch (error) {
                return { ok: false, error: error?.message ?? String(error) };
              }
            },
          }),
        'peer-messaging: peer_list tool',
      );
    } catch (error) {
      log.warn('注册 peer_list 工具失败：', error?.message ?? error);
    }

    try {
      scoped.effect(
        () =>
          scoped.tools.register({
            name: SEND_TOOL,
            description:
              '把一条消息投递给另一个 DSH 会话，并把它叫醒（跨会话通知 / 任务交接）。当用户只跟你说话、让你去通知或安排另一个会话时使用。投递后对方会像收到用户消息一样开一个新回合。',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string', description: '目标会话：会话 id、id 前缀或标题（先用 peer_list 查）' },
                message: { type: 'string', description: '要投递的正文。写成你希望对方直接看到并照着做的内容，不要写"请转达给…"' },
                mode: {
                  type: 'string',
                  enum: ['auto', 'steer', 'followup'],
                  description: 'auto=对方忙就插话、空闲就开新回合（默认）；steer=插话；followup=尽量开新回合',
                },
              },
              required: ['to', 'message'],
              additionalProperties: false,
            },
            output: {
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  session_id: { type: 'string' },
                  title: { type: 'string' },
                  mode: { type: 'string' },
                  woke: { type: 'boolean' },
                  error: { type: 'string' },
                },
                additionalProperties: true,
              },
              render(args, value) {
                if (value?.ok !== true) return [{ type: 'text', text: `跨会话投递失败：${value?.error ?? '未知错误'}` }];
                const title = value.title ? `「${value.title}」` : '';
                const woke = value.woke ? '，已唤醒' : '';
                return [{ type: 'text', text: `已投递到 ${value.session_id}${title}（${value.mode}${woke}）` }];
              },
            },
            timeoutMs: 30_000,
            async execute(args, exec) {
              const body = typeof args?.message === 'string' ? args.message.trim() : '';
              if (body === '') return { ok: false, error: 'message 不能为空' };
              if (body.length > MAX_TEXT) return { ok: false, error: `message 太长（>${MAX_TEXT} 字符），请拆成几条` };
              const mode = args?.mode === 'steer' || args?.mode === 'followup' ? args.mode : 'auto';
              const selfId = callerSessionId(exec);
              try {
                const target = await resolveTarget(args?.to);
                if (selfId !== '' && target.session_id === selfId) {
                  return { ok: false, error: '不能发给自己：目标会话就是当前会话' };
                }
                return await deliver({
                  sessionId: target.session_id,
                  body,
                  mode,
                  from: { session_id: selfId },
                });
              } catch (error) {
                return { ok: false, error: error?.message ?? String(error) };
              }
            },
          }),
        'peer-messaging: peer_send tool',
      );
    } catch (error) {
      log.warn('注册 peer_send 工具失败：', error?.message ?? error);
    }
  });
}
