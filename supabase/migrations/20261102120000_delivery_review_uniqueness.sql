-- Prevent concurrent duplicate delivery decisions by the same reviewer for the same immutable receipt.
-- Different reviewers may independently review the same delivery.
-- Recreate the index so a previous draft definition cannot retain the broader uniqueness scope.
drop index if exists executive_visuals.ev_delivery_review_reviewer_fingerprint_unique;

create unique index ev_delivery_review_reviewer_fingerprint_unique
  on executive_visuals.job_events (
    job_id,
    owner_id,
    (event_data ->> 'reviewerId'),
    (event_data ->> 'fingerprint')
  )
  where event_type = 'delivery.reviewed'
    and event_data ? 'reviewerId'
    and event_data ? 'fingerprint'
    and (event_data ->> 'reviewerId') ~ '^[0-9a-f-]{36}$'
    and (event_data ->> 'fingerprint') ~ '^[a-f0-9]{64}$';

comment on index executive_visuals.ev_delivery_review_reviewer_fingerprint_unique is
  'Enforces one delivery review decision per reviewer, render job and SHA-256 receipt fingerprint while allowing independent reviewers.';
