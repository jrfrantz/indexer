import { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addTypeValue("contract_kind_t", "wyvern-v2.3");
  pgm.addTypeValue("order_kind_t", "wyvern-v2.3");

  pgm.addColumns("orders", {
    nonce: {
      type: "numeric(78, 0)",
    },
  });

  // To run separately from the migration:
  // pgm.createIndex("orders", ["kind", "maker", "nonce"], {
  //   name: "orders_side_created_at_hash",
  //   where: `"status" = 'valid' or "status" = 'no-balance'`,
  //   concurrently: true,
  // });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("orders", ["nonce"]);
}
