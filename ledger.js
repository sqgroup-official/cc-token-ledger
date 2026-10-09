#!/usr/bin/env node
'use strict';
// cc-token-ledger CLI.
// 사용법: node ledger.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--dir <폴더> | --all] [--config <파일>]
const fs = require('node:fs');
const path = require('node:path');
const { aggregate, render, normalizeConfig, projectsRoot, findProjectDir, listProjectDirs } = require('./src/core');

const VALUE_OPTS = ['--since', '--until', '--dir', '--config'];
const FLAG_OPTS = ['--all'];
const CONFIG_KEYS = ['mainName', 'agentTitle', 'groupTitle', 'mainGroup', 'otherGroup', 'groups'];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (FLAG_OPTS.includes(key)) { opts[key.slice(2)] = true; continue; }
    const val = argv[i + 1];
    if (!VALUE_OPTS.includes(key) || val === undefined || val.startsWith('--')) throw new Error(`알 수 없는 옵션: ${key}`);
    i++;
    if ((key === '--since' || key === '--until') && !/^\d{4}-\d{2}-\d{2}$/.test(val)) throw new Error(`${key}는 YYYY-MM-DD 형식이어야 합니다: ${val}`);
    opts[key.slice(2)] = val;
  }
  if (opts.since && opts.until && opts.since > opts.until) throw new Error('--since가 --until보다 늦습니다');
  if (opts.dir && opts.all) throw new Error('--dir와 --all은 같이 쓸 수 없습니다');
  return opts;
}

// 설정 파일: --config > 도구 폴더(ledger.js 옆)의 ledger.config.json > 없음.
// 있는데 깨졌으면 조용히 무시하지 않고 오류로 알린다.
function loadConfig(explicit) {
  const file = explicit || path.join(__dirname, 'ledger.config.json');
  if (!explicit && !fs.existsSync(file)) return {};
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`설정 파일을 읽지 못했습니다(없거나 JSON이 깨짐): ${file}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`설정 파일은 { ... } 형태여야 합니다: ${file}`);
  // 오타난 키(group 등)가 조용히 무시되지 않게, 아는 키 밖은 오류로 알린다
  const unknown = Object.keys(raw).filter((k) => !CONFIG_KEYS.includes(k));
  if (unknown.length) throw new Error(`설정 파일에 모르는 항목이 있습니다: ${unknown.join(', ')}`);
  normalizeConfig(raw); // 형식 검사. 틀리면 여기서 오류
  return raw;
}

// 기록 폴더 못 찾음: 추측하지 않고 후보 이름만 보여 준다(대화 내용은 읽지 않음)
function notFoundMessage(root, name, all) {
  const lines = [`[오류] 이 폴더의 기록 폴더를 찾지 못했습니다(찾은 이름: ${name})`];
  if (all.length) {
    lines.push(`${root} 아래 폴더(최근 수정 순, 최대 10개):`);
    for (const e of all.slice(0, 10)) lines.push(`  ${e.name}`);
  } else {
    lines.push(`${root} 아래에 폴더가 없습니다.`);
  }
  lines.push('`--dir <폴더>` 또는 `--all`로 다시 실행하세요.');
  return lines.join('\n');
}

async function main() {
  let opts, config;
  try {
    opts = parseArgs(process.argv.slice(2));
    config = loadConfig(opts.config);
  } catch (e) { console.log(`[오류] ${e.message}`); return 1; }

  let dirs;
  if (opts.dir) {
    if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
      console.log(`[오류] 기록 폴더가 없습니다: ${opts.dir}`);
      return 1;
    }
    dirs = [opts.dir];
  } else if (opts.all) {
    const root = projectsRoot();
    const all = listProjectDirs(root);
    if (!all.length) { console.log(`[오류] ${root} 아래에 기록이 없습니다. --dir <폴더>로 직접 지정하세요.`); return 1; }
    dirs = all.map((e) => path.join(root, e.name));
  } else {
    // 도구가 아니라 "지금 서 있는 폴더"가 기준이다. 일반 사용자는 도구를 자기 프로젝트 밖에 받기 때문.
    const root = projectsRoot();
    const found = findProjectDir(root, process.cwd());
    if (!found.dir) { console.log(notFoundMessage(root, found.name, found.all)); return 1; }
    dirs = [found.dir];
  }
  const options = { ...config, since: opts.since, until: opts.until };
  const result = await aggregate(dirs, options);
  console.log(render(result, options));
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.log(`[오류] ${e.message}`); // 줄 내용은 넣지 않는다
  process.exitCode = 1;
});
