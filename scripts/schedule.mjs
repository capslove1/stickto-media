// 일정표 만들기: 네 대기열을 "언제 · 어디에 · 무엇을" 한 줄씩으로 바꾼다. stickto-media 와 stickto-reels 에 같은 파일이 있다.
//   posts   = stickto-media posts/queue.json   (스레드·인스타·페이스북)
//   blogger = stickto-media blogger/queue.json (구글 블로그)
//   reels   = stickto-reels reels/queue.json   (인스타 릴스)
//   shorts  = stickto-reels shorts/queue.json  (유튜브 쇼츠, 시각은 공개 시각)
// 일정표 알림(digest.mjs)과 일정 변경 알림(schedule-change.mjs)이 쓴다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEK = "일월화수목금토";
const BASE_TIMES = ["08:30", "12:00", "20:00", "21:00"]; // spread-times.mjs 가 앞뒤 15분 안으로 흩기 전의 기준 시각
const ORDER = ["threads", "instagram", "facebook", "blogger", "reels", "shorts"];
export const byTime = (a, b) => a.at - b.at || ORDER.indexOf(a.ch) - ORDER.indexOf(b.ch) || a.key.localeCompare(b.key);
export const CH = { threads: "스레드", instagram: "인스타", facebook: "페북", blogger: "구글블로그", reels: "릴스", shorts: "쇼츠" };

export const kstDay = (ms = Date.now()) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = 일요일
export const dayLabel = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${WEEK[weekday(d)]})`; // 10/19(월)
const atMs = (date, time) => Date.parse(`${date}T${time}:00+09:00`);

// 상태: upcoming(올릴 예정) · ok(올라감) · fail(실패·내용 다름) · missed(늦어서 안 올림)
function make(src, item, ch, date, time, label, r, extra = {}) {
  const e = { key: `${src}:${item.id}:${ch}`, src, item, ch, date, time, at: atMs(date, time), label, url: null, verify: null, note: "", ...extra };
  if (r?.missed || item.status === "missed") e.state = "missed";
  else if (r?.error) { e.state = "fail"; e.note = r.error; }
  else if (r?.id || r?.postId || r?.videoId) {
    e.url = r.permalink ?? r.url ?? null;
    e.verify = r.verify ?? null;
    e.state = r.verify?.ok === false ? "fail" : "ok";
    if (r.verify?.ok === false) e.note = r.verify.issue;
  } else e.state = "upcoming";
  return e;
}

export function buildEntries({ posts, blogger, reels, shorts } = {}) {
  const out = [];
  const live = (s) => ["approved", "posted", "partial", "failed", "missed", "scheduled", "public", "locked"].includes(s);
  for (const item of posts?.posts ?? []) {
    if (!live(item.status)) continue;
    const label = item.type === "text" ? "일상" : item.site ?? item.id;
    // 페이스북은 인스타 사진 게시물을 같은 날짜·시각에 그대로 따라간다(publish.mjs 와 같은 조건).
    const fbOn = item.result?.facebook || (item.status === "approved" && item.instagram && item.facebook !== false && (item.type ?? "photo") !== "reel");
    for (const ch of ["threads", "instagram", "facebook"]) {
      const c = ch === "facebook" ? (fbOn ? item.instagram : null) : item[ch];
      if (!c) continue;
      const r = item.result?.[ch];
      if (item.status !== "approved" && !r) continue; // 끝난 글인데 이 채널 기록이 없으면 뺀다
      const time = c.time ?? item.time;
      const approx = item.status === "approved" && !r && !item.fixedTime && BASE_TIMES.includes(time);
      out.push(make("posts", item, ch, c.date ?? item.date, time, label, r, { approx }));
    }
  }
  for (const item of blogger?.posts ?? []) {
    if (!live(item.status)) continue;
    out.push(make("blogger", item, "blogger", item.date, item.time, item.site ?? "", item.result));
  }
  for (const item of reels?.posts ?? []) {
    if (!live(item.status)) continue;
    out.push(make("reels", item, "reels", item.date, item.time, item.site ?? item.id.slice(11), item.result));
  }
  for (const item of shorts?.shorts ?? []) {
    if (!live(item.status)) continue;
    const r = item.result ?? {};
    const e = make("shorts", item, "shorts", item.date, item.time, item.site ?? item.id.slice(11), null);
    // 쇼츠는 미리 비공개로 올리고 공개 시각에 유튜브가 공개한다. 공개가 확인돼야 "올라감".
    if (item.status === "public") Object.assign(e, { state: "ok", url: r.url, verify: r.verify ?? null });
    else if (item.status === "locked") Object.assign(e, { state: "fail", url: r.url, note: `공개 안 됨(${r.checked?.privacy ?? "?"})` });
    else if (item.status === "failed") Object.assign(e, { state: "fail", note: r.error ?? "" });
    else if (item.status === "missed") e.state = "missed";
    else if (r.verify?.ok === false) Object.assign(e, { state: "fail", url: r.url, note: r.verify.issue });
    else if (item.status === "scheduled") e.url = r.url; // 비공개로 올라가 공개를 기다리는 중
    out.push(e);
  }
  return out.sort(byTime);
}

// 한 줄: "08:37 스레드 일상". 인스타와 페북이 같은 글·같은 시각이면 "인스타·페북 H064" 한 줄로 합친다.
export function lines(list, mark = () => "") {
  const rows = [];
  for (const e of list) {
    const prev = rows.at(-1);
    if (prev && e.ch === "facebook" && prev.e.ch === "instagram" && prev.e.item === e.item && prev.e.time === e.time && mark(prev.e) === mark(e)) {
      prev.name = "인스타·페북";
      continue;
    }
    rows.push({ e, name: CH[e.ch] });
  }
  return rows.map(({ e, name }) => `${e.time}${e.approx ? "쯤" : ""} ${name} ${e.label}${e.ch === "shorts" ? " 공개" : ""}${mark(e)}`.trim());
}

// 카톡 텍스트는 200자까지라서 줄 단위로 나눠 여러 메시지로 만든다. 날짜 줄이 메시지 끝에 혼자 남지 않게 다음 메시지로 넘긴다.
const isDay = (row) => /^\d+\/\d+\(/.test(row);
export function chunk(header, rows, max = 200, cont = "(이어서)") {
  const msgs = [];
  let cur = [header];
  const len = (a) => a.join("\n").length;
  for (const row of rows) {
    if (len([...cur, row]) > max && cur.length > 1) {
      const carry = isDay(cur.at(-1)) && cur.length > 2 ? [cur.pop()] : [];
      msgs.push(cur.join("\n"));
      cur = [cont, ...carry];
    }
    cur.push(row);
  }
  msgs.push(cur.join("\n"));
  return msgs;
}

// 날짜별로 묶은 일정표: ["10/19(월)", " 08:37 스레드 일상", ...]
export function dayTable(list, mark) {
  const rows = [];
  for (const d of [...new Set(list.map((e) => e.date))].sort()) {
    rows.push(dayLabel(d));
    for (const l of lines(list.filter((e) => e.date === d), mark)) rows.push(` ${l}`);
  }
  return rows;
}

// 일정 비교: 앞으로 올릴 글(upcoming)만 본다. 새로 생김 / 시각 바뀜 / 빠짐
export function diffEntries(before, after, now = Date.now()) {
  const pick = (list) => new Map(list.filter((e) => e.state === "upcoming" && e.at >= now).map((e) => [e.key, e]));
  const b = pick(before), a = pick(after);
  const added = [], moved = [], removed = [];
  for (const [k, e] of a) {
    const old = b.get(k);
    if (!old) added.push(e);
    else if (old.date !== e.date || old.time !== e.time) moved.push({ e, from: old });
  }
  for (const [k, e] of b) if (!a.has(k)) removed.push(e);
  return { added, moved, removed };
}
