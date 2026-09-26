import type { Cue } from '../types';

/** 一条规范化后的替换规则（source/target 均已去除首尾空白，source 全局唯一） */
export interface TermRule {
  source: string;
  target: string;
}

/** 规则编辑行（key 仅用于列表渲染） */
export interface TermRuleRow {
  key: number;
  source: string;
  target: string;
}

let rowKey = 0;
export function newTermRow(): TermRuleRow {
  return { key: ++rowKey, source: '', target: '' };
}

/** 一次命中：在原始 cue 文本中的位置与所用规则 */
export interface TermHit {
  ruleIndex: number;
  source: string;
  target: string;
  start: number; // 原始 cue 文本中的偏移（坐标含标签/实体）
  end: number;
}

export interface TextSpan {
  start: number;
  end: number;
}

export interface TermPreviewRow {
  cue: Cue;
  index: number; // 字幕在当前列表中的序号（0 起）
  hits: TermHit[];
  newText: string;
  outSpans: TextSpan[]; // newText 中各替换片段的位置（用于高亮）
}

/**
 * 校验规则编辑行：
 * - 完全留空的行忽略；
 * - 原词 / 推荐词只填一个 → 报错（两者均须非空）；
 * - 原词（去除首尾空白后，区分大小写）不允许重复。
 */
export function validateTermRows(rows: TermRuleRow[]): { rules: TermRule[]; error: string | null } {
  const rules: TermRule[] = [];
  const seen = new Map<string, number>(); // 原词 → 首次出现的行号（1 起）
  for (let i = 0; i < rows.length; i++) {
    const source = rows[i].source.trim();
    const target = rows[i].target.trim();
    if (source === '' && target === '') continue;
    if (source === '' || target === '') {
      return { rules: [], error: `第 ${i + 1} 行：原词和推荐词均不能为空` };
    }
    const dup = seen.get(source);
    if (dup !== undefined) {
      return { rules: [], error: `第 ${i + 1} 行：原词「${source}」与第 ${dup} 行重复` };
    }
    seen.set(source, i + 1);
    rules.push({ source, target });
  }
  return { rules, error: null };
}

interface Segment {
  kind: 'text' | 'raw';
  value: string;
  start: number; // 在原文中的偏移
}

/**
 * 把 cue 正文切分为「可见文本」与「边界」片段。
 * 边界 = WebVTT 内联标签（<...>）与实体（&...;）：匹配不可跨越，输出时原样保留。
 * 未闭合的 `<` 与不合法的 `&...` 按普通文本处理（容错）。
 */
export function tokenizeCueText(text: string): Segment[] {
  const segs: Segment[] = [];
  let buf = '';
  let bufStart = 0;

  const flush = () => {
    if (buf !== '') {
      segs.push({ kind: 'text', value: buf, start: bufStart });
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close !== -1) {
        flush();
        segs.push({ kind: 'raw', value: text.slice(i, close + 1), start: i });
        i = close + 1;
        continue;
      }
      // 没有配对的 '>' → 按普通字符
    } else if (ch === '&') {
      const m = /^&[#0-9A-Za-z]+;/.exec(text.slice(i, i + 32));
      if (m) {
        flush();
        segs.push({ kind: 'raw', value: m[0], start: i });
        i += m[0].length;
        continue;
      }
      // 不是合法实体 → 按普通字符
    }
    if (buf === '') bufStart = i;
    buf += ch;
    i++;
  }
  flush();
  return segs;
}

/**
 * 在单条 cue 正文上执行替换（区分大小写的字面匹配）。
 * 逐段扫描可见文本：每个位置取能命中的最长原词（等长按规则顺序），
 * 命中后跳过已消费字符（不再重复匹配），未命中则原样前进一个字符；
 * 替换结果不会再次被匹配（对原文扫描，不级联）。
 */
export function replaceInText(
  text: string,
  rules: TermRule[],
): { text: string; hits: TermHit[]; outSpans: TextSpan[] } {
  const active = rules.filter((r) => r.source.length > 0);
  if (active.length === 0) return { text, hits: [], outSpans: [] };

  const hits: TermHit[] = [];
  const outSpans: TextSpan[] = [];
  let out = '';

  for (const seg of tokenizeCueText(text)) {
    if (seg.kind === 'raw') {
      out += seg.value; // 标签 / 实体原样保留
      continue;
    }
    const s = seg.value;
    let i = 0;
    while (i < s.length) {
      // 同一位置：取最长原词；等长时先出现的规则优先（严格更长才替换 best）
      let best = -1;
      for (let r = 0; r < active.length; r++) {
        const src = active[r].source;
        if (s.startsWith(src, i) && (best === -1 || src.length > active[best].source.length)) {
          best = r;
        }
      }
      if (best === -1) {
        out += s[i];
        i += 1;
      } else {
        const rule = active[best];
        hits.push({
          ruleIndex: best,
          source: rule.source,
          target: rule.target,
          start: seg.start + i,
          end: seg.start + i + rule.source.length,
        });
        outSpans.push({ start: out.length, end: out.length + rule.target.length });
        out += rule.target;
        i += rule.source.length;
      }
    }
  }
  return { text: out, hits, outSpans };
}

/** 计算全部字幕的命中预览（只返回有命中的字幕，顺序与当前列表一致） */
export function previewTerms(cues: Cue[], rules: TermRule[]): TermPreviewRow[] {
  const rows: TermPreviewRow[] = [];
  cues.forEach((cue, index) => {
    const r = replaceInText(cue.text, rules);
    if (r.hits.length > 0) {
      rows.push({ cue, index, hits: r.hits, newText: r.text, outSpans: r.outSpans });
    }
  });
  return rows;
}

/**
 * 应用替换：仅改写选中字幕的 text，id 与时间保持不变；
 * 无实际改动时返回原数组（配合撤销历史：相同引用不产生记录）。
 */
export function applyTerms(cues: Cue[], rules: TermRule[], ids: ReadonlySet<string>): Cue[] {
  if (rules.length === 0 || ids.size === 0) return cues;
  let changed = false;
  const next = cues.map((c) => {
    if (!ids.has(c.id)) return c;
    const r = replaceInText(c.text, rules);
    if (r.hits.length === 0) return c;
    changed = true;
    return { ...c, text: r.text };
  });
  return changed ? next : cues;
}
