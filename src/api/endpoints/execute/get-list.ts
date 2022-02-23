import { AddressZero } from "@ethersproject/constants";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";

import { bn } from "@/common/bignumber";
import { db } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { config } from "@/config/index";
import * as wyvernV23 from "@/orders/wyvern-v2.3";

export const getExecuteListOptions: RouteOptions = {
  description: "Get steps required to build a sell order.",
  tags: ["api", "execute"],
  validate: {
    query: Joi.object({
      source: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/),
      contract: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/),
      tokenId: Joi.string(),
      maker: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/)
        .required(),
      price: Joi.string().required(),
      orderbook: Joi.string()
        .valid("reservoir", "opensea")
        .default("reservoir"),
      disableRoyalties: Joi.boolean().default(false),
      fee: Joi.alternatives(Joi.string(), Joi.number()),
      feeRecipient: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/)
        .disallow(AddressZero),
      v: Joi.number(),
      r: Joi.string().pattern(/^0x[a-f0-9]{64}$/),
      s: Joi.string().pattern(/^0x[a-f0-9]{64}$/),
      listingTime: Joi.alternatives(Joi.string(), Joi.number()),
      expirationTime: Joi.alternatives(Joi.string(), Joi.number()),
      salt: Joi.string(),
    })
      .or("contract", "collection")
      .oxor("contract", "collection")
      .with("contract", "tokenId")
      .with("attributeKey", ["collection", "attributeValue"]),
  },
  response: {
    schema: Joi.object({
      steps: Joi.array().items(
        Joi.object({
          action: Joi.string().required(),
          description: Joi.string().required(),
          status: Joi.string().valid("complete", "incomplete").required(),
          kind: Joi.string()
            .valid("request", "signature", "transaction")
            .required(),
          data: Joi.any(),
        })
      ),
      query: Joi.any(),
      error: Joi.string(),
    }).label("getExecuteListResponse"),
    failAction: (_request, _h, error) => {
      logger.error(
        "get_execute_list_handler",
        `Wrong response schema: ${error}`
      );
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    try {
      if (!query.disableRoyalties) {
        query.fee = undefined;
        query.feeRecipient = undefined;
      }

      const order = await wyvernV23.buildOrder({
        ...query,
        side: "sell",
      } as wyvernV23.BuildOrderOptions);

      if (!order) {
        return { error: "Could not generate order" };
      }

      // Step 1: Check that the taker owns the token
      const { kind } = await db.one(
        `
          select "c"."kind" from "contracts" "c"
          where "c"."address" = $/address/
        `,
        { address: order.params.target }
      );

      if (kind === "erc721") {
        const contract = new Sdk.Common.Helpers.Erc721(
          baseProvider,
          order.params.target
        );
        const owner = await contract.getOwner(query.tokenId);
        if (owner.toLowerCase() !== query.maker) {
          return { error: "No ownership" };
        }
      } else if (kind === "erc1155") {
        const contract = new Sdk.Common.Helpers.Erc1155(
          baseProvider,
          order.params.target
        );
        const balance = await contract.getBalance(query.maker, query.tokenId);
        if (bn(balance).isZero()) {
          return { error: "No ownership" };
        }
      } else {
        return { error: "Unknown contract" };
      }

      const steps = [
        {
          action: "Initialize wallet",
          description:
            "A one-time setup transaction to enable trading with the Wyvern Protocol (used by Open Sea)",
        },
        {
          action: "Approve NFT contract",
          description:
            "Each NFT collection you want to trade requires a one-time approval transaction",
        },
        {
          action: "Authorize listing",
          description: "A free off-chain signature to create the listing",
        },
        {
          action: "Submit listing",
          description:
            "Post your listing to the order book for others to discover it",
        },
      ];

      // Step 2: Check that the taker has registered a user proxy
      const proxyRegistry = new Sdk.WyvernV23.Helpers.ProxyRegistry(
        baseProvider,
        config.chainId
      );
      const proxy = await proxyRegistry.getProxy(query.maker);
      if (proxy === AddressZero) {
        const proxyRegistrationTx = proxyRegistry.registerProxyTransaction(
          query.maker
        );
        return {
          steps: [
            {
              ...steps[0],
              status: "incomplete",
              kind: "transaction",
              data: proxyRegistrationTx,
            },
            {
              ...steps[1],
              status: "incomplete",
              kind: "transaction",
            },
            {
              ...steps[2],
              status: "incomplete",
              kind: "signature",
            },
            {
              ...steps[3],
              status: "incomplete",
              kind: "request",
            },
          ],
        };
      }

      // Step 3: Check the taker's approval
      let isApproved: boolean;
      let approvalTx;
      if (kind === "erc721") {
        const contract = new Sdk.Common.Helpers.Erc721(
          baseProvider,
          order.params.target
        );
        isApproved = await contract.isApproved(query.maker, proxy);
        approvalTx = contract.approveTransaction(query.maker, proxy);
      } else if (kind === "erc1155") {
        const contract = new Sdk.Common.Helpers.Erc1155(
          baseProvider,
          order.params.target
        );
        isApproved = await contract.isApproved(query.maker, proxy);
        approvalTx = contract.approveTransaction(query.maker, proxy);
      } else {
        return { error: "Unknown contract" };
      }

      if (!isApproved) {
        return {
          steps: [
            {
              ...steps[0],
              status: "complete",
              kind: "transaction",
            },
            {
              ...steps[1],
              status: "incomplete",
              kind: "transaction",
              data: approvalTx,
            },
            {
              ...steps[2],
              status: "incomplete",
              kind: "signature",
            },
            {
              ...steps[3],
              status: "incomplete",
              kind: "request",
            },
          ],
        };
      }

      const hasSignature = query.v && query.r && query.s;

      return {
        steps: [
          {
            ...steps[0],
            status: "complete",
            kind: "transaction",
          },
          {
            ...steps[1],
            status: "complete",
            kind: "transaction",
          },
          {
            ...steps[2],
            status: hasSignature ? "complete" : "incomplete",
            kind: "signature",
            data: hasSignature ? undefined : order.getSignatureData(),
          },
          {
            ...steps[3],
            status: "incomplete",
            kind: "request",
            data: !hasSignature
              ? undefined
              : {
                  endpoint: "/order",
                  method: "POST",
                  body: {
                    order: {
                      kind: "wyvern-v2.3",
                      orderbook: query.orderbook,
                      data: {
                        ...order.params,
                        v: query.v,
                        r: query.r,
                        s: query.s,
                        contract: query.contract,
                        tokenId: query.tokenId,
                      },
                      source: query.source,
                    },
                  },
                },
          },
        ],
        query: {
          ...query,
          listingTime: order.params.listingTime,
          expirationTime: order.params.expirationTime,
          salt: order.params.salt,
        },
      };
    } catch (error) {
      logger.error("get_execute_list_handler", `Handler failure: ${error}`);
      throw error;
    }
  },
};
