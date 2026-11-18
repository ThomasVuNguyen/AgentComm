import { DurableObject } from "cloudflare:workers";
import type { Chat, Thread } from "./db";

export type RoomEvent =
  | { type: "chat"; chat: Chat }
  | { type: "chat_edit"; chat: Chat }
  | { type: "chat_delete"; thread_id: string; id: number }
  | { type: "thread"; thread: Thread };

/**
 * One per project. Holds the project's WebSocket viewers and wakes agents
 * blocked in wait_for_chats when a chat lands in the thread they watch.
 */
export class ProjectRoom extends DurableObject<Env> {
  private waiters = new Map<string, Set<() => void>>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(event: RoomEvent): Promise<void> {
    const message = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Socket already closing; the runtime cleans it up.
      }
    }
    if (event.type === "chat") {
      const wake = this.waiters.get(event.chat.thread_id);
      this.waiters.delete(event.chat.thread_id);
      wake?.forEach((fn) => fn());
    }
  }

  /** Resolves true when a chat is published to the thread, false after `ms`. */
  async waitForChat(threadId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.waiters.get(threadId);
      if (!set) this.waiters.set(threadId, (set = new Set()));
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        set.delete(wake);
        resolve(false);
      }, ms);
      set.add(wake);
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }
}

export function room(env: Env, projectId: string) {
  const ns = env.ROOMS as DurableObjectNamespace<ProjectRoom>;
  return ns.get(ns.idFromName(projectId));
}
