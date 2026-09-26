import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { Cue } from '../types';
import { formatTimestamp } from '../lib/time';
import {
  newTermRow,
  previewTerms,
  validateTermRows,
  type TermRule,
  type TermRuleRow,
  type TextSpan,
} from '../lib/terms';

interface TermsModalProps {
  cues: Cue[];
  rows: TermRuleRow[];
  onRowsChange: (rows: TermRuleRow[]) => void;
  onClose: () => void;
  onApply: (rules: TermRule[], cueIds: string[]) => void;
}

export default function TermsModal({ cues, rows, onRowsChange, onClose, onApply }: TermsModalProps) {
  // 用户显式取消勾选的字幕 id；预览重算后新出现的命中默认勾选
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());

  // 解析 + 校验规则（完全留空的行忽略；只填一半或原词重复则报错）
  const parsed = useMemo(() => validateTermRows(rows), [rows]);

  // 规则或字幕任何变动都会触发预览重算
  const preview = useMemo(
    () => (parsed.error === null ? previewTerms(cues, parsed.rules) : []),
    [cues, parsed],
  );

  const hasAnyInput = rows.some((r) => r.source.trim() !== '' || r.target.trim() !== '');
  const totalHits = preview.reduce((n, r) => n + r.hits.length, 0);
  const selected = preview.filter((r) => !unchecked.has(r.cue.id));
  const canApply = parsed.error === null && selected.length > 0;

  const updateRow = (key: number, field: 'source' | 'target', value: string) => {
    onRowsChange(rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };
  const removeRow = (key: number) => onRowsChange(rows.filter((r) => r.key !== key));
  const addRow = () => onRowsChange([...rows, newTermRow()]);

  const toggleCue = (id: string) => {
    const next = new Set(unchecked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setUnchecked(next);
  };
  const selectAll = () => setUnchecked(new Set());
  const selectNone = () => setUnchecked(new Set(preview.map((r) => r.cue.id)));

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal wide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>术语审校</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          维护「原词 → 推荐词」替换规则（两者均非空、原词不重复，保存时去除首尾空白）。
          按字幕正文的可见文本做区分大小写的字面匹配：内联标签（如 &lt;b&gt;）与实体（如 &amp;amp;）作为边界并原样保留；
          同一位置取最长原词，等长按规则顺序，已命中的字符不会再次匹配。
        </p>

        <div className="anchor-grid">
          <span className="col-label">原词</span>
          <span />
          <span className="col-label">推荐词</span>
          <span />
          {rows.map((r) => (
            <Fragment key={r.key}>
              <input
                value={r.source}
                placeholder="如：帐号"
                spellCheck={false}
                onChange={(e) => updateRow(r.key, 'source', e.target.value)}
              />
              <span className="arrow">→</span>
              <input
                value={r.target}
                placeholder="如：账号"
                spellCheck={false}
                onChange={(e) => updateRow(r.key, 'target', e.target.value)}
              />
              <button
                className="btn tiny danger"
                title="删除该规则"
                disabled={rows.length <= 1}
                onClick={() => removeRow(r.key)}
              >
                ✕
              </button>
            </Fragment>
          ))}
        </div>
        <div className="anchor-add">
          <button className="btn small" onClick={addRow}>
            + 添加规则
          </button>
        </div>

        {parsed.error && hasAnyInput && <div className="modal-error">{parsed.error}</div>}

        {parsed.error === null && parsed.rules.length > 0 && (
          <div className={`remap-summary ${preview.length > 0 ? 'ok' : ''}`}>
            {preview.length > 0
              ? `预览：${parsed.rules.length} 条规则，命中 ${preview.length} 条字幕共 ${totalHits} 处；已勾选 ${selected.length} 条。`
              : `${parsed.rules.length} 条规则，当前字幕中没有命中。`}
            {preview.length > 0 && (
              <span className="terms-select">
                <button className="btn tiny" onClick={selectAll}>
                  全选
                </button>
                <button className="btn tiny" onClick={selectNone}>
                  全不选
                </button>
              </span>
            )}
          </div>
        )}

        {preview.length > 0 && (
          <div className="terms-preview">
            {preview.map((row) => {
              const checked = !unchecked.has(row.cue.id);
              return (
                <div key={row.cue.id} className={`terms-cue${checked ? '' : ' off'}`}>
                  <div className="terms-cue-head">
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCue(row.cue.id)}
                      />
                      <span className="terms-cue-pos">
                        #{row.index + 1} · {formatTimestamp(row.cue.start)} →{' '}
                        {formatTimestamp(row.cue.end)}
                      </span>
                    </label>
                    <span className="terms-cue-count">{row.hits.length} 处命中</span>
                  </div>
                  <div className="terms-hits">
                    {groupHits(row.hits).map((g) => (
                      <span key={g.ruleIndex} className="terms-hit">
                        「{g.source}」→「{g.target}」{g.count > 1 ? ` ×${g.count}` : ''}
                      </span>
                    ))}
                  </div>
                  <div className="terms-line">
                    <span className="terms-tag">原文</span>
                    <span className="terms-text">
                      <Marked text={row.cue.text} spans={row.hits} markClass="src" />
                    </span>
                  </div>
                  <div className="terms-line">
                    <span className="terms-tag">替换后</span>
                    <span className="terms-text">
                      <Marked text={row.newText} spans={row.outSpans} markClass="dst" />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '仅替换勾选字幕的文本（一条撤销记录）' : '没有可应用的命中'}
            onClick={() =>
              onApply(
                parsed.rules,
                selected.map((r) => r.cue.id),
              )
            }
          >
            应用替换{selected.length > 0 ? `（${selected.length} 条字幕）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 按规则聚合命中次数（保持命中出现顺序） */
function groupHits(hits: { ruleIndex: number; source: string; target: string }[]) {
  const order: number[] = [];
  const map = new Map<number, { ruleIndex: number; source: string; target: string; count: number }>();
  for (const h of hits) {
    let g = map.get(h.ruleIndex);
    if (!g) {
      g = { ruleIndex: h.ruleIndex, source: h.source, target: h.target, count: 0 };
      map.set(h.ruleIndex, g);
      order.push(h.ruleIndex);
    }
    g.count++;
  }
  return order.map((k) => map.get(k)!);
}

/** 把 spans 区间渲染为高亮 <mark>（spans 须有序且不重叠，由匹配器保证） */
function Marked({ text, spans, markClass }: { text: string; spans: TextSpan[]; markClass: string }) {
  const parts: ReactNode[] = [];
  let pos = 0;
  spans.forEach((sp, i) => {
    if (sp.start > pos) parts.push(text.slice(pos, sp.start));
    parts.push(
      <mark key={i} className={markClass}>
        {text.slice(sp.start, sp.end)}
      </mark>,
    );
    pos = sp.end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
