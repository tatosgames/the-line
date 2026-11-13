// Usage: node tools/pixi-benchmark.mjs --baseline <pinned worktree> --out <evidence directory>
// Add --quick for a short headless comparison, --entry-only --smoke-dist dist
// for a production entry smoke, or --device android for a connected physical device.
// Set CHROME_PATH or ADB_PATH to override discovery. Run with Node >= 22.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { build } from 'vite';

const baselineCommit = '8789a44fe6151467490a9fe4618bca43fca6cbf3';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values: options } = parseArgs({ options: {
  baseline: { type: 'string' },
  out: { type: 'string' },
  device: { type: 'string', default: 'desktop' },
  quick: { type: 'boolean', default: false },
  'baseline-only': { type: 'boolean', default: false },
  port: { type: 'string', default: '4182' },
  serial: { type: 'string' },
  'smoke-dist': { type: 'string' },
  'gl-diagnostics': { type: 'boolean', default: false },
  'entry-only': { type: 'boolean', default: false },
  'headless-desktop': { type: 'boolean', default: false },
} });
if (!options.baseline || !options.out || !['desktop', 'android'].includes(options.device)) {
  throw new Error('Provide --baseline <pinned worktree> --out <evidence directory> [--device desktop|android]');
}
if (options.quick && options.device === 'android') throw new Error('Use desktop for --quick mode.');
if (options['headless-desktop'] && options.device !== 'desktop') throw new Error('Use desktop for --headless-desktop.');
if (options['entry-only'] && !options['smoke-dist']) throw new Error('Provide --smoke-dist for --entry-only.');
const baseline = resolve(options.baseline);
const out = resolve(options.out);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (git(baseline, 'rev-parse', 'HEAD') !== baselineCommit || git(baseline, 'status', '--porcelain', '--untracked-files=no')) {
  throw new Error('The baseline worktree must be at the pinned Canvas commit with clean tracked files.');
}
const temp = await mkdtemp(join(await realpath(tmpdir()), 'the-line-pixi-'));
await mkdir(out, { recursive: true });

async function buildPage(checkout, backend) {
  const folder = join(temp, backend);
  const html = await readFile(join(checkout, 'index.html'), 'utf8');
  // Keep the baseline's real canvas styles and fonts, replace only the entry module.
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), html
    .replace(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\s*/g, '')
    .replace(/<script type="module"[^>]*><\/script>/, '<script type="module" src="/entry.mjs"></script>'));
  await build({
    configFile: false,
    root: folder,
    base: './',
    publicDir: false,
    logLevel: 'warn',
    define: { __BUILD_DATE__: JSON.stringify('benchmark'), __VERSION__: JSON.stringify('0.1.0') },
    resolve: { alias: { '@bench': join(checkout, 'src') } },
    plugins: [{
      name: 'the-line-benchmark-entry',
      resolveId(id) {
        if (id === '/entry.mjs' || id.endsWith(sep + 'entry.mjs')) return join(root, 'tools', 'pixi-benchmark-page.mjs');
        if (id === 'benchmark:pixi') return backend === 'pixi' ? join(root, 'src', 'game', 'pixiRenderer.ts') : '\0benchmark:canvas';
      },
      load(id) {
        if (id === '\0benchmark:canvas') return 'export function createPixiRenderer() { throw new Error("Canvas build"); }';
      },
    }],
    build: { outDir: join(folder, 'dist'), target: 'es2022' },
  });
}

const backends = options['entry-only'] ? [] : options['baseline-only'] ? ['canvas'] : ['canvas', 'pixi'];
try {
  for (const backend of backends) await buildPage(backend === 'canvas' ? baseline : root, backend);
} catch (error) {
  await rm(temp, { recursive: true, force: true });
  throw error;
}
const gameDist = options['smoke-dist'] && resolve(options['smoke-dist']);

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const [, backend, ...rest] = path.split('/');
  const dir = backend === 'game' && gameDist ? gameDist : join(temp, backend, 'dist');
  const file = resolve(dir, ...(rest.some(Boolean) ? rest : ['index.html']));
  if ((!backends.includes(backend) && !(backend === 'game' && gameDist)) || !file.startsWith(dir + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolveListen, reject) => server.once('error', reject).listen(Number(options.port), '127.0.0.1', resolveListen));
const port = server.address().port;

async function until(action, deadline = 15000) {
  const stop = Date.now() + deadline;
  let last;
  do {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(150);
  } while (Date.now() < stop);
  throw new Error('Timed out waiting for benchmark browser', { cause: last });
}

let child;
let adb;
let androidSerial;
let androidReverse = false;
let debugPort;
const runAdb = (...args) => execFileSync(adb, args, { encoding: 'utf8' }).trim();

async function browserPort() {
  if (options.device === 'android') {
    adb = process.env.ADB_PATH || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')) || 'adb';
    const devices = runAdb('devices', '-l').split(/\r?\n/).slice(1);
    const usable = devices.filter((line) => /^\S+\s+device\s/.test(line)).map((line) => line.split(/\s+/)[0]);
    androidSerial = options.serial || (usable.length === 1 ? usable[0] : null);
    if (!androidSerial || !usable.includes(androidSerial) || androidSerial.startsWith('emulator-')) {
      throw new Error('Connect one authorized physical Android device, or pass --serial to select it.');
    }
    const reverse = runAdb('-s', androidSerial, 'reverse', '--list');
    if (reverse.split(/\r?\n/).some((line) => line.split(/\s+/)[1] === 'tcp:' + port)) {
      throw new Error('The Android reverse port is already in use. Pass a different --port.');
    }
    runAdb('-s', androidSerial, 'reverse', 'tcp:' + port, 'tcp:' + port);
    androidReverse = true;
    debugPort = Number(runAdb('-s', androidSerial, 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'));
    return debugPort;
  }
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const chrome = candidates.find((path) => path && existsSync(path));
  if (!chrome) throw new Error('Set CHROME_PATH to the installed Chrome executable.');
  const profile = join(temp, 'chrome-profile');
  child = spawn(chrome, [
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1360,840',
    ...(options.quick ? ['--headless=new', '--enable-unsafe-swiftshader']
      : options['headless-desktop'] ? ['--headless=new', '--enable-gpu'] : []),
    'about:blank',
  ], { stdio: 'ignore', windowsHide: options.quick || options['headless-desktop'] });
  child.on('error', (error) => console.error(error));
  return until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]));
}

class CDP {
  next = 0;
  requests = new Map();
  listeners = new Map();
  constructor(url) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const cb = this.requests.get(message.id);
        this.requests.delete(message.id);
        cb?.(message);
      } else this.listeners.get(message.method)?.(message.params);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.next;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('CDP timed out: ' + method));
      }, 105000);
      this.requests.set(id, ({ error, result }) => {
        clearTimeout(timer);
        if (error) reject(new Error(method + ': ' + error.message));
        else resolveResult(result);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
}

const stamp = () => new Date().toISOString();
const p95 = (xs) => {
  if (!xs.length) throw new Error('No samples collected');
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = (run) => ({ cpuP95: p95(run.cpu), frameP95: p95(run.intervals), frames: run.cpu.length });
const scenes = { title: 370, normal: 730, dense: 1900, boss: 1000, nostalgia: 730 };
const requestedScenes = process.env.THE_LINE_BENCHMARK_SCENE && options.quick
  ? Object.fromEntries(process.env.THE_LINE_BENCHMARK_SCENE.split(',').map((scene) => [scene, scenes[scene]]))
  : scenes;
if (Object.values(requestedScenes).includes(undefined)) throw new Error('Unknown THE_LINE_BENCHMARK_SCENE.');
const captureNames = Math.random() < 0.5 ? { canvas: 'A', pixi: 'B' } : { canvas: 'B', pixi: 'A' };
const evidence = {
  baselineCommit,
  candidateCommit: git(root, 'rev-parse', 'HEAD'),
  candidateStatus: git(root, 'status', '--porcelain'),
  rendererSourceHash: createHash('sha256').update(await readFile(join(root, 'src/game/pixiRenderer.ts')).catch(() => '')).digest('hex'),
  mode: options.quick ? 'headless smoke' : options['headless-desktop'] ? 'headless desktop supplemental' : options.device,
  recordedAt: stamp(),
  workload: { simulationHz: 120, maxRenderHz: 60, bloom: false, audio: false, lifeBudget: 20, warmupSeconds: options.quick ? 1 : 8 },
  samples: [],
  captures: {},
};
let cdp;
try {
  const remote = 'http://127.0.0.1:' + await browserPort();
  const version = await until(async () => (await fetch(remote + '/json/version')).json());
  evidence.browser = version.Browser;
  if (version.webSocketDebuggerUrl) {
    const browser = new CDP(version.webSocketDebuggerUrl);
    try {
      const { gpu } = await browser.send('SystemInfo.getInfo');
      evidence.gpu = { devices: gpu.devices, featureStatus: gpu.featureStatus, renderer: gpu.auxAttributes?.glRenderer };
    } catch (error) {
      evidence.gpuInspectionError = String(error);
    } finally {
      browser.socket.close();
    }
  }
  if (androidSerial) {
    evidence.device = runAdb('-s', androidSerial, 'shell', 'getprop', 'ro.product.model');
    evidence.androidRelease = runAdb('-s', androidSerial, 'shell', 'getprop', 'ro.build.version.release');
    const qemu = runAdb('-s', androidSerial, 'shell', 'getprop', 'ro.kernel.qemu');
    if (qemu === '1') throw new Error('Android gate requires physical hardware.');
  } else evidence.device = process.env.COMPUTERNAME || process.platform;
  const page = await until(async () => (await (await fetch(remote + '/json/new?about:blank', { method: 'PUT' })).json()));
  cdp = new CDP(page.webSocketDebuggerUrl);
  const errors = [];
  const warnings = new Set();
  evidence.browserErrors = errors;
  cdp.listeners.set('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  cdp.listeners.set('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'warning' || type === 'error') warnings.add(args.map(({ value, description }) => value ?? description ?? '').join(' '));
  });
  cdp.listeners.set('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'warning' || entry.level === 'error') warnings.add(entry.text);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.bringToFront');
  if (!androidSerial) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  let current;
  async function open(backend) {
    if (current === backend) return;
    const url = 'http://127.0.0.1:' + port + '/' + backend + '/?renderer=' + backend
      + (options['gl-diagnostics'] ? '&gl-diagnostics' : '');
    await cdp.send('Page.navigate', { url });
    try {
      await until(() => cdp.eval('location.href === ' + JSON.stringify(url) + ' && window.benchmark?.renderer === ' + JSON.stringify(backend)));
    } catch (error) {
      if (errors.length) throw new Error(errors.join('\n'), { cause: error });
      throw error;
    }
    current = backend;
  }
  const measure = async (scene, seconds, warmup) => {
    await cdp.send('Page.bringToFront');
    try {
      return await cdp.eval('benchmark.measure(' + [JSON.stringify(scene), seconds, warmup].join(',') + ')');
    } catch (error) {
      const visibility = await cdp.eval('document.visibilityState').catch(() => 'unknown');
      throw new Error(`Measurement for ${current}/${scene} failed (document visibility: ${visibility}): ${error.message}`, { cause: error });
    }
  };
  async function compareRenderers() {
    await open('canvas');
    evidence.probes = {};
    for (const scene of options['gl-diagnostics'] && options.quick ? ['normal'] : ['normal', 'dense', 'boss']) {
      evidence.probes[scene] = summary(await measure(scene, options.quick ? 2 : 8, options.quick ? 1 : 4));
    }
    const stress = Object.keys(evidence.probes).sort((a, b) => evidence.probes[b].cpuP95 - evidence.probes[a].cpuP95)[0];
    evidence.stressScene = stress;

    for (const backend of backends) {
      await open(backend);
      evidence.captures[backend] = {};
      for (const [scene, step] of Object.entries(requestedScenes)) {
        const data = await cdp.eval('benchmark.capture(' + JSON.stringify(scene) + ',' + step + ')');
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const name = scene + '-' + captureNames[backend] + '.png';
        await writeFile(join(out, name), Buffer.from(screenshot.data, 'base64'));
        evidence.captures[backend][scene] = { image: name, ...data };
      }
    }
    evidence.browserWarnings = [...warnings];
    for (const backend of backends) {
      for (const [scene, data] of Object.entries(evidence.captures[backend])) {
        const reference = evidence.captures.canvas[scene].state;
        const different = Object.keys(reference).filter((key) => JSON.stringify(reference[key]) !== JSON.stringify(data.state[key]));
        if (different.length) throw new Error('Replay diverged in ' + backend + ': ' + scene + ' (' + different.join(', ') + ')');
        if (JSON.stringify(data.viewport) !== JSON.stringify(evidence.captures.canvas[scene].viewport)) throw new Error('Viewport/backing size differs for ' + backend + ': ' + scene);
      }
    }
    evidence.matchedReplay = backends.length > 1;

    const runs = options.quick ? 1 : 3;
    for (let i = 0; i < runs; i++) {
      for (const backend of i % 2 === 0 ? backends : [...backends].reverse()) {
        await open(backend);
        const run = await measure(stress, options.quick ? 2 : 30, evidence.workload.warmupSeconds);
        const metrics = summary(run);
        evidence.samples.push({ backend, round: i + 1, ...metrics, raw: run });
        console.log(backend, 'round', i + 1, stress, metrics);
      }
    }
    evidence.medians = Object.fromEntries(backends.map((backend) => {
      const entries = evidence.samples.filter((run) => run.backend === backend);
      return [backend, { cpuP95: median(entries.map((run) => run.cpuP95)), frameP95: median(entries.map((run) => run.frameP95)) }];
    }));
    if (evidence.medians.pixi) {
      evidence.relative = {
        cpuReduction: 1 - evidence.medians.pixi.cpuP95 / evidence.medians.canvas.cpuP95,
        frameRegression: evidence.medians.pixi.frameP95 / evidence.medians.canvas.frameP95 - 1,
      };
      const frameGate = evidence.relative.frameRegression <= 0.05;
      const cpuGate = options.device !== 'android' || evidence.relative.cpuReduction >= 0.20;
      evidence.performanceGate = options.quick || options['headless-desktop'] ? 'supplemental only' : frameGate && cpuGate ? 'pass' : 'fail';
    }

    if (!options.quick) {
      // Trace a separate sample so tracing overhead cannot affect the scored runs.
      for (const backend of backends) {
        await open(backend);
        const completion = new Promise((done, reject) => {
          const timeout = setTimeout(() => reject(new Error('Trace collection timed out')), 30000);
          cdp.listeners.set('Tracing.tracingComplete', (result) => { clearTimeout(timeout); done(result); });
        });
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' });
        await measure(stress, 5, 3);
        await cdp.send('Tracing.end');
        const { stream } = await completion;
        const chunks = [];
        let eof;
        do {
          const result = await cdp.send('IO.read', { handle: stream });
          chunks.push(result.base64Encoded ? Buffer.from(result.data, 'base64') : Buffer.from(result.data));
          eof = result.eof;
        } while (!eof);
        await cdp.send('IO.close', { handle: stream });
        await writeFile(join(out, backend + '-trace.json'), Buffer.concat(chunks));
      }
    }
  }
  if (backends.length) await compareRenderers();
  if (gameDist) {
    const url = 'http://127.0.0.1:' + port + '/game/';
    evidence.entrySmoke = {};
    const navigate = (query = '') => cdp.send('Page.navigate', { url: url + query });
    const renderer = (name) => until(() => cdp.eval(
      `document.querySelector('#view')?.dataset.renderer === '${name}'`));
    await navigate();
    await renderer('canvas');
    evidence.entrySmoke.defaultCanvas = true;
    await navigate('?renderer=pixi');
    await renderer('pixi');
    evidence.entrySmoke.pixiOptIn = true;
    const click = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    await cdp.eval("localStorage.removeItem('the-line-bloom')");
    await navigate('?renderer=pixi&bloom=check');
    await until(() => cdp.eval("location.search.includes('bloom=check') && document.querySelector('#view')?.dataset.renderer === 'pixi'"));
    // Speaker icon and Bloom row in a 1280×720 world, matching the production HUD layout.
    if (options.device === 'desktop') {
      await delay(250);
      await click(1234, 36);
      await delay(120);
      const bloomY = await cdp.eval(`(() => {
        const fullscreen = document.fullscreenEnabled && !matchMedia('(display-mode: standalone)').matches;
        const row = fullscreen ? 5 : 4;
        const height = 2.8 + (row + 1) * 1.55 + 1.65;
        const s = Math.min(720 * 0.045 * 1.35, 720 * 0.9 / height);
        return (720 - s * height) / 2 + s * (2.8 + row * 1.55);
      })()`);
      await click(720, bloomY);
      await until(() => cdp.eval("localStorage.getItem('the-line-bloom') === '1'"));
      await click(720, bloomY);
      await until(() => cdp.eval("localStorage.getItem('the-line-bloom') === '0'"));
      evidence.entrySmoke.bloomToggle = true;
    }
    await cdp.eval(`(() => {
      const canvas = document.querySelector('#view');
      const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Cannot force WebGL context loss');
      extension.loseContext();
    })()`);
    await renderer('canvas');
    evidence.entrySmoke.contextLossFallback = true;

    const blockWebGl = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (kind === 'webgl' || kind === 'webgl2') return null;
        return getContext.call(this, kind, ...args);
      };
    }` });
    await navigate('?renderer=pixi&context=disabled');
    await until(() => cdp.eval("location.search.includes('context=disabled') && document.querySelector('#view')?.dataset.renderer === 'canvas'"));
    evidence.entrySmoke.webGlInitializationFallback = true;
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', blockWebGl);

    if (options.device === 'desktop') {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      await navigate('?renderer=pixi&portrait=check');
      await until(() => cdp.eval("location.search.includes('portrait=check') && document.querySelector('#view')?.dataset.renderer === 'pixi'"));
      await delay(1200);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await delay(900);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
      await touch('touchStart', 75, 710);
      await touch('touchMove', 145, 710);
      await delay(400);
      await touch('touchEnd');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(join(out, 'portrait-pixi.png'), Buffer.from(data, 'base64'));
      evidence.entrySmoke.portraitCapture = 'portrait-pixi.png';
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    }

    await navigate('?renderer=canvas&offline=prepare');
    await until(() => cdp.eval("location.search.includes('offline=prepare') && !!navigator.serviceWorker.controller"));
    const sounds = await cdp.eval(`(async () => {
      const response = await fetch('./assets/sounds-packed/manifest.json');
      if (!response.ok) throw new Error('Packed sound manifest unavailable');
      const manifest = await response.json();
      return ['./assets/sounds-packed/' + manifest.appear[0], './assets/sounds/compare.wav'];
    })()`);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    try {
      await navigate('?renderer=canvas&offline=check');
      await until(() => cdp.eval("location.search.includes('offline=check') && document.querySelector('#view')?.dataset.renderer === 'canvas'"));
      evidence.entrySmoke.offlineAudio = await cdp.eval(`(async () => {
        const context = new AudioContext();
        try {
          for (const url of ${JSON.stringify(sounds)}) {
            const response = await fetch(url);
            if (!response.ok) return false;
            if (!(await context.decodeAudioData(await response.arrayBuffer())).duration) return false;
          }
          return true;
        } finally {
          await context.close();
        }
      })()`);
      if (!evidence.entrySmoke.offlineAudio) throw new Error('Offline sample decode failed');
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  }
  if (errors.length) throw new Error('Browser exceptions: ' + errors.join('\n'));
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await writeFile(join(out, 'metrics.json'), JSON.stringify(evidence, null, 2) + '\n');
  cdp?.socket.close();
  child?.kill();
  try {
    if (androidSerial && debugPort) runAdb('-s', androidSerial, 'forward', '--remove', 'tcp:' + debugPort);
    if (androidReverse) runAdb('-s', androidSerial, 'reverse', '--remove', 'tcp:' + port);
  } finally {
    server.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error) => console.warn(error.message));
  }
}
