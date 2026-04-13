/**
 * Tally XML Gateway client — TallyPrime HTTP format
 *
 * Reading:  TYPE=Collection + inline TDL → HTTP response only, no file I/O.
 * Writing:  TYPE=Data + TALLYMESSAGE (Import) → no file dialogs.
 */

const http = require("http");
const cfg  = require("./config.json").tally;

const COMPANY   = cfg.company;
const HOST      = cfg.host;
const PORT      = cfg.port;
const FY_START  = cfg.fyStart  || "20250401";
const CASH_LED   = cfg.cashLedger || "Cash";
const BANK_LED   = cfg.bankLedger || "HDFC Bank";
const BANK_LEDS  = cfg.bankLedgers || {};

// ── Low-level XML POST ────────────────────────────────────────
function postXml(xml) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(xml, "utf8");
    const req = http.request(
      {
        host: HOST, port: PORT, method: "POST", path: "/",
        headers: { "Content-Type": "application/xml", "Content-Length": buf.length },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Tally request timed out")); });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function ok(xml) {
  if (!xml) return false;
  if (xml.includes("<LINEERROR>")) return false;
  if (xml.includes("ODBC Error"))  return false;
  return true;
}

// Extract a single tag value
function extractTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

// Today as YYYYMMDD for Tally date fields
function todayTally() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

// ── Generic collection fetch (names only) ────────────────────
async function fetchCollection(collId, type) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${collId}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${collId}" ISINITIALIZE="Yes">
            <TYPE>${type}</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  if (response.includes("UNKNOWN") || response.includes("LINEERROR")) {
    throw new Error(`Tally rejected ${type} request: ` + response.slice(0, 300));
  }

  const names = new Set();
  const attrRe = /(?:STOCKITEM|LEDGER|ITEM)\s+NAME="([^"]+)"/gi;
  let m;
  while ((m = attrRe.exec(response)) !== null) names.add(m[1].trim());
  const elemRe = /<NAME>([^<]+)<\/NAME>/gi;
  while ((m = elemRe.exec(response)) !== null) names.add(m[1].trim());
  return [...names].filter(Boolean);
}

// ── Export all stock items ────────────────────────────────────
async function getAllStockItems() {
  const names = await fetchCollection("KMTStockItems", "Stock Item");
  console.log(`[DEBUG] Stock items from Tally: ${names.length}`);
  return names;
}

// ── Export all ledgers (names only, for mapping UI) ───────────
async function getAllLedgers() {
  const names = await fetchCollection("KMTLedgers", "Ledger");
  console.log(`[DEBUG] Ledgers from Tally: ${names.length}`);
  return names;
}

// ── Generic ledger fetch with full details ─────────────────────
async function fetchLedgerGroup(collId, childOf) {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${collId}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${collId}" ISINITIALIZE="Yes">
            <TYPE>Ledger</TYPE>
            <CHILDOF>${childOf}</CHILDOF>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>MailingName</NATIVEMETHOD>
            <NATIVEMETHOD>LedgerPhone</NATIVEMETHOD>
            <NATIVEMETHOD>LedgerMobile</NATIVEMETHOD>
            <NATIVEMETHOD>LedgerEmail</NATIVEMETHOD>
            <NATIVEMETHOD>Website</NATIVEMETHOD>
            <NATIVEMETHOD>Address</NATIVEMETHOD>
            <NATIVEMETHOD>PinCode</NATIVEMETHOD>
            <NATIVEMETHOD>StateName</NATIVEMETHOD>
            <NATIVEMETHOD>LedStateName</NATIVEMETHOD>
            <NATIVEMETHOD>CountryName</NATIVEMETHOD>
            <NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
            <NATIVEMETHOD>GSTRegistrationNumber</NATIVEMETHOD>
            <NATIVEMETHOD>IncomeTaxNumber</NATIVEMETHOD>
            <NATIVEMETHOD>CreditLimit</NATIVEMETHOD>
            <NATIVEMETHOD>BillCreditPeriod</NATIVEMETHOD>
            <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  if (response.includes("UNKNOWN") || response.includes("LINEERROR")) {
    throw new Error(`Tally rejected ${childOf} ledger request: ` + response.slice(0, 300));
  }

  const results = [];
  const ledgerRe = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
  let m;
  while ((m = ledgerRe.exec(response)) !== null) {
    const name  = m[1].trim();
    const block = m[2];

    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i").exec(block);
      return r ? r[1].trim() : null;
    };

    // Address lines
    const addrLines = [];
    const addrRe = /<ADDRESS[^>]*>([^<]+)<\/ADDRESS>/gi;
    let a;
    while ((a = addrRe.exec(block)) !== null) {
      const line = a[1].trim();
      if (line) addrLines.push(line);
    }

    const city = addrLines.length > 0
      ? addrLines[addrLines.length - 1].split(",")[0].trim() || null
      : null;

    // Closing balance (Dr = positive = they owe us / we owe them)
    const closingRaw = get("CLOSINGBALANCE") || get("OPENINGBALANCE");
    let outstanding = null;
    if (closingRaw) {
      const num = parseFloat(closingRaw.replace(/[^0-9.\-]/g, ""));
      if (!isNaN(num)) outstanding = Math.abs(num);
    }

    // Credit period (days → "30 days")
    const creditPeriodRaw = get("BILLCREDITPERIOD");
    let paymentTerms = null;
    if (creditPeriodRaw) {
      const days = parseInt(creditPeriodRaw);
      if (!isNaN(days) && days > 0) paymentTerms = `${days} days`;
    }

    // Credit limit
    const creditLimitRaw = get("CREDITLIMIT");
    let creditLimit = null;
    if (creditLimitRaw) {
      const num = parseFloat(creditLimitRaw.replace(/[^0-9.\-]/g, ""));
      if (!isNaN(num) && num > 0) creditLimit = num;
    }

    results.push({
      name,
      mailing_name:  get("MAILINGNAME") || name,
      phone:         get("LEDGERPHONE"),
      phone2:        get("LEDGERMOBILE"),
      email:         get("LEDGEREMAIL") || get("EMAIL"),
      website:       get("WEBSITE"),
      address:       addrLines.join(", ") || null,
      city,
      pincode:       get("PINCODE"),
      state:         get("LEDSTATENAME") || get("STATENAME"),
      country:       get("COUNTRYNAME"),
      gst_number:    get("PARTYGSTIN") || get("GSTREGISTRATIONNUMBER"),
      pan_number:    get("INCOMETAXNUMBER"),
      credit_limit:  creditLimit,
      payment_terms: paymentTerms,
      outstanding,
    });
  }

  return results;
}

// ── Dealers (Sundry Debtors) ──────────────────────────────────
async function getDealerLedgers() {
  const dealers = await fetchLedgerGroup("KMTDealers", "Sundry Debtors");
  console.log(`[DEBUG] Parsed ${dealers.length} dealer ledgers`);
  return dealers;
}

// ── Suppliers (Sundry Creditors) ─────────────────────────────
async function getSupplierLedgers() {
  const suppliers = await fetchLedgerGroup("KMTSuppliers", "Sundry Creditors");
  console.log(`[DEBUG] Parsed ${suppliers.length} supplier ledgers`);
  return suppliers;
}

// ── Payment vouchers (Receipts) from Tally ───────────────────
async function getPaymentVouchers(fromDate, toDate) {
  const from = (fromDate || FY_START).replace(/-/g, "");
  const to   = (toDate   || todayTally()).replace(/-/g, "");

  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMTReceipts</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
        <SVFROMDATE>${from}</SVFROMDATE>
        <SVTODATE>${to}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMTReceipts" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <CHILDOF>Receipt</CHILDOF>
            <NATIVEMETHOD>Date</NATIVEMETHOD>
            <NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
            <NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
            <NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
            <NATIVEMETHOD>Amount</NATIVEMETHOD>
            <NATIVEMETHOD>Narration</NATIVEMETHOD>
            <NATIVEMETHOD>Guid</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  if (response.includes("UNKNOWN") || response.includes("LINEERROR")) {
    throw new Error("Tally rejected receipts request: " + response.slice(0, 300));
  }

  const vouchers = [];
  const vRe = /<VOUCHER\s+[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
  let m;
  while ((m = vRe.exec(response)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i").exec(block);
      return r ? r[1].trim() : null;
    };

    const dateRaw = get("DATE");
    const amtRaw  = get("AMOUNT");
    const guid    = get("GUID");
    const vchNum  = get("VOUCHERNUMBER");
    const party   = get("PARTYLEDGERNAME");

    if (!dateRaw || !amtRaw || !party) continue;

    // Date: YYYYMMDD → YYYY-MM-DD
    const date = dateRaw.length === 8
      ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
      : dateRaw;

    const amount = Math.abs(parseFloat(amtRaw.replace(/[^0-9.\-]/g, "")) || 0);
    if (amount === 0) continue;

    vouchers.push({
      tally_voucher_id: guid || vchNum,
      payment_date:     date,
      party_ledger:     party,
      amount,
      narration:        get("NARRATION"),
      voucher_number:   vchNum,
    });
  }

  console.log(`[DEBUG] Fetched ${vouchers.length} payment receipts from Tally`);
  return vouchers;
}

// ── Push payment receipt TO Tally ────────────────────────────
async function createReceiptVoucher({ date, amount, dealerLedger, mode, reference, narration }) {
  // Pick ledger: cash → Cash, hdfc/indian_bank/united_bank → specific bank, default → BANK_LED
  const cashBankLedger = mode === "cash"
    ? CASH_LED
    : (BANK_LEDS[mode] || BANK_LED);
  const dateStr = date.replace(/-/g, "");
  const narr = narration || (reference ? `Payment ref: ${reference}` : "Payment received");

  const xml = `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">
          <DATE>${dateStr}</DATE>
          <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
          <NARRATION>${narr}</NARRATION>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${cashBankLedger}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-${amount}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${dealerLedger}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>${amount}</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  const voucherId = extractTag(response, "LASTVCHID") || extractTag(response, "VCHKEY");
  return { success: ok(response), voucherId, raw: response };
}

// ── Stock summary (closing quantities per item) ───────────────
async function getStockSummary() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMTStockSummary</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMTStockSummary" ISINITIALIZE="Yes">
            <TYPE>Stock Item</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>Parent</NATIVEMETHOD>
            <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
            <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
            <NATIVEMETHOD>StandardSellingPrice</NATIVEMETHOD>
            <NATIVEMETHOD>StandardCost</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  if (response.includes("UNKNOWN") || response.includes("LINEERROR")) {
    throw new Error("Tally rejected stock summary request: " + response.slice(0, 300));
  }

  const items = [];
  const itemRe = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
  let m;
  while ((m = itemRe.exec(response)) !== null) {
    const name  = m[1].trim();
    const block = m[2];

    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i").exec(block);
      return r ? r[1].trim() : null;
    };

    // Parse "450 ROL" or "1200.5 SQF" into qty + unit
    function parseQtyUnit(raw) {
      if (!raw) return { qty: 0, unit: null };
      const match = raw.match(/^([\-\d.,]+)\s*(.*)$/);
      if (!match) return { qty: 0, unit: null };
      return {
        qty:  parseFloat(match[1].replace(/,/g, "")) || 0,
        unit: match[2].trim() || null,
      };
    }

    const closing = parseQtyUnit(get("CLOSINGBALANCE"));
    const opening = parseQtyUnit(get("OPENINGBALANCE"));

    // Standard selling price: "150/SQM" or "150.00" → extract numeric part
    const parsePrice = (raw) => {
      if (!raw) return null;
      const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
      return isNaN(num) || num === 0 ? null : num;
    };

    items.push({
      name,
      parent:          get("PARENT"),
      base_units:      get("BASEUNITS"),
      closing_qty:     closing.qty,
      closing_unit:    closing.unit,
      opening_qty:     opening.qty,
      selling_price:   parsePrice(get("STANDARDSELLINGPRICE")),
      cost_price:      parsePrice(get("STANDARDCOST")),
    });
  }

  console.log(`[DEBUG] Stock summary: ${items.length} items`);
  return items;
}

// ── Ping ──────────────────────────────────────────────────────
async function ping() {
  try {
    const xml = `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMTPing</ID>
  </HEADER>
  <BODY>
    <DESC>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMTPing" ISMODIFY="No" ISFIXED="No" ISKEYFIELD="No" RESERVEDNAME="">
            <TYPE>Company</TYPE>
            <FETCH>Name</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();
    const r = await postXml(xml);
    return r.length > 0 && !r.includes("ODBC Error") && !r.includes("UNKNOWN");
  } catch {
    return false;
  }
}

// ── Create Receipt Note (inward stock) ───────────────────────
async function createReceiptNote({ date, supplierRef, rolls, tallyItemName, supplierLedger }) {
  const ledger = supplierLedger || "Purchase Account";

  const batchEntries = rolls.map((r) => `
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>${r.roll_number}</BATCHNAME>
            <AMOUNT>0</AMOUNT>
            <ACTUALQTY>1 ROL</ACTUALQTY>
            <BILLEDQTY>1 ROL</BILLEDQTY>
          </BATCHALLOCATIONS.LIST>`).join("");

  const xml = `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Receipt Note" ACTION="Create" OBJVIEW="Invoice Voucher View">
          <DATE>${date.replace(/-/g, "")}</DATE>
          <VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
          <NARRATION>${supplierRef}</NARRATION>
          <ISINVOICE>Yes</ISINVOICE>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${ledger}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>0</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${tallyItemName}</STOCKITEMNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <RATE>0/ROL</RATE>
            <AMOUNT>0</AMOUNT>
            <ACTUALQTY>${rolls.length} ROL</ACTUALQTY>
            <BILLEDQTY>${rolls.length} ROL</BILLEDQTY>
            ${batchEntries}
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  const voucherId = extractTag(response, "LASTVCHID") || extractTag(response, "VCHKEY");
  return { success: ok(response), voucherId, raw: response };
}

// ── Create Delivery Note (outward dispatch) ───────────────────
async function createDeliveryNote({ date, orderRef, rolls, tallyItemName, customerLedger }) {
  const ledger = customerLedger || "Sales Account";

  const batchEntries = rolls.map((r) => `
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>${r.roll_number}</BATCHNAME>
            <AMOUNT>0</AMOUNT>
            <ACTUALQTY>1 ROL</ACTUALQTY>
            <BILLEDQTY>1 ROL</BILLEDQTY>
          </BATCHALLOCATIONS.LIST>`).join("");

  const xml = `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
    </DESC>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Delivery Note" ACTION="Create" OBJVIEW="Invoice Voucher View">
          <DATE>${date.replace(/-/g, "")}</DATE>
          <VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME>
          <NARRATION>${orderRef || "Dispatch"}</NARRATION>
          <ISINVOICE>Yes</ISINVOICE>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>${ledger}</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>0</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${tallyItemName}</STOCKITEMNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <RATE>0/ROL</RATE>
            <AMOUNT>0</AMOUNT>
            <ACTUALQTY>${rolls.length} ROL</ACTUALQTY>
            <BILLEDQTY>${rolls.length} ROL</BILLEDQTY>
            ${batchEntries}
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);
  const voucherId = extractTag(response, "LASTVCHID") || extractTag(response, "VCHKEY");
  return { success: ok(response), voucherId, raw: response };
}

module.exports = {
  getAllStockItems,
  getAllLedgers,
  getDealerLedgers,
  getSupplierLedgers,
  getPaymentVouchers,
  getStockSummary,
  createReceiptVoucher,
  createReceiptNote,
  createDeliveryNote,
  ping,
};
