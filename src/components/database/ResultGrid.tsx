import { useEffect, useRef, useState } from 'react';

import type { ResultSet } from '../../lib/database/queryStore';
import { valueText } from '../../lib/database/values';
import type { DatabaseValue } from '../../types/database';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

const HEIGHT = 28,
  WIDTH = 170;
export default function ResultGrid({
  result,
  onCellActivate,
  rowClass,
}: {
  result: ResultSet;
  onCellActivate?: (row: number, column: number) => void;
  rowClass?: (row: number) => string | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 320, width: 800 });
  const [inspector, setInspector] = useState<{ value: DatabaseValue; name: string } | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () =>
      setViewport((v) => ({ ...v, height: element.clientHeight, width: element.clientWidth }));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(viewport.top / HEIGHT) - 4),
    last = Math.min(result.rows.length, first + Math.ceil(viewport.height / HEIGHT) + 8);
  const colFirst = Math.max(0, Math.floor(viewport.left / WIDTH) - 1),
    colLast = Math.min(result.columns.length, colFirst + Math.ceil(viewport.width / WIDTH) + 3);
  const columns = result.columns.slice(colFirst, colLast);
  const activate = (row: number, column: number, value: DatabaseValue) => {
    if (onCellActivate) onCellActivate(row, column);
    else setInspector({ value, name: result.columns[column].name });
  };
  return (
    <>
      <div
        ref={host}
        role="grid"
        aria-label={onCellActivate ? 'Editable table rows' : 'Read-only query results'}
        aria-rowcount={result.rows.length + 1}
        aria-colcount={result.columns.length}
        tabIndex={0}
        className="min-h-40 flex-1 overflow-auto text-xs"
        onScroll={(event) => {
          const element = event.currentTarget;
          setViewport((v) => ({ ...v, top: element.scrollTop, left: element.scrollLeft }));
        }}
      >
        <div
          style={{ width: Math.max(result.columns.length * WIDTH, 1), height: HEIGHT }}
          role="row"
          className="sticky top-0 z-10 bg-muted"
        >
          {columns.map((column, index) => (
            <div
              key={colFirst + index}
              role="columnheader"
              aria-colindex={colFirst + index + 1}
              className="absolute truncate border-r border-border/50 px-2 py-1.5 font-semibold"
              style={{ left: (colFirst + index) * WIDTH, width: WIDTH, height: HEIGHT }}
              title={`${column.name} · ${column.engine_type}`}
            >
              {column.name}
              <span className="ml-2 font-normal text-muted-foreground">{column.engine_type}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            height: result.rows.length * HEIGHT,
            width: Math.max(result.columns.length * WIDTH, 1),
            position: 'relative',
          }}
        >
          {result.rows.slice(first, last).map((row, index) => (
            <div
              role="row"
              aria-rowindex={first + index + 2}
              key={first + index}
              className={rowClass?.(first + index)}
              style={{
                position: 'absolute',
                top: (first + index) * HEIGHT,
                height: HEIGHT,
                width: '100%',
              }}
            >
              {row.slice(colFirst, colLast).map((value, columnIndex) => (
                <div
                  key={colFirst + columnIndex}
                  role="gridcell"
                  aria-colindex={colFirst + columnIndex + 1}
                  tabIndex={0}
                  className="absolute cursor-pointer truncate border-b border-r border-border/40 px-2 py-1.5 outline-none focus:bg-accent"
                  style={{ left: (colFirst + columnIndex) * WIDTH, width: WIDTH, height: HEIGHT }}
                  onClick={() => activate(first + index, colFirst + columnIndex, value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate(first + index, colFirst + columnIndex, value);
                    }
                  }}
                  title={value.kind === 'truncated' ? 'Truncated value' : undefined}
                >
                  {valueText(value)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {inspector && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setInspector(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>{inspector.name}</DialogTitle>
              <DialogDescription>Read-only value · {inspector.value.kind}</DialogDescription>
            </DialogHeader>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {valueText(inspector.value)}
            </pre>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {JSON.stringify(inspector.value, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
