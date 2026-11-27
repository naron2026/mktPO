import { useEffect, useRef, useState } from 'react';
import { statusOf } from '../../shared/po.js';
import { StatusIcon, WarnIcon } from './Icons.jsx';

export const ROW_H = 34;   // keep in step with --row in styles.css
const oneLine = (s) => s.replace(/\n/g, ' ↵ ');

// Only the rows in sight (plus a margin) are rendered, so big files stay fast.
export default function StringList({ entries, view, sel, onSelect, emptyText, resetKey }) {
  const box = useRef(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { box.current.scrollTop = 0; setTop(0); }, [resetKey]);
  useEffect(() => {
    const el = box.current, p = view.indexOf(sel);
    if (p < 0) return;
    const y = p * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight + ROW_H * 2;
  }, [sel, view]);

  const first = Math.max(0, Math.floor(top / ROW_H) - 6);
  const last = Math.min(view.length, first + Math.ceil(height / ROW_H) + 12);
  const rows = [];
  for (let p = first; p < last; p++) {
    const i = view[p], e = entries[i], tr = e.strs.find((s) => s) || '', st = statusOf(e);
    rows.push(
      <button type="button" key={i} className={'row' + (i === sel ? ' on' : '') + (st === 'review' ? ' review' : '')} role="option" aria-selected={i === sel} style={{ top: p * ROW_H }} onClick={() => onSelect(i)}>
        <span className="st">{st === 'review' ? <span className="sr">Needs review</span> : <StatusIcon st={st} />}</span>
        <span className="cell">
          <span className="one">{oneLine(e.id)}</span>
          {e.ctx !== null && <span className="ctx">context: {e.ctx}</span>}
        </span>
        <span className="cell trc">
          <span className={'one km' + (tr ? '' : ' muted')}>{tr ? oneLine(tr) : 'Not translated yet'}</span>
          {e.warn.length > 0 && <WarnIcon />}
        </span>
      </button>
    );
  }
  return (
    <div className="list" ref={box} role="listbox" aria-label="Strings" tabIndex={-1} onScroll={(ev) => setTop(ev.currentTarget.scrollTop)}>
      {view.length
        ? <div className="list-inner" style={{ height: view.length * ROW_H }}>{rows}</div>
        : <div className="list-inner"><p className="empty-list">{emptyText}</p></div>}
    </div>
  );
}
