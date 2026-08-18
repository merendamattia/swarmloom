import { Cron } from "croner";
import type { Config } from "../core/config-schema.ts";
import { logger } from "../core/logger.ts";

type Scanner = { run(source: "SCHEDULED" | "MANUAL"): Promise<unknown> };

export function startScheduler(config: Config, scanner: Scanner) {
  let cron = createCron();

  function createCron() {
    return new Cron(config.SCHEDULE_CRON, {
      timezone: config.SCHEDULE_TIMEZONE,
      protect: true,
    }, async () => {
      try {
        await scanner.run("SCHEDULED");
      } catch (error) {
        logger.error("Scheduled scan failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  return {
    stop: () => cron.stop(),
    restart: () => {
      cron.stop();
      cron = createCron();
    },
  };
}
