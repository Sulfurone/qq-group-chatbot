import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);

export function isOfficialAuthURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && ['codebuddy.cn', 'codebuddy.ai', 'workbuddy.cn', 'workbuddy.ai', 'tencent.com'].some(host => u.hostname === host || u.hostname.endsWith('.' + host));
  } catch { return false; }
}
export function safeCLIArgs() {
  return ['--tools=', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources=',
    '--settings', '{"disableAllHooks":true,"memory":{"enabled":false},"codebuddy":{"agentHome":{"enabled":false,"orchestration":false}}}', '--no-session-persistence'];
}
export function isFreeCredit(value) { return typeof value === 'string' && /^x\s*0(?:\.0+)?\s+credits$/i.test(value.trim()); }
export function parseCLIOutput(output) {
  let records;
  try { const parsed = JSON.parse(output.trim()); records = Array.isArray(parsed) ? parsed : [parsed]; } catch {
    records = output.split(/\r?\n/).flatMap(line => { try { const p = JSON.parse(line); return Array.isArray(p) ? p : [p]; } catch { return []; } });
  }
  const result = records.findLast(x => x.type === 'result' || typeof x.result === 'string');
  if (result?.is_error) throw new Error('官方 CLI 返回模型错误，请检查账号、模型权限和剩余额度');
  let answer = result?.result ?? result?.response;
  if (typeof answer !== 'string') {
    const all = records.flatMap(x => Array.isArray(x.output) ? x.output : [x]);
    const assistant = all.findLast(x => x.role === 'assistant' || x.message?.role === 'assistant');
    const content = assistant?.content ?? assistant?.message?.content;
    answer = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => ['text', 'output_text'].includes(x.type)).map(x => x.text || '').join('') : '';
  }
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('官方 CLI 未返回文字回答');
  return { answer: answer.trim(), credit: result?.usage?.credit ?? null };
}
class RPC {
  constructor(child, notify) {
    this.child = child; this.notify = notify; this.pending = new Map(); this.buffer = ''; this.id = 0;
    this.failure = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 1024 * 1024) return this.close(new Error('官方 CLI 输出过大'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let p; try { p = JSON.parse(line); } catch { continue; }
        if (p.method) {
          if (p.id !== undefined) this.send(p.method === 'session/request_permission' ? { jsonrpc: '2.0', id: p.id, result: { outcome: { outcome: 'cancelled' } } }
            : { jsonrpc: '2.0', id: p.id, error: { code: -32601, message: 'Client capability unavailable' } });
          else this.notify(p);
        } else if (this.pending.has(p.id)) {
          const item = this.pending.get(p.id); this.pending.delete(p.id); clearTimeout(item.timer);
          p.error ? item.reject(new Error(`官方 CLI 授权或协议错误 ${p.error.code}`)) : item.resolve(p.result);
        }
      }
    });
    child.stderr.on('data', () => {}); // 授权进程日志可能含 URL/凭据，不回传到页面或日志。
    child.once('error', () => this.close(new Error('官方 CLI 无法启动')));
    child.once('exit', () => this.close(new Error('官方 CLI 连接已结束')));
    child.stdin.on('error', () => this.close(new Error('官方 CLI 输入通道已关闭')));
  }
  send(packet) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(packet) + '\n'); }
  call(method, params, timeout = 30000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('官方 CLI 响应超时')); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  close(reason = new Error('授权连接已关闭')) {
    this.failure = reason;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear(); if (!this.child.killed) this.child.kill();
  }
}
export class CodeBuddy {
  constructor(dataDir, spawnProcess = spawn) {
    this.dataDir = dataDir; this.spawnProcess = spawnProcess;
    this.authDir = path.join(dataDir, 'codebuddy-auth'); this.workDir = path.join(dataDir, 'cli-workspace');
    this.marker = path.join(dataDir, 'cli-account.json'); this.account = null; this.rpc = null;
    this.phase = 'idle'; this.url = ''; this.deadline = 0; this.error = ''; this.starting = null; this.authJob = null;
    this.modelCache = null; this.modelLoading = null; this.lastUsage = null;
  }
  async init() {
    await Promise.all([mkdir(this.workDir, { recursive: true }), mkdir(this.authDir, { recursive: true })]);
    try { this.account = JSON.parse(await readFile(this.marker, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  environment() {
    const env = { ...process.env, CODEBUDDY_CONFIG_DIR: this.authDir, CODEBUDDY_SKIP_GIT_BASH_CHECK: '1', DISABLE_AUTOUPDATER: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1', CODEBUDDY_AGENT_HOME_ENABLED: '0', CODEBUDDY_AGENT_HOME_ORCHESTRATION_ENABLED: '0',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
    // 不从父进程带入模型 Key、第三方端点或其他 Agent 的会话标记。
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CODEBUDDY_API_|CODEBUDDY_AUTH_TOKEN|CODEBUDDY_BASE_URL|CODEBUDDY_GATEWAY_|CLAUDECODE$|CLAUDE_CODE_|launch_schema$)/i.test(key)) delete env[key];
    return env;
  }
  child(args) {
    return this.spawnProcess(process.execPath, [require.resolve('@tencent-ai/codebuddy-code/bin/codebuddy'), ...args], {
      cwd: this.workDir, windowsHide: true, env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  }
  status() {
    return { phase: this.phase, authorized: !!this.account, nickname: this.account?.nickname || '', authorizedAt: this.account?.at || null,
      pending: ['starting', 'pending'].includes(this.phase), expiresAt: this.deadline || null, error: this.error,
      lastSuccess: this.lastUsage,
      url: this.phase === 'pending' && Date.now() < this.deadline ? this.url : '' };
  }
  async authorize() {
    if (this.phase === 'pending' && Date.now() < this.deadline && this.url) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.begin().finally(() => { this.starting = null; });
    return this.starting;
  }
  async begin() {
    this.rpc?.close(); this.phase = 'starting'; this.url = ''; this.error = ''; this.lastUsage = null; this.deadline = Date.now() + 10 * 60000;
    this.account = null; await writeFile(this.marker, 'null', { mode: 0o600 });
    let resolveURL, rejectURL;
    const urlReady = new Promise((resolve, reject) => { resolveURL = resolve; rejectURL = reject; });
    const rpc = new RPC(this.child(['--acp', ...safeCLIArgs()]), p => {
      if (p.method === '_codebuddy.ai/authUrl') {
        const value = p.params?.authUrl;
        if (!isOfficialAuthURL(value)) { rejectURL(new Error('官方 CLI 返回了无法识别的授权站点')); return; }
        this.url = value; this.phase = 'pending'; resolveURL();
      }
    });
    this.rpc = rpc;
    let urlTimeout;
    try {
      const init = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'qq-group-qa', version: '1.0.0' } });
      if (!init.authMethods?.some(x => x.id === 'internal')) throw new Error('此版本官方 CLI 没有提供微信授权方式');
      this.authJob = rpc.call('authenticate', { methodId: 'internal' }, 10 * 60000).then(async result => {
        if (this.rpc !== rpc) return;
        const info = result?._meta?.['codebuddy.ai/userinfo'];
        this.account = { nickname: String(info?.userNickname || info?.userName || '已授权账号').slice(0, 80), at: Date.now() };
        await writeFile(this.marker, JSON.stringify(this.account), { mode: 0o600 });
        this.phase = 'authorized'; this.url = ''; this.deadline = 0; resolveURL();
      }).catch(e => {
        if (this.rpc === rpc) { this.phase = 'error'; this.error = e.message; this.url = ''; }
        rejectURL(e);
      }).finally(() => { if (this.rpc === rpc) { this.rpc = null; rpc.close(); } });
      await Promise.race([urlReady, new Promise((_, reject) => { urlTimeout = setTimeout(() => reject(new Error('授权链接暂未生成，请稍后重试')), 35000); })]);
      return this.status();
    } catch (e) { this.phase = 'error'; this.error = e.message; if (this.rpc === rpc) this.rpc = null; rpc.close(); throw e; }
    finally { clearTimeout(urlTimeout); }
  }
  async models(fresh = false) {
    if (!this.account) throw new Error('请先完成官方账号授权');
    if (this.modelLoading) return this.modelLoading;
    if (!fresh && this.modelCache && Date.now() - this.modelCache.at < 60000) return this.modelCache.models;
    this.modelLoading = (async () => {
      const rpc = new RPC(this.child(['--acp', ...safeCLIArgs()]), () => {});
      try {
        await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'qq-group-qa', version: '1.0.0' } });
        const session = await rpc.call('session/new', { cwd: this.workDir, mcpServers: [] });
        const models = (session.models?.availableModels || []).map(m => {
          const credits = String(m._meta?.credits ?? m.description ?? '');
          return { id: String(m.modelId), name: String(m.name || m.modelId), credits, free: isFreeCredit(credits) };
        });
        this.modelCache = { at: Date.now(), models }; return models;
      } finally { rpc.close(); }
    })().finally(() => { this.modelLoading = null; });
    return this.modelLoading;
  }
  async answer(messages, model = '', freeOnly = true) {
    if (!this.account) throw new Error('请先点击「连接 WorkBuddy 账号」并在官方页面确认授权');
    if (freeOnly) {
      const models = await this.models(true);
      const selected = model ? models.find(m => m.id === model) : models.find(m => m.free);
      if (!selected?.free) throw new Error('仅免费模型模式已阻止调用：所选模型没有明确标注为 0 credits，请刷新模型列表');
      model = selected.id;
    }
    const args = ['--print', '--output-format', 'json', '--max-turns', '1', ...safeCLIArgs(),
      '--system-prompt', messages.find(x => x.role === 'system')?.content || '请用中文回答问题。'];
    if (model) args.push('--model', model);
    const prompt = JSON.stringify(messages.filter(x => x.role !== 'system'));
    const child = this.child(args);
    return new Promise((resolve, reject) => {
      let output = ''; let finished = false;
      const finish = (error, answer) => { if (finished) return; finished = true; clearTimeout(timeout); if (!child.killed) child.kill(); error ? reject(error) : resolve(answer); };
      const timeout = setTimeout(() => finish(new Error('官方 CLI 模型回答超时')), 150000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) finish(new Error('模型输出过大')); });
      child.stderr.on('data', () => {});
      child.once('error', () => finish(new Error('官方 CLI 模型进程无法启动')));
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
      child.once('exit', code => {
        if (finished) return;
        try {
          if (code !== 0) throw new Error('模型调用失败，请检查官方账号登录、所选模型权限和剩余额度');
          const { answer, credit } = parseCLIOutput(output);
          this.lastUsage = { model, at: Date.now(), credit };
          finish(null, answer);
        } catch (e) { finish(e); }
      });
    });
  }
  close() { this.rpc?.close(); this.rpc = null; }
}
