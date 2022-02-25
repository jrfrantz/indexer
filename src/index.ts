import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import "@/common/tracer";
import "@/jobs/index";

import { start } from "@/api/index";
import { logger } from "@/common/logger";
import { db } from "./common/db";
import { addToOrdersUpdateByHashQueue } from "./jobs/orders-update";

process.on("unhandledRejection", (error) => {
  logger.error("process", `Unhandled rejection: ${error}`);
  process.exit(1);
});

const foo = async () => {
  let done = false;
  let i = 0;
  while (!done) {
    console.log(i++);
    const results = await db.manyOrNone(
      `
        update "orders" as "o"
        set "status" = 'cancelled'
        from (
          select "hash" from "orders"
          where "kind" = 'wyvern-v2'
            and ("status" = 'valid' or "status" = 'no-balance')
          limit 100
        ) "x"
        where "o"."hash" = "x"."hash"
        returning "o"."hash"
      `
    );
    await addToOrdersUpdateByHashQueue(
      results.map(({ hash }) => ({ context: `cancelled-${hash}`, hash }))
    );

    if (results.length < 100) {
      done = true;
    }
  }
};
foo();

start();
