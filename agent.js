/**
 * KMT Tally Sync Agent
 *
 * Runs on the office PC. Every 30 seconds:
 *   1. Syncs all Tally stock items → Supabase (for mapping UI)
 *   2. Finds pending inward consignments → creates Receipt Notes in Tally
 *   3. Finds pending dispatched rolls → creates Delivery Notes in Tally
 *
 * Usage:
 *   node agent.js          (foreground, shows logs)
 *   node agent.js --silent (background/service mode)
 */

const tally    = require("./tally");
const db       = require("./supabase");
const cfg      = require("./config.json");

const INTERVAL = (cfg.sync?.intervalSeconds ?? 30) * 1000;
const silent   = process.argv.includes("--silent");

function log(...args) {
  if (!silent) console.log(new Date().toLocaleTimeString("en-IN"), ...args);
}

function err(...args) {
  console.error(new Date().toLocaleTimeString("en-IN"), "[ERR]", ...args);
}

// ── Stock item sync (runs once at startup, then every 10 min) ─
let lastItemSync = 0;
async function syncStockItems() {
  if (Date.now() - lastItemSync < 10 * 60 * 1000) return;
  try {
    log("Fetching stock items from Tally…");
    const names = await tally.getAllStockItems();
    log(`Got ${names.length} stock items from Tally`);
    if (names.length > 0) {
      log("Saving stock items to Supabase…");
      const res = await db.upsertTallyStockItems(names);
      log(`Stock items synced: ${names.length} items (HTTP ${res.status})`);
    }
    lastItemSync = Date.now();
  } catch (e) {
    err("Stock item sync failed:", e.message);
  }
}

// ── Inward sync (pending consignments → Receipt Notes) ────────
async function syncInward() {
  const consignments = await db.getPendingInwardConsignments();
  if (!consignments.length) return;

  const itemMap = await db.getTallyItemMap();
  log(`Inward: ${consignments.length} consignment(s) pending`);

  for (const c of consignments) {
    const rolls = c.rolls ?? [];
    if (!rolls.length) continue;

    // Group rolls by (product, design_code) → each group = one inventory line
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
        err(`No Tally mapping for ${key} — skipping. Set it in Admin → Tally Bridge → Mapping`);
        consignmentOk = false;
        continue;
      }

      const result = await tally.createReceiptNote({
        date: c.inward_date,
        supplierRef: c.supplier_ref,
        rolls: groupRolls,
        tallyItemName,
      });

      if (result.success) {
        await db.markRollsSynced(groupRolls.map((r) => r.roll_number));
        log(`Receipt Note created: ${c.supplier_ref} | ${tallyItemName} | ${groupRolls.length} rolls`);
      } else {
        await db.markRollsFailed(groupRolls.map((r) => r.roll_number));
        err(`Receipt Note failed: ${c.supplier_ref} | ${tallyItemName}`, result.raw?.slice(0, 200));
        consignmentOk = false;
      }
    }

    if (consignmentOk) {
      await db.markConsignmentSynced(c.id, null);
    }
  }
}

// ── Outward sync (dispatched rolls → Delivery Notes) ──────────
async function syncOutward() {
  const rolls = await db.getPendingDispatchedRolls();
  if (!rolls.length) return;

  const itemMap = await db.getTallyItemMap();
  log(`Outward: ${rolls.length} dispatched roll(s) pending`);

  // Group by (dispatch_date, order_id, product, design_code)
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
      date,
      orderRef,
      rolls: groupRolls,
      tallyItemName,
    });

    if (result.success) {
      await db.markRollsSynced(groupRolls.map((r) => r.roll_number));
      log(`Delivery Note created: ${tallyItemName} | ${groupRolls.length} rolls | ${date}`);
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
      await syncStockItems();
      await syncInward();
      await syncOutward();
    } catch (e) {
      err("Tick error:", e.message);
    }
  }

  await tick();
  setInterval(tick, INTERVAL);
}

run().catch((e) => { err("Fatal:", e.message); process.exit(1); });
