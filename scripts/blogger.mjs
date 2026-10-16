// 구글 블로그(Blogger) 스크립트: 네이버 블로그 새 글을 찾고, 승인된 구글용 글을 예약 시각에 올린다.
// 실행: node scripts/blogger.mjs --dry-run | --post | --check
//   --dry-run : 새 글 확인과 올릴 대상만 보여 준다 (기본값)
//   --post    : 새 글을 blogger/queue.json 에 기록(카톡 알림)하고, 때가 된 글을 올린다
//   --check   : Blogger 연결만 확인한다
// - 구글용 글은 PC 에서 만들어 blogger/posts/<id>.html 에 두고, 승인하면 status 를 approved 로 바꾼다.
// - 사진은 이 저장소 media/blogger/ 에 두고 raw.githubusercontent.com 주소로 넣는다(하청 현장 사진 금지).
// - 결과는 .kakao-events-blogger.json 에 남기고, 워크플로의 카카오 알림 단계가 보낸다.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gapi } from "./google.mjs";
import { sendKakao, short } from "./kakao.mjs";

const ROOT = new URL("../", import.meta.url);
const QUEUE_FILE = new URL("blogger/queue.json", ROOT);
const EVENTS_FILE = new URL(".kakao-events-blogger.json", ROOT);
const BLOG_ID = "4123174471676481726";
const API = `https://www.googleapis.com/blogger/v3/blogs/${BLOG_ID}`;
const RSS = "https://rss.blog.naver.com/stickto_film.xml";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WAIT_MS = 20 * 60 * 1000; // 예약 20분 전부터 맡아서 그 시각까지 기다렸다가 올린다 (11:20 알람 → 11:30)
const LATE_LIMIT_MS = 6 * 60 * 60 * 1000; // 6시간 넘게 늦으면 올리지 않고 missed
const DAYS_AFTER = 3; // 네이버 글 3일 뒤(일요일이면 4일 뒤) 11:30

const events = [];
const addEvent = (e) => { events.push({ ch: "blogger", ...e }); writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); };
const kst = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
const kstDay = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
const scheduledAt = (p) => Date.parse(`${p.date}T${p.time}:00+09:00`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();

function planDate(naverMs) {
  let d = naverMs + DAYS_AFTER * 86400_000;
  if (new Date(d + KST_OFFSET_MS).getUTCDay() === 0) d += 86400_000; // 일요일은 피한다
  return kstDay(d);
}

async function readRss() {
  const res = await fetch(RSS);
  if (!res.ok) throw new Error(`네이버 RSS 를 읽지 못했어요 (${res.status})`);
  const xml = await res.text();
  const pick = (block, tag) => block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))?.[1]?.trim() ?? "";
  return xml.split("<item>").slice(1).map((b) => {
    const guid = pick(b, "guid");
    return { id: guid.split("/").pop(), url: guid, title: pick(b, "title"), at: Date.parse(pick(b, "pubDate")) };
  }).filter((i) => /^\d+$/.test(i.id));
}

async function check() {
  const { data } = await gapi(API);
  console.log(`구글 블로그: ${data.name} (${data.url}) · 글 ${data.posts?.totalItems ?? "?"}개`);
}

async function findPosted(post) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "ignore", timeout: 30_000 });
    const remote = JSON.parse(execFileSync("git", ["show", "origin/main:blogger/queue.json"], { encoding: "utf8" }));
    const r = remote.posts.find((p) => p.id === post.id)?.result;
    if (r?.postId) return r;
  } catch {
    console.log("  (원격 blogger/queue.json 확인은 건너뜀)");
  }
  for (const status of ["live", "scheduled"]) {
    const { data } = await gapi(`${API}/posts?status=${status}&fetchBodies=false&maxResults=20`);
    const hit = (data.items ?? []).find((p) => norm(p.title) === norm(post.title));
    if (hit) return { postId: hit.id, url: hit.url };
  }
  return null;
}

async function run(mode) {
  const now = mode !== "post" && process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  if (Number.isNaN(now)) throw new Error("NOW 값이 날짜 형식이 아니에요. 예) 2026-10-20T11:20:00+09:00");
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const save = () => writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(`[구글 블로그] 지금(한국 시간): ${kst(now)} · 모드: ${mode}`);

  // 1) 네이버 새 글 확인 (queue.since 이후 글만)
  try {
    const known = new Set(queue.posts.map((p) => p.id));
    const fresh = (await readRss()).filter((i) => !known.has(i.id) && i.at > Date.parse(queue.since)).sort((a, b) => a.at - b.at);
    if (!fresh.length) console.log("네이버 새 글: 없음");
    for (const i of fresh) {
      const date = planDate(i.at);
      console.log(`네이버 새 글: ${i.title} (${kst(i.at)}) → 구글 블로그 ${date} 11:30 예정`);
      if (mode !== "post") continue;
      queue.posts.push({ id: i.id, naverUrl: i.url, naverTitle: i.title, naverDate: kst(i.at), date, time: "11:30", title: "", file: "", labels: [], status: "new", result: {} });
      save();
      await sendKakao(`[구글 블로그] 네이버 새 글을 찾았어요\n${i.title.slice(0, 60)}\n${short(date)} 11:30 예정이에요. PC에서 구글용 글을 만들어 승인해 주세요.`);
    }
  } catch (e) {
    console.log(`네이버 새 글 확인 실패: ${e.message}`);
  }

  // 2) 승인된 글 올리기
  const due = queue.posts.filter((p) => p.status === "approved" && !p.result?.postId && now >= scheduledAt(p) - WAIT_MS).sort((a, b) => scheduledAt(a) - scheduledAt(b));
  if (!due.length) console.log("지금 올릴 구글 블로그 글이 없어요.");
  for (const post of due) {
    const label = `[${post.id}] ${post.date} ${post.time} ${post.title}`;
    const file = new URL(post.file, ROOT);
    if ((mode === "post" ? Date.now() : now) - scheduledAt(post) > LATE_LIMIT_MS) {
      console.log(`${label}: 예약 시각보다 6시간 넘게 지나 올리지 않았어요.`);
      if (mode === "post") { post.status = "missed"; post.result = { missed: true, at: new Date().toISOString() }; save(); addEvent({ kind: "missed", date: post.date, site: post.site, reason: "예약 시각보다 6시간 넘게 늦음" }); }
      continue;
    }
    if (!post.file || !existsSync(file)) {
      console.log(`${label}: 글 파일이 없어요 (${post.file})`);
      if (mode === "post") { post.status = "failed"; post.result = { error: `글 파일 없음: ${post.file}` }; save(); addEvent({ kind: "fail", date: post.date, site: post.site, reason: "글 파일 없음" }); }
      continue;
    }
    const html = readFileSync(file, "utf8");
    console.log(`\n${label}\n  글 ${post.file} (${html.length}자) · 사진 ${(html.match(/<img/g) ?? []).length}장 · 라벨 ${post.labels.join(", ")}`);
    if (mode !== "post") continue;
    const wait = scheduledAt(post) - Date.now();
    if (wait > 0) { console.log(`  ${Math.ceil(wait / 60000)}분 기다렸다가 올려요`); await sleep(wait); }
    try {
      const posted = await findPosted(post);
      if (posted) {
        post.result = { ...posted, note: "이미 올라가 있어 다시 올리지 않음" };
        console.log(`  이미 올라가 있어서 다시 올리지 않았어요: ${posted.url}`);
      } else {
        const { data } = await gapi(`${API}/posts?isDraft=false`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ title: post.title, content: html, labels: post.labels }),
        });
        post.result = { postId: data.id, url: data.url, at: new Date().toISOString() };
        console.log(`  게시 완료: ${data.url}`);
        addEvent({ kind: "ok", date: post.date, site: post.site, permalink: data.url });
      }
      post.status = "posted";
    } catch (e) {
      post.status = "failed";
      post.result = { error: e.message, at: new Date().toISOString() };
      console.log(`  에러: ${e.message}`);
      addEvent({ kind: "fail", date: post.date, site: post.site, reason: e.message });
    }
    save();
  }
}

const mode = process.argv.includes("--post") ? "post" : process.argv.includes("--check") ? "check" : "dry-run";
try {
  if (mode === "check") await check();
  else await run(mode);
} catch (e) {
  console.error(`에러: ${e.message}`);
  if (mode === "post") addEvent({ kind: "fail", date: kstDay(Date.now()), site: "", reason: e.message });
  process.exit(1);
}
