import { AnimatePresence, motion } from 'motion/react';
import { Kbd } from '@/components/ui/kbd';
import { NAV } from '@/lib/nav';

const GLOBAL = [
  ['Ctrl K', 'Open command palette'],
  ['?', 'Show keyboard shortcuts'],
  ['Esc', 'Close dialogs'],
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = NAV.filter((n) => n.shortcut).map((n) => [n.shortcut!, `Go to ${n.label}`]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Keyboard shortcuts"
            className="w-full max-w-lg rounded-xl border border-border bg-elevated p-6 shadow-2xl"
            initial={{ scale: 0.97 }}
            animate={{ scale: 1 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-base font-semibold">Keyboard shortcuts</h2>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 text-sm">
              {[...GLOBAL, ...nav].map(([k, label]) => (
                <div key={label} className="flex items-center justify-between gap-3">
                  <span className="text-muted">{label}</span>
                  <span className="flex gap-1">
                    {k!.split(' ').map((p) => (
                      <Kbd key={p}>{p}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
