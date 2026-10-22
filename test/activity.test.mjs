import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, defaultActivity, validateConfig, validateActivity } from '../lib/config.mjs';
import { ActivityScheduler, shanghaiTime, nextActivityAt } from '../lib/activity.mjs';

const at = value => Date.parse(`2026-10-21T${value}+08:00`);
async function fixture(t, override = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqa-activity-'));
  const state = { now: at('08:00:00'), conn: { connected: true, selfId: 123456 }, busy: false };
  const store = { value: { ...defaults(), enabled: true, allowAllGroups: true,
    activity: { ...defaultActivity(), enabled: true, groups: ['123456789'], useAI: false, ...override } } };
  const actions = []; const providers = { answer: async () => '来聊聊吧：最近有什么让你开心的小事？' };
  const options = { store, providers, dataDir: dir, clock: () => state.now, spacingMs: 0, connection: () => state.conn, busy: () => state.busy,
    action: async (action, params) => {
      actions.push({ action, params });
      if (action === 'get_group_list') return [{ group_id: 123456789 }, { group_id: 234567 }];
      return { message_id: 99 };
    } };
  const scheduler = await new ActivityScheduler(options).init();
  t.after(async () => { scheduler.close(); await rm(dir, { recursive: true, force: true }); });
  return { state, store, actions, scheduler, providers, options, sent: () => actions.filter(x => x.action === 'send_group_msg') };
}
test('时区固定为北京时间，跨日后正确计算下一次 09:00', () => {
  assert.deepEqual(shanghaiTime(Date.parse('2026-10-21T01:00:00Z')), { date: '2026-10-21', time: '09:00' });
  const config = { ...defaultActivity(), enabled: true, groups: ['123456789'] };
  assert.equal(nextActivityAt(config, at('21:00:01')), Date.parse('2026-10-22T09:00:00+08:00'));
  assert.equal(nextActivityAt(config, at('08:59:59')), at('09:00:00'));
});
test('定时群名单独验证，不继承所有群答疑，且不接受夜间时间', () => {
  const current = { ...defaults(), allowAllGroups: true };
  assert.throws(() => validateConfig({ activity: { enabled: true } }, current), /群号/);
  assert.throws(() => validateActivity({ times: ['23:00'] }), /时间/);
  assert.throws(() => validateActivity({ times: ['08:60'] }), /时间/);
  assert.throws(() => validateActivity({ times: [] }), /时间/);
  assert.throws(() => validateActivity({ quietMinutes: -1 }), /分钟/);
  const config = validateActivity({ enabled: true, groups: ['123456789'], times: ['12:00', '09:00', '09:00'] }, undefined, 123);
  assert.deepEqual(config.times, ['09:00', '12:00']); assert.equal(config.updatedAt, 123);
  assert.equal(validateActivity({ times: ['09:00', '12:00'] }, config, 456).updatedAt, 123);
});
test('同一时间只发一次，只发指定群，重启后仍不重发，也不 @ 任何人', async t => {
  const f = await fixture(t); f.state.now = at('09:00:10'); await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.sent().length, 1); assert.equal(f.sent()[0].params.group_id, 123456789);
  assert.deepEqual(f.sent()[0].params.message.map(x => x.type), ['text']);
  f.state.now = at('08:00:00'); const restarted = await new ActivityScheduler(f.options).init();
  f.state.now = at('09:00:40'); await restarted.tick(); restarted.close();
  assert.equal(f.sent().length, 1); assert.equal(f.scheduler.status().sent, 1);
});
test('群里刚有人聊天时跳过，之后的计划可正常发送', async t => {
  const f = await fixture(t); f.state.now = at('08:55:00');
  f.scheduler.observe({ post_type: 'message', message_type: 'group', group_id: 123456789, user_id: 888888, self_id: 123456 });
  f.state.now = at('09:00:10'); await f.scheduler.tick(); assert.equal(f.sent().length, 0); assert.equal(f.scheduler.status().last.status, 'skipped');
  f.state.now = at('12:00:10'); await f.scheduler.tick(); assert.equal(f.sent().length, 1);
});
test('断线错过的时间不补发，启动中途和重新启用也不追发', async t => {
  const f = await fixture(t); f.state.conn.connected = false; f.state.now = at('09:00:10'); await f.scheduler.tick();
  f.state.conn.connected = true; f.state.now = at('09:01:00'); await f.scheduler.tick(); assert.equal(f.sent().length, 0);
  f.scheduler.startedAt = at('12:00:05'); f.state.now = at('12:00:20'); await f.scheduler.tick(); assert.equal(f.sent().length, 0);
  f.scheduler.startedAt = at('08:00:00'); f.store.value.activity.updatedAt = at('15:00:02'); f.state.now = at('15:00:20'); await f.scheduler.tick(); assert.equal(f.sent().length, 0);
  f.state.now = at('18:00:20'); await f.scheduler.tick(); assert.equal(f.sent().length, 1);
});
test('暂停或修改设置会阻止正在生成的话题发送；并发 tick 不重复', async t => {
  const f = await fixture(t, { useAI: true }); let finish;
  f.providers.answer = () => new Promise(resolve => { finish = resolve; });
  f.state.now = at('09:00:10'); const run = f.scheduler.tick();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.scheduler.tick(); f.store.value.activity.enabled = false; f.scheduler.invalidate(); finish('这条不能发'); await run;
  assert.equal(f.sent().length, 0); assert.equal(f.scheduler.status().last.status, 'skipped');
});
test('生成期间群里开始聊天时跳过，模型不可用时使用本地话题', async t => {
  const f = await fixture(t, { useAI: true }); let finish;
  f.providers.answer = () => new Promise(resolve => { finish = resolve; });
  f.state.now = at('09:00:10'); const run = f.scheduler.tick();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.scheduler.observe({ post_type: 'message', message_type: 'group', group_id: 123456789, user_id: 888888, self_id: 123456 }); finish('话题'); await run;
  assert.equal(f.sent().length, 0);
  f.providers.answer = async () => { throw new Error('模型额度不可用'); };
  f.state.now = at('12:00:10'); await f.scheduler.tick();
  assert.equal(f.sent().length, 1); assert.equal(f.scheduler.status().last.source, '本地话题（模型不可用）');
});
test('发送回执失败不自动重发，避免群里出现两条相同消息', async t => {
  const f = await fixture(t); let sent = 0;
  f.scheduler.action = async action => { if (action === 'get_group_list') return [{ group_id: 123456789 }]; sent++; throw new Error('ack timeout'); };
  f.state.now = at('09:00:10'); await f.scheduler.tick(); f.state.now = at('09:00:35'); await f.scheduler.tick();
  assert.equal(sent, 1); assert.equal(f.scheduler.status().last.status, 'failed');
});
test('不向未加入的群发送；预览绝不调用 QQ 发信接口', async t => {
  const f = await fixture(t, { groups: ['99999999'] }); f.state.now = at('09:00:10'); await f.scheduler.tick();
  assert.equal(f.sent().length, 0); assert.equal(f.scheduler.status().last.reason, '当前 QQ 未加入此群');
  const count = f.actions.length; const preview = await f.scheduler.preview(); assert.ok(preview.text); assert.equal(f.actions.length, count);
});
test('答疑忙碌时跳过；生成期间切换 QQ 账号也不会误发', async t => {
  const f = await fixture(t, { useAI: true }); f.state.busy = true; f.state.now = at('09:00:10'); await f.scheduler.tick();
  assert.equal(f.sent().length, 0); assert.equal(f.scheduler.status().last.reason, '机器人正在答疑');
  f.state.busy = false; let finish; f.providers.answer = () => new Promise(resolve => { finish = resolve; }); f.state.now = at('12:00:10');
  const run = f.scheduler.tick(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.state.conn.selfId = 999999; finish('不能发给新账号'); await run; assert.equal(f.sent().length, 0);
});
test('发送记录损坏时拒绝忽略记录，防止重复发送', async t => {
  const f = await fixture(t); await writeFile(path.join(f.options.dataDir, 'activity-ledger.json'), 'broken');
  await assert.rejects(new ActivityScheduler(f.options).init(), /记录损坏/); assert.equal(f.sent().length, 0);
});
