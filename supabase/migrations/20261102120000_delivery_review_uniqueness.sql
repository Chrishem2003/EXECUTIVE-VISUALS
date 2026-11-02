-- Prevent concurrent duplicate delivery decisions for the same reviewer and immutable receipt.
-- A different reviewer may still record their own independent decision.
create unique index if not exists ev_delivery_review_reviewer_fingerprint_unique
  on executive_visuals.job_events (
    job_id,
    owner_id,
    (event_data ->> 'fingerprint')
  )
  where event_type = 'delivery.reviewed'
    and event_data ? 'fingerprint'
    and (event_data ->> 'fingerprint') ~ '^[a-f0-9]{64}$';

comment on index executive_visuals.ev_delivery_review_reviewer_fingerprint_unique is
  'Enforces one delivery review decision per reviewer, render job and SHA-256 receipt fingerprint, including concurrent requests.';
