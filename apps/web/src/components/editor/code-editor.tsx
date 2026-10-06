import { lazy, Suspense } from 'react';
import { Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const Monaco = lazy(() => import('./monaco-setup').then((m) => ({ default: m.MonacoEditor })));

/** Monaco editor (loaded on demand) with a plain textarea while it loads. */
export function CodeEditor({
  value,
  onChange,
  language,
  height = 140,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  language: 'json' | 'sql' | 'javascript' | 'plaintext';
  height?: number;
  ariaLabel: string;
  className?: string;
}) {
  const dark = document.documentElement.classList.contains('dark');
  const fallback = (
    <Textarea
      aria-label={ariaLabel}
      spellCheck={false}
      className={cn('font-mono text-xs', className)}
      style={{ height }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border', className)}
      style={{ height }}
      data-testid={`code-${ariaLabel}`}
    >
      <Suspense fallback={fallback}>
        <Monaco
          height={height}
          language={language}
          theme={dark ? 'stepforge-dark' : 'light'}
          value={value}
          onChange={(v) => onChange(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbers: 'off',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            ariaLabel,
            tabSize: 2,
            automaticLayout: true,
            padding: { top: 8 },
          }}
        />
      </Suspense>
    </div>
  );
}
