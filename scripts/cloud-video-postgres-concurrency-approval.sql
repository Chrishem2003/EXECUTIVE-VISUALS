\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
set role authenticated;
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at
) values (
 '823e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('b',64),'USD',1,'concurrency integration test',clock_timestamp()+interval '10 minutes'
);
reset role;
