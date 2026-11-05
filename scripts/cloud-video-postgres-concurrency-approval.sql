\set ON_ERROR_STOP on
select set_config('request.jwt.claim.role','service_role',false);
set role service_role;
insert into executive_visuals.runway_router_approvals(
 id,owner_id,project_id,config_id,provider,model,input_hash,request_hash,
 estimated_credits,max_estimated_credits,expires_at
) values (
 '923e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'creative_low_cost','runway','gen4.5',repeat('e',64),repeat('b',64),
 24,30,clock_timestamp()+interval '10 minutes'
);
insert into executive_visuals.video_generation_budget_approvals(
 id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,
 approval_note,expires_at,router_approval_id,router_input_hash
) values (
 '823e4567-e89b-42d3-a456-426614174000',
 '123e4567-e89b-42d3-a456-426614174000',
 '323e4567-e89b-42d3-a456-426614174000',
 'runway','gen4.5',repeat('b',64),'USD',1,'concurrency integration test',
 clock_timestamp()+interval '10 minutes',
 '923e4567-e89b-42d3-a456-426614174000',repeat('e',64)
);
reset role;
select set_config('request.jwt.claim.sub','123e4567-e89b-42d3-a456-426614174000',false);
select set_config('request.jwt.claim.role','authenticated',false);
set role authenticated;
select executive_visuals.approve_runway_router_preflight('923e4567-e89b-42d3-a456-426614174000');
reset role;
