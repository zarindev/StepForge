import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Eye,
  Hand,
  Keyboard,
  MousePointerClick,
  Type,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api, sessionToken } from '@/lib/api';
import { cn } from '@/lib/utils';

type Mode = 'tap' | 'longPress' | 'checkText' | 'checkVisible';
const MODES: { id: Mode; label: string; icon: typeof Hand; hint: string }[] = [
  {
    id: 'tap',
    label: 'Tap',
    icon: MousePointerClick,
    hint: 'Taps what you click; a text field gets the focus',
  },
  { id: 'longPress', label: 'Long press', icon: Hand, hint: 'Holds what you click for a second' },
  {
    id: 'checkText',
    label: 'Check text',
    icon: CheckCircle2,
    hint: 'Adds a check that what you click shows its current text',
  },
  {
    id: 'checkVisible',
    label: 'Check visible',
    icon: Eye,
    hint: 'Adds a check that what you click is on screen',
  },
];

/**
 * Recording a phone app: the device's screen, refreshed about once a second. Clicking it taps the app (or adds a
 * check) and the step appears in the list; typing goes into the field tapped last.
 */
export function NativeScreen({ platform, recordKey }: { platform: string; recordKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const [src, setSrc] = useState<string>();
  const [mode, setMode] = useState<Mode>('tap');
  const [text, setText] = useState('');
  const [focused, setFocused] = useState<string>();
  const busy = useRef(false);
  const tick = useRef(0);

  // The screen picture: fetched with the session token (an <img> cannot send it), shown as a blob.
  useEffect(() => {
    let stop = false;
    let url: string | undefined;
    const load = async () => {
      if (stop) return;
      if (!busy.current) {
        try {
          const res = await fetch(`/api/recorder/screen?t=${tick.current++}`, {
            headers: { 'x-stepforge-token': sessionToken() },
          });
          if (res.ok) {
            const next = URL.createObjectURL(await res.blob());
            if (url) URL.revokeObjectURL(url);
            url = next;
            if (!stop) setSrc(next);
          }
        } catch {
          // the next refresh tries again
        }
      }
      if (!stop) setTimeout(load, 1000);
    };
    void load();
    return () => {
      stop = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const act = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      busy.current = true;
      try {
        return await api<{ describe?: string; field?: boolean; recording: unknown }>('/api/recorder/act', {
          method: 'POST',
          json: body,
        });
      } finally {
        busy.current = false;
      }
    },
    onSuccess: (res, body) => {
      qc.setQueryData(recordKey, res.recording);
      if (body.action === 'tap') setFocused(res.field ? res.describe : undefined);
      if (body.action === 'type') {
        setText('');
        toast('Typed into the field');
      }
    },
    onError: toastError,
  });

  const click = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (mode === 'tap') act.mutate({ action: 'tap', x, y });
    else if (mode === 'longPress') act.mutate({ action: 'longPress', x, y });
    else act.mutate({ action: 'check', check: mode === 'checkText' ? 'text' : 'visible', x, y });
  };

  return (
    <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,320px)_1fr]">
      <div className="relative mx-auto w-full max-w-[320px] overflow-hidden rounded-[28px] border-4 border-fg/80 bg-black">
        {src ? (
          <img
            src={src}
            alt={`The ${platform} app's screen`}
            className={cn(
              'block w-full select-none',
              act.isPending ? 'cursor-wait opacity-80' : 'cursor-crosshair',
            )}
            draggable={false}
            onClick={click}
          />
        ) : (
          <div className="grid aspect-[9/19] place-items-center text-xs text-white/70">Starting the app…</div>
        )}
      </div>
      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Clicking the screen will…</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Clicking the screen will">
            {MODES.map((m) => (
              <Button
                key={m.id}
                size="sm"
                variant={mode === m.id ? 'primary' : 'outline'}
                role="radio"
                aria-checked={mode === m.id}
                title={m.hint}
                onClick={() => setMode(m.id)}
              >
                <m.icon className="h-3.5 w-3.5" /> {m.label}
              </Button>
            ))}
          </div>
        </div>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ action: 'type', text });
          }}
        >
          <p className="text-xs font-medium text-muted">
            {focused ? `Type into ${focused}` : 'Tap a text field on the screen, then type here'}
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Text to type"
              value={text}
              disabled={!focused}
              onChange={(e) => setText(e.target.value)}
              placeholder={focused ? 'Text, then Enter' : ''}
            />
            <Button type="submit" size="sm" disabled={!focused || act.isPending}>
              <Type className="h-3.5 w-3.5" /> Type
            </Button>
          </div>
        </form>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Swipe and device</p>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['up', ArrowUp],
                ['down', ArrowDown],
                ['left', ArrowLeft],
                ['right', ArrowRight],
              ] as const
            ).map(([d, Icon]) => (
              <Button
                key={d}
                size="sm"
                variant="outline"
                aria-label={`Swipe ${d}`}
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'swipe', direction: d })}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: 'back' })}
            >
              <Undo2 className="h-3.5 w-3.5" /> Back
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: 'hideKeyboard' })}
            >
              <Keyboard className="h-3.5 w-3.5" /> Hide keyboard
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted">
          Each action is done in the app and recorded with the element’s id, text or label. Elements without
          any get an explanation instead of a step: give them an accessibility id in the app.
        </p>
      </div>
    </div>
  );
}
