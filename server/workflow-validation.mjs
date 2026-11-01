const mediaTypes=new Set(["image","video","audio","mask","asset","media","identity-reference","style-reference","product-reference","start-frame","end-frame","keyframe","motion-reference","proxy","3d-scene","mesh","timeline-package"]);
function compatible(source,target){return source===target||source==="any"||target==="any"||(target==="media"&&mediaTypes.has(source))||(target==="asset"&&mediaTypes.has(source))||(target==="start-frame"&&(source==="image"||source==="asset"||source==="media"));}
export function validateWorkflowGraph(graph){
 const issues=[];
 if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return {valid:false,issues:[{code:"invalid_graph",message:"Workflow requires node and edge arrays."}],executionOrder:[]};
 if(graph.nodes.length>500||graph.edges.length>2000)return {valid:false,issues:[{code:"graph_limit_exceeded",message:"Workflow exceeds the configured node or edge limit."}],executionOrder:[]};
 const nodes=new Map(),edgeIds=new Set(),incoming=new Map(),outgoing=new Map(),connected=new Set();
 for(const node of graph.nodes){
  if(!node||typeof node.id!=="string"||!node.id.trim()){issues.push({code:"invalid_node_id",message:"Every node needs a non-empty ID."});continue;}
  if(nodes.has(node.id)){issues.push({code:"duplicate_node",nodeId:node.id,message:"Duplicate node ID: "+node.id});continue;}
  nodes.set(node.id,node);incoming.set(node.id,new Set());outgoing.set(node.id,new Set());
 }
 for(const edge of graph.edges){
  if(!edge||typeof edge.id!=="string"||!edge.id.trim()){issues.push({code:"invalid_edge_id",message:"Every edge needs a non-empty ID."});continue;}
  if(edgeIds.has(edge.id)){issues.push({code:"duplicate_edge",edgeId:edge.id,message:"Duplicate edge ID: "+edge.id});continue;}
  edgeIds.add(edge.id);
  const source=nodes.get(edge.sourceNodeId),target=nodes.get(edge.targetNodeId);
  if(!source||!target){issues.push({code:"missing_node",edgeId:edge.id,message:"Edge references a missing source or target node."});continue;}
  const output=(source.outputs||[]).find(port=>port.id===edge.sourcePortId);
  const input=(target.inputs||[]).find(port=>port.id===edge.targetPortId);
  if(!output||!input){issues.push({code:"missing_port",edgeId:edge.id,message:"Edge references a missing input or output port."});continue;}
  if(!compatible(output.type,input.type)){issues.push({code:"incompatible_ports",edgeId:edge.id,message:"Port types "+output.type+" and "+input.type+" are incompatible."});continue;}
  const key=target.id+":"+input.id;
  if(!input.multiple&&connected.has(key)){issues.push({code:"duplicate_input",nodeId:target.id,edgeId:edge.id,message:"Input accepts only one connection."});continue;}
  connected.add(key);outgoing.get(source.id).add(target.id);incoming.get(target.id).add(source.id);
 }
 for(const node of nodes.values())for(const input of node.inputs||[])if(input.required&&!connected.has(node.id+":"+input.id)&&!(node.config&&Object.hasOwn(node.config,input.id)))issues.push({code:"required_input_missing",nodeId:node.id,message:"Required input is not connected or configured: "+input.id});
 const degree=new Map([...incoming].map(([id,parents])=>[id,parents.size]));
 const ready=[...nodes.keys()].filter(id=>degree.get(id)===0),executionOrder=[];
 while(ready.length){const id=ready.shift();executionOrder.push(id);for(const child of outgoing.get(id)||[]){const value=degree.get(child)-1;degree.set(child,value);if(value===0)ready.push(child);}}
 if(executionOrder.length!==nodes.size)issues.push({code:"cycle_detected",message:"Workflow contains a dependency cycle."});
 return {valid:issues.length===0,issues,executionOrder};
}

export function planWorkflowTarget(graph,target={kind:"all"}){
 const validation=validateWorkflowGraph(graph);
 const issues=[...validation.issues];
 const nodes=new Map((graph?.nodes||[]).map(node=>[node.id,node]));
 let requested=[];
 if(target?.kind==="all")requested=[...nodes.keys()];
 else if(target?.kind==="node")requested=[target.nodeId];
 else if(target?.kind==="subgraph"&&Array.isArray(target.nodeIds))requested=target.nodeIds;
 else issues.push({code:"invalid_execution_target",message:"Choose all nodes, one node, or a selected subgraph."});
 if(!requested.length)issues.push({code:"invalid_execution_target",message:"At least one target node is required."});
 for(const id of requested)if(!nodes.has(id))issues.push({code:"invalid_execution_target",nodeId:id,message:"Target node does not exist: "+id});
 const parents=new Map([...nodes.keys()].map(id=>[id,new Set()]));
 for(const edge of graph?.edges||[])if(nodes.has(edge.sourceNodeId)&&nodes.has(edge.targetNodeId))parents.get(edge.targetNodeId).add(edge.sourceNodeId);
 const included=new Set();
 const visit=id=>{
  if(included.has(id))return;
  included.add(id);
  const node=nodes.get(id);
  if(node?.locked&&(node.lockedOutputIds?.length||0)>0)return;
  for(const parent of parents.get(id)||[])visit(parent);
 };
 if(target?.kind==="all")for(const id of requested)included.add(id);
 else for(const id of requested)if(nodes.has(id))visit(id);
 const executionOrder=validation.executionOrder.filter(id=>included.has(id));
 const runNodeIds=[],reusedNodeIds=[];
 for(const id of executionOrder){
  const node=nodes.get(id);
  if(node?.locked){
   if(!(node.lockedOutputIds?.length)){issues.push({code:"locked_node_missing_output",nodeId:id,message:"Locked node has no saved output to reuse: "+id});}
   else reusedNodeIds.push(id);
  }else runNodeIds.push(id);
 }
 return {valid:issues.length===0,target,includedNodeIds:executionOrder,executionOrder,runNodeIds,reusedNodeIds,issues};
}
