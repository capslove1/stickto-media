// 일정 변경 알림: 예약이 새로 잡히거나 바뀌면 바뀐 날의 일정표를 카톡으로 보낸다. stickto-media 와 stickto-reels 에 같은 파일이 있다.
// 실행: node scripts/schedule-change.mjs <이전 커밋>   (push 때 워크플로가 실행)
//       node scripts/schedule-change.mjs --test        (앞으로 3일 일정을 새로 잡힌 것처럼 보여 준다, "[시험]" 붙음)
// - 게시 결과 기록 커밋(GITHUB_TOKEN 으로 올림)은 워크플로를 깨우지 않아서, 사람이 올린 변경만 알린다.
// - 바뀐 날의 일정 전체를 보내고, 바뀐 줄에 [새] · [변경 12:00→] · [취소] 를 붙인다.
// - 새로 잡히거나 바뀐 글이 올리기 전 검사(checks.mjs)에 걸리면 맨 위에 ⚠ 로 알린다.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEntries, diffEntries, dayTable, chunk, dayLabel, kstDay, addDays, byTime, CH } from "./schedule.mjs";
import { checkEntry } from "./checks.mjs";
import { sendKakao } from "./kakao.mjs";

const ROOT = new URL("../", import.meta.url);
const FILES = { posts: "posts/queue.json", blogger: "blogger/queue.json", reels: "reels/queue.json", shorts: "shorts/queue.json" };
const arg = process.argv[2] ?? "";
const test = arg === "--test";
const label = process.env.NOTIFY_LABEL || "예약 게시";

// rev 가 있으면 그 커밋의 대기열, 없으면 지금 파일. 그 커밋에 파일이 없었으면 빈 대기열로 본다.
function load(rev) {
  const out = {};
  for (const [k, f] of Object.entries(FILES)) {
    if (!existsSync(new URL(f, ROOT))) continue;
    try {
      out[k] = JSON.parse(rev ? execFileSync("git", ["show", `${rev}:${f}`], { encoding: "utf8", cwd: fileURLToPath(ROOT), stdio: ["ignore", "pipe", "ignore"] }) : readFileSync(new URL(f, ROOT), "utf8"));
    } catch {
      out[k] = undefined;
    }
  }
  return out;
}

const now = Date.now();
const after = buildEntries(load());
let diff;
if (test) {
  const until = addDays(kstDay(now), 3);
  diff = { added: after.filter((e) => e.state === "upcoming" && e.at >= now && e.date <= until), moved: [], removed: [] };
} else {
  if (!/^[0-9a-f]{7,40}$/.test(arg) || /^0+$/.test(arg)) {
    console.log(`이전 커밋(${arg || "없음"})을 알 수 없어서 비교를 건너뛰어요.`);
    process.exit(0);
  }
  diff = diffEntries(buildEntries(load(arg)), after, now);
}
const { added, moved, removed } = diff;
if (!added.length && !moved.length && !removed.length) {
  console.log("바뀐 일정이 없어요.");
  process.exit(0);
}

// 바뀐 날의 일정 전체(앞으로 올릴 글) + 취소된 글
const days = new Set([...added.map((e) => e.date), ...moved.flatMap((m) => [m.e.date, m.from.date]), ...removed.map((e) => e.date)]);
const movedBy = new Map(moved.map((m) => [m.e.key, m.from]));
const addedKeys = new Set(added.map((e) => e.key));
const removedKeys = new Set(removed.map((e) => e.key));
const list = [...after.filter((e) => days.has(e.date) && e.state === "upcoming" && e.at >= now), ...removed].sort(byTime);
const mark = (e) => {
  if (removedKeys.has(e.key)) return " [취소]";
  if (addedKeys.has(e.key)) return " [새]";
  const from = movedBy.get(e.key);
  return from ? ` [변경 ${from.date !== e.date ? `${dayLabel(from.date)} ` : ""}${from.time}→]` : "";
};

// 올리기 전 검사: 지금 고치면 되니까 미리 알린다.
const warn = [...added, ...moved.map((m) => m.e)].flatMap((e) =>
  checkEntry(e).map((p) => `⚠ ${dayLabel(e.date)} ${e.time} ${CH[e.ch]} ${e.label}: ${p}`.slice(0, 120)));

const counts = [added.length && `새 ${added.length}`, moved.length && `변경 ${moved.length}`, removed.length && `취소 ${removed.length}`].filter(Boolean).join("·");
const header = `${test ? "[시험] " : ""}[일정 변경] ${label} ${counts}`;
const msgs = chunk(header, [...warn, ...dayTable(list, mark)], 200, (test ? "[시험] " : "") + "[일정 변경] (이어서)");
for (const m of msgs) {
  console.log(`---\n${m}`);
  await sendKakao(m, process.env.RUN_URL || undefined);
}
