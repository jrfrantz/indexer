import { AddressZero } from "@ethersproject/constants";
import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { idb, pgp } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { fromBuffer, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as orderUpdatesById from "@/jobs/order-updates/by-id-queue";
import * as bundleOrderUpdatesByMaker from "@/jobs/order-updates/by-maker-bundle-queue";
import { TriggerKind } from "@/jobs/order-updates/types";
import { OrderKind } from "@/orderbook/orders";
import { fetchAndUpdateFtApproval } from "@/utils/on-chain-data";

const QUEUE_NAME = "order-updates-by-maker";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 10000,
    },
    removeOnComplete: 1000,
    removeOnFail: 10000,
    timeout: 60000,
  },
});
export let worker: Worker | undefined;

new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { context, maker, trigger, data } = job.data as MakerInfo;

      try {
        // TODO: Right now, it is assumed all results from the below queries
        // are small enough so that they can be retrieved in one go. This is
        // not going to hold for much longer so we should change the flow to
        // use keyset pagination (eg. get a batch of affected orders, handle
        // them, and then trigger the next batch). While sell side approvals
        // or balances will fit in a single batch in all cases, results from
        // the buy side can potentially span multiple batches (eg. checks on
        // the sell side will handle all of a maker's sell orders on exactly
        // a SINGLE TOKEN, while checks on the buy side will handle all of a
        // maker's buy orders on ALL TOKENS / TOKEN SETS - so buy side check
        // can potentially be more prone to not being able to handle all the
        // affected orders in a single batch).

        switch (data.kind) {
          // Handle changes in ERC20 balances (relevant for 'buy' orders)
          case "buy-balance": {
            // Get the old and new fillability statuses of the current maker's 'buy' orders
            const fillabilityStatuses = await idb.manyOrNone(
              `
                SELECT
                  orders.kind,
                  orders.id,
                  orders.fillability_status AS old_status,
                  (CASE
                    WHEN ft_balances.amount >= (orders.currency_price * orders.quantity_remaining) THEN 'fillable'
                    ELSE 'no-balance'
                  END)::order_fillability_status_t AS new_status,
                  (CASE
                    WHEN ft_balances.amount >= (orders.currency_price * orders.quantity_remaining) THEN nullif(upper(orders.valid_between), 'infinity')
                    ELSE to_timestamp($/timestamp/)
                  END)::timestamptz AS expiration
                FROM orders
                JOIN ft_balances
                  ON orders.maker = ft_balances.owner
                WHERE orders.maker = $/maker/
                  AND orders.side = 'buy'
                  AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
                  AND ft_balances.contract = $/contract/
              `,
              {
                maker: toBuffer(maker),
                contract: toBuffer(data.contract),
                timestamp: trigger.txTimestamp,
              }
            );

            // Filter any orders that didn't change status
            const values = fillabilityStatuses
              .filter(({ old_status, new_status }) => old_status !== new_status)
              // We mark X2Y2 orders as cancelled if the balance ever gets underwater
              // in order to be consistent with the way they handle things (see below
              // description on handling X2Y2 "sell-balance" changes)
              .map((data) =>
                data.kind === "x2y2" && data.new_status === "no-balance"
                  ? { ...data, new_status: "cancelled" }
                  : data
              )
              .map(({ id, new_status, expiration }) => ({
                id,
                fillability_status: new_status,
                expiration: expiration || "infinity",
              }));

            // Update any orders that did change status
            if (values.length) {
              const columns = new pgp.helpers.ColumnSet(
                ["id", "fillability_status", "expiration"],
                { table: "orders" }
              );

              await idb.none(
                `
                  UPDATE orders SET
                    fillability_status = x.fillability_status::order_fillability_status_t,
                    expiration = x.expiration::TIMESTAMPTZ,
                    updated_at = now()
                  FROM (VALUES ${pgp.helpers.values(
                    values,
                    columns
                  )}) AS x(id, fillability_status, expiration)
                  WHERE orders.id = x.id::TEXT
                `
              );
            }

            // Recheck all updated orders
            await orderUpdatesById.addToQueue(
              fillabilityStatuses.map(({ id }) => ({
                context: `${context}-${id}`,
                id,
                trigger,
              }))
            );

            break;
          }

          // Handle changes in ERC20 approvals (relevant for 'buy' orders)
          case "buy-approval": {
            if (data.operator) {
              // If `operator` is specified, then the approval change is coming from an `Approval` event

              // Fetch all 'buy' orders with `operator` as conduit
              const result = await idb.manyOrNone(
                `
                  SELECT
                    orders.id,
                    orders.price
                  FROM orders
                  WHERE orders.maker = $/maker/
                    AND orders.side = 'buy'
                    AND orders.conduit = $/conduit/
                    AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
                  LIMIT 1
                `,
                {
                  maker: toBuffer(maker),
                  conduit: toBuffer(data.operator),
                }
              );

              if (result.length) {
                // Refresh approval from on-chain data
                await fetchAndUpdateFtApproval(data.contract, maker, data.operator);

                // Validate or invalidate orders based on the just-updated approval
                const result = await idb.manyOrNone(
                  `
                    WITH
                      x AS (
                        SELECT
                          orders.id,
                          orders.price
                        FROM orders
                        WHERE orders.maker = $/maker/
                          AND orders.side = 'buy'
                          AND orders.conduit = $/conduit/
                          AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
                      ),
                      y AS (
                        SELECT
                          ft_approvals.value
                        FROM ft_approvals
                        WHERE ft_approvals.token = $/token/
                          AND ft_approvals.owner = $/maker/
                          AND ft_approvals.spender = $/conduit/
                      )
                    UPDATE orders SET
                      approval_status = (
                        CASE
                          WHEN orders.currency_price > y.value THEN 'no-approval'
                          ELSE 'approved'
                        END
                      )::order_approval_status_t,
                      expiration = (
                        CASE
                          WHEN orders.currency_price > y.value THEN to_timestamp($/timestamp/)
                          ELSE nullif(upper(orders.valid_between), 'infinity')
                        END
                      )::timestamptz,
                      updated_at = now()
                    FROM x
                    LEFT JOIN y ON TRUE
                    WHERE orders.id = x.id
                      AND orders.approval_status != (
                        CASE
                          WHEN orders.currency_price > y.value THEN 'no-approval'
                          ELSE 'approved'
                        END
                      )::order_approval_status_t
                    RETURNING
                      orders.kind,
                      orders.approval_status,
                      orders.expiration,
                      orders.id
                  `,
                  {
                    token: toBuffer(data.contract),
                    maker: toBuffer(maker),
                    conduit: toBuffer(data.operator!),
                    timestamp: trigger.txTimestamp,
                  }
                );

                const cancelledValues = result
                  .filter(
                    // When an approval gets revoked, X2Y2 will off-chain cancel all the
                    // orders from the same owner, so that if they ever re-approve, none
                    // of these orders will get reactivated (they are able to do that by
                    // having their backend refuse to sign on such orders).
                    ({ kind, approval_status }) =>
                      kind === "x2y2" && approval_status === "no-approval"
                  )
                  .map(({ id, expiration }) => ({
                    id,
                    fillability_status: "cancelled",
                    expiration: expiration || "infinity",
                  }));

                // Cancel any orders if needed
                if (cancelledValues.length) {
                  const columns = new pgp.helpers.ColumnSet(
                    ["id", "fillability_status", "expiration"],
                    {
                      table: "orders",
                    }
                  );

                  await idb.none(
                    `
                      UPDATE orders SET
                        fillability_status = x.fillability_status::order_fillability_status_t,
                        expiration = x.expiration::TIMESTAMPTZ,
                        updated_at = now()
                      FROM (VALUES ${pgp.helpers.values(
                        cancelledValues,
                        columns
                      )}) AS x(id, fillability_status, expiration)
                      WHERE orders.id = x.id::TEXT
                    `
                  );
                }

                // Recheck all affected orders
                await orderUpdatesById.addToQueue(
                  result.map(({ id }) => ({
                    context: `${context}-${id}`,
                    id,
                    trigger,
                  }))
                );
              }
            } else if (data.orderKind) {
              // Otherwise, the approval change is coming from a `Transfer` event

              // Fetch all different conduits for the given order kind
              const result = await idb.manyOrNone(
                `
                  SELECT DISTINCT
                    orders.conduit
                  FROM orders
                  WHERE orders.maker = $/maker/
                    AND orders.side = 'buy'
                    AND orders.kind = $/kind/
                    AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
                `,
                {
                  maker: toBuffer(maker),
                  kind: data.orderKind,
                }
              );

              // Trigger a new job to individually handle all maker's conduits
              await addToQueue(
                result
                  .filter(({ conduit }) => Boolean(conduit))
                  .map(({ conduit }) => {
                    conduit = fromBuffer(conduit);
                    return {
                      context: `${context}-${conduit}`,
                      maker,
                      trigger,
                      data: {
                        kind: "buy-approval",
                        contract: data.contract,
                        operator: conduit,
                      },
                    };
                  })
              );
            }

            break;
          }

          // Handle changes in ERC721/ERC1155 balances (relevant for 'sell' orders)
          case "sell-balance": {
            // Get the old and new fillability statuses of the affected orders (filter by maker + token)
            const fillabilityStatuses = await idb.manyOrNone(
              `
                SELECT
                  orders.kind,
                  orders.id,
                  orders.fillability_status AS old_status,
                  (CASE
                    WHEN nft_balances.amount >= orders.quantity_remaining THEN 'fillable'
                    ELSE 'no-balance'
                  END)::order_fillability_status_t AS new_status,
                  (CASE
                    WHEN nft_balances.amount >= orders.quantity_remaining THEN nullif(upper(orders.valid_between), 'infinity')
                    ELSE to_timestamp($/timestamp/)
                  END)::TIMESTAMPTZ AS expiration
                FROM orders
                JOIN nft_balances
                  ON orders.maker = nft_balances.owner
                JOIN token_sets_tokens
                  ON orders.token_set_id = token_sets_tokens.token_set_id
                  AND nft_balances.contract = token_sets_tokens.contract
                  AND nft_balances.token_id = token_sets_tokens.token_id
                WHERE orders.maker = $/maker/
                  AND orders.side = 'sell'
                  AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
                  AND nft_balances.contract = $/contract/
                  AND nft_balances.token_id = $/tokenId/
              `,
              {
                maker: toBuffer(maker),
                contract: toBuffer(data.contract),
                tokenId: data.tokenId,
                timestamp: trigger.txTimestamp,
              }
            );

            // Filter any orders that didn't change status
            const values = fillabilityStatuses
              .filter(({ old_status, new_status }) => old_status !== new_status)
              // Exclude escrowed orders
              .filter(({ kind }) => kind !== "foundation" && kind !== "cryptopunks")
              // When a token gets transferred, X2Y2 will off-chain cancel all the
              // orders from the initial owner, so that if they ever get the token
              // back in their wallet no order will get reactivated (they are able
              // to do that by having their backend refuse to sign on such orders).
              .map((data) =>
                data.kind === "x2y2" && data.new_status === "no-balance"
                  ? { ...data, new_status: "cancelled" }
                  : data
              )
              .map(({ id, new_status, expiration }) => ({
                id,
                fillability_status: new_status,
                expiration: expiration || "infinity",
              }));

            // Update any orders that did change status
            if (values.length) {
              const columns = new pgp.helpers.ColumnSet(
                ["id", "fillability_status", "expiration"],
                { table: "orders" }
              );

              await idb.none(
                `
                  UPDATE orders SET
                    fillability_status = x.fillability_status::order_fillability_status_t,
                    expiration = x.expiration::TIMESTAMPTZ,
                    updated_at = now()
                  FROM (VALUES ${pgp.helpers.values(
                    values,
                    columns
                  )}) AS x(id, fillability_status, expiration)
                  WHERE orders.id = x.id::TEXT
                `
              );
            }

            // Recheck all affected orders
            await orderUpdatesById.addToQueue(
              fillabilityStatuses.map(({ id }) => ({
                context: `${context}-${id}`,
                id,
                trigger,
              }))
            );

            // Revalidate any bundles
            await bundleOrderUpdatesByMaker.addToQueue([job.data]);

            break;
          }

          // Handle changes in ERC721/ERC1155 approvals (relevant for 'sell' orders)
          case "sell-approval": {
            const approvalStatuses = await idb.manyOrNone(
              `
                SELECT
                  orders.id,
                  orders.kind,
                  orders.approval_status AS old_status,
                  x.new_status,
                  x.expiration
                FROM orders
                JOIN LATERAL (
                  SELECT
                    (CASE
                      WHEN nft_approval_events.approved THEN 'approved'
                      ELSE 'no-approval'
                    END)::order_approval_status_t AS new_status,
                    (CASE
                      WHEN nft_approval_events.approved THEN nullif(upper(orders.valid_between), 'infinity')
                      ELSE to_timestamp($/timestamp/)
                    END)::TIMESTAMPTZ AS expiration
                  FROM nft_approval_events
                  WHERE nft_approval_events.address = orders.contract
                    AND nft_approval_events.owner = orders.maker
                    AND nft_approval_events.operator = orders.conduit
                  ORDER BY nft_approval_events.block DESC
                  LIMIT 1
                ) x ON TRUE
                WHERE orders.contract = $/contract/
                  AND orders.maker = $/maker/
                  AND orders.side = 'sell'
                  AND orders.conduit = $/operator/
                  AND (orders.fillability_status = 'fillable' OR orders.fillability_status = 'no-balance')
              `,
              {
                maker: toBuffer(maker),
                contract: toBuffer(data.contract),
                operator: toBuffer(data.operator),
                timestamp: trigger.txTimestamp,
              }
            );

            // Filter any orders that didn't change status
            const values = approvalStatuses
              .filter(({ old_status, new_status }) => old_status !== new_status)
              // Exclude escrowed orders
              .filter(({ kind }) => kind !== "foundation" && kind !== "cryptopunks")
              .map(({ id, new_status, expiration }) => ({
                id,
                approval_status: new_status,
                expiration: expiration || "infinity",
              }));

            // Update any orders that did change status
            if (values.length) {
              const columns = new pgp.helpers.ColumnSet(["id", "approval_status", "expiration"], {
                table: "orders",
              });

              await idb.none(
                `
                  UPDATE orders SET
                    approval_status = x.approval_status::order_approval_status_t,
                    expiration = x.expiration::TIMESTAMPTZ,
                    updated_at = now()
                  FROM (VALUES ${pgp.helpers.values(
                    values,
                    columns
                  )}) AS x(id, approval_status, expiration)
                  WHERE orders.id = x.id::TEXT
                `
              );
            }

            const cancelledValues = approvalStatuses
              .filter(
                // When an approval gets revoked, X2Y2 will off-chain cancel all the
                // orders from the same owner, so that if they ever re-approve, none
                // of these orders will get reactivated (they are able to do that by
                // having their backend refuse to sign on such orders).
                ({ kind, new_status }) => kind === "x2y2" && new_status === "no-approval"
              )
              .map(({ id, expiration }) => ({
                id,
                fillability_status: "cancelled",
                expiration: expiration || "infinity",
              }));

            // Cancel any orders if needed
            if (cancelledValues.length) {
              const columns = new pgp.helpers.ColumnSet(
                ["id", "fillability_status", "expiration"],
                {
                  table: "orders",
                }
              );

              await idb.none(
                `
                  UPDATE orders SET
                    fillability_status = x.fillability_status::order_fillability_status_t,
                    expiration = x.expiration::TIMESTAMPTZ,
                    updated_at = now()
                  FROM (VALUES ${pgp.helpers.values(
                    cancelledValues,
                    columns
                  )}) AS x(id, fillability_status, expiration)
                  WHERE orders.id = x.id::TEXT
                `
              );
            }

            // Recheck all affected orders
            await orderUpdatesById.addToQueue(
              approvalStatuses.map(({ id }) => ({
                context: `${context}-${id}`,
                id,
                trigger,
              }))
            );

            // Revalidate any bundles
            await bundleOrderUpdatesByMaker.addToQueue([job.data]);

            break;
          }
        }
      } catch (error) {
        logger.error(
          QUEUE_NAME,
          `Failed to handle maker info ${JSON.stringify(job.data)}: ${error}`
        );
        throw error;
      }
    },
    { connection: redis.duplicate(), concurrency: 30 }
  );
  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type MakerInfo = {
  // The context represents a deterministic id for what triggered
  // the job in the first place. Since this is what's going to be
  // set as the id of the job, the queue is only going to process
  // a context once (further jobs that have the same context will
  // be ignored - as long as the queue still holds past jobs with
  // the same context). It is VERY IMPORTANT to have this in mind
  // and set the contexts distinctive enough so that jobs are not
  // going to be wrongfully ignored. However, to be as performant
  // as possible it's also important to not have the contexts too
  // distinctive in order to avoid doing duplicative work.
  context: string;
  maker: string;
  // Information regarding what triggered the job
  trigger: {
    kind: TriggerKind;
    txHash: string;
    txTimestamp: number;
  };
  data:
    | {
        kind: "buy-balance";
        contract: string;
      }
    | {
        kind: "buy-approval";
        contract: string;
        // Keeping track of buy approvals is trickier than keeping track of sell approvals,
        // due to the way the ERC20 standard is designed (eg. when a spender spends allowed
        // tokens, the allowance is reduced but no associated `Approval` event gets emitted
        // to be able to fully keep track of it off-chain). For this reason, we don't track
        // ERC20 approvals off-chain, but fetch them directly from the blockchain when it's
        // detected than an approval might have changed. There are two cases when approvals
        // could have changed (both in the context of a single maker):
        // - we detect an ERC20 `Approval` event (in this case `operator` will be set and
        //   so we recheck the approvals of all orders having that `operator` as conduit)
        // - a `Transfer` event and a sale occur within the same transaction (in this case
        //   `orderKind` is going to be set and we recheck the approvals of all the orders
        //   which have that particular `orderKind`)
        orderKind?: OrderKind;
        operator?: string;
      }
    | {
        kind: "sell-balance";
        contract: string;
        tokenId: string;
      }
    | {
        kind: "sell-approval";
        contract: string;
        operator: string;
      };
};

export const addToQueue = async (makerInfos: MakerInfo[]) => {
  // Ignore empty makers
  makerInfos = makerInfos.filter(({ maker }) => maker !== AddressZero);

  await queue.addBulk(
    makerInfos.map((makerInfo) => ({
      name: makerInfo.maker,
      data: makerInfo,
      opts: {
        // We should make sure not to perform any expensive work more
        // than once. As such, we keep the last performed jobs in the
        // queue and give all jobs a deterministic id so that we skip
        // handling jobs that already got executed.
        jobId: makerInfo.context,
      },
    }))
  );
};
