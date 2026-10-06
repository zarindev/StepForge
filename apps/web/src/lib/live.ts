import { useEffect, useState } from 'react';
import { sessionToken } from './api';

export type LiveEvent = { type: string; [key: string]: unknown };
type Listener = (e: LiveEvent) => void;

/** Single shared WebSocket with automatic reconnect. */
class LiveConnection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  connect(): void {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/api/ws?token=${encodeURIComponent(sessionToken())}`,
    );
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
    };
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as LiveEvent;
        this.listeners.forEach((l) => l(e));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setConnected(false);
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private setConnected(c: boolean) {
    this.connected = c;
    this.statusListeners.forEach((l) => l(c));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  onStatus(l: (c: boolean) => void): () => void {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  }
}

export const live = new LiveConnection();

export function useLiveConnected(): boolean {
  const [c, setC] = useState(live.connected);
  useEffect(() => live.onStatus(setC), []);
  return c;
}

export function useLiveEvent(handler: Listener): void {
  useEffect(() => live.subscribe(handler), [handler]);
}
