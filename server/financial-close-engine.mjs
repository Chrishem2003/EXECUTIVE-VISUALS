const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const required=(value,label,max=180)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("FINANCIAL_CLOSE_INPUT_INVALID",label+" must be a non-empty string of at most "+max+" characters.");
 return value.trim();
};
const uuid=(value,label)=>{const v=required(value,label,64);if(!UUID.test(v))fail("FINANCIAL_CLOSE_UUID_INVALID",label+" must be a UUID.");return v;};
const period=value=>{
 const v=required(value,"period",7);
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(v))fail("FINANCIAL_CLOSE_PERIOD_INVALID","period must use YYYY-MM format.");
 return v;
};
const iso=(value,label)=>{
 if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail("FINANCIAL_CLOSE_TIMESTAMP_INVALID",label+" must be a canonical UTC ISO timestamp.");
 return value;
};
const uniqueUuids=(values,label,min=1,max=5)=>{
 if(!Array.isArray(values)||values.length<min||values.length>max)fail("FINANCIAL_CLOSE_APPROVERS_INVALID",label+" must contain "+min+" to "+max+" approver UUIDs.");
 const result=values.map((v,i)=>uuid(v,label+"["+i+"]"));
 if(new Set(result).size!==result.length)fail("FINANCIAL_CLOSE_APPROVERS_INVALID",label+" cannot contain duplicate approvers.");
 return result;
};
export const FINANCIAL_CLOSE_ACTION_EVENT_TYPES=Object.freeze({
 "period.open":"close_period.created",
 "task.create":"close_task.assigned",
 "task.assign":"close_task.assigned",
 "task.start":"close_task.started",
 "task.submit":"close_task.submitted",
 "task.approve":"close_task.approved",
 "task.reject":"close_task.rejected",
 "task.waive":"close_task.waived",
 "period.submit":"close_period.submitted",
 "period.approve":"close_period.approved",
 "period.lock":"close_period.locked",
 "period.reopen":"close_period.reopened"
});
export function prepareFinancialCloseCommand(input={}){
 const action=required(input.action,"action",48);
 const eventType=FINANCIAL_CLOSE_ACTION_EVENT_TYPES[action];
 if(!eventType)fail("FINANCIAL_CLOSE_ACTION_INVALID","Unsupported financial close action.");
 const closePeriod=period(input.period);
 const raw=input.payload&&typeof input.payload==="object"&&!Array.isArray(input.payload)?input.payload:{};
 const payload={action,period:closePeriod};
 if(action==="period.open"){
  const currency=required(raw.currency,"currency",3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))fail("FINANCIAL_CLOSE_CURRENCY_INVALID","currency must be a three-letter ISO code.");
  payload.currency=currency;
  payload.label=raw.label==null?closePeriod:required(raw.label,"label",120);
  payload.periodEnd=raw.periodEnd==null?null:iso(raw.periodEnd,"periodEnd");
 }else if(action==="task.create"){
  payload.taskId=uuid(raw.taskId,"taskId");
  payload.title=required(raw.title,"title",180);
  payload.description=raw.description==null?"":required(raw.description,"description",2000);
  payload.assignedTo=uuid(raw.assignedTo,"assignedTo");
  payload.approverIds=uniqueUuids(raw.approverIds,"approverIds",1,5);
  if(payload.approverIds.includes(payload.assignedTo))fail("FINANCIAL_CLOSE_SELF_APPROVAL","A task assignee cannot approve their own work.");
  payload.dueAt=raw.dueAt==null?null:iso(raw.dueAt,"dueAt");
  payload.dependencies=raw.dependencies==null?[]:uniqueUuids(raw.dependencies,"dependencies",0,100);
  if(payload.dependencies.includes(payload.taskId))fail("FINANCIAL_CLOSE_DEPENDENCY_CYCLE","A task cannot depend on itself.");
 }else if(action==="task.assign"){
  payload.taskId=uuid(raw.taskId,"taskId");
  payload.assignedTo=uuid(raw.assignedTo,"assignedTo");
  payload.approverIds=uniqueUuids(raw.approverIds,"approverIds",1,5);
  if(payload.approverIds.includes(payload.assignedTo))fail("FINANCIAL_CLOSE_SELF_APPROVAL","A task assignee cannot approve their own work.");
 }else if(action==="task.start"||action==="task.submit"||action==="task.approve"){
  payload.taskId=uuid(raw.taskId,"taskId");
  if(action==="task.submit"){
   if(!Array.isArray(raw.evidenceRefs)||raw.evidenceRefs.length<1||raw.evidenceRefs.length>100)fail("FINANCIAL_CLOSE_EVIDENCE_REQUIRED","Submitting a task requires 1–100 evidence references.");
   payload.evidenceRefs=raw.evidenceRefs.map((v,i)=>required(v,"evidenceRefs["+i+"]",180));
   payload.completionNote=raw.completionNote==null?"":required(raw.completionNote,"completionNote",1000);
  }
  if(action==="task.approve"&&raw.comment!=null)payload.comment=required(raw.comment,"comment",1000);
 }else if(action==="task.reject"||action==="task.waive"||action==="period.reopen"){
  if(action!=="period.reopen")payload.taskId=uuid(raw.taskId,"taskId");
  payload.reason=required(raw.reason,"reason",1000);
 }else if(action==="period.submit"||action==="period.approve"||action==="period.lock"){
  if(raw.comment!=null)payload.comment=required(raw.comment,"comment",1000);
 }
 return {action,period:closePeriod,eventType,payload};
}
