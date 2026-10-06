// Type-only import: Monaco itself is lazy-loaded by the editor and handed to onMount.
import type * as Monaco from 'monaco-editor';

export type SqlSchema = { tables: { name: string; columns: { name: string; type: string }[] }[] };
const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'DISTINCT',
  'COUNT(*)',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'AS',
  'ASC',
  'DESC',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'UNION',
  'EXPLAIN',
];

/**
 * Schema-aware SQL completion: table names everywhere, and `table.` / `alias.` completes that table's columns.
 * Returns a disposer; one provider is active at a time (the workbench's current connection).
 */
export function registerSqlCompletions(m: typeof Monaco, schema: SqlSchema): Monaco.IDisposable {
  return m.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const before = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      });
      const qualifier = /([A-Za-z_][\w]*)\.$/.exec(before)?.[1];
      const K = m.languages.CompletionItemKind;
      if (qualifier) {
        // Resolve aliases written as "FROM table alias" / "JOIN table AS alias".
        const text = model.getValue();
        const alias = new RegExp(`\\b([A-Za-z_][\\w]*)\\s+(?:AS\\s+)?${qualifier}\\b`, 'i').exec(text)?.[1];
        const table = schema.tables.find(
          (t) =>
            t.name.toLowerCase() === qualifier.toLowerCase() || t.name.toLowerCase() === alias?.toLowerCase(),
        );
        return {
          suggestions: (table?.columns ?? []).map((c) => ({
            label: c.name,
            kind: K.Field,
            detail: c.type,
            insertText: c.name,
            range,
          })),
        };
      }
      return {
        suggestions: [
          ...schema.tables.map((t) => ({
            label: t.name,
            kind: K.Class,
            detail: 'table',
            insertText: t.name,
            range,
          })),
          ...schema.tables.flatMap((t) =>
            t.columns.map((c) => ({
              label: c.name,
              kind: K.Field,
              detail: `${t.name} · ${c.type}`,
              insertText: c.name,
              range,
              sortText: `z${c.name}`,
            })),
          ),
          ...SQL_KEYWORDS.map((k) => ({
            label: k,
            kind: K.Keyword,
            insertText: k,
            range,
            sortText: `zz${k}`,
          })),
        ],
      };
    },
  });
}
