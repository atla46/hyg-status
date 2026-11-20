// 配信状況ポーラー: Twitch / YouTube を巡回して status.json を書き出す。Node 18 以上。
//
//   TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... YOUTUBE_API_KEY=... node poller.mjs --loop 60
//
// 引数なしで1回だけ実行。--loop 秒 で常駐。出力先は環境変数 OUT(既定 ./status.json)。
// 履歴は HISTORY(既定 ./history.json)に残るので、再起動しても帯がつながります。
import { readFile, writeFile } from "node:fs/promises";

const OUT = process.env.OUT || "./status.json";
const HISTORY = process.env.HISTORY || "./history.json";
const KEEP_DAYS = 7;
const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_API_KEY } = process.env;

const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return d; } };
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/* ---------- Twitch ---------- */
let twToken = null, twExp = 0;
async function twitchToken() {
  if (twToken && Date.now() < twExp) return twToken;
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: "client_credentials" })
  });
  if (!r.ok) throw new Error("Twitch token " + r.status);
  const j = await r.json(); twToken = j.access_token; twExp = Date.now() + (j.expires_in - 300) * 1000;
  return twToken;
}
async function pollTwitch(channels) {
  const byLogin = new Map(Object.entries(channels).filter(([, c]) => c.twitch).map(([pid, c]) => [c.twitch.toLowerCase(), pid]));
  const found = [];
  for (const logins of chunk([...byLogin.keys()], 100)) {
    const q = new URLSearchParams(); logins.forEach(l => q.append("user_login", l));
    const r = await fetch("https://api.twitch.tv/helix/streams?" + q, { headers: { "client-id": TWITCH_CLIENT_ID, authorization: "Bearer " + await twitchToken() } });
    if (!r.ok) throw new Error("Twitch streams " + r.status);
    for (const s of (await r.json()).data) {
      if (s.type !== "live") continue;
      found.push({
        pid: byLogin.get(s.user_login.toLowerCase()), platform: "twitch", key: "tw:" + s.id,
        title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
        url: "https://www.twitch.tv/" + s.user_login, channel: s.user_login,
        thumb: s.thumbnail_url.replace("{width}", "320").replace("{height}", "180") + "?t=" + Math.floor(Date.now() / 300000)
      });
    }
  }
  return found;
}

/* ---------- YouTube(RSSで新着ID → videos.list で配信中か判定。クォータはほぼ消費しない) ---------- */
async function pollYouTube(channels) {
  const owner = new Map(); // videoId -> pid
  await Promise.all(Object.entries(channels).filter(([, c]) => c.youtube).map(async ([pid, c]) => {
    try {
      const r = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + c.youtube);
      if (!r.ok) return;
      for (const m of (await r.text()).matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)) { if (owner.size < 2000) owner.set(m[1], { pid, channelId: c.youtube }); }
    } catch { /* 1チャンネルの失敗は無視 */ }
  }));
  const found = [];
  for (const ids of chunk([...owner.keys()], 50)) {
    const q = new URLSearchParams({ part: "snippet,liveStreamingDetails", id: ids.join(","), key: YOUTUBE_API_KEY });
    const r = await fetch("https://www.googleapis.com/youtube/v3/videos?" + q);
    if (!r.ok) throw new Error("YouTube videos " + r.status);
    for (const v of (await r.json()).items || []) {
      const d = v.liveStreamingDetails;
      if (!d || !d.actualStartTime || d.actualEndTime) continue;
      const o = owner.get(v.id), th = v.snippet.thumbnails;
      found.push({
        pid: o.pid, platform: "youtube", key: "yt:" + v.id, title: v.snippet.title, game: "",
        viewers: Number(d.concurrentViewers || 0), startedAt: d.actualStartTime, url: "https://www.youtube.com/watch?v=" + v.id,
        videoId: v.id, channelId: o.channelId, thumb: (th.medium || th.default || {}).url
      });
    }
  }
  return found;
}

/* ---------- 1回分の更新 ---------- */
async function tick() {
  const channels = await readJson("./channels.json", null);
  if (!channels) { console.error("!! channels.json が読めません。poller.mjs と同じフォルダで実行してください。(今の場所: " + process.cwd() + ")"); return; }
  const nTw = Object.values(channels).filter(c => c.twitch).length, nYt = Object.values(channels).filter(c => c.youtube).length;
  console.log(`channels.json: ${Object.keys(channels).length}人 (Twitch ${nTw} / YouTube ${nYt})`);
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) console.warn("!! TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET が設定されていません。Twitchは確認しません。");
  if (!YOUTUBE_API_KEY) console.warn("-- YOUTUBE_API_KEY 未設定。YouTubeは確認しません。");
  const hist = await readJson(HISTORY, { sessions: [] });
  const now = new Date().toISOString();
  const ok = {}, live = [];
  if (TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET) { try { const r = await pollTwitch(channels); live.push(...r); ok.twitch = true; console.log("Twitch OK: 配信中 " + r.length + "人"); } catch (e) { console.error("!! Twitch エラー: " + e.message); } }
  if (YOUTUBE_API_KEY) { try { const r = await pollYouTube(channels); live.push(...r); ok.youtube = true; console.log("YouTube OK: 配信中 " + r.length + "人"); } catch (e) { console.error("!! YouTube エラー: " + e.message); } }

  const seen = new Set();
  for (const l of live) {
    seen.add(l.key);
    let s = hist.sessions.find(x => x.key === l.key);
    if (!s) { s = { key: l.key, pid: l.pid, platform: l.platform, start: l.startedAt, end: null }; hist.sessions.push(s); }
    Object.assign(s, { title: l.title, game: l.game, viewers: l.viewers, url: l.url, thumb: l.thumb, channel: l.channel, videoId: l.videoId, channelId: l.channelId, lastSeen: now, misses: 0, end: null });
  }
  for (const s of hist.sessions) {
    if (s.end || seen.has(s.key) || !ok[s.platform]) continue; // 取得に失敗した媒体の配信は閉じない
    s.misses = (s.misses || 0) + 1;
    if (s.misses >= 2) s.end = s.lastSeen || now;             // 2回連続で見えなければ終了(一瞬の切断で帯が割れないように)
  }
  const cut = Date.now() - KEEP_DAYS * 86400e3;
  hist.sessions = hist.sessions.filter(s => Date.parse(s.end || now) > cut);
  await writeFile(HISTORY, JSON.stringify(hist));
  const sessions = hist.sessions.map(({ misses, lastSeen, ...s }) => s);
  await writeFile(OUT, JSON.stringify({ generatedAt: now, sessions }));
  console.log(now, "live:", live.length, "sessions:", sessions.length);
}

const loopIdx = process.argv.indexOf("--loop");
if (loopIdx > 0) {
  const sec = Number(process.argv[loopIdx + 1]) || 60;
  for (;;) { try { await tick(); } catch (e) { console.error(e); } await new Promise(r => setTimeout(r, sec * 1000)); }
} else await tick();
