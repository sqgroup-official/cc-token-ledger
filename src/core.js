'use strict';
// 토큰 장부 핵심 로직: 기록 파일을 줄 단위로 읽어 숫자만 더한다. 메시지 본문은 읽어도 저장·출력하지 않는다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// 환산값 가중치: 입력 토큰 1개를 1로 본 상대 비율. 바꿀 때는 여기 한 곳만 고친다.
// 출처: Anthropic 공식 가격 문서의 prompt caching 배수와 출력/입력 가격비.
// 기본값(표에 없는 모델): 캐시 읽기 0.1, 5분 쓰기 1.25, 1시간 쓰기 2, 출력 5.
const WEIGHTS = { cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };
// 모델 이름 패턴별 값. 가격 문서에서 확인한 모델만 적는다(바꾸는 항목만 쓰면 나머지는 기본값).
// 확인한 모든 모델이 쓰기 1.25/2, 출력 5배로 같고, 캐시 읽기만 다르다.
const MODEL_WEIGHTS = [
  // (?!\d): claude-opus-5-50 같은 다른 버전이 잘못 걸리지 않게 끝을 막는다
  [/^claude-opus-5-5(?!\d)/, { cacheRead: 0.05 }, 'Opus 5.5'],
  [/^claude-sonnet-5-5(?!\d)/, { cacheRead: 0.05 }, 'Sonnet 5.5'],
  [/^claude-(fable|mythos)-5-1(?!\d)/, { cacheRead: 0.025 }, 'Fable/Mythos 5.1'],
];
const weightsFor = (model) => {
  const hit = MODEL_WEIGHTS.find(([re]) => re.test(model));
  return hit ? { ...WEIGHTS, ...hit[1] } : null; // null = 기본값 적용
};
const WEIGHT_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const WEIGHT_CHECKED = '2026-10-09';
const BIG_SESSION = 150000; // 정책 원칙 7의 "큰 세션" 기준(최대 대화 크기, 토큰)
const SESSION_ROWS = 10;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const UNKNOWN_NAME = '알 수 없음';

// 설정(선택). 코어는 특정 회사 이름을 모른다: 메인 세션 이름, 그룹(접두어 -> 이름) 표는 모두 설정으로 받는다.
// 설정이 없으면(일반 사용자) 그룹 표는 나오지 않는다.
function normalizeConfig(c = {}) {
  const str = (v, def, key) => {
    if (v === undefined) return def;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`설정의 ${key}는 비어 있지 않은 글자여야 합니다`);
    return v;
  };
  const groups = c.groups === undefined ? [] : c.groups;
  if (!Array.isArray(groups) || !groups.every((g) => Array.isArray(g) && g.length === 2 && g.every((x) => typeof x === 'string' && x))) {
    throw new Error('설정의 groups는 ["접두어", "이름"] 쌍의 목록이어야 합니다');
  }
  const mainName = str(c.mainName, '메인 세션', 'mainName');
  return {
    mainName, groups,
    agentTitle: str(c.agentTitle, '에이전트별', 'agentTitle'),
    groupTitle: str(c.groupTitle, '그룹별', 'groupTitle'),
    mainGroup: str(c.mainGroup, mainName, 'mainGroup'),
    otherGroup: str(c.otherGroup, '기타', 'otherGroup'),
  };
}

// Claude Code가 기록 폴더 이름을 만드는 규칙: 절대 경로의 영문·숫자 아닌 글자는 모두 '-'
const projectFolderName = (absPath) => absPath.replace(/[^a-zA-Z0-9]/g, '-');
const projectsRoot = () => path.join(os.homedir(), '.claude', 'projects');

// 현재 폴더에 해당하는 기록 폴더 찾기. 못 찾으면 추측하지 않고 후보 목록(최근 수정 순)만 돌려준다.
function findProjectDir(root, cwd) {
  const name = projectFolderName(cwd);
  const all = listProjectDirs(root);
  const exact = all.find((e) => e.name === name);
  if (exact) return { dir: path.join(root, exact.name), name, all };
  // 대소문자만 다른 경우(Windows 드라이브 글자 등)
  const loose = all.filter((e) => e.name.toLowerCase() === name.toLowerCase());
  if (loose.length === 1) return { dir: path.join(root, loose[0].name), name, all };
  return { dir: null, name, all };
}

// projects 폴더 아래 폴더들을 최근 수정 순으로. 폴더가 없으면 빈 목록.
function listProjectDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// UTC 시각 문자열 -> KST 날짜(YYYY-MM-DD). 해석 못 하면 null.
function toKstDate(ts) {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 에이전트 이름 -> 그룹 이름
function companyOf(agent, cfg) {
  if (agent === cfg.mainName) return cfg.mainGroup;
  for (const [prefix, name] of cfg.groups) if (agent.startsWith(prefix)) return name;
  return cfg.otherGroup;
}

// 폴더 안의 기록 파일 목록: 메인(<세션>.jsonl)과 서브에이전트(<세션>/subagents/agent-*.jsonl)
function findLogFiles(dir, mainName) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      files.push({ file: path.join(dir, e.name), agent: mainName, isSub: false });
    } else if (e.isDirectory()) {
      const subDir = path.join(dir, e.name, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      for (const s of fs.readdirSync(subDir)) {
        if (!/^agent-.*\.jsonl$/.test(s)) continue;
        files.push({ file: path.join(subDir, s), agent: readAgentType(path.join(subDir, s)), isSub: true });
      }
    }
  }
  return files;
}

// 같은 이름의 .meta.json에서 agentType을 읽는다. 없거나 깨지면 '알 수 없음'.
function readAgentType(jsonlPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : UNKNOWN_NAME;
  } catch {
    return UNKNOWN_NAME;
  }
}

function emptyTotals() {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, responses: 0, calls: 0, cacheWrite1h: 0, weighted: 0 };
}
function bucket(map, key) {
  if (!map.has(key)) map.set(key, emptyTotals());
  return map.get(key);
}
function add(t, u) {
  t.input += u.input; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; t.output += u.output;
  t.responses += 1;
  t.cacheWrite1h += u.cacheWrite1h;
  t.weighted += u.w; // u.w는 모델별 가중치로 미리 계산한 환산값
}
// 환산값: 1시간 쓰기와 5분 쓰기를 나눠 계산한다. 구분 정보가 없는 쓰기는 5분으로 본다.
function weightedOf(u, model) {
  const W = weightsFor(model) || WEIGHTS;
  return u.input + W.cacheRead * u.cacheRead + W.cacheWrite5m * (u.cacheWrite - u.cacheWrite1h)
    + W.cacheWrite1h * u.cacheWrite1h + W.output * u.output;
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// 기록 폴더를 집계한다. since/until은 KST 날짜 문자열(포함), 없으면 제한 없음.
// 같은 message.id는 여러 줄에 걸쳐 반복되고 output_tokens가 뒤 줄로 갈수록 커진다.
// 그래서 줄마다 바로 더하지 않고 id별로 항목마다 최댓값을 모아 두었다가, 다 읽은 뒤 한 번에 더한다.
// dirs는 폴더 하나(글자) 또는 여러 개(--all). 설정은 같은 객체에 섞어서 받는다.
async function aggregate(dirs, options = {}) {
  const { since, until } = options;
  const cfg = normalizeConfig(options);
  const result = {
    total: emptyTotals(), byDate: new Map(), byAgent: new Map(), byCompany: new Map(), byModel: new Map(),
    skipped: 0, skippedFiles: 0, sessions: [],
  };
  const entries = []; // 응답 하나당 하나 (id 없는 줄은 줄마다 하나)
  const byId = new Map();
  const fileInfos = [];
  const allFiles = [].concat(dirs).flatMap((d) => findLogFiles(d, cfg.mainName));
  for (const info of allFiles) {
    const fileIdx = fileInfos.push(info) - 1;
    try {
      const rl = readline.createInterface({ input: fs.createReadStream(info.file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { result.skipped++; continue; }
        const msg = rec && typeof rec === 'object' ? rec.message : null;
        const usage = msg && typeof msg === 'object' ? msg.usage : null;
        if (!usage || typeof usage !== 'object') {
          // 응답(assistant)인데 usage가 없는 줄만 '건너뜀'으로 센다. 사용자 입력 등은 원래 usage가 없다.
          if (msg && msg.role === 'assistant') result.skipped++;
          continue;
        }
        if (msg.model === '<synthetic>') continue; // Claude Code가 만든 가짜 응답(토큰 0)은 세지 않는다
        const date = toKstDate(rec.timestamp);
        if (!date) { result.skipped++; continue; }
        const u = {
          input: num(usage.input_tokens), cacheWrite: num(usage.cache_creation_input_tokens),
          cacheRead: num(usage.cache_read_input_tokens), output: num(usage.output_tokens),
        };
        const cc = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {};
        u.cacheWrite1h = Math.min(u.cacheWrite, num(cc.ephemeral_1h_input_tokens));
        const model = typeof msg.model === 'string' ? msg.model : UNKNOWN_NAME;
        const prev = typeof msg.id === 'string' ? byId.get(msg.id) : null;
        if (prev) {
          for (const k of Object.keys(u)) prev.u[k] = Math.max(prev.u[k], u[k]);
        } else {
          const entry = { u, date, model, fileIdx, ts: Date.parse(rec.timestamp) };
          entries.push(entry);
          if (typeof msg.id === 'string') byId.set(msg.id, entry);
        }
      }
    } catch {
      // 파일 하나가 읽히지 않아도(권한, 중간에 삭제) 멈추지 않고 알린다. 오류 내용에 줄 본문은 없다.
      result.skippedFiles++;
    }
  }
  // 세션(메인 파일)의 시작 시각은 기간과 상관없이 그 파일의 첫 응답 기준
  const sessions = new Map();
  for (const e of entries) {
    if (fileInfos[e.fileIdx].isSub) continue;
    const s = sessions.get(e.fileIdx) || { ...emptyTotals(), start: e.ts, maxContext: 0 };
    s.start = Math.min(s.start, e.ts);
    sessions.set(e.fileIdx, s);
  }
  const defaultModels = new Set();
  const callFiles = new Set(); // 기간 안에 응답이 있었던 서브에이전트 파일
  for (const e of entries) {
    if ((since && e.date < since) || (until && e.date > until)) continue;
    const { agent, isSub } = fileInfos[e.fileIdx]; // 직원은 그 id를 먼저 읽은 파일 기준
    e.u.w = weightedOf(e.u, e.model); // 중복 제거(최댓값 합치기)가 끝난 뒤에 계산한다
    if (!weightsFor(e.model)) defaultModels.add(e.model);
    add(result.total, e.u);
    add(bucket(result.byDate, e.date), e.u);
    add(bucket(result.byAgent, agent), e.u);
    if (cfg.groups.length) add(bucket(result.byCompany, companyOf(agent, cfg)), e.u);
    add(bucket(result.byModel, e.model), e.u);
    if (!isSub) {
      const s = sessions.get(e.fileIdx);
      add(s, e.u);
      s.maxContext = Math.max(s.maxContext, e.u.input + e.u.cacheWrite + e.u.cacheRead);
    }
    if (isSub && !callFiles.has(e.fileIdx)) {
      callFiles.add(e.fileIdx);
      bucket(result.byAgent, agent).calls += 1;
      if (cfg.groups.length) bucket(result.byCompany, companyOf(agent, cfg)).calls += 1;
    }
  }
  for (const [idx, s] of sessions) {
    if (!s.responses) continue; // 기간 안에 응답이 없는 세션은 뺀다
    result.sessions.push({ id: path.basename(fileInfos[idx].file, '.jsonl').slice(0, 8), ...s });
  }
  result.defaultModels = [...defaultModels].sort();
  result.sessions.sort((a, b) => b.weighted - a.weighted);
  return result;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const kstTime = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(5, 16).replace('T', ' '); // MM-DD HH:mm

function table(title, byDate, map, { withCalls = false } = {}) {
  const head = ['구분', '입력', '캐시 쓰기', '캐시 읽기', '출력', '응답 수', '환산값'];
  if (withCalls) head.push('호출 수');
  const lines = [`## ${title}`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  // 날짜는 오름차순, 나머지는 출력 토큰 많은 순
  const rows = [...map.entries()].sort((a, b) => (byDate ? a[0].localeCompare(b[0]) : b[1].output - a[1].output));
  for (const [k, t] of rows) {
    const cells = [String(k).replaceAll('|', '\\|'), fmt(t.input), fmt(t.cacheWrite), fmt(t.cacheRead), fmt(t.output), fmt(t.responses), fmt(t.weighted)];
    if (withCalls) cells.push(fmt(t.calls));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

// 세션별 표: 메인 세션만, 환산값 큰 순 상위 SESSION_ROWS개
function sessionTable(sessions) {
  const head = ['세션', '시작(KST)', '응답 수', '최대 대화', '캐시 읽기', '출력', '환산값'];
  const lines = [`## 세션별 (메인, 상위 ${SESSION_ROWS}개)`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const s of sessions.slice(0, SESSION_ROWS)) {
    lines.push(`| ${s.id} | ${kstTime(s.start)} | ${fmt(s.responses)} | ${fmt(s.maxContext / 1000)}K | ${fmt(s.cacheRead)} | ${fmt(s.output)} | ${fmt(s.weighted)} |`);
  }
  const big = sessions.filter((s) => s.maxContext >= BIG_SESSION).length;
  lines.push('', `15만 토큰을 넘은 세션: ${big}개`);
  return lines.join('\n');
}

// 환산값을 금액으로 오해하지 않게 가중치 줄 바로 위에 항상 붙인다
const WEIGHT_NOTICE = '환산값은 입력 토큰 1을 기준으로 한 상대 비교용 숫자입니다. 금액이 아니고, 구독 요금제의 사용 한도 계산과도 다릅니다.';

function weightLine(defaultModels) {
  const per = MODEL_WEIGHTS.map(([, w, name]) => `${name} 읽기 ${w.cacheRead}`).join(', ');
  const def = defaultModels.length ? ` 기본값 적용 모델: ${defaultModels.join(', ')}.` : '';
  return `가중치: 캐시 쓰기 ${WEIGHTS.cacheWrite5m}(5분)/${WEIGHTS.cacheWrite1h}(1시간), 출력 ${WEIGHTS.output}, 캐시 읽기 기본 ${WEIGHTS.cacheRead}(${per}).${def} (${WEIGHT_SOURCE}, 확인 ${WEIGHT_CHECKED})`;
}

// 집계 결과 -> 마크다운 문자열
function render(r, options = {}) {
  const { since, until } = options;
  const cfg = normalizeConfig(options);
  const t = r.total;
  const period = `${since || '처음'} ~ ${until || '현재'} (KST)`;
  return [
    '# 토큰 장부 (cc-token-ledger)', '',
    `기간: ${period}`, '',
    `합계: 입력 ${fmt(t.input)} / 캐시 쓰기 ${fmt(t.cacheWrite)} / 캐시 읽기 ${fmt(t.cacheRead)} / 출력 ${fmt(t.output)} / 응답 ${fmt(t.responses)}건 / 환산값 ${fmt(t.weighted)}`, '',
    table('날짜별', true, r.byDate), '',
    table(cfg.agentTitle, false, r.byAgent, { withCalls: true }), '',
    ...(cfg.groups.length ? [table(cfg.groupTitle, false, r.byCompany, { withCalls: true }), ''] : []),
    table('모델별', false, r.byModel), '',
    sessionTable(r.sessions), '',
    `건너뛴 줄 ${fmt(r.skipped)}${r.skippedFiles ? ` / 읽지 못한 파일 ${fmt(r.skippedFiles)}` : ''}`, '',
    WEIGHT_NOTICE,
    weightLine(r.defaultModels), '',
  ].join('\n');
}

module.exports = { aggregate, render, toKstDate, companyOf, normalizeConfig, projectFolderName, projectsRoot, findProjectDir, listProjectDirs };
