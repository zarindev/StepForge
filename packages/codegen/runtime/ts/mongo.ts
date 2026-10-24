// MongoDB access for tests exported by StepForge (by Md Zarin Tasnim).
// Each connection name reads DB_<NAME>_URL: mongodb://user:password@host:27017/database
import { BSON, MongoClient, type Document } from 'mongodb';
import type { DbLike } from './helpers';

function urlFor(connection: string): string {
  const key = `DB_${connection.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_URL`;
  const url = process.env[key];
  if (!url) throw new Error(`Set ${key} for the "${connection}" database (see .env.example)`);
  return url;
}

const READ = ['find', 'aggregate', 'countDocuments', 'distinct'];
const WRITE = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];

/**
 * Runs one Mongo command, written as StepForge writes it (Extended JSON text, or the same as a value):
 * `{ "collection": "orders", "find": {…}, "sort": {…}, "limit": 10 }`, aggregate, countDocuments, distinct (+ filter),
 * insertOne / insertMany, updateOne / updateMany `{ filter, update }`, deleteOne / deleteMany. The result reads like
 * a database result: rows (documents), columns, rowCount, affected.
 */
export async function run(connection: string, command: string | Record<string, unknown>): Promise<DbLike> {
  const cmd = (
    typeof command === 'string'
      ? BSON.EJSON.parse(command, { relaxed: true })
      : BSON.EJSON.deserialize(command)
  ) as Record<string, unknown>;
  const name = [...READ, ...WRITE].filter((k) => k in cmd);
  if (typeof cmd.collection !== 'string' || name.length !== 1)
    throw new Error(`A Mongo command needs a "collection" and one of: ${[...READ, ...WRITE].join(', ')}`);
  const client = new MongoClient(urlFor(connection), { serverSelectionTimeoutMS: 10_000 });
  const started = Date.now();
  await client.connect();
  try {
    const col = client.db().collection(cmd.collection);
    const rows = (docs: Document[]): DbLike => {
      const plain = docs.map((d) => BSON.EJSON.serialize(d, { relaxed: true }) as Record<string, unknown>);
      return {
        rows: plain,
        columns: [...new Set(plain.flatMap((r) => Object.keys(r)))],
        rowCount: plain.length,
        ms: Date.now() - started,
      };
    };
    const changed = (affected: number, extra: Record<string, unknown> = {}): DbLike => ({
      rows: Object.keys(extra).length ? [extra] : [],
      columns: Object.keys(extra),
      rowCount: 0,
      affected,
      ms: Date.now() - started,
    });
    if ('find' in cmd) {
      let cur = col.find((cmd.find as Document) ?? {});
      if (cmd.projection) cur = cur.project(cmd.projection as Document);
      if (cmd.sort) cur = cur.sort(cmd.sort as Record<string, 1 | -1>);
      if (cmd.skip) cur = cur.skip(Number(cmd.skip));
      return rows(await cur.limit(Number(cmd.limit ?? 1000)).toArray());
    }
    if ('aggregate' in cmd) return rows(await col.aggregate(cmd.aggregate as Document[]).toArray());
    if ('countDocuments' in cmd)
      return rows([{ count: await col.countDocuments((cmd.countDocuments as Document) ?? {}) }]);
    if ('distinct' in cmd)
      return rows(
        (await col.distinct(String(cmd.distinct), (cmd.filter as Document) ?? {})).map((value) => ({
          value,
        })),
      );
    if ('insertOne' in cmd) {
      const r = await col.insertOne(cmd.insertOne as Document);
      return changed(1, { insertedId: String(r.insertedId) });
    }
    if ('insertMany' in cmd)
      return changed((await col.insertMany(cmd.insertMany as Document[])).insertedCount);
    const spec = (cmd.updateOne ?? cmd.updateMany ?? cmd.deleteOne ?? cmd.deleteMany) as {
      filter?: Document;
      update?: Document;
    };
    if ('updateOne' in cmd || 'updateMany' in cmd) {
      const r = await ('updateOne' in cmd
        ? col.updateOne(spec.filter ?? {}, spec.update ?? {})
        : col.updateMany(spec.filter ?? {}, spec.update ?? {}));
      return changed(r.modifiedCount, { matched: r.matchedCount });
    }
    const filter = spec.filter ?? (spec as Document) ?? {};
    return changed(
      ('deleteOne' in cmd ? await col.deleteOne(filter) : await col.deleteMany(filter)).deletedCount,
    );
  } finally {
    await client.close();
  }
}
