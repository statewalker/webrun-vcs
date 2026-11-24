---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-commands": minor
---

Word diff in `git diff`, `log -p` and `show`: `DiffTextOptions.wordDiff` (`--word-diff=plain|color|porcelain|none`, `color` is `--color-words` and turns colors on) and `wordDiffRegex` (`--word-diff-regex`, `--color-words=<regex>`), `diff.wordRegex` and `diff.<driver>.wordRegex`, with the builtin drivers' word regexes from userdiff.c (`BUILTIN_WORD_REGEXES`, `userdiffWordRegex`) run through `compilePosixRegex`. `driverCompatibility: "2.43"` selects git 2.43's builtin drivers (word and funcname patterns).
