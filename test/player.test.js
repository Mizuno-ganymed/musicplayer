// 偽の Qobuz API と偽の DLNA レンダラーを立てて、検索 → 再生 → 中継 → 自動曲送りまでを通しで確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';
import { fileUrlSignature } from '../src/qobuz.js';
import { didl, parseTime, formatTime } from '../src/dlna.js';

const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
const readBody = async (req) => {
  let b = '';
  for await (const c of req) b += c;
  return b;
};

test('getFileUrl の署名', () => {
  const expected = createHash('md5').update('trackgetFileUrlformat_id6intentstreamtrack_id1231700000000sec').digest('hex');
  assert.equal(fileUrlSignature(123, 6, 1700000000, 'sec'), expected);
});

test('時間と DIDL の整形', () => {
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(parseTime('0:03:20.500'), 200);
  assert.equal(parseTime('NOT_IMPLEMENTED'), 0);
  const xml = didl({ url: 'http://x/a?b=1&c=2', mime: 'audio/flac', title: 'A & B <live>', artist: 'X', album: 'Y', duration: 65 });
  assert.match(xml, /A &amp; B &lt;live&gt;/);
  assert.match(xml, /duration="0:01:05.000"/);
  assert.match(xml, /b=1&amp;c=2/);
});

const LIBRARY = `<DIDL-Lite><container id="64" parentID="0"><dc:title>Jazz &amp; Blues</dc:title><upnp:class>object.container</upnp:class></container>
<item id="t1"><dc:title>Local Song</dc:title><upnp:artist>Someone</upnp:artist><upnp:album>Disc</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class>
<res protocolInfo="http-get:*:audio/x-flac:DLNA.ORG_OP=01" duration="0:04:05.000">http://10.0.0.5:9000/disk/1.flac?a=1&amp;b=2</res></item>
<item id="p1"><dc:title>Photo</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><res protocolInfo="http-get:*:image/jpeg:*">http://10.0.0.5/1.jpg</res></item></DIDL-Lite>`;

test('検索して再生し、曲が終わると次の曲を送る', async () => {
  // --- 偽レンダラー ---
  const actions = [];
  let transport = 'STOPPED';
  const renderer = await listen(async (req, res) => {
    if (req.url === '/desc.xml') {
      return res.end(`<root><device><friendlyName>Fake &amp; Renderer</friendlyName><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/ctl/avt</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctl/rc</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>/ctl/cd</controlURL></service>
      </serviceList></device></root>`);
    }
    const body = await readBody(req);
    const action = req.headers.soapaction.match(/#(\w+)"/)[1];
    if (!action.startsWith('Get')) actions.push({ action, body });
    if (action === 'Play') transport = 'PLAYING';
    const out = {
      GetTransportInfo: `<CurrentTransportState>${transport}</CurrentTransportState>`,
      GetPositionInfo: `<TrackDuration>0:03:00</TrackDuration><RelTime>0:00:42</RelTime>`,
      GetVolume: `<CurrentVolume>30</CurrentVolume>`,
      Browse: `<Result>${LIBRARY.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Result><NumberReturned>3</NumberReturned><TotalMatches>3</TotalMatches>`,
    }[action] ?? '';
    res.end(`<s:Envelope><s:Body><u:${action}Response>${out}</u:${action}Response></s:Body></s:Envelope>`);
  });
  const rendererUrl = `http://127.0.0.1:${renderer.address().port}/desc.xml`;

  // --- 偽 Qobuz（fetch を差し替え）---
  const audio = Buffer.from('0123456789');
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/user/login')) {
      assert.equal(u.searchParams.get('password'), createHash('md5').update('pw').digest('hex'));
      return json({ user_auth_token: 'TOKEN', user: { display_name: 'Tester' } });
    }
    if (u.pathname.endsWith('/catalog/search')) {
      assert.equal(opts.headers['X-User-Auth-Token'], 'TOKEN');
      const album = { id: 'al1', title: 'Album', artist: { name: 'Artist' }, image: { large: 'http://img/1.jpg' }, tracks_count: 2 };
      return json({ albums: { items: [album] }, tracks: { items: [1, 2].map((id) => ({ id, title: `Song ${id}`, duration: 180, performer: { name: 'Artist' }, album })) } });
    }
    if (u.pathname.endsWith('/track/getFileUrl')) {
      const p = u.searchParams;
      assert.equal(p.get('request_sig'), fileUrlSignature(p.get('track_id'), p.get('format_id'), p.get('request_ts'), 'SECRET'));
      return json({ url: `https://cdn.example/file${p.get('track_id')}`, mime_type: 'audio/flac' });
    }
    if (u.hostname === 'cdn.example') {
      const range = opts.headers?.range;
      if (range) return new Response(audio.subarray(2, 5), { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3' } });
      return new Response(audio, { headers: { 'content-length': '10' } });
    }
    throw new Error('unexpected fetch ' + url);
  };

  const dir = await mkdtemp(join(tmpdir(), 'qdp-'));
  const app = await start({ port: 0, configPath: join(dir, 'config.json'), fetchImpl });
  const base = `http://127.0.0.1:${app.port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const get = async (path) => (await fetch(base + path)).json();

  try {
    // JSON 以外の POST は拒否される
    assert.equal((await fetch(base + '/api/logout', { method: 'POST', body: 'x' })).status, 415);

    assert.equal((await post('/api/login', { appId: 'APP', appSecret: 'SECRET', email: 'a@b.c', password: 'pw' })).status, 200);
    const found = await get('/api/search?q=song');
    assert.equal(found.tracks.length, 2);
    assert.equal(found.albums[0].artist, 'Artist');

    // レンダラー未選択なら再生できない
    assert.match((await post('/api/play', { tracks: found.tracks })).json.error, /レンダラー/);

    assert.equal((await post('/api/renderer', { location: rendererUrl })).status, 200);
    let st = await get('/api/state');
    assert.equal(st.renderers[0].name, 'Fake & Renderer');
    assert.equal(st.volume, 30);

    assert.equal((await post('/api/play', { tracks: found.tracks, index: 0 })).status, 200);
    assert.deepEqual(actions.map((a) => a.action), ['SetAVTransportURI', 'Play']);
    const streamUrl = actions[0].body.match(/<CurrentURI>(.*?)<\/CurrentURI>/)[1];
    assert.match(streamUrl, /^http:\/\/127\.0\.0\.1:\d+\/stream\/[0-9a-f]{24}\.flac$/);
    assert.match(actions[0].body, /Song 1/);

    // レンダラーが取りに来るストリーム（全体 / Range / 不正トークン）
    const full = await fetch(streamUrl);
    assert.equal(full.headers.get('content-type'), 'audio/flac');
    assert.equal(await full.text(), '0123456789');
    const part = await fetch(streamUrl, { headers: { range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '234');
    assert.equal((await fetch(`${base}/stream/${'0'.repeat(24)}.flac`)).status, 404);

    // 再生状態が反映され、停止を検知すると 2 曲目が送られる
    await new Promise((r) => setTimeout(r, 1300));
    st = await get('/api/state');
    assert.equal(st.state, 'PLAYING');
    assert.equal(st.position, 42);
    transport = 'STOPPED';
    await new Promise((r) => setTimeout(r, 1500));
    st = await get('/api/state');
    assert.equal(st.index, 1);
    assert.match(actions.at(-2).body, /Song 2/);

    // ミュージックサーバーの閲覧と、その曲の再生（URL はそのままレンダラーへ渡る）
    assert.equal(st.servers[0].name, 'Fake & Renderer');
    const lib = await get(`/api/browse?server=${encodeURIComponent(rendererUrl)}&id=0`);
    assert.deepEqual(lib.containers, [{ id: '64', title: 'Jazz & Blues', image: '' }]);
    assert.equal(lib.tracks.length, 1);
    assert.deepEqual(
      { ...lib.tracks[0] },
      { id: 't1', title: 'Local Song', artist: 'Someone', album: 'Disc', image: '', duration: 245, url: 'http://10.0.0.5:9000/disk/1.flac?a=1&b=2', mime: 'audio/x-flac' },
    );
    assert.equal((await post('/api/play', { tracks: lib.tracks })).status, 200);
    assert.match(actions.at(-2).body, /<CurrentURI>http:\/\/10\.0\.0\.5:9000\/disk\/1\.flac\?a=1&amp;b=2<\/CurrentURI>/);
    assert.match(actions.at(-2).body, /audio\/x-flac/);
    assert.equal((await post('/api/play', { tracks: [{ ...lib.tracks[0], url: 'file:///etc/passwd' }] })).status, 400);

    await post('/api/control', { action: 'volume', value: 55 });
    assert.match(actions.at(-1).body, /<DesiredVolume>55<\/DesiredVolume>/);
    await post('/api/control', { action: 'stop' });
    assert.equal(actions.at(-1).action, 'Stop');
    assert.equal((await get('/api/state')).index, -1);
  } finally {
    app.close();
    renderer.close();
  }
});
