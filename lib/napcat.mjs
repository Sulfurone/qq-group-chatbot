import { readdir, readFile, writeFile, mkdir, open, cp } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = result => { if (!done) { done = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(350, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
export class NapCatManager {
  constructor(root, dataDir, connectionConfig) {
    this.root = root; this.dataDir = dataDir; this.connectionConfig = connectionConfig;
    this.child = null; this.lastError = ''; this.cached = null; this.startedAt = 0;
  }
  async locate() {
    if (this.cached) return this.cached;
    const candidates = [];
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) candidates.push({ dir: path.join(process.env.LOCALAPPDATA, 'QQGroupQA/engine'), depth: 0 });
    candidates.push({ dir: this.root, depth: 0 });
    for (let index = 0; index < candidates.length && index < 80; index++) {
      const { dir, depth } = candidates[index];
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      if (entries.some(x => x.name === 'NapCatWinBootMain.exe' && x.isFile()) && !/[\\/]bootmain$/i.test(dir)) {
        this.cached = dir; return dir;
      }
      if (depth < 3) for (const entry of entries) if (entry.isDirectory() && !['bootmain', 'node_modules', 'resources', 'locales', 'logs', 'data'].includes(entry.name)) candidates.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
    return null;
  }
  async configDir() {
    const dir = await this.locate(); if (!dir) return null;
    const versions = await readdir(path.join(dir, 'versions'), { withFileTypes: true }).catch(() => []);
    const versionConfigs = versions.filter(x => x.isDirectory()).map(x => path.join(dir, 'versions', x.name, 'resources/app/napcat/config'));
    for (const candidate of [...versionConfigs, path.join(dir, 'napcat/config'), path.join(dir, 'resources/app/app_launcher/napcat/config'), path.join(dir, 'config')]) {
      try { const entries = await readdir(candidate); if (entries.some(x => /webui|onebot|napcat/i.test(x))) return candidate; } catch {}
    }
    return versionConfigs[0] || path.join(dir, 'napcat/config');
  }
  async webConfig() {
    const dir = await this.configDir();
    if (dir) try { const config = JSON.parse(await readFile(path.join(dir, 'webui.json'), 'utf8')); return { port: Number(config.port) || 6099, token: config.token || '' }; } catch {}
    return { port: 6099, token: '' };
  }
  async status() {
    const dir = await this.locate(); const config = await this.webConfig(); const ready = await listening(config.port);
    return { installed: !!dir, ready, starting: !!this.child && !ready, port: config.port, error: this.lastError };
  }
  async start() {
    const status = await this.status(); if (status.ready || status.starting) return status;
    let dir = await this.locate(); if (!dir) throw new Error('QQ 组件仍未安装完成，请等待安装结束后再启动');
    // QQ 原生组件不兼容中文安装路径；目录联接仍会被组件解析回中文路径，须使用实际副本。
    if (process.platform === 'win32' && process.env.LOCALAPPDATA && /[^\x00-\x7f]/.test(dir)) {
      const destination = path.join(process.env.LOCALAPPDATA, 'QQGroupQA/engine', path.basename(dir));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(dir, destination, { recursive: true, force: false, errorOnExist: false });
      dir = destination; this.cached = destination;
    }
    const configDir = await this.configDir(); await mkdir(configDir, { recursive: true });
    const shellDir = path.dirname(configDir); const launchDir = dir; const launchShell = shellDir;
    const webFile = path.join(configDir, 'webui.json');
    let web = {};
    try { web = JSON.parse(await readFile(webFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (web.host !== '127.0.0.1') { web.host = '127.0.0.1'; await writeFile(webFile, JSON.stringify(web, null, 2)); }
    // 独立安装目录的新配置；不覆盖已有帐号的其他连接。
    const defaultFile = path.join(configDir, 'onebot11.json');
    try { await readFile(defaultFile); } catch (e) { if (e.code !== 'ENOENT') throw e; await writeFile(defaultFile, JSON.stringify(this.connectionConfig(), null, 2)); }
    await mkdir(this.dataDir, { recursive: true });
    const out = await open(path.join(this.dataDir, 'napcat.stdout.log'), 'a');
    const err = await open(path.join(this.dataDir, 'napcat.stderr.log'), 'a');
    this.lastError = ''; this.startedAt = Date.now();
    try {
      const child = spawn(path.join(launchShell, 'NapCatWinBootMain.exe'), [path.join(launchDir, 'QQ.exe'), path.join(launchShell, 'NapCatWinBootHook.dll')], {
        cwd: launchShell, windowsHide: true, detached: true, stdio: ['ignore', out.fd, err.fd],
        env: { ...process.env, NAPCAT_PATCH_PACKAGE: path.join(launchShell, 'qqnt.json'), NAPCAT_LOAD_PATH: path.join(launchShell, 'loadNapCat.js'),
          NAPCAT_INJECT_PATH: path.join(launchShell, 'NapCatWinBootHook.dll'), NAPCAT_LAUNCHER_PATH: path.join(launchShell, 'NapCatWinBootMain.exe'), NAPCAT_MAIN_PATH: path.join(launchShell, 'napcat.mjs') }
      });
      this.child = child;
      child.once('error', e => { this.lastError = 'QQ 连接服务启动失败：' + e.message; if (this.child === child) this.child = null; });
      child.once('exit', code => { if (code) this.lastError = `QQ 连接服务退出，错误码 ${code}。请查看 data/napcat.stderr.log。`; if (this.child === child) this.child = null; });
      child.unref();
    } finally { await out.close(); await err.close(); }
    return { ...status, starting: true };
  }
  async loginURL() {
    const config = await this.webConfig();
    if (!await listening(config.port)) throw new Error('QQ 登录服务尚未就绪，请先点击「启动 QQ 登录服务」并等待');
    return `http://127.0.0.1:${config.port}/webui${config.token ? '?token=' + encodeURIComponent(config.token) : ''}`;
  }
}
