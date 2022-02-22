import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";

import { db } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { config } from "@/config/index";

export const getProxy = async (owner: string): Promise<string | undefined> => {
  try {
    let proxy = await db
      .oneOrNone(
        `
          select "wp"."proxy" from "wyvern_proxies" "wp"
          where "wp"."owner" = $/owner/
        `,
        { owner }
      )
      .then((r) => r?.proxy);

    if (!proxy) {
      proxy = await new Sdk.WyvernV23.Helpers.ProxyRegistry(
        baseProvider,
        config.chainId
      )
        .getProxy(owner)
        .then((p) => p.toLowerCase());

      if (proxy === AddressZero) {
        return undefined;
      }

      await db.none(
        `
          insert into "wyvern_proxies" ("owner", "proxy")
          values ($/owner/, $/proxy/)
        `,
        { owner, proxy }
      );
    }

    return proxy;
  } catch {
    return undefined;
  }
};
