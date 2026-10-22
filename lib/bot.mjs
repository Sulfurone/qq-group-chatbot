export function segments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message !== 'string') return [];
  const result = []; let end = 0;
  const decode = s => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  for (const match of message.matchAll(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > end) result.push({ type: 'text', data: { text: decode(message.slice(end, match.index)) } });
    result.push({ type: match[1], data: Object.fromEntries(match[2].split(',').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), decode(s.slice(i + 1))]; })) });
    end = match.index + match[0].length;
  }
  if (end < message.length) result.push({ type: 'text', data: { text: decode(message.slice(end)) } });
  return result;
}
export function parseQuestion(event, config) {
  if (!config.enabled || event.post_type !== 'message' || event.message_type !== 'group' || !event.self_id || !event.group_id || !event.user_id || String(event.user_id) === String(event.self_id)) return null;
  if (!config.allowAllGroups && !config.groups.includes(String(event.group_id))) return null;
  const list = segments(event.message);
  if (!list.some(s => s.type === 'at' && String(s.data?.qq) === String(event.self_id))) return null;
  const text = list.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('').trim();
  return { text, key: `${event.group_id}:${event.user_id}`, group: String(event.group_id), user: String(event.user_id), message: event.message_id };
}
export class QABot {
  constructor(store, providers, send, log = () => {}) {
    this.store = store; this.providers = providers; this.send = send; this.log = log;
    this.history = new Map(); this.busy = new Set(); this.last = new Map(); this.seen = new Map(); this.active = 0; this.generation = 0;
    this.stats = { received: 0, answered: 0, failed: 0 };
  }
  clear() { this.history.clear(); this.last.clear(); this.generation++; }
  sweep() {
    const now = Date.now();
    for (const [key, item] of this.history) if (now - item.at > 30 * 60 * 1000) this.history.delete(key);
    for (const [key, at] of this.seen) if (now - at > 5 * 60 * 1000) this.seen.delete(key);
    for (const [key, at] of this.last) if (now - at > 5 * 60 * 1000) this.last.delete(key);
    for (const map of [this.history, this.last, this.seen]) while (map.size > 2000) map.delete(map.keys().next().value);
  }
  async reply(q, text) {
    const generation = this.generation;
    const chars = Array.from(text.slice(0, 8000));
    for (let i = 0; i < chars.length; i += 1400) {
      if (generation !== this.generation) return;
      const message = [{ type: 'at', data: { qq: q.user } }, { type: 'text', data: { text: '\n' + chars.slice(i, i + 1400).join('') } }];
      await this.send('send_group_msg', { group_id: Number(q.group), message });
    }
  }
  async handle(event) {
    const q = parseQuestion(event, this.store.value); if (!q) return;
    this.sweep();
    const dedup = `${event.self_id}:${q.group}:${q.message}`;
    if (q.message != null) { if (this.seen.has(dedup)) return; this.seen.set(dedup, Date.now()); }
    this.stats.received++;
    if (!q.text) return this.reply(q, '我在，@ 我并写下问题就可以提问。发送「/重置」可清空你在本群的对话。');
    if (q.text === '/重置' || q.text === '/reset') {
      if (this.busy.has(q.key)) return this.reply(q, '上一条回答还在生成，请等待完成后再重置。');
      this.history.delete(q.key); this.last.delete(q.key); return this.reply(q, '已清空你在本群的对话记录。');
    }
    if (q.text.length > 4000) return this.reply(q, '问题太长，请精简到 4000 字以内。');
    if (this.busy.has(q.key)) return;
    if (Date.now() - (this.last.get(q.key) || 0) < this.store.value.cooldownSeconds * 1000) return;
    if (this.active >= 4) return this.reply(q, '当前提问较多，请稍后再试。');
    const config = { ...this.store.value }; const generation = this.generation;
    this.busy.add(q.key); this.active++; this.last.set(q.key, Date.now());
    this.log('info', `收到提问 · 群 ${q.group} · 用户 ${q.user}`);
    try {
      const history = this.history.get(q.key)?.messages ?? [];
      const kept = config.historyTurns ? history.slice(-config.historyTurns * 2) : [];
      const messages = [{ role: 'system', content: `${config.systemPrompt}\n你的名字是${config.displayName || '聊天机器人1'}，你是 QQ 群聊天机器人。` }, ...kept, { role: 'user', content: q.text }];
      const answer = await this.providers.answer(messages);
      if (generation !== this.generation || !this.store.value.enabled) return;
      if (!this.store.value.allowAllGroups && !this.store.value.groups.includes(q.group)) return;
      await this.reply(q, answer);
      if (config.historyTurns) this.history.set(q.key, { at: Date.now(), messages: [...kept, { role: 'user', content: q.text }, { role: 'assistant', content: answer.slice(0, 8000) }].slice(-config.historyTurns * 2) });
      this.stats.answered++; this.log('success', `回答已发送 · 群 ${q.group}`);
    } catch (e) {
      this.stats.failed++; this.log('error', e.message);
      if (generation === this.generation && this.store.value.enabled) await this.reply(q, '暂时无法生成回答，请稍后重试；管理员可以在本机管理页查看连接、授权或额度问题。').catch(() => {});
    } finally { this.active--; this.busy.delete(q.key); }
  }
}
