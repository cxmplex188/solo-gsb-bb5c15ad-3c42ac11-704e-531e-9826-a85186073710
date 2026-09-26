import { useEffect, useState } from 'react';
import type { Cue } from '../types';
import { MIN_DURATION, formatTimestamp, parseTimestamp } from '../lib/time';

interface CueTableProps {
  cues: Cue[];
  selectedId: string | null;
  playhead: number;
  onSelect: (id: string) => void;
  onEditTimes: (id: string, start: number, end: number) => void;
  onEditText: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onInsert: (afterId: string | null) => void;
}

export default function CueTable(props: CueTableProps) {
  const { cues, selectedId, playhead, onSelect, onEditTimes, onEditText, onDelete, onInsert } = props;

  return (
    <div className="cue-table">
      <div className="cue-table-head">
        <span>字幕列表（{cues.length}）</span>
        <button className="btn small" onClick={() => onInsert(null)}>
          ＋ 新增
        </button>
      </div>
      <div className="cue-rows">
        {cues.length === 0 && <div className="empty-hint">还没有字幕，请导入或粘贴 VTT</div>}
        {cues.map((cue) => {
          const active = playhead >= cue.start && playhead < cue.end;
          return (
            <CueRow
              key={cue.id}
              cue={cue}
              active={active}
              selected={cue.id === selectedId}
              onSelect={() => onSelect(cue.id)}
              onEditTimes={(s, e) => onEditTimes(cue.id, s, e)}
              onEditText={(t) => onEditText(cue.id, t)}
              onDelete={() => onDelete(cue.id)}
              onInsertAfter={() => onInsert(cue.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function CueRow({
  cue,
  active,
  selected,
  onSelect,
  onEditTimes,
  onEditText,
  onDelete,
  onInsertAfter,
}: {
  cue: Cue;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onEditTimes: (s: number, e: number) => void;
  onEditText: (t: string) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
}) {
  const [startStr, setStartStr] = useState(formatTimestamp(cue.start));
  const [endStr, setEndStr] = useState(formatTimestamp(cue.end));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartStr(formatTimestamp(cue.start));
    setEndStr(formatTimestamp(cue.end));
  }, [cue.start, cue.end]);

  const commitTimes = () => {
    const s = parseTimestamp(startStr);
    const e = parseTimestamp(endStr);
    if (s === null || e === null) {
      setError('时间戳格式无效');
      setStartStr(formatTimestamp(cue.start));
      setEndStr(formatTimestamp(cue.end));
      return;
    }
    if (e - s < MIN_DURATION - 1e-6) {
      setError('时长至少 300ms');
      setStartStr(formatTimestamp(cue.start));
      setEndStr(formatTimestamp(cue.end));
      return;
    }
    setError(null);
    onEditTimes(s, e);
  };

  return (
    <div
      className={`cue-row${selected ? ' selected' : ''}${active ? ' playing' : ''}`}
      onClick={onSelect}
    >
      <div className="cue-row-times">
        <input
          value={startStr}
          spellCheck={false}
          onChange={(e) => setStartStr(e.target.value)}
          onBlur={commitTimes}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="起点"
        />
        <span className="arrow">→</span>
        <input
          value={endStr}
          spellCheck={false}
          onChange={(e) => setEndStr(e.target.value)}
          onBlur={commitTimes}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="终点"
        />
      </div>
      <textarea
        className="cue-row-text"
        value={cue.text}
        rows={2}
        spellCheck={false}
        onChange={(e) => onEditText(e.target.value)}
      />
      {error && <div className="cue-row-error">{error}</div>}
      <div className="cue-row-actions">
        <button
          className="btn tiny"
          title="在其后插入"
          onClick={(e) => {
            e.stopPropagation();
            onInsertAfter();
          }}
        >
          ＋
        </button>
        <button
          className="btn tiny danger"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
