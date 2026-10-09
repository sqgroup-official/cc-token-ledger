'use strict';
// fixture(가짜 기록)를 만드는 스크립트. 한 번 돌려 test/fixtures/에 결과를 두고, 결과 파일도 함께 보관한다.
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'fixtures');
const sub = path.join(F, 'sess1', 'subagents');
fs.mkdirSync(sub, { recursive: true });

const L = (id, ts, model, i, cw, cr, o) => JSON.stringify({
  timestamp: ts,
  message: {
    id, role: 'assistant', model, content: [{ type: 'text', text: '비밀문장' }],
    usage: { input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o },
  },
});
const w = (p, lines) => fs.writeFileSync(p, lines.join('\n') + '\n');

w(path.join(F, 'sess1.jsonl'), [
  L('m1', '2026-10-08T01:00:00Z', 'model-a', 1, 10, 100, 1), // 같은 id 반복: 출력 토큰이 1 -> 500 -> 1000으로 늘어남
  L('m1', '2026-10-08T01:00:00Z', 'model-a', 1, 10, 100, 500),
  L('m1', '2026-10-08T01:00:00Z', 'model-a', 1, 10, 100, 1000),
  L('m2', '2026-10-08T15:30:00Z', 'model-a', 2, 20, 200, 2000), // KST로는 10-09
  JSON.stringify({ timestamp: '2026-10-08T02:00:00Z', message: { role: 'user', content: '비밀문장' } }),
  '깨진 줄 비밀문장 {',
  JSON.stringify({ timestamp: '2026-10-08T02:00:00Z', message: { id: 'm3', role: 'assistant', content: [] } }), // usage 없음
]);
w(path.join(sub, 'agent-qa.jsonl'), [
  L('q1', '2026-10-08T03:00:00Z', 'model-b', 3, 30, 300, 3000),
  L('q1', '2026-10-08T03:00:00Z', 'model-b', 3, 30, 300, 3000),
]);
w(path.join(sub, 'agent-qa.meta.json'), [JSON.stringify({ agentType: 'code-reviewer' })]);
w(path.join(sub, 'agent-rep.jsonl'), [L('r1', '2026-10-08T04:00:00Z', 'model-b', 4, 40, 400, 4000)]);
w(path.join(sub, 'agent-rep.meta.json'), [JSON.stringify({ agentType: 'team-a-writer' })]);
w(path.join(sub, 'agent-nometa.jsonl'), [L('x1', '2026-10-08T05:00:00Z', 'model-b', 5, 50, 500, 5000)]);
// 같은 id(m2)가 다른 파일에 또 나오는 경우 (이어 하기 등): 한 번만 세야 한다
w(path.join(F, 'sess2.jsonl'), [L('m2', '2026-10-08T15:30:00Z', 'model-a', 2, 20, 200, 2000)]);

// 2차(세션별 표·환산값)용 fixture: 별도 폴더. 1차 fixture의 합계를 건드리지 않으려고 분리했다.
const G = path.join(__dirname, 'fixtures-sessions');
fs.mkdirSync(path.join(G, 'bbbbbbbb-2222', 'subagents'), { recursive: true });
// cw1h: 캐시 쓰기 중 1시간 몫. null이면 5분/1시간 구분 정보가 없는 기록.
const S = (id, ts, i, cw, cw1h, cr, o) => JSON.stringify({
  timestamp: ts,
  message: {
    id, role: 'assistant', model: 'model-a', content: [{ type: 'text', text: '비밀문장' }],
    usage: {
      input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o,
      ...(cw1h === null ? {} : { cache_creation: { ephemeral_5m_input_tokens: cw - cw1h, ephemeral_1h_input_tokens: cw1h } }),
    },
  },
});
w(path.join(G, 'aaaaaaaa-1111.jsonl'), [
  S('a1', '2026-10-08T01:00:00Z', 10, 1000, 400, 2000, 100),
  S('a2', '2026-10-08T01:05:00Z', 20, 0, 0, 3000, 200),
  S('a3', '2026-10-08T01:10:00Z', 5, 500, null, 4000, 300),
]);
w(path.join(G, 'bbbbbbbb-2222.jsonl'), [S('b1', '2026-10-08T02:00:00Z', 1000, 100000, 100000, 60000, 1000)]);
w(path.join(G, 'bbbbbbbb-2222', 'subagents', 'agent-s.jsonl'), [S('s1', '2026-10-08T02:30:00Z', 0, 0, 0, 1000, 100)]);
w(path.join(G, 'bbbbbbbb-2222', 'subagents', 'agent-s.meta.json'), [JSON.stringify({ agentType: 'code-reviewer' })]);

// 모델별 가중치 fixture: 같은 토큰량, 다른 모델
const H = path.join(__dirname, 'fixtures-models');
fs.mkdirSync(H, { recursive: true });
w(path.join(H, 'cccccccc-3333.jsonl'), [
  L('o1', '2026-10-08T01:00:00Z', 'claude-opus-5-5', 10, 0, 1000, 10),
  L('d1', '2026-10-08T01:01:00Z', 'claude-haiku-9', 10, 0, 1000, 10),
]);
