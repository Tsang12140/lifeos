import { once } from "node:events";
import type { Server } from "node:net";

// Ports the Fetch standard marks as "bad": undici refuses them before it even
// connects, so a test that fetches its own fixture fails with `bad port`.
// Windows can hand one of these out for listen(0) when its dynamic range starts
// low, so keep the OS allocator (parallel tests stay collision-safe) but close
// and retry whenever it picked one of them.
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** Binds an ephemeral port the built-in fetch is allowed to talk to. */
export async function listenOnFetchablePort(server: Server, host = "127.0.0.1"): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    server.listen(0, host);
    await once(server, "listening");
    const address = server.address();
    if (address !== null && typeof address !== "string" && !FETCH_FORBIDDEN_PORTS.has(address.port)) return address.port;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("error", onError);
        server.off("close", onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      server.once("error", onError);
      server.once("close", onClose);
      server.close();
    });
  }
  throw new Error("test server could not obtain a fetchable port after retries");
}
