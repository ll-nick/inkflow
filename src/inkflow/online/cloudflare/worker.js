// relay/cloudflare/src/worker.ts
import { DurableObject } from "cloudflare:workers";
var PROTOCOL = 1;
var MAX_FRAME = 512 * 1024;
var MAX_WIRE = MAX_FRAME + 64;
var ROOM = /^[A-Za-z0-9_-]{22}$/;
var NO_ROOM = 4404;
var ROOM_FULL = 4409;
var HOST_GONE = 4410;
var UNAUTHORIZED = 4401;
var KICKED = 4403;
var RATE_LIMITED = 4429;
var BAD_REQUEST = 4400;
var REPLACED = 4408;
var ROLE_HEADER = "X-Inkflow-Relay-Role";
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
function b64uDecode(text) {
  try {
    const s = atob(
      text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4)
    );
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
function b64u(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
async function roomOf(secret) {
  const prefix = new TextEncoder().encode("inkflow-room/1");
  const data = new Uint8Array(prefix.length + secret.length);
  data.set(prefix);
  data.set(secret, prefix.length);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64u(new Uint8Array(digest)).slice(0, 22);
}
async function hostRefusal(request, env, room) {
  const token = env.RELAY_ACCESS_TOKEN;
  if (token) {
    const given = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!same(given, token)) return "this relay needs its access token";
  } else if (env.REQUIRE_ACCESS_TOKEN === "1") {
    return "this relay has no access token set yet (wrangler secret put RELAY_ACCESS_TOKEN)";
  }
  const secret = b64uDecode(request.headers.get("Inkflow-Room-Secret") ?? "");
  if (!secret || secret.length < 16) return "bad room secret";
  if (!same(await roomOf(secret), room)) return "not this room's host";
  return null;
}
function refuse(code, reason) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.addEventListener("error", () => {
  });
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_relay/health") {
      return json({ ok: true, v: PROTOCOL, relay: "inkflow" });
    }
    const host = url.pathname === "/_relay/host";
    if (!host && url.pathname !== "/_relay/join") {
      return new Response("not found\n", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("a WebSocket endpoint\n", { status: 426 });
    }
    const room = url.searchParams.get("room") ?? "";
    if (!ROOM.test(room)) return refuse(BAD_REQUEST, "bad room");
    if (host) {
      const refused = await hostRefusal(request, env, room);
      if (refused) return refuse(UNAUTHORIZED, refused);
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const headers = new Headers(request.headers);
    headers.set(ROLE_HEADER, host ? "host" : "guest");
    headers.delete("Inkflow-Room-Secret");
    headers.delete("Authorization");
    return stub.fetch(new Request(request.url, { headers }));
  }
};
var Bucket = class {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  rate;
  burst;
  tokens;
  at = Date.now();
  take() {
    const now = Date.now();
    this.tokens = Math.min(
      this.burst,
      this.tokens + (now - this.at) / 1e3 * this.rate
    );
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
};
function close(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
  }
}
var Room = class extends DurableObject {
  buckets = /* @__PURE__ */ new WeakMap();
  attachment(ws) {
    return ws.deserializeAttachment() ?? null;
  }
  host(except) {
    for (const ws of this.ctx.getWebSockets("host")) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }
  guest(peer) {
    return this.ctx.getWebSockets(`g:${peer}`)[0] ?? null;
  }
  closeGuests(code, reason) {
    for (const ws of this.ctx.getWebSockets("guest"))
      close(ws, code, reason);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    if (request.headers.get(ROLE_HEADER) === "host") {
      const [client2, server2] = Object.values(new WebSocketPair());
      const old = this.ctx.getWebSockets("host");
      if (old.length) {
        this.closeGuests(HOST_GONE, "the host reconnected");
        for (const ws of old)
          close(ws, REPLACED, "replaced by a new connection");
      }
      this.ctx.acceptWebSocket(server2, ["host"]);
      const id = crypto.getRandomValues(new Uint32Array(1))[0];
      server2.serializeAttachment({
        role: "host",
        id,
        room
      });
      server2.send(
        JSON.stringify({
          type: "ready",
          room,
          v: PROTOCOL,
          maxGuests: this.maxGuests(),
          maxFrame: MAX_FRAME
        })
      );
      return new Response(null, { status: 101, webSocket: client2 });
    }
    const host = this.host();
    if (!host) return refuse(NO_ROOM, "no one is sharing in this room now");
    if (this.ctx.getWebSockets("guest").length >= this.maxGuests()) {
      return refuse(ROOM_FULL, "the room is full");
    }
    const [client, server] = Object.values(new WebSocketPair());
    let peer = crypto.getRandomValues(new Uint32Array(1))[0];
    while (this.guest(peer))
      peer = crypto.getRandomValues(new Uint32Array(1))[0];
    this.ctx.acceptWebSocket(server, ["guest", `g:${peer}`]);
    server.serializeAttachment({
      role: "guest",
      id: peer,
      room
    });
    host.send(JSON.stringify({ type: "join", peer }));
    return new Response(null, { status: 101, webSocket: client });
  }
  maxGuests() {
    const n = Number(this.env.MAX_GUESTS);
    return Number.isFinite(n) && n > 0 ? n : 50;
  }
  bucket(ws, role) {
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = role === "host" ? new Bucket(2e3, 8e3) : new Bucket(100, 400);
      this.buckets.set(ws, bucket);
    }
    return bucket;
  }
  async webSocketMessage(ws, message) {
    const me = this.attachment(ws);
    if (!me) return;
    if (!this.bucket(ws, me.role).take()) {
      close(ws, RATE_LIMITED, "too many frames");
      return;
    }
    if (me.role === "host") {
      if (typeof message === "string") {
        this.control(message);
        return;
      }
      if (message.byteLength < 5 || message.byteLength > MAX_WIRE) {
        close(ws, 1009, "frame too large");
        return;
      }
      const peer = new DataView(message).getUint32(0);
      const guest = this.guest(peer);
      if (guest) {
        try {
          guest.send(message.slice(4));
        } catch {
          close(guest, 1011, "cannot send");
        }
      }
      return;
    }
    if (typeof message === "string" || !message.byteLength) {
      close(ws, BAD_REQUEST, "frames only");
      return;
    }
    if (message.byteLength > MAX_WIRE - 4) {
      close(ws, 1009, "frame too large");
      return;
    }
    const host = this.host();
    if (!host) {
      close(ws, HOST_GONE, "the host left");
      return;
    }
    const out = new Uint8Array(4 + message.byteLength);
    new DataView(out.buffer).setUint32(0, me.id);
    out.set(new Uint8Array(message), 4);
    host.send(out);
  }
  control(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "kick" && typeof msg.peer === "number") {
      const guest = this.guest(msg.peer);
      if (guest) close(guest, KICKED, "sent away");
    }
  }
  async webSocketClose(ws, code, reason) {
    this.gone(ws);
    close(ws, code === 1005 || code === 1006 ? 1e3 : code, reason);
  }
  async webSocketError(ws) {
    this.gone(ws);
  }
  gone(ws) {
    const me = this.attachment(ws);
    if (!me) return;
    if (me.role === "host") {
      if (!this.host(ws)) this.closeGuests(HOST_GONE, "the host left");
      return;
    }
    const host = this.host();
    if (host) {
      try {
        host.send(JSON.stringify({ type: "leave", peer: me.id }));
      } catch {
      }
    }
  }
};
export {
  Room,
  worker_default as default,
  hostRefusal,
  roomOf
};
