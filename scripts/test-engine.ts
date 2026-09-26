import assert from 'node:assert';
import type { Cue } from '../src/types';
import { applyEdit, computeSnap, assertInvariants } from '../src/lib/engine';
import { parseVtt, serializeVtt } from '../src/lib/vtt';
import { parseTimestamp, formatTimestamp, MIN_DURATION, SNAP_DISTANCE } from '../src/lib/time';
import { validateAnchors, mapTime, previewRemap, applyRemap } from '../src/lib/remap';
import {
  validateRules,
  effectiveRules,
  replaceTerms,
  previewTerms,
  applyTerms,
  type TermRule,
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
function mkRules(...pairs: Array<[string, string]>): TermRule[] {
  return pairs.map(([source, target], i) => ({ id: `r${i}`, source, target }));
}

test('规则校验：整行留空忽略，只填一半或原词重复被拒绝', () => {
  // 全空行被忽略 → 合法
  assert.equal(validateRules(mkRules(['', ''])), null);
  assert.equal(validateRules(mkRules(['  ', ' '])), null);
  // 只填一半 → 报错
  assert(validateRules(mkRules(['hello', ''])) !== null);
  assert(validateRules(mkRules(['', 'hi'])) !== null);
  assert(validateRules(mkRules(['  ', 'hi'])) !== null);
  // 原词重复 → 报错
  assert(validateRules(mkRules(['a', 'x'], ['a', 'y'])) !== null);
  // 合法
  assert(validateRules(mkRules(['a', 'x'], ['ab', 'y'])) === null);
  // effectiveRules 只保留完整行
  const eff = effectiveRules(mkRules(['a', 'x'], ['', ''], ['b', '']));
  assert.equal(eff.length, 1);
  assert.equal(eff[0].source, 'a');
});

test('术语替换：区分大小写的字面匹配', () => {
  const r = replaceTerms('Hello hello HELLO', mkRules(['hello', '嗨']));
  assert.equal(r.newText, 'Hello 嗨 HELLO');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].start, 6);
  assert.equal(r.hits[0].end, 11);
});

test('术语替换：内联标签作为边界且原样保留', () => {
  // 标签内的可见文本仍可匹配，标签本身原样保留
  const r = replaceTerms('<b>hello</b> <i class="x">hello</i>', mkRules(['hello', 'hi']));
  assert.equal(r.newText, '<b>hi</b> <i class="x">hi</i>');
  assert.equal(r.hits.length, 2);
  // 匹配不可跨越标签边界
  const cross = replaceTerms('he<b>llo</b>', mkRules(['hello', 'X']));
  assert.equal(cross.newText, 'he<b>llo</b>');
  assert.equal(cross.hits.length, 0);
  // 时间戳标签与 voice 标签同样是边界
  const ts = replaceTerms('<00:00:01.000>hello<v Speaker>world</v>', mkRules(['hello', 'H'], ['world', 'W']));
  assert.equal(ts.newText, '<00:00:01.000>H<v Speaker>W</v>');
});

test('术语替换：实体作为边界且原样保留', () => {
  // &amp; 是边界：ab 不能跨越它匹配；实体内容不参与匹配
  const r = replaceTerms('a&amp;b', mkRules(['ab', 'X'], ['amp', 'Y'], ['a', '1'], ['b', '2']));
  assert.equal(r.newText, '1&amp;2');
  assert.equal(r.hits.length, 2);
  // 数字实体与未知命名实体同样视为边界
  const num = replaceTerms('x&#65;y&foo;z', mkRules(['xy', 'X'], ['xyz', 'X'], ['foo', 'F']));
  assert.equal(num.newText, 'x&#65;y&foo;z');
  // 裸露的 & 不是实体，仍属可见文本
  const bare = replaceTerms('a & b', mkRules(['&', '和']));
  assert.equal(bare.newText, 'a 和 b');
});

test('术语替换：同一位置取最长原词，等长按规则顺序', () => {
  // 最长优先
  const r = replaceTerms('hello world', mkRules(['he', 'X'], ['hello', 'Y'], ['hell', 'Z']));
  assert.equal(r.newText, 'Y world');
  assert.equal(r.hits[0].source, 'hello');
  // 等长（同词）按规则顺序，靠前者优先
  const tie = replaceTerms('ab', mkRules(['ab', '第一'], ['ab', '第二']));
  assert.equal(tie.newText, '第一');
});

test('术语替换：已选中的字符不再重复匹配', () => {
  // "aa" 在 "aaa" 上只命中一次（0–2），余下的 a 保留
  const r = replaceTerms('aaa', mkRules(['aa', 'X']));
  assert.equal(r.newText, 'Xa');
  assert.equal(r.hits.length, 1);
  // ab 消费后，bc 无法在位置 1 命中
  const overlap = replaceTerms('abc', mkRules(['ab', 'X'], ['bc', 'Y']));
  assert.equal(overlap.newText, 'Xc');
  // 替换结果不会被二次扫描：target 含 source 也不递归
  const noRecurse = replaceTerms('a', mkRules(['a', 'aa']));
  assert.equal(noRecurse.newText, 'aa');
  assert.equal(noRecurse.hits.length, 1);
});

test('术语替换：命中区间与替换后区间一一对应', () => {
  const r = replaceTerms('foo bar foo', mkRules(['foo', 'F'], ['bar', 'BB']));
  assert.equal(r.newText, 'F BB F');
  assert.deepEqual(
    r.hits.map((h) => [h.start, h.end]),
    [
      [0, 3],
      [4, 7],
      [8, 11],
    ],
  );
  assert.deepEqual(
    r.newRanges.map((g) => r.newText.slice(g.start, g.end)),
    ['F', 'BB', 'F'],
  );
  // 空规则表 → 原样返回
  const noop = replaceTerms('hello', []);
  assert.equal(noop.newText, 'hello');
  assert.equal(noop.hits.length, 0);
});

test('术语预览：只列出有命中的字幕，按时间轴顺序', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 5, end: 6, text: 'nothing here' },
    { id: 'c2', start: 1, end: 2, text: 'say hello' },
    { id: 'c3', start: 3, end: 4, text: 'hello again' },
  ];
  const rows = previewTerms(cues, mkRules(['hello', 'hi']));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cue.id, 'c2'); // 按起点排序
  assert.equal(rows[1].cue.id, 'c3');
  assert.equal(rows[0].newText, 'say hi');
  assert.equal(rows[1].hits.length, 1);
  // 无有效规则 → 无预览行
  assert.equal(previewTerms(cues, mkRules(['', ''])).length, 0);
});

test('术语应用：仅替换所选字幕文本，时间与 id 不变', () => {
  const cues: Cue[] = [
    { id: 'c1', start: 0, end: 1, text: 'hello one' },
    { id: 'c2', start: 2, end: 3, text: 'hello two' },
    { id: 'c3', start: 4, end: 5, text: 'no match' },
  ];
  const rules = mkRules(['hello', 'hi']);
  // 只勾选 c1 与 c3（c3 无命中）
  const next = applyTerms(cues, rules, new Set(['c1', 'c3']));
  assert.equal(next[0].text, 'hi one');
  assert.equal(next[1].text, 'hello two'); // 未勾选 → 不变
  assert.equal(next[2].text, 'no match');
  // 时间与 id 不变
  next.forEach((c, i) => {
    assert.equal(c.id, cues[i].id);
    assert.equal(c.start, cues[i].start);
    assert.equal(c.end, cues[i].end);
  });
  // 未改动的行保持对象引用（最小化 diff）
  assert.equal(next[1], cues[1]);
  assert.equal(next[2], cues[2]);
  // 原数组未被修改
  assert.equal(cues[0].text, 'hello one');
});

test('术语应用：空选择或无命中时原样返回（不产生撤销记录）', () => {
  const cues: Cue[] = [{ id: 'c1', start: 0, end: 1, text: 'hello' }];
  const rules = mkRules(['hello', 'hi']);
  assert.equal(applyTerms(cues, rules, new Set()), cues);
  assert.equal(applyTerms(cues, rules, new Set(['nope'])), cues);
  assert.equal(applyTerms(cues, mkRules(['zzz', 'q']), new Set(['c1'])), cues);
  assert.equal(applyTerms(cues, mkRules(['', '']), new Set(['c1'])), cues);
});

test('术语替换结果可序列化往返，导出反映替换', () => {
  const cues = parseVtt(`WEBVTT

cue-1
00:00:01.000 --> 00:00:03.000
<b>帐号</b> 与 &amp; 实体

cue-2
00:00:04.000 --> 00:00:06.000
帐号 再见`);
  const next = applyTerms(cues, mkRules(['帐号', '账号']), new Set(['cue-1', 'cue-2']));
  assert.equal(next[0].text, '<b>账号</b> 与 &amp; 实体');
  assert.equal(next[1].text, '账号 再见');
  const text = serializeVtt(next);
  assert(text.includes('<b>账号</b> 与 &amp; 实体'));
  assert(text.includes('账号 再见'));
  const reparsed = parseVtt(text);
  assert.equal(reparsed.length, 2);
  assert.equal(reparsed[0].id, 'cue-1');
  assert.equal(reparsed[0].text, '<b>账号</b> 与 &amp; 实体');
  assert(Math.abs(reparsed[0].start - 1) < 1e-9);
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
