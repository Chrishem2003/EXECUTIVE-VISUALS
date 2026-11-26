# Batch 140 — staging private storage acceptance

This is an owner-triggered, staging-only acceptance test for the existing private Supabase Storage bucket. It is deliberately not part of ordinary pull-request CI because it creates and deletes a temporary object in the connected staging bucket.

## Safety boundary
- The script refuses to run unless the Supabase URL identifies the approved staging project `bokxljngydmqrmktofwm`.
- Both test JWTs are verified with Supabase Auth; the configured owner UUID must match the verified owner, and the second identity must be different.
- The bucket metadata must confirm `public=false` before any object is created.
- The test writes one small text object beneath the owner UUID and a random asset UUID.
- It verifies owner-authenticated read, denial to a second authenticated user, and a short-lived signed-URL read.
- It deletes the exact temporary object in a `finally` cleanup path. A cleanup failure is reported as a failed test, never as a pass.
- Credential values, JWTs, signed URLs and object contents are never printed.

## Run
Configure the GitHub `staging` environment with the required secrets and variables, then manually run the `Staging private storage round-trip acceptance` workflow. The script does not run on pull requests and does not touch production.

## Interpretation
A pass demonstrates the real configured staging bucket can store and return a private object, owner access works, cross-user access is denied, signed downloads work and the test object is removed. It does not verify project-member sharing, large multipart uploads, production storage, backup restoration or the full video pipeline.
