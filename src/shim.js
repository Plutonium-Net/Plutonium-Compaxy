// The runtime shim injected into every proxied HTML document.
//
// This source is owned and emitted by the server (never shipped as a static
// frontend asset). It exists because a pure server-side URL rewrite cannot see
// URLs that page JavaScript builds at runtime: fetch/XHR/WebSocket targets,
// dynamically created image/script/iframe sources, history state and
// window.open. The shim maps those back onto the same /proxy/ scheme so the
// browser keeps talking only to this origin.

export function buildShim(pageUrl) {
  return `(() => {
  if (window.__plutoniumShim) return;
  window.__plutoniumShim = true;
  const BASE = ${JSON.stringify(pageUrl)};
  const PROXY = "/proxy/";
  const SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|filesystem:|#)/i;

  function enc(url) {
    return PROXY + url.protocol.slice(0, -1) + "/" + url.host + url.pathname + url.search;
  }

  function toProxy(input, protocols) {
    if (typeof input !== "string" && !(input instanceof URL)) return input;
    const value = input instanceof URL ? input.href : input;
    if (!value || SKIP.test(value) || value.startsWith(PROXY)) return input;
    try {
      const abs = new URL(value, BASE);
      // Already on our own origin (e.g. a page handing us location.href back):
      // leave it alone so it is never proxied twice.
      if (abs.origin === location.origin) return input;
      if (protocols && !protocols.includes(abs.protocol)) return input;
      if (!["http:", "https:", "ws:", "wss:"].includes(abs.protocol)) return input;
      return enc(abs);
    } catch {
      return input;
    }
  }

  // A page that targets _top/_parent would navigate the browser tab the host
  // page lives in, so those targets are collapsed to _self.
  function remapTarget(value) {
    const lower = String(value ?? "").trim().toLowerCase();
    return lower === "_top" || lower === "_parent" ? "_self" : value;
  }

  function mapSrcset(value) {
    const out = [];
    const input = String(value);
    let i = 0;
    while (i < input.length) {
      while (i < input.length && (input[i] === "," || /\\s/.test(input[i]))) i++;
      if (i >= input.length) break;
      const start = i;
      while (i < input.length && !/\\s/.test(input[i])) i++;
      let url = input.slice(start, i);
      while (url.endsWith(",")) url = url.slice(0, -1);
      const descriptorStart = i;
      while (i < input.length && input[i] !== ",") i++;
      const descriptor = input.slice(descriptorStart, i).trim();
      if (i < input.length && input[i] === ",") i++;
      if (!url) continue;
      out.push(toProxy(url, ["http:", "https:"]) + (descriptor ? " " + descriptor : ""));
    }
    return out.join(", ");
  }

  // --- fetch ---------------------------------------------------------------
  // Chromium refuses a request whose body is a ReadableStream (unknown length)
  // over HTTP/1.1 and fails it with net::ERR_H2_OR_QUIC_REQUIRED before it ever
  // reaches the server. This proxy speaks cleartext HTTP/1.1, so forwarded
  // bodies are buffered to give them a known length. YouTube's SABR media
  // uploads (POST + binary body) depend on this.
  function bufferBody(stream) {
    return new Response(stream).arrayBuffer();
  }

  function initFromRequest(request) {
    const init = {
      method: request.method,
      headers: request.headers,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      signal: request.signal
    };
    if (request.mode && request.mode !== "navigate") init.mode = request.mode;
    return init;
  }

  function sendBuffered(fetchFn, thisArg, url, init, stream) {
    if (!stream) return fetchFn.call(thisArg, url, init);
    return bufferBody(stream).then(
      (buffer) => {
        init.body = buffer;
        delete init.duplex;
        return fetchFn.call(thisArg, url, init);
      },
      () => {
        delete init.body;
        delete init.duplex;
        return fetchFn.call(thisArg, url, init);
      }
    );
  }

  const nativeFetch = window.fetch;
  const isStream = (value) =>
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          const mapped = toProxy(input, ["http:", "https:"]);
          if (mapped !== input && isStream(init && init.body)) {
            const copy = Object.assign({}, init);
            return sendBuffered(nativeFetch, this, mapped, copy, copy.body);
          }
          input = mapped;
        } else if (typeof Request !== "undefined" && input instanceof Request) {
          const mapped = toProxy(input.url, ["http:", "https:"]);
          if (mapped !== input.url) {
            const stream =
              input.method !== "GET" && input.method !== "HEAD" ? input.body : null;
            return sendBuffered(nativeFetch, this, mapped, initFromRequest(input), stream);
          }
        }
      } catch {}
      return nativeFetch.call(this, input, init);
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      url = toProxy(url, ["http:", "https:"]);
    } catch {}
    return open.call(this, method, url, ...rest);
  };

  // --- WebSocket -----------------------------------------------------------
  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    function ProxiedWebSocket(url, protocols) {
      let mapped = url;
      try {
        const raw = String(url);
        if (raw.startsWith(PROXY) || raw.includes(location.host + PROXY)) {
          return protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
        }
        const abs = new URL(raw, BASE);
        mapped =
          (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          PROXY +
          (abs.protocol === "wss:" ? "wss" : "ws") +
          "/" +
          abs.host +
          abs.pathname +
          abs.search;
      } catch {}
      return protocols === undefined
        ? new NativeWebSocket(mapped)
        : new NativeWebSocket(mapped, protocols);
    }
    ProxiedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      ProxiedWebSocket[key] = NativeWebSocket[key];
    }
    window.WebSocket = ProxiedWebSocket;
  }

  // --- EventSource ---------------------------------------------------------
  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = function (url, config) {
      return new NativeEventSource(toProxy(url, ["http:", "https:"]), config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  // --- Workers -------------------------------------------------------------
  for (const name of ["Worker", "SharedWorker"]) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = function (url, options) {
      return new Native(toProxy(url, ["http:", "https:"]), options);
    };
    window[name].prototype = Native.prototype;
  }

  // --- sendBeacon / window.open -------------------------------------------
  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) =>
      nativeBeacon(toProxy(url, ["http:", "https:"]), data);
  }
  const nativeOpen = window.open;
  window.open = function (url, target, ...rest) {
    return nativeOpen.call(
      this,
      toProxy(url, ["http:", "https:"]),
      target === undefined ? target : remapTarget(target),
      ...rest
    );
  };

  // --- history -------------------------------------------------------------
  // A page pushing a real path ("/settings") must land on the proxy path that
  // stands for it, or the next reload would ask us for a page we do not have.
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  const wrapState = (fn) =>
    function (state, title, url) {
      const mapped = url == null ? url : toProxy(url, ["http:", "https:"]);
      return fn(state, title, mapped);
    };
  history.pushState = wrapState(pushState);
  history.replaceState = wrapState(replaceState);

  // --- reflected URL attributes -------------------------------------------
  const URL_ATTRS = new Set([
    "src", "href", "action", "poster", "formaction", "data", "srcset", "imagesrcset"
  ]);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      const lower = String(name).toLowerCase();
      if (URL_ATTRS.has(lower) && typeof value === "string") {
        value = lower.includes("srcset")
          ? mapSrcset(value)
          : toProxy(value, ["http:", "https:"]);
      } else if (lower === "target" && typeof value === "string") {
        value = remapTarget(value);
      }
    } catch {}
    return nativeSetAttribute.call(this, name, value);
  };

  const TARGET_PROPS = [
    [HTMLAnchorElement, "target"],
    [HTMLAreaElement, "target"],
    [HTMLFormElement, "target"],
    [HTMLBaseElement, "target"]
  ];
  for (const [proto, prop] of TARGET_PROPS) {
    if (!proto) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto.prototype, prop);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(proto.prototype, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        descriptor.set.call(this, remapTarget(value));
      }
    });
  }

  const PROPS = [
    [HTMLImageElement, "src"],
    [HTMLScriptElement, "src"],
    [HTMLLinkElement, "href"],
    [HTMLIFrameElement, "src"],
    [HTMLMediaElement, "src"],
    [HTMLSourceElement, "src"],
    [HTMLVideoElement, "poster"],
    [HTMLObjectElement, "data"],
    [HTMLEmbedElement, "src"],
    [HTMLFormElement, "action"],
    [HTMLAnchorElement, "href"],
    [HTMLAreaElement, "href"]
  ];
  for (const [proto, prop] of PROPS) {
    if (!proto) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto.prototype, prop);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(proto.prototype, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        let mapped = value;
        try {
          mapped = toProxy(value, ["http:", "https:"]);
        } catch {}
        descriptor.set.call(this, mapped);
      }
    });
  }

  const SRCSET_PROPS = [
    [HTMLImageElement, "srcset"],
    [HTMLImageElement, "imageSrcset"],
    [HTMLLinkElement, "imageSrcset"]
  ];
  for (const [proto, prop] of SRCSET_PROPS) {
    if (!proto) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto.prototype, prop);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(proto.prototype, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        descriptor.set.call(this, mapSrcset(value));
      }
    });
  }

  // --- storage scoping -----------------------------------------------------
  // localStorage/sessionStorage are per-origin; namespace keys by target origin
  // so two proxied sites cannot collide.
  const originKey = (() => {
    try {
      return new URL(BASE).origin + "::";
    } catch {
      return "proxied::";
    }
  })();
  try {
    for (const kind of ["localStorage", "sessionStorage"]) {
      const store = window[kind];
      if (!store) continue;
      const proto = Object.getPrototypeOf(store);
      const nativeGet = proto.getItem;
      const nativeSet = proto.setItem;
      const nativeRemove = proto.removeItem;
      proto.getItem = function (key) {
        return nativeGet.call(this, originKey + key);
      };
      proto.setItem = function (key, value) {
        return nativeSet.call(this, originKey + key, value);
      };
      proto.removeItem = function (key) {
        return nativeRemove.call(this, originKey + key);
      };
    }
  } catch {}

  // --- service workers -----------------------------------------------------
  // Service workers cannot be scoped per proxied origin and would intercept
  // our whole proxy namespace, so registration is refused instead.
  if (navigator.serviceWorker) {
    try {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        get: () => ({
          register: () => Promise.reject(new Error("service workers are disabled")),
          getRegistration: () => Promise.resolve(undefined),
          getRegistrations: () => Promise.resolve([]),
          addEventListener() {},
          removeEventListener() {}
        })
      });
    } catch {}
  }
})();`;
}
