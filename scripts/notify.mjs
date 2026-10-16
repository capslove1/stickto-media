// 게시 실행이 끝난 뒤 GitHub Issue 로 알린다.
// - 남은 approved 글이 3개 이하이면 "예약 글 N개 남음 - 대기열 채워주세요"
// - 실패(failed / partial / missed)한 글마다 "게시 실패 - 날짜 현장번호"
// - 실행 자체가 실패하면 "게시 실패 - 날짜 실행 오류"
// 같은 제목의 열린 Issue 가 있으면 새로 만들지 않는다.
// 시험: NOTIFY_DRY=1 이면 GitHub 에 요청하지 않고 할 일만 보여 준다. QUEUE_FILE 로 다른 파일을 읽을 수 있다.

import { readFileSync, writeFileSync } from "node:fs";

const QUEUE_FILE = process.env.QUEUE_FILE || new URL("../posts/queue.json", import.meta.url);
const REPO = process.env.REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const RUN_URL = process.env.RUN_URL || "";
const OUTCOME = process.env.PUBLISH_OUTCOME || "success";
const DRY = process.env.NOTIFY_DRY === "1";
const LOW_LIMIT = 3;
const MENTION = "@capslove1";

const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} 실패 (${res.status}) ${await res.text()}`);
  return res.json();
}

let openTitles = null;
async function createIssue(title, body) {
  if (DRY) { console.log(`[시험] 이슈 만들 예정: ${title}`); return true; }
  openTitles ??= new Set((await gh("GET", "issues?state=open&per_page=100")).filter((i) => !i.pull_request).map((i) => i.title));
  if (openTitles.has(title)) { console.log(`이미 열린 이슈가 있어 건너뜀: ${title}`); return false; }
  const issue = await gh("POST", "issues", { title, body: `${body}\n\n${MENTION}` });
  openTitles.add(title);
  console.log(`이슈 만듦: ${title} → ${issue.html_url}`);
  return true;
}

async function main() {
  if (!DRY && (!REPO || !TOKEN)) throw new Error("REPO 또는 GITHUB_TOKEN 이 없어요.");
  const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  let changed = false;

  // 1) 실행 자체 실패
  if (OUTCOME === "failure") {
    await createIssue(`게시 실패 - ${todayKst()} 실행 오류`,
      `예약 게시 실행이 중간에 멈췄어요. 토큰·권한·네트워크 문제일 수 있어요.\n\n실행 기록: ${RUN_URL}`);
  }

  // 2) 글별 실패
  for (const item of queue.posts) {
    if (!["failed", "partial", "missed"].includes(item.status) || item.notified) continue;
    const reasons = {
      failed: "두 채널 모두 올라가지 않았어요.",
      partial: "한쪽 채널만 올라갔어요.",
      missed: "예약 시각보다 6시간 넘게 늦어 올리지 않았어요. 날짜를 다시 잡아 주세요.",
    };
    const detail = ["instagram", "threads"]
      .map((ch) => item.result?.[ch]?.missed ? `- ${ch}: 예약 시각보다 6시간 넘게 늦어 올리지 않음` : item.result?.[ch]?.error ? `- ${ch}: ${item.result[ch].error}` : item.result?.[ch]?.permalink ? `- ${ch}: 게시됨 ${item.result[ch].permalink}` : null)
      .filter(Boolean);
    if (item.result?.error) detail.push(`- ${item.result.error}`);
    await createIssue(`게시 실패 - ${item.date} ${item.site ?? item.id}`,
      `${reasons[item.status]}\n\n글: ${item.id} (상태: ${item.status})\n${detail.join("\n")}\n\n실행 기록: ${RUN_URL}`);
    item.notified = true;
    changed = true;
  }

  // 3) 대기열 부족
  // 대기열 알림은 시공 글(사진·릴스)만 센다. 스레드 일상 글(type: "text")은 빼고 센다.
  const left = queue.posts.filter((p) => p.status === "approved" && p.type !== "text");
  if (left.length <= LOW_LIMIT) {
    const list = left.map((p) => `- ${p.date} ${p.site}`).join("\n") || "- (없음)";
    await createIssue(`예약 글 ${left.length}개 남음 - 대기열 채워주세요`,
      `아직 올라가지 않은 승인된 시공 글(사진·릴스)이 ${left.length}개 남았어요.\n\n${list}\n\nClaude 에게 "대기열 확인해 줘"라고 말하면 다음 2주 치 글을 만들어 보여 줘요.`);
  } else {
    console.log(`남은 시공 글 ${left.length}개 - 알림 없음`);
  }

  if (changed && !DRY) writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
}

main().catch((e) => {
  console.error(`알림 에러: ${e.message}`);
  process.exit(1);
});
