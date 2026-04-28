#!/usr/bin/env node
import { startOpsDashboard, type StartedOpsDashboard } from "./server.js";

export { createOpsDashboardServer, startOpsDashboard } from "./server.js";
export type { OpsDashboardOptions, StartedOpsDashboard } from "./server.js";

let activeDashboard: StartedOpsDashboard | undefined;

if (import.meta.url === `file://${process.argv[1]}`) {
  startOpsDashboard().then((started) => {
    activeDashboard = started;
    const shutdown = (): void => {
      activeDashboard?.server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
