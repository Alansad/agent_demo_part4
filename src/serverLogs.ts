import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

export type ApiLogEntry = {
  id: string;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  aborted: boolean;
  ip?: string;
  userAgent?: string;
  contentType?: string;
  requestBodySummary?: unknown;
  query?: Record<string, unknown>;
};

type Subscriber = Response;

export class ServerLogStore {
  private logs: ApiLogEntry[] = [];
  private readonly maxEntries: number;
  private readonly subscribers = new Set<Subscriber>();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor({ maxEntries = 200 }: { maxEntries?: number } = {}) {
    this.maxEntries = maxEntries;
  }

  getAll(): ApiLogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }

  add(entry: ApiLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxEntries) {
      this.logs.splice(0, this.logs.length - this.maxEntries);
    }
    this.broadcast(entry);
  }

  subscribe(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    this.subscribers.add(res);
    res.on("close", () => {
      this.subscribers.delete(res);
      if (this.subscribers.size === 0) this.stopKeepAlive();
    });

    if (this.subscribers.size === 1) this.startKeepAlive();
  }

  private broadcast(entry: ApiLogEntry): void {
    const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(payload);
      } catch {
        // 忽略单个断开的订阅者；close 事件会清理
      }
    }
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      for (const res of this.subscribers) {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          // noop
        }
      }
    }, 15_000);
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}

function redactSecrets(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 500) return value.slice(0, 500) + "…(truncated)";
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) return [...value.slice(0, 50), `…(${value.length - 50} more)`];
    return value.map(redactSecrets);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (/key|token|authorization|password|secret/i.test(key)) {
        out[key] = "***";
      } else {
        out[key] = redactSecrets(obj[key]);
      }
    }
    return out;
  }
  return value;
}

function summarizeBody(req: Request): unknown {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (!("body" in req)) return undefined;

  if (req.path === "/chat") {
    const body = req.body as Record<string, unknown>;
    const messages = Array.isArray(body?.messages) ? (body.messages as unknown[]) : [];
    const settings = (body?.settings ?? {}) as Record<string, unknown>;
    return {
      kind: "chat",
      messagesCount: messages.length,
      settings: redactSecrets({
        enableThinking: settings.enableThinking,
        enableTools: settings.enableTools,
        systemPrompt: typeof settings.systemPrompt === "string" ? settings.systemPrompt : "",
      }),
    };
  }

  return redactSecrets(req.body);
}

export function createApiLoggingMiddleware(store: ServerLogStore) {
  return function apiLoggingMiddleware(req: Request, res: Response, next: NextFunction) {
    // 避免把日志自身接口写进日志（否则会疯狂刷屏）
    if (req.path.startsWith("/server-logs")) return next();

    const id = randomUUID();
    const start = process.hrtime.bigint();
    let finished = false;

    res.setHeader("X-Request-Id", id);

    const writeOnce = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;

      const entry: ApiLogEntry = {
        id,
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        aborted,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        contentType: String(res.getHeader("content-type") || ""),
        requestBodySummary: summarizeBody(req),
        query: Object.keys(req.query || {}).length ? (req.query as Record<string, unknown>) : undefined,
      };

      store.add(entry);
    };

    res.on("finish", () => writeOnce(false));
    res.on("close", () => {
      // close 可能发生在 finish 之后，所以用 writeOnce 保证只记一条
      // 若在 finish 前 close，多数情况下是客户端中断（比如 SSE 取消）
      writeOnce(true);
    });

    next();
  };
}

