#!/usr/bin/env node
/**
 * 提交信息校验器（Conventional Commits）
 *
 * 用法：
 *   node scripts/validate-commit-msg.mjs            # 校验最近一条提交
 *   node scripts/validate-commit-msg.mjs <文件路径>  # 校验指定文件中的提交信息
 *   node scripts/validate-commit-msg.mjs --range A..B# 校验区间内所有提交
 *
 * 规则见 docs/engineering/git-workflow.md §2
 * 退出码：0 = 通过；1 = 不通过
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf',
  'test', 'build', 'ci', 'chore', 'revert',
];

const HEADER_RE = new RegExp(
  `^(${TYPES.join('|')})(\\([^)]*\\))?(!)?:\\s+.+$`,
);

// 允许的 scope：项目可在此扩展
const SCOPES = new Set([
  'client', 'server', 'editor', 'runtime', 'api', 'ui', 'settings', 'test', 'docs',
  'engineering', 'ui-kit', 'build', 'deps', 'release',
]);

const MAX_HEADER = 72;
const MAX_BODY_LINE = 100;

function validate(message) {
  const errors = [];
  const lines = message.split(/\r?\n/);

  // 跳过注释行
  const content = [];
  for (const line of lines) {
    if (line.startsWith('#')) break;
    content.push(line);
  }
  const text = content.join('\n').trim();

  if (!text) {
    return ['提交信息为空'];
  }

  const header = content[0] ?? '';

  // 1. 首行格式
  const m = header.match(HEADER_RE);
  if (!m) {
    errors.push(
      `首行不符合 Conventional Commits 格式。\n` +
      `  当前：${header}\n` +
      `  要求：<类型>(<范围>): <主题>\n` +
      `  类型取值：${TYPES.join(' / ')}`
    );
    return errors;
  }

  const [, type, scopeGroup, breakingMarker] = m;

  // 2. 首行长度
  if (header.length > MAX_HEADER) {
    errors.push(`首行 ${header.length} 字符，超过 ${MAX_HEADER} 上限。请精简主题。`);
  }

  // 3. 主题不以句号结尾
  const subject = header.replace(HEADER_RE, '$1$2$3: $4');
  if (subject.endsWith('。') || subject.endsWith('.') || subject.endsWith('，') || subject.endsWith(',')) {
    errors.push('主题不应以句号或逗号结尾。');
  }

  // 4. 主题不是纯空白/占位
  const pureSubject = header.slice(header.indexOf(':') + 1).trim();
  if (!pureSubject || /^(更新|修改|修复问题|update|fix|change|wip|test)$/i.test(pureSubject)) {
    errors.push(`主题过于笼统：「${pureSubject}」。请写清具体改了什么。`);
  }

  // 5. scope 检查
  if (scopeGroup) {
    const scope = scopeGroup.slice(1, -1);
    if (!SCOPES.has(scope)) {
      errors.push(
        `scope「${scope}」不在允许列表中。\n` +
        `  允许：${[...SCOPES].join(', ')}\n` +
        `  若需新增，请同步更新本脚本的 SCOPES 集合。`
      );
    }
  }

  // 6. 破坏性变更标记
  const body = content.slice(1).join('\n');
  if (breakingMarker && !/BREAKING CHANGE:/.test(body)) {
    errors.push('首行含 `!` 破坏性标记，但正文缺少 `BREAKING CHANGE:` 说明段落。');
  }
  if (!breakingMarker && /BREAKING CHANGE:/.test(body)) {
    errors.push('正文含 `BREAKING CHANGE:`，但首行缺少 `!` 标记。');
  }

  // 7. 正文行长
  content.slice(1).forEach((line, i) => {
    if (line.length > MAX_BODY_LINE) {
      errors.push(`正文第 ${i + 2} 行 ${line.length} 字符，超过 ${MAX_BODY_LINE} 上限。`);
    }
  });

  // 8. 禁止内容
  if (/^(wip|test|debug|tmp)$/i.test(type) && type !== 'test') {
    errors.push(`禁止使用「${type}」作为类型。`);
  }

  return errors;
}

function main() {
  const args = process.argv.slice(2);
  let messages = [];

  if (args.length === 0) {
    // 校验最近一条提交
    const msg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' });
    messages = [{ label: 'HEAD', text: msg }];
  } else if (args[0] === '--range') {
    const range = args[1];
    if (!range) {
      console.error('用法：node scripts/validate-commit-msg.mjs --range <A..B>');
      process.exit(1);
    }
    const raw = execSync(`git log --pretty=format:%H%x00%B%x00 ${range}`, { encoding: 'utf8' });
    const chunks = raw.split('\0').filter((c) => c.trim() !== '');
    for (let i = 0; i < chunks.length; i += 2) {
      messages.push({ label: chunks[i].slice(0, 8), text: chunks[i + 1] ?? '' });
    }
  } else {
    const file = args[0];
    messages = [{ label: file, text: readFileSync(file, 'utf8') }];
  }

  let failed = 0;
  for (const { label, text } of messages) {
    const errors = validate(text);
    if (errors.length === 0) {
      console.log(`✓ ${label} 提交信息格式正确`);
    } else {
      failed++;
      console.error(`\n✗ ${label}`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} 条提交信息不合规。详见 docs/engineering/git-workflow.md §2`);
    process.exit(1);
  }
  console.log('\n全部提交信息校验通过。');
}

main();
