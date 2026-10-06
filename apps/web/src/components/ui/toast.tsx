import { CheckCircle2, XCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useSyncExternalStore } from 'react';

type Toast = { id: number; tone: 'success' | 'error'; message: string };
let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, tone: Toast['tone'] = 'success'): void {
  const id = ++seq;
  toasts = [...toasts, { id, tone, message }];
  emit();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
    tone === 'error' ? 6000 : 3000,
  );
}
export const toastError = (err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error');

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {list.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 20 }}
            role="status"
            className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-border bg-elevated px-3.5 py-2.5 text-sm shadow-xl"
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-pass" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-fail" />
            )}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
