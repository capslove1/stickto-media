# stickto-media

착붙인테리어필름 인스타그램·스레드 예약 게시용 저장소예요.

- `posts/queue.json`: 예약 목록. `status`가 `approved`인 글만 예약 시각에 올라가요.
- `media/`: 게시용 사진(1080×1350, 위치·촬영 정보 제거). **이 저장소는 공개라서 누구나 볼 수 있어요.** 올려도 되는 사진만 넣어요.
- `scripts/publish.mjs`: 게시 스크립트 (`--dry-run` / `--check` / `--post`)
- `.github/workflows/publish.yml`: 월~토 08:10·11:40·19:40·20:40(한국 시간) 자동 실행. 스레드 일상 08:30·21:00, 스레드 시공 글 12:00, 인스타 20:00. 예약 30분 전부터 올리고 3시간 넘게 늦으면 올리지 않아요.

## 필요한 설정 (Settings → Secrets and variables → Actions)
- Secrets: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `THREADS_ACCESS_TOKEN`
- Variables: `IG_TOKEN_EXPIRES`, `THREADS_TOKEN_EXPIRES` (예: `2026-12-10`). 만료 7일 전부터 실행 결과에 경고가 떠요.

## 상태 값
`draft` 초안 → `approved` 승인 → `posted` 게시 완료 / `partial` 한쪽만 성공 / `failed` 실패 / `missed` 예약 시각보다 3시간 넘게 늦어 올리지 않음
