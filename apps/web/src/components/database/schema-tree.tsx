import { ChevronRight, Eye, KeyRound, Link2, ListTree, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import type { DbSchema, DbTable } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Tables → columns (PK/FK marked) → indexes. Clicking a table or column hands it to the editor. */
export function SchemaTree({
  schema,
  onTable,
  onColumn,
}: {
  schema: DbSchema;
  onTable: (t: DbTable) => void;
  onColumn: (name: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const toggle = (n: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const tables = schema.tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const key = (t: DbTable) => `${t.schema ?? ''}.${t.name}`;

  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        aria-label="Filter tables"
        placeholder={`Filter ${schema.tables.length} ${schema.engine === 'mongo' ? 'collections' : 'tables'}…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-8 text-xs"
      />
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto text-sm" aria-label="Schema">
        {tables.map((t) => {
          const isOpen = open.has(key(t));
          const fk = new Map(t.foreignKeys.map((f) => [f.column, f]));
          return (
            <li key={key(t)}>
              <div className="group flex items-center gap-1 rounded px-1 hover:bg-fg/[0.05]">
                <button
                  type="button"
                  aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${t.name}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(key(t))}
                  className="p-0.5 text-muted"
                >
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                  title={`Query ${t.name}`}
                  aria-label={`Query ${t.name}`}
                  onClick={() => onTable(t)}
                >
                  {t.kind === 'view' ? (
                    <Eye className="h-3.5 w-3.5 shrink-0 text-indigo" />
                  ) : (
                    <Table2 className="h-3.5 w-3.5 shrink-0 text-brand" />
                  )}
                  <span className="truncate">
                    {t.schema && <span className="text-muted">{t.schema}.</span>}
                    {t.name}
                  </span>
                </button>
                <span className="text-[10px] text-muted" title={`${t.columns.length} columns`}>
                  {t.columns.length}
                </span>
              </div>
              {isOpen && (
                <ul className="mb-1 ml-6 border-l border-border pl-2 text-xs">
                  {t.columns.map((c) => (
                    <li key={c.name}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-fg/[0.05]"
                        onClick={() => onColumn(c.name)}
                        title={`${c.type}${c.nullable ? '' : ' · NOT NULL'}${fk.has(c.name) ? ` · → ${fk.get(c.name)!.refTable}.${fk.get(c.name)!.refColumn}` : ''}`}
                      >
                        {c.primaryKey ? (
                          <KeyRound className="h-3 w-3 text-warn" aria-label="primary key" />
                        ) : fk.has(c.name) ? (
                          <Link2 className="h-3 w-3 text-indigo" aria-label="foreign key" />
                        ) : (
                          <span className="w-3" />
                        )}
                        <span className="font-mono">{c.name}</span>
                        <span className="ml-auto truncate pl-2 text-[10px] text-muted">
                          {c.type}
                          {!c.nullable && !c.primaryKey && ' *'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {t.indexes.length > 0 && (
                    <li className="mt-1 flex items-start gap-1.5 px-1 text-[11px] text-muted">
                      <ListTree className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        {t.indexes
                          .map((i) => `${i.name}${i.unique ? ' (unique)' : ''}: ${i.columns.join(', ')}`)
                          .join(' · ')}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
        {tables.length === 0 && (
          <li className="px-2 py-3 text-xs text-muted">No tables{filter && ' match'}.</li>
        )}
      </ul>
    </div>
  );
}
