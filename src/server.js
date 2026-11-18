// ローカル Web サーバー: 画面 + API + レンダラー向けストリーム中継。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Qobuz, FORMATS } from './qobuz.js';
import { Renderer, discover, describe, browse, localAddressFor, DLNA_FEATURES } from './dlna.js';

const INDEX_HTML = fileURLToPath(new URL('../public/index.html', import.meta.url));
const isLoopback = (addr = '') => addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
const str = (v, max = 500) => String(v ?? '').slice(0, max);

export async function start({
  port = Number(process.env.PORT) || 8080,
  configPath = fileURLToPath(new URL('../config.json', import.meta.url)),
  lanUi = process.env.LAN_UI === '1', // 1 のとき LAN 内の他の端末からも画面を操作できる
  fetchImpl = fetch,
} = {}) {
  let config = { appId: '', appSecret: '', token: '', userName: '', formatId: 6, rendererLocation: '' };
  try {
    Object.assign(config, JSON.parse(await readFile(configPath, 'utf8')));
  } catch {}
  const save = () => writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const qobuz = new Qobuz({ ...config, fetchImpl });
  let renderers = [];
  let devices = []; // 見つかったすべての UPnP 機器（診断表示用）
  let servers = []; // ミュージックサーバー（ContentDirectory を持つ機器）
  let renderer = null;
  const player = { queue: [], index: -1, state: 'STOPPED', position: 0, duration: 0, volume: null, error: '', notice: '' };
  const tokens = new Map(); // ストリーム URL のトークン → キューの曲
  let sawPlaying = false; // 現在の曲が一度でも再生状態になったか（自動曲送りの判定用）
  let busy = false;

  async function selectRenderer(location) {
    const info = renderers.find((r) => r.location === location) ?? (await describe(location));
    if (info?.cd && !servers.some((r) => r.location === info.location)) servers.push(info);
    if (!info?.avt) {
      throw new Error(
        info?.cd ? 'ミュージックサーバーとして追加しました（再生先としては使えない機器です）'
          : info?.openhome ? 'この機器は OpenHome 方式で動作中のため操作できません。機器側で DLNA 方式に切り替えてください'
            : 'DLNA レンダラーではありません',
      );
    }
    if (!renderers.some((r) => r.location === info.location)) renderers.push(info);
    renderer = new Renderer(info);
    config.rendererLocation = info.location;
    await save();
    player.volume = await renderer.getVolume().catch(() => null);
  }

  async function resolveFile(item) {
    // Qobuz の配信 URL は期限付きなので短時間だけ使い回す
    if (!item.file || Date.now() - item.file.at > 5 * 60_000 || item.file.formatId !== config.formatId) {
      item.file = { ...(await qobuz.fileUrl(item.id, config.formatId)), at: Date.now(), formatId: config.formatId };
    }
    return item.file;
  }

  async function playIndex(i) {
    if (!renderer) throw new Error('再生先のレンダラーを選択してください');
    const item = player.queue[i];
    if (!item) throw new Error('再生する曲がありません');
    busy = true;
    try {
      player.index = i;
      player.error = '';
      sawPlaying = false;
      player.notice = '';
      if (item.url) {
        // ミュージックサーバーの曲: レンダラーがサーバーから直接取りに行く
        await renderer.load(item);
      } else {
        const file = await resolveFile(item);
        if (file.sample) player.notice = '試聴版（30秒）のみ再生できる曲です。契約内容を確認してください。';
        const ip = await localAddressFor(renderer.host);
        const ext = file.mime.includes('mpeg') ? 'mp3' : 'flac';
        await renderer.load({ ...item, url: `http://${ip}:${port}/stream/${item.token}.${ext}`, mime: file.mime });
      }
      player.state = 'TRANSITIONING';
    } finally {
      busy = false;
    }
  }

  // レンダラーの状態を監視し、曲が終わったら次の曲を送る
  const timer = setInterval(async () => {
    if (!renderer || busy || player.index < 0) return;
    try {
      const s = await renderer.status();
      Object.assign(player, s);
      if (s.state === 'PLAYING') sawPlaying = true;
      else if (sawPlaying && (s.state === 'STOPPED' || s.state === 'NO_MEDIA_PRESENT')) {
        sawPlaying = false;
        if (player.index + 1 < player.queue.length) await playIndex(player.index + 1);
        else player.index = -1;
      }
    } catch (e) {
      player.error = e.message;
    }
  }, 1000);

  async function rediscover() {
    const found = await discover().catch(() => []);
    devices = found;
    // 手動追加・選択中の機器は探索で見つからなくても残す
    const keep = (list, f) => [...f, ...list.filter((r) => !f.some((x) => x.location === r.location))];
    renderers = keep(renderer ? [{ ...renderer }] : [], found.filter((d) => d.avt));
    servers = keep(servers, found.filter((d) => d.cd));
  }

  const api = {
    'GET /api/state': () => ({
      configured: Boolean(config.appId && config.appSecret),
      loggedIn: Boolean(qobuz.token),
      userName: config.userName,
      formatId: config.formatId,
      formats: FORMATS,
      renderers: renderers.map(({ location, name }) => ({ location, name })),
      servers: servers.map(({ location, name }) => ({ location, name })),
      devices: devices.map(({ location, name, avt, cd, openhome, services }) => ({
        location, name, renderer: Boolean(avt), server: Boolean(cd), openhome: Boolean(openhome), services,
      })),
      renderer: renderer?.location ?? '',
      ...player,
      queue: player.queue.map(({ token, file, ...t }) => t),
    }),
    'POST /api/login': async ({ appId, appSecret, email, password, token }) => {
      qobuz.appId = config.appId = str(appId || config.appId).trim();
      qobuz.appSecret = config.appSecret = str(appSecret || config.appSecret).trim();
      if (token) {
        qobuz.token = str(token).trim();
        config.userName = '';
      } else {
        qobuz.token = '';
        config.userName = (await qobuz.login(str(email).trim(), str(password))).name;
      }
      config.token = qobuz.token;
      await save();
    },
    'POST /api/logout': async () => {
      qobuz.token = config.token = config.userName = '';
      await save();
    },
    'GET /api/search': (_, q) => qobuz.search(str(q.get('q'), 200)),
    'GET /api/album': (_, q) => qobuz.album(str(q.get('id'), 100)),
    'POST /api/discover': async () => {
      await rediscover();
    },
    'GET /api/browse': (_, q) => {
      const server = servers.find((s) => s.location === q.get('server'));
      if (!server) throw new Error('ミュージックサーバーが見つかりません。再検索してください');
      return browse(server.cd, str(q.get('id') || '0', 2000));
    },
    'POST /api/renderer': ({ location }) => selectRenderer(new URL(str(location)).href),
    'POST /api/quality': async ({ formatId }) => {
      if (!FORMATS[formatId]) throw new Error('不明な音質です');
      config.formatId = Number(formatId);
      await save();
    },
    'POST /api/play': async ({ tracks, index = 0 }) => {
      if (!Array.isArray(tracks) || !tracks.length) throw new Error('曲が指定されていません');
      tokens.clear();
      player.queue = tracks.slice(0, 500).map((t) => {
        const item = {
          id: str(t.id, 40), title: str(t.title), artist: str(t.artist), album: str(t.album),
          image: str(t.image), duration: Number(t.duration) || 0, token: randomBytes(12).toString('hex'),
        };
        if (t.url) {
          const u = new URL(str(t.url, 2000));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('再生できない URL です');
          item.url = u.href;
          item.mime = /^audio\/[\w.+-]+$/.test(t.mime) ? t.mime : 'audio/mpeg';
        }
        tokens.set(item.token, item);
        return item;
      });
      await playIndex(Math.min(Math.max(0, Number(index) || 0), player.queue.length - 1));
    },
    'POST /api/control': async ({ action, value }) => {
      if (!renderer) throw new Error('再生先のレンダラーを選択してください');
      if (action === 'pause') await renderer.pause();
      else if (action === 'resume') await renderer.play();
      else if (action === 'stop') {
        player.index = -1;
        player.state = 'STOPPED';
        await renderer.stop();
      } else if (action === 'next') await playIndex(player.index + 1);
      else if (action === 'prev') await playIndex(Math.max(0, player.index - 1));
      else if (action === 'seek') await renderer.seek(Number(value) || 0);
      else if (action === 'volume') {
        await renderer.setVolume(Math.min(100, Math.max(0, Number(value) || 0)));
        player.volume = Math.round(Number(value) || 0);
      } else throw new Error('不明な操作です');
    },
  };

  async function handleStream(req, res, token) {
    const item = tokens.get(token);
    if (!item || item.url) return res.writeHead(404).end();
    const file = await resolveFile(item);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const up = await fetchImpl(file.url, { headers: req.headers.range ? { range: req.headers.range } : {}, signal: ac.signal });
    const headers = {
      'content-type': file.mime,
      'accept-ranges': 'bytes',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) headers[k] = up.headers.get(k);
    res.writeHead(up.status, headers);
    if (req.method === 'HEAD' || !up.body) {
      ac.abort();
      return res.end();
    }
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const stream = url.pathname.match(/^\/stream\/([0-9a-f]+)\.\w+$/);
      if (stream && (req.method === 'GET' || req.method === 'HEAD')) return await handleStream(req, res, stream[1]);

      // 画面と API はこのマシンからのみ（LAN_UI=1 で LAN に公開）。ストリームだけはレンダラーが取りに来る。
      if (!lanUi && !isLoopback(req.socket.remoteAddress)) return res.writeHead(403).end('Forbidden');

      if (req.method === 'GET' && url.pathname === '/') {
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(INDEX_HTML));
      }
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return res.writeHead(404).end('Not found');
      let body = {};
      if (req.method === 'POST') {
        // JSON 以外を拒否して、他サイトからのフォーム送信（CSRF）を防ぐ
        if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return res.writeHead(415).end();
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1_000_000) return res.writeHead(413).end();
        }
        body = JSON.parse(raw || '{}');
      }
      const result = (await handler(body, url.searchParams)) ?? { ok: true };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (e) {
      if (res.headersSent) return res.destroy();
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });

  await new Promise((resolve, reject) => server.once('error', reject).listen(port, resolve));
  port = server.address().port;

  // 前回のレンダラーを復元しつつ、ネットワークを探索しておく
  (async () => {
    await rediscover();
    if (config.rendererLocation) await selectRenderer(config.rendererLocation).catch(() => {});
  })();

  return { port, close: () => (clearInterval(timer), server.close()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await start();
  console.log(`DLNA Music Player: http://localhost:${port}`);
}
