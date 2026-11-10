import test from "node:test";
import assert from "node:assert/strict";
import {detectDuplicateInvoices,reconcileProviderInvoiceLines,reconcilePaymentSettlement} from "../financial-reconciliation.mjs";

test("duplicate invoice scan normalizes provider references without conflating currencies",()=>{
 const result=detectDuplicateInvoices({invoices:[
  {provider:"Vendor-A",invoiceReference:" INV-001 ",currency:"USD",totalMinor:1000,sourceId:"a"},
  {provider:"vendor-a",invoiceReference:"inv 001",currency:"USD",totalMinor:1000,sourceId:"b"},
  {provider:"vendor-a",invoiceReference:"INV-001",currency:"UGX",totalMinor:1000,sourceId:"c"}
 ]});
 assert.equal(result.duplicateGroups,1);
 assert.equal(result.duplicates[0].records.length,2);
 assert.equal(result.status,"exceptions_found");
});

test("invoice lines require exact one-to-one usage, amount, currency, model, operation and period",()=>{
 const result=reconcileProviderInvoiceLines({
  invoiceLines:[
   {provider:"p",lineReference:"line-1",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",amountMinor:500},
   {provider:"p",lineReference:"line-2",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",amountMinor:700},
   {provider:"p",lineReference:"line-3",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",amountMinor:300}
  ],
  usageEvents:[
   {id:"u1",provider:"p",invoiceLineReference:"line-1",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",providerCostMinor:500,status:"succeeded"},
   {id:"u2",provider:"p",invoiceLineReference:"line-2",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",providerCostMinor:650,status:"succeeded"},
   {id:"u3",provider:"p",invoiceLineReference:"line-4",currency:"USD",model:"m1",operation:"video",usagePeriod:"2026-11-01",providerCostMinor:200,status:"succeeded"}
  ]
 });
 assert.equal(result.counts.matched,1);
 assert.equal(result.counts.variance,1);
 assert.equal(result.counts.unmatched,2);
 assert.equal(result.automaticPosting,false);
 assert.equal(result.totals.currencyTotals.invoice.USD,1500);
});

test("invoice reconciliation refuses ambiguous duplicate usage references",()=>{
 const line={provider:"p",lineReference:"line-1",currency:"UGX",model:"m",operation:"image",usagePeriod:"2026-11-01",amountMinor:100};
 const usage={provider:"p",invoiceLineReference:"line-1",currency:"UGX",model:"m",operation:"image",usagePeriod:"2026-11-01",providerCostMinor:100};
 const result=reconcileProviderInvoiceLines({invoiceLines:[line],usageEvents:[{...usage,id:"a"},{...usage,id:"b"}]});
 assert.equal(result.counts.duplicate,1);
 assert.equal(result.status,"exceptions_found");
});

test("payment settlement matches only exact settled records and detects duplicates and amount variances",()=>{
 const result=reconcilePaymentSettlement({
  statementRows:[
   {provider:"flw",providerReference:"TX-1",currency:"UGX",amountMinor:10000},
   {provider:"flw",providerReference:"TX-2",currency:"UGX",amountMinor:9000},
   {provider:"flw",providerReference:"TX-2",currency:"UGX",amountMinor:9000},
   {provider:"flw",providerReference:"TX-3",currency:"USD",amountMinor:100}
  ],
  payments:[
   {id:"p1",provider:"flw",providerReference:"tx 1",currency:"UGX",amountMinor:10000,status:"settled"},
   {id:"p2",provider:"flw",providerReference:"tx-2",currency:"UGX",amountMinor:8000,status:"succeeded"}
  ]
 });
 assert.equal(result.counts.matched,1);
 assert.equal(result.counts.duplicate,1);
 assert.equal(result.counts.variance,1);
 assert.equal(result.counts.unmatched,2);
 assert.equal(result.automaticPosting,false);
 assert.equal(result.totals.currencyTotals.statement.UGX,28000);
});

test("invalid currencies, non-integer minor units and excessive rows fail closed",()=>{
 assert.throws(()=>detectDuplicateInvoices({invoices:[{provider:"p",invoiceReference:"x",currency:"US",totalMinor:1}]}),{code:"FINANCIAL_RECON_CURRENCY_INVALID"});
 assert.throws(()=>reconcilePaymentSettlement({statementRows:[{provider:"p",providerReference:"x",currency:"USD",amountMinor:1.2}],payments:[]}),{code:"FINANCIAL_RECON_AMOUNT_INVALID"});
 assert.throws(()=>reconcileProviderInvoiceLines({invoiceLines:new Array(5001).fill({}),usageEvents:[]}),{code:"FINANCIAL_RECON_ROWS_INVALID"});
});
