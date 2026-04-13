/**
 * Tally XML Gateway client — TallyPrime HTTP format
 *
 * Reading data: use TYPE=Collection with inline TDL definition.
 * This returns data in the HTTP response body — no file I/O, no Excel popup.
 *
 * Writing data: use TYPE=Data with TALLYMESSAGE (Import).
 * Import requests never trigger file export dialogs.
 */

const http = require("http");
const cfg  = require("./config.json").tally;

const COMPANY = cfg.company;
const HOST    = cfg.host;
const PORT    = cfg.port;

// ── Low-level XML POST with timeout ──────────────────────────
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

// ── Export all stock items via TDL Collection ─────────────────
async function getAllStockItems() {
  const xml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMTStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMTStockItems" ISINITIALIZE="Yes">
            <TYPE>Stock Item</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`.trim();

  const response = await postXml(xml);

  // Debug: show raw response so we can verify Tally's XML shape
  console.log("[DEBUG] Tally raw (first 800 chars):\n", response.slice(0, 800));

  if (response.includes("UNKNOWN") || response.includes("LINEERROR")) {
    throw new Error("Tally rejected request: " + response.slice(0, 300));
  }

  // TallyPrime may return names as:
  //   <STOCKITEM NAME="ItemName"> attributes, OR
  //   <NAME>ItemName</NAME> elements inside each object
  const names = new Set();

  // Try attribute form: NAME="..."
  const attrRe = /(?:STOCKITEM|ITEM)\s+NAME="([^"]+)"/gi;
  let m;
  while ((m = attrRe.exec(response)) !== null) names.add(m[1].trim());

  // Try element form: <NAME>...</NAME>
  const elemRe = /<NAME>([^<]+)<\/NAME>/gi;
  while ((m = elemRe.exec(response)) !== null) names.add(m[1].trim());

  return [...names].filter(Boolean);
}

// ── Ping: simple collection request, no file I/O ─────────────
async function ping() {
  try {
    const xml = `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>KMT Ping</ID>
  </HEADER>
  <BODY>
    <DESC>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="KMT Ping" ISMODIFY="No" ISFIXED="No" ISKEYFIELD="No" RESERVEDNAME="">
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
async function createReceiptNote({ date, supplierRef, rolls, tallyItemName }) {
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
            <LEDGERNAME>Purchase Account</LEDGERNAME>
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
  return { success: ok(response), raw: response };
}

// ── Create Delivery Note (outward dispatch) ───────────────────
async function createDeliveryNote({ date, orderRef, rolls, tallyItemName }) {
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
            <LEDGERNAME>Sales Account</LEDGERNAME>
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
  return { success: ok(response), raw: response };
}

module.exports = { getAllStockItems, createReceiptNote, createDeliveryNote, ping };
