// 올리기 전 검사: 규칙에 어긋나는 글은 올리지 않는다. publish.mjs 와 schedule-change.mjs 가 쓴다.
// - 스레드: 해시태그는 #대구인테리어필름 1개만 (일반 단어 태그는 글 밑 주제 태그로 어색하게 남는다), 전화번호 없음, 500자 이하
// - 인스타: 해시태그 5개까지, 캡션 2200자 이하, 사진 1~10장
// 문제가 없으면 빈 배열을 돌려준다.

export const THREADS_TAG = "#대구인테리어필름";
const IG_TAG_LIMIT = 5;
const PHONE = /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/;

// 스레드는 이모지를 UTF-8 바이트 수로 센다.
const threadsLength = (t) => [...t].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? Buffer.byteLength(ch) : 1), 0);
const tagsOf = (t) => t.match(/#[^\s#]+/g) ?? [];

export function validate(item, ch) {
  const problems = [];
  const c = item[ch];
  if (ch === "threads") {
    const tags = tagsOf(c.text);
    if (tags.length !== 1 || tags[0] !== THREADS_TAG) problems.push(`스레드 해시태그는 ${THREADS_TAG} 1개만 써야 해요(지금: ${tags.join(" ") || "없음"}).`);
    if (PHONE.test(c.text)) problems.push("스레드 글에 전화번호가 있어요.");
    if (threadsLength(c.text) > 500) problems.push("스레드 글이 500자를 넘어요.");
  } else if (ch === "instagram") {
    const tags = tagsOf(c.caption);
    if (tags.length > IG_TAG_LIMIT) problems.push(`인스타 해시태그가 ${tags.length}개예요(${IG_TAG_LIMIT}개까지).`);
    if (c.caption.length > 2200) problems.push("인스타 캡션이 2200자를 넘어요.");
  }
  const n = (c.images ?? []).length;
  if (ch === "instagram" && (n < 1 || n > 10)) problems.push(`인스타 사진은 1~10장이어야 해요(지금 ${n}장).`);
  if (ch === "threads" && n > 10) problems.push(`스레드 사진은 10장 이하여야 해요(지금 ${n}장).`);
  if (ch === "facebook" && n < 1) problems.push("페이스북에 올릴 사진이 없어요.");
  return problems;
}

// 일정표 항목(schedule.mjs 의 entry)을 검사한다. 원본 글이 필요하다.
export function checkEntry(e) {
  if (e.src !== "posts" || !e.item[e.ch]) return [];
  return validate(e.item, e.ch);
}
