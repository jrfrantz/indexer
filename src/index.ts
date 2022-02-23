import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import "@/common/tracer";
import "@/jobs/index";

import { start } from "@/api/index";
import { logger } from "@/common/logger";
import { db } from "./common/db";
import * as Sdk from "@reservoir0x/sdk";
import { config } from "./config";
import * as wyvernV23Utils from "@/orders/wyvern-v2.3/utils";
import { addToOrdersUpdateByHashQueue } from "./jobs/orders-update";
import { ethers } from "ethers";

process.on("unhandledRejection", (error) => {
  logger.error("process", `Unhandled rejection: ${error}`);
  process.exit(1);
});

const foo = async () => {
  if (!config.master) {
    return;
  }

  const baseProvider = new ethers.providers.StaticJsonRpcProvider(
    "https://eth-mainnet.alchemyapi.io/v2/RJMrxQtPNhwO3CIZsJy4K-JGgi8Ag6Xg"
  );
  const orders = await db.manyOrNone(
    `select raw_data from orders where kind = 'wyvern-v2.3' and (status = 'valid' or status = 'no-balance') and side = 'sell'`
  );
  for (let i = 0; i < orders.length; i++) {
    console.log(i);
    const order = new Sdk.WyvernV23.Order(
      config.chainId,
      orders[i].raw_data as any
    );
    const proxy = await wyvernV23Utils.getProxy(order.params.maker);
    if (!proxy) {
      continue;
    }
    const info = order.getInfo();
    if (!info) {
      continue;
    }
    if (order.params.kind?.startsWith("erc721")) {
      const contract = new Sdk.Common.Helpers.Erc721(
        baseProvider,
        info.contract
      );
      if (
        !(await contract
          .isApproved(order.params.maker, proxy)
          .catch(() => false))
      ) {
        const hash = order.prefixHash();
        console.log(`updating ${hash}`);
        await db.none(
          `update orders set approved = false where hash = $/hash/`,
          { hash }
        );
        await addToOrdersUpdateByHashQueue([
          {
            context: `revalidation-${hash}`,
            hash,
          },
        ]);
      }
    } else if (order.params.kind?.startsWith("erc1155")) {
      const contract = new Sdk.Common.Helpers.Erc1155(
        baseProvider,
        info.contract
      );
      if (
        !(await contract
          .isApproved(order.params.maker, proxy)
          .catch(() => false))
      ) {
        const hash = order.prefixHash();
        console.log(`updating ${hash}`);
        await db.none(
          `update orders set approved = false where hash = $/hash/`,
          { hash }
        );
        await addToOrdersUpdateByHashQueue([
          {
            context: `revalidation-${hash}`,
            hash,
          },
        ]);
      }
    }
  }
  console.log("done");
};
foo();

start();
