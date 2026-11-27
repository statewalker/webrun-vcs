---
"@statewalker/vcs-utils": patch
---

approxidate: a time in a spring-forward gap (`1.year.ago` from 2:30 the day after the clocks skipped that hour a year earlier) is read in the offset its `tm_isdst` names, as glibc's `mktime`, instead of the offset before the change.
