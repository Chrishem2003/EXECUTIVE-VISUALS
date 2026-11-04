# Delivery manifest revision invariant

A delivery manifest must reference a meaningful, positive timeline revision.

Accepted values:
- A non-empty string revision, for legacy externally assigned revision identifiers.
- A positive safe integer revision.

Rejected values:
- Zero and negative integers.
- Blank or whitespace-only strings.
- Fractional, unsafe or non-finite numeric values.
- Missing or non-string/non-integer values.

The Runway dry-run branch carries this validation alongside its provider changes so a full CI run exercises both the delivery evidence guard and the Runway router tests. The manifest fingerprint includes the revision, so changing it invalidates the published evidence fingerprint.

This guard is a validation-only change. It does not publish assets, modify timelines or trigger rendering.
