-- Supabase Free projects cap the global maximum individual object size at 50 MiB.
-- Keep the private media bucket aligned with that plan-level constraint.
do $$
begin
  update storage.buckets
     set file_size_limit = 52428800
   where id = 'executive-visuals-media'
     and (file_size_limit is null or file_size_limit > 52428800);

  if not found then
    if not exists (select 1 from storage.buckets where id = 'executive-visuals-media') then
      raise exception 'Required private media bucket executive-visuals-media is missing';
    end if;
  end if;
end
$$;
