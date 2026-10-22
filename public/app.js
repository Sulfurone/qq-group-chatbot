const $ = id => document.getElementById(id);
let latest = null, toastTimer;
async function api(url, data) {
  const res = await fetch(url, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Request': '1' }, body: JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`); return result;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function providerFields() {
  const provider = document.querySelector('[name=provider]:checked').value;
  $('workbuddy-fields').hidden = provider !== 'workbuddy'; $('openai-fields').hidden = provider !== 'openai'; $('codebuddy-fields').hidden = provider !== 'codebuddy';
}
function fill(c) {
  fillActivity(c.activity);
  fillChat(c.autoChat); $('displayName').value = c.displayName || '聊天机器人1';
  for (const id of ['enabled', 'allowAllGroups']) $(id).checked = c[id];
  for (const id of ['cooldownSeconds', 'historyTurns', 'systemPrompt', 'clientId', 'apiBase']) $(id).value = c[id];
  $('modelId').value = c.model; $('groups').value = c.groups.join('\n');
  $('cliModel').value = c.cliModel || '';
  $('cliFreeOnly').checked = c.cliFreeOnly !== false;
  document.querySelector(`[name=provider][value=${c.provider}]`).checked = true;
  $('apiKey').value = ''; $('clientSecret').value = '';
  $('apiKey').placeholder = c.hasApiKey ? '已保存，留空保留原密钥' : '接口服务提供的密钥；本机服务可留空';
  $('clientSecret').placeholder = c.hasClientSecret ? '已保存，留空保留原密钥' : '填写 clientSecret';
  providerFields();
}
function fillActivity(activity = {}) {
  $('activity-enabled').checked = !!activity.enabled; $('activity-ai').checked = activity.useAI !== false;
  $('activity-groups').value = (activity.groups || []).join('\n'); $('activity-times').value = (activity.times || ['09:00', '12:00', '15:00', '18:00', '21:00']).join(', ');
  $('activity-quiet').value = activity.quietMinutes ?? 15; $('activity-style').value = activity.style || 'mixed';
}
function fillChat(chat = {}) {
  $('chat-enabled').checked = !!chat.enabled; $('chat-groups').value = (chat.groups || []).join('\n');
  $('chat-cooldown').value = chat.cooldownSeconds ?? 90; $('chat-debounce').value = chat.debounceSeconds ?? 4;
  $('chat-context').value = chat.contextMessages ?? 20;
}
function settings() {
  return { displayName: $('displayName').value, enabled: $('enabled').checked, allowAllGroups: $('allowAllGroups').checked,
    groups: $('groups').value.split(/[\s,，;；]+/).filter(Boolean),
    cooldownSeconds: Number($('cooldownSeconds').value), historyTurns: Number($('historyTurns').value),
    systemPrompt: $('systemPrompt').value, provider: document.querySelector('[name=provider]:checked').value,
    clientId: $('clientId').value, clientSecret: $('clientSecret').value,
    apiBase: $('apiBase').value, apiKey: $('apiKey').value, model: $('modelId').value, cliModel: $('cliModel').value, cliFreeOnly: $('cliFreeOnly').checked };
}
async function save(extra = {}) {
  const result = await api('/api/config', { ...settings(), ...extra }); fill(result.config);
  $('save-status').textContent = '已保存'; setTimeout(() => { $('save-status').textContent = ''; }, 3500);
  await refresh(); return result;
}
function render(state) {
  latest = state; const { config: c, connection, stats, port } = state;
  $('brand-name').textContent = c.displayName || '聊天机器人1'; document.title = `${c.displayName || '聊天机器人1'} · QQ 群聊工作台`;
  if (state.autoChat) {
    const a = state.autoChat;
    $('chat-badge').textContent = a.enabled ? '已开启 · 无需 @' : '已暂停'; $('chat-badge').classList.toggle('on', a.enabled);
    $('chat-summary').textContent = `${a.answered} 次自动接话 · ${a.received} 条群聊消息 · ${a.groups} 个群有近期记录${a.pending ? ' · 正在等待或生成回复' : ''}`;
    $('chat-scope').textContent = a.enabled ? `生效群：${c.autoChat.groups.join('、')} · 每群至少间隔 ${c.autoChat.cooldownSeconds} 秒` : '自动聊天独立指定群；上方机器人总开关也需要开启。';
  }
  if (state.activity) {
    const a = state.activity; const format = at => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    $('activity-badge').textContent = a.enabled ? '已开启 · 指定群' : '尚未开启'; $('activity-badge').classList.toggle('on', a.enabled);
    $('activity-next').textContent = a.nextAt ? format(a.nextAt) + '（北京）' : '尚未开启'; $('activity-count').textContent = a.sent + ' 条';
    const labels = { claimed: '处理中或上次进程已中断', sent: '已发送', skipped: '已跳过', failed: '失败，不重发' };
    $('activity-last').textContent = a.last ? `最近记录：${format(a.last.at)} · 群 ${a.last.group} · ${labels[a.last.status] || a.last.status}${a.last.reason ? ' · ' + a.last.reason : ''}` : '暂无定时发送记录。';
  }
  if (state.napcat) {
    const n = state.napcat;
    $('napcat-status').textContent = connection.connected ? 'QQ 已登录并连接成功，可在账号管理页查看当前账号。' : n.ready ? 'QQ 登录服务已就绪，点击下方入口扫码登录。' : n.error || (n.starting ? 'QQ 登录服务正在启动，请稍候…' : n.installed ? 'QQ 组件已安装，点击下方按钮启动登录服务。' : 'QQ 组件正在安装或尚未安装完成，请等待安装结束。首次需要下载组件。');
    $('qq-login-link').textContent = connection.connected ? '打开 QQ 账号管理 ↗' : '打开 QQ 扫码登录 ↗';
    $('qq-login-link').hidden = !n.ready; $('start-qq').hidden = n.ready;
    $('start-qq').disabled = !n.installed || n.starting;
  }
  $('enabled-badge').textContent = c.enabled ? '机器人运行中' : '机器人已暂停'; $('enabled-badge').classList.toggle('on', c.enabled);
  $('qq-status').textContent = connection.connected ? '已连接' : '等待连接';
  $('qq-identity').textContent = connection.identity ? `${connection.identity.nickname} · ${connection.identity.user_id}` : '连接 NapCat 后显示账号';
  $('model-status').textContent = c.provider === 'codebuddy' ? state.codebuddy?.authorized ? '已授权 · 待测试' : '等待账号授权' : c.provider === 'workbuddy' ? c.workbuddyAuthorized ? '已授权 · 待测试' : '等待授权' : c.apiBase && c.model ? '已配置 · 待测试' : '等待配置';
  $('model-detail').textContent = c.provider === 'codebuddy' ? '腾讯官方 CodeBuddy CLI' : c.provider === 'workbuddy' ? 'WorkBuddy 官方云端会话' : c.model || 'OpenAI 兼容接口';
  if (c.provider === 'codebuddy' && state.codebuddy?.lastSuccess && (!c.cliModel || state.codebuddy.lastSuccess.model === c.cliModel)) {
    $('model-status').textContent = '已连通'; $('model-detail').textContent = state.codebuddy.lastSuccess.model + (c.cliFreeOnly ? ' · 仅免费模型' : '');
  }
  if (state.codebuddy) {
    const auth = state.codebuddy;
    $('cli-auth-status').textContent = auth.pending ? '等待你在官方页面完成登录…' : auth.error || (auth.authorized ? `账号已授权${auth.nickname ? ' · ' + auth.nickname : ''}` : '尚未授权');
    $('cli-auth-link').hidden = !auth.url; if (auth.url) $('cli-auth-link').href = auth.url;
    $('cli-authorize').textContent = auth.authorized ? '重新连接账号 ↗' : auth.pending ? '刷新授权状态' : '连接 WorkBuddy 账号 ↗';
  }
  $('auth-status').textContent = c.workbuddyAuthorized ? '账号已授权，可测试模型' : '尚未授权';
  $('answer-count').replaceChildren(document.createTextNode(String(stats.answered) + ' '));
  const em = document.createElement('em'); em.textContent = '次'; $('answer-count').append(em);
  $('active-count').textContent = stats.active ? `${stats.active} 个回答正在生成` : `已接收 ${stats.received} 条提问 · ${stats.conversations} 个对话`;
  $('local-address').textContent = `127.0.0.1:${port}`; $('callback-url').textContent = `http://127.0.0.1:${port}/oauth/callback`;
  const logs = $('logs'); const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 30;
  logs.replaceChildren(...state.logs.map(item => {
    const row = document.createElement('div'); row.className = 'log-line';
    const time = document.createElement('time'); time.textContent = new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false });
    const text = document.createElement('span'); text.className = item.level; text.textContent = item.message;
    row.append(time, text); return row;
  }));
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}
async function refresh() { render(await api('/api/state')); }
document.querySelectorAll('[name=provider]').forEach(input => input.addEventListener('change', providerFields));
$('start-qq').addEventListener('click', async () => {
  $('start-qq').disabled = true;
  try { await api('/api/qq/start', {}); toast('QQ 登录服务正在启动，请等待扫码入口出现'); await refresh(); }
  catch (e) { toast(e.message); $('start-qq').disabled = false; }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); try { await save(); toast('设置已保存'); } catch (e) { toast(e.message); }
});
$('chat-save').addEventListener('click', async () => {
  const button = $('chat-save'); button.disabled = true;
  try {
    const result = await api('/api/config', { autoChat: { enabled: $('chat-enabled').checked,
      groups: $('chat-groups').value.split(/[\s,，;；]+/).filter(Boolean), cooldownSeconds: Number($('chat-cooldown').value),
      debounceSeconds: Number($('chat-debounce').value), contextMessages: Number($('chat-context').value) } });
    fillChat(result.config.autoChat); await refresh(); $('chat-save-status').textContent = '自动聊天设置已保存'; toast('自动聊天设置已保存');
  } catch (e) { toast(e.message); } finally { button.disabled = false; }
});
$('activity-save').addEventListener('click', async () => {
  const button = $('activity-save'); button.disabled = true;
  try {
    const result = await api('/api/config', { activity: { enabled: $('activity-enabled').checked, useAI: $('activity-ai').checked,
      groups: $('activity-groups').value.split(/[\s,，;；]+/).filter(Boolean), times: $('activity-times').value.split(/[\s,，;；]+/).filter(Boolean),
      quietMinutes: Number($('activity-quiet').value), style: $('activity-style').value } });
    fillActivity(result.config.activity); await refresh(); $('activity-save-status').textContent = '定时设置已保存'; toast('定时设置已保存');
  } catch (e) { toast(e.message); } finally { button.disabled = false; }
});
$('activity-preview').addEventListener('click', async () => {
  const button = $('activity-preview'); button.disabled = true; $('activity-preview-text').textContent = '正在生成预览，不会向群发消息…';
  try { const result = await api('/api/activity/preview', {}); $('activity-preview-text').textContent = result.text + '\n\n来源：' + result.source; }
  catch (e) { $('activity-preview-text').textContent = e.message; } finally { button.disabled = false; }
});
$('show-token').addEventListener('click', () => { const show = $('onebot-token').type === 'password'; $('onebot-token').type = show ? 'text' : 'password'; $('show-token').textContent = show ? '隐藏' : '显示'; });
$('download-napcat').addEventListener('click', async () => {
  try {
    const data = await api('/api/napcat'); const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'onebot11.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已下载连接配置；也可在 NapCat 管理页逐项填写');
  } catch (e) { toast(e.message); }
});
$('authorize').addEventListener('click', async () => {
  // 同页跳转，保留发起授权的本机管理会话。
  try { await save(); const result = await api('/api/workbuddy/authorize', {}); window.location.assign(result.url); } catch (e) { toast(e.message); }
});
$('cli-authorize').addEventListener('click', async () => {
  const button = $('cli-authorize'); button.disabled = true;
  try {
    await save(); $('cli-auth-status').textContent = '正在生成官方授权链接…';
    const result = await api('/api/codebuddy/authorize', {});
    if (result.url) {
      $('cli-auth-link').href = result.url; $('cli-auth-link').hidden = false;
      // 原管理页保留状态轮询，官方 CLI 也会按自身登录流程打开浏览器。
      $('cli-auth-link').click(); toast('请在官方页面确认账号登录，完成后这里会自动更新');
    } else if (result.authorized) toast('账号已授权');
    await refresh();
  } catch (e) { toast(e.message); $('cli-auth-status').textContent = e.message; }
  finally { button.disabled = false; }
});
$('cli-load-models').addEventListener('click', async () => {
  const button = $('cli-load-models'); button.disabled = true;
  try {
    const { models } = await api('/api/codebuddy/models');
    const list = $('cli-model-list'); list.replaceChildren(...models.filter(m => !$('cliFreeOnly').checked || m.free).map(m => {
      const option = document.createElement('option'); option.value = m.id; option.label = `${m.name} · ${m.credits}`; return option;
    }));
    const free = models.filter(m => m.free);
    $('cli-model-info').textContent = free.length ? `当前明确标注 0 credits：${free.map(m => m.name + ' (' + m.id + ')').join('、')}` : '当前没有明确标注为免费的可用模型。';
    if (!$('cliModel').value && free.length && $('cliFreeOnly').checked) $('cliModel').value = free[0].id;
    toast('模型列表已刷新，请保存所选模型');
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
});
$('clear-history').addEventListener('click', async () => { try { await api('/api/history/clear', {}); await refresh(); toast('对话记忆已清空'); } catch (e) { toast(e.message); } });
$('clear-secrets').addEventListener('click', async () => {
  if (!window.confirm('清除模型 API Key、WorkBuddy 应用密钥和账号授权？需要重新填写才能使用。')) return;
  try { await save({ clearSecrets: true, enabled: false }); toast('密钥与授权已清除，答疑已暂停'); } catch (e) { toast(e.message); }
});
$('load-groups').addEventListener('click', async () => {
  const button = $('load-groups'); button.disabled = true;
  try {
    const data = await api('/api/groups'); const selected = new Set($('groups').value.split(/[\s,，;；]+/).filter(Boolean));
    $('group-picker').replaceChildren(...data.groups.map(group => {
      const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(String(group.group_id));
      checkbox.addEventListener('change', () => {
        const values = new Set($('groups').value.split(/[\s,，;；]+/).filter(Boolean));
        checkbox.checked ? values.add(String(group.group_id)) : values.delete(String(group.group_id)); $('groups').value = [...values].join('\n');
      });
      label.append(checkbox, document.createTextNode(`${group.group_name} (${group.group_id})`)); return label;
    }));
    if (!data.groups.length) toast('该 QQ 尚未加入群聊');
  } catch (e) { toast(e.message); } finally { button.disabled = false; }
});
$('test-model').addEventListener('click', async () => {
  const button = $('test-model'); button.disabled = true; button.textContent = '正在生成…';
  $('test-answer').classList.remove('error'); $('test-answer').textContent = '正在连接已保存的模型配置，请稍候。WorkBuddy 云端会话首次启动可能需要较长时间。';
  try { const result = await api('/api/test', { text: $('test-question').value }); $('test-answer').textContent = result.answer; toast('模型测试成功'); }
  catch (e) { $('test-answer').textContent = e.message; $('test-answer').classList.add('error'); }
  finally { button.disabled = false; button.textContent = '测试模型 →'; await refresh().catch(() => {}); }
});
document.querySelectorAll('nav a').forEach(a => a.addEventListener('click', () => { document.querySelectorAll('nav a').forEach(x => x.classList.remove('active')); a.classList.add('active'); }));
async function init() {
  try { const state = await api('/api/state'); fill(state.config); render(state); const params = await api('/api/napcat'); $('ws-url').value = params.wsURL; $('onebot-token').value = params.token;
    if (new URLSearchParams(location.search).has('authorized')) { toast('WorkBuddy 授权成功'); history.replaceState(null, '', '/'); }
  } catch (e) { toast(e.message); }
  setInterval(() => refresh().catch(() => { $('qq-status').textContent = '服务已离线'; }), 3000);
}
init();
