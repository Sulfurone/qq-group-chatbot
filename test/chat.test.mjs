import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../lib/config.mjs';
import { AutoChat } from '../lib/chat.mjs';

const event = (text, overrides = {}) => ({ post_type: 'message', message_type: 'group', self_id: 123456,
  group_id: 123456789, user_id: 234567, message_id: text, sender: { nickname: '小明' },
  message: [{ type: 'text', data: { text } }], ...overrides });
function fixture(answer = async () => '那就一起聊聊吧！') {
  let time = 1000000, next = 0;
  const timers = new Map(), calls = [], sent = [], logs = [];
  const store = { value: { ...defaults(), enabled: true, autoChat: { ...defaults().autoChat, enabled: true, groups: ['123456789', '234567'] } } };
  const bot = { active: 0, stats: { answered: 0, failed: 0 } };
  const chat = new AutoChat({ store, bot, providers: { answer: async messages => { calls.push(messages); return answer(messages); } },
    send: async (action, params) => { sent.push({ action, params }); chat.recordBot(action, params); },
    now: () => time, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: id => timers.delete(id), log: (level, message) => logs.push({ level, message }) });
  return { chat, store, bot, timers, calls, sent, logs, tick: async ms => {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    // 定时回调包含模型和发送回执的异步链。
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('无需 @：只监听启用群，合并连续消息、去重，并带上本群近期上下文', async () => {
  const f = fixture();
  f.chat.observe(event('今天有点累')); f.chat.observe(event('今天有点累'));
  await f.tick(2000); f.chat.observe(event('下班想放松一下', { user_id: 345678, sender: { card: '小红' } }));
  assert.equal(f.timers.size, 1); await f.tick(3999); assert.equal(f.calls.length, 0);
  await f.tick(1); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1);
  const context = f.calls[0][1].content;
  assert.match(context, /今天有点累/); assert.match(context, /下班想放松/); assert.match(context, /小红/);
  assert.equal(f.sent[0].params.message.length, 1); assert.equal(f.sent[0].params.message[0].type, 'text');
  assert.equal(f.chat.stats.received, 2); assert.equal(f.chat.groups.get('123456789').messages.at(-1).bot, true);
  f.chat.clear();
});

test('自动聊天不会越群、响应自己、私聊、附件、指令或群内 @ 其他人', async () => {
  const f = fixture();
  for (const overrides of [{ group_id: 999999 }, { user_id: 123456 }, { message_type: 'private' },
    { message: [{ type: 'image', data: { file: 'image' } }] },
    { message: [{ type: 'at', data: { qq: '345678' } }, { type: 'text', data: { text: '找你' } }] }]) f.chat.observe(event('不该回复', overrides));
  f.chat.observe(event('/指令'));
  await f.tick(100000); assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
  f.store.value.autoChat.enabled = false; f.chat.observe(event('停用后')); await f.tick(10000); assert.equal(f.calls.length, 0);
  f.chat.clear();
});

test('各群上下文隔离，冷却内消息合并成一次；机器人回复包含在后续上下文中', async () => {
  const f = fixture(); f.chat.observe(event('甲群消息')); await f.tick(4000);
  f.chat.observe(event('乙群消息', { group_id: 234567 })); await f.tick(4000);
  assert.ok(!f.calls[1][1].content.includes('甲群消息'));
  f.chat.observe(event('甲群追问1')); f.chat.observe(event('甲群追问2'));
  await f.tick(85999); assert.equal(f.calls.length, 2);
  await f.tick(1); assert.equal(f.calls.length, 3);
  assert.match(f.calls[2][1].content, /甲群追问1/); assert.match(f.calls[2][1].content, /甲群追问2/);
  assert.match(f.calls[2][1].content, /那就一起聊聊吧/); assert.ok(!f.calls[2][1].content.includes('乙群消息'));
  f.chat.clear();
});

test('@ 机器人撤销待发与生成中的接话，不产生双重回复', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.chat.observe(event('普通聊天'));
  const mention = event('直接提问', { message: '[CQ:at,qq=123456]直接提问' });
  f.chat.observe(mention); await f.tick(4000); assert.equal(f.calls.length, 0);
  f.chat.observe(event('另一个话题')); await f.tick(4000); assert.equal(f.calls.length, 1);
  f.chat.observe(event('直接提问2', { message: '[CQ:at,qq=123456]直接提问2' }));
  finish('过期回答'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0); assert.equal(f.bot.active, 0); f.chat.clear();
});

test('配置清理会撤销定时器和旧模型结果；生成期间的新消息继续合并等待', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.chat.observe(event('问题1')); await f.tick(4000); assert.equal(f.bot.active, 1);
  f.chat.observe(event('问题2')); assert.equal(f.timers.size, 0);
  finish('问题1的回答'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 1);
  f.chat.clear(); assert.equal(f.timers.size, 0);
  f.chat.observe(event('问题3')); await f.tick(4000);
  f.chat.clear(); finish('不能发送'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1); assert.equal(f.bot.active, 0);
});

test('答疑忙时延后自动聊天；失败不向群发报错，不泄露聊天正文到日志', async () => {
  const f = fixture(async () => { throw new Error('模型不可用'); });
  f.bot.active = 1; f.chat.observe(event('私密聊天内容')); await f.tick(4000); assert.equal(f.calls.length, 0);
  f.bot.active = 0; await f.tick(3000); assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.chat.stats.failed, 1); assert.ok(!JSON.stringify(f.logs).includes('私密聊天内容')); f.chat.clear();
});

test('内存过期、上下文限量，拒绝缺少群名单或非法频率的自动聊天配置', async () => {
  const f = fixture(); f.store.value.autoChat.contextMessages = 5;
  for (let i = 0; i < 10; i++) f.chat.observe(event('消息' + i));
  assert.equal(f.chat.groups.get('123456789').messages.length, 5);
  f.chat.clear(); f.chat.observe(event('/仅记录')); await f.tick(30 * 60000 + 1); f.chat.sweep(); assert.equal(f.chat.groups.size, 0);
  assert.throws(() => validateConfig({ autoChat: { enabled: true } }, defaults()));
  assert.throws(() => validateConfig({ autoChat: { cooldownSeconds: 0 } }, defaults()));
  assert.throws(() => validateConfig({ autoChat: { groups: ['all'] } }, defaults()));
  assert.throws(() => validateConfig({ displayName: '' }, defaults()));
  assert.equal(validateConfig({ activity: { enabled: false } }, f.store.value).autoChat.enabled, true);
  f.chat.clear();
});
