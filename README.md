# stickto-media

착붙인테리어필름 인스타그램·스레드 예약 게시용 저장소예요.

- `posts/queue.json`: 예약 목록. `status`가 `approved`인 글만 예약 시각에 올라가요.
  - 인스타와 스레드 날짜를 따로 둘 수 있어요: `instagram.date` 나 `threads.date` 가 있으면 그 날짜, 없으면 `date`. (릴스와 번갈아 올리려고 인스타 사진 날짜만 따로 잡을 때 써요. 릴스는 비공개 저장소 stickto-reels 에서 올려요)
- `media/`: 게시용 사진(1080×1350, 위치·촬영 정보 제거). **이 저장소는 공개라서 누구나 볼 수 있어요.** 올려도 되는 사진만 넣어요. 하청 현장(H237·H238·H239) 사진은 넣지 않아요. 다른 현장 사진도 건물·상가·업체 이름이 보이면 넣지 않아요.
- `scripts/publish.mjs`: 게시 스크립트 (`--dry-run` / `--check` / `--post`)
- `scripts/spread-times.mjs`: 기준 시각(08:30·12:00·20:00·21:00) 그대로인 새 글을 앞뒤 15분 안의 임의 시각으로 바꿔요. 같은 날 같은 시각, 앞뒤 날 같은 시각은 피해요. 새 글은 기준 시각으로 넣고 이 스크립트를 돌리면 돼요(게시 스크립트도 실행할 때마다 자동으로 해요). 꼭 그 시각에 올려야 하는 글은 `"fixedTime": true`.
- `.github/workflows/publish.yml`: 월~토 07:05~22:35(한국 시간) 30분마다 자동 실행 (GitHub 예약 실행이 늦거나 빠질 때가 있어서). 스레드 일상 08:15~08:45·20:45~21:15, 스레드 시공 글 11:45~12:15, 인스타 19:45~20:15. 예약 60분 전부터 맡아서 예약 시각까지 기다렸다가 올리고, 6시간 넘게 늦으면 올리지 않아요.
- 중복 방지: 실행은 한 번에 하나만 돌고, 올리기 직전에 원격 queue.json 과 계정의 최근 게시물 10개를 확인해서 같은 글이 있으면 다시 올리지 않아요.

- 카카오톡 알림(나에게 보내기): 게시 실행 뒤 `scripts/kakao-notify.mjs` 가 실패·missed 를 보내고, `KAKAO_SUCCESS_UNTIL` 날짜까지는 성공도 보내요. `.github/workflows/token-check.yml` 이 매일 09:10 카카오 토큰을 갱신하고(실패하면 GitHub 메일), 만료 임박 토큰(인스타·스레드 7일 전, GH_SECRETS_PAT 14일 전)을 카톡으로 알려요. 카카오가 새 refresh token 을 주면 두 저장소 비밀값을 자동으로 바꿔요.

## 필요한 설정 (Settings → Secrets and variables → Actions)
- Secrets: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `THREADS_ACCESS_TOKEN`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, `KAKAO_REFRESH_TOKEN`, `GH_SECRETS_PAT`(두 저장소 Secrets 쓰기 전용)
- Variables: `IG_TOKEN_EXPIRES`, `THREADS_TOKEN_EXPIRES`, `GH_SECRETS_PAT_EXPIRES` (예: `2026-12-10`), `KAKAO_SUCCESS_UNTIL`(성공 알림 마지막 날). 만료 7일 전부터 실행 결과에 경고가 떠요.

## 상태 값
`draft` 초안 → `approved` 승인 → `posted` 게시 완료 / `partial` 한쪽만 성공 / `failed` 실패 / `missed` 예약 시각보다 6시간 넘게 늦어 올리지 않음
