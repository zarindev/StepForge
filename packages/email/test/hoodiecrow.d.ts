// hoodiecrow-imap (a scriptable IMAP server used only in tests) ships no types.
declare module 'hoodiecrow-imap' {
  type Server = { listen(port: number, cb: () => void): void; close(cb?: () => void): void };
  export default function hoodiecrow(options: Record<string, unknown>): Server;
}
