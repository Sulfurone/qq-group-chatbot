import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodeBuddy, isOfficialAuthURL, isFreeCredit, parseCLIOutput, safeCLIArgs } from '../lib/codebuddy.mjs';

function loginChild(url = 'https://copilot.tencent.com/ide/login?state=test-state') {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  const packets = [];
  child.push = packet => child.stdout.write(JSON.stringify(packet) + '\n');
  child.kill = () => { child.killed = true; child.emit('exit', null); };
  child.stdin = new Writable({ write(bytes, encoding, done) {
    for (const line of String(bytes).trim().split('\n')) {
      const p = JSON.parse(line); packets.push(p);
      if (p.method === 'initialize') queueMicrotask(() => child.push({ id: p.id, result: { authMethods: [{ id: 'internal', name: '微信登录' }] } }));
      if (p.method === 'authenticate') {
        child.authId = p.id;
        queueMicrotask(() => child.push({ method: '_codebuddy.ai/authUrl', params: { authUrl: url } }));
      }
    }
    done();
  } });
  return { child, packets };
}
test('官方授权链接只允许 HTTPS 官方域名，拦截伪造后缀与嵌入凭据', () => {
  assert.ok(isOfficialAuthURL('https://copilot.tencent.com/login'));
  assert.ok(isOfficialAuthURL('https://www.workbuddy.cn/login'));
  for (const url of ['javascript:alert(1)', 'http://copilot.tencent.com/login', 'https://copilot.tencent.com.evil.example', 'https://user:password@www.codebuddy.cn/login']) assert.equal(isOfficialAuthURL(url), false);
});
test('官方 CLI 授权可等待登录、去重、完成后仅持久化昵称而非令牌', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqa-auth-'));
  let spawned = 0; const mock = loginChild();
  const cli = await new CodeBuddy(dir, (command, args, options) => {
    spawned++; assert.ok(args.includes('--tools=')); assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--setting-sources='));
    assert.equal(options.shell, undefined); assert.equal(options.env.CODEBUDDY_CONFIG_DIR, path.join(dir, 'codebuddy-auth'));
    return mock.child;
  }).init();
  t.after(async () => { cli.close(); await rm(dir, { recursive: true, force: true }); });
  const result = await cli.authorize(); assert.equal(result.phase, 'pending'); assert.equal(result.authorized, false);
  assert.equal((await cli.authorize()).url, result.url); assert.equal(spawned, 1);
  mock.child.push({ id: mock.child.authId, result: { _meta: { 'codebuddy.ai/userinfo': { userName: '测试用户', accessToken: 'must-never-leak' } } } });
  await cli.authJob;
  assert.equal(cli.status().authorized, true); assert.equal(cli.status().nickname, '测试用户');
  assert.equal(cli.status().url, ''); assert.ok(!JSON.stringify(cli.status()).includes('must-never-leak'));
  const disk = await readFile(path.join(dir, 'cli-account.json'), 'utf8'); assert.ok(!disk.includes('must-never-leak'));
  assert.equal((await new CodeBuddy(dir).init()).status().authorized, true);
});
test('CLI 拒绝未知授权站点，且不把模型工具权限自动放行', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqa-auth-domain-'));
  const mock = loginChild('https://unknown.example/login');
  const cli = await new CodeBuddy(dir, () => mock.child).init();
  t.after(async () => { cli.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(cli.authorize(), /无法识别/);
  assert.equal(cli.status().authorized, false);
  const args = safeCLIArgs(); assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--no-session-persistence'));
});
test('仅免费模式严格区分零倍率与收费/未知倍率，绝不回退到默认收费模型', async () => {
  assert.equal(isFreeCredit('x0.00 credits'), true);
  for (const value of ['x0.05 credits', 'x0.29 credits', 'unknown', '', null, 'x0.00 credits then paid']) assert.equal(isFreeCredit(value), false);
  const cli = new CodeBuddy('unused', () => { throw new Error('不应启动模型进程'); }); cli.account = { nickname: '测试' };
  cli.models = async () => [{ id: 'paid', free: false }, { id: 'free', free: true }];
  await assert.rejects(cli.answer([], 'paid', true), /已阻止调用/);
  await assert.rejects(cli.answer([], 'missing', true), /已阻止调用/);
});
test('解析真实 CLI JSON 数组时只取助手回答，不回传用户上下文、思考和工具输出', () => {
  const output = JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private context' }] },
    { type: 'reasoning', summary: [{ text: 'private reasoning' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '连接成功' }] }], null, 2);
  assert.deepEqual(parseCLIOutput(output), { answer: '连接成功', credit: null });
  assert.equal(parseCLIOutput('{"type":"result","result":"兼容输出","usage":{"credit":0}}').answer, '兼容输出');
  assert.throws(() => parseCLIOutput('[{"role":"user","content":"不能当作回答"}]'));
});
