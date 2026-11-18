// DLNA / UPnP AV のコントロールポイント（レンダラー探索と AVTransport 操作）。
import dgram from 'node:dgram';

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CD = 'urn:schemas-upnp-org:service:ContentDirectory:1';
export const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

export const xmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const xmlUnescape = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? xmlUnescape(m[1].trim()) : undefined;
};

/** SSDP でネットワーク上のレンダラーとミュージックサーバーの description URL を集める */
export function ssdpSearch(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try { sock.close(); } catch {}
      resolve([...found]);
    };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const m = msg.toString().match(/^location:\s*(\S+)/im);
      if (m) found.add(m[1]);
    });
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:device:MediaServer:1', AVT]) {
        const req = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
        );
        for (let i = 0; i < 2; i++) sock.send(req, 1900, '239.255.255.250', () => {});
      }
      setTimeout(done, timeoutMs);
    });
  });
}

/** description XML を読んで機器情報にする。avt があればレンダラー、cd があればミュージックサーバー。どちらも無ければ null */
export async function describe(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`description 取得失敗 (${res.status})`);
  const xml = await res.text();
  const base = tag(xml, 'URLBase') || location;
  const control = {};
  for (const [, svc] of xml.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    const type = tag(svc, 'serviceType') ?? '';
    const url = tag(svc, 'controlURL');
    if (!url) continue;
    if (type.includes(':AVTransport:')) control.avt ??= new URL(url, base).href;
    if (type.includes(':RenderingControl:')) control.rc ??= new URL(url, base).href;
    if (type.includes(':ContentDirectory:')) control.cd ??= new URL(url, base).href;
  }
  if (!control.avt && !control.cd) return null;
  return { location, name: tag(xml, 'friendlyName') ?? new URL(location).host, host: new URL(location).hostname, ...control };
}

export async function discover(timeoutMs) {
  const locations = await ssdpSearch(timeoutMs);
  const list = await Promise.all(locations.map((l) => describe(l).catch(() => null)));
  return list.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function soap(url, service, action, args = {}) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = tag(text, 'errorDescription') ?? tag(text, 'errorCode') ?? res.statusText;
    throw new Error(`レンダラーが ${action} を拒否しました: ${detail}`);
  }
  return text;
}

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? xmlUnescape(m[1]) : '';
};

/** ContentDirectory の Browse 結果（DIDL-Lite）をフォルダと曲に分ける */
export function parseDidl(xml) {
  const containers = [];
  const tracks = [];
  for (const [, attrs, inner] of xml.matchAll(/<container\b([^>]*)>([\s\S]*?)<\/container>/g)) {
    containers.push({ id: attr(attrs, 'id'), title: tag(inner, 'title') ?? '', image: tag(inner, 'albumArtURI') ?? '' });
  }
  for (const [, attrs, inner] of xml.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)) {
    if (!(tag(inner, 'class') ?? '').startsWith('object.item.audioItem')) continue;
    // 複数の <res> のうち、HTTP で取れる音声を選ぶ（先頭が原本であることが多い）
    const res = [...inner.matchAll(/<res\b([^>]*)>([\s\S]*?)<\/res>/g)]
      .map(([, a, u]) => ({ info: attr(a, 'protocolInfo').split(':'), duration: attr(a, 'duration'), url: xmlUnescape(u.trim()) }))
      .find((r) => r.info[0] === 'http-get' && (r.info[2] ?? '').startsWith('audio/'));
    if (!res) continue;
    tracks.push({
      id: attr(attrs, 'id'),
      title: tag(inner, 'title') ?? '',
      artist: tag(inner, 'artist') ?? tag(inner, 'creator') ?? '',
      album: tag(inner, 'album') ?? '',
      image: tag(inner, 'albumArtURI') ?? '',
      duration: parseTime(res.duration),
      url: res.url,
      mime: res.info[2],
    });
  }
  return { containers, tracks };
}

/** ミュージックサーバーのフォルダ 1 階層分を取得する */
export async function browse(cdUrl, objectId = '0') {
  const out = { containers: [], tracks: [] };
  for (let start = 0; start < 5000; ) {
    const x = await soap(cdUrl, CD, 'Browse', {
      ObjectID: objectId, BrowseFlag: 'BrowseDirectChildren', Filter: '*',
      StartingIndex: start, RequestedCount: 200, SortCriteria: '',
    });
    const page = parseDidl(tag(x, 'Result') ?? '');
    out.containers.push(...page.containers);
    out.tracks.push(...page.tracks);
    const returned = Number(tag(x, 'NumberReturned')) || 0;
    start += returned;
    if (!returned || start >= (Number(tag(x, 'TotalMatches')) || 0)) break;
  }
  return out;
}

export function didl({ url, mime, title, artist, album, image, duration }) {
  const dur = duration ? ` duration="${formatTime(duration)}.000"` : '';
  return (
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="1" parentID="0" restricted="1">` +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<dc:creator>${xmlEscape(artist)}</dc:creator>` +
    `<upnp:artist>${xmlEscape(artist)}</upnp:artist>` +
    `<upnp:album>${xmlEscape(album)}</upnp:album>` +
    (image ? `<upnp:albumArtURI>${xmlEscape(image)}</upnp:albumArtURI>` : '') +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<res protocolInfo="http-get:*:${mime}:${DLNA_FEATURES}"${dur}>${xmlEscape(url)}</res>` +
    `</item></DIDL-Lite>`
  );
}

export const formatTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const parseTime = (t) => {
  if (!t || !/^\d+:\d+:\d+/.test(t)) return 0;
  const [h, m, s] = t.split(':').map(parseFloat);
  return Math.floor(h * 3600 + m * 60 + s);
};

/** レンダラー 1 台を操作する */
export class Renderer {
  constructor(info) {
    Object.assign(this, info);
  }
  avtCall(action, args) {
    return soap(this.avt, AVT, action, { InstanceID: 0, ...args });
  }
  async load(media) {
    await this.avtCall('SetAVTransportURI', { CurrentURI: media.url, CurrentURIMetaData: didl(media) });
    await this.play();
  }
  play() { return this.avtCall('Play', { Speed: 1 }); }
  pause() { return this.avtCall('Pause'); }
  stop() { return this.avtCall('Stop'); }
  seek(sec) { return this.avtCall('Seek', { Unit: 'REL_TIME', Target: formatTime(sec) }); }
  async status() {
    const [t, p] = await Promise.all([this.avtCall('GetTransportInfo'), this.avtCall('GetPositionInfo')]);
    return {
      state: tag(t, 'CurrentTransportState') ?? 'UNKNOWN',
      position: parseTime(tag(p, 'RelTime')),
      duration: parseTime(tag(p, 'TrackDuration')),
    };
  }
  async getVolume() {
    if (!this.rc) return null;
    const x = await soap(this.rc, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    return Number(tag(x, 'CurrentVolume'));
  }
  setVolume(v) {
    if (!this.rc) throw new Error('このレンダラーは音量操作に対応していません');
    return soap(this.rc, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(v) });
  }
}

/** レンダラーから見たこのマシンの IP アドレス */
export function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.connect(9, host, () => {
      const { address } = s.address();
      s.close();
      resolve(address);
    });
  });
}
