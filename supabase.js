/**
 * Supabase client for the Tally agent (service role — office PC only).
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Supabase timeout: ${method} ${path}`)); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Upsert helper (adds resolution=merge-duplicates) ─────────
function requestUpsert(path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(cfg.url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: `/rest/v1/${path}`,
      method: "POST",
      headers: {
        "apikey":          cfg.serviceRoleKey,
        "Authorization":   `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type":    "application/json",
        "Content-Length":  Buffer.byteLength(data),
        "Prefer":          "resolution=merge-duplicates,return=minimal",
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Supabase timeout: POST ${path}`)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Stock items ───────────────────────────────────────────────
async function upsertTallyStockItems(names) {
  const rows = names.map((name) => ({ tally_item_name: name }));
  return requestUpsert("tally_stock_items?on_conflict=tally_item_name", rows);
}

// ── Ledgers ───────────────────────────────────────────────────
async function upsertTallyLedgers(names) {
  const rows = names.map((name) => ({ tally_ledger_name: name }));
  return requestUpsert("tally_ledgers?on_conflict=tally_ledger_name", rows);
}

// ── Supplier map (our supplier name → Tally ledger name) ──────
async function getSupplierMap() {
  const { data } = await request("GET", "tally_suppliers_map?select=supplier,tally_ledger_name", null);
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) map[row.supplier] = row.tally_ledger_name;
  }
  return map;
}

// ── Upsert dealers from Tally (Sundry Debtors ledgers) ────────
async function upsertDealers(dealers) {
  // Map Tally fields → dealers table columns
  const rows = dealers.map((d) => ({
    name:              d.mailing_name || d.name,
    phone:             d.phone || null,
    email:             d.email || null,
    address:           d.address || null,
    state:             d.state || null,
    gst_number:        d.gst_number || null,
    status:            "active",
    tally_ledger_name: d.name,
  }));

  // Batch into 100-row chunks to avoid payload / timeout issues
  const BATCH = 100;
  let lastRes;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    lastRes = await requestUpsert("dealers?on_conflict=tally_ledger_name", chunk);
    if (lastRes.status >= 400) {
      console.error("[ERR] dealers upsert batch", i, "→", i + chunk.length,
        "HTTP", lastRes.status, JSON.stringify(lastRes.data).slice(0, 300));
      break;
    }
  }
  return lastRes;
}

// ── Tally item map (product|design_code → Tally stock item) ───
async function getTallyItemMap() {
  const { data } = await request("GET", "tally_items_map?select=product,design_code,tally_item_name", null);
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) map[`${row.product}|${row.design_code}`] = row.tally_item_name;
  }
  return map;
}

// ── Pending inward consignments with their rolls ──────────────
async function getPendingInwardConsignments() {
  const { data } = await request("GET",
    "consignments?tally_sync_status=eq.pending&select=id,supplier_ref,supplier,inward_date,rolls(roll_number,product,thickness,design_code,sqm,grade,tally_sync_status)&rolls.tally_sync_status=eq.pending",
    null
  );
  return Array.isArray(data) ? data : [];
}

// ── Pending dispatched rolls ──────────────────────────────────
async function getPendingDispatchedRolls() {
  const { data } = await request("GET",
    "rolls?status=eq.dispatched&tally_sync_status=eq.pending&select=roll_number,product,thickness,design_code,sqm,dispatch_date,dispatch_order_id",
    null
  );
  return Array.isArray(data) ? data : [];
}

// ── Mark rolls synced / failed ────────────────────────────────
async function markRollsSynced(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "synced" }
  );
}

async function markRollsFailed(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "failed" }
  );
}

// ── Mark consignment synced (stores voucher ID if returned) ───
async function markConsignmentSynced(id, voucherId) {
  return request("PATCH",
    `consignments?id=eq.${id}`,
    { tally_sync_status: "synced", tally_voucher_id: voucherId || null }
  );
}

module.exports = {
  upsertTallyStockItems,
  upsertTallyLedgers,
  upsertDealers,
  getSupplierMap,
  getTallyItemMap,
  getPendingInwardConsignments,
  getPendingDispatchedRolls,
  markRollsSynced,
  markRollsFailed,
  markConsignmentSynced,
};
