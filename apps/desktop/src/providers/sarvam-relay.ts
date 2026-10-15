import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * Local WebSocket relay for Sarvam, hosted inside the Electron main process.
 * Sarvam requires an Api-Subscription-Key HTTP header that browser WebSockets
 * cannot set, so the renderer connects to 127.0.0.1:<port>/stt/sarvam and this
 * relay dials Sarvam upstream with the key injected. Frames are relayed
 * verbatim in both directions; the key never reaches the renderer.
 *
 * Started lazily (only when the Sarvam provider is actually used) on an
 * ephemeral port. Idempotent: repeated start calls return the same port.
 */

const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text-translate/ws";
const DEFAULT_MODEL = "saaras:v3";
const DEFAULT_MODE = "transcribe";
const SAMPLE_RATE = "16000";

export const SARVAM_RELAY_PATH = "/stt/sarvam";

let server: Server | null = null;
let port: number | null = null;

export class SarvamRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SarvamRelayError";
  }
}

/** Starts the relay if needed and resolves to its localhost port. */
export async function startSarvamRelay(): Promise<number> {
  if (!process.env.SARVAM_API_KEY?.trim()) {
    throw new SarvamRelayError(
      "The Sarvam key is missing. Click Keys and add it (needed only for Gujarati).",
    );
  }
  if (server && port !== null) {
    return port;
  }

  const httpServer = createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
    if (requestUrl.pathname !== SARVAM_RELAY_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, requestUrl));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // Port 0 = OS-assigned ephemeral port, bound to loopback only.
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new SarvamRelayError("Sarvam relay failed to bind a localhost port.");
  }

  server = httpServer;
  port = address.port;
  return port;
}

/** Stops the relay (no-op when not running). */
export function stopSarvamRelay(): void {
  server?.close();
  server = null;
  port = null;
}

function bridge(client: WebSocket, requestUrl: URL): void {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    client.close(1011, "SARVAM_API_KEY is not configured");
    return;
  }

  const upstream = new WebSocket(buildUpstreamUrl(requestUrl), {
    headers: { "Api-Subscription-Key": apiKey },
  });

  // Buffer client audio frames that arrive before the upstream socket is open.
  const pending: RawData[] = [];
  let upstreamOpen = false;

  client.on("message", (data) => {
    if (upstreamOpen) {
      upstream.send(data);
    } else {
      pending.push(data);
    }
  });
  client.on("close", (code, reason) => upstream.close(normalizeCloseCode(code), reason.toString()));
  client.on("error", () => upstream.close());

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const frame of pending.splice(0, pending.length)) {
      upstream.send(frame);
    }
  });
  upstream.on("message", (data) => client.send(data));
  upstream.on("close", (code, reason) => client.close(normalizeCloseCode(code), reason.toString()));
  upstream.on("error", () => client.close(1011, "Sarvam upstream error"));
}

function buildUpstreamUrl(requestUrl: URL): string {
  const url = new URL(SARVAM_WS_URL);
  url.searchParams.set("model", DEFAULT_MODEL);
  url.searchParams.set("mode", requestUrl.searchParams.get("mode") ?? DEFAULT_MODE);
  url.searchParams.set("sample_rate", SAMPLE_RATE);
  return url.toString();
}

/** Close codes 1005/1006 are reserved and cannot be sent; fall back to a normal close. */
function normalizeCloseCode(code: number): number {
  return code === 1005 || code === 1006 ? 1000 : code;
}
