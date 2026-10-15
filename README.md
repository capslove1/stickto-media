# stickto-media

착붙인테리어필름 인스타그램·스레드 예약 게시용 저장소예요.

- `posts/queue.json`: 예약 목록. `status`가 `approved`인 글만 예약 시각에 올라가요.
- `media/`: 게시용 사진(1080×1350, 위치·촬영 정보 제거). **이 저장소는 공개라서 누구나 볼 수 있어요.** 올려도 되는 사진만 넣어요.
- `scripts/publish.mjs`: 게시 스크립트 (`--dry-run` / `--check` / `--post`)
- `.github/workflows/publish.yml`: 월·수·금 11:00(한국 시간) 자동 실행. Actions 탭에서 직접 실행할 수도 있어요.

## 필요한 설정 (Settings → Secrets and variables → Actions)
- Secrets: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `THREADS_ACCESS_TOKEN`
- Variables: `IG_TOKEN_EXPIRES`, `THREADS_TOKEN_EXPIRES` (예: `2026-12-10`). 만료 7일 전부터 실행 결과에 경고가 떠요.

## 상태 값
`draft` 초안 → `approved` 승인 → `posted` 게시 완료 / `partial` 한쪽만 성공 / `failed` 실패 / `missed` 예약 시각이 24시간 넘게 지나 올리지 않음
