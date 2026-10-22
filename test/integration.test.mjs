import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { ACPClient, readSSE, Providers } from '../lib/providers.mjs';

test('真实 HTTP + WebSocket 链路：鉴权、@ 问答、无需 @ 自动聊天、发送回执与去重', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqa-integration-'));
  const calls = [];
  const app = await startServer({ port: 0, dataDir: dir, fetcher: async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: '测试链路回答成功。' } }] });
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const home = await fetch(base); const cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Local-Request': '1', origin: base };
  assert.equal((await fetch(base + '/api/config', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  let res = await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify({ enabled: true, groups: ['234567'], provider: 'openai', apiBase: 'http://127.0.0.1:9999/v1', apiKey: 'test-secret', model: 'test-model' }) });
  assert.equal(res.status, 200); assert.ok(!(await res.text()).includes('test-secret'));
  const config = await (await fetch(base + '/api/napcat', { headers: { cookie } })).json();
  const bad = new WebSocket(`ws://127.0.0.1:${app.port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer wrong' } });
  const error = await new Promise(resolve => bad.on('error', resolve)); assert.match(error.message, /403/);
  const ws = new WebSocket(config.wsURL, { headers: { Authorization: `Bearer ${config.token}`, 'X-Client-Role': 'Universal' } });
  const sent = []; let answerReady;
  const answer = new Promise(resolve => { answerReady = resolve; });
  ws.on('message', bytes => {
    const packet = JSON.parse(bytes.toString());
    if (packet.action === 'get_login_info') ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: { user_id: 123456, nickname: '测试机器人' } }));
    if (packet.action === 'send_group_msg') { sent.push(packet.params); ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: packet.echo, data: { message_id: 100 } })); answerReady(); }
  });
  await once(ws, 'open');
  const event = { post_type: 'message', message_type: 'group', group_id: 234567, user_id: 345678, self_id: 123456, message_id: 1,
    message: [{ type: 'at', data: { qq: '123456' } }, { type: 'text', data: { text: '你好' } }] };
  ws.send(JSON.stringify(event)); ws.send(JSON.stringify(event));
  await Promise.race([answer, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('答疑超时')), 3000); timeout.unref(); })]);
  assert.equal(sent.length, 1); assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:9999/v1/chat/completions');
  assert.equal(sent[0].message[1].data.text, '\n测试链路回答成功。');
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
  assert.equal(state.connection.connected, true); assert.ok(!JSON.stringify(state).includes('test-secret'));
  res = await fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify({ autoChat: { enabled: true, groups: ['234567'], debounceSeconds: 2, cooldownSeconds: 30 } }) });
  assert.equal(res.status, 200);
  const autoAnswer = new Promise(resolve => { answerReady = resolve; });
  const chatEvent = { ...event, message_id: 2, message: [{ type: 'text', data: { text: '今天适合聊什么？' } }] };
  ws.send(JSON.stringify(chatEvent)); ws.send(JSON.stringify(chatEvent));
  await Promise.race([autoAnswer, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('自动聊天超时')), 4000); timeout.unref(); })]);
  assert.equal(sent.length, 2); assert.equal(calls.length, 2);
  assert.equal(sent[1].message.length, 1); assert.equal(sent[1].message[0].type, 'text');
  assert.match(calls[1].messages[1].content, /今天适合聊什么/);
  await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
});

test('SSE 在中文字符与 CRLF 跨块时仍能正确解析', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"中文"}\r\n\r\ndata: {"text":"完成"}\n\n');
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1)); controller.close(); } });
  const result = []; await readSSE(stream, x => result.push(x)); assert.deepEqual(result, [{ text: '中文' }, { text: '完成' }]);
});

test('WorkBuddy ACP 完成握手、忽略加载历史、拒绝工具授权、收齐最终回答', async () => {
  let stream; const requests = [];
  const push = packet => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet)}\n\n`));
  const fetcher = async (url, init) => {
    if (!init.method) return new Response(new ReadableStream({ start(c) { stream = c; init.signal.addEventListener('abort', () => { try { c.close(); } catch {} }); } }), { headers: { 'Acp-Connection-Id': 'connection-test' } });
    const packet = JSON.parse(init.body); requests.push(packet);
    assert.equal(init.headers['Acp-Connection-Id'], 'connection-test');
    if (packet.method === 'session/load') push({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '历史回放不应出现' } } } });
    if (packet.method === 'session/prompt') {
      push({ id: 'permission-test', method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } });
      for (const text of ['你好，', '这是回答。']) push({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    }
    if (packet.method) push({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} });
    return new Response(null, { status: 202 });
  };
  const client = new ACPClient('https://acp.example/session', 'secret', AbortSignal.timeout(3000), fetcher);
  assert.equal(await client.answer('session-1', '问题'), '你好，这是回答。');
  assert.deepEqual(requests.filter(x => x.method).map(x => x.method), ['initialize', 'session/load', 'session/prompt']);
  assert.deepEqual(requests.find(x => x.id === 'permission-test').result, { outcome: { outcome: 'cancelled' } });
});

test('WorkBuddy OAuth 会刷新令牌；并发刷新只请求一次', async () => {
  const store = { value: { clientId: 'app', clientSecret: 'secret', accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 }, save: async () => {} };
  let count = 0;
  const providers = new Providers(store, async (url, init) => {
    count++; assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token');
    return Response.json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 });
  });
  assert.deepEqual(await Promise.all([providers.token(), providers.token()]), ['new', 'new']); assert.equal(count, 1);
});

test('WorkBuddy SSE 意外关闭时立即失败，不悬挂等到超时', async () => {
  const fetcher = async (url, init) => !init.method ? new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { 'Acp-Connection-Id': 'x' } }) : new Response(null, { status: 202 });
  await assert.rejects(new ACPClient('https://example.test', 'token', AbortSignal.timeout(1000), fetcher).answer('s', 'hello'), /断开/);
});
