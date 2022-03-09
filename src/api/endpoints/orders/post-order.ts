import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";
import Joi from "joi";

import { wyvernV23OrderFormat } from "@/api/types";
import { logger } from "@/common/logger";
import { config } from "@/config/index";
import * as wyvernV23 from "@/orders/wyvern-v2.3";

export const postOrderOptions: RouteOptions = {
  description: "Submit a new signed order to the order book.",
  tags: ["api", "orders"],
  timeout: {
    server: 30 * 1000,
  },
  validate: {
    payload: Joi.object({
      order: Joi.object({
        kind: Joi.string().lowercase().valid("wyvern-v2.3").required(),
        orderbook: Joi.string()
          .lowercase()
          .valid("reservoir", "opensea")
          .default("reservoir"),
        source: Joi.string()
          .lowercase()
          .pattern(/^0x[a-f0-9]{40}$/),
        data: Joi.alternatives().conditional("kind", {
          switch: [{ is: "wyvern-v2.3", then: wyvernV23OrderFormat }],
        }),
        attribute: Joi.object({
          collection: Joi.string().required(),
          key: Joi.string().required(),
          value: Joi.string().required(),
        }),
      }),
    }),
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;

    if (!config.acceptOrders) {
      throw Boom.unauthorized("Not accepting orders");
    }

    const order = payload.order as any;

    try {
      const { kind, orderbook, data, attribute, source } = order;

      if (kind === "wyvern-v2.3") {
        const sdkOrder = new Sdk.WyvernV23.Order(config.chainId, data);
        let orderInfo: wyvernV23.OrderInfo = {
          order: sdkOrder,
          attribute,
          source,
        };

        const filterResults = await wyvernV23.filterOrders([orderInfo]);
        if (filterResults.invalid.length) {
          throw Boom.badRequest(filterResults.invalid[0].reason);
        }

        if (orderbook === "reservoir") {
          const saveResults = await wyvernV23.saveOrders(filterResults.valid);
          if (saveResults.invalid.length) {
            throw Boom.badRequest(saveResults.invalid[0].reason);
          }
        } else if (orderbook === "opensea") {
          const osOrder = {
            ...sdkOrder.params,
            makerProtocolFee: "0",
            takerProtocolFee: "0",
            makerReferrerFee: "0",
            feeMethod: 1,
            quantity: "1",
            metadata: {
              asset: {
                id: data.tokenId,
                address: data.contract,
              },
              schema: "ERC721",
            },
            hash: sdkOrder.hash(),
          };

          // Post order to OpenSea
          await axios
            .post(
              `https://${
                config.chainId === 4 ? "testnets-api." : "api."
              }opensea.io/wyvern/v1/orders/post`,
              JSON.stringify(osOrder),
              {
                headers:
                  config.chainId === 1
                    ? {
                        "Content-Type": "application/json",
                        "X-Api-Key": String(process.env.OPENSEA_API_KEY),
                      }
                    : {
                        "Content-Type": "application/json",
                      },
              }
            )
            .catch((error) => {
              if (error.response) {
                logger.error(
                  "post_order",
                  `Failed to post order to OpenSea: ${JSON.stringify(
                    error.response.data
                  )}`
                );
              }
              throw error;
            });
        } else {
          throw Boom.badRequest("Unsupported order kind");
        }
      }

      return { message: "Success" };
    } catch (error) {
      logger.error("post_order_handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
