// Qobuz API の最小クライアント。
// app_id / app_secret は Qobuz から発行されたものをユーザーが設定する。
import { createHash } from 'node:crypto';

const BASE = 'https://www.qobuz.com/api.json/0.2/';
const md5 = (s) => createHash('md5').update(s).digest('hex');

// format_id: 5=MP3 320k, 6=FLAC 16bit/44.1k, 7=FLAC 24bit/〜96k, 27=FLAC 24bit/〜192k
export const FORMATS = { 5: 'MP3 320kbps', 6: 'FLAC 16bit/44.1kHz', 7: 'FLAC 24bit/96kHz', 27: 'FLAC 24bit/192kHz' };

export function fileUrlSignature(trackId, formatId, ts, secret) {
  return md5(`trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${ts}${secret}`);
}

const normTrack = (t, album = t.album) => ({
  id: t.id,
  title: t.version ? `${t.title} (${t.version})` : t.title,
  artist: t.performer?.name ?? album?.artist?.name ?? '',
  album: album?.title ?? '',
  image: album?.image?.large ?? album?.image?.small ?? '',
  duration: t.duration ?? 0,
  hires: Boolean(t.hires_streamable),
  streamable: t.streamable !== false,
});

const normAlbum = (a) => ({
  id: a.id,
  title: a.version ? `${a.title} (${a.version})` : a.title,
  artist: a.artist?.name ?? '',
  image: a.image?.large ?? a.image?.small ?? '',
  tracksCount: a.tracks_count ?? 0,
  hires: Boolean(a.hires_streamable),
});

export class Qobuz {
  constructor({ appId = '', appSecret = '', token = '', fetchImpl = fetch } = {}) {
    Object.assign(this, { appId, appSecret, token, fetch: fetchImpl });
  }

  async call(path, params = {}) {
    if (!this.appId) throw new Error('Qobuz の app_id が未設定です');
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = { 'X-App-Id': this.appId };
    if (this.token) headers['X-User-Auth-Token'] = this.token;
    const res = await this.fetch(url, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Qobuz API エラー (${res.status}): ${body.message ?? res.statusText}`);
    return body;
  }

  async login(email, password) {
    const r = await this.call('user/login', { email, password: md5(password), app_id: this.appId });
    if (!r.user_auth_token) throw new Error('ログインに失敗しました');
    this.token = r.user_auth_token;
    return { name: r.user?.display_name ?? r.user?.login ?? email };
  }

  async search(query, limit = 20) {
    const r = await this.call('catalog/search', { query, limit });
    return {
      albums: (r.albums?.items ?? []).map(normAlbum),
      tracks: (r.tracks?.items ?? []).map((t) => normTrack(t)),
    };
  }

  async album(id) {
    const a = await this.call('album/get', { album_id: id });
    return { ...normAlbum(a), tracks: (a.tracks?.items ?? []).map((t) => normTrack(t, a)) };
  }

  async fileUrl(trackId, formatId) {
    if (!this.appSecret) throw new Error('Qobuz の app_secret が未設定です');
    const ts = Math.floor(Date.now() / 1000);
    const r = await this.call('track/getFileUrl', {
      track_id: trackId,
      format_id: formatId,
      intent: 'stream',
      request_ts: ts,
      request_sig: fileUrlSignature(trackId, formatId, ts, this.appSecret),
    });
    if (!r.url) throw new Error('この曲はストリーミングできません');
    return {
      url: r.url,
      mime: r.mime_type ?? (Number(r.format_id) === 5 ? 'audio/mpeg' : 'audio/flac'),
      sample: Boolean(r.sample), // true のときは 30 秒試聴版（契約外の曲など）
      bitDepth: r.bit_depth,
      samplingRate: r.sampling_rate,
    };
  }
}
