import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const here = path.dirname(scriptPath);
const defaultThemeDir = path.join(here, "tools", "theme");
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_CDP_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const ALLOWED_FILES = new Map([
  ["background.png", "image/png"],
  ["codex_startup_animation.webm", "video/webm"],
]);

function parseArgs(argv) {
  const options = {
    port: 9222,
    themeDir: defaultThemeDir,
    once: false,
    intervalMs: 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--theme-dir") options.themeDir = path.resolve(argv[++index]);
    else if (arg === "--once") options.once = true;
    else if (arg === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node windows/codex-video-theme.mjs [--port 9222] [--theme-dir DIR] [--once]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid CDP port: ${options.port}`);
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 250 || options.intervalMs > 10000) {
    throw new Error(`Invalid polling interval: ${options.intervalMs}`);
  }
  return options;
}

function assertSafeChild(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return;
  }
  throw new Error(`${label} must remain inside the theme directory`);
}

async function loadTheme(themeDir) {
  const root = await fs.realpath(themeDir);
  const configPath = path.join(root, "theme.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (config.schemaVersion !== 1 || typeof config.image !== "string") {
    throw new Error("theme.json must use schemaVersion 1 and contain an image field");
  }
  if (path.basename(config.image) !== config.image || !ALLOWED_FILES.has(config.image)) {
    throw new Error("theme.json image must be the local background.png asset");
  }
  const imagePath = path.join(root, config.image);
  const videoName = "codex_startup_animation.webm";
  const videoPath = path.join(root, videoName);
  assertSafeChild(root, imagePath, "Theme image");
  assertSafeChild(root, videoPath, "Theme video");
  await Promise.all([fs.access(imagePath), fs.access(videoPath)]);
  return { root, imagePath, videoPath, config };
}

function validatedPageWebSocketUrl(target, port) {
  if (!target?.webSocketDebuggerUrl || target.type !== "page" || !target.url?.startsWith("app://")) {
    throw new Error("Target is not a verified Codex app page");
  }
  if (typeof target.id !== "string" || !ID_PATTERN.test(target.id)) {
    throw new Error("Target id is invalid");
  }
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== "ws:" || !LOOPBACK_CDP_HOSTS.has(url.hostname) || Number(url.port) !== port) {
    throw new Error("Rejected a CDP endpoint outside the local loopback port");
  }
  if (url.pathname !== `/devtools/page/${target.id}` || url.username || url.password || url.search || url.hash) {
    throw new Error("Rejected an unexpected CDP page endpoint");
  }
  return url.href;
}

class CdpPage {
  constructor(target, port) {
    if (typeof WebSocket !== "function") {
      throw new Error("This adapter needs Node.js 22 or newer so it can use the built-in WebSocket client");
    }
    this.socket = new WebSocket(validatedPageWebSocketUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.#onMessage(event));
    this.socket.addEventListener("close", () => this.close());
    return this;
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.close();
      return;
    }
    if (!message?.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
    else pending.resolve(message.result);
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error("CDP connection is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed");
    }
    return result?.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    try { this.socket.close(); } catch {}
  }
}

async function listTargets(port) {
  let response;
  try {
    response = await fetch(`http://${LOOPBACK_HOST}:${port}/json/list`, { redirect: "error" });
  } catch {
    throw new Error(`无法连接 127.0.0.1:${port}。请用 --remote-debugging-port=${port} 启动 Codex。`);
  }
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}

async function isCodexPage(page) {
  const probe = await page.evaluate(`(() => {
    const root = Boolean(document.querySelector('#root, #app'));
    const body = Boolean(document.body);
    return { root, body, title: document.title, url: location.href };
  })()`);
  return Boolean(probe?.root && probe?.body);
}

function makeInjectionExpression(urls) {
  const config = JSON.stringify(urls);
  return `(() => {
    const config = ${config};
    const STYLE_ID = "codex-windows-video-theme-style";
    const BACKGROUND_ID = "codex-windows-video-background";
    const OVERLAY_ID = "codex-windows-startup-video";
    const STATE_KEY = "__CODEX_WINDOWS_VIDEO_THEME_STATE__";
    const ASSET_TOKEN_KEY = "__CODEX_WINDOWS_VIDEO_ASSET_TOKEN__";
    const IMAGE_URL_KEY = "__CODEX_WINDOWS_VIDEO_IMAGE_URL__";
    const VIDEO_URL_KEY = "__CODEX_WINDOWS_VIDEO_VIDEO_URL__";
    const root = document.documentElement;
    if (!root) return { applied: false, reason: "document root is not ready" };
    const dataUrlToBlobUrl = (dataUrl) => {
      const comma = dataUrl.indexOf(",");
      const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "application/octet-stream";
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    };
    if (config.assetToken && window[ASSET_TOKEN_KEY] !== config.assetToken
      && config.imageDataUrl && config.videoDataUrl) {
      if (window[IMAGE_URL_KEY]) URL.revokeObjectURL(window[IMAGE_URL_KEY]);
      if (window[VIDEO_URL_KEY]) URL.revokeObjectURL(window[VIDEO_URL_KEY]);
      window[IMAGE_URL_KEY] = dataUrlToBlobUrl(config.imageDataUrl);
      window[VIDEO_URL_KEY] = dataUrlToBlobUrl(config.videoDataUrl);
      window[ASSET_TOKEN_KEY] = config.assetToken;
    }
    const imageUrl = window[IMAGE_URL_KEY] || config.imageUrl;
    const videoUrl = window[VIDEO_URL_KEY] || config.videoUrl;
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || root).appendChild(style);
    }
    const styleText = \`
      html.codex-windows-video-theme,
      html.codex-windows-video-theme body {
        background-color: #f4f0eb !important;
        background-image: url("\${imageUrl}") !important;
        background-position: center center !important;
        background-repeat: no-repeat !important;
        background-size: cover !important;
        background-attachment: scroll !important;
        overflow-x: hidden !important;
      }
      html.codex-windows-video-theme #root,
      html.codex-windows-video-theme main,
      html.codex-windows-video-theme aside {
        background-color: rgba(255, 255, 255, .72) !important;
      }
      html.codex-windows-video-theme #root {
        position: relative !important;
        z-index: 1 !important;
      }
      html.codex-windows-video-theme #\${BACKGROUND_ID} {
        position: fixed;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-position: center center;
        background-repeat: no-repeat;
        background-size: cover;
      }
      html.codex-windows-video-theme #\${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: grid;
        place-items: center;
        overflow: hidden;
        contain: strict;
        isolation: isolate;
        background: rgba(23, 22, 28, .38);
        opacity: 1;
        pointer-events: none;
        transition: opacity 650ms ease;
      }
      html.codex-windows-video-theme #\${OVERLAY_ID} .codex-windows-video-backdrop {
        position: absolute;
        inset: -10%;
        z-index: 0;
        width: 120%;
        height: 120%;
        background-color: #f4f0eb;
        background-position: center center;
        background-repeat: no-repeat;
        background-size: cover;
        filter: saturate(108%) brightness(72%);
        opacity: .88;
        transform: translateZ(0) scale(1.06);
        backface-visibility: hidden;
      }
      html.codex-windows-video-theme #\${OVERLAY_ID}::before {
        content: '';
        position: absolute;
        inset: -20%;
        z-index: 2;
        pointer-events: none;
        background:
          radial-gradient(circle at 50% 44%, rgba(255,255,255,.30), transparent 34%),
          radial-gradient(circle at 50% 50%, transparent 0 48%, rgba(30,22,28,.22) 100%);
        animation: codex-windows-ambient-pulse 2.4s ease-in-out infinite alternate;
      }
      html.codex-windows-video-theme #\${OVERLAY_ID}::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
        background: linear-gradient(112deg, transparent 0%, transparent 42%, rgba(255,255,255,.30) 50%, transparent 58%, transparent 100%);
        transform: translateX(-115%);
        animation: codex-windows-light-sweep 2.7s cubic-bezier(.2,.7,.2,1) .25s 1 both;
      }
      html.codex-windows-video-theme #\${OVERLAY_ID} .codex-windows-video-foreground {
        position: relative;
        z-index: 1;
        display: block;
        width: 100vw;
        height: 100vh;
        object-fit: contain;
        border-radius: 0;
        box-shadow: none;
        transform: translateZ(0);
        backface-visibility: hidden;
        filter: drop-shadow(0 0 12px rgba(255,255,255,.16));
        animation: codex-windows-ink-glow 1.8s ease-out .15s 1 both;
      }
      @keyframes codex-windows-ambient-pulse {
        from { opacity: .72; transform: scale(1); }
        to { opacity: 1; transform: scale(1.035); }
      }
      @keyframes codex-windows-light-sweep {
        from { transform: translateX(-115%); opacity: 0; }
        18% { opacity: .72; }
        to { transform: translateX(115%); opacity: 0; }
      }
      @keyframes codex-windows-ink-glow {
        from { filter: drop-shadow(0 0 2px rgba(255,255,255,.04)); }
        45% { filter: drop-shadow(0 0 16px rgba(255,255,255,.26)); }
        to { filter: drop-shadow(0 0 8px rgba(255,255,255,.12)); }
      }
      @media (prefers-reduced-motion: reduce) {
        html.codex-windows-video-theme #\${OVERLAY_ID}::before,
        html.codex-windows-video-theme #\${OVERLAY_ID}::after,
        html.codex-windows-video-theme #\${OVERLAY_ID} .codex-windows-video-foreground {
          animation: none !important;
        }
      }
      html.codex-windows-video-theme #\${OVERLAY_ID}[data-done="true"] {
        opacity: 0;
      }
    \`;
    if (style.textContent !== styleText) style.textContent = styleText;
    root.classList.add("codex-windows-video-theme");
    const state = window[STATE_KEY] || (window[STATE_KEY] = { startupShown: false });
    if (!document.body) return { applied: true, overlay: false };
    let background = document.getElementById(BACKGROUND_ID);
    if (!background) {
      background = document.createElement("div");
      background.id = BACKGROUND_ID;
      background.setAttribute("aria-hidden", "true");
      document.body.prepend(background);
    }
    const backgroundImage = 'url(' + imageUrl + ')';
    if (background.style.backgroundImage !== backgroundImage) {
      background.style.backgroundImage = backgroundImage;
    }
    const shouldShowStartup = !state.startupShown || state.startupAssetToken !== config.assetToken;
    if (shouldShowStartup && !document.getElementById(OVERLAY_ID)) {
      state.startupShown = true;
      state.startupAssetToken = config.assetToken;
      const overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("aria-hidden", "true");
      const backdrop = document.createElement("div");
      backdrop.className = "codex-windows-video-backdrop";
      backdrop.style.backgroundImage = "url(" + imageUrl + ")";
      backdrop.setAttribute("aria-hidden", "true");
      const video = document.createElement("video");
      video.className = "codex-windows-video-foreground";
      video.src = videoUrl;
      video.autoplay = true;
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.setAttribute("aria-hidden", "true");
      const finish = () => {
        overlay.dataset.done = "true";
        video.pause();
        setTimeout(() => overlay.remove(), 720);
      };
      video.addEventListener("ended", finish, { once: true });
      video.addEventListener("error", () => overlay.remove(), { once: true });
      overlay.append(backdrop, video);
      document.body.appendChild(overlay);
      video.play().catch(() => {});
    }
    return { applied: true, overlay: Boolean(document.getElementById(OVERLAY_ID)), url: location.href };
  })()`;
}

function makeCleanupExpression() {
  return `(() => {
    const STYLE_ID = "codex-windows-video-theme-style";
    const BACKGROUND_ID = "codex-windows-video-background";
    const OVERLAY_ID = "codex-windows-startup-video";
    const STATE_KEY = "__CODEX_WINDOWS_VIDEO_THEME_STATE__";
    const IMAGE_URL_KEY = "__CODEX_WINDOWS_VIDEO_IMAGE_URL__";
    const VIDEO_URL_KEY = "__CODEX_WINDOWS_VIDEO_VIDEO_URL__";
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(BACKGROUND_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement?.classList.remove("codex-windows-video-theme");
    if (window[IMAGE_URL_KEY]) URL.revokeObjectURL(window[IMAGE_URL_KEY]);
    if (window[VIDEO_URL_KEY]) URL.revokeObjectURL(window[VIDEO_URL_KEY]);
    delete window[IMAGE_URL_KEY];
    delete window[VIDEO_URL_KEY];
    delete window[STATE_KEY];
    return { cleaned: true };
  })()`;
}

async function findCodexPage(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "the main renderer is still loading";
  while (Date.now() < deadline) {
    try {
      const targets = (await listTargets(port))
        .filter((target) => target.type === "page" && target.url?.startsWith("app://"))
        .filter((target) => !target.url.includes("detached-window") && !target.url.includes("avatar-overlay"))
        .sort((left, right) => {
          const score = (target) => target.url === "app://-/index.html" ? 2 : target.title === "ChatGPT" ? 1 : 0;
          return score(right) - score(left);
        });
      for (const target of targets) {
        let page;
        try {
          page = await new CdpPage(target, port).open();
          if (await isCodexPage(page)) return { page, target };
          lastError = "the main Codex DOM is not ready yet";
        } catch (error) {
          lastError = error.message;
        }
        page?.close();
      }
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`No verified Codex page was found: ${lastError}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const theme = await loadTheme(options.themeDir);
  const [imageBytes, videoBytes] = await Promise.all([
    fs.readFile(theme.imagePath),
    fs.readFile(theme.videoPath),
  ]);
  const urls = {
    imageUrl: "",
    videoUrl: "",
    imageDataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    videoDataUrl: `data:video/webm;base64,${videoBytes.toString("base64")}`,
    assetToken: `${process.pid}-${Date.now()}`,
  };
  const connection = await findCodexPage(options.port);
  console.log(`[codex-windows] verified target: ${connection.target.id}`);
  let inlineAssetsPending = true;
  let reportedApply = false;
  const apply = async () => {
      if (connection.page.closed) return false;
      try {
        const payload = inlineAssetsPending ? urls : {
          ...urls,
          imageDataUrl: null,
          videoDataUrl: null,
        };
        const result = await connection.page.evaluate(makeInjectionExpression(payload));
        if (result?.applied) inlineAssetsPending = false;
        if (result?.applied && !reportedApply) {
          console.log(`[codex-windows] theme applied (${new Date().toLocaleTimeString()})`);
          reportedApply = true;
        }
        return Boolean(result?.applied);
      } catch (error) {
        console.error(`[codex-windows] renderer refresh failed: ${error.message}`);
        return false;
      }
  };
  await apply();
  if (!options.once) {
    const timer = setInterval(apply, options.intervalMs);
    let resolveStop;
    const stopped = new Promise((resolve) => { resolveStop = resolve; });
    const stop = () => {
      clearInterval(timer);
      connection.page.evaluate(makeCleanupExpression()).catch(() => {}).finally(() => {
        connection.page.close();
        resolveStop();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await stopped;
  }
  connection.page.close();
}

try {
  await main();
} catch (error) {
  console.error(`[codex-windows] ${error.stack || error.message}`);
  process.exitCode = 1;
}
