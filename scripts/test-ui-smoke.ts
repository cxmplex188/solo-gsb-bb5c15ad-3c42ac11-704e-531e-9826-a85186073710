import assert from 'node:assert';
import React from 'react';
import { renderToString } from 'react-dom/server';
import TermModal from '../src/components/TermModal';
import type { Cue } from '../src/types';
import type { TermRule } from '../src/lib/terms';

/** SSR 输出中 React 会在插值处插入 <!-- -->，先归一化再断言 */
function render(props: Parameters<typeof TermModal>[0]): string {
  return renderToString(React.createElement(TermModal, props)).replace(/<!-- -->/g, '');
}

const noop = () => {};

const cues: Cue[] = [
  { id: 'c1', start: 0.5, end: 2, text: '<b>帐号</b> 与 &amp; 实体 hello' },
  { id: 'c2', start: 2.5, end: 4, text: '无命中行' },
  { id: 'c3', start: 4.5, end: 6, text: 'hello hello 帐号' },
];
const rules: TermRule[] = [
  { id: 'r1', source: '帐号', target: '账号' },
  { id: 'r2', source: 'hello', target: '你好' },
  { id: 'r3', source: '', target: '' },
];

// 正常预览渲染：c1 命中 2 处（帐号、hello），c3 命中 3 处（hello×2、帐号）
const html = render({ cues, rules, onRulesChange: noop, onClose: noop, onApply: noop });
assert(html.includes('术语审校'), '标题缺失');
assert(html.includes('应用替换（2）'), '应默认勾选 2 条命中字幕');
assert(html.includes('帐号→账号'), '命中标签缺失');
assert(html.includes('mark-old') && html.includes('mark-new'), '高亮缺失');
assert(html.includes('&lt;b&gt;'), '标签应按原样转义显示');
assert(html.includes('预览：2 条字幕共 5 处命中，已勾选 2 条。'), '汇总缺失');

// 非法规则（重复原词）→ 显示错误、禁止应用
const bad = render({
  cues,
  rules: [
    { id: 'r1', source: 'a', target: 'x' },
    { id: 'r2', source: 'a', target: 'y' },
  ],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(bad.includes('原词重复'), '重复校验缺失');
assert(bad.includes('应用替换（0）'), '无预览时应用数应为 0');

// 空规则 → 提示语
const empty = render({
  cues,
  rules: [{ id: 'r1', source: '', target: '' }],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(empty.includes('请先填写至少一条完整规则'), '空规则提示缺失');

console.log('UI 冒烟测试通过 ✅');
