import { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("nft_approval_events", {
    owner: {
      type: "text",
      notNull: true,
    },
    operator: {
      type: "text",
      notNull: true,
    },
    approved: {
      type: "boolean",
      notNull: true,
    },
    address: {
      type: "text",
      notNull: true,
    },
    block: {
      type: "int",
      notNull: true,
    },
    block_hash: {
      type: "text",
      notNull: true,
    },
    tx_hash: {
      type: "text",
      notNull: true,
    },
    log_index: {
      type: "int",
      notNull: true,
    },
  });
  pgm.createConstraint("nft_approval_events", "nft_approval_events_pk", {
    primaryKey: ["block_hash", "tx_hash", "log_index"],
  });

  pgm.createIndex("nft_approval_events", [{ name: "block", sort: "DESC" }]);
  pgm.createIndex("nft_approval_events", [
    "owner",
    "operator",
    { name: "block", sort: "DESC" },
  ]);

  pgm.addColumn("orders", {
    approved: {
      type: "boolean",
      notNull: true,
      default: "true",
    },
  });

  pgm.createTable("wyvern_proxies", {
    owner: {
      type: "text",
      notNull: true,
    },
    proxy: {
      type: "text",
      notNull: true,
    },
  });
  pgm.createConstraint("wyvern_proxies", "wyvern_proxies_pk", {
    primaryKey: ["owner"],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("wyvern_proxies");

  pgm.dropColumn("orders", ["approved"]);

  pgm.dropTable("nft_approval_events");
}
