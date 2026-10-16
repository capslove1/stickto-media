// 토큰 점검 (매일 1번): 카카오 토큰 갱신 + 만료 임박 토큰을 카톡으로 알린다.
// - 카카오 갱신이 실패하면 이 실행이 실패로 끝난다 → GitHub 가 메일로 알려 준다.
// - 인스타·스레드 토큰은 만료 7일 전부터, GH_SECRETS_PAT 는 14일 전부터 매일 알린다.
// 만료일은 GitHub 변수(vars): IG_TOKEN_EXPIRES, THREADS_TOKEN_EXPIRES, GH_SECRETS_PAT_EXPIRES (예: 2026-12-13)

import { refreshKakao, sendKakao, kstDate, short } from "./kakao.mjs";

const r = await refreshKakao(); // 실패하면 여기서 에러 → 실행 실패 → 메일
console.log(`카카오 토큰 갱신: 됨${r.rotated ? ` (새 refresh token 을 두 저장소 비밀값에 넣음, ${r.refreshDays}일)` : ""}`);

const today = kstDate();
const daysLeft = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
const CHECKS = [
  ["인스타 토큰", process.env.IG_TOKEN_EXPIRES, 7, "새 토큰을 받아 stickto-media·stickto-reels 비밀값을 바꿔 주세요"],
  ["스레드 토큰", process.env.THREADS_TOKEN_EXPIRES, 7, "새 토큰을 받아 stickto-media 비밀값을 바꿔 주세요"],
  ["페이스북 데이터 접근", process.env.FB_DATA_ACCESS_EXPIRES, 14, "Graph API Explorer 에서 다시 로그인해 페이지 토큰을 새로 받아 주세요"],
  ["GitHub 토큰(GH_SECRETS_PAT)", process.env.GH_SECRETS_PAT_EXPIRES, 14, "새로 만들어 두 저장소 비밀값을 바꿔 주세요. 없으면 카카오 토큰 자동 갱신이 멈춰요"],
];
const warn = [];
for (const [name, date, within, todo] of CHECKS) {
  if (!date) { console.log(`::warning::${name} 만료일 변수가 없어요.`); continue; }
  const left = daysLeft(date);
  console.log(`${name}: ${date} (${left}일 남음)`);
  if (left <= within) warn.push(`[토큰] ${name} ${left < 0 ? "만료됨" : `${left}일 뒤 만료`}(${short(date)}) · ${todo}`);
}
if (process.env.KAKAO_TEST === "true") warn.push("[시험] GitHub 에서 보낸 토큰 점검 알림이에요.");
if (warn.length) await sendKakao(warn.join("\n"), process.env.RUN_URL || undefined);
