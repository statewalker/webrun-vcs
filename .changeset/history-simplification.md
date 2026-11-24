---
"@statewalker/vcs-commands": minor
---

History simplification modes for log and rev-list: `--simplify-merges`
(revision.c's simplify_merges with remove_redundant_parents), `--simplify-by-decoration`,
`--ancestry-path` and `--ancestry-path=<commit>` (limit_to_ancestry), `--sparse`/`--dense`,
`--show-pulls` and `--parents` (parent rewriting for rev-list and for log's header and `%P`),
with their `--full-history` interplay (`LogCommand`/`RevListCommand` setters,
`LogOutputOptions.parents`).

Native twins from t6012-rev-list-simplify, t6019-rev-list-ancestry-path and
t6016-rev-list-graph-simplify-history pass on git 2.43 and 2.56.1.
