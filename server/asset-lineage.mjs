const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
export function buildAssetLineage({assetId,assets,maxNodes=1000,maxDepth=32}={}){
 if(typeof assetId!=="string"||!assetId||!Array.isArray(assets)||!Number.isInteger(maxNodes)||maxNodes<1||maxNodes>5000||!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>64)throw new TypeError("Asset lineage input is invalid.");
 const byId=new Map();
 for(const asset of assets){if(!plain(asset)||typeof asset.id!=="string"||!asset.id)continue;if(!byId.has(asset.id))byId.set(asset.id,asset);}
 const root=byId.get(assetId);if(!root)return null;
 const parentOf=asset=>typeof asset.derivativeOf==="string"&&asset.derivativeOf?asset.derivativeOf:null;
 const ancestors=[],seen=new Set([assetId]);let cursor=root,truncated=false;
 for(let depth=0;depth<maxDepth;depth++){
  const parentId=parentOf(cursor);if(!parentId)break;
  if(seen.has(parentId)){ancestors.push({id:parentId,cycle:true});break;}
  seen.add(parentId);const parent=byId.get(parentId);
  if(!parent){ancestors.push({id:parentId,missing:true});break;}
  ancestors.push(parent);cursor=parent;
  if(depth===maxDepth-1&&parentOf(cursor))truncated=true;
 }
 const children=new Map();
 for(const asset of byId.values()){const parent=parentOf(asset);if(parent){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(asset);}}
 const descendants=[],queue=[{id:assetId,depth:0}],visited=new Set([assetId]);
 while(queue.length){
  const current=queue.shift();
  for(const child of children.get(current.id)||[]){
   if(visited.has(child.id)){descendants.push({id:child.id,cycle:true});continue;}
   if(descendants.length>=maxNodes){truncated=true;queue.length=0;break;}
   visited.add(child.id);descendants.push(child);
   if(current.depth+1<maxDepth)queue.push({id:child.id,depth:current.depth+1});else if(children.has(child.id))truncated=true;
  }
 }
 return {asset:root,ancestors,descendants,truncated,nodeCount:1+ancestors.filter(item=>!item.missing&&!item.cycle).length+descendants.filter(item=>!item.cycle).length};
}
