'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process'); // 테스트에서만 CLI를 실제로 실행해 본다 (제품 코드는 child_process 미사용)
const { aggregate, render, toKstDate } = require('../src/core');

const FIX = path.join(__dirname, 'fixtures');
const CLI = path.join(__dirname, '..', 'ledger.js');
const TEAM_CFG = { groups: [['team-a-', '팀 A']] }; // 테스트 안에서 만든 일반 설정
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

// 손 계산 (중복 제거 후): 메인 m1(출력 1000)+m2(2000), code-reviewer 3000, team-a-writer 4000, 메타 없음 5000

test('AC2: 같은 message.id 3줄은 1번만 센다', async () => {
  const r = await aggregate(FIX);
  assert.strictEqual(r.byAgent.get('메인 세션').responses, 2);
  assert.strictEqual(r.byAgent.get('메인 세션').output, 3000);
  assert.strictEqual(r.byAgent.get('code-reviewer').responses, 1);
});

test('같은 id 줄의 출력 토큰이 늘어나면 최댓값을 쓰고, 다른 파일의 같은 id는 한 번만 센다', async () => {
  const r = await aggregate(FIX);
  assert.strictEqual(r.byAgent.get('메인 세션').output, 3000); // 1000(최댓값) + 2000, 합계 1+500+1000 아님
  assert.strictEqual(r.byAgent.get('메인 세션').responses, 2);
});

test('AC3: 에이전트별·그룹별 합계가 손 계산과 같다', async () => {
  const r = await aggregate(FIX, TEAM_CFG);
  assert.strictEqual(r.byAgent.get('code-reviewer').output, 3000);
  assert.strictEqual(r.byAgent.get('code-reviewer').calls, 1);
  assert.strictEqual(r.byAgent.get('team-a-writer').cacheRead, 400);
  assert.strictEqual(r.byCompany.get('팀 A').output, 4000);
  assert.strictEqual(r.byCompany.get('메인 세션').output, 3000); // mainGroup을 안 쓰면 메인 세션 이름 그대로
  assert.strictEqual(r.byCompany.get('기타').output, 8000); // code-reviewer 3000 + 알 수 없음 5000
  assert.deepStrictEqual(
    [r.total.input, r.total.cacheWrite, r.total.cacheRead, r.total.output, r.total.responses],
    [15, 150, 1500, 15000, 5],
  );
});

test('AC4: UTC 15:30은 KST 다음 날로 집계되고 --since에 포함된다', async () => {
  assert.strictEqual(toKstDate('2026-10-08T15:30:00Z'), '2026-10-09');
  const r = await aggregate(FIX, { since: '2026-10-09' });
  assert.strictEqual(r.total.responses, 1);
  assert.strictEqual(r.total.output, 2000);
  assert.ok(r.byDate.has('2026-10-09'));
  const r2 = await aggregate(FIX, { until: '2026-10-08' });
  assert.strictEqual(r2.total.output, 13000);
});

test('AC5: 깨진 줄·usage 없는 줄·meta 없는 에이전트가 있어도 안 멈춘다', async () => {
  const r = await aggregate(FIX);
  assert.strictEqual(r.skipped, 2); // 깨진 JSON 1 + usage 없는 응답 1
  assert.ok(r.byAgent.has('알 수 없음'));
  const p = run('--dir', FIX);
  assert.strictEqual(p.status, 0);
  assert.match(p.stdout, /건너뛴 줄 2/);
  assert.match(p.stdout, /\| 알 수 없음 \|/);
});

test('AC6: 출력에 메시지 본문이 나오지 않는다', async () => {
  const out = render(await aggregate(FIX));
  assert.ok(!out.includes('비밀문장'));
  assert.ok(!run('--dir', FIX).stdout.includes('비밀문장'));
  assert.ok(out.includes('| code-reviewer |'));
});

test('AC8: 없는 폴더는 [오류] 한 줄과 종료 코드 1', () => {
  const p = run('--dir', path.join(FIX, 'nope'));
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout.trim(), /^\[오류\]/);
  assert.strictEqual(p.stdout.trim().split('\n').length, 1);
});

test('잘못된 날짜 옵션도 [오류]와 종료 코드 1', () => {
  const p = run('--since', '어제');
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout, /^\[오류\]/);
});

test('AC1: 의존성 없음, 제품 코드에 child_process 없음', () => {
  const pkg = path.join(__dirname, '..', 'package.json');
  assert.ok(!fs.existsSync(pkg) || !JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies);
  for (const f of [CLI, path.join(__dirname, '..', 'src', 'core.js')]) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('child_process'), f);
  }
});

test('--since가 --until보다 늦으면 [오류]', () => {
  const p = run('--since', '2026-10-09', '--until', '2026-10-01', '--dir', FIX);
  assert.strictEqual(p.status, 1);
  assert.ok(p.stdout.startsWith('[오류]'));
});

// 2차 손 계산 (가중치: 읽기 0.1, 5분 쓰기 1.25, 1시간 쓰기 2, 출력 5)
// A: a1=10+200+1.25*600+2*400+500=2260, a2=20+300+1000=1320, a3=5+400+1.25*500+1500=2530 -> 6110, 최대 대화 4505, 읽기 9000
// B: 1000+6000+2*100000+5000=212000, 최대 대화 161000.  서브 code-reviewer: 100+500=600
const FIX2 = path.join(__dirname, 'fixtures-sessions');

test('2차 AC2: 세션별 표가 손 계산과 같고 환산값 큰 순이며 서브에이전트는 빠진다', async () => {
  const r = await aggregate(FIX2);
  assert.deepStrictEqual(r.sessions.map((s) => s.id), ['bbbbbbbb', 'aaaaaaaa']);
  const [b, a] = r.sessions;
  assert.deepStrictEqual([a.responses, a.maxContext, a.cacheRead, a.output], [3, 4505, 9000, 600]);
  assert.deepStrictEqual([b.responses, b.maxContext, b.cacheRead], [1, 161000, 60000]);
  assert.match(render(r), /\| aaaaaaaa \| 10-08 10:00 \| 3 \| 5K \| 9,000 \| 600 \| 6,110 \|/);
});

test('2차 AC3: 15만 이상 세션 수', async () => {
  assert.match(render(await aggregate(FIX2)), /15만 토큰을 넘은 세션: 1개/);
});

test('2차 AC4: 환산값 합계·직원별이 손 계산과 같다', async () => {
  const r = await aggregate(FIX2);
  assert.ok(Math.abs(r.total.weighted - 218710) < 1e-6);
  assert.ok(Math.abs(r.byAgent.get('code-reviewer').weighted - 600) < 1e-6);
  assert.ok(Math.abs(r.byAgent.get('메인 세션').weighted - 218110) < 1e-6);
});

test('2차 AC5/AC7: 출력 끝에 가중치·출처·확인일, 본문은 없음', async () => {
  const out = render(await aggregate(FIX2));
  const last = out.trim().split('\n').pop();
  assert.match(last, /^가중치: 캐시 쓰기 1\.25\(5분\)\/2\(1시간\), 출력 5, 캐시 읽기 기본 0\.1\(.*Opus 5\.5 읽기 0\.05.*\)\. 기본값 적용 모델: model-a. \(https:\/\/.+, 확인 \d{4}-\d{2}-\d{2}\)$/);
  assert.ok(!out.includes('비밀문장'));
});

test('모델별 가중치: 모델이 다르면 각자의 가중치로 환산하고, 표에 없는 모델은 기본값 표시', async () => {
  // opus-5-5: 10 + 0.05*1000 + 5*10 = 110 / 기본값 모델: 10 + 0.1*1000 + 50 = 160
  const r = await aggregate(path.join(__dirname, 'fixtures-models'));
  assert.ok(Math.abs(r.byModel.get('claude-opus-5-5').weighted - 110) < 1e-6);
  assert.ok(Math.abs(r.byModel.get('claude-haiku-9').weighted - 160) < 1e-6);
  assert.ok(Math.abs(r.total.weighted - 270) < 1e-6);
  assert.match(render(r), /기본값 적용 모델: claude-haiku-9./);
});

// ---- 3차: 공개 준비 ----
const os = require('node:os');
const TOOL = path.join(__dirname, '..');
const EXAMPLE = path.join(TOOL, 'ledger.config.example.json');
const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ccl-${name}-`));
// 설정 파일이 없는 도구 폴더 상태를 만든다(ledger.js + src만 복사). 도구 폴더에 설정 파일이 있어도 "설정 없음"을 시험하기 위해.
function bareTool() {
  const d = mkTmp('tool');
  fs.mkdirSync(path.join(d, 'src'));
  fs.copyFileSync(path.join(TOOL, 'ledger.js'), path.join(d, 'ledger.js'));
  fs.copyFileSync(path.join(TOOL, 'src', 'core.js'), path.join(d, 'src', 'core.js'));
  return d;
}
const runIn = (toolDir, args, opts = {}) => spawnSync(process.execPath, [path.join(toolDir, 'ledger.js'), ...args], { encoding: 'utf8', ...opts });

test('3차 AC4: 설정 없이 실행하면 메인 세션·에이전트별 표만 나오고 그룹 표·회사 이름은 없다', () => {
  const t = bareTool();
  const p = runIn(t, ['--dir', FIX]);
  assert.strictEqual(p.status, 0);
  assert.match(p.stdout, /\| 메인 세션 \|/);
  assert.match(p.stdout, /## 에이전트별/);
  assert.ok(!/## (그룹별|팀별)/.test(p.stdout));
  assert.ok(!p.stdout.includes('팀 A'), '설정에만 있는 이름이 새면 안 됨');
  assert.ok(!p.stdout.includes('비밀문장'));
  fs.rmSync(t, { recursive: true, force: true });
});

test('3차 AC5: --config 예시 파일이면 그룹 표가 나오고 팀 A 행이 손 계산과 같다', () => {
  const p = run('--dir', FIX, '--config', EXAMPLE);
  assert.strictEqual(p.status, 0);
  assert.match(p.stdout, /## 팀별/);
  // 팀 A = team-a-writer 1건: 입력 4, 캐시 쓰기 40, 캐시 읽기 400, 출력 4000, 응답 1, 환산값 4+0.1*400+1.25*40+5*4000=20094, 호출 1
  assert.match(p.stdout, /\| 팀 A \| 4 \| 40 \| 400 \| 4,000 \| 1 \| 20,094 \| 1 \|/);
  assert.ok(!p.stdout.includes('비밀문장'));
});

test('3차 AC5: 깨진·틀린 설정 파일은 [오류] 한 줄과 종료 코드 1', () => {
  const d = mkTmp('cfg');
  for (const body of ['{ 깨짐', '[1,2]', '{"groups":"x"}', '{"groups":[["a"]]}', '{"mainName":""}']) {
    const f = path.join(d, 'bad.json');
    fs.writeFileSync(f, body);
    const p = run('--dir', FIX, '--config', f);
    assert.strictEqual(p.status, 1, body);
    assert.match(p.stdout, /^\[오류\]/);
    assert.strictEqual(p.stdout.trim().split('\n').length, 1);
  }
  assert.strictEqual(run('--dir', FIX, '--config', path.join(d, 'none.json')).status, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('3차 AC6: 폴더 이름 계산, 대소문자만 다른 폴더도 찾는다', () => {
  const { projectFolderName, findProjectDir } = require('../src/core');
  assert.strictEqual(projectFolderName(String.raw`C:\Users\alice\My_App`), 'C--Users-alice-My-App');
  assert.strictEqual(projectFolderName('/home/alice/my.app'), '-home-alice-my-app');
  assert.strictEqual(projectFolderName('/Users/alice/my-app'), '-Users-alice-my-app');
  const root = mkTmp('root');
  fs.mkdirSync(path.join(root, 'c--Users-alice-My-App'));
  const hit = findProjectDir(root, String.raw`C:\Users\alice\My_App`);
  assert.strictEqual(path.basename(hit.dir), 'c--Users-alice-My-App');
  assert.strictEqual(findProjectDir(root, String.raw`D:\other`).dir, null);
  fs.rmSync(root, { recursive: true, force: true });
});

// 가짜 홈 폴더 아래 projects를 만들고 그 홈으로 CLI를 실행한다 (HOME: macOS·Linux, USERPROFILE: Windows)
function fakeHome(projectNames) {
  const home = mkTmp('home');
  const projects = path.join(home, '.claude', 'projects');
  for (const n of projectNames) fs.mkdirSync(path.join(projects, n), { recursive: true });
  return { home, projects, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
const copyLog = (from, toDir) => { // fixture의 기록 파일들을 가짜 projects 안으로 복사
  fs.cpSync(from, toDir, { recursive: true });
};

test('3차 AC7: 기록 폴더가 없으면 [오류] + 폴더 목록(최대 10개) + --dir/--all 안내, 종료 코드 1', () => {
  const names = Array.from({ length: 12 }, (_, i) => `proj-${i}`);
  const { home, env } = fakeHome(names);
  const cwd = fs.realpathSync(mkTmp('cwd'));
  const t = bareTool();
  const p = runIn(t, [], { cwd, env });
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout, /^\[오류\]/);
  assert.strictEqual(p.stdout.split('\n').filter((l) => /^ {2}proj-/.test(l)).length, 10);
  assert.match(p.stdout, /--dir <폴더>.*--all/);
  for (const d of [home, cwd, t]) fs.rmSync(d, { recursive: true, force: true });
});

test('3차 AC7: 현재 폴더로 계산한 기록 폴더를 쓰고, --all은 프로젝트 2개의 합계와 같다', async () => {
  const cwd = fs.realpathSync(mkTmp('cwd'));
  const { projectFolderName } = require('../src/core');
  const { home, projects, env } = fakeHome([projectFolderName(cwd), 'other-proj']);
  copyLog(FIX, path.join(projects, projectFolderName(cwd)));
  copyLog(FIX2, path.join(projects, 'other-proj'));
  const t = bareTool();
  const one = runIn(t, [], { cwd, env });
  assert.strictEqual(one.status, 0);
  assert.match(one.stdout, /합계: 입력 15 \/ .* 응답 5건/);
  const all = runIn(t, ['--all'], { cwd, env });
  assert.strictEqual(all.status, 0);
  const a = await aggregate(FIX), b = await aggregate(FIX2);
  assert.match(all.stdout, new RegExp(`응답 ${a.total.responses + b.total.responses}건`));
  assert.ok(!all.stdout.includes('비밀문장'));
  for (const d of [home, cwd, t]) fs.rmSync(d, { recursive: true, force: true });
});

test('3차: 출력 끝에 환산값 오해 방지 줄이 가중치 줄 바로 위에 있다', async () => {
  const lines = render(await aggregate(FIX)).trim().split('\n');
  assert.match(lines[lines.length - 2], /^환산값은 입력 토큰 1을 기준으로 한 상대 비교용 숫자입니다\. 금액이 아니고/);
  assert.match(lines[lines.length - 1], /^가중치:/);
});

test('3차: --dir와 --all을 같이 쓰면 [오류]', () => {
  const p = run('--dir', FIX, '--all');
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout, /^\[오류\]/);
});

test('리뷰#12: 설정 파일의 모르는 항목(오타)은 [오류]로 알린다', () => {
  const d = mkTmp('cfgkey');
  const f = path.join(d, 'typo.json');
  fs.writeFileSync(f, JSON.stringify({ group: [['a-', 'A']] }));
  const p = run('--dir', FIX, '--config', f);
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout, /^\[오류\].*group/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('리뷰#10: --all인데 기록이 없으면 --all을 다시 권하지 않는다', () => {
  const { home, env } = fakeHome([]);
  const p = runIn(TOOL, ['--all'], { env });
  assert.strictEqual(p.status, 1);
  assert.match(p.stdout, /^\[오류\]/);
  assert.ok(!p.stdout.includes('--all로'));
  fs.rmSync(home, { recursive: true, force: true });
});
