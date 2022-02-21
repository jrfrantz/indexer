import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";

import { wyvernV2OrderFormat, wyvernV23OrderFormat } from "@/api/types";
import { logger } from "@/common/logger";
import { config } from "@/config/index";
import * as wyvernV2 from "@/orders/wyvern-v2";
import * as wyvernV23 from "@/orders/wyvern-v2.3";

export const postOrdersOptions: RouteOptions = {
  description:
    "Submit a new signed order to the order book. Use the SDK to help build and sign orders.",
  tags: ["api", "orders"],
  timeout: {
    server: 2 * 60 * 1000,
  },
  validate: {
    payload: Joi.object().keys({
      orders: Joi.array().items(
        Joi.object().keys({
          kind: Joi.string()
            .lowercase()
            .valid("wyvern-v2", "wyvern-v2.3")
            .required(),
          data: Joi.alternatives().conditional("kind", {
            switch: [
              { is: "wyvern-v2", then: wyvernV2OrderFormat },
              { is: "wyvern-v2.3", then: wyvernV23OrderFormat },
            ],
          }),
          attribute: Joi.object({
            collection: Joi.string().required(),
            key: Joi.string().required(),
            value: Joi.string().required(),
          }),
        })
      ),
    }),
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;

    if (!config.acceptOrders) {
      throw Boom.unauthorized("Not accepting orders");
    }

    try {
      const orders = payload.orders as any;

      const validOrderInfosWyvernV2: wyvernV2.OrderInfo[] = [];
      const validOrderInfosWyvernV23: wyvernV23.OrderInfo[] = [];
      for (const { kind, data, attribute } of orders) {
        if (kind === "wyvern-v2") {
          try {
            const order = new Sdk.WyvernV2.Order(config.chainId, data);
            validOrderInfosWyvernV2.push({ order, attribute });
          } catch {
            // Skip any invalid orders
          }
        } else if (kind === "wyvern-v2.3") {
          try {
            const order = new Sdk.WyvernV23.Order(config.chainId, data);
            validOrderInfosWyvernV23.push({ order, attribute });
          } catch {
            // Skip any invalid orders
          }
        }
      }

      let validCount = 0;
      const result: { [hash: string]: string } = {};

      // Handle WyvernV2 orders
      {
        const filterResults = await wyvernV2.filterOrders(
          validOrderInfosWyvernV2
        );
        const saveResults = await wyvernV2.saveOrders(
          filterResults.valid,
          false
        );

        for (const { orderInfo, reason } of filterResults.invalid) {
          result[orderInfo.order.prefixHash()] = reason;
        }
        for (const { orderInfo, reason } of saveResults.invalid) {
          result[orderInfo.order.prefixHash()] = reason;
        }
        for (const orderInfo of saveResults.valid) {
          result[orderInfo.order.prefixHash()] = "Success";
          validCount++;
        }
      }

      // Handle WyvernV23 orders
      {
        const filterResults = await wyvernV23.filterOrders(
          validOrderInfosWyvernV23
        );
        const saveResults = await wyvernV23.saveOrders(
          filterResults.valid,
          false
        );

        for (const { orderInfo, reason } of filterResults.invalid) {
          result[orderInfo.order.prefixHash()] = reason;
        }
        for (const { orderInfo, reason } of saveResults.invalid) {
          result[orderInfo.order.prefixHash()] = reason;
        }
        for (const orderInfo of saveResults.valid) {
          result[orderInfo.order.prefixHash()] = "Success";
          validCount++;
        }
      }

      if (validCount) {
        logger.info(
          "post_orders_handler",
          JSON.stringify({
            message: `Got ${validCount} orders`,
            data: {
              validOrdersCount: validCount,
            },
          })
        );
      }

      return { orders: result };
    } catch (error) {
      logger.error("post_orders_handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
