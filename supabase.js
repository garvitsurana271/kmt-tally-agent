/**
 * Supabase client for the Tally agent
 * Uses service role key — runs only on the local office PC, never exposed.
 */

const https = require("https");
const cfg   = require("./config.json").supabase;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(cfg.url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "apikey":        cfg.serviceRoleKey,
        "Authorization": `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Supabase request timed out: ${method} ${path}`)); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Fetch pending inward rolls (grouped by consignment)
async function getPendingInwardConsignments() {
  const { data } = await request("GET",
    "consignments?tally_sync_status=eq.pending&select=id,supplier_ref,inward_date,rolls(roll_number,product,thickness,design_code,sqm,grade,tally_sync_status)&rolls.tally_sync_status=eq.pending",
    null
  );
  return Array.isArray(data) ? data : [];
}

// Fetch pending dispatched rolls
async function getPendingDispatchedRolls() {
  const { data } = await request("GET",
    "rolls?status=eq.dispatched&tally_sync_status=eq.pending&select=roll_number,product,thickness,design_code,sqm,dispatch_date,dispatch_order_id",
    null
  );
  return Array.isArray(data) ? data : [];
}

// Fetch tally item mapping
async function getTallyItemMap() {
  const { data } = await request("GET",
    "tally_items_map?select=product,design_code,tally_item_name",
    null
  );
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      map[`${row.product}|${row.design_code}`] = row.tally_item_name;
    }
  }
  return map;
}

// Save Tally stock items to DB (for mapping UI)
async function upsertTallyStockItems(names) {
  const rows = names.map((name) => ({ tally_item_name: name }));
  return request("POST", "tally_stock_items", rows);
}

// Mark rolls as synced
async function markRollsSynced(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "synced" }
  );
}

// Mark rolls as failed
async function markRollsFailed(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "failed" }
  );
}

// Mark consignment synced
async function markConsignmentSynced(id, voucherId) {
  return request("PATCH",
    `consignments?id=eq.${id}`,
    { tally_sync_status: "synced", tally_voucher_id: voucherId || null }
  );
}

module.exports = {
  getPendingInwardConsignments,
  getPendingDispatchedRolls,
  getTallyItemMap,
  upsertTallyStockItems,
  markRollsSynced,
  markRollsFailed,
  markConsignmentSynced,
};
