export type GovernanceSeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type GovernanceFindingStatus = "open" | "monitor" | "evidence_gap" | "not_assessed";
export interface GovernanceFinding {
  id: string; controlId: string; title: string; severity: GovernanceSeverity;
  status: GovernanceFindingStatus; count: number; evidence: string;
  rationale: string; recommendedAction: string;
}
export interface GovernanceControl {
  id: string; name: string; objective: string; owner: string; frequency: string;
  status: "evidence_available" | "attention" | "not_assessed";
  evidence: string; findingCount: number;
}
export interface GovernanceAssessment {
  generatedAt: string; score: number | null; scoreLabel: string;
  findings: GovernanceFinding[]; controls: GovernanceControl[];
  coverage: { available: number; total: number; missing: string[] };
  summary: { critical: number; high: number; medium: number; low: number; open: number; gaps: number };
  limitations: string[];
}
type Row = Record<string, unknown>;
type Input = {
  commandCentre?: Row | null; liquidityAlerts?: Row | null; marginAlerts?: Row | null;
  cashflowReconciliation?: Row | null; disputes?: Row | null;
  auditVerification?: Row | null; auditEvents?: Row | null;
  closeWorkflow?: Row | null; scenarioSnapshots?: Row | null;
  profitability?: Row | null; lifetimeAcquisition?: Row | null;
  asOf?: string;
};
const isObject=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const rows=(v:unknown):Row[]=>Array.isArray(v)?v.filter(isObject):[];
const countRows=(v:unknown)=>rows(v).length;
const firstArray=(o:Row|null|undefined,keys:string[])=>{if(!o)return [];for(const k of keys)if(Array.isArray(o[k]))return rows(o[k]);return [];};
const text=(v:unknown)=>typeof v==="string"?v.toLowerCase():"";
const isResolved=(r:Row)=>["resolved","closed","matched","reconciled","complete","completed","settled"].includes(text(r.status)||text(r.state));
const dateValue=(v:unknown)=>{const n=Date.parse(String(v??""));return Number.isFinite(n)?n:null;};
const add=(list:GovernanceFinding[],finding:GovernanceFinding)=>list.push(finding);
export function buildFinancialGovernanceAssessment(input:Input={}):GovernanceAssessment{
 const asOf=dateValue(input.asOf)||Date.now(), findings:GovernanceFinding[]=[];
 const command=input.commandCentre||null,liq=input.liquidityAlerts||null,margin=input.marginAlerts||null;
 const recon=input.cashflowReconciliation||null,disputes=input.disputes||null,audit=input.auditVerification||null;
 const auditEvents=input.auditEvents||null,close=input.closeWorkflow||null,scenarios=input.scenarioSnapshots||null;
 const liqRows=firstArray(liq,["alerts","items"]),marginRows=firstArray(margin,["alerts","items"]);
 const reconRows=firstArray(recon,["items","exceptions","rows"]);
 const disputeRows=firstArray(disputes,["cases","disputes","items"]);
 const overdue=disputeRows.filter(r=>!isResolved(r)&&dateValue(r.dueAt??r.deadlineAt??r.responseDueAt)!==null&&(dateValue(r.dueAt??r.deadlineAt??r.responseDueAt) as number)<asOf);
 const openRecon=reconRows.filter(r=>!isResolved(r));
 const commandExceptions=firstArray(command,["reconciliationExceptions"]).filter(r=>!isResolved(r));
 const scenariosRows=firstArray(scenarios,["snapshots"]);
 const periods=firstArray(close,["periods"]);
 const auditCount=countRows(auditEvents?.events);
 const addRows=(sourceRows:Row[],id:string,title:string,controlId:string,defaultSeverity:GovernanceSeverity,action:string)=>{
  if(!sourceRows.length)return;
  const grouped=new Map<string,Row[]>();
  for(const r of sourceRows.filter(r=>!isResolved(r))){const sev=text(r.severity??r.riskLevel??r.priority)||defaultSeverity;const key=["critical","high","medium","low"].includes(sev)?sev:defaultSeverity;grouped.set(key,[...(grouped.get(key)||[]),r]);}
  for(const [severity,group] of grouped)add(findings,{id:id+"-"+severity,controlId,title,severity:severity as GovernanceSeverity,status:"open",count:group.length,evidence:"Loaded source records",rationale:group.length+" unresolved record(s) are present in the loaded source.",recommendedAction:action});
 };
 addRows(liqRows,"liquidity","Liquidity threshold alerts","CTRL-LIQ-01","high","Treasury owner should validate the affected currency, forecast horizon, policy threshold and contingency response.");
 addRows(marginRows,"margin","Margin protection alerts","CTRL-MRG-01","medium","Finance owner should reconcile affected revenue and cost drivers, then document the approved remediation.");
 addRows(openRecon,"cash-reconciliation","Unresolved cash-flow reconciliation items","CTRL-REC-01","high","Reconciliation preparer and independent reviewer should resolve or formally explain each unmatched item.");
 addRows(commandExceptions,"command-reconciliation","Command-centre reconciliation exceptions","CTRL-REC-01","high","Reconciliation owner should trace exceptions to source settlement evidence and record independent review.");
 if(overdue.length)add(findings,{id:"dispute-deadline-overdue",controlId:"CTRL-DSP-01",title:"Overdue dispute response deadlines",severity:"critical",status:"open",count:overdue.length,evidence:"Dispute register due-date fields",rationale:overdue.length+" unresolved dispute(s) have a due date before the assessment time.",recommendedAction:"Escalate immediately to the dispute owner; preserve evidence and confirm processor response deadlines."});
 if(audit&&!Boolean(audit.valid))add(findings,{id:"audit-chain-invalid",controlId:"CTRL-AUD-01",title:"Audit-chain integrity verification failed",severity:"critical",status:"open",count:1,evidence:"Financial audit chain verification",rationale:String((audit.firstBroken as Row|undefined)?.reason||"The supplied audit chain did not verify."),recommendedAction:"Suspend reliance on this audit extract, preserve the evidence bundle and investigate the first broken sequence."});
  if(!audit)add(findings,{id:"audit-chain-not-verified",controlId:"CTRL-AUD-01",title:"Audit-chain verification not performed",severity:"unknown",status:"not_assessed",count:0,evidence:"No verification result loaded",rationale:"The current session has no verified chain result; absence of a failure is not proof of integrity.",recommendedAction:"Run the existing audit-chain verification and retain the exported evidence with an independently trusted checkpoint."});
 if(!liq)add(findings,{id:"liquidity-source-gap",controlId:"CTRL-LIQ-01",title:"Liquidity monitoring evidence unavailable",severity:"unknown",status:"evidence_gap",count:0,evidence:"Liquidity alert source unavailable",rationale:"The liquidity alert source did not load; no conclusion about liquidity risk can be drawn.",recommendedAction:"Refresh the liquidity alert source and investigate any data or authorization errors."});
 if(!margin)add(findings,{id:"margin-source-gap",controlId:"CTRL-MRG-01",title:"Margin monitoring evidence unavailable",severity:"unknown",status:"evidence_gap",count:0,evidence:"Margin alert source unavailable",rationale:"The margin alert source did not load; no conclusion about margin health can be drawn.",recommendedAction:"Refresh margin alerts and confirm the underlying profitability data is current."});
 if(!recon)add(findings,{id:"reconciliation-source-gap",controlId:"CTRL-REC-01",title:"Cash reconciliation evidence unavailable",severity:"unknown",status:"evidence_gap",count:0,evidence:"Cash-flow reconciliation source unavailable",rationale:"Reconciliation control effectiveness cannot be assessed without its evidence source.",recommendedAction:"Load cash-flow reconciliation data and obtain preparer/reviewer sign-off records."});
 if(!disputes)add(findings,{id:"dispute-source-gap",controlId:"CTRL-DSP-01",title:"Dispute deadline evidence unavailable",severity:"unknown",status:"evidence_gap",count:0,evidence:"Dispute register unavailable",rationale:"The system cannot assess open dispute exposure or deadlines without the dispute register.",recommendedAction:"Load the dispute register and validate processor due dates."});
 const specs=[
  {id:"CTRL-LIQ-01",name:"Liquidity threshold monitoring",objective:"Detect liquidity policy breaches and forecast shortfalls.",owner:"Treasury / Finance",frequency:"Each refresh",source:liq,findings:findings.filter(f=>f.controlId==="CTRL-LIQ-01")},
  {id:"CTRL-MRG-01",name:"Margin and profitability monitoring",objective:"Identify margin deterioration and unprofitable segments.",owner:"Finance / Commercial",frequency:"Each refresh",source:margin,findings:findings.filter(f=>f.controlId==="CTRL-MRG-01")},
  {id:"CTRL-REC-01",name:"Cash reconciliation and independent review",objective:"Resolve unmatched cash movements and retain reviewer evidence.",owner:"Finance preparer + independent reviewer",frequency:"Daily / close",source:recon,findings:findings.filter(f=>f.controlId==="CTRL-REC-01")},
  {id:"CTRL-DSP-01",name:"Dispute deadline and evidence control",objective:"Meet processor deadlines and retain case evidence.",owner:"Payments operations",frequency:"Daily",source:disputes,findings:findings.filter(f=>f.controlId==="CTRL-DSP-01")},
  {id:"CTRL-AUD-01",name:"Audit integrity and evidence preservation",objective:"Verify event-chain consistency and preserve independent checkpoints.",owner:"Finance control owner + independent reviewer",frequency:"Each export / review",source:audit,findings:findings.filter(f=>f.controlId==="CTRL-AUD-01")},
  {id:"CTRL-CLOSE-01",name:"Financial close governance",objective:"Require reconciliations, evidence and independent approval before close.",owner:"Controller / authorized approver",frequency:"Each period close",source:close,findings:[]},
  {id:"CTRL-SCN-01",name:"Scenario and downside review",objective:"Retain documented downside and sensitivity review for material decisions.",owner:"FP&A / Executive sponsor",frequency:"Before material decisions",source:scenarios,findings:[]}
 ];
 const controls:GovernanceControl[]=specs.map(c=>({id:c.id,name:c.name,objective:c.objective,owner:c.owner,frequency:c.frequency,status:!c.source?"not_assessed":c.findings.some(f=>f.status==="open")?"attention":"evidence_available",evidence:!c.source?"Source unavailable":c.findings.length?c.findings.length+" finding(s)":"Source loaded; operating effectiveness not independently tested",findingCount:c.findings.length}));
 const weights:Record<string,number>={critical:25,high:12,medium:5,low:2};
 const scoreFindings=findings.filter(f=>f.status==="open");
 const score=scoreFindings.length?Math.min(100,scoreFindings.reduce((sum,f)=>sum+(weights[f.severity]||0)*Math.min(f.count,5),0)):0;
 const missing=specs.filter(c=>!c.source).map(c=>c.name);
 const available=specs.length-missing.length;
 const summary={critical:findings.filter(f=>f.severity==="critical"&&f.status==="open").length,high:findings.filter(f=>f.severity==="high"&&f.status==="open").length,medium:findings.filter(f=>f.severity==="medium"&&f.status==="open").length,low:findings.filter(f=>f.severity==="low"&&f.status==="open").length,open:findings.filter(f=>f.status==="open").length,gaps:findings.filter(f=>f.status==="evidence_gap"||f.status==="not_assessed").length};
 return {generatedAt:new Date(asOf).toISOString(),score:scoreFindings.length?score:null,scoreLabel:scoreFindings.length?"Rule-based triage index · not a probability":"No open rule findings in available sources",findings,controls,coverage:{available,total:specs.length,missing},summary,limitations:["Rules operate only on records loaded in this authenticated session; missing source data is a coverage gap, not a clean result.","Severity defaults are triage labels, not a calibrated financial-loss estimate or fraud determination.","A loaded source does not prove the underlying control operated effectively; independent testing and reviewer sign-off remain necessary.","Audit-chain consistency does not detect complete historical replacement without a separately retained trusted checkpoint.","No automated transaction blocking, journal posting, payment action, approval or control override is performed."]};
}
