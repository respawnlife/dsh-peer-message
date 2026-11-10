// 离线单测：用假 ctx 加载 Host 插件，验证 peer_list / peer_send 的行为。
// 运行：node test/harness.mjs
import assert from 'node:assert/strict';
import { apply } from '../index.js';

const titles = {
  'session-aaa': 'Test',
  'session-bbb': '插件开发',
  'session-ccc': '另一个会话',
  'session-ddd': '别的工作区会话',
};

const sessions = [
  { id: 'session-aaa', header: { cwd: '/w' } },
  { id: 'session-bbb', header: { cwd: '/w' } },
  { id: 'session-ccc', header: { cwd: '/w' } },
  { id: 'session-ddd', header: { cwd: '/other' } },
];

// 已加载的 agent：aaa 空闲，bbb 正在跑；ccc 未加载（走 resolveAgent）
const sent = [];
function fakeAgent(id, status) {
  const record = (kind) => (message) => sent.push({ id, kind, message });
  return { id, status, followup: record('followup'), steer: record('steer') };
}
const live = new Map([
  ['session-aaa', fakeAgent('session-aaa', 'idle')],
  ['session-bbb', fakeAgent('session-bbb', 'running')],
]);
const resolved = [];
const services = {
  agents: {
    get: (id) => live.get(id),
    list: () => [...live.values()].map((agent) => ({ id: agent.id, status: agent.status })),
  },
  sessions: { list: () => sessions },
  sessionQuery: {
    listSessions: async () => sessions.map((row) => ({ header: { id: row.id, cwd: row.header.cwd, createdAt: 0 } })),
    readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { title: { title: titles[id] } } })),
  },
  sessionTitle: { get: (id) => titles[id] },
  sessionController: {
    resolveAgent: async (id) => {
      resolved.push(id);
      const agent = fakeAgent('session-ccc', 'idle');
      live.set(id, agent);
      return { agent };
    },
  },
};

const tools = new Map();
const ctx = {
  get: (name) => services[name],
  inject: (deps, callback) => {
    callback({
      ...services,
      get: (name) => services[name],
      effect: (fn) => fn(),
      tools: { register: (definition) => { tools.set(definition.name, definition); } },
    });
  },
};

apply(ctx, {});

const call = async (toolName, args, exec = { agent: { session: { id: 'session-zzz' } } }) => {
  const tool = tools.get(toolName);
  assert.ok(tool, `工具 ${toolName} 没注册上`);
  return tool.execute(args, exec);
};

// 1) peer_list：默认只看当前工作区（/w），标出自己
const listResult = await call('peer_list', {}, { agent: { session: { id: 'session-aaa' } } });
assert.equal(listResult.ok, true);
assert.equal(listResult.self, 'session-aaa');
assert.equal(listResult.sessions.length, 3);
assert.equal(listResult.total, 3);
assert.equal(listResult.sessions.find((row) => row.session_id === 'session-aaa').title, 'Test');
assert.equal(listResult.sessions.every((row) => typeof row.title === 'string' && row.title !== ''), true);
assert.equal(listResult.sessions.find((row) => row.session_id === 'session-bbb').status, 'running');
console.log('✓ peer_list', listResult.sessions.map((row) => `${row.session_id}/${row.status}`).join(', '));

// 1b) 过滤：scope=all / query / limit
const allResult = await call('peer_list', { scope: 'all' }, { agent: { session: { id: 'session-aaa' } } });
assert.equal(allResult.total, 4);
const queryResult = await call('peer_list', { scope: 'all', query: '别的工作区' });
assert.equal(queryResult.sessions.length, 1);
assert.equal(queryResult.sessions[0].session_id, 'session-ddd');
const limitResult = await call('peer_list', { limit: 2 }, { agent: { session: { id: 'session-aaa' } } });
assert.equal(limitResult.shown, 2);
assert.equal(limitResult.sessions.length, 2);
assert.equal(limitResult.total, 3);
console.log('✓ peer_list 过滤/限额');

// 2) 按标题投递到空闲会话 → followup
let result = await call('peer_send', { to: 'Test', message: '把报告发出来' });
assert.equal(result.ok, true);
assert.equal(result.session_id, 'session-aaa');
assert.equal(result.mode, 'followup');
let last = sent.at(-1);
assert.equal(last.kind, 'followup');
assert.match(last.message.content[0].text, /【跨会话消息 · 来自 DSH 会话/);
assert.equal(last.message.source.kind, 'plugin:peer-messaging');
assert.equal(last.message.source.from.session_id, 'session-zzz');
console.log('✓ peer_send 按标题 → followup');

// 3) 投递到运行中的会话 → auto 退化为 steer
result = await call('peer_send', { to: 'session-bbb', message: '先别继续，改一下方向' });
assert.equal(result.mode, 'steer');
assert.equal(sent.at(-1).kind, 'steer');
console.log('✓ peer_send 运行中 → steer');

// 4) 投递到未加载会话 → resolveAgent 唤醒后再 followup
result = await call('peer_send', { to: 'session-ccc', message: '帮我查下日志' });
assert.equal(result.ok, true);
assert.deepEqual(resolved, ['session-ccc']);
assert.equal(sent.at(-1).id, 'session-ccc');
console.log('✓ peer_send 未加载 → resolveAgent → followup');

// 5) 发给自己 → 拒绝（目标会话就是调用方）
result = await call('peer_send', { to: 'Test', message: 'hi' }, { agent: { session: { id: 'session-aaa' } } });
assert.equal(result.ok, false);
assert.match(result.error, /不能发给自己/);
console.log('✓ 发给自己被拒绝');

// 6) 找不到目标 → 报错并给出可用列表
result = await call('peer_send', { to: '不存在的会话', message: 'hi' });
assert.equal(result.ok, false);
assert.match(result.error, /找不到会话/);
assert.match(result.error, /session-aaa/);
console.log('✓ 目标不存在时给出候选列表');

// 7) id 前缀唯一时可用
result = await call('peer_send', { to: 'session-aa', message: '前缀投递' });
assert.equal(result.session_id, 'session-aaa');
console.log('✓ id 前缀解析');

// 8) 空正文拒绝
result = await call('peer_send', { to: 'Test', message: '   ' });
assert.equal(result.ok, false);
console.log('✓ 空正文被拒绝');

console.log('\n全部通过');
