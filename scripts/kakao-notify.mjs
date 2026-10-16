// 게시 실행이 끝난 뒤 카카오톡으로 결과를 알린다.
// - publish 가 남긴 .kakao-events.json 을 읽는다 (커밋하지 않는 파일)
// - 실패·missed 는 항상, 성공은 KAKAO_SUCCESS_UNTIL 날짜까지만 보낸다.
// - 게시 단계 자체가 에러로 끝났는데 기록이 없으면 "실행 실패"를 보낸다.
// 실행: node scripts/kakao-notify.mjs [이벤트 파일]

import { readFileSync, existsSync } from "node:fs";
import { sendKakao, successOn, formatEvents } from "./kakao.mjs";

const file = process.argv[2] ?? ".kakao-events.json";
const events = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const runUrl = process.env.RUN_URL || undefined;
const label = process.env.NOTIFY_LABEL || "예약 게시";

const show = events.filter((e) => e.kind !== "ok" || successOn());
if (show.length) {
  await sendKakao(`${label}\n${formatEvents(show)}`, runUrl);
} else if (process.env.PUBLISH_OUTCOME === "failure") {
  await sendKakao(`[실패] ${label} 실행이 에러로 끝났어요. 실행 기록을 확인해 주세요.`, runUrl);
} else {
  console.log("카카오 알림: 보낼 내용 없음");
}
