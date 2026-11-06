export type ReviewVersionScope="all"|"current"|"previous"|"unlinked";
export interface VersionedReview { timelineId:string|null; timelineRevision:number|null }
export interface TimelineRevision { id:string; revision:number }
export function filterReviewsByTimelineRevision<T extends VersionedReview>(
 reviews:readonly T[],
 timelines:readonly TimelineRevision[],
 scope:ReviewVersionScope
):T[]{
 if(scope==="all")return [...reviews];
 const currentRevision=new Map(timelines.map(timeline=>[timeline.id,timeline.revision]));
 return reviews.filter(review=>{
  if(scope==="unlinked")return review.timelineId===null&&review.timelineRevision===null;
  if(!review.timelineId||review.timelineRevision===null)return false;
  const current=currentRevision.get(review.timelineId);
  if(current===undefined)return false;
  return scope==="current"?review.timelineRevision===current:review.timelineRevision<current;
 });
}
