# 부동산 시그널

전세가율·비교 단지 배율로 아파트 예상 고점을 보는 대시보드.
데이터: 국토교통부 실거래가 공개시스템 (공공데이터포털 API), 2020-01~

## 자동 업데이트
- `.github/workflows/update.yml` 이 매일 06:00 KST 에 국토부 실거래를 받아 사이트를 다시 배포합니다.
- 수동 실행: Actions → 실거래 업데이트 → Run workflow
- 필요한 설정: 저장소 Secret `MOLIT_KEY` (공공데이터포털 인증키), Settings → Pages → Source: GitHub Actions
- `history/` 는 2020-01 이후 원자료 압축본 (매번 전체를 다시 받지 않기 위함)
