import { ArrowUpRight, Circle, Pencil, RotateCcw, Square, Trash2, Type } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Tool = 'box' | 'circle' | 'arrow' | 'pen' | 'text';
type Shape =
  | {
      tool: 'box' | 'circle' | 'arrow';
      color: string;
      width: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | { tool: 'pen'; color: string; width: number; points: [number, number][] }
  | { tool: 'text'; color: string; width: number; x: number; y: number; text: string };

const COLORS = ['#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#A855F7', '#FFFFFF', '#0F172A'];
const WIDTHS = [3, 6, 10];
const TOOLS: { tool: Tool; label: string; icon: typeof Square }[] = [
  { tool: 'box', label: 'Box', icon: Square },
  { tool: 'circle', label: 'Circle', icon: Circle },
  { tool: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { tool: 'pen', label: 'Pen', icon: Pencil },
  { tool: 'text', label: 'Text', icon: Type },
];

function draw(ctx: CanvasRenderingContext2D, s: Shape, scale: number) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'box') ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
  else if (s.tool === 'circle') {
    ctx.beginPath();
    ctx.ellipse(
      (s.x1 + s.x2) / 2,
      (s.y1 + s.y2) / 2,
      Math.abs(s.x2 - s.x1) / 2,
      Math.abs(s.y2 - s.y1) / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (s.tool === 'arrow') {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(14, s.width * 4) * scale;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === 'pen') {
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  } else if (s.tool === 'text') {
    const size = (14 + s.width * 3) * scale;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    // A dark outline keeps light text readable on any background.
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = s.color === '#0F172A' ? '#FFFFFF' : '#0F172A';
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillText(s.text, s.x, s.y);
  }
}

/**
 * Marks up a screenshot: boxes, circles, arrows, free pen and text in any colour. Saving produces a new image (the
 * original screenshot is kept).
 */
export function Annotator({
  src,
  onClose,
  onSave,
  saving,
}: {
  src: string | null;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
  saving?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  // The shape being drawn, kept outside render: several pointer events can arrive before React renders (fast pen
  // strokes), and each must build on the previous one, not on the last rendered draft.
  const drawing = useRef<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('box');
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(WIDTHS[1]!);
  const [label, setLabel] = useState('Here');

  useEffect(() => {
    setShapes([]);
    setImg(null);
    if (!src) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);

  // Strokes scale with the image so they look the same on small and large screenshots.
  const scale = img ? Math.max(1, img.naturalWidth / 1200) : 1;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    for (const s of draft ? [...shapes, draft] : shapes) draw(ctx, s, scale);
  }, [img, shapes, draft, scale]);

  const point = (e: React.PointerEvent): [number, number] => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };
  const down = (e: React.PointerEvent) => {
    const [x, y] = point(e);
    if (tool === 'text') {
      if (label.trim()) setShapes((all) => [...all, { tool, color, width, x, y, text: label.trim() }]);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    drawing.current =
      tool === 'pen'
        ? { tool, color, width, points: [[x, y]] }
        : { tool, color, width, x1: x, y1: y, x2: x, y2: y };
    setDraft(drawing.current);
  };
  const move = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    const [x, y] = point(e);
    drawing.current =
      d.tool === 'pen'
        ? { ...d, points: [...d.points, [x, y]] }
        : d.tool === 'text'
          ? d
          : { ...d, x2: x, y2: y };
    setDraft(drawing.current);
  };
  const up = () => {
    const d = drawing.current;
    drawing.current = null;
    if (d) setShapes((all) => [...all, d]);
    setDraft(null);
  };
  // The system took the pointer (a palm, a scroll gesture): the unfinished shape is dropped.
  const cancel = () => {
    drawing.current = null;
    setDraft(null);
  };

  return (
    <Dialog
      open={!!src}
      onClose={onClose}
      title="Mark up the screenshot"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!img || !shapes.length || saving}
            onClick={() => canvas.current && onSave(canvas.current.toDataURL('image/png'))}
          >
            Save marked-up copy
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="annotator">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                type="button"
                aria-label={t.label}
                aria-pressed={tool === t.tool}
                title={t.label}
                onClick={() => setTool(t.tool)}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs',
                  tool === t.tool
                    ? 'border-brand/50 bg-brand/15 text-brand'
                    : 'border-border text-muted hover:bg-fg/5',
                )}
              >
                <t.icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="Colour">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn('h-6 w-6 rounded-full border-2', color === c ? 'border-fg' : 'border-border')}
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="Line width">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`Line width ${w}`}
                aria-pressed={width === w}
                onClick={() => setWidth(w)}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-md border',
                  width === w ? 'border-brand/50 bg-brand/15' : 'border-border hover:bg-fg/5',
                )}
              >
                <span className="rounded-full bg-fg" style={{ width: w + 2, height: w + 2 }} />
              </button>
            ))}
          </div>
          {tool === 'text' && (
            <Input
              aria-label="Text to place"
              className="h-8 w-40 text-xs"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Text, then click the image"
            />
          )}
          <span className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!shapes.length}
              onClick={() => setShapes((s) => s.slice(0, -1))}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Undo
            </Button>
            <Button size="sm" variant="ghost" disabled={!shapes.length} onClick={() => setShapes([])}>
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          </span>
        </div>
        <div className="max-h-[65vh] overflow-auto rounded-lg border border-border bg-bg">
          <canvas
            ref={canvas}
            aria-label="Screenshot to mark up"
            className="block w-full cursor-crosshair touch-none"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
          />
        </div>
      </div>
    </Dialog>
  );
}
