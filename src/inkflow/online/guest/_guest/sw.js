"use strict";
(() => {
  // src/ts/guest/sw.ts
  var sw = self;
  sw.addEventListener("install", () => {
    void sw.skipWaiting();
  });
  sw.addEventListener(
    "activate",
    (ev) => {
      ev.waitUntil(sw.clients.claim());
    }
  );
  var NULL_BODY = /* @__PURE__ */ new Set([101, 103, 204, 205, 304]);
  function relayed(ev) {
    const url = new URL(ev.request.url);
    if (url.origin !== sw.location.origin) return false;
    if (url.pathname.startsWith("/_guest/")) return false;
    if (url.pathname.startsWith("/_relay/")) return false;
    if (ev.request.mode === "navigate") return false;
    return Boolean(ev.clientId);
  }
  sw.addEventListener("fetch", (ev) => {
    if (!relayed(ev)) return;
    ev.respondWith(answer(ev));
  });
  async function answer(ev) {
    const request = ev.request;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Not available through the relay", { status: 405 });
    }
    const client = await sw.clients.get(ev.clientId);
    if (!client) return fetch(request);
    const url = new URL(request.url);
    const channel = new MessageChannel();
    const port = channel.port1;
    client.postMessage(
      {
        type: "inkflow-fetch",
        path: url.pathname + url.search,
        range: request.headers.get("range")
      },
      [channel.port2]
    );
    return new Promise((resolve) => {
      let controller = null;
      let answered = false;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          port.postMessage({ type: "cancel" });
          port.close();
        }
      });
      const timer = setTimeout(() => {
        if (!answered) {
          answered = true;
          resolve(
            new Response("No answer from the host", { status: 504 })
          );
        }
      }, 6e4);
      port.onmessage = ({ data }) => {
        if (data.type === "head") {
          answered = true;
          clearTimeout(timer);
          const empty = request.method === "HEAD" || NULL_BODY.has(data.status);
          resolve(
            new Response(empty ? null : stream, {
              status: data.status,
              headers: data.headers
            })
          );
        } else if (data.type === "chunk") {
          controller?.enqueue(new Uint8Array(data.data));
        } else if (data.type === "end") {
          controller?.close();
          port.close();
        } else if (data.type === "error") {
          clearTimeout(timer);
          if (!answered) {
            answered = true;
            resolve(new Response(data.message, { status: 502 }));
          } else {
            controller?.error(new Error(data.message));
          }
          port.close();
        }
      };
    });
  }
})();
