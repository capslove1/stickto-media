// 예약 게시 스크립트: posts/queue.json 에서 때가 된 글을 인스타그램·스레드에 올린다.
// 실행: node scripts/publish.mjs --dry-run | --post | --check
//   --dry-run : 올릴 대상과 사진 주소만 보여 준다 (기본값)
//   --post    : 실제로 올리고 결과를 queue.json 에 기록한다
//   --check   : 두 계정 연결만 확인한다
// 토큰은 환경 변수(GitHub Secrets)로만 받고, 화면에 출력하지 않는다.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { spreadTimes } from "./spread-times.mjs";

// 카카오 알림용 결과 기록 (커밋하지 않는 파일. 실행 뒤 kakao-notify.mjs 가 읽는다)
const EVENTS_FILE = new URL("../.kakao-events.json", import.meta.url);
const events = [];
const addEvent = (e) => { events.push(e); writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); };

const QUEUE_FILE = new URL("../posts/queue.json", import.meta.url);
const MEDIA_BASE = (process.env.MEDIA_BASE_URL || "https://raw.githubusercontent.com/capslove1/stickto-media/main/").replace(/\/?$/, "/");
const IG_BASE = "https://graph.instagram.com/v26.0";
const TH_BASE = "https://graph.threads.net/v1.0";
const FB_BASE = "https://graph.facebook.com/v21.0";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WAIT_MS = 60 * 60 * 1000; // 예약 시각 60분 전부터 실행되면 그 시각까지 기다렸다가 올린다
const LATE_LIMIT_MS = 6 * 60 * 60 * 1000; // 예약 시각보다 6시간 넘게 지났으면 올리지 않고 "missed"
// facebook 은 인스타 사진 게시물을 그대로 따라간다(같은 날짜·시각·사진·캡션). 릴스는 비공개 저장소라 여기 없음.
const CHANNELS = ["instagram", "facebook", "threads"];
const CH_NAME = { instagram: "인스타", facebook: "페이스북", threads: "스레드" };
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_TRIES = 60;
const TOKEN_WARN_DAYS = 7;

const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const TH_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const FB_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;

class PostError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

// 자주 나오는 에러를 쉬운 한국어로 바꾼다.
function explain(err, channel) {
  const code = err?.code;
  const sub = err?.error_subcode;
  if (code === 190) return `${channel} 토큰이 잘못되었거나 만료되었어요. 새 토큰을 GitHub Secrets 에 다시 넣어 주세요.`;
  if (code === 10 || code === 200) return `${channel} 게시 권한이 없어요. 앱 권한을 확인해 주세요.`;
  if ([4, 17, 32, 613].includes(code)) return "요청을 너무 많이 보냈어요. 잠시 뒤에 다시 시도해 주세요.";
  if (code === 9 || sub === 2207042) return "24시간 게시 한도를 넘었어요.";
  if (code === 9004 || sub === 2207052) return "사진 주소에서 이미지를 가져오지 못했어요. 저장소가 공개인지, 사진이 올라가 있는지 확인해 주세요.";
  if (sub === 2207009 || code === 36003) return "사진 비율이 맞지 않아요. 4:5 ~ 1.91:1 사이여야 해요.";
  if (code === 100) return "요청 값이 잘못되었어요. 아래 상세 메시지를 확인해 주세요.";
  return "알 수 없는 에러예요. 아래 상세 메시지를 확인해 주세요.";
}

function client(base, token, channel) {
  return async function api(method, path, params = {}) {
    const url = new URL(`${base}/${path}`);
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else init.body = new URLSearchParams(params);
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new PostError(`${channel} 서버에 접속하지 못했어요.`, e.message);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const err = data.error ?? {};
      throw new PostError(explain(err, channel), `${err.message ?? res.statusText} (code ${err.code ?? res.status}${err.error_subcode ? `, subcode ${err.error_subcode}` : ""})`);
    }
    return data;
  };
}

const ig = client(IG_BASE, IG_TOKEN, "인스타그램");
const th = client(TH_BASE, TH_TOKEN, "스레드");
const fb = client(FB_BASE, FB_TOKEN, "페이스북");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFinished(api, id, field, label) {
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    const data = await api("GET", id, { fields: field === "status" ? "status,error_message" : "status_code" });
    const status = data[field];
    if (status === "FINISHED") return;
    if (status === "ERROR") throw new PostError(`${label} 사진 처리에 실패했어요.`, `${data.error_message ?? "ERROR"} (container ${id})`);
    if (status === "EXPIRED") throw new PostError(`${label} 컨테이너가 만료되었어요.`, `container ${id}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new PostError(`${label} 사진 처리가 5분 넘게 끝나지 않았어요.`, `container ${id}`);
}

async function postInstagram(images, caption) {
  let creationId;
  if (images.length === 1) {
    ({ id: creationId } = await ig("POST", `${IG_USER_ID}/media`, { image_url: images[0], caption }));
  } else {
    const children = [];
    for (const image_url of images) {
      const { id } = await ig("POST", `${IG_USER_ID}/media`, { image_url, is_carousel_item: "true" });
      await waitFinished(ig, id, "status_code", "인스타그램");
      children.push(id);
    }
    ({ id: creationId } = await ig("POST", `${IG_USER_ID}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }));
  }
  await waitFinished(ig, creationId, "status_code", "인스타그램");
  const { id } = await ig("POST", `${IG_USER_ID}/media_publish`, { creation_id: creationId });
  const { permalink } = await ig("GET", id, { fields: "permalink" });
  return { id, permalink };
}

async function postThreads(images, text) {
  let creationId;
  if (images.length === 0) {
    ({ id: creationId } = await th("POST", "me/threads", { media_type: "TEXT", text }));
  } else if (images.length === 1) {
    ({ id: creationId } = await th("POST", "me/threads", { media_type: "IMAGE", image_url: images[0], text }));
  } else {
    const children = [];
    for (const image_url of images) {
      const { id } = await th("POST", "me/threads", { media_type: "IMAGE", image_url, is_carousel_item: "true" });
      await waitFinished(th, id, "status", "스레드");
      children.push(id);
    }
    ({ id: creationId } = await th("POST", "me/threads", { media_type: "CAROUSEL", children: children.join(","), text }));
  }
  await waitFinished(th, creationId, "status", "스레드");
  const { id } = await th("POST", "me/threads_publish", { creation_id: creationId });
  const { permalink } = await th("GET", id, { fields: "permalink" });
  return { id, permalink };
}

// 페이스북 페이지: 사진 1장은 바로 올리고, 여러 장은 사진을 비공개로 먼저 올린 뒤 한 게시물로 묶는다.
async function postFacebook(images, message) {
  let postId;
  if (images.length === 1) {
    const r = await fb("POST", `${FB_PAGE_ID}/photos`, { url: images[0], caption: message });
    postId = r.post_id ?? r.id;
  } else {
    const params = { message };
    for (const [i, url] of images.entries()) {
      const { id } = await fb("POST", `${FB_PAGE_ID}/photos`, { url, published: "false" });
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    }
    ({ id: postId } = await fb("POST", `${FB_PAGE_ID}/feed`, params));
  }
  const { permalink_url } = await fb("GET", postId, { fields: "permalink_url" });
  return { id: postId, permalink: permalink_url };
}

// 채널별 예약 시각(한국 시간)을 UTC 밀리초로 바꾼다. 채널에 time 이 없으면 글의 time 을 쓴다.
// 채널마다 날짜를 따로 둘 수 있다: item[ch].date 가 있으면 그 날짜, 없으면 item.date
const chDate = (item, ch) => item[ch]?.date ?? item.date;
const scheduledAt = (item, ch) => Date.parse(`${chDate(item, ch)}T${item[ch].time ?? item.time}:00Z`) - KST_OFFSET_MS;
const kst = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
const urls = (paths) => paths.map((p) => (/^https?:\/\//.test(p) ? p : MEDIA_BASE + p));

// 스레드는 이모지를 UTF-8 바이트 수로 센다.
const threadsLength = (t) => [...t].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? Buffer.byteLength(ch) : 1), 0);

function validate(item, ch) {
  const problems = [];
  const c = item[ch];
  if (ch === "threads") {
    const tags = c.text.match(/#\S+/g) ?? [];
    if (tags.length > 1) problems.push(`스레드 해시태그가 ${tags.length}개예요(1개만).`);
    if (threadsLength(c.text) > 500) problems.push("스레드 글이 500자를 넘어요.");
  } else if (ch === "instagram" && c.caption.length > 2200) problems.push("인스타 캡션이 2200자를 넘어요.");
  const n = (c.images ?? []).length;
  if (ch === "instagram" && (n < 1 || n > 10)) problems.push(`인스타 사진은 1~10장이어야 해요(지금 ${n}장).`);
  if (ch === "threads" && n > 10) problems.push(`스레드 사진은 10장 이하여야 해요(지금 ${n}장).`);
  if (ch === "facebook" && n < 1) problems.push("페이스북에 올릴 사진이 없어요.");
  return problems;
}

async function checkImages(list) {
  for (const u of list) {
    const res = await fetch(u, { method: "HEAD" }).catch(() => null);
    if (!res || !res.ok) throw new PostError("사진 주소가 열리지 않아요. 저장소가 공개인지, 사진이 올라가 있는지 확인해 주세요.", u);
  }
}

function warnTokens(now) {
  for (const [name, value] of [["인스타그램", process.env.IG_TOKEN_EXPIRES], ["스레드", process.env.THREADS_TOKEN_EXPIRES]]) {
    if (!value) { console.log(`::warning::${name} 토큰 만료일(변수)이 설정되지 않았어요.`); continue; }
    const days = Math.floor((Date.parse(`${value}T00:00:00+09:00`) - now) / 86_400_000);
    if (days <= TOKEN_WARN_DAYS) console.log(`::warning::${name} 토큰이 ${days}일 뒤(${value}) 만료돼요. 새 토큰으로 바꿔 주세요.`);
  }
}

async function check() {
  if (!IG_TOKEN || !TH_TOKEN || !IG_USER_ID) throw new PostError("토큰 또는 사용자 ID 환경 변수가 없어요.");
  const a = await ig("GET", "me", { fields: "user_id,username" });
  const b = await th("GET", "me", { fields: "id,username" });
  console.log(`인스타그램 연결: ${a.username}${String(a.user_id) === String(IG_USER_ID) ? "" : " (주의: INSTAGRAM_USER_ID 와 다름)"}`);
  console.log(`스레드 연결: ${b.username}`);
  await recentPosts("instagram");
  await recentPosts("threads");
  console.log("최근 게시물 읽기(중복 확인용): 두 계정 모두 됨");
  if (FB_TOKEN && FB_PAGE_ID) {
    const p = await fb("GET", FB_PAGE_ID, { fields: "name" });
    await recentPosts("facebook");
    console.log(`페이스북 페이지 연결: ${p.name} (최근 게시물 읽기 됨)`);
  } else console.log("::warning::페이스북 비밀값(FB_PAGE_TOKEN, FB_PAGE_ID)이 없어요.");
}

// 최근 게시물 10개 (중복 게시 확인용)
async function recentPosts(ch) {
  if (ch === "facebook") {
    const { data } = await fb("GET", `${FB_PAGE_ID}/posts`, { fields: "id,message,permalink_url", limit: "10" });
    return (data ?? []).map((p) => ({ id: p.id, permalink: p.permalink_url, text: p.message }));
  }
  const { data } = ch === "instagram"
    ? await ig("GET", `${IG_USER_ID}/media`, { fields: "id,caption,permalink", limit: "10" })
    : await th("GET", "me/threads", { fields: "id,text,permalink", limit: "10" });
  return (data ?? []).map((p) => ({ id: p.id, permalink: p.permalink, text: ch === "instagram" ? p.caption : p.text }));
}

// 올리기 직전 확인: 다른 실행이 이미 올렸는지(원격 queue.json), 같은 글이 계정에 이미 있는지.
// 이미 있으면 그 결과를 돌려준다. 계정 확인이 안 되면 에러를 던져서 이번에는 올리지 않는다.
async function findPosted(item, ch, text) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "ignore", timeout: 30_000 });
    const remote = JSON.parse(execFileSync("git", ["show", "origin/main:posts/queue.json"], { encoding: "utf8" }));
    const r = remote.posts.find((p) => p.id === item.id)?.result?.[ch];
    if (r?.id) return r;
  } catch {
    console.log("  (원격 queue.json 확인은 건너뜀)");
  }
  const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();
  const hit = (await recentPosts(ch)).find((p) => norm(p.text) === norm(text));
  return hit ? { id: hit.id, permalink: hit.permalink } : null;
}

async function run(mode) {
  // NOW(시험용 시각)는 미리보기에서만 쓴다. 실제 게시는 항상 현재 시각 기준.
  const now = mode !== "post" && process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  if (Number.isNaN(now)) throw new PostError("NOW 값이 날짜 형식이 아니에요. 예) 2026-10-19T11:05:00+09:00");
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const save = () => writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
  let changed = false;
  console.log(`지금(한국 시간): ${kst(now)} · 모드: ${mode}`);
  // 인스타 사진 게시물에 페이스북을 붙인다. queue.json 에는 쓰지 않으려고 숨은 속성으로 둔다.
  // 이미 끝난 글(posted 등)과 "facebook": false 인 글은 빼고, 실제 게시 때 페이스북 비밀값이 없으면 붙이지 않는다.
  const fbOn = mode !== "post" || Boolean(FB_TOKEN && FB_PAGE_ID);
  if (!fbOn) console.log("::warning::페이스북 비밀값이 없어서 페이스북은 건너뛰어요.");
  for (const item of queue.posts) {
    if (fbOn && item.status === "approved" && item.instagram && item.facebook !== false && (item.type ?? "photo") !== "reel")
      Object.defineProperty(item, "facebook", { value: item.instagram, enumerable: false, configurable: true });
  }
  warnTokens(now);

  // 기준 시각 그대로인 새 글은 먼저 앞뒤 15분 안으로 흩는다.
  for (const c of spreadTimes(queue)) {
    console.log(`시각 자동 배정: [${c.id}] ${c.ch === "instagram" ? "인스타" : "스레드"} ${c.date} ${c.from} → ${c.to}`);
    changed = true;
  }

  // 이번 실행에서 맡을 글: 예약 시각 60분 전부터. 이른 시각부터 차례로 올린다.
  const tasks = [];
  for (const item of queue.posts) {
    if (item.status !== "approved") continue;
    item.result ??= {};
    for (const ch of CHANNELS) {
      if (!item[ch] || item.result[ch]?.id || item.result[ch]?.missed || item.result[ch]?.error) continue;
      const at = scheduledAt(item, ch);
      if (now >= at - WAIT_MS) tasks.push({ item, ch, at });
    }
  }
  tasks.sort((a, b) => a.at - b.at);

  for (const { item, ch, at } of tasks) {
    const label = `[${item.id}] ${CH_NAME[ch]} ${chDate(item, ch)} ${item[ch].time ?? item.time}`;
    if ((mode === "post" ? Date.now() : now) - at > LATE_LIMIT_MS) {
      console.log(`${label}: 예약 시각보다 6시간 넘게 지나 올리지 않았어요.`);
      if (mode === "post") { item.result[ch] = { missed: true, at: new Date().toISOString() }; changed = true; addEvent({ kind: "missed", ch, date: chDate(item, ch), site: item.site ?? item.id, reason: "예약 시각보다 6시간 넘게 늦음" }); }
      continue;
    }
    const problems = validate(item, ch);
    if (problems.length) {
      console.log(`${label}: 올리지 않음 - ${problems.join(" ")}`);
      if (mode === "post") { item.result[ch] = { error: problems.join(" "), at: new Date().toISOString() }; changed = true; addEvent({ kind: "fail", ch, date: chDate(item, ch), site: item.site ?? item.id, reason: problems.join(" ") }); }
      continue;
    }
    const imgs = urls(item[ch].images ?? []);
    const text = ch === "threads" ? item[ch].text : item[ch].caption;
    console.log(`\n${label} · ${item.type ?? "photo"}${item.site ? " · " + item.site : ""}`);
    imgs.forEach((u, i) => console.log(`  사진 ${i + 1}: ${u}`));
    if (!imgs.length) console.log(`  글: ${text.split("\n")[0]} …`);
    if (mode !== "post") {
      if (at > now) console.log(`  예약 시각까지 ${Math.ceil((at - now) / 60_000)}분 기다렸다가 올릴 예정`);
      if (imgs.length) {
        try { await checkImages(imgs); console.log("  사진 주소: 모두 열림"); }
        catch (e) { console.log(`  사진 주소 문제: ${e.message} ${e.detail ?? ""}`); }
      }
      continue;
    }
    const wait = at - Date.now();
    if (wait > 0) {
      console.log(`  예약 시각(${kst(at)})까지 ${Math.ceil(wait / 60_000)}분 기다려요.`);
      await sleep(wait);
    }
    let posted;
    try {
      posted = await findPosted(item, ch, text);
    } catch (e) {
      console.log(`  중복 확인이 안 돼서 이번에는 올리지 않아요(다음 실행 때 다시 확인): ${e.message} ${e.detail ?? ""}`);
      continue;
    }
    if (posted) {
      item.result[ch] = { ...posted, note: "이미 올라가 있어 다시 올리지 않음" };
      console.log(`  이미 올라가 있어서 다시 올리지 않았어요: ${posted.permalink ?? posted.id}`);
    } else {
      try {
        if (imgs.length) await checkImages(imgs);
        const r = await ({ instagram: postInstagram, facebook: postFacebook, threads: postThreads })[ch](imgs, text);
        item.result[ch] = { ...r, at: new Date().toISOString() };
        console.log(`  게시 완료: ${r.permalink ?? r.id}`);
        addEvent({ kind: "ok", ch, date: chDate(item, ch), site: item.site ?? item.id, permalink: r.permalink });
      } catch (e) {
        item.result[ch] = { error: `${e.message} ${e.detail ?? ""}`.trim(), at: new Date().toISOString() };
        addEvent({ kind: "fail", ch, date: chDate(item, ch), site: item.site ?? item.id, reason: e.message });
        console.log(`  에러: ${e.message}
  상세: ${e.detail ?? ""}`);
      }
    }
    changed = true;
    save(); // 다음 글을 기다리는 중 실행이 끊겨도 앞에서 올린 결과는 남도록 바로 기록
  }

  // 채널이 모두 끝난 글은 상태를 정한다.
  for (const item of queue.posts) {
    if (item.status !== "approved") continue;
    const chs = CHANNELS.filter((c) => item[c]);
    if (chs.every((c) => item.result[c]?.id || item.result[c]?.missed || item.result[c]?.error)) {
      const ok = chs.filter((c) => item.result[c]?.id).length;
      const missed = chs.filter((c) => item.result[c]?.missed).length;
      item.status = ok === chs.length ? "posted" : missed === chs.length ? "missed" : ok > 0 ? "partial" : "failed";
      changed = true;
    }
  }

  if (changed) save();
  console.log(changed ? "\nqueue.json 에 결과를 기록했어요." : "\n바뀐 내용이 없어요.");
}

const mode = (process.argv[2] || "--dry-run").replace(/^--/, "");
if (!["dry-run", "post", "check"].includes(mode)) {
  console.log("사용법: node scripts/publish.mjs --dry-run | --post | --check");
  process.exit(1);
}
(mode === "check" ? check() : (mode === "post" && (!IG_TOKEN || !TH_TOKEN || !IG_USER_ID))
  ? Promise.reject(new PostError("토큰 또는 사용자 ID 환경 변수가 없어요. GitHub Secrets 를 확인해 주세요."))
  : run(mode)
).catch((e) => {
  console.error(`\n에러: ${e.message}`);
  if (e.detail) console.error(`상세: ${e.detail}`);
  process.exit(1);
});
