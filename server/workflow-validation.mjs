const mediaTypes=new Set(["image","video","audio","mask","asset","media","identity-reference","style-reference","product-reference","start-frame","end-frame","keyframe","motion-reference","proxy","3d-scene","mesh","timeline-package"]);
function compatible(source,target){return source===target||source==="any"||target==="any"||(target==="media"&&mediaTypes.has(source))||(target==="asset"&&mediaTypes.has(source));}
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
