import { db, pgp } from "@/common/db";
import { BaseParams } from "@/events/parser";

type OrderKind = "wyvern-v2.3";

export type BulkCancelEvent = {
  maker: string;
  minNonce: string;
  baseParams: BaseParams;
};

export const addBulkCancelEvents = async (
  orderKind: OrderKind,
  events: BulkCancelEvent[]
) => {
  const values: any[] = [];
  for (const e of events) {
    values.push({
      maker: e.maker,
      min_nonce: e.minNonce,
      address: e.baseParams.address,
      block: e.baseParams.block,
      block_hash: e.baseParams.blockHash,
      tx_hash: e.baseParams.txHash,
      log_index: e.baseParams.logIndex,
    });
  }

  let query: string | undefined;
  if (values) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "maker",
        "min_nonce",
        "address",
        "block",
        "block_hash",
        "tx_hash",
        "log_index",
      ],
      { table: "bulk_cancel_events" }
    );

    if (values.length) {
      // Atomically insert the cancel events and update order status
      query = `
        with "x" as (
          insert into "bulk_cancel_events" (
            "maker",
            "min_nonce",
            "address",
            "block",
            "block_hash",
            "tx_hash",
            "log_index"
          ) values ${pgp.helpers.values(values, columns)}
          on conflict do nothing
          returning "min_nonce"
        )
        update "orders" set "status" = 'cancelled' from "x"
        where "kind" = '${orderKind}'
          and "maker" = "x"."maker"
          and "nonce" < "x"."min_nonce"
          and ("status" = 'valid' or "status" = 'no-balance')
        returning "hash"
      `;
    }
  }

  if (query) {
    return db.manyOrNone(query);
  }

  return [];
};
