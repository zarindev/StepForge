import { isMongoWrite, MONGO_READ_OPS, MONGO_WRITE_OPS } from '../sql-guard.ts';
import {
  DbError,
  normalizeRows,
  type ColumnInfo,
  type ConnectionConfig,
  type DbClient,
  type SchemaInfo,
} from '../types.ts';

/**
 * A Mongo command, written as (Extended) JSON in the workbench and in `db.query` steps:
 *   { "collection": "patients", "find": { "email": "a@b.test" }, "projection": {…}, "sort": {…}, "limit": 10 }
 *   { "collection": "orders", "aggregate": [ { "$match": {…} }, { "$group": {…} } ] }
 *   { "collection": "patients", "countDocuments": {…} }   { "collection": "x", "distinct": "field", "filter": {…} }
 *   { "collection": "x", "insertOne": {…} } / insertMany / updateOne|updateMany { filter, update } / deleteOne|deleteMany
 */
export type MongoCommand = Record<string, unknown> & { collection: string };

export async function parseMongoCommand(text: string): Promise<MongoCommand> {
  const { BSON } = await import('mongodb');
  let spec: unknown;
  try {
    spec = BSON.EJSON.parse(text, { relaxed: true });
  } catch (err) {
    throw new DbError('query', `Mongo command must be JSON: ${(err as Error).message}`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    throw new DbError('query', 'Mongo command must be a JSON object');
  const cmd = spec as MongoCommand;
  if (typeof cmd.collection !== 'string' || !cmd.collection)
    throw new DbError('query', 'Mongo command needs a "collection"');
  const ops = [...MONGO_READ_OPS, ...MONGO_WRITE_OPS].filter((op) => op in cmd);
  if (ops.length !== 1)
    throw new DbError(
      'query',
      `Mongo command needs exactly one operation: ${[...MONGO_READ_OPS, ...MONGO_WRITE_OPS].join(', ')}`,
    );
  return cmd;
}

export { isMongoWrite };

export async function openMongo(cfg: ConnectionConfig): Promise<DbClient> {
  const { MongoClient } = await import('mongodb');
  const o = cfg.options;
  const uri = String(
    o.uri ?? o.connectionString ?? `mongodb://${cfg.host || '127.0.0.1'}:${cfg.port ?? 27017}`,
  );
  const client = new MongoClient(uri, {
    ...(cfg.username && { auth: { username: cfg.username, password: cfg.password } }),
    ...(o.authSource ? { authSource: String(o.authSource) } : {}),
    ...(o.ssl ? { tls: true } : {}),
    serverSelectionTimeoutMS: Number(o.connectTimeoutMs ?? 10_000),
    appName: 'StepForge',
  });
  try {
    await client.connect();
  } catch (err) {
    throw new DbError('connection', `Cannot connect to MongoDB: ${(err as Error).message}`);
  }
  const db = client.db(cfg.database || undefined);
  let session: ReturnType<typeof client.startSession> | null = null;

  const run = async (cmd: MongoCommand, maxRows?: number) => {
    const started = performance.now();
    const col = db.collection(cmd.collection);
    const s = session ? { session } : {};
    const done = (docs: Record<string, unknown>[]) => {
      const { rows, truncated } = normalizeRows(docs, maxRows);
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      return {
        columns,
        rows,
        rowCount: docs.length,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    };
    const changed = (affected: number, extra: Record<string, unknown> = {}) => ({
      columns: Object.keys(extra),
      rows: Object.keys(extra).length ? [extra] : [],
      rowCount: 0,
      affected,
      durationMs: Math.round(performance.now() - started),
    });
    try {
      if ('find' in cmd) {
        let cur = col.find((cmd.find as object) ?? {}, s);
        if (cmd.projection) cur = cur.project(cmd.projection as object);
        if (cmd.sort) cur = cur.sort(cmd.sort as Record<string, 1 | -1>);
        if (cmd.skip) cur = cur.skip(Number(cmd.skip));
        cur = cur.limit(Math.min(Number(cmd.limit ?? maxRows ?? 1000), (maxRows ?? 1000) + 1));
        return done((await cur.toArray()) as Record<string, unknown>[]);
      }
      if ('aggregate' in cmd)
        return done(
          (await col.aggregate(cmd.aggregate as object[], s).toArray()) as Record<string, unknown>[],
        );
      if ('countDocuments' in cmd) {
        const count = await col.countDocuments((cmd.countDocuments as object) ?? {}, s);
        return done([{ count }]);
      }
      if ('distinct' in cmd) {
        const values = await col.distinct(String(cmd.distinct), (cmd.filter as object) ?? {}, s);
        return done(values.map((value) => ({ value })));
      }
      if ('insertOne' in cmd) {
        const r = await col.insertOne(cmd.insertOne as Record<string, unknown>, s);
        return changed(1, { insertedId: String(r.insertedId) });
      }
      if ('insertMany' in cmd) {
        const r = await col.insertMany(cmd.insertMany as Record<string, unknown>[], s);
        return changed(r.insertedCount);
      }
      const spec = (cmd.updateOne ?? cmd.updateMany ?? cmd.deleteOne ?? cmd.deleteMany) as {
        filter?: object;
        update?: object;
      };
      if ('updateOne' in cmd || 'updateMany' in cmd) {
        const fn = 'updateOne' in cmd ? col.updateOne.bind(col) : col.updateMany.bind(col);
        const r = await fn(spec.filter ?? {}, spec.update ?? {}, s);
        return changed(r.modifiedCount, { matched: r.matchedCount });
      }
      const fn = 'deleteOne' in cmd ? col.deleteOne.bind(col) : col.deleteMany.bind(col);
      const r = await fn(spec.filter ?? spec ?? {}, s);
      return changed(r.deletedCount);
    } catch (err) {
      const msg = (err as Error).message;
      throw new DbError(
        'query',
        /Transaction numbers are only allowed|replica set/i.test(msg)
          ? 'Rollback mode needs MongoDB transactions, which require a replica set. Use a replica set, or turn rollback mode off for this connection.'
          : msg,
      );
    }
  };

  return {
    engine: 'mongo',
    async query(text, _params, opts) {
      return run(await parseMongoCommand(text), opts?.maxRows);
    },
    async callProcedure() {
      throw new DbError('unsupported', 'MongoDB has no stored procedures');
    },
    async begin() {
      session = client.startSession();
      session.startTransaction();
    },
    async rollback() {
      if (session) {
        await session.abortTransaction().catch(() => undefined);
        await session.endSession();
      }
      session = null;
    },
    async schema(): Promise<SchemaInfo> {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const tables = await Promise.all(
        collections
          .filter((c) => !c.name.startsWith('system.'))
          .map(async (c) => {
            const col = db.collection(c.name);
            const sample = await col.find({}).limit(50).toArray();
            const fields = new Map<string, Set<string>>();
            for (const doc of sample)
              for (const [k, v] of Object.entries(doc)) {
                if (!fields.has(k)) fields.set(k, new Set());
                fields
                  .get(k)!
                  .add(
                    v === null
                      ? 'null'
                      : Array.isArray(v)
                        ? 'array'
                        : typeof v === 'object'
                          ? ((v as object).constructor?.name ?? 'object')
                          : typeof v,
                  );
              }
            const columns: ColumnInfo[] = [...fields].map(([name, types]) => ({
              name,
              type: [...types].join(' | '),
              nullable: name !== '_id' && (types.has('null') || sample.some((d) => !(name in d))),
              primaryKey: name === '_id',
            }));
            const indexes = (await col.indexes().catch(() => [])).map((i) => ({
              name: String(i.name),
              columns: Object.keys(i.key),
              unique: !!i.unique,
            }));
            return {
              name: c.name,
              kind: (c.type === 'view' ? 'view' : 'collection') as 'view' | 'collection',
              columns,
              foreignKeys: [],
              indexes,
            };
          }),
      );
      return { engine: 'mongo', database: db.databaseName, tables };
    },
    quote: (id) => id,
    async close() {
      if (session) await session.abortTransaction().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}
