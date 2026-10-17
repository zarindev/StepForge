/**
 * A frame selector can name a frame inside a frame: `#outer >>> #inner` (outermost first). Each part is a CSS
 * selector, optionally followed by ` >> nth=<n>` when several frames match.
 */
export const FRAME_SEPARATOR = ' >>> ';

export function frameChain(selector: string): string[] {
  return selector
    .split(/\s*>>>\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
