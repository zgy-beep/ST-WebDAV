import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 客户端「运行时诊断」接线守卫
 * ------------------------------------------------------------------
 * 前端是单文件 IIFE（由 manifest.json 直接加载），无法在本进程内 import，
 * 行为验证由 tests/browser（ui-kit 运行时）与 manual-qa 的真实宿主验收承担。
 * 本文件只守卫「诊断区块的接线不会在重构中悄悄消失」：
 * 区块 DOM id、四个加载来源标签、自检与刷新按钮的调用点。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.js'), 'utf-8');

test('Client 诊断：服务设置页包含只读诊断区块与刷新按钮', () => {
  assert.ok(CLIENT_SRC.includes('id="st-webdav-acc-diag"'), '缺少运行时诊断折叠区');
  assert.ok(CLIENT_SRC.includes('id="st-webdav-diag-body"'), '缺少诊断内容容器');
  assert.ok(CLIENT_SRC.includes('id="st-webdav-diag-sum"'), '缺少诊断摘要');
  assert.ok(CLIENT_SRC.includes('id="cfg-diag-refresh"'), '缺少「重新检测」按钮');
});

test('Client 诊断：四种 UI Kit 加载来源均有可读标签', () => {
  for (const source of ['host', 'vendored', 'host-fallback', 'cdn']) {
    assert.ok(
      CLIENT_SRC.includes(`'${source}'`),
      `缺少加载来源 ${source} 的赋值或标签映射`,
    );
  }
  assert.ok(CLIENT_SRC.includes('NVUI_SOURCE_LABELS'), '缺少来源标签映射表');
});

test('Client 诊断：自检结果被展示且不使用 innerHTML 拼接未转义内容', () => {
  assert.ok(CLIENT_SRC.includes('function formatKitDiagnostics('), '缺少诊断文本组装函数');
  // 诊断行必须经 escapeHtml 后再写入 DOM（防止未来把远端/版本字符串直接当 HTML）
  assert.ok(
    /formatKitDiagnostics\(\)[\s\S]{0,300}escapeHtml\(row\)/.test(CLIENT_SRC),
    '诊断行写入 DOM 前必须经过 escapeHtml',
  );
});
