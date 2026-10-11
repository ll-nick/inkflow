"use strict";
(() => {
  // src/ts/guest/crypto.ts
  var HELLO = 1;
  var WELCOME = 2;
  var DATA = 3;
  var NONCE_BYTES = 32;
  var HEADER_BYTES = 9;
  var TAG_BYTES = 16;
  var MAX_FRAME = 512 * 1024;
  var MAX_PLAINTEXT = MAX_FRAME - HEADER_BYTES - TAG_BYTES;
  var subtle = () => {
    if (!globalThis.crypto?.subtle) {
      throw new Error(
        "this page needs a secure connection (https) for its encryption"
      );
    }
    return globalThis.crypto.subtle;
  };
  var enc = new TextEncoder();
  function unb64u(text) {
    const s = atob(
      text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4)
    );
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  function buf(bytes) {
    return bytes.slice().buffer;
  }
  function isRoomId(text) {
    return /^[A-Za-z0-9_-]{22}$/.test(text);
  }
  async function hkdf(ikm, salt, info) {
    const key = await subtle().importKey("raw", buf(ikm), "HKDF", false, [
      "deriveBits"
    ]);
    const bits = await subtle().deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: buf(salt),
        info: buf(enc.encode(info))
      },
      key,
      256
    );
    return new Uint8Array(bits);
  }
  function authKey(link, room) {
    return hkdf(link, new Uint8Array(0), `inkflow/1 auth ${room}`);
  }
  async function sessionKeys(link, room, cnonce, snonce) {
    const salt = concat(cnonce, snonce);
    return {
      g2h: await hkdf(link, salt, `inkflow/1 g2h ${room}`),
      h2g: await hkdf(link, salt, `inkflow/1 h2g ${room}`)
    };
  }
  async function mac(key, ...parts) {
    const k = await subtle().importKey(
      "raw",
      buf(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new Uint8Array(
      await subtle().sign("HMAC", k, buf(concat(...parts)))
    );
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  async function hello(link, room, cnonce) {
    const nonce2 = cnonce ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
    const tag = await mac(
      await authKey(link, room),
      enc.encode("hello"),
      nonce2
    );
    return concat(new Uint8Array([HELLO]), nonce2, tag);
  }
  var CryptoError = class extends Error {
  };
  async function finish(link, room, helloFrame, frame) {
    if (frame.length !== 1 + NONCE_BYTES + 32 || frame[0] !== WELCOME) {
      throw new CryptoError("not a welcome frame");
    }
    const cnonce = helloFrame.slice(1, 1 + NONCE_BYTES);
    const snonce = frame.slice(1, 1 + NONCE_BYTES);
    const expected = await mac(
      await authKey(link, room),
      enc.encode("welcome"),
      cnonce,
      snonce
    );
    if (!sameBytes(frame.slice(1 + NONCE_BYTES), expected)) {
      throw new CryptoError("the welcome is not from the host");
    }
    const { g2h, h2g } = await sessionKeys(link, room, cnonce, snonce);
    return Session.create(g2h, h2g);
  }
  function header(seq) {
    const out = new Uint8Array(HEADER_BYTES);
    out[0] = DATA;
    new DataView(out.buffer).setBigUint64(1, BigInt(seq));
    return out;
  }
  function nonce(seq) {
    const out = new Uint8Array(12);
    new DataView(out.buffer).setBigUint64(4, BigInt(seq));
    return out;
  }
  function aesKey(raw, use) {
    return subtle().importKey("raw", buf(raw), "AES-GCM", false, [use]);
  }
  async function seal(key, seq, plaintext) {
    const head = header(seq);
    const sealed = await subtle().encrypt(
      { name: "AES-GCM", iv: buf(nonce(seq)), additionalData: buf(head) },
      key,
      buf(plaintext)
    );
    return concat(head, new Uint8Array(sealed));
  }
  async function unseal(key, expect, frame) {
    if (frame.length < HEADER_BYTES + TAG_BYTES || frame[0] !== DATA) {
      throw new CryptoError("not a data frame");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    const seq = Number(view.getBigUint64(1));
    if (seq !== expect) {
      throw new CryptoError(`frame ${seq} where ${expect} was due`);
    }
    try {
      const plain = await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: buf(nonce(seq)),
          additionalData: buf(frame.slice(0, HEADER_BYTES))
        },
        key,
        buf(frame.slice(HEADER_BYTES))
      );
      return new Uint8Array(plain);
    } catch {
      throw new CryptoError("frame failed authentication");
    }
  }
  var Session = class _Session {
    constructor(sendKey, recvKey) {
      this.sendKey = sendKey;
      this.recvKey = recvKey;
    }
    sendKey;
    recvKey;
    sent = 0;
    received = 0;
    // Frames are sealed and opened one at a time, in order (each awaits the
    // one before), so the sequence numbers match the order on the wire.
    sealing = Promise.resolve();
    opening = Promise.resolve();
    static async create(send, recv) {
      return new _Session(
        await aesKey(send, "encrypt"),
        await aesKey(recv, "decrypt")
      );
    }
    seal(plaintext) {
      const seq = this.sent++;
      const next = this.sealing.then(
        () => seal(this.sendKey, seq, plaintext)
      );
      this.sealing = next.catch(() => {
      });
      return next;
    }
    open(frame) {
      const seq = this.received++;
      const next = this.opening.then(() => unseal(this.recvKey, seq, frame));
      this.opening = next.catch(() => {
      });
      return next;
    }
  };

  // src/ts/guest/frames.ts
  var LAST = 1;
  var CHUNK = MAX_PLAINTEXT - 1;
  var MAX_MESSAGE = 96 * 1024 * 1024;
  var enc2 = new TextEncoder();
  var dec = new TextDecoder();
  function pack(header2, body = new Uint8Array(0)) {
    const head = enc2.encode(JSON.stringify(header2));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, head.length);
    return concat(len, head, body);
  }
  function unpack(message) {
    if (message.length < 4) throw new Error("short message");
    const view = new DataView(message.buffer, message.byteOffset, 4);
    const n = view.getUint32(0);
    if (4 + n > message.length) throw new Error("header past the end");
    const header2 = JSON.parse(dec.decode(message.subarray(4, 4 + n)));
    if (!header2 || typeof header2 !== "object" || Array.isArray(header2)) {
      throw new Error("header is not an object");
    }
    return [header2, message.subarray(4 + n)];
  }
  var RAW = 0;
  var DEFLATE = 1;
  function wrap(message) {
    return concat(new Uint8Array([RAW]), message);
  }
  async function unwrap(data, limit = MAX_MESSAGE) {
    if (!data.length) throw new Error("empty message");
    if (data[0] === RAW) return data.subarray(1);
    if (data[0] !== DEFLATE) throw new Error("unknown message coding");
    const stream = new Blob([data.slice(1)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const parts = [];
    let size = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("message too large");
      }
      parts.push(value);
    }
    return concat(...parts);
  }
  function chunks(message, size = CHUNK) {
    if (!message.length) return [new Uint8Array([LAST])];
    const out = [];
    for (let i = 0; i < message.length; i += size) {
      const part = message.subarray(i, i + size);
      const last = i + size >= message.length;
      out.push(concat(new Uint8Array([last ? LAST : 0]), part));
    }
    return out;
  }
  var Reassembler = class {
    constructor(limit = MAX_MESSAGE) {
      this.limit = limit;
    }
    limit;
    parts = [];
    size = 0;
    /** The whole message once its last chunk is in, else null. */
    push(plaintext) {
      if (!plaintext.length) throw new Error("empty chunk");
      this.size += plaintext.length - 1;
      if (this.size > this.limit) throw new Error("message too large");
      this.parts.push(plaintext.subarray(1));
      if (plaintext[0] & LAST) {
        const message = concat(...this.parts);
        this.parts = [];
        this.size = 0;
        return message;
      }
      return null;
    }
  };

  // src/ts/guest/channel.ts
  var NO_ROOM = 4404;
  var ROOM_FULL = 4409;
  var HOST_GONE = 4410;
  var KICKED = 4403;
  var RATE_LIMITED = 4429;
  var SENT_AWAY = 4001;
  var RelaySocket = class {
    constructor(channel, cid) {
      this.channel = channel;
      this.cid = cid;
    }
    channel;
    cid;
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    send(data) {
      if (this.readyState === 0) throw new Error("still connecting");
      if (this.readyState !== 1) return;
      this.channel.send(
        { t: "ws", c: this.cid },
        new TextEncoder().encode(String(data))
      );
    }
    close(code = 1e3, reason = "") {
      if (this.readyState >= 2) return;
      const wasOpen = this.readyState === 1;
      this.readyState = 2;
      if (wasOpen) {
        this.channel.send({ t: "close", c: this.cid, code, reason });
      }
      this.ended(code, reason);
    }
    opened() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({ type: "open" });
    }
    message(text) {
      if (this.readyState === 1)
        this.onmessage?.({ type: "message", data: text });
    }
    ended(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.channel.forget(this.cid);
      this.onclose?.({ type: "close", code, reason, wasClean: code < 4e3 });
    }
  };
  var Channel = class {
    constructor(link, relayUrl) {
      this.link = link;
      this.relayUrl = relayUrl;
    }
    link;
    relayUrl;
    state = "connecting";
    role = null;
    /** Why the channel ended, or what it is waiting for. */
    detail = "";
    onstate = () => {
    };
    /** Bytes of frames each way, for measurements. */
    sentBytes = 0;
    receivedBytes = 0;
    ws = null;
    session = null;
    helloFrame = null;
    again = new Reassembler();
    sending = Promise.resolve();
    sockets = /* @__PURE__ */ new Map();
    fetches = /* @__PURE__ */ new Map();
    nextCid = 1;
    nextRid = 1;
    waiters = [];
    retry = 1e3;
    start() {
      this.connect();
    }
    whenOpen() {
      if (this.state === "open") return Promise.resolve();
      return new Promise((resolve) => this.waiters.push(resolve));
    }
    setState(state, detail = "") {
      this.state = state;
      this.detail = detail;
      this.onstate(state, detail);
      if (state === "open") {
        for (const resolve of this.waiters) resolve();
        this.waiters = [];
      }
    }
    connect() {
      if (this.state === "ended") return;
      const url = `${this.relayUrl}/_relay/join?room=${encodeURIComponent(this.link.room)}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.session = null;
      this.again = new Reassembler();
      let inbox = Promise.resolve();
      ws.onopen = () => {
        void hello(this.link.secret, this.link.room).then((frame) => {
          this.helloFrame = frame;
          this.raw(frame);
        });
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(ev.data);
        this.receivedBytes += frame.length;
        inbox = inbox.then(() => this.receive(frame)).catch((err) => {
          console.warn("inkflow: dropped the channel:", err);
          ws.close(4e3, "bad frame");
        });
      };
      ws.onclose = (ev) => this.closed(ws, ev.code, ev.reason);
    }
    closed(ws, code, reason) {
      if (this.ws !== ws) return;
      this.ws = null;
      this.session = null;
      const ending = this.state === "ended";
      const sentAway = code === KICKED || code === RATE_LIMITED;
      const why = ending ? this.detail : sentAway ? reason || "the host sent this page away" : "";
      for (const sock of [...this.sockets.values()]) {
        sock.ended(ending || sentAway ? SENT_AWAY : 1006, why);
      }
      for (const sink of this.fetches.values()) {
        sink.error("the connection to the host was lost");
      }
      this.fetches.clear();
      if (ending) return;
      if (sentAway) {
        this.setState("ended", why);
        return;
      }
      const waiting = code === NO_ROOM || code === HOST_GONE ? "Waiting for the person sharing the deck\u2026 (if they made new links since, this one no longer works)" : code === ROOM_FULL ? "The room is full: trying again shortly\u2026" : "Reconnecting\u2026";
      this.setState("waiting", waiting);
      const delay = code === ROOM_FULL ? 1e4 : this.retry;
      this.retry = Math.min(this.retry * 2, 15e3);
      window.setTimeout(() => this.connect(), delay);
    }
    /** End for good (the host said bye, or the page gives up). */
    end(why) {
      if (this.state === "ended") return;
      this.setState("ended", why);
      this.ws?.close(1e3, "bye");
    }
    raw(frame) {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.sentBytes += frame.length;
      this.ws.send(frame);
    }
    async receive(frame) {
      if (!this.session) {
        if (!this.helloFrame) throw new Error("welcome before hello");
        this.session = await finish(
          this.link.secret,
          this.link.room,
          this.helloFrame,
          frame
        );
        return;
      }
      const message = this.again.push(await this.session.open(frame));
      if (!message) return;
      const [header2, body] = unpack(await unwrap(message));
      this.dispatch(header2, body);
    }
    dispatch(header2, body) {
      const t = header2.t;
      if (t === "hi") {
        this.role = header2.role === "editor" ? "editor" : "viewer";
        this.retry = 1e3;
        this.setState("open");
      } else if (t === "ws") {
        this.sockets.get(Number(header2.c))?.message(new TextDecoder().decode(body));
      } else if (t === "close") {
        this.sockets.get(Number(header2.c))?.ended(
          Number(header2.code) || 1e3,
          String(header2.reason ?? "")
        );
      } else if (t === "res") {
        this.fetches.get(Number(header2.id))?.head(
          Number(header2.status),
          header2.headers ?? {}
        );
      } else if (t === "body") {
        this.fetches.get(Number(header2.id))?.chunk(body);
      } else if (t === "end") {
        const id = Number(header2.id);
        this.fetches.get(id)?.end();
        this.fetches.delete(id);
      } else if (t === "bye") {
        this.end(
          String(header2.reason ?? "the person sharing the deck ended it")
        );
      }
    }
    /** Send one message (sealed in order, in as many frames as it takes). */
    send(header2, body) {
      const session = this.session;
      if (!session || this.state !== "open") return;
      const parts = chunks(wrap(pack(header2, body)));
      const sealed = parts.map((p) => session.seal(p));
      this.sending = this.sending.then(async () => {
        for (const frame of sealed) {
          try {
            const bytes = await frame;
            if (this.session === session) this.raw(bytes);
          } catch {
            return;
          }
        }
      });
    }
    // ── What pages use ──
    openSocket() {
      const sock = new RelaySocket(this, this.nextCid++);
      this.sockets.set(sock.cid, sock);
      if (this.state === "ended") {
        window.setTimeout(() => sock.ended(SENT_AWAY, this.detail), 0);
        return sock;
      }
      void this.whenOpen().then(() => {
        if (sock.readyState !== 0) return;
        this.send({ t: "open", c: sock.cid });
        sock.opened();
      });
      return sock;
    }
    forget(cid) {
      this.sockets.delete(cid);
    }
    /** A GET through the channel; returns how to cancel it. */
    fetch(path, range, sink) {
      const id = this.nextRid++;
      let cancelled = false;
      if (this.state === "ended") {
        sink.error(this.detail || "not connected");
        return () => {
        };
      }
      void this.whenOpen().then(() => {
        if (cancelled) return;
        this.fetches.set(id, sink);
        this.send({ t: "get", id, path, ...range ? { range } : {} });
      });
      return () => {
        cancelled = true;
        if (this.fetches.delete(id)) this.send({ t: "cancel", id });
      };
    }
    /** A whole response, for the page itself. */
    fetchAll(path) {
      return new Promise((resolve, reject) => {
        let status2 = 0;
        let headers = {};
        const parts = [];
        this.fetch(path, null, {
          head: (s, h) => {
            status2 = s;
            headers = h;
          },
          chunk: (b) => parts.push(b),
          end: () => {
            const body = new Uint8Array(
              parts.reduce((n, p) => n + p.length, 0)
            );
            let at = 0;
            for (const p of parts) {
              body.set(p, at);
              at += p.length;
            }
            resolve({ status: status2, headers, body });
          },
          error: (m) => reject(new Error(m))
        });
      });
    }
  };

  // src/ts/guest/boot.ts
  var STORE = "inkflow-online-link";
  function parentRelay() {
    try {
      if (window.parent !== window) return window.parent.__inkflowRelay;
    } catch {
    }
    return void 0;
  }
  function forwardRequests(channel) {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.onmessage = (ev) => {
      const msg = ev.data;
      const port = ev.ports[0];
      if (msg?.type !== "inkflow-fetch" || !port || !msg.path) return;
      const sink = {
        head: (status2, headers) => port.postMessage({ type: "head", status: status2, headers }),
        chunk: (bytes) => {
          const copy = bytes.slice().buffer;
          port.postMessage({ type: "chunk", data: copy }, [copy]);
        },
        end: () => port.postMessage({ type: "end" }),
        error: (message) => port.postMessage({ type: "error", message })
      };
      const cancel = channel.fetch(msg.path, msg.range ?? null, sink);
      port.onmessage = (m) => {
        if (m.data?.type === "cancel") cancel();
      };
    };
  }
  async function frameMode(relay2) {
    forwardRequests(relay2.channel);
    const path = location.pathname + location.search;
    let html;
    try {
      const res = await relay2.channel.fetchAll(path);
      html = new TextDecoder().decode(res.body);
    } catch (err) {
      document.body.textContent = `Could not load the page: ${String(err)}`;
      return;
    }
    document.open();
    document.write(html);
    document.close();
    forwardRequests(relay2.channel);
  }
  function linkFromFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get("r");
    const secret = params.get("k");
    if (!room || !secret || !isRoomId(room)) return null;
    return { room, secret };
  }
  function stored() {
    try {
      const raw = sessionStorage.getItem(STORE);
      const link = raw ? JSON.parse(raw) : null;
      if (link && isRoomId(link.room) && typeof link.secret === "string") {
        return link;
      }
    } catch {
    }
    return null;
  }
  function store(link) {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(link));
    } catch {
    }
  }
  var status = document.getElementById("status");
  var statusText = document.getElementById("status-text");
  function show(text, kind = "busy") {
    if (!status || !statusText) return;
    statusText.textContent = text;
    status.className = kind;
    status.hidden = false;
  }
  function hide() {
    if (status) status.hidden = true;
  }
  async function topMode() {
    const fromLink = linkFromFragment();
    const link = fromLink ?? stored();
    if (!link) {
      show(
        "This is a relay for sharing inkflow decks. Open the link the person sharing a deck sent you.",
        "end"
      );
      return;
    }
    store(link);
    const keep = fromLink ? "" : location.hash;
    history.replaceState(null, "", location.pathname + location.search + keep);
    if (!window.isSecureContext || !globalThis.crypto?.subtle) {
      show("This page needs a secure (https) address.", "end");
      return;
    }
    if (!("serviceWorker" in navigator)) {
      show(
        "This browser cannot show shared decks (no service workers; a private window may turn them off).",
        "end"
      );
      return;
    }
    show("Connecting\u2026");
    try {
      await navigator.serviceWorker.register("/_guest/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    } catch (err) {
      show(
        `This browser refused the page's service worker: ${String(err)}`,
        "end"
      );
      return;
    }
    const relayUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const channel = new Channel(
      { room: link.room, secret: unb64u(link.secret) },
      relayUrl
    );
    window.__inkflowRelay = { channel, openSocket: () => channel.openSocket() };
    forwardRequests(channel);
    let frame = null;
    channel.onstate = (state, detail) => {
      if (state === "open") {
        hide();
        if (!frame) frame = openFrame(channel, fromLink !== null, keep);
      } else if (state === "waiting") {
        show(detail, "wait");
      } else if (state === "ended") {
        show(
          `Disconnected: ${detail}. Ask the person sharing the deck for a new link.`,
          "end"
        );
      }
    };
    channel.start();
  }
  function openFrame(channel, byLink, hash) {
    const target = byLink ? channel.role === "editor" ? "/edit" : "/" : location.pathname + location.search;
    if (byLink) history.replaceState(null, "", target);
    const frame = document.createElement("iframe");
    frame.id = "page";
    frame.title = "Shared deck";
    frame.allow = "fullscreen; clipboard-read; clipboard-write; autoplay";
    frame.src = target + hash;
    document.body.append(frame);
    frame.addEventListener("load", () => frame.focus());
    window.setInterval(() => {
      try {
        const title = frame.contentDocument?.title;
        if (title && title !== document.title) document.title = title;
      } catch {
      }
    }, 1e3);
    window.addEventListener("focus", () => frame.focus());
    return frame;
  }
  var relay = parentRelay();
  if (relay) void frameMode(relay);
  else void topMode();
})();
