import { setTimeout as delay } from 'node:timers/promises';

export async function jsonFetch(url, init = {}, fetcher = fetch) {
  const res = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120000), redirect: 'error' });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`上游接口返回 HTTP ${res.status}${res.status === 401 ? '，请检查密钥或重新授权' : res.status === 429 ? '，请求过于频繁或额度不足' : ''}`); }
  const data = await res.json();
  if (data.code !== undefined && ![0, '0', 'success'].includes(data.code)) throw new Error(`上游业务错误 ${String(data.code).slice(0, 40)}，请检查账号权限与额度`);
  return data.data ?? data;
}
export function completionsURL(base) {
  const clean = base.replace(/\/+$/, '');
  return clean.endsWith('/chat/completions') ? clean : clean + '/chat/completions';
}
export async function openaiAnswer(c, messages, fetcher = fetch) {
  if (!c.apiBase || !c.model) throw new Error('请先填写 API 地址和模型 ID');
  const data = await jsonFetch(completionsURL(c.apiBase), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({ model: c.model, messages, stream: false, max_tokens: 2000 }) }, fetcher);
  const raw = data.choices?.[0]?.message?.content;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter(x => x.type === 'text').map(x => x.text).join('') : '';
  if (!text?.trim()) throw new Error('模型未返回文字回答，请检查模型是否支持聊天补全');
  return text.trim();
}

// SSE 按事件解析，支持跨块 UTF-8、CRLF、多行 data 和最后一个事件。
export async function readSSE(body, receive) {
  const decoder = new TextDecoder(); let buffer = '';
  function consume(final = false) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      deliver(event);
    }
    if (final && buffer.trim()) { deliver(buffer); buffer = ''; }
  }
  function deliver(event) {
    const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
    if (data && data !== '[DONE]') receive(JSON.parse(data));
  }
  for await (const chunk of body) { buffer += decoder.decode(chunk, { stream: true }); consume(); }
  buffer += decoder.decode(); consume(true);
}

export class ACPClient {
  constructor(link, token, signal, fetcher = fetch) {
    this.link = link; this.token = token; this.fetcher = fetcher;
    this.abort = new AbortController(); this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.pending = new Map(); this.id = 0; this.text = ''; this.capturing = false; this.failure = null;
  }
  async connect() {
    const res = await this.fetcher(this.link, { signal: this.signal, redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' } });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`ACP 连接失败 HTTP ${res.status}`); }
    this.connection = res.headers.get('acp-connection-id');
    if (!this.connection || !res.body) { await res.body?.cancel(); throw new Error('ACP 缺少连接标识或事件流'); }
    this.reader = readSSE(res.body, packet => this.receive(packet)).then(() => { throw new Error('ACP 事件流已断开'); }).catch(e => {
      this.failure = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    this.signal.addEventListener('abort', () => {
      for (const p of this.pending.values()) p.reject(new Error('模型请求超时或已取消'));
      this.pending.clear();
    }, { once: true });
  }
  receive(packet) {
    if (packet.method && packet.id !== undefined) {
      const permission = packet.method === 'session/request_permission';
      this.post(permission ? { jsonrpc: '2.0', id: packet.id, result: { outcome: { outcome: 'cancelled' } } }
        : { jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'Unsupported client method' } }).catch(e => {
          for (const p of this.pending.values()) p.reject(e); this.pending.clear();
        });
      return;
    }
    if (packet.method === 'session/update' && this.capturing) {
      const update = packet.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        this.text += update.content.text ?? '';
        if (this.text.length > 32000) this.abort.abort();
      }
    }
    if (!packet.method && packet.id !== undefined) {
      const wait = this.pending.get(packet.id);
      if (wait) { this.pending.delete(packet.id); packet.error ? wait.reject(new Error(`ACP 协议错误 ${packet.error.code}`)) : wait.resolve(packet.result); }
    }
  }
  async post(packet) {
    const res = await this.fetcher(this.link, { method: 'POST', signal: this.signal, redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Acp-Connection-Id': this.connection }, body: JSON.stringify(packet) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`ACP 发送失败 HTTP ${res.status}`); }
    await res.body?.cancel();
  }
  async call(method, params) {
    if (this.failure) throw this.failure;
    this.signal.throwIfAborted();
    const id = ++this.id;
    const wait = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ jsonrpc: '2.0', id, method, params }).catch(e => { this.pending.delete(id); reject(e); });
    });
    return wait;
  }
  async answer(sessionId, text) {
    try {
      await this.connect();
      await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      await this.call('session/load', { sessionId, cwd: '/workspace', mcpServers: [] });
      this.text = ''; this.capturing = true;
      const result = await this.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      if (result?.stopReason === 'cancelled') throw new Error('WorkBuddy 任务已取消，可能请求了答疑以外的工具权限');
      if (!this.text.trim()) throw new Error('WorkBuddy 未返回文字回答');
      return this.text.trim();
    } finally { this.abort.abort(); await this.reader; }
  }
}

export class Providers {
  constructor(store, fetcher = fetch, codebuddy = null) { this.store = store; this.fetcher = fetcher; this.refreshing = null; this.codebuddy = codebuddy; }
  async exchange(fields) {
    const c = this.store.value;
    const data = await jsonFetch('https://www.workbuddy.cn/openapi/v2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: c.clientId, client_secret: c.clientSecret }) }, this.fetcher);
    if (!data.access_token) throw new Error('WorkBuddy 授权未返回访问令牌');
    if (this.store.value.clientId !== c.clientId || this.store.value.clientSecret !== c.clientSecret) throw new Error('应用配置已改变，请重新授权');
    Object.assign(this.store.value, { accessToken: data.access_token, refreshToken: data.refresh_token || c.refreshToken,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 });
    await this.store.save();
  }
  async token() {
    const c = this.store.value;
    if (!c.accessToken) throw new Error('请先配置 WorkBuddy 应用并完成账号授权');
    if (Date.now() > c.expiresAt - 60000) {
      if (!c.refreshToken) throw new Error('WorkBuddy 授权已过期，请重新授权');
      if (!this.refreshing) this.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: c.refreshToken }).finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    return this.store.value.accessToken;
  }
  async answer(messages) {
    const c = { ...this.store.value };
    if (c.provider === 'codebuddy') {
      if (!this.codebuddy) throw new Error('官方 CLI 连接尚未初始化');
      return this.codebuddy.answer(messages, c.cliModel, c.cliFreeOnly);
    }
    if (c.provider === 'openai') return openaiAnswer(c, messages, this.fetcher);
    const token = await this.token(); const signal = AbortSignal.timeout(150000);
    const request = (route, init = {}) => jsonFetch(`https://www.workbuddy.cn/openapi/v2${route}`, { ...init, signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, this.fetcher);
    // 每轮创建独立云端任务，明确传入本用户历史，不使用本机助理 API。
    let task = await request('/tasks', { method: 'POST', body: JSON.stringify({ prompt: '建立一个只做文字问答、不执行工具的会话。等待接下来的提问。', name: 'QQ 群文字答疑' }) });
    if (!task.task_id) throw new Error('WorkBuddy 没有返回任务 ID');
    while (!task.link || !task.token || ['CREATING', 'working', 'planning'].includes(task.status)) {
      if (['failed', 'pending', 'deleted', 'archived'].includes(task.status)) throw new Error(`WorkBuddy 会话状态 ${task.status}`);
      await delay(1200, undefined, { signal }); task = await request(`/tasks/${encodeURIComponent(task.task_id)}`);
    }
    if (['failed', 'pending', 'deleted', 'archived'].includes(task.status)) throw new Error(`WorkBuddy 会话状态 ${task.status}`);
    const transcript = JSON.stringify(messages);
    return new ACPClient(task.link, task.token, signal, this.fetcher).answer(String(task.task_id), `请根据以下对话记录，用中文直接回答最后一个用户的问题。仅返回答疑文字，不调用工具。\n${transcript}`);
  }
}
