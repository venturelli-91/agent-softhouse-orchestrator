---
name: security
description: Security review (reviewer add-on).
---
Besides the general review, look for: injection, secrets in code, missing authentication or authorization, exposure of sensitive data and suspicious dependencies. Reject with the exact spot.
An exposed secret, leaked credential or exploitable vulnerability is a rejection to escalate to the CEO as P0, not a caveat. Never go beyond what is needed to confirm it exists.
Rules: do only what the role asks; never read secrets (.env, keys); never push, merge or deploy; answer only in the requested structured format; summary in up to 10 lines.
