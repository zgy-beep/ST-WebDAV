/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖）
 * ------------------------------------------------------------------
 * 浏览器冒烟测试需要真实浏览器验证 ui-kit 运行时（DOM/CSS/玻璃降级），
 * 但项目不想引入 playwright/puppeteer 这类重型依赖与浏览器下载。
 * 这里只用 Node 内置 WebSocket 连接系统 Chrome 的 remote-debugging 端口。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * 查找本机可用的 Chrome / Edge；找不到返回 null（调用方应 skip 测试）
 * @returns {string | null}
 */
export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = process.platform === 'win32'
    ? WINDOWS_CANDIDATES
    : process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 启动 headless Chrome 并连接页面 target
 * @param {{ extraArgs?: string[] }} [options]
 * @returns {Promise<{ cdp: { ws: WebSocket, send: Function }, close: () => Promise<void> }>}
 */
export async function launchChrome(options = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Edge，可通过 CHROME_PATH 指定');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-webdav-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    ...(options.extraArgs || []),
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });

  // Chrome 就绪后会把调试端口写入 user-data-dir/DevToolsActivePort
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(portFile)) {
      const [firstLine] = fs.readFileSync(portFile, 'utf-8').trim().split(/\r?\n/);
      port = Number(firstLine);
      if (port) break;
    }
    await sleep(100);
  }

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };

  if (!port) {
    cleanup();
    throw new Error('Chrome 调试端口未就绪');
  }

  let pageWsUrl = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) { pageWsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(100);
  }
  if (!pageWsUrl) {
    cleanup();
    throw new Error('未找到可调试的页面 target');
  }

  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  return {
    cdp: { ws, send },
    async close() {
      try { await send('Browser.close'); } catch {}
      try { ws.close(); } catch {}
      cleanup();
    },
  };
}

/**
 * 在页面上下文求值并返回 JSON 结果
 * @param {{ send: Function }} cdp
 * @param {string} expression
 * @returns {Promise<any>}
 */
export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面脚本异常: ${result.exceptionDetails.text || 'unknown'}`);
  }
  return result.result.value;
}

/**
 * 轮询等待页面表达式返回真值
 * @param {{ send: Function }} cdp
 * @param {string} expression
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>}
 */
export async function waitFor(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(`等待页面条件超时: ${expression}`);
}
