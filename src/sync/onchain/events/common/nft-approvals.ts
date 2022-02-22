import { db, pgp } from "@/common/db";
import { BaseParams } from "@/events/parser";

export type NftApprovalEvent = {
  owner: string;
  operator: string;
  approved: boolean;
  baseParams: BaseParams;
};

export const addNftApprovalEvents = async (
  approvalEvents: NftApprovalEvent[]
) => {
  const approvalValues: any[] = [];
  for (const ae of approvalEvents) {
    approvalValues.push({
      owner: ae.owner,
      operator: ae.operator,
      approved: ae.approved,
      address: ae.baseParams.address,
      block: ae.baseParams.block,
      block_hash: ae.baseParams.blockHash,
      tx_hash: ae.baseParams.txHash,
      log_index: ae.baseParams.logIndex,
    });
  }

  let approvalInsertsQuery: string | undefined;
  if (approvalValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "owner",
        "operator",
        "approved",
        "address",
        "block",
        "block_hash",
        "tx_hash",
        "log_index",
      ],
      { table: "nft_approval_events" }
    );
    const values = pgp.helpers.values(approvalValues, columns);

    if (values.length) {
      // Atomically insert the transfer events and update ownership
      approvalInsertsQuery = `
        insert into "nft_approval_events" (
          "owner",
          "operator",
          "approved",
          "address",
          "block",
          "block_hash",
          "tx_hash",
          "log_index"
        ) values ${values}
        on conflict do nothing
      `;
    }
  }

  if (approvalInsertsQuery) {
    await db.none(approvalInsertsQuery);
  }
};

export const removeNftApprovalEvents = async (blockHash: string) => {
  await db.any(
    `delete from "nft_approval_events" where "block_hash" = $/blockHash/`,
    { blockHash }
  );
};
