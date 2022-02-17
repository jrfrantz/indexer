import { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("bulk_cancel_events", {
    maker: {
      type: "text",
      notNull: true,
    },
    min_nonce: {
      type: "numeric(78, 0)",
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
  pgm.createConstraint("bulk_cancel_events", "bulk_cancel_events_pk", {
    primaryKey: ["tx_hash", "log_index"],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("bulk_cancel_events");
}
