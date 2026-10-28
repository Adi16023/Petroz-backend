export async function moveShopStock(client, outletId, productId, quantity, {
  purchasePrice = null, sellingPrice = null, purchaseItemId = null, saleItemId = null, restore = false,
} = {}) {
  try {
    await client.query(
      "SELECT move_shop_stock($1,$2,$3,$4,$5,$6,$7,$8)",
      [outletId, productId, quantity, purchasePrice, sellingPrice, purchaseItemId, saleItemId, restore],
    );
  } catch (error) {
    if (error.code === "P0001") error.status = 400;
    throw error;
  }
}
