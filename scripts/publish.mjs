// 예약 게시 스크립트: posts/queue.json 에서 때가 된 글을 인스타그램·스레드에 올린다.
// 실행: node scripts/publish.mjs --dry-run | --post | --check
//   --dry-run : 올릴 대상과 사진 주소만 보여 준다 (기본값)
//   --post    : 실제로 올리고 결과를 queue.json 에 기록한다
//   --check   : 두 계정 연결만 확인한다
// 토큰은 환경 변수(GitHub Secrets)로만 받고, 화면에 출력하지 않는다.

import { readFileSync, writeFileSync } from "node:fs";

const QUEUE_FILE = new URL("../posts/queue.json", import.meta.url);
const MEDIA_BASE = (process.env.MEDIA_BASE_URL || "https://raw.githubusercontent.com/capslove1/stickto-media/main/").replace(/\/?$/, "/");
const IG_BASE = "https://graph.instagram.com/v26.0";
const TH_BASE = "https://graph.threads.net/v1.0";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 예약 시각보다 24시간 넘게 지났으면 올리지 않고 "missed"
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_TRIES = 60;
const TOKEN_WARN_DAYS = 7;

const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const TH_TOKEN = process.env.THREADS_ACCESS_TOKEN;

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
  if (images.length === 1) {
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

// 예약 시각(한국 시간)을 UTC 밀리초로 바꾼다.
const scheduledAt = (item) => Date.parse(`${item.date}T${item.time}:00Z`) - KST_OFFSET_MS;
const kst = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
const urls = (paths) => paths.map((p) => (/^https?:\/\//.test(p) ? p : MEDIA_BASE + p));

// 스레드는 이모지를 UTF-8 바이트 수로 센다.
const threadsLength = (t) => [...t].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? Buffer.byteLength(ch) : 1), 0);

function validate(item) {
  const problems = [];
  const tags = item.threads.text.match(/#\S+/g) ?? [];
  if (tags.length > 1) problems.push(`스레드 해시태그가 ${tags.length}개예요(1개만).`);
  if (threadsLength(item.threads.text) > 500) problems.push("스레드 글이 500자를 넘어요.");
  if (item.instagram.caption.length > 2200) problems.push("인스타 캡션이 2200자를 넘어요.");
  for (const ch of ["instagram", "threads"]) {
    const n = item[ch].images.length;
    if (n < 1 || n > 10) problems.push(`${ch} 사진은 1~10장이어야 해요(지금 ${n}장).`);
  }
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
}

async function run(mode) {
  // NOW(시험용 시각)는 미리보기에서만 쓴다. 실제 게시는 항상 현재 시각 기준.
  const now = mode !== "post" && process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  if (Number.isNaN(now)) throw new PostError("NOW 값이 날짜 형식이 아니에요. 예) 2026-10-19T11:05:00+09:00");
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  let changed = false;
  console.log(`지금(한국 시간): ${kst(now)} · 모드: ${mode}`);
  warnTokens(now);

  for (const item of queue.posts) {
    if (item.status !== "approved") continue;
    const at = scheduledAt(item);
    if (now < at) continue;
    if (now - at > LATE_LIMIT_MS) {
      console.log(`[${item.id}] 예약 시각(${item.date} ${item.time})이 24시간 넘게 지나 올리지 않았어요. 날짜를 다시 잡아 주세요.`);
      if (mode === "post") { item.status = "missed"; changed = true; }
      continue;
    }
    const problems = validate(item);
    if (problems.length) {
      console.log(`[${item.id}] 올리지 않음: ${problems.join(" ")}`);
      if (mode === "post") { item.status = "failed"; item.result = { error: problems.join(" ") }; changed = true; }
      continue;
    }

    const igImages = urls(item.instagram.images);
    const thImages = urls(item.threads.images);
    console.log(`\n[${item.id}] ${item.site} · 예약 ${item.date} ${item.time}`);
    igImages.forEach((u, i) => console.log(`  인스타 사진 ${i + 1}: ${u}`));
    thImages.forEach((u, i) => console.log(`  스레드 사진 ${i + 1}: ${u}`));
    if (mode !== "post") {
      try {
        await checkImages([...new Set([...igImages, ...thImages])]);
        console.log("  사진 주소: 모두 열림");
      } catch (e) {
        console.log(`  사진 주소 문제: ${e.message} ${e.detail ?? ""}`);
      }
      continue;
    }

    item.result ??= {};
    try {
      await checkImages([...new Set([...igImages, ...thImages])]);
    } catch (e) {
      console.log(`  에러: ${e.message}\n  상세: ${e.detail ?? ""}`);
      item.status = "failed"; item.result.error = `${e.message} ${e.detail ?? ""}`.trim(); changed = true;
      continue;
    }
    for (const [ch, fn, imgs, text] of [["instagram", postInstagram, igImages, item.instagram.caption], ["threads", postThreads, thImages, item.threads.text]]) {
      if (item.result[ch]?.id) continue; // 이미 올라간 채널은 건너뛴다
      try {
        const r = await fn(imgs, text);
        item.result[ch] = { ...r, at: new Date().toISOString() };
        console.log(`  ${ch} 게시 완료: ${r.permalink ?? r.id}`);
      } catch (e) {
        item.result[ch] = { error: `${e.message} ${e.detail ?? ""}`.trim(), at: new Date().toISOString() };
        console.log(`  ${ch} 에러: ${e.message}\n  상세: ${e.detail ?? ""}`);
      }
      changed = true;
    }
    const ok = ["instagram", "threads"].filter((c) => item.result[c]?.id).length;
    item.status = ok === 2 ? "posted" : ok === 1 ? "partial" : "failed";
  }

  if (changed) writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
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
