const CURRENCIES=/^[A-Z]{3}$/;
const ISO_DAY=/^\d{4}-\d{2}-\d{2}$/;
const OPERATIONS=new Set(["text","image","video","render","upscale","audio","embedding","other"]);

function firstDefined(...values){return values.find(value=>value!==undefined&&value!==null&&value!=="");}
function safeNumber(value,label,{integer=false}={}){
 if(value===undefined||value===null||value==="")return 0;
 const number=Number(value);
 if(!Number.isFinite(number)||number<0||(integer&&!Number.isSafeInteger(number)))throw Object.assign(new Error(label+" is invalid."),{code:"AI_USAGE_VALUE_INVALID"});
 return number;
}
function validDay(value){
 if(typeof value!=="string"||!ISO_DAY.test(value))return false;
 const date=new Date(value+"T00:00:00.000Z");
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}

/** Normalize OpenTelemetry GenAI attributes and common provider usage objects without retaining prompt/output content. */
export function normalizeGenAiUsage(input={}){
 const attrs=input.attributes||input;
 const usage=input.usage||input.response?.usage||input.providerUsage||{};
 const provider=String(firstDefined(attrs["gen_ai.provider.name"],attrs["gen_ai.system"],input.provider,input.providerName)||"").trim().toLowerCase();
 const requestedModel=String(firstDefined(attrs["gen_ai.request.model"],input.requestedModel,input.model,input.modelId)||"").trim();
 const responseModel=String(firstDefined(attrs["gen_ai.response.model"],input.responseModel,input.response?.model)||"").trim();
 const inputTokens=safeNumber(firstDefined(usage.billable_input_tokens,usage.input_tokens,usage.prompt_tokens,attrs["gen_ai.usage.input_tokens"],input.inputTokens),"Input token usage",{integer:true});
 const outputTokens=safeNumber(firstDefined(usage.billable_output_tokens,usage.output_tokens,usage.completion_tokens,attrs["gen_ai.usage.output_tokens"],input.outputTokens),"Output token usage",{integer:true});
 const operationRaw=String(firstDefined(attrs["gen_ai.operation.name"],input.operation,"other")).toLowerCase();
 const operationMap={chat:"text",text_completion:"text",generate_content:"other",embeddings:"embedding",image_generation:"image",video_generation:"video"};
 const operation=operationMap[operationRaw]||operationRaw;
 if(!provider||provider.length>80||!requestedModel||requestedModel.length>160||!OPERATIONS.has(operation))
  throw Object.assign(new Error("Provider, requested model or operation is missing or invalid."),{code:"AI_USAGE_IDENTITY_INVALID"});
 const occurredAt=String(firstDefined(input.occurredAt,input.timestamp,new Date().toISOString()));
 if(!Number.isFinite(Date.parse(occurredAt)))throw Object.assign(new Error("Usage timestamp is invalid."),{code:"AI_USAGE_TIMESTAMP_INVALID"});
 const status=String(firstDefined(input.status,input.error?"failed":"succeeded"));
 if(!["succeeded","failed","cancelled","unknown"].includes(status))throw Object.assign(new Error("Usage status is invalid."),{code:"AI_USAGE_STATUS_INVALID"});
 const currency=firstDefined(input.currency,usage.currency);
 if(currency!==undefined&&!CURRENCIES.test(String(currency).toUpperCase()))throw Object.assign(new Error("Usage currency is invalid."),{code:"AI_USAGE_CURRENCY_INVALID"});
 const cost=firstDefined(input.providerCostMinor,usage.cost_minor,usage.costMinor);
 const providerCostMinor=cost===undefined?null:safeNumber(cost,"Provider-reported cost",{integer:true});
 return {
  occurredAt,provider,requestedModel,responseModel:responseModel||null,
  operation,status,inputTokens,outputTokens,
  imageCount:safeNumber(firstDefined(usage.image_count,input.imageCount),"Image count"),
  videoSeconds:safeNumber(firstDefined(usage.video_seconds,input.videoSeconds),"Video seconds"),
  renderSeconds:safeNumber(firstDefined(usage.render_seconds,input.renderSeconds),"Render seconds"),
  currency:currency===undefined?null:String(currency).toUpperCase(),
  providerCostMinor,operationId:String(firstDefined(input.operationId,input.jobId,input.requestId)||""),
  ownerId:input.ownerId||null,projectId:input.projectId||null,jobId:input.jobId||null,
  traceId:String(firstDefined(input.traceId,attrs["trace_id"])||""),
  invoiceLineReference:String(firstDefined(input.invoiceLineReference,usage.invoice_line_reference)||""),
  idempotencyKey:String(input.idempotencyKey||"")
 };
}

/** Parse bounded RFC-4180-style CSV, including quoted commas, escaped quotes and embedded newlines. */
export function parseProviderInvoiceCsv(csv,{provider,currency}={}){
 if(typeof csv!=="string"||csv.length>2_000_000)throw Object.assign(new Error("Invoice CSV is missing or exceeds the 2 MB limit."),{code:"AI_INVOICE_CSV_INVALID"});
 const rows=[];let row=[],field="",quoted=false;
 for(let i=0;i<csv.length;i++){
  const ch=csv[i];
  if(quoted){
   if(ch==='"'&&csv[i+1]==='"'){field+='"';i++;}
   else if(ch==='"')quoted=false;
   else field+=ch;
  }else if(ch==='"'&&field.length===0)quoted=true;
  else if(ch==='"')throw Object.assign(new Error("Invoice CSV contains a quote inside an unquoted field."),{code:"AI_INVOICE_CSV_INVALID"});
  else if(ch===","){row.push(field);field="";}
  else if(ch==="\n"||ch==="\r"){
   if(ch==="\r"&&csv[i+1]==="\n")i++;
   row.push(field);field="";
   if(row.some(value=>value.trim()!==""))rows.push(row);
   row=[];
  }else field+=ch;
 }
 if(quoted)throw Object.assign(new Error("Invoice CSV contains an unterminated quoted field."),{code:"AI_INVOICE_CSV_INVALID"});
 row.push(field);if(row.some(value=>value.trim()!==""))rows.push(row);
 if(rows.length<2)throw Object.assign(new Error("Invoice CSV requires a header and at least one line."),{code:"AI_INVOICE_CSV_INVALID"});
 const headers=rows.shift().map((value,index)=>index===0?value.replace(/^\uFEFF/,"").trim():value.trim());
 if(new Set(headers).size!==headers.length)throw Object.assign(new Error("Invoice CSV contains duplicate column names."),{code:"AI_INVOICE_CSV_INVALID"});
 const required=["line_reference","model","operation","amount_minor","usage_period"];
 if(required.some(name=>!headers.includes(name)))throw Object.assign(new Error("Invoice CSV is missing required columns: "+required.join(", ")),{code:"AI_INVOICE_CSV_COLUMNS_INVALID"});
 if(!provider||!currency||!CURRENCIES.test(String(currency).toUpperCase()))throw Object.assign(new Error("Invoice provider and currency are required."),{code:"AI_INVOICE_IDENTITY_INVALID"});
 if(rows.length>5000)throw Object.assign(new Error("Invoice CSV exceeds 5,000 lines."),{code:"AI_INVOICE_LINE_LIMIT"});
 return rows.map((values,index)=>{
  if(values.length!==headers.length)throw Object.assign(new Error("Invoice CSV row "+(index+2)+" has an inconsistent number of columns."),{code:"AI_INVOICE_CSV_ROW_INVALID"});
  const record=Object.fromEntries(headers.map((header,i)=>[header,values[i].trim()]));
  const amountText=record.amount_minor;
  if(!/^-?\d{1,18}$/.test(amountText)||!Number.isSafeInteger(Number(amountText))||!validDay(record.usage_period)||
   !record.line_reference||record.line_reference.length>180||!record.model||record.model.length>160||
   !OPERATIONS.has(record.operation)||record.usage_quantity!==undefined&&record.usage_quantity!==""&&(!Number.isFinite(Number(record.usage_quantity))||Number(record.usage_quantity)<0))
   throw Object.assign(new Error("Invoice CSV row "+(index+2)+" contains invalid line data."),{code:"AI_INVOICE_CSV_ROW_INVALID"});
  return {provider,currency:String(currency).toUpperCase(),lineReference:record.line_reference,
   model:record.model,operation:record.operation,amountMinor:Number(amountText),usagePeriod:record.usage_period,
   usageQuantity:record.usage_quantity===""?null:record.usage_quantity===undefined?null:Number(record.usage_quantity),
   usageUnit:record.usage_unit||"",ownerId:record.owner_id||null,projectId:record.project_id||null,jobId:record.job_id||null};
 });
}
