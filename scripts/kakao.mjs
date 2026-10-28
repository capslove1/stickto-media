// 카카오톡 "나에게 보내기" 알림. stickto-media 와 stickto-reels 에 같은 파일이 있다.
// 필요한 비밀값: KAKAO_REST_API_KEY, KAKAO_CLIENT_SECRET, KAKAO_REFRESH_TOKEN, GH_SECRETS_PAT
// - 보낼 때마다 refresh token 으로 접속 토큰을 새로 받는다.
// - 카카오가 refresh token 을 새로 주면(만료 1달 전부터) 두 저장소의 GitHub 비밀값을 바로 바꾼다.
// - 토큰 값은 절대 출력하지 않는다.

import { execFileSync } from "node:child_process";

const REPOS = ["capslove1/stickto-media", "capslove1/stickto-reels"];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
let accessToken;

export const kstDate = (ms = Date.now()) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
export const short = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`; // 2026-10-19 → 10/19

export function kakaoReady() {
  return Boolean(process.env.KAKAO_REST_API_KEY && process.env.KAKAO_REFRESH_TOKEN);
}

// 접속 토큰 받기. 실패하면 에러를 던진다(토큰 점검 실행이 실패로 끝나서 GitHub 가 메일을 보낸다).
export async function refreshKakao() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.KAKAO_REST_API_KEY ?? "",
    refresh_token: process.env.KAKAO_REFRESH_TOKEN ?? "",
  });
  if (process.env.KAKAO_CLIENT_SECRET) body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", body });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`카카오 토큰 갱신 실패: ${t.error ?? res.status} ${t.error_code ?? ""} ${t.error_description ?? ""}`.trim());
  accessToken = t.access_token;
  let rotated = false;
  if (t.refresh_token) {
    // 새 refresh token 을 두 저장소 비밀값에 넣는다. 하나라도 실패하면 에러(메일로 알림).
    for (const repo of REPOS) {
      execFileSync("gh", ["secret", "set", "KAKAO_REFRESH_TOKEN", "-R", repo], {
        input: t.refresh_token,
        env: { ...process.env, GH_TOKEN: process.env.GH_SECRETS_PAT ?? "" },
        stdio: ["pipe", "ignore", "pipe"],
      });
    }
    rotated = true;
  }
  return { rotated, refreshDays: t.refresh_token_expires_in ? Math.round(t.refresh_token_expires_in / 86400) : null };
}

// 나에게 보내기. 실패해도 게시 작업은 그대로 두려고 에러를 던지지 않고 false 를 돌려준다.
// buttons: [{ title, url }] 최대 2개. 주면 "실행 기록 보기" 대신 이 버튼들을 단다.
export async function sendKakao(text, linkUrl = "https://github.com/capslove1/stickto-media/actions", buttons = []) {
  if (!kakaoReady()) {
    console.log("카카오 알림: 비밀값이 없어서 건너뜀");
    return false;
  }
  try {
    if (!accessToken) await refreshKakao();
    const template = {
      object_type: "text",
      text: text.slice(0, 200), // 텍스트 템플릿은 200자까지
      link: { web_url: linkUrl, mobile_web_url: linkUrl },
    };
    if (buttons.length) template.buttons = buttons.slice(0, 2).map((b) => ({ title: b.title, link: { web_url: b.url, mobile_web_url: b.url } }));
    else template.button_title = "실행 기록 보기";
    const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
    const r = await res.json().catch(() => ({}));
    if (r.result_code !== 0) throw new Error(`${r.code ?? res.status} ${r.msg ?? ""}`);
    console.log("카카오 알림 보냄");
    return true;
  } catch (e) {
    console.log(`::warning::카카오 알림을 보내지 못했어요: ${e.message}`);
    return false;
  }
}

// 게시 결과(events)를 한 메시지로 묶는다. events: [{ kind: ok|fail|missed, ch, date, site, reason, permalink }]
export function formatEvents(events) {
  const CH = { instagram: "인스타", facebook: "페이스북", threads: "스레드", reels: "릴스", shorts: "쇼츠", blogger: "구글 블로그" };
  const lines = events.map((e) => {
    if (e.kind === "notice") return `[알림] ${e.text}`;
    const head = e.kind === "ok" ? "[완료]" : e.kind === "missed" ? "[missed]" : "[실패]";
    const tail = e.kind === "ok" ? "" : ` · ${(e.reason ?? "").slice(0, 60)}`;
    return `${head} ${short(e.date)} ${CH[e.ch] ?? e.ch} ${e.site ?? ""}${tail}`.trim();
  });
  return lines.join("\n");
}
