// 구글(유튜브·Blogger) 접속 토큰. stickto-media 와 stickto-reels 에 같은 파일이 있다.
// 필요한 비밀값: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// 토큰 값은 절대 출력하지 않는다.

let accessToken;

export function googleReady() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

export async function googleToken() {
  if (accessToken) return accessToken;
  if (!googleReady()) throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN 이 설정되지 않았어요.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) {
    const hint = t.error === "invalid_grant" ? " (구글 로그인을 다시 해서 GOOGLE_REFRESH_TOKEN 을 바꿔야 해요)" : "";
    throw new Error(`구글 토큰 갱신 실패: ${t.error ?? res.status} ${t.error_description ?? ""}${hint}`.trim());
  }
  accessToken = t.access_token;
  return accessToken;
}

// 구글 API 호출. 실패하면 구글이 준 메시지를 담아 에러를 던진다.
export async function gapi(url, init = {}) {
  const token = await googleToken();
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 200) } }; }
  if (!res.ok) {
    const e = data.error ?? {};
    const reason = e.errors?.[0]?.reason ?? e.status ?? res.status;
    throw new Error(`${e.message ?? res.statusText} (${reason})`);
  }
  return { data, res };
}
