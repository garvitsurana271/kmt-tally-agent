/**
 * KMT Tally Sync Agent — Full Bidirectional
 *
 * Every 30 seconds:
 *   • Pending inward consignments  → Receipt Notes in Tally
 *   • Pending dispatched rolls     → Delivery Notes in Tally
 *   • Pending website payments     → Receipt Vouchers in Tally
 *
 * Every 10 minutes:
 *   • Tally stock items            → Supabase tally_stock_items
 *   • Tally ledgers                → Supabase tally_ledgers
 *   • Tally Sundry Debtors         → Supabase dealers (full details + balance)
 *   • Tally Sundry Creditors       → Supabase vendors (full details + balance)
 *   • Tally Receipt vouchers (FY)  → Supabase payments
 */

const tally = require("./tally");
const db    = require("./supabase");
const cfg   = require("./config.json");

const INTERVAL    = (cfg.sync?.intervalSeconds ?? 30) * 1000;
const MASTER_TTL  = 10 * 60 * 1000;  // 10 min
const PAYMENT_TTL =  5 * 60 * 1000;  //  5 min
const silent      = process.argv.includes("--silent");

function log(...args)  { if (!silent) console.log(new Date().toLocaleTimeString("en-IN"), ...args); }
function err(...args)  { console.error(new Date().toLocaleTimeString("en-IN"), "[ERR]", ...args); }

// ── Stock item sync ───────────────────────────────────────────
let lastItemSync = 0;
async function syncStockItems() {
  if (Date.now() - lastItemSync < MASTER_TTL) return;
  try {
    log("Fetching stock items from Tally…");
    const names = await tally.getAllStockItems();
    log(`Got ${names.length} stock items from Tally`);
    if (names.length > 0) {
      const res = await db.upsertTallyStockItems(names);
      log(`Stock items synced: ${names.length} items (HTTP ${res.status})`);
    }
    lastItemSync = Date.now();
  } catch (e) { err("Stock item sync failed:", e.message); }
}

// ── Ledger sync ───────────────────────────────────────────────
let lastLedgerSync = 0;
async function syncLedgers() {
  if (Date.now() - lastLedgerSync < MASTER_TTL) return;
  try {
    log("Fetching ledgers from Tally…");
    const names = await tally.getAllLedgers();
    log(`Got ${names.length} ledgers from Tally`);
    if (names.length > 0) {
      const res = await db.upsertTallyLedgers(names);
      log(`Ledgers synced: ${names.length} (HTTP ${res.status})`);
    }
    lastLedgerSync = Date.now();
  } catch (e) { err("Ledger sync failed:", e.message); }
}

// ── Dealer sync (Sundry Debtors → dealers) ───────────────────
let lastDealerSync = 0;
async function syncDealers() {
  if (Date.now() - lastDealerSync < MASTER_TTL) return;
  try {
    log("Fetching dealer ledgers from Tally…");
    const dealers = await tally.getDealerLedgers();
    log(`Got ${dealers.length} dealers from Tally`);
    if (dealers.length > 0) {
      const res = await db.upsertDealers(dealers);
      log(`Dealers synced: ${dealers.length} (HTTP ${res?.status})`);
    }
    lastDealerSync = Date.now();
  } catch (e) { err("Dealer sync failed:", e.message); }
}

// ── Supplier sync (Sundry Creditors → vendors) ────────────────
let lastSupplierSync = 0;
async function syncSuppliers() {
  if (Date.now() - lastSupplierSync < MASTER_TTL) return;
  try {
    log("Fetching supplier ledgers from Tally…");
    const suppliers = await tally.getSupplierLedgers();
    log(`Got ${suppliers.length} suppliers from Tally`);
    if (suppliers.length > 0) {
      const res = await db.upsertVendors(suppliers);
      log(`Suppliers synced: ${suppliers.length} (HTTP ${res?.status})`);
    }
    lastSupplierSync = Date.now();
  } catch (e) { err("Supplier sync failed:", e.message); }
}

// ── Payment sync: Tally receipts → website payments ───────────
let lastPaymentPull = 0;
async function syncPaymentsFromTally() {
  if (Date.now() - lastPaymentPull < PAYMENT_TTL) return;
  try {
    log("Fetching payment receipts from Tally…");
    const vouchers = await tally.getPaymentVouchers(); // current FY
    if (vouchers.length > 0) {
      const dealerMap = await db.getDealerLedgerMap();
      const res = await db.upsertTallyPayments(vouchers, dealerMap);
      log(`Tally payments synced: ${vouchers.length} (HTTP ${res?.status})`);
    } else {
      log("No payment receipts found in Tally");
    }
    lastPaymentPull = Date.now();
  } catch (e) { err("Payment pull from Tally failed:", e.message); }
}

// ── Payment sync: website payments → Tally receipt vouchers ───
async function syncPaymentsToTally() {
  try {
    const payments = await db.getPendingPaymentsToSync();
    if (!payments.length) return;
    log(`Outward payments: ${payments.length} pending → Tally`);

    for (const p of payments) {
      const dealerLedger = await db.getDealerTallyName(p.dealer_id);
      if (!dealerLedger) {
        err(`No Tally ledger for dealer ${p.dealer_id} — skipping payment ${p.id}`);
        await db.markPaymentFailed(p.id);
        continue;
      }

      const result = await tally.createReceiptVoucher({
        date:      p.payment_date?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        amount:    p.amount,
        dealerLedger,
        mode:      p.payment_mode,
        reference: p.reference_number,
        narration: p.notes,
      });

      if (result.success) {
        await db.markPaymentSynced(p.id, result.voucherId);
        log(`Receipt Voucher: dealer=${dealerLedger} amount=${p.amount}${result.voucherId ? ` | ID: ${result.voucherId}` : ""}`);
      } else {
        await db.markPaymentFailed(p.id);
        err(`Receipt Voucher failed: ${dealerLedger}`, result.raw?.slice(0, 200));
      }
    }
  } catch (e) { err("Payment push to Tally failed:", e.message); }
}

// ── Inward sync (pending consignments → Receipt Notes) ────────
async function syncInward() {
  const consignments = await db.getPendingInwardConsignments();
  if (!consignments.length) return;

  const [itemMap, supplierMap] = await Promise.all([
    db.getTallyItemMap(),
    db.getSupplierMap(),
  ]);
  log(`Inward: ${consignments.length} consignment(s) pending`);

  for (const c of consignments) {
    const rolls = c.rolls ?? [];
    if (!rolls.length) continue;

    const supplierLedger = supplierMap[c.supplier] || null;
    if (!supplierLedger) {
      log(`No supplier ledger mapped for "${c.supplier}" — using Purchase Account.`);
    }

    const groups = {};
    for (const r of rolls) {
      const key = `${r.product}|${r.design_code}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    let consignmentOk = true;

    for (const [key, groupRolls] of Object.entries(groups)) {
      const tallyItemName = itemMap[key];
      if (!tallyItemName) {
        err(`No Tally mapping for ${key} — skipping. Set it in Admin → Tally Bridge.`);
        consignmentOk = false;
        continue;
      }

      const result = await tally.createReceiptNote({
        date: c.inward_date,
        supplierRef: c.supplier_ref,
        rolls: groupRolls,
        tallyItemName,
        supplierLedger,
      });

      if (result.success) {
        await db.markRollsSynced(groupRolls.map((r) => r.roll_number));
        log(`Receipt Note: ${c.supplier_ref} | ${tallyItemName} | ${groupRolls.length} rolls${result.voucherId ? ` | ID: ${result.voucherId}` : ""}`);
      } else {
        await db.markRollsFailed(groupRolls.map((r) => r.roll_number));
        err(`Receipt Note failed: ${c.supplier_ref} | ${tallyItemName}`, result.raw?.slice(0, 200));
        consignmentOk = false;
      }
    }

    if (consignmentOk) await db.markConsignmentSynced(c.id, null);
  }
}

// ── Outward sync (dispatched rolls → Delivery Notes) ──────────
async function syncOutward() {
  const rolls = await db.getPendingDispatchedRolls();
  if (!rolls.length) return;

  const itemMap = await db.getTallyItemMap();
  log(`Outward: ${rolls.length} dispatched roll(s) pending`);

  const groups = {};
  for (const r of rolls) {
    const key = `${r.dispatch_date}|${r.dispatch_order_id ?? ""}|${r.product}|${r.design_code}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  for (const [key, groupRolls] of Object.entries(groups)) {
    const [date, orderRef, product, designCode] = key.split("|");
    const tallyItemName = itemMap[`${product}|${designCode}`];

    if (!tallyItemName) {
      err(`No Tally mapping for ${product}|${designCode} — skipping`);
      continue;
    }

    const result = await tally.createDeliveryNote({
      date, orderRef, rolls: groupRolls, tallyItemName,
    });

    if (result.success) {
      await db.markRollsSynced(groupRolls.map((r) => r.roll_number));
      log(`Delivery Note: ${tallyItemName} | ${groupRolls.length} rolls | ${date}${result.voucherId ? ` | ID: ${result.voucherId}` : ""}`);
    } else {
      await db.markRollsFailed(groupRolls.map((r) => r.roll_number));
      err(`Delivery Note failed: ${tallyItemName}`, result.raw?.slice(0, 200));
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────
async function run() {
  log("KMT Tally Agent starting…");

  const alive = await tally.ping();
  if (!alive) {
    err("Cannot reach Tally on localhost:9000 — is TallyPrime open?");
    process.exit(1);
  }
  log("Tally connection OK");

  async function tick() {
    try {
      // Master data (every 10 min)
      await syncStockItems();
      await syncLedgers();
      await syncDealers();
      await syncSuppliers();

      // Payments: Tally → website (every 5 min)
      await syncPaymentsFromTally();

      // Transactional (every 30 sec)
      await syncInward();
      await syncOutward();
      await syncPaymentsToTally();
    } catch (e) {
      err("Tick error:", e.message);
    }
  }

  await tick();
  setInterval(tick, INTERVAL);
}

run().catch((e) => { err("Fatal:", e.message); process.exit(1); });
