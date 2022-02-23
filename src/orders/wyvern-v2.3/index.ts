import * as Sdk from "@reservoir0x/sdk";

import { BuildOrderOptions, buildOrder } from "@/orders/wyvern-v2.3/build";
import { filterOrders } from "@/orders/wyvern-v2.3/filter";
import { saveOrders } from "@/orders/wyvern-v2.3/save";

export type OrderInfo = {
  order: Sdk.WyvernV23.Order;
  attribute?: {
    collection: string;
    key: string;
    value: string;
  };
  source?: string;
};

export { BuildOrderOptions, buildOrder, filterOrders, saveOrders };
