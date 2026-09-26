import assert from 'node:assert';
import type { Cue } from '../src/types';
import { applyEdit, computeSnap, assertInvariants } from '../src/lib/engine';
import { parseVtt, serializeVtt } from '../src/lib/vtt';
import { parseTimestamp, formatTimestamp, MIN_DURATION, SNAP_DISTANCE } from '../src/lib/time';
import { validateAnchors, mapTime, previewRemap, applyRemap } from '../src/lib/remap';
import {
  validateTermRows,
  tokenizeCueText,
  replaceInText,
  previewTerms,
  applyTerms,
  newTermRow,
  type TermRuleRow,
} from '../src/lib/terms';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

function mkCues(spec: Array<[number, number]>): Cue[] {
  return spec.map(([start, end], i) => ({
    id: `c${i}`,
    start,
    end,
    text: `cue ${i}`,
  }));
}

function expectValid(cues: Cue[]) {
  const errors = assertInvariants(cues);
  assert(errors.length === 0, `invariants broken: ${errors.join('; ')}`);
}

// ---------- 基础不变量 ----------
test('初始示例数据合法', () => {
  const cues = mkCues([
    [0.5, 3],
    [3.2, 6],
    [6.3, 9.5],
  ]);
  expectValid(cues);
});

// ---------- 非连锁：被邻居挡住 ----------
test('非连锁模式右移被右邻边界挡住', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  const next = applyEdit(cues, 'move', 0, 10, false);
  expectValid(next);
  assert.equal(next[0].end, next[1].start);
});

test('非连锁模式拖动起点被左邻挡住', () => {
  const cues = mkCues([
    [0, 1],
    [2, 5],
  ]);
  const next = applyEdit(cues, 'start', 1, -5, false);
  expectValid(next);
  assert.equal(next[1].start, 1);
});

test('非连锁拖 end 保留至少 300ms 且不越界', () => {
  const cues = mkCues([
    [0, 1],
    [1.5, 3],
  ]);
  const next = applyEdit(cues, 'end', 0, 100, false);
  expectValid(next);
  assert.equal(next[0].end, next[1].start);
  const next2 = applyEdit(cues, 'start', 0, 100, false);
  assert(next2[0].end - next2[0].start >= MIN_DURATION - 1e-6);
});

// ---------- 连锁：重叠逐条传递 ----------
test('连锁模式右推：重叠逐条传递，各条时长不变', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3.5],
    [4.5, 6],
  ]);
  const durations = cues.map((c) => c.end - c.start);
  // 把第一条终点拖到 4（与第2条重叠 2s，第2条再推第3条）
  const next = applyEdit(cues, 'end', 0, 4, true);
  expectValid(next);
  assert.equal(next[0].end, 4);
  // 第2条被推到 4 开始
  assert.equal(next[1].start, 4);
  assert.equal(next[1].end, 5.5);
  // 第3条应被推到 5.5
  assert.equal(next[2].start, 5.5);
  assert.equal(next[2].end, 7);
  // 目标条时长变为 4s；被推动的邻居时长保持不变
  assert.equal(next[0].end - next[0].start, 4);
  for (let i = 1; i < next.length; i++) {
    assert(Math.abs(next[i].end - next[i].start - durations[i]) < 1e-9);
  }
});

test('连锁模式左推：重叠向左传递，邻居时长保持', () => {
  const cues = mkCues([
    [0, 2],
    [3, 5],
    [6, 7],
  ]);
  const durations = cues.map((c) => c.end - c.start);
  // 把最后一条起点拖到 4（与第2条重叠 1s，第2条左推至 [2,4]，第1条恰好不受影响）
  const next = applyEdit(cues, 'start', 2, 4, true);
  expectValid(next);
  assert.equal(next[2].start, 4);
  assert.equal(next[2].end, 7);
  assert.equal(next[1].start, 2);
  assert.equal(next[1].end, 4);
  assert.equal(next[0].start, 0);
  assert.equal(next[0].end, 2);
  // 邻居时长保持
  assert(Math.abs(next[1].end - next[1].start - durations[1]) < 1e-9);
  assert(Math.abs(next[0].end - next[0].start - durations[0]) < 1e-9);
});

test('连锁左推空间不足时在 0 处回夹，仍满足全部不变量', () => {
  const cues = mkCues([
    [0, 1.5],
    [2.5, 4],
    [5, 6],
  ]);
  // 把最后一条起点拖到 1 → 它变成 [1,6]，左侧空间不足
  const next = applyEdit(cues, 'start', 2, 1, true);
  expectValid(next);
  // 最终只能依次排开：[0,1.5] [1.5,3] [3,8]
  assert.equal(next[0].start, 0);
  assert.equal(next[0].end, 1.5);
  assert.equal(next[1].start, 1.5);
  assert.equal(next[1].end, 3);
  assert.equal(next[2].start, 3);
  assert.equal(next[2].end, 8);
});

test('连锁整体移动跨过多条字幕，全部波纹推开', () => {
  const cues = mkCues([
    [0, 0.5],
    [1, 1.5],
    [2, 2.5],
    [3, 3.5],
  ]);
  const next = applyEdit(cues, 'move', 0, 2.2, true);
  expectValid(next);
  // 顺序可能重排，但所有条互不重叠
  const sorted = [...next].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert(sorted[i].end <= sorted[i + 1].start + 1e-9);
  }
});

test('连锁模式密集字幕压缩后每条仍至少 300ms', () => {
  // 4 条紧密排列，把第一条的终点拖到很后面，空间充足；反向极端用例：
  // 多条 300ms 的字幕，左推到 0 附近
  const cues = mkCues([
    [0, 0.3],
    [0.3, 0.6],
    [0.6, 0.9],
    [0.9, 1.2],
  ]);
  const next = applyEdit(cues, 'move', 3, -10, true);
  expectValid(next);
  next.forEach((c) => assert(c.start >= -1e-9));
  next.forEach((c) => assert(c.end - c.start >= MIN_DURATION - 1e-6));
});

test('大量连锁压力测试：随机拖拽始终满足不变量', () => {
  let cues: Cue[] = [];
  for (let i = 0; i < 30; i++) {
    cues.push({ id: `c${i}`, start: i * 1.1, end: i * 1.1 + 0.8, text: `${i}` });
  }
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < 500; n++) {
    const idx = Math.floor(rand() * cues.length);
    const kind = (['move', 'start', 'end'] as const)[Math.floor(rand() * 3)];
    const value = rand() * 25 - 5;
    cues = applyEdit(cues, kind, idx, value, true);
    if (n % 10 === 0) expectValid(cues);
  }
  expectValid(cues);
});

// ---------- 吸附 ----------
test('100ms 内吸附到相邻边界', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  // 移动第一条，终点距第二条起点 0.06s → 应吸附
  const r = computeSnap(cues, 0, 'move', 0.94, 1.94, null);
  assert.equal(r.snapTime, 2);
  assert.equal(r.end, 2);
});

test('超过 100ms 不吸附', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  const r = computeSnap(cues, 0, 'move', 0.85, 1.85, null);
  assert.equal(r.snapTime, null);
});

test('优先吸附更近的目标（播放头 vs 边界）', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
  ]);
  // 起点 0.05 接近播放头 0，同时终点 1.94 接近 2（差 0.06）→ 取更近的播放头
  const r = computeSnap(cues, 0, 'move', 0.05, 1.05, 0);
  assert.equal(r.snapTime, 0);
  assert.equal(r.start, 0);
});

test('吸附阈值常量确为 100ms', () => {
  assert.equal(SNAP_DISTANCE, 0.1);
});

// ---------- VTT 解析/序列化 ----------
test('解析带 id、NOTE、设置行的 VTT', () => {
  const vtt = `WEBVTT

NOTE This is a note

cue-1
00:00:01.500 --> 00:00:03.200 align:start
第一条

00:00:04,000 --> 00:05.500
第二条，逗号毫秒
多行`;
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, 'cue-1');
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 3.2);
  assert.equal(cues[0].text, '第一条');
  assert.equal(cues[1].start, 4);
  assert.equal(cues[1].text, '第二条，逗号毫秒\n多行');
});

test('非法输入返回空数组而不抛错', () => {
  assert.deepEqual(parseVtt('hello world'), []);
  assert.deepEqual(parseVtt(''), []);
});

test('忽略时长不足 300ms 的坏数据行', () => {
  const cues = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:01.100
太短
00:00:02.000 --> 00:00:03.000
正常`);
  assert.equal(cues.length, 1);
});

test('序列化后可往返解析且时间一致', () => {
  const cues = mkCues([
    [0.5, 3],
    [3.2, 6],
  ]);
  const text = serializeVtt(cues);
  const reparsed = parseVtt(text);
  assert.equal(reparsed.length, 2);
  assert(Math.abs(reparsed[0].start - 0.5) < 1e-9);
  assert(Math.abs(reparsed[1].end - 6) < 1e-9);
  assert(text.startsWith('WEBVTT'));
});

test('时间戳解析/格式化', () => {
  assert.equal(parseTimestamp('00:00:01.500'), 1.5);
  assert.equal(parseTimestamp('00:01.500'), 1.5);
  assert.equal(parseTimestamp('01:02:03.004'), 3723.004);
  assert.equal(parseTimestamp('bad'), null);
  assert.equal(formatTimestamp(3723.004), '01:02:03.004');
});

// ---------- 剪辑版本时间映射 ----------
test('锚点校验：少于两组或任一侧非严格递增都被拒绝', () => {
  assert(validateAnchors([]) !== null);
  assert(validateAnchors([{ oldTime: 1, newTime: 1 }]) !== null);
  // 旧版时间不递增
  assert(validateAnchors([
    { oldTime: 1, newTime: 1 },
    { oldTime: 1, newTime: 2 },
  ]) !== null);
  assert(validateAnchors([
    { oldTime: 2, newTime: 1 },
    { oldTime: 1, newTime: 2 },
  ]) !== null);
  // 新版时间不递增
  assert(validateAnchors([
    { oldTime: 1, newTime: 2 },
    { oldTime: 2, newTime: 2 },
  ]) !== null);
  // 合法
  assert(validateAnchors([
    { oldTime: 1, newTime: 1 },
    { oldTime: 2, newTime: 2 },
  ]) === null);
});

test('分段线性映射：锚点精确命中，段内线性插值', () => {
  const anchors = [
    { oldTime: 10, newTime: 20 },
    { oldTime: 20, newTime: 40 },
    { oldTime: 40, newTime: 50 },
  ];
  assert.equal(mapTime(anchors, 10), 20);
  assert.equal(mapTime(anchors, 20), 40);
  assert.equal(mapTime(anchors, 40), 50);
  assert.equal(mapTime(anchors, 15), 30); // 第一段斜率 2
  assert.equal(mapTime(anchors, 30), 45); // 第二段斜率 0.5
});

test('区间外按最近一段斜率外推', () => {
  const anchors = [
    { oldTime: 10, newTime: 20 },
    { oldTime: 20, newTime: 40 },
    { oldTime: 40, newTime: 50 },
  ];
  assert.equal(mapTime(anchors, 0), 0); // 首段斜率 2 向左外推
  assert.equal(mapTime(anchors, 5), 10);
  assert.equal(mapTime(anchors, 50), 55); // 末段斜率 0.5 向右外推
});

test('预览标出负起点 / 时长不足 300ms / 相邻重叠，且禁止应用', () => {
  const cues = mkCues([
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
  // 斜率 0.1：1s 时长被压成 0.1s → 时长不足
  const compressed = previewRemap(cues, [
    { oldTime: 0, newTime: 10 },
    { oldTime: 10, newTime: 11 },
  ]);
  assert(!compressed.ok);
  assert(compressed.issues.every((i) => i.kind === 'short-duration'));
  assert(compressed.rows.every((r) => r.issues.includes('short-duration')));

  // 首段外推到负区间 → 负起点
  const negative = previewRemap(mkCues([[0, 1]]), [
    { oldTime: 10, newTime: 0 },
    { oldTime: 20, newTime: 10 },
  ]);
  assert(!negative.ok);
  assert(negative.issues.some((i) => i.kind === 'negative-start'));

  // 输入本身重叠（恒等映射）→ 重叠的两条都被标出
  const overlapping = previewRemap(
    mkCues([
      [0, 2],
      [1, 3],
    ]),
    [
      { oldTime: 0, newTime: 0 },
      { oldTime: 10, newTime: 10 },
    ],
  );
  assert(!overlapping.ok);
  assert(overlapping.rows[0].issues.includes('overlap'));
  assert(overlapping.rows[1].issues.includes('overlap'));

  // 预览未通过时 applyRemap 原样返回（不产生新数组）
  assert.equal(applyRemap(cues, [
    { oldTime: 0, newTime: 10 },
    { oldTime: 10, newTime: 11 },
  ]), cues);
});

test('应用映射：一次性替换时间，保留 id 与文本，结果满足不变量', () => {
  const cues = mkCues([
    [0, 1],
    [2, 4],
  ]);
  const anchors = [
    { oldTime: 0, newTime: 5 },
    { oldTime: 4, newTime: 9 },
  ];
  const next = applyRemap(cues, anchors);
  assert.equal(next.length, 2);
  // id / 文本保留
  assert.equal(next[0].id, cues[0].id);
  assert.equal(next[0].text, cues[0].text);
  assert.equal(next[1].id, cues[1].id);
  // 时间被替换：斜率 1，整体平移 +5
  assert.equal(next[0].start, 5);
  assert.equal(next[0].end, 6);
  assert.equal(next[1].start, 7);
  assert.equal(next[1].end, 9);
  expectValid(next);
  // 原数组未被修改
  assert.equal(cues[0].start, 0);
});

test('映射结果可序列化往返', () => {
  const cues = mkCues([
    [1, 2.5],
    [3, 4],
  ]);
  const next = applyRemap(cues, [
    { oldTime: 0, newTime: 2 },
    { oldTime: 10, newTime: 20 },
  ]);
  const reparsed = parseVtt(serializeVtt(next));
  assert.equal(reparsed.length, 2);
  assert(Math.abs(reparsed[0].start - next[0].start) < 1e-3);
  assert(Math.abs(reparsed[1].end - next[1].end) < 1e-3);
});

// ---------- 术语审校 ----------
function mkRows(spec: Array<[string, string]>): TermRuleRow[] {
  return spec.map(([source, target]) => ({ ...newTermRow(), source, target }));
}

test('规则校验：原词/推荐词均须非空，全空行忽略', () => {
  // 全空行被忽略
  assert.deepEqual(validateTermRows(mkRows([['', ''], ['  ', ' ']])).rules, []);
  // 只填一边 → 报错
  assert(validateTermRows(mkRows([['帐号', '']])).error !== null);
  assert(validateTermRows(mkRows([['', '账号']])).error !== null);
  // 合法规则：首尾空白被去除，顺序保持
  const ok = validateTermRows(mkRows([[' 帐号 ', '账号'], ['foo', 'bar']]));
  assert.equal(ok.error, null);
  assert.deepEqual(ok.rules, [
    { source: '帐号', target: '账号' },
    { source: 'foo', target: 'bar' },
  ]);
});

test('规则校验：原词重复被拒绝（区分大小写）', () => {
  assert(validateTermRows(mkRows([['帐号', '账号'], ['帐号', '賬號']])).error !== null);
  // 大小写不同不算重复
  assert.equal(validateTermRows(mkRows([['Foo', 'x'], ['foo', 'y']])).error, null);
});

test('正文分词：标签与实体是边界，未闭合符号按普通文本', () => {
  const segs = tokenizeCueText('a<b>c</b>&amp;d&#39;e < f');
  assert.deepEqual(
    segs.map((s) => `${s.kind}:${s.value}`),
    ['text:a', 'raw:<b>', 'text:c', 'raw:</b>', 'raw:&amp;', 'text:d', 'raw:&#39;', 'text:e < f'],
  );
  // 边界片段的原文偏移正确
  assert.equal(segs[1].start, 1);
  assert.equal(segs[4].start, 9);
});

test('字面匹配区分大小写', () => {
  const r = replaceInText('foo Foo FOO', [{ source: 'Foo', target: 'Bar' }]);
  assert.equal(r.text, 'foo Bar FOO');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].start, 4);
});

test('同一位置取最长原词，等长按规则顺序', () => {
  // "abc" 与 "ab" 同时命中位置 0 → 取更长的 "abc"
  const r1 = replaceInText('abc ab', [
    { source: 'ab', target: 'X' },
    { source: 'abc', target: 'Y' },
  ]);
  assert.equal(r1.text, 'Y X');
  // 等长（同词，绕过校验直接调用）→ 先出现的规则生效
  const r2 = replaceInText('ab', [
    { source: 'ab', target: 'X' },
    { source: 'ab', target: 'Y' },
  ]);
  assert.equal(r2.text, 'X');
});

test('已选中的字符不再重复匹配，替换结果不级联', () => {
  // "aa" 消费后跳过，"aaaa" → 两次命中而非重叠匹配
  const r1 = replaceInText('aaaa', [{ source: 'aa', target: 'X' }]);
  assert.equal(r1.text, 'XX');
  assert.equal(r1.hits.length, 2);
  // "ab" 命中后，"bc" 不能再从 b 处匹配
  const r2 = replaceInText('abc', [
    { source: 'ab', target: 'X' },
    { source: 'bc', target: 'Y' },
  ]);
  assert.equal(r2.text, 'Xc');
  // 替换出的 "b" 不会触发 b→c（对原文扫描）
  const r3 = replaceInText('a', [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ]);
  assert.equal(r3.text, 'b');
});

test('标签与实体作为边界且原样保留', () => {
  // 标签内的可见文本正常替换，标签本身原样保留
  const r1 = replaceInText('<b>hello</b> world', [{ source: 'hello', target: '你好' }]);
  assert.equal(r1.text, '<b>你好</b> world');
  // 跨越标签边界的词不匹配
  const r2 = replaceInText('he<b>llo</b>', [{ source: 'hello', target: 'X' }]);
  assert.equal(r2.text, 'he<b>llo</b>');
  assert.equal(r2.hits.length, 0);
  // 实体是边界：可见文本里不存在 "Tom & Jerry"
  const r3 = replaceInText('Tom &amp; Jerry', [
    { source: 'Tom & Jerry', target: 'X' },
    { source: 'Jerry', target: 'jerry' },
  ]);
  assert.equal(r3.text, 'Tom &amp; jerry');
  // 实体自身不会被当作普通文本命中
  const r4 = replaceInText('a &amp; b', [{ source: 'amp', target: 'X' }]);
  assert.equal(r4.text, 'a &amp; b');
});

test('多行正文与带说话人标签的正文', () => {
  const r = replaceInText('<v 旁白>第一行 foo\n第二行 foo</v>', [{ source: 'foo', target: 'bar' }]);
  assert.equal(r.text, '<v 旁白>第一行 bar\n第二行 bar</v>');
  assert.equal(r.hits.length, 2);
});

test('命中预览：只返回有命中的字幕，位置/原文/替换后正文正确', () => {
  const cues: Cue[] = [
    { id: 'c0', start: 0, end: 1, text: '没有命中' },
    { id: 'c1', start: 1, end: 2, text: 'x 帐号 y 帐号' },
    { id: 'c2', start: 2, end: 3, text: '<i>帐号</i>' },
  ];
  const rows = previewTerms(cues, [{ source: '帐号', target: '账号' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cue.id, 'c1');
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].hits.length, 2);
  assert.equal(rows[0].hits[0].start, 2);
  assert.equal(rows[0].newText, 'x 账号 y 账号');
  assert.equal(rows[1].cue.id, 'c2');
  assert.equal(rows[1].newText, '<i>账号</i>');
  // 替换后正文中替换片段的高亮区间正确
  assert.equal(rows[1].outSpans.length, 1);
  assert.equal(rows[1].newText.slice(rows[1].outSpans[0].start, rows[1].outSpans[0].end), '账号');
});

test('应用替换：仅选中字幕文本被改，id/时间不变，未选中保持同引用', () => {
  const cues: Cue[] = [
    { id: 'c0', start: 0, end: 1, text: '帐号 A' },
    { id: 'c1', start: 1, end: 2, text: '帐号 B' },
    { id: 'c2', start: 2, end: 3, text: '无关' },
  ];
  const rules = [{ source: '帐号', target: '账号' }];
  const next = applyTerms(cues, rules, new Set(['c1']));
  assert.equal(next[0], cues[0]); // 未选中：同一引用
  assert.equal(next[2], cues[2]); // 无命中：同一引用
  assert.equal(next[1].text, '账号 B');
  assert.equal(next[1].id, 'c1');
  assert.equal(next[1].start, 1);
  assert.equal(next[1].end, 2);
  // 原数组未被修改
  assert.equal(cues[1].text, '帐号 B');
  // 空选择 / 无命中 → 返回原数组（不产生撤销记录）
  assert.equal(applyTerms(cues, rules, new Set()), cues);
  assert.equal(applyTerms(cues, rules, new Set(['c2'])), cues);
  assert.equal(applyTerms(cues, [], new Set(['c0'])), cues);
});

test('术语替换结果可序列化往返', () => {
  const cues: Cue[] = [
    { id: 'keep-id', start: 0.5, end: 2, text: '<b>帐号</b> 与 &amp; 实体' },
  ];
  const next = applyTerms(cues, [{ source: '帐号', target: '账号' }], new Set(['keep-id']));
  const text = serializeVtt(next);
  assert(text.includes('<b>账号</b> 与 &amp; 实体'));
  const reparsed = parseVtt(text);
  assert.equal(reparsed.length, 1);
  assert.equal(reparsed[0].id, 'keep-id');
  assert.equal(reparsed[0].text, '<b>账号</b> 与 &amp; 实体');
  assert(Math.abs(reparsed[0].start - 0.5) < 1e-9);
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);

