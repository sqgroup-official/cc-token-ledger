# cc-token-ledger

Claude Code 대화 기록에 남은 토큰 사용량을 날짜별·에이전트별·모델별 표로 보여 주는 도구입니다.

**대화 내용은 읽어서 버리고 출력·저장하지 않습니다. 숫자·모델 이름·에이전트 이름·날짜만 나옵니다. 네트워크 접속 없음, 의존성 0.**

```
git clone https://github.com/sqgroup-official/cc-token-ledger.git
cd <프로젝트 폴더>
node /경로/cc-token-ledger/ledger.js
```

- 필요한 것: Node.js. 개발자가 실제로 확인한 버전은 v24.14.0입니다(더 낮은 버전은 확인하지 못했습니다). 설치할 패키지는 없습니다.
- 환산값은 입력 토큰 1을 기준으로 한 상대 비교용 숫자입니다. 금액이 아니고, 구독 요금제의 사용 한도 계산과도 다릅니다. 가중치는 Anthropic 가격 문서(https://platform.claude.com/docs/en/about-claude/pricing, 확인 2026-10-09)를 따르며 가격이 바뀌면 달라질 수 있습니다.

## 실행

토큰을 재고 싶은 프로젝트 폴더로 이동한 뒤 `ledger.js`를 실행합니다. 도구는 프로젝트 밖 어디에 받아 두어도 됩니다.

```
node /경로/cc-token-ledger/ledger.js
node /경로/cc-token-ledger/ledger.js --since 2026-10-08
node /경로/cc-token-ledger/ledger.js --since 2026-10-01 --until 2026-10-07
node /경로/cc-token-ledger/ledger.js --all
node /경로/cc-token-ledger/ledger.js --dir "기록/폴더"
```

| 옵션 | 뜻 |
|---|---|
| `--since YYYY-MM-DD` | 이 날부터(한국 시간 KST 기준, 그 날 포함) |
| `--until YYYY-MM-DD` | 이 날까지(KST, 그 날 포함) |
| `--dir <폴더>` | 기록 폴더를 직접 지정 |
| `--all` | `~/.claude/projects/` 아래 모든 프로젝트를 합산 |
| `--config <파일>` | 설정 파일 지정(아래 "설정 파일") |

기록 폴더는 `--dir` > `--all` > 현재 폴더 순으로 정합니다. 현재 폴더로 정할 때는 `~/.claude/projects/` 아래에서 현재 폴더의 절대 경로를 바꾼 이름(영문·숫자가 아닌 글자는 모두 `-`)의 폴더를 찾습니다. 예: `C:\Users\alice\My_App` 은 `C--Users-alice-My-App`. 못 찾으면 다른 폴더를 추측하지 않고 `[오류]`와 폴더 목록(최근 수정 순 10개)을 보여 준 뒤 종료 코드 1로 끝납니다. 그때는 `--dir`이나 `--all`로 다시 실행하세요.

## 표 읽는 법

- **입력**: 캐시에 걸리지 않고 새로 보낸 입력 토큰.
- **캐시 쓰기**: 긴 앞부분(지침, 파일 내용 등)을 캐시에 처음 저장할 때 쓴 토큰. 캐시 읽기보다 비쌉니다.
- **캐시 읽기**: 이미 저장된 앞부분을 다시 불러 쓴 토큰. 값이 싸서 숫자가 커도 부담이 작습니다.
- **출력**: 모델이 쓴 답의 토큰.
- **응답 수**: 모델 응답 횟수(같은 응답이 기록에 여러 줄 반복돼도 한 번만 셉니다).
- **호출 수**: 서브에이전트가 불려 일한 횟수(기록 파일 수).
- **환산값**: 입력 1, 캐시 읽기 0.1(모델에 따라 0.05 또는 0.025), 캐시 쓰기 1.25(5분)/2(1시간), 출력 5를 곱해 더한 상대 비교용 숫자. 가중치와 출처는 출력 맨 끝 줄과 `src/core.js` 맨 위에 있습니다.
- **세션별 표**: 메인 대화만, 환산값 큰 순 상위 10개. `최대 대화`는 응답 한 번에 모델이 읽은 양(입력+캐시 쓰기+캐시 읽기)의 최댓값으로, 대화가 얼마나 길어졌는지 보여 줍니다. 아래 줄은 15만 토큰을 넘은 세션 수.
- 에이전트 이름은 서브에이전트 `.meta.json`의 `agentType`. 메타가 없으면 `알 수 없음`.
- 마지막 `건너뛴 줄 N`: 깨진 JSON 줄, 날짜를 못 읽은 줄, usage가 없는 응답 줄의 수.

## 설정 파일 (선택)

없어도 됩니다. 에이전트 이름을 접두어로 묶어 팀별 표를 보고 싶을 때만 씁니다. `ledger.js` 옆에 `ledger.config.json`을 두거나 `--config <파일>`로 지정합니다(예시: `ledger.config.example.json`).

```json
{
  "mainName": "메인 세션",
  "agentTitle": "에이전트별",
  "groupTitle": "팀별",
  "mainGroup": "메인",
  "otherGroup": "기타",
  "groups": [["team-a-", "팀 A"], ["team-b-", "팀 B"]]
}
```

`groups`가 없으면 그룹 표는 나오지 않습니다. 파일이 깨졌으면 `[오류]` 한 줄과 종료 코드 1로 끝납니다(조용히 무시하지 않음).

## 폴더 구조

```
ledger.js                     실행 파일(옵션 읽기, 폴더 찾기, 출력)
src/core.js                   기록 읽기와 집계, 표 만들기
test/ledger.test.js           테스트
test/make-fixtures.js         가짜 기록(fixture) 생성 스크립트
test/fixtures*/               직접 만든 가짜 기록(실제 기록 아님)
ledger.config.example.json    설정 파일 예시
LICENSE                       MIT
```

테스트는 프로젝트 폴더에서 `node --test "test/*.test.js"`.

## 한계

- 이 PC의 기록만 셉니다. 클라우드에서 돌린 작업이나 다른 PC의 사용량은 포함되지 않습니다.
- 금액은 계산하지 않습니다.
- Windows 폴더 이름 규칙만 실제로 확인했습니다. macOS·Linux(`/Users/alice/my-app` 은 `-Users-alice-my-app`)는 외부 문서를 근거로 한 것이라 실제 기기에서 확인하지 못했습니다. 영문이 아닌 글자(한글 폴더 이름 등)가 들어간 경로는 규칙이 다를 수 있습니다. 못 찾으면 `--dir`이나 `--all`을 쓰세요.
- 기록 위치를 바꾸는 환경 변수는 지원하지 않습니다. 기록 위치가 기본과 다르면 `--dir`로 지정하세요.

## English

cc-token-ledger sums the token usage that Claude Code records locally and prints tables by date, agent, and model. It never prints or stores conversation text (only numbers, model names, agent names, dates), makes no network calls, and has zero dependencies. The weighted value is a relative comparison number, not a price.

```
git clone https://github.com/sqgroup-official/cc-token-ledger.git
cd <your project folder>
node /path/to/cc-token-ledger/ledger.js
```

The output and the rest of this README are in Korean.

## 만든 곳

SQ그룹의 AI 에이전트 뉴스룸 [SQ타임즈](https://sqgroup.kr/times/?utm_source=github&utm_medium=readme&utm_campaign=cc-token-ledger)에서 매주 토큰 점검에 쓰는 도구입니다.
