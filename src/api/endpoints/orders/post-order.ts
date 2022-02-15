import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";
import Joi from "joi";

import { wyvernV2OrderFormat } from "@/api/types";
import { logger } from "@/common/logger";
import { config } from "@/config/index";
import * as wyvernV2 from "@/orders/wyvern-v2";

export const postOrderOptions: RouteOptions = {
  description: "Submit a new signed order to the order book.",
  tags: ["api", "orders"],
  timeout: {
    server: 30 * 1000,
  },
  validate: {
    payload: Joi.object({
      order: Joi.object({
        kind: Joi.string().lowercase().valid("wyvern-v2").required(),
        orderbook: Joi.string()
          .lowercase()
          .valid("reservoir", "opensea")
          .default("reservoir"),
        data: Joi.object().when("kind", {
          is: Joi.equal("wyvern-v2"),
          then: wyvernV2OrderFormat,
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
      const { kind, orderbook, data, attribute } = order;

      if (kind === "wyvern-v2") {
        const sdkOrder = new Sdk.WyvernV2.Order(config.chainId, data);
        let orderInfo: wyvernV2.OrderInfo = { order: sdkOrder, attribute };

        const filterResults = await wyvernV2.filterOrders([orderInfo]);
        if (filterResults.invalid.length) {
          throw Boom.badRequest(filterResults.invalid[0].reason);
        }

        if (orderbook === "reservoir") {
          const saveResults = await wyvernV2.saveOrders(filterResults.valid);
          if (saveResults.invalid.length) {
            throw Boom.badRequest(saveResults.invalid[0].reason);
          }
        } else if (orderbook === "opensea") {
          const osOrder = {
            ...order.params,
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
            hash: order.hash(),
          };

          // Post order to OpenSea
          await axios.post(
            `https://${
              config.chainId === 4 ? "testnets-api." : ""
            }opensea.io/wyvern/v1/orders/post`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.OPENSEA_API_KEY,
              },
              body: JSON.stringify(osOrder),
            }
          );
        }
      } else {
        throw Boom.badRequest("Unsupported order kind");
      }

      return { message: "Success" };
    } catch (error) {
      logger.error("post_order_handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
