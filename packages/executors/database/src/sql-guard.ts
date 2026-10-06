/**
 * Best-effort SQL statement classifier used to enforce read-only connections and production confirmations.
 * It is deliberately conservative: anything it does not recognise as a read is treated as a write.
 * Drivers add a second line of defence where the engine supports it (SQLite readonly handle,
 * PostgreSQL/MySQL read-only sessions); see docs/KNOWN_ISSUES.md.
 */

export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction';
export type ClassifiedStatement = { text: string; keyword: string; kind: StatementKind };
export type Classification = {
  statements: ClassifiedStatement[];
  /** True when any statement changes data, schema, session state or transactions. */
  write: boolean;
  /** True when any statement controls transactions (BEGIN/COMMIT/ROLLBACK…). */
  transactionControl: boolean;
};

const READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'USE', 'EXPLAIN', 'WITH']);
const DDL = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'REINDEX',
]);
const TRANSACTION = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT']);
const WRITE_WORD = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/;

/**
 * Blanks out comments, string literals and quoted identifiers with spaces, keeping every character position,
 * so keywords inside strings are ignored and split points map straight back onto the original text.
 */
export type SqlDialect = {
  backslashEscapes: boolean;
  dollarQuotes: boolean;
  bracketIdentifiers: boolean;
  hashComments: boolean;
};
/** How each engine lexes: MySQL has backslash escapes and # comments, PostgreSQL dollar quotes, SQL Server [ids]. */
export const DIALECTS: Record<string, SqlDialect> = {
  pg: { backslashEscapes: false, dollarQuotes: true, bracketIdentifiers: false, hashComments: false },
  mysql: { backslashEscapes: true, dollarQuotes: false, bracketIdentifiers: false, hashComments: true },
  mssql: { backslashEscapes: false, dollarQuotes: false, bracketIdentifiers: true, hashComments: false },
  sqlite: { backslashEscapes: false, dollarQuotes: false, bracketIdentifiers: true, hashComments: false },
};
const ALL_DIALECTS: SqlDialect[] = Array.from({ length: 16 }, (_, m) => ({
  backslashEscapes: !!(m & 1),
  dollarQuotes: !!(m & 2),
  bracketIdentifiers: !!(m & 4),
  hashComments: !!(m & 8),
}));

export function stripSql(sql: string, dialect: SqlDialect = DIALECTS.sqlite!): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    let end = -1;
    if (
      (c === '-' && next === '-') ||
      (c === '#' && dialect.hashComments && (i === 0 || /\s/.test(sql[i - 1]!)))
    ) {
      end = sql.indexOf('\n', i);
      if (end === -1) end = n;
    } else if (c === '/' && next === '*') {
      end = sql.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && c === "'" && dialect.backslashEscapes) j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      end = Math.min(j + 1, n);
    } else if (c === '[' && dialect.bracketIdentifiers) {
      end = sql.indexOf(']', i + 1);
      end = end === -1 ? n : end + 1;
    } else if (c === '$' && dialect.dollarQuotes && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        end = sql.indexOf(m[0], i + m[0].length);
        end = end === -1 ? n : end + m[0].length;
      }
    }
    if (end === -1) i++;
    else {
      blank(i, end);
      i = end;
    }
  }
  return out.join('');
}

/** Splits a script into statements on top-level semicolons (comments and strings are ignored). */
export function splitStatements(sql: string, dialect?: SqlDialect): string[] {
  const stripped = stripSql(sql, dialect);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === ';') {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter((p) => stripSql(p, dialect).trim().length > 0);
}

function classifyOne(text: string, dialect: SqlDialect): ClassifiedStatement {
  const s = stripSql(text, dialect)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/^\(+\s*/, '');
  const keyword = /^[A-Z_]+/.exec(s)?.[0] ?? '';
  let kind: StatementKind;
  if (TRANSACTION.has(keyword)) kind = 'transaction';
  else if (DDL.has(keyword)) kind = 'ddl';
  else if (keyword === 'PRAGMA') kind = s.includes('=') || /\(\s*[^)]/.test(s) ? 'write' : 'read';
  else if (keyword === 'EXPLAIN') {
    // EXPLAIN ANALYZE really executes the statement.
    kind = /\bANALY[SZ]E\b/.test(s) && WRITE_WORD.test(s) ? 'write' : 'read';
  } else if (keyword === 'WITH') kind = WRITE_WORD.test(s) ? 'write' : 'read';
  else if (keyword === 'SELECT') kind = /\bINTO\b/.test(s) && !/\bINTO\s+@/.test(s) ? 'write' : 'read';
  else if (READ.has(keyword)) kind = 'read';
  else kind = 'write'; // INSERT, UPDATE, DELETE, MERGE, CALL, EXEC, SET, COPY, VACUUM, ATTACH, unknown…
  return { text, keyword, kind };
}

/**
 * Classifies a script for `engine`. Because a wrong guess about lexing could hide a write inside what looks
 * like a string, the script is also lexed under every other dialect, and it counts as a write if any says so.
 */
export function classifySql(sql: string, engine = 'sqlite'): Classification {
  const dialect = DIALECTS[engine] ?? DIALECTS.sqlite!;
  const statements = splitStatements(sql, dialect).map((t) => classifyOne(t, dialect));
  const others = ALL_DIALECTS.flatMap((d) => splitStatements(sql, d).map((t) => classifyOne(t, d)));
  return {
    statements,
    write: [...statements, ...others].some((s) => s.kind !== 'read'),
    transactionControl: [...statements, ...others].some((s) => s.kind === 'transaction'),
  };
}

/** Mongo operations accepted by the Mongo driver. */
export const MONGO_READ_OPS = ['find', 'aggregate', 'countDocuments', 'distinct'] as const;
export const MONGO_WRITE_OPS = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const;

/** A Mongo command is a write when it uses a write op or an aggregation stage that writes ($out/$merge). */
export function isMongoWrite(spec: Record<string, unknown>): boolean {
  if (MONGO_WRITE_OPS.some((op) => op in spec)) return true;
  const pipeline = spec.aggregate;
  return (
    Array.isArray(pipeline) &&
    pipeline.some((stage) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage))
  );
}
