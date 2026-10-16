// 예약 시각 흩기: 기준 시각(08:30·12:00·20:00·21:00) 그대로인 글을 앞뒤 15분 안의 임의 시각으로 바꾼다.
// 실행: node scripts/spread-times.mjs  (publish.mjs 도 실행할 때마다 먼저 이 작업을 한다)
// - 아직 올리지 않은 글(draft·approved)만 바꾼다. 정확히 그 시각에 올려야 하는 글은 "fixedTime": true 로 둔다.
// - 같은 날 다른 글과 같은 시각, 앞뒤 날의 같은 시각, 딱 기준 시각은 피한다.

import { readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

const QUEUE_FILE = new URL("../posts/queue.json", import.meta.url);
const BASE_TIMES = ["08:30", "12:00", "20:00", "21:00"];
const SPREAD_MIN = 15;
const CHANNELS = ["instagram", "threads"];

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const chDate = (item, ch) => item[ch]?.date ?? item.date; // 채널별 날짜가 있으면 그 날짜
const shiftDate = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function spreadTimes(queue) {
  // 날짜별로 이미 쓰인 시각
  const used = new Map();
  const use = (date, time) => (used.get(date) ?? used.set(date, new Set()).get(date)).add(time);
  for (const item of queue.posts) for (const ch of CHANNELS) if (item[ch]) use(chDate(item, ch), item[ch].time ?? item.time);

  const changes = [];
  for (const item of queue.posts) {
    if (!["draft", "approved"].includes(item.status) || item.fixedTime) continue;
    for (const ch of CHANNELS) {
      const from = item[ch]?.time;
      if (!BASE_TIMES.includes(from)) continue;
      const busy = (t) => [-1, 0, 1].some((d) => used.get(shiftDate(chDate(item, ch), d))?.has(t));
      let to;
      for (let i = 0; i < 100 && !to; i++) {
        const offset = randomInt(-SPREAD_MIN, SPREAD_MIN + 1);
        const t = toTime(toMin(from) + offset);
        if (offset !== 0 && !busy(t)) to = t;
      }
      if (!to) continue; // 빈 시각이 없으면 그대로 둔다
      item[ch].time = to;
      use(chDate(item, ch), to);
      changes.push({ id: item.id, ch, date: chDate(item, ch), from, to });
    }
  }
  return changes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  const changes = spreadTimes(queue);
  for (const c of changes) console.log(`[${c.id}] ${c.ch === "instagram" ? "인스타" : "스레드"} ${c.date} ${c.from} → ${c.to}`);
  if (changes.length) writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(changes.length ? `${changes.length}개 시각을 바꿨어요.` : "바꿀 시각이 없어요.");
}
