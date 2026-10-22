import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../lib/config.mjs';
import { parseQuestion, QABot } from '../lib/bot.mjs';

const event = (text = '什么是牛顿第一定律？', overrides = {}) => ({ post_type: 'message', message_type: 'group',
  self_id: 123456, group_id: 234567, user_id: 345678, message_id: 1,
  message: [{ type: 'at', data: { qq: '123456' } }, { type: 'text', data: { text } }], ...overrides });
const configured = () => ({ ...defaults(), enabled: true, groups: ['234567'], cooldownSeconds: 0 });
function fixture(provider = { answer: async () => '物体在不受外力时保持静止或匀速直线运动。' }) {
  const sent = []; const store = { value: configured() }; const calls = [];
  const bot = new QABot(store, { answer: async messages => { calls.push(messages); return provider.answer(messages); } }, async (action, params) => sent.push({ action, params }));
  return { bot, sent, store, calls };
}
test('只处理允许群里 @ 当前账号的群消息', () => {
  const c = configured(); assert.ok(parseQuestion(event(), c));
  for (const e of [event('', { message_type: 'private' }), event('', { group_id: 999999 }), event('', { user_id: 123456 }), event('', { post_type: 'notice' }), event('', { message: [{ type: 'text', data: { text: '@123456 你好' } }] }), event('', { message: '[CQ:at,qq=all]大家好' })]) assert.equal(parseQuestion(e, c), null);
  assert.equal(parseQuestion(event(), defaults()), null);
  assert.equal(parseQuestion(event(), { ...c, groups: [] }), null);
  assert.ok(parseQuestion(event('', { group_id: 999999 }), { ...c, allowAllGroups: true }));
});
test('CQ 字符串只识别真实 @ 段，不把编码后的文本当指令', () => {
  assert.equal(parseQuestion(event('', { message: '[CQ:at,qq=123456]你好&#91;测试&#93;' }), configured()).text, '你好[测试]');
  assert.equal(parseQuestion(event('', { message: '&#91;CQ:at,qq=123456&#93;你好' }), configured()), null);
});
test('消息去重、每人每群独立上下文、重置只清理自己的对话', async () => {
  const { bot, sent, calls } = fixture();
  await bot.handle(event()); await bot.handle(event()); assert.equal(calls.length, 1);
  await bot.handle(event('追问', { message_id: 2 })); assert.equal(calls[1].length, 4);
  await bot.handle(event('另一个人', { user_id: 456789, message_id: 3 })); assert.equal(calls[2].length, 2);
  await bot.handle(event('/重置', { message_id: 4 }));
  await bot.handle(event('重新提问', { message_id: 5 })); assert.equal(calls[3].length, 2);
  assert.equal(bot.history.size, 2); assert.equal(sent[0].action, 'send_group_msg');
  assert.equal(sent[0].params.message[0].data.qq, '345678');
});
test('开启限流后同一人短时间不会重复调用模型', async () => {
  const { bot, store, calls } = fixture(); store.value.cooldownSeconds = 30;
  await bot.handle(event()); await bot.handle(event('第二个问题', { message_id: 2 })); assert.equal(calls.length, 1);
});
test('停用或切换配置后，不发送旧请求生成的回答', async () => {
  let finish; const { bot, sent, store } = fixture({ answer: () => new Promise(resolve => { finish = resolve; }) });
  const running = bot.handle(event()); store.value.enabled = false; bot.clear(); finish('这条回答不应发送'); await running;
  assert.equal(sent.length, 0); assert.equal(bot.active, 0); assert.equal(bot.history.size, 0);
});
test('最多四个并行提问，不向群里泄露上游错误', async () => {
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  const { bot, calls, sent } = fixture({ answer: async () => { await waiting; throw new Error('SECRET_VALUE'); } });
  const tasks = Array.from({ length: 5 }, (_, i) => bot.handle(event('问题', { user_id: 456780 + i, message_id: i + 1 })));
  assert.equal(calls.length, 4); assert.equal(sent.length, 1); finish(); await Promise.all(tasks);
  assert.ok(!JSON.stringify(sent).includes('SECRET_VALUE')); assert.equal(bot.stats.failed, 4); assert.equal(bot.active, 0);
});
test('保存设置会保留空密钥框，显式清除会清掉授权', () => {
  const c = { ...configured(), apiKey: 'key', accessToken: 'token', refreshToken: 'refresh' };
  assert.equal(validateConfig({ apiKey: '' }, c).apiKey, 'key');
  const cleared = validateConfig({ clearSecrets: true }, c); assert.equal(cleared.apiKey, ''); assert.equal(cleared.accessToken, '');
  assert.throws(() => validateConfig({ apiBase: 'http://remote.example/v1' }, c));
  assert.throws(() => validateConfig({ groups: ['invalid'] }, c));
  assert.throws(() => validateConfig({ historyTurns: -1 }, c));
});
