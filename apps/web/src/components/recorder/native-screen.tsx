import { useMutation } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Command,
  Eye,
  Hand,
  Keyboard,
  ListTree,
  MousePointer2,
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

type Mode = 'tap' | 'longPress' | 'double' | 'right' | 'checkText' | 'checkVisible';
type ModeSpec = { id: Mode; label: string; icon: typeof Hand; hint: string };

const TAP: ModeSpec = {
  id: 'tap',
  label: 'Tap',
  icon: MousePointerClick,
  hint: 'Taps what you click; a text field gets the focus',
};
const CLICK: ModeSpec = {
  id: 'tap',
  label: 'Click',
  icon: MousePointerClick,
  hint: 'Clicks what you click; a text field gets the focus',
};
const LONG: ModeSpec = {
  id: 'longPress',
  label: 'Long press',
  icon: Hand,
  hint: 'Holds what you click for a second',
};
const DOUBLE: ModeSpec = {
  id: 'double',
  label: 'Double-click',
  icon: MousePointer2,
  hint: 'Double-clicks what you click',
};
const RIGHT: ModeSpec = {
  id: 'right',
  label: 'Right-click',
  icon: MousePointer2,
  hint: 'Right-clicks what you click (its context menu)',
};
const CHECKS: ModeSpec[] = [
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

/** What a click on the picture means, for recording a phone or desktop app, or using one in a manual test. */
function modesFor(kind: 'phone' | 'desktop', recording: boolean): ModeSpec[] {
  const base = kind === 'phone' ? [TAP, LONG] : [CLICK, DOUBLE, RIGHT];
  return recording ? [...base, ...CHECKS] : base;
}

type ActResult = { describe?: string; field?: boolean; recording?: unknown };

/**
 * A phone or desktop app's screen in the dashboard (a desktop app's windows), refreshed about once a second. Clicking
 * it taps or clicks the app; typing, keys, swipes and menus go to the app as well. Recording (`recording`): each action
 * becomes a step (or a check). A manual test: the tester uses the app from here as on the device.
 */
export function NativeScreen({
  platform,
  screenUrl = '/api/recorder/screen',
  actUrl = '/api/recorder/act',
  recording = true,
  onActed,
}: {
  platform: string;
  screenUrl?: string;
  actUrl?: string;
  /** Recording (each action becomes a step), or a manual test (the actions only drive the app). */
  recording?: boolean;
  onActed?: (res: ActResult, body: Record<string, unknown>) => void;
}) {
  const kind: 'phone' | 'desktop' = ['macOS', 'Windows', 'Linux'].includes(platform) ? 'desktop' : 'phone';
  const modes = modesFor(kind, recording);
  const [src, setSrc] = useState<string>();
  const [mode, setMode] = useState<Mode>('tap');
  const [text, setText] = useState('');
  const [keys, setKeys] = useState('');
  const [menu, setMenu] = useState('');
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
          const res = await fetch(`${screenUrl}?t=${tick.current++}`, {
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
  }, [screenUrl]);

  const act = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      busy.current = true;
      try {
        return await api<ActResult>(actUrl, { method: 'POST', json: body });
      } finally {
        busy.current = false;
      }
    },
    onSuccess: (res, body) => {
      onActed?.(res, body);
      if (body.action === 'tap' || body.action === 'click') setFocused(res.field ? res.describe : undefined);
      if (body.action === 'type') {
        setText('');
        toast('Typed');
      }
      if (body.action === 'key') setKeys('');
      if (body.action === 'menu') setMenu('');
    },
    onError: toastError,
  });

  const click = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (mode === 'checkText' || mode === 'checkVisible')
      return act.mutate({ action: 'check', check: mode === 'checkText' ? 'text' : 'visible', x, y });
    if (!recording) {
      // A manual test: the tap or click goes to the point itself.
      if (mode === 'longPress') return act.mutate({ action: 'tap', x, y, holdMs: 1000 });
      if (mode === 'double') return act.mutate({ action: 'tap', x, y, count: 2 });
      if (mode === 'right') return act.mutate({ action: 'tap', x, y, button: 'right' });
      return act.mutate({ action: 'tap', x, y });
    }
    if (mode === 'longPress') return act.mutate({ action: 'longPress', x, y });
    if (kind === 'phone') return act.mutate({ action: 'tap', x, y });
    act.mutate({
      action: 'click',
      x,
      y,
      ...(mode === 'double' && { count: 2 }),
      ...(mode === 'right' && { button: 'right' }),
    });
  };

  // Recording types into the field clicked last (its step gets the text); a manual test types where the focus is.
  const canType = !recording || !!focused;
  return (
    <div
      className={cn(
        'grid gap-4 p-4',
        kind === 'phone' ? 'md:grid-cols-[minmax(0,320px)_1fr]' : 'lg:grid-cols-[minmax(0,640px)_1fr]',
      )}
    >
      <div
        className={cn(
          'relative mx-auto w-full overflow-hidden bg-black',
          kind === 'phone'
            ? 'max-w-[320px] rounded-[28px] border-4 border-fg/80'
            : 'rounded-lg border border-border',
        )}
      >
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
            onContextMenu={(e) => {
              // A right-click on a desktop app's picture right-clicks the app.
              if (kind !== 'desktop') return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - r.left) / r.width;
              const y = (e.clientY - r.top) / r.height;
              act.mutate(
                recording
                  ? { action: 'click', x, y, button: 'right' }
                  : { action: 'tap', x, y, button: 'right' },
              );
            }}
          />
        ) : (
          <div
            className={cn(
              'grid place-items-center text-xs text-white/70',
              kind === 'phone' ? 'aspect-[9/19]' : 'aspect-video',
            )}
          >
            Starting the app…
          </div>
        )}
      </div>
      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Clicking the screen will…</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Clicking the screen will">
            {modes.map((m) => (
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
            {!recording
              ? 'Type into the field that has the focus'
              : focused
                ? `Type into ${focused}`
                : `${kind === 'phone' ? 'Tap' : 'Click'} a text field on the screen, then type here`}
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Text to type"
              value={text}
              disabled={!canType}
              onChange={(e) => setText(e.target.value)}
              placeholder={canType ? 'Text, then Enter' : ''}
            />
            <Button type="submit" size="sm" disabled={!canType || act.isPending}>
              <Type className="h-3.5 w-3.5" /> Type
            </Button>
          </div>
        </form>
        {kind === 'phone' ? (
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
        ) : (
          <>
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate({ action: 'key', key: keys });
              }}
            >
              <p className="text-xs font-medium text-muted">Press a key or a shortcut</p>
              <div className="flex gap-2">
                <Input
                  aria-label="Keys to press"
                  value={keys}
                  onChange={(e) => setKeys(e.target.value)}
                  placeholder="Enter, Tab, Control+S, Meta+N"
                  className="font-mono"
                />
                <Button type="submit" size="sm" disabled={!keys.trim() || act.isPending}>
                  <Command className="h-3.5 w-3.5" /> Press
                </Button>
              </div>
            </form>
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate({ action: 'menu', path: menu });
              }}
            >
              <p className="text-xs font-medium text-muted">Choose from the menu bar</p>
              <div className="flex gap-2">
                <Input
                  aria-label="Menu path"
                  value={menu}
                  onChange={(e) => setMenu(e.target.value)}
                  placeholder="File > Save"
                />
                <Button type="submit" size="sm" disabled={!menu.trim() || act.isPending}>
                  <ListTree className="h-3.5 w-3.5" /> Choose
                </Button>
              </div>
            </form>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                aria-label="Scroll up"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'scroll', direction: 'up' })}
              >
                <ArrowUp className="h-3.5 w-3.5" /> Scroll
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label="Scroll down"
                disabled={act.isPending}
                onClick={() => act.mutate({ action: 'scroll', direction: 'down' })}
              >
                <ArrowDown className="h-3.5 w-3.5" /> Scroll
              </Button>
            </div>
          </>
        )}
        <p className="text-xs text-muted">
          {recording
            ? 'Each action is done in the app and recorded with the element’s id, text or label. Elements without any get an explanation instead of a step: give them an accessibility id in the app.'
            : kind === 'phone'
              ? 'Taps go to the point you click; you can also use the device or simulator itself.'
              : 'Clicks go to the point you click; you can also use the app itself (it shows on this computer’s screen).'}
        </p>
      </div>
    </div>
  );
}
