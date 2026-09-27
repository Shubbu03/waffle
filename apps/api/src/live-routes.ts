import type { ServerWebSocket } from "bun";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { apiError } from "./errors.ts";
import type { LiveDelivery } from "./live-delivery.ts";
import type { AppEnv } from "./types.ts";

/** Register before header-mutating middleware: Bun owns the upgraded response. */
export function mountLiveRoute(app: Hono<AppEnv>, live?: LiveDelivery) {
  app.get("/live", async (c, next) => {
    if (new URL(c.req.url).search)
      return apiError(c, 400, "VALIDATION_ERROR", "Live credentials belong in an auth frame");
    if (!live) return apiError(c, 503, "SERVICE_UNAVAILABLE", "Live delivery is not configured");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426);
    const response = await upgradeWebSocket(() => {
      let connection: ReturnType<LiveDelivery["connect"]>;
      return {
        onOpen(_event, socket) {
          const raw = socket.raw as ServerWebSocket<unknown>;
          connection = live.connect(
            {
              send(frame) {
                return raw.send(JSON.stringify(frame)) > 0;
              },
              close(code, reason) {
                socket.close(code, reason);
              },
            },
            c.env?.remoteAddress ?? "unknown",
          );
        },
        onMessage(event) {
          void connection?.receive(event.data);
        },
        onClose() {
          connection?.close();
        },
        onError() {
          connection?.close();
        },
      };
    })(c, next);
    return response ?? c.body(null, 400);
  });
}
