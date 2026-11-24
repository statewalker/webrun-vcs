---
"@statewalker/vcs-commands": minor
---

Colored `git diff`, `git log` and `git show` output, byte for byte as git's `--color=always`:
the new `DiffTextOptions` `color` (`--color[=always|never|auto]`, `--no-color`; `auto` is git
without a terminal), `colorMoved` (`--color-moved[=no|default|plain|blocks|zebra|dimmed-zebra]`,
`--no-color-moved`), `colorMovedWs` (`--color-moved-ws=no|ignore-space-at-eol|
ignore-space-change|ignore-all-space|allow-indentation-change`) and `wsErrorHighlight`
(`--ws-error-highlight`), over the configuration's `color.ui`, `color.diff`/`diff.color`,
`color.diff.<slot>` (every slot of diff.c, `plain` too), `diff.colorMoved`, `diff.colorMovedWS`,
`diff.wsErrorHighlight`, `color.decorate.<slot>`, `core.whitespace` and the `whitespace`
attribute. Color values are parsed as color.c's `color_parse_mem` (names, `bright`, attributes
and their negations, 256 colors, `#rrggbb`/`#rgb`); a value git refuses dies as git dies. The
patch's headers, hunk headers, lines and whitespace errors are colored as diff.c's `emit_*`
functions, moved lines are detected over one diff's files (`MovedLineBuffer`:
`add_lines_to_move_detection`, `mark_color_as_moved`, `dim_moved_lines`), and `--stat`,
combined diffs (`--cc`), `--submodule=log|diff`, log's commit lines and decorations, `%C(auto)`
decorations and show's `tag`/`tree` headers take their colors. `colorCompatibility: "2.43"`
drops what git 2.43 lacks (`#rgb`, the `incomplete-line` whitespace rule). `git log --graph` draws
its columns in color as graph.c does (`column_colors_ansi`, or `log.graphColors`; its invalid
colors reported in the new `LogCommand.warnings`).
