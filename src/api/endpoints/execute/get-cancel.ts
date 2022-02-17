import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";

import { db } from "@/common/db";
import { logger } from "@/common/logger";
import { config } from "@/config/index";

export const getExecuteCancelOptions: RouteOptions = {
  description: "Get steps required to cancel an order.",
  tags: ["api", "execute"],
  validate: {
    query: Joi.object({
      hash: Joi.string().required(),
      maker: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/)
        .required(),
    }),
  },
  response: {
    schema: Joi.object({
      steps: Joi.array().items(
        Joi.object({
          action: Joi.string().required(),
          description: Joi.string().required(),
          status: Joi.string().valid("complete", "incomplete").required(),
          kind: Joi.string().valid("transaction", "confirmation").required(),
          data: Joi.any(),
        })
      ),
      error: Joi.string(),
    }).label("getExecuteCancelResponse"),
    failAction: (_request, _h, error) => {
      logger.error(
        "get_execute_cancel_handler",
        `Wrong response schema: ${error}`
      );
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    try {
      const order = await db.one(
        `
          select "o"."kind", "o"."raw_data" from "orders" "o"
          where "o"."hash" = $/hash/
            and "o"."maker" = $/maker/
            and (
              "o"."status" = 'valid'
              or "o"."status" = 'no-balance'
              or "o"."status" = 'disabled'
            )
        `,
        {
          hash: query.hash,
          maker: query.maker,
        }
      );

      if (!order) {
        return { error: "No matching order" };
      }

      if (order.kind === "wyvern-v2") {
        const sdkOrder = new Sdk.WyvernV2.Order(config.chainId, order.raw_data);

        const exchange = new Sdk.WyvernV2.Exchange(config.chainId);
        const cancelTx = exchange.cancelTransaction(query.maker, sdkOrder);

        const steps = [
          sdkOrder.params.side === Sdk.WyvernV2.Types.OrderSide.SELL
            ? {
                action: "Submit cancellation",
                description:
                  "To cancel this listing you must confirm the transaction and pay the gas fee",
              }
            : {
                action: "Cancel offer",
                description:
                  "To cancel this offer you must confirm the transaction and pay the gas fee",
              },
          {
            action: "Confirmation",
            description: `Verify that the ${
              sdkOrder.params.side === Sdk.WyvernV2.Types.OrderSide.SELL
                ? "listing"
                : "offer"
            } was successfully cancelled`,
          },
        ];

        return {
          steps: [
            {
              ...steps[0],
              status: "incomplete",
              kind: "transaction",
              data: cancelTx,
            },
            {
              ...steps[1],
              status: "incomplete",
              kind: "confirmation",
              data: {
                endpoint: `/orders/executed?hash=${sdkOrder.prefixHash()}`,
                method: "GET",
              },
            },
          ],
        };
      } else if (order.kind === "wyvern-v2.3") {
        const sdkOrder = new Sdk.WyvernV23.Order(
          config.chainId,
          order.raw_data
        );

        const exchange = new Sdk.WyvernV23.Exchange(config.chainId);
        const cancelTx = exchange.cancelTransaction(query.maker, sdkOrder);

        const steps = [
          sdkOrder.params.side === Sdk.WyvernV23.Types.OrderSide.SELL
            ? {
                action: "Submit cancellation",
                description:
                  "To cancel this listing you must confirm the transaction and pay the gas fee",
              }
            : {
                action: "Cancel offer",
                description:
                  "To cancel this offer you must confirm the transaction and pay the gas fee",
              },
          {
            action: "Confirmation",
            description: `Verify that the ${
              sdkOrder.params.side === Sdk.WyvernV23.Types.OrderSide.SELL
                ? "listing"
                : "offer"
            } was successfully cancelled`,
          },
        ];

        return {
          steps: [
            {
              ...steps[0],
              status: "incomplete",
              kind: "transaction",
              data: cancelTx,
            },
            {
              ...steps[1],
              status: "incomplete",
              kind: "confirmation",
              data: {
                endpoint: `/orders/executed?hash=${sdkOrder.prefixHash()}`,
                method: "GET",
              },
            },
          ],
        };
      }

      return { error: "No matching order" };
    } catch (error) {
      logger.error("get_execute_cancel_handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
