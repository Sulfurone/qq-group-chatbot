import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultActivity } from './config.mjs';

const DAY = 86400000;
export function shanghaiTime(at) {
  const shifted = new Date(at + 8 * 3600000);
  return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16) };
}
export function slotTimestamp(date, time) { return Date.parse(`${date}T${time}:00+08:00`); }
export function nextActivityAt(activity, now) {
  if (!activity.enabled || !activity.groups.length) return null;
  const date = shanghaiTime(now).date;
  for (let day = 0; day < 3; day++) {
    const current = shanghaiTime(slotTimestamp(date, '12:00') + day * DAY).date;
    for (const time of [...activity.times].sort()) { const at = slotTimestamp(current, time); if (at > now) return at; }
  }
  return null;
}
const QUESTIONS = [
  '来个轻松脑洞：如果明天能瞬间学会一项技能，你最想学什么？欢迎随手聊一句～',
  '今日选择题：一周不用洗碗，还是一周不用通勤？只能选一个，你站哪边？😄',
  '把今天的心情比作一道菜，会是哪一道？我先抛个题，大家自由发挥～',
  '如果给这个群开一家小店，你觉得最适合卖什么？名字也可以一起想想！',
  '有没有一首歌，前奏一响你就忍不住跟着唱？欢迎分享你的循环歌单～',
  '轻松聊聊：最近发现的一个小快乐是什么？一顿好吃的、一次好天气都算。',
  '如果周末多出半天自由时间，你会拿来睡觉、出门，还是做点一直想做的事？',
  '今天的脑洞：如果能和一种动物正常聊天，你会选哪种，第一句想问什么？'
];
const GAMES = [
  '来个不费脑的小接龙：用三个词形容理想中的周末。我先来——睡到自然醒、好吃的、慢慢走。',
  '迷你脑洞游戏：给“会自动整理书桌的机器人”起个名字，越有趣越好～',
  '一起编个小故事吧：一句话接龙，开头是“我打开冰箱，发现里面坐着一只企鹅……”',
  '轻松小挑战：不用“忙”和“累”，用一句话描述今天。欢迎有空的朋友来一句～',
  '想象力时间：如果你的水杯突然会说话，它对你说的第一句话会是什么？',
  '给今天起个电影名吧！喜剧、冒险片、生活纪录片都可以，欢迎脑洞～'
];
const GREETINGS = [
  '新一天开始啦，早上好！今天有没有一件小事，让你有一点期待？☀️',
  '到午间啦，记得好好吃饭、活动一下。今天的午饭，有什么值得推荐的吗？',
  '下午小歇一会儿：喝口水，松松肩膀。最近有什么让你觉得“还不错”的小事？',
  '傍晚好，忙了一天辛苦啦。今晚准备吃点什么，给自己补充一点快乐？',
  '晚上好，今天有没有一个值得记下的小瞬间？愿今晚大家都能放松一点～'
];
export function topicFor(activity, date, time, group) {
  const slot = Math.max(0, activity.times.indexOf(time));
  let hash = 0; for (const ch of `${date}:${group}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const style = activity.style === 'mixed' ? (time === '09:00' ? 'greeting' : ['question', 'game', 'question', 'greeting'][(slot + hash) % 4]) : activity.style;
  const source = style === 'game' ? GAMES : style === 'greeting' ? GREETINGS : QUESTIONS;
  const index = style === 'greeting' ? Math.min(4, Math.max(0, Math.floor((Number(time.slice(0, 2)) - 9) / 3))) : (hash + slot) % source.length;
  return { style, text: source[index] };
}
export class ActivityScheduler {
  constructor({ store, providers, action, connection, busy = () => false, log = () => {}, dataDir, clock = () => Date.now(), spacingMs = 1500 }) {
    Object.assign(this, { store, providers, action, connection, busy, log, dataDir, clock, spacingMs });
    this.file = path.join(dataDir, 'activity-ledger.json'); this.startedAt = clock();
    this.entries = {}; this.messages = new Map(); this.running = false; this.previewing = false; this.generation = 0; this.closed = false;
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try { const data = JSON.parse(await readFile(this.file, 'utf8')); if (!data || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('invalid ledger'); this.entries = data.entries; }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('定时发言记录损坏。为避免重复发送，服务不会自动忽略此记录，请检查 data/activity-ledger.json'); }
    return this;
  }
  config() { return { ...defaultActivity(), ...this.store.value.activity }; }
  invalidate() { this.generation++; }
  close() { this.closed = true; this.invalidate(); }
  observe(event) {
    if (event.post_type === 'message' && event.message_type === 'group' && event.group_id && String(event.user_id) !== String(event.self_id)) this.messages.set(String(event.group_id), this.clock());
    if (this.messages.size > 2000) for (const [id, at] of this.messages) if (this.clock() - at > DAY) this.messages.delete(id);
  }
  status() {
    const config = this.config(); const records = Object.values(this.entries).filter(x => x.at >= this.clock() - 14 * DAY);
    const latest = records.reduce((last, item) => !last || item.at > last.at ? item : last, null);
    return { enabled: config.enabled, running: this.running, nextAt: nextActivityAt(config, this.clock()), timezone: 'Asia/Shanghai',
      sent: records.filter(x => x.status === 'sent').length, last: latest ? { ...latest } : null };
  }
  async persist() {
    const cutoff = this.clock() - 14 * DAY;
    for (const [key, value] of Object.entries(this.entries)) if (value.at < cutoff) delete this.entries[key];
    const keys = Object.keys(this.entries); for (const key of keys.slice(0, Math.max(0, keys.length - 10000))) delete this.entries[key];
    await writeFile(this.file + '.tmp', JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  async generate(config, date, time, group) {
    const topic = topicFor(config, date, time, group);
    if (!config.useAI) return { ...topic, source: '本地话题' };
    try {
      const content = await this.providers.answer([
        { role: 'system', content: '你是 QQ 群里的友善话题助手。仅输出一条自然、轻松的中文互动话题，60～120 字，最多 180 字。不冒充群成员，不编造时事、天气、群内经历，不询问隐私，不营销，不点名、不@任何人，不调用工具，不要求转发或刷屏。只输出可直接发送的正文。' },
        { role: 'user', content: `北京时间 ${date} ${time}。话题类型 ${topic.style}。请围绕这个点子写一条有变化的话题：${topic.text}` }
      ]);
      const text = content.replace(/\[CQ:[^\]]*\]/gi, '').replace(/@全体成员/g, '').trim();
      if (!text) throw new Error('话题为空');
      return { style: topic.style, text: Array.from(text).slice(0, 240).join(''), source: '当前模型' };
    } catch {
      this.log('info', '活跃话题模型暂不可用，使用本地话题');
      return { ...topic, source: '本地话题（模型不可用）' };
    }
  }
  async preview() {
    if (this.previewing) throw new Error('话题预览正在生成，请稍候');
    this.previewing = true;
    try { const { date, time } = shanghaiTime(this.clock()); return await this.generate(this.config(), date, time, 'preview'); }
    finally { this.previewing = false; }
  }
  async record(key, record) { this.entries[key] = record; await this.persist(); }
  async tick() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const now = this.clock(); const config = this.config(); const { date, time } = shanghaiTime(now); const slot = slotTimestamp(date, time);
      if (!config.enabled || !config.groups.length || !config.times.includes(time) || slot < this.startedAt || slot < config.updatedAt) return;
      const conn = this.connection(); if (!conn.connected || !conn.selfId) return;
      const generation = this.generation; const self = String(conn.selfId);
      const valid = () => !this.closed && this.generation === generation && this.config().enabled && this.connection().connected && String(this.connection().selfId) === self;
      const targets = config.groups.filter(group => !this.entries[`${self}:${date}:${time}:${group}`]); if (!targets.length) return;
      const groupList = await this.action('get_group_list', {}); if (!valid()) return;
      const joined = new Set(groupList.map(g => String(g.group_id)));
      for (const group of targets) {
        if (!valid()) break;
        const key = `${self}:${date}:${time}:${group}`;
        const base = { at: this.clock(), date, time, group, status: 'claimed', source: '' };
        // 在生成和发送前落盘。即使发送回执超时或进程重启，也不重复发送。
        await this.record(key, base);
        const skip = async reason => { await this.record(key, { ...base, at: this.clock(), status: 'skipped', reason }); this.log('info', `跳过定时话题 · 群 ${group} · ${reason}`); };
        const quiet = () => config.quietMinutes > 0 && this.clock() - (this.messages.get(group) ?? this.startedAt) < config.quietMinutes * 60000;
        if (!joined.has(group)) { await skip('当前 QQ 未加入此群'); continue; }
        if (quiet()) { await skip('群里正在聊天或启动观察时间不足'); continue; }
        if (this.busy()) { await skip('机器人正在答疑'); continue; }
        const content = await this.generate(config, date, time, group);
        if (!valid()) { await skip('配置或 QQ 连接已变化'); break; }
        if (this.clock() > slot + 180000) { await skip('本次话题生成超时，不延迟补发'); continue; }
        if (quiet()) { await skip('生成期间群里开始聊天'); continue; }
        try {
          await this.action('send_group_msg', { group_id: Number(group), message: [{ type: 'text', data: { text: content.text } }] });
          await this.record(key, { ...base, at: this.clock(), status: 'sent', source: content.source, text: content.text });
          this.log('success', `定时活跃话题已发送 · 群 ${group}`);
        } catch {
          await this.record(key, { ...base, at: this.clock(), status: 'failed', reason: '发送失败或回执超时，不自动重发' });
          this.log('error', `定时话题发送失败 · 群 ${group} · 不自动重发`);
        }
        if (targets.length > 1 && this.spacingMs) await delay(this.spacingMs);
      }
    } catch (e) { this.log('error', '定时活跃检查失败：' + e.message); }
    finally { this.running = false; }
  }
}
