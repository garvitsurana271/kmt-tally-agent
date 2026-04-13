/**
 * Supabase client for the Tally agent (service role — office PC only).
 */

const https = require("https");
const cfg   = require("./config.json").supabase;

// ── Base request ─────────────────────────────────────────────
function request(method, path, body, extraHeaders) {
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
        ...(extraHeaders || {}),
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

// ── Upsert helper (resolution=merge-duplicates) ───────────────
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
        "apikey":         cfg.serviceRoleKey,
        "Authorization":  `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
        "Prefer":         "resolution=merge-duplicates,return=minimal",
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

// ── Batch upsert (splits into chunks, continues on error) ─────
async function batchUpsert(path, rows, batchSize = 100, label = path) {
  let lastRes;
  let errCount = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    lastRes = await requestUpsert(path, chunk);
    if (lastRes.status >= 400) {
      console.error(`[ERR] ${label} batch ${i}→${i + chunk.length} HTTP ${lastRes.status}`,
        JSON.stringify(lastRes.data).slice(0, 300));
      errCount++;
    }
  }
  if (errCount > 0) console.error(`[ERR] ${errCount} ${label} batch(es) failed`);
  return lastRes;
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

// ── Shared ledger → row mapper ────────────────────────────────
function mapLedgerRow(d, now) {
  return {
    name:              d.mailing_name || d.name,
    phone:             d.phone || null,
    phone2:            d.phone2 || null,
    email:             d.email || null,
    city:              d.city || null,
    address:           d.address || null,
    state:             d.state || null,
    gst_number:        d.gst_number || null,
    notes: [
      d.pan_number ? `PAN: ${d.pan_number}` : null,
      d.website    ? `Web: ${d.website}`    : null,
      d.country && d.country !== "India" ? `Country: ${d.country}` : null,
    ].filter(Boolean).join(" | ") || null,
    ...(d.credit_limit  != null ? { credit_limit:         d.credit_limit }  : {}),
    ...(d.payment_terms != null ? { payment_terms:        d.payment_terms } : {}),
    ...(d.outstanding   != null ? { current_outstanding:  d.outstanding }   : {}),
    status:            "active",
    updated_at:        now,
  };
}

// ── Upsert dealers (Sundry Debtors) ──────────────────────────
async function upsertDealers(dealers) {
  const now  = new Date().toISOString();
  const rows = dealers.map((d) => ({
    ...mapLedgerRow(d, now),
    current_outstanding: d.outstanding ?? 0,
    tally_ledger_name:   d.name,
  }));
  return batchUpsert("dealers?on_conflict=tally_ledger_name", rows, 100, "dealers");
}

// ── Upsert vendors (Sundry Creditors) ─────────────────────────
async function upsertVendors(suppliers) {
  const now  = new Date().toISOString();
  const rows = suppliers.map((s) => ({
    name:              s.mailing_name || s.name,
    phone:             s.phone || null,
    email:             s.email || null,
    city:              s.city || null,
    address:           s.address || null,
    state:             s.state || null,
    gst_number:        s.gst_number || null,
    notes: [
      s.pan_number ? `PAN: ${s.pan_number}` : null,
      s.website    ? `Web: ${s.website}`    : null,
    ].filter(Boolean).join(" | ") || null,
    ...(s.payment_terms != null ? { payment_terms: s.payment_terms } : {}),
    status:            "active",
    tally_ledger_name: s.name,
    tally_closing_balance: s.outstanding ?? null,
    updated_at:        now,
  }));
  return batchUpsert("vendors?on_conflict=tally_ledger_name", rows, 100, "vendors");
}

// ── Upsert payment vouchers from Tally ───────────────────────
async function upsertTallyPayments(vouchers, dealerMap) {
  // dealerMap: { tally_ledger_name → dealer_id }
  const now  = new Date().toISOString();
  const rows = vouchers
    .filter((v) => v.tally_voucher_id)
    .map((v) => ({
      tally_voucher_id:  v.tally_voucher_id,
      dealer_id:         dealerMap[v.party_ledger] || null,
      amount:            v.amount,
      payment_date:      v.payment_date,
      reference_number:  v.voucher_number || null,
      notes:             v.narration || null,
      payment_mode:      "bank_transfer", // default; Tally doesn't expose mode easily
      recorded_by:       "Tally",
      source:            "tally",
      tally_sync_status: "synced",
      created_at:        now,
    }));

  if (!rows.length) return { status: 200 };
  return batchUpsert("payments?on_conflict=tally_voucher_id", rows, 50, "tally-payments");
}

// ── Get dealer map (tally_ledger_name → dealer_id) ────────────
async function getDealerLedgerMap() {
  const { data } = await request("GET",
    "dealers?select=id,tally_ledger_name&tally_ledger_name=not.is.null&limit=10000", null);
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) if (row.tally_ledger_name) map[row.tally_ledger_name] = row.id;
  }
  return map;
}

// ── Pending payments on website to push → Tally ───────────────
async function getPendingPaymentsToSync() {
  const { data } = await request("GET",
    "payments?tally_sync_status=eq.pending&source=eq.manual&select=id,dealer_id,amount,payment_date,payment_mode,reference_number,notes&limit=200",
    null);
  return Array.isArray(data) ? data : [];
}

// ── Get dealer name for a payment (to get tally_ledger_name) ──
async function getDealerTallyName(dealerId) {
  if (!dealerId) return null;
  const { data } = await request("GET",
    `dealers?id=eq.${dealerId}&select=tally_ledger_name`, null);
  return Array.isArray(data) && data[0] ? data[0].tally_ledger_name : null;
}

// ── Mark payment synced to Tally ─────────────────────────────
async function markPaymentSynced(id, voucherId) {
  return request("PATCH",
    `payments?id=eq.${id}`,
    { tally_sync_status: "synced", tally_voucher_id: voucherId || null });
}

async function markPaymentFailed(id) {
  return request("PATCH",
    `payments?id=eq.${id}`,
    { tally_sync_status: "failed" });
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

// ── Pending inward consignments ───────────────────────────────
async function getPendingInwardConsignments() {
  const { data } = await request("GET",
    "consignments?tally_sync_status=eq.pending&select=id,supplier_ref,supplier,inward_date,rolls(roll_number,product,thickness,design_code,sqm,grade,tally_sync_status)&rolls.tally_sync_status=eq.pending",
    null);
  return Array.isArray(data) ? data : [];
}

// ── Pending dispatched rolls ──────────────────────────────────
async function getPendingDispatchedRolls() {
  const { data } = await request("GET",
    "rolls?status=eq.dispatched&tally_sync_status=eq.pending&select=roll_number,product,thickness,design_code,sqm,dispatch_date,dispatch_order_id",
    null);
  return Array.isArray(data) ? data : [];
}

// ── Mark rolls synced / failed ────────────────────────────────
async function markRollsSynced(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "synced" });
}

async function markRollsFailed(rollNumbers) {
  return request("PATCH",
    `rolls?roll_number=in.(${rollNumbers.map((r) => `"${r}"`).join(",")})`,
    { tally_sync_status: "failed" });
}

// ── Mark consignment synced ───────────────────────────────────
async function markConsignmentSynced(id, voucherId) {
  return request("PATCH",
    `consignments?id=eq.${id}`,
    { tally_sync_status: "synced", tally_voucher_id: voucherId || null });
}

module.exports = {
  upsertTallyStockItems,
  upsertTallyLedgers,
  upsertDealers,
  upsertVendors,
  upsertTallyPayments,
  getSupplierMap,
  getTallyItemMap,
  getDealerLedgerMap,
  getPendingPaymentsToSync,
  getDealerTallyName,
  markPaymentSynced,
  markPaymentFailed,
  getPendingInwardConsignments,
  getPendingDispatchedRolls,
  markRollsSynced,
  markRollsFailed,
  markConsignmentSynced,
};
