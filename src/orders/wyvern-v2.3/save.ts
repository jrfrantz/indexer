import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";
import { generateMerkleTree } from "@reservoir0x/sdk/dist/wyvern-v2/builders/token-list/utils";

import { bn } from "@/common/bignumber";
import { db, pgp } from "@/common/db";
import {
  addPendingOrdersWyvernV23,
  addPendingTokenSets,
} from "@/jobs/orders-relay";
import { addToOrdersUpdateByHashQueue } from "@/jobs/orders-update";
import {
  TokenSetInfo,
  TokenSetLabelKind,
  generateAttributeInfo,
  generateCollectionInfo,
  generateTokenInfo,
} from "@/orders/utils";
import { OrderInfo } from "@/orders/wyvern-v2.3";

type OrderMetadata = {
  kind: TokenSetLabelKind;
  data?: any;
};

const extractOrderMetadata = (
  order: Sdk.WyvernV23.Order
): OrderMetadata | undefined => {
  const info = order.getInfo();
  if (!info) {
    return undefined;
  }

  switch (order.params.kind) {
    case "erc721-single-token": {
      return {
        kind: "token",
        data: {
          contract: info.contract,
          tokenId: (info as any).tokenId,
        },
      };
    }

    case "erc721-single-token-v2": {
      return {
        kind: "token",
        data: {
          contract: info.contract,
          tokenId: (info as any).tokenId,
        },
      };
    }

    case "erc1155-single-token": {
      return {
        kind: "token",
        data: {
          contract: info.contract,
          tokenId: (info as any).tokenId,
        },
      };
    }

    case "erc1155-single-token-v2": {
      return {
        kind: "token",
        data: {
          contract: info.contract,
          tokenId: (info as any).tokenId,
        },
      };
    }

    case "erc721-token-range": {
      return {
        kind: "collection",
        data: {
          contract: info.contract,
          tokenIdRange: [(info as any).startTokenId, (info as any).endTokenId],
        },
      };
    }

    case "erc1155-token-range": {
      return {
        kind: "collection",
        data: {
          contract: info.contract,
          tokenIdRange: [(info as any).startTokenId, (info as any).endTokenId],
        },
      };
    }

    case "erc721-contract-wide": {
      return {
        kind: "collection",
        data: {
          contract: info.contract,
        },
      };
    }

    case "erc1155-contract-wide": {
      return {
        kind: "collection",
        data: {
          contract: info.contract,
        },
      };
    }

    case "erc721-token-list": {
      return {
        kind: "attribute",
        data: {
          contract: info.contract,
          merkleRoot: (info as any).merkleRoot,
        },
      };
    }

    case "erc1155-token-list": {
      return {
        kind: "attribute",
        data: {
          contract: info.contract,
          merkleRoot: (info as any).merkleRoot,
        },
      };
    }

    default: {
      return undefined;
    }
  }
};

type SaveResult = {
  valid: OrderInfo[];
  invalid: {
    orderInfo: OrderInfo;
    reason: string;
  }[];
};

export const saveOrders = async (
  orderInfos: OrderInfo[],
  relayToArweave = true
): Promise<SaveResult> => {
  const result: SaveResult = {
    valid: [],
    invalid: [],
  };

  if (!orderInfos.length) {
    return result;
  }

  // For Arweave relaying, we must keep track of the following:
  // - valid orders together with their associated schema hashes
  // - new token sets
  const arweaveOrderData: {
    order: Sdk.WyvernV23.Order;
    schemaHash?: string;
    source?: string;
  }[] = [];
  const arweaveTokenSetData: {
    id: string;
    schema: any;
    contract: string;
    tokenIds: string[];
  }[] = [];

  const queries: any[] = [];
  for (const orderInfo of orderInfos) {
    const { order } = orderInfo;

    const orderMetadata = extractOrderMetadata(order);
    if (!orderMetadata) {
      result.invalid.push({ orderInfo, reason: "Order is invalid" });
      continue;
    }

    let tokenSetInfo: TokenSetInfo | undefined;
    switch (orderMetadata.kind) {
      // We have a single-token order
      case "token": {
        tokenSetInfo = generateTokenInfo(
          orderMetadata.data?.contract,
          orderMetadata.data?.tokenId
        );

        arweaveOrderData.push({ order, schemaHash: tokenSetInfo.labelHash });

        // Create the token set
        queries.push({
          query: `
            insert into "token_sets" (
              "id",
              "contract",
              "token_id",
              "label",
              "label_hash",
              "metadata"
            ) values (
              $/tokenSetId/,
              $/contract/,
              $/tokenId/,
              $/tokenSetLabel/,
              $/tokenSetLabelHash/,
              (
                select
                  jsonb_build_object('collectionName', "c"."name", 'tokenName', "t"."name")
                from "tokens" "t"
                join "collections" "c"
                  on "t"."collection_id" = "c"."id"
                where "t"."contract" = $/contract/
                and "t"."token_id" = $/tokenId/
              )
            ) on conflict do nothing
          `,
          values: {
            tokenSetId: tokenSetInfo.id,
            contract: orderMetadata.data.contract,
            tokenId: orderMetadata.data.tokenId,
            tokenSetLabel: tokenSetInfo.label,
            tokenSetLabelHash: tokenSetInfo.labelHash,
          },
        });

        // For increased performance, only trigger the insertion of
        // corresponding tokens in the token set if we don't already
        // have them stored in the database
        const tokenSetTokensExists = await db.oneOrNone(
          `
            select 1
            from "token_sets_tokens" "tst"
            where "tst"."token_set_id" = $/tokenSetId/
            limit 1
          `,
          { tokenSetId: tokenSetInfo.id }
        );
        if (!tokenSetTokensExists) {
          // Insert matching tokens in the token set
          queries.push({
            query: `
              insert into "token_sets_tokens" (
                "token_set_id",
                "contract",
                "token_id"
              ) values (
                $/tokenSetId/,
                $/contract/,
                $/tokenId/
              ) on conflict do nothing
            `,
            values: {
              tokenSetId: tokenSetInfo.id,
              contract: orderMetadata.data.contract,
              tokenId: orderMetadata.data.tokenId,
            },
          });
        }

        break;
      }

      // We have a collection-wide order
      case "collection": {
        // Build the token set associated to the order
        const tokenSetId = orderMetadata.data?.tokenIdRange
          ? `range:${orderMetadata.data.contract}:${orderMetadata.data.tokenIdRange[0]}:${orderMetadata.data.tokenIdRange[1]}`
          : `contract:${orderMetadata.data.contract}`;

        // Fetch the collection that matches the token set
        const collection: { id: string } | null = await db.oneOrNone(
          `
            select
              "c"."id"
            from "collections" "c"
            where "c"."token_set_id" = $/tokenSetId/
          `,
          { tokenSetId }
        );

        if (collection) {
          tokenSetInfo = generateCollectionInfo(
            collection.id,
            orderMetadata.data.contract,
            orderMetadata.data?.tokenIdRange
          );

          arweaveOrderData.push({ order, schemaHash: tokenSetInfo.labelHash });

          // Create the token set
          queries.push({
            query: `
              insert into "token_sets" (
                "id",
                "collection_id",
                "label",
                "label_hash",
                "metadata"
              ) values (
                $/tokenSetId/,
                $/collectionId/,
                $/tokenSetLabel/,
                $/tokenSetLabelHash/,
                (
                  select
                    jsonb_build_object('collectionName', "c"."name")
                  from "collections" "c"
                  where "c"."id" = $/collectionId/
                )
              ) on conflict do nothing
            `,
            values: {
              tokenSetId: tokenSetInfo.id,
              collectionId: collection.id,
              tokenSetLabel: tokenSetInfo.label,
              tokenSetLabelHash: tokenSetInfo.labelHash,
            },
          });

          // For increased performance, only trigger the insertion of
          // corresponding tokens in the token set if we don't already
          // have them stored in the database
          const tokenSetTokensExists = await db.oneOrNone(
            `
              select 1
              from "token_sets_tokens" "tst"
              where "tst"."token_set_id" = $/tokenSetId/
              limit 1
            `,
            { tokenSetId: tokenSetInfo.id }
          );
          if (!tokenSetTokensExists) {
            // Insert matching tokens in the token set
            queries.push({
              query: `
                insert into "token_sets_tokens" (
                  "token_set_id",
                  "contract",
                  "token_id"
                )
                (
                  select
                    $/tokenSetId/,
                    "t"."contract",
                    "t"."token_id"
                  from "tokens" "t"
                  where "t"."collection_id" = $/collection/
                ) on conflict do nothing
              `,
              values: {
                tokenSetId: tokenSetInfo.id,
                collection: collection.id,
              },
            });
          }
        }

        break;
      }

      // We have an attribute order
      case "attribute": {
        // Fetch all tokens that match the order's attribute

        if (!orderInfo.attribute) {
          // Skip if the order was passed without any associated attribute
          break;
        }

        const collection: { token_set_id: string | null } | null =
          await db.oneOrNone(
            `
              select
                "c"."token_set_id"
              from "collections" "c"
              where "c"."id" = $/collection/
            `,
            {
              collection: orderInfo.attribute.collection,
            }
          );
        if (!collection?.token_set_id) {
          // Skip if the collection has no associated token set
          break;
        }

        let tokens: { contract: string; token_id: string }[] =
          await db.manyOrNone(
            `
              select
                "a"."contract",
                "a"."token_id"
              from "attributes" "a"
              where "a"."collection_id" = $/collection/
                and "a"."key" = $/key/
                and "a"."value" = $/value/
            `,
            {
              collection: orderInfo.attribute.collection,
              key: orderInfo.attribute.key,
              value: orderInfo.attribute.value,
            }
          );

        if (!tokens.length) {
          // No tokens matched the passed attribute
          break;
        }

        if (
          !tokens.every(
            ({ contract }) => contract === orderMetadata.data.contract
          )
        ) {
          // Make sure all matching tokens are on the same order target contract
          break;
        }

        const merkleTree = generateMerkleTree(
          tokens.map(({ token_id }) => token_id)
        );
        if (merkleTree.getHexRoot() !== orderMetadata.data?.merkleRoot) {
          // The order's merkle root doesn't match the attributes
          break;
        }

        tokenSetInfo = generateAttributeInfo(
          orderInfo.attribute,
          merkleTree.getHexRoot()
        );

        arweaveOrderData.push({
          order,
          schemaHash: tokenSetInfo.labelHash,
        });

        // Create the token set
        queries.push({
          query: `
            insert into "token_sets" (
              "id",
              "collection_id",
              "attribute_key",
              "attribute_value",
              "label",
              "label_hash",
              "metadata"
            ) values (
              $/tokenSetId/,
              $/collectionId/,
              $/attributeKey/,
              $/attributeValue/,
              $/tokenSetLabel/,
              $/tokenSetLabelHash/,
              (
                select
                  jsonb_build_object('collectionName', "c"."name")
                from "collections" "c"
                where "c"."id" = $/collectionId/
              )
            ) on conflict do nothing
          `,
          values: {
            tokenSetId: tokenSetInfo.id,
            collectionId: orderInfo.attribute.collection,
            attributeKey: orderInfo.attribute.key,
            attributeValue: orderInfo.attribute.value,
            tokenSetLabel: tokenSetInfo.label,
            tokenSetLabelHash: tokenSetInfo.labelHash,
          },
        });

        // For increased performance, only trigger the insertion of
        // corresponding tokens in the token set if we don't already
        // have them stored in the database
        const tokenSetTokensExists = await db.oneOrNone(
          `
            select 1
            from "token_sets_tokens" "tst"
            where "tst"."token_set_id" = $/tokenSetId/
            limit 1
          `,
          { tokenSetId: tokenSetInfo.id }
        );
        if (!tokenSetTokensExists) {
          arweaveTokenSetData.push({
            id: tokenSetInfo.id,
            schema: tokenSetInfo.label,
            contract: orderMetadata.data.contract,
            tokenIds: tokens.map(({ token_id }) => token_id),
          });

          const columns = new pgp.helpers.ColumnSet(
            ["token_set_id", "contract", "token_id"],
            {
              table: "token_sets_tokens",
            }
          );
          const values = pgp.helpers.values(
            tokens.map((token) => ({
              ...token,
              token_set_id: tokenSetInfo!.id,
            })),
            columns
          );

          // Insert matching tokens in the token set
          queries.push({
            query: `
              insert into "token_sets_tokens" (
                "token_set_id",
                "contract",
                "token_id"
              ) values ${values}
               on conflict do nothing
            `,
          });
        }

        break;
      }
    }

    if (!tokenSetInfo) {
      result.invalid.push({
        orderInfo,
        reason: "Order has no matching token set",
      });
      continue;
    }

    const side = order.params.side === 0 ? "buy" : "sell";

    let value: string;
    if (side === "buy") {
      // For buy orders, we set the value as `price - fee` since it's
      // best for UX to show the user exactly what they're going to
      // receive on offer acceptance (and that is `price - fee` and
      // not `price`)
      const fee = order.params.takerRelayerFee;
      value = bn(order.params.basePrice)
        .sub(bn(order.params.basePrice).mul(bn(fee)).div(10000))
        .toString();
    } else {
      // For sell orders, the value is the same as the price
      value = order.params.basePrice;
    }

    // Handle fees

    const feeBps = Math.max(
      order.params.makerRelayerFee,
      order.params.takerRelayerFee
    );

    let sourceInfo;
    switch (order.params.feeRecipient) {
      // OpenSea
      case "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073": {
        sourceInfo = {
          id: "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073",
          bps: 250,
        };
        break;
      }

      // Unknown
      default: {
        sourceInfo = {
          id: orderInfo.source || AddressZero,
          // Assume everything goes to the order's fee recipient
          bps: feeBps,
        };
        break;
      }
    }

    // Handle royalties

    const royalty: { recipient: string } | null = await db.oneOrNone(
      `
        select
          "c"."royalty_recipient" as "recipient"
        from "collections" "c"
        join "tokens" "t"
          on "c"."id" = "t"."collection_id"
        where "t"."contract" = $/contract/
        limit 1
      `,
      { contract: orderMetadata.data.contract }
    );

    let royaltyInfo;
    if (royalty) {
      // Royalties are whatever is left after subtracting the marketplace fee
      const bps = feeBps - sourceInfo.bps;
      if (bps > 0) {
        royaltyInfo = [
          {
            recipient: royalty.recipient,
            bps: feeBps - sourceInfo.bps,
          },
        ];
      }
    }

    // TODO: Not at all critical, but multi-row inserts could
    // do here to get better insert performance when handling
    // multiple orders
    queries.push({
      query: `
        insert into "orders" (
          "hash",
          "kind",
          "status",
          "side",
          "token_set_id",
          "token_set_label_hash",
          "maker",
          "price",
          "value",
          "valid_between",
          "source_id",
          "source_bps",
          "royalty_info",
          "nonce",
          "raw_data",
          "expiry",
          "created_at"
        ) values (
          $/hash/,
          $/kind/,
          $/status/,
          $/side/,
          $/tokenSetId/,
          $/tokenSetLabelHash/,
          $/maker/,
          $/price/,
          $/value/,
          tstzrange(date_trunc('seconds', to_timestamp($/listingTime/)), date_trunc('seconds', to_timestamp($/expirationTime/))),
          $/sourceId/,
          $/sourceBps/,
          $/royaltyInfo:json/,
          $/nonce/,
          $/rawData/,
          date_trunc('seconds', to_timestamp($/expirationTime/)),
          date_trunc('milliseconds', now())
        ) on conflict ("hash") do
        update set
          "side" = $/side/,
          "token_set_id" = $/tokenSetId/,
          "token_set_label_hash" = $/tokenSetLabelHash/,
          "maker" = $/maker/,
          "price" = $/price/,
          "value" = $/value/,
          "valid_between" = tstzrange(date_trunc('seconds', to_timestamp($/listingTime/)), date_trunc('seconds', to_timestamp($/expirationTime/))),
          "source_id" = $/sourceId/,
          "source_bps" = $/sourceBps/,
          "royalty_info" = $/royaltyInfo:json/,
          "nonce" = $/nonce/,
          "raw_data" = $/rawData/,
          "expiry" = date_trunc('seconds', to_timestamp($/expirationTime/)),
          "created_at" = date_trunc('milliseconds', now())
      `,
      values: {
        hash: order.prefixHash(),
        kind: "wyvern-v2.3",
        status: "valid",
        side,
        tokenSetId: tokenSetInfo.id,
        tokenSetLabelHash: tokenSetInfo.labelHash,
        maker: order.params.maker,
        price: order.params.basePrice,
        value,
        listingTime: order.params.listingTime,
        expirationTime:
          order.params.expirationTime == 0
            ? "infinity"
            : order.params.expirationTime,
        sourceId: sourceInfo.id,
        sourceBps: sourceInfo.bps,
        royaltyInfo,
        nonce: order.params.nonce,
        rawData: order.params,
      },
    });

    result.valid.push(orderInfo);
  }

  if (queries.length) {
    await db.none(pgp.helpers.concat(queries));
  }

  await addToOrdersUpdateByHashQueue(
    orderInfos.map(({ order }) => ({
      context: "save",
      hash: order.prefixHash(),
    }))
  );

  if (relayToArweave) {
    await addPendingOrdersWyvernV23(arweaveOrderData);
    await addPendingTokenSets(arweaveTokenSetData);
  }

  return result;
};
