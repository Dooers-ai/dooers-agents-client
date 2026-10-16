export class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closedWith: number | null = null;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.readyState = 3;
    this.closedWith = code ?? 1000;
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The server (or Cloud Run's request timeout) drops the socket. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }

  connectFrame() {
    return JSON.parse(this.sent.find((s) => JSON.parse(s).type === "connect") as string);
  }
}

export function ackConnect(ws: MockWebSocket, ok: boolean, error?: { code: string; message: string }) {
  ws.receive({
    id: "s1",
    type: "ack",
    payload: { ack_id: ws.connectFrame().id, ok, ...(error ? { error } : {}) },
  });
}
