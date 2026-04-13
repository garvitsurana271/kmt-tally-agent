/**
 * Tally XML Gateway client — TallyPrime HTTP format
 *
 * Reading:  TYPE=Collection + inline TDL → HTTP response only, no file I/O.
 * Writing:  TYPE=Data + TALLYMESSAGE (Import) → no file dialogs.
 */

const http = require("http");
const cfg  = require("./config.json").tally;

const COMPANY = cfg.company;
const HOST    = cfg.host;
const PORT    = cfg.port;

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

// Extract a single tag value: <TAGNAME>value</TAGNAME>
function extractTag(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]+)<\/${tag}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
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
  // Attribute form: <STOCKITEM NAME="..."> or <LEDGER NAME="...">
  const attrRe = /(?:STOCKITEM|LEDGER|ITEM)\s+NAME="([^"]+)"/gi;
  let m;
  while ((m = attrRe.exec(response)) !== null) names.add(m[1].trim());
  // Element form: <NAME>...</NAME>
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

// ── Export dealer ledgers (Sundry Debtors) with full details ──
async function getDealerLedgers() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMTDealers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMTDealers" ISINITIALIZE="Yes">
            <TYPE>Ledger</TYPE>
            <CHILDOF>Sundry Debtors</CHILDOF>
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
    throw new Error("Tally rejected dealer request: " + response.slice(0, 300));
  }

  // Debug: print first LEDGER block to see actual tag names
  const firstBlock = /<LEDGER\s[^>]+>[\s\S]*?<\/LEDGER>/i.exec(response);
  if (firstBlock) console.log("[DEBUG] First LEDGER block:\n", firstBlock[0].slice(0, 2000));

  // Parse each LEDGER block
  const dealers = [];
  const ledgerRe = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
  let m;
  while ((m = ledgerRe.exec(response)) !== null) {
    const name  = m[1].trim();
    const block = m[2];

    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i").exec(block);
      return r ? r[1].trim() : null;
    };

    // Address can be multi-line: collect all <ADDRESS> elements
    const addrLines = [];
    const addrRe = /<ADDRESS[^>]*>([^<]+)<\/ADDRESS>/gi;
    let a;
    while ((a = addrRe.exec(block)) !== null) {
      const line = a[1].trim();
      if (line) addrLines.push(line);
    }

    // City: last address line, first comma-segment
    const city = addrLines.length > 0
      ? addrLines[addrLines.length - 1].split(",")[0].trim() || null
      : null;

    // ClosingBalance: positive Dr = dealer owes us, negative Cr = we owe them
    const closingRaw = get("CLOSINGBALANCE") || get("OPENINGBALANCE");
    let outstanding = null;
    if (closingRaw) {
      const num = parseFloat(closingRaw.replace(/[^0-9.\-]/g, ""));
      if (!isNaN(num)) outstanding = Math.abs(num); // Dr balance = positive outstanding
    }

    // CreditPeriod: Tally stores as number of days e.g. "30 Days"
    const creditPeriodRaw = get("BILLCREDITPERIOD");
    let paymentTerms = null;
    if (creditPeriodRaw) {
      const days = parseInt(creditPeriodRaw);
      if (!isNaN(days) && days > 0) paymentTerms = `${days} days`;
    }

    // CreditLimit: stored as Amount
    const creditLimitRaw = get("CREDITLIMIT");
    let creditLimit = null;
    if (creditLimitRaw) {
      const num = parseFloat(creditLimitRaw.replace(/[^0-9.\-]/g, ""));
      if (!isNaN(num) && num > 0) creditLimit = num;
    }

    dealers.push({
      name,
      mailing_name:    get("MAILINGNAME") || name,
      phone:           get("LEDGERPHONE"),
      phone2:          get("LEDGERMOBILE"),
      email:           get("LEDGEREMAIL") || get("EMAIL"),
      website:         get("WEBSITE"),
      address:         addrLines.join(", ") || null,
      city,
      pincode:         get("PINCODE"),
      state:           get("LEDSTATENAME") || get("STATENAME"),
      country:         get("COUNTRYNAME"),
      gst_number:      get("PARTYGSTIN") || get("GSTREGISTRATIONNUMBER"),
      pan_number:      get("INCOMETAXNUMBER"),
      credit_limit:    creditLimit,
      payment_terms:   paymentTerms,
      outstanding,
    });
  }

  console.log(`[DEBUG] Parsed ${dealers.length} dealer ledgers`);
  return dealers;
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

module.exports = { getAllStockItems, getAllLedgers, getDealerLedgers, createReceiptNote, createDeliveryNote, ping };
