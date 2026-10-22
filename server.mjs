import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ConfigStore, validateConfig } from './lib/config.mjs';
import { Providers } from './lib/providers.mjs';
import { QABot } from './lib/bot.mjs';
import { NapCatManager } from './lib/napcat.mjs';
import { CodeBuddy } from './lib/codebuddy.mjs';
import { ActivityScheduler } from './lib/activity.mjs';
import { AutoChat, chatPrompt } from './lib/chat.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function napcatConfig(token, port) {
  return { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [{
    name: 'QQ答疑机器人', enable: true, url: `ws://127.0.0.1:${port}/onebot/v11/ws`,
    messagePostFormat: 'array', reportSelfMessage: false, reconnectInterval: 5000,
    token, debug: false, heartInterval: 30000 }] }, musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false };
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('请求内容过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export async function startServer({ port = Number(process.env.PORT || 3210), dataDir = path.join(root, 'data'), fetcher = fetch } = {}) {
  const store = await new ConfigStore(dataDir).init();
  const codebuddy = await new CodeBuddy(dataDir).init();
  const providers = new Providers(store, fetcher, codebuddy); const sessions = new Map(); const oauth = new Map();
  const logs = []; let peer = null; let identity = null; let connectedAt = null; let lastHeartbeat = null;
  const pending = new Map(); let closing = false; let testing = false; let actualPort = port;
  const origin = () => `http://127.0.0.1:${actualPort}`;
  const napcat = new NapCatManager(path.join(root, 'runtime/napcat'), dataDir, () => napcatConfig(store.value.onebotToken, actualPort));
  function log(level, message) {
    let clean = String(message);
    for (const key of ['apiKey', 'clientSecret', 'accessToken', 'refreshToken', 'onebotToken']) {
      const secret = store.value[key]; if (secret) clean = clean.split(secret).join('[已隐藏]');
    }
    logs.push({ at: Date.now(), level, message: clean.slice(0, 400) }); if (logs.length > 150) logs.shift();
  }
  async function action(action, params) {
    const socket = peer;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('QQ 尚未连接');
    const echo = randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(new Error('QQ 接口响应超时')); }, 15000);
      pending.set(echo, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ action, params, echo }), err => { if (err) { clearTimeout(timer); pending.delete(echo); reject(err); } });
    });
  }
  let chat;
  const send = async (name, params) => {
    const generation = chat?.generation;
    const result = await action(name, params);
    if (chat?.generation === generation) chat?.recordBot(name, params);
    return result;
  };
  const bot = new QABot(store, providers, send, log);
  chat = new AutoChat({ store, providers, send, bot, log });
  const activity = await new ActivityScheduler({ store, providers, action: send,
    connection: () => ({ connected: !!peer && peer.readyState === WebSocket.OPEN, selfId: identity?.user_id }),
    busy: () => bot.active > 0, log, dataDir }).init();
  function json(res, data, status = 200, extra = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(data)); }
  function validSession(req) {
    const id = /(?:^|;\s*)qqa_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const expiry = sessions.get(id); return expiry && expiry > Date.now();
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return json(res, { error: `请使用 ${origin()} 访问` }, 403);
      const url = new URL(req.url, origin());
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const state = url.searchParams.get('state'); const saved = oauth.get(state); oauth.delete(state);
        if (!saved || Date.now() > saved.at + 10 * 60000 || !validSession(req)) throw new Error('授权校验失败或已过期，请从管理页重新授权');
        if (saved.clientId !== store.value.clientId) throw new Error('应用 ID 已改变，请重新授权');
        if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('WorkBuddy 未完成授权');
        await providers.exchange({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: origin() + '/oauth/callback' });
        log('success', 'WorkBuddy 账号授权成功');
        res.writeHead(302, { Location: '/?authorized=1', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[url.pathname];
        const bytes = await readFile(path.join(root, 'public', file));
        const headers = { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
        if (url.pathname === '/' && !validSession(req)) {
          for (const [id, expiry] of sessions) if (expiry < Date.now()) sessions.delete(id);
          while (sessions.size > 50) sessions.delete(sessions.keys().next().value);
          const id = randomBytes(24).toString('hex'); sessions.set(id, Date.now() + 24 * 3600000);
          headers['Set-Cookie'] = `qqa_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
        }
        res.writeHead(200, headers); return res.end(bytes);
      }
      if (!validSession(req)) return json(res, { error: '请刷新管理页后重试' }, 401);
      if (req.method === 'POST' && (req.headers['x-local-request'] !== '1' || (req.headers.origin && req.headers.origin !== origin()))) return json(res, { error: '请求来源校验失败' }, 403);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, { config: store.public(),
        napcat: await napcat.status(),
        codebuddy: codebuddy.status(),
        activity: activity.status(),
        autoChat: chat.status(),
        connection: { connected: !!peer && peer.readyState === WebSocket.OPEN, identity, connectedAt, lastHeartbeat },
        stats: { ...bot.stats, active: bot.active, conversations: bot.history.size }, logs, port: actualPort });
      if (req.method === 'POST' && url.pathname === '/api/qq/start') return json(res, await napcat.start());
      if (req.method === 'POST' && url.pathname === '/api/codebuddy/authorize') return json(res, await codebuddy.authorize());
      if (req.method === 'GET' && url.pathname === '/api/codebuddy/models') return json(res, { models: await codebuddy.models(true) });
      if (req.method === 'POST' && url.pathname === '/api/activity/preview') return json(res, await activity.preview());
      if (req.method === 'GET' && url.pathname === '/qq/login') {
        res.writeHead(302, { Location: await napcat.loginURL(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const next = validateConfig(await body(req), store.value); activity.invalidate(); chat.clear(); bot.clear(); store.value = next; await store.save();
        log('info', store.value.enabled ? '配置已保存，答疑已启用' : '配置已保存，答疑已暂停');
        return json(res, { ok: true, config: store.public() });
      }
      if (req.method === 'GET' && url.pathname === '/api/napcat') return json(res, { wsURL: `ws://127.0.0.1:${actualPort}/onebot/v11/ws`, token: store.value.onebotToken, config: napcatConfig(store.value.onebotToken, actualPort) });
      if (req.method === 'POST' && url.pathname === '/api/test') {
        if (testing) return json(res, { error: '已有模型测试正在进行' }, 409);
        const input = await body(req); const text = String(input.text || '你好，请用一句话介绍你自己。').trim();
        if (!text || text.length > 4000) throw new Error('测试问题应为 1～4000 字');
        testing = true;
        try {
          const answer = await providers.answer([{ role: 'system', content: chatPrompt(store.value) }, { role: 'user', content: text }]);
          log('success', '模型连接测试成功'); return json(res, { answer });
        } finally { testing = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/history/clear') { chat.clear(); bot.clear(); log('info', '已清空全部本机对话上下文'); return json(res, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/workbuddy/authorize') {
        if (!store.value.clientId || !store.value.clientSecret) throw new Error('请填写并保存 WorkBuddy 应用 ID 和应用密钥');
        for (const [key, saved] of oauth) if (Date.now() - saved.at > 10 * 60000) oauth.delete(key);
        const state = randomBytes(32).toString('hex'); oauth.set(state, { at: Date.now(), clientId: store.value.clientId });
        const params = new URLSearchParams({ response_type: 'code', client_id: store.value.clientId, redirect_uri: origin() + '/oauth/callback',
          scope: 'user.task.readable user.task.invokable', state });
        return json(res, { url: `https://www.workbuddy.cn/openapi/v2/authorize?${params}`, callback: origin() + '/oauth/callback' });
      }
      if (req.method === 'GET' && url.pathname === '/api/groups') {
        const groups = await action('get_group_list', {}); return json(res, { groups });
      }
      return json(res, { error: '接口不存在' }, 404);
    } catch (e) { log('error', e.message); if (!res.headersSent) json(res, { error: logs.at(-1).message }, 400); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin()); const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('access_token');
    if (closing || url.pathname !== '/onebot/v11/ws' || !same(auth, store.value.onebotToken) || req.headers.origin) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    const role = req.headers['x-client-role'];
    if (role && role !== 'Universal') { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    chat.clear(); bot.clear();
    if (peer) peer.close(1000, 'New connection'); peer = ws; identity = null; connectedAt = Date.now(); lastHeartbeat = Date.now();
    ws.alive = true; ws.on('pong', () => { ws.alive = true; }); log('success', 'NapCat 已连接');
    action('get_login_info', {}).then(info => { if (peer === ws) identity = info; }).catch(e => log('error', e.message));
    ws.on('message', bytes => {
      try {
        const packet = JSON.parse(bytes.toString());
        if (packet.echo && pending.has(packet.echo)) {
          const item = pending.get(packet.echo); if (item.socket !== ws) return;
          clearTimeout(item.timer); pending.delete(packet.echo);
          if (packet.retcode !== 0 || packet.status === 'failed') item.reject(new Error(`QQ 接口调用失败，错误码 ${packet.retcode}`)); else item.resolve(packet.data);
        } else if (peer === ws) {
          if (packet.self_id && !identity) identity = { user_id: packet.self_id, nickname: 'QQ 机器人' };
          if (packet.meta_event_type === 'heartbeat') lastHeartbeat = Date.now();
          activity.observe(packet); chat.observe(packet); bot.handle(packet).catch(e => log('error', e.message));
        }
      } catch { log('error', '收到格式不正确的 QQ 消息'); }
    });
    ws.on('error', () => log('error', 'QQ 连接发生网络错误'));
    ws.on('close', () => {
      for (const [key, item] of pending) if (item.socket === ws) { clearTimeout(item.timer); item.reject(new Error('QQ 连接已断开')); pending.delete(key); }
      if (peer === ws) { peer = null; identity = null; chat.clear(); bot.clear(); log('error', 'QQ 连接已断开，等待 NapCat 自动重连'); }
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    bot.sweep(); chat.sweep();
  }, 30000); timer.unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  const activityTimer = setInterval(() => { activity.tick().catch(e => log('error', e.message)); }, 10000); activityTimer.unref();
  log('info', '本机管理服务已启动');
  await mkdir(path.join(dataDir), { recursive: true });
  return { server, store, bot, chat, port: actualPort, async close() {
    activity.close(); clearInterval(activityTimer); codebuddy.close();
    closing = true; clearInterval(timer); chat.clear(); bot.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve)); wss.close();
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(app => {
    console.log(`QQ 群答疑机器人已启动：http://127.0.0.1:${app.port}\n关闭此进程将停止答疑。配置保存在 data/config.json。`);
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await app.close(); process.exit(0); });
  }).catch(e => { console.error(e.code === 'EADDRINUSE' ? '端口已占用。如果已经启动，请打开 http://127.0.0.1:3210' : e.message); process.exitCode = 1; });
}
