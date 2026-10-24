// Downloads for Cypress tests exported by StepForge (by Md Zarin Tasnim): Node tasks reading the downloads folder.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Files in the folder, not counting downloads still in progress. */
const files = (folder: string) =>
  existsSync(folder) ? readdirSync(folder).filter((f) => !/\.(crdownload|part|download)$/.test(f)) : [];

/** Tasks: the files there now; the next new file (its name, size, path and text up to 5 MB, as StepForge reads it). */
export function downloadTasks(folder: string) {
  return {
    'downloads:list': () => files(folder),
    'downloads:wait': async ({ before, timeoutMs }: { before: string[]; timeoutMs: number }) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const fileName = files(folder).find((f) => !before.includes(f));
        if (fileName) {
          const path = join(folder, fileName);
          // Wait until the size stops changing: the browser may still be writing it.
          let size = -1;
          while (size !== statSync(path).size) {
            size = statSync(path).size;
            await new Promise((r) => setTimeout(r, 200));
          }
          return { fileName, size, path, content: size <= 5_000_000 ? readFileSync(path, 'utf8') : '' };
        }
        if (Date.now() >= deadline) throw new Error(`No download within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
