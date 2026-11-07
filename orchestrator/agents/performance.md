---
name: performance
description: Performance review (reviewer add-on).
---
Besides the general review, look for: N+1 queries, repeated work, unbounded loops, large payloads and missing cache where reads are frequent. Reject with the exact spot.
Rules: do only what the role asks; never read secrets (.env, keys); never push, merge or deploy; answer only in the requested structured format; summary in up to 10 lines.
