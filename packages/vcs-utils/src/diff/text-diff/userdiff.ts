/**
 * The diff drivers of hunk headers (git's `userdiff.c`): the funcname patterns of the builtin
 * drivers (`diff=cpp`, `diff=python`, ...) and the matching `ff_regexp` does with them.
 *
 * @example
 * ```ts
 * const find = userdiffFindFunction("python");
 * unifiedDiff(before, after, { findFunction: find });
 * // hunk headers like "@@ -10,7 +10,8 @@ def parse(self, text):"
 * ```
 *
 * The patterns are POSIX regular expressions (extended for builtin drivers and
 * `diff.<driver>.xfuncname`, basic for `diff.<driver>.funcname`), matched on the bytes of a
 * line as glibc matches them in the C locale ({@link compilePosixRegex}: leftmost-longest,
 * back-references, linear time without them).
 * A pattern holds one regular expression per line; a line starting with `!` rejects the
 * lines it matches. The first matching expression gives the function text: its first group
 * if it has one, else the whole match.
 *
 * @module
 */

import { compilePosixRegex, PosixRegexError } from "../../regex/index.js";
import type { FindFunction } from "./xemit.js";

/** A funcname pattern: lines of regular expressions, `!` lines negated */
export interface FuncnamePattern {
  pattern: string;
  /** Case-insensitive (`IPATTERN` of userdiff.c) */
  icase?: boolean;
  /** Basic instead of extended regular expressions (`diff.<driver>.funcname`) */
  basic?: boolean;
}

/** The funcname patterns of the builtin diff drivers (git 2.56) */
export const BUILTIN_FUNCNAME_PATTERNS: Readonly<Record<string, FuncnamePattern>> = {
  ada: {
    pattern:
      "!^(.*[ \t])?(is[ \t]+new|renames|is[ \t]+separate)([ \t].*)?$\n!^[ \t]*with[ \t].*$\n^[ \t]*((procedure|function)[ \t]+.*)$\n^[ \t]*((package|protected|task)[ \t]+.*)$",
    icase: true,
  },
  bash: {
    pattern:
      "^[ \t]*((([a-zA-Z_][a-zA-Z0-9_]*[ \t]*\\([ \t]*\\))|(function[ \t]+[a-zA-Z_][a-zA-Z0-9_]*(([ \t]*\\([ \t]*\\))|([ \t]+)))).*$)",
    icase: false,
  },
  bibtex: { pattern: "(@[a-zA-Z]{1,}[ \t]*\\{{0,1}[ \t]*[^ \t\"@',\\#}{~%]*).*$", icase: false },
  cpp: {
    pattern:
      "!^[ \t]*[A-Za-z_][A-Za-z_0-9]*:[[:space:]]*($|/[/*])\n^((::[[:space:]]*)?[A-Za-z_].*)$",
    icase: false,
  },
  csharp: {
    pattern:
      "!(^|[ \t]+)(do|while|for|foreach|if|else|new|default|return|switch|case|throw|catch|using|lock|fixed)([ \t(]+|$)\n^[ \t]*(([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+([ \t]+([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+)+[ \t]*\\([^;]*)$\n^[ \t]*(([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+([ \t]+([][[:alnum:]@_.](<[][[:alnum:]@_, \t<>]+>)?)+)+[^;=:,()]*)$\n^[ \t]*(((static|public|internal|private|protected|new|unsafe|sealed|abstract|partial)[ \t]+)*(class|enum|interface|struct|record)[ \t]+.*)$\n^[ \t]*(namespace[ \t]+.*)$",
    icase: false,
  },
  css: { pattern: "![:;][[:space:]]*$\n^[:[@.#]?[_a-z0-9].*$", icase: true },
  dts: { pattern: "!;\n!=\n^[ \t]*((/[ \t]*\\{|&?[a-zA-Z_]).*)", icase: false },
  elixir: { pattern: "^[ \t]*((def(macro|module|impl|protocol|p)?|test)[ \t].*)$", icase: false },
  fortran: {
    pattern:
      "!^([C*]|[ \t]*!)\n!^[ \t]*MODULE[ \t]+PROCEDURE[ \t]\n^[ \t]*((END[ \t]+)?(PROGRAM|MODULE|BLOCK[ \t]+DATA|([^!'\" \t]+[ \t]+)*(SUBROUTINE|FUNCTION))[ \t]+[A-Z].*)$",
    icase: true,
  },
  fountain: { pattern: "^((\\.[^.]|(int|ext|est|int\\.?/ext|i/e)[. ]).*)$", icase: true },
  golang: {
    pattern:
      "^[ \t]*(func[ \t]*.*(\\{[ \t]*)?)\n^[ \t]*(type[ \t].*(struct|interface)[ \t]*(\\{[ \t]*)?)",
    icase: false,
  },
  html: { pattern: "^[ \t]*(<[Hh][1-6]([ \t].*)?>.*)$", icase: false },
  ini: { pattern: "^[ \t]*\\[[^]]+\\]", icase: false },
  java: {
    pattern:
      "!^[ \t]*(catch|do|for|if|instanceof|new|return|switch|throw|while)\n^[ \t]*(([a-z-]+[ \t]+)*(class|enum|interface|record)[ \t]+.*)$\n^[ \t]*(([A-Za-z_<>&][][?&<>.,A-Za-z_0-9]*[ \t]+)+[A-Za-z_][A-Za-z_0-9]*[ \t]*\\([^;]*)$",
    icase: false,
  },
  kotlin: { pattern: "^[ \t]*(([a-z]+[ \t]+)*(fun|class|interface)[ \t]+.*)$", icase: false },
  markdown: { pattern: "^ {0,3}#{1,6}[ \t].*", icase: false },
  matlab: {
    pattern: "^[[:space:]]*((classdef|function)[[:space:]].*)$|^(%%%?|##)[[:space:]].*$",
    icase: false,
  },
  objc: {
    pattern:
      "!^[ \t]*(do|for|if|else|return|switch|while)\n^[ \t]*([-+][ \t]*\\([ \t]*[A-Za-z_][A-Za-z_0-9* \t]*\\)[ \t]*[A-Za-z_].*)$\n^[ \t]*(([A-Za-z_][A-Za-z_0-9]*[ \t]+)+[A-Za-z_][A-Za-z_0-9]*[ \t]*\\([^;]*)$\n^(@(implementation|interface|protocol)[ \t].*)$",
    icase: false,
  },
  pascal: {
    pattern:
      "^(((class[ \t]+)?(procedure|function)|constructor|destructor|interface|implementation|initialization|finalization)[ \t]*.*)$\n^(.*=[ \t]*(class|record).*)$",
    icase: false,
  },
  perl: {
    pattern:
      "^package .*\n^sub [[:alnum:]_':]+[ \t]*(\\([^)]*\\)[ \t]*)?(:[^;#]*)?(\\{[ \t]*)?(#.*)?$\n^(BEGIN|END|INIT|CHECK|UNITCHECK|AUTOLOAD|DESTROY)[ \t]*(\\{[ \t]*)?(#.*)?$\n^=head[0-9] .*",
    icase: false,
  },
  php: {
    pattern:
      "^[\t ]*(((public|protected|private|static|abstract|final)[\t ]+)*function.*)$\n^[\t ]*((((final|abstract)[\t ]+)?class|enum|interface|trait).*)$",
    icase: false,
  },
  python: { pattern: "^[ \t]*((class|(async[ \t]+)?def)[ \t].*)$", icase: false },
  r: { pattern: "^[ \t]*([a-zA-z][a-zA-Z0-9_.]*[ \t]*(<-|=)[ \t]*function.*)$", icase: false },
  ruby: { pattern: "^[ \t]*((class|module|def)[ \t].*)$", icase: false },
  rust: {
    pattern:
      '^[\t ]*((pub(\\([^\\)]+\\))?[\t ]+)?((async|const|unsafe|extern([\t ]+"[^"]+"))[\t ]+)?(struct|enum|union|mod|trait|fn|impl|macro_rules!)[< \t]+[^;]*)$',
    icase: false,
  },
  scheme: {
    pattern:
      "^(\\(.*)$\n^[\t ]*(\\(((define|def(struct|syntax|class|method|rules|record|proto|alias)?)[-*/ \t]|(library|module|struct|class)[*+ \t]).*)$\n^  ?(\\([Dd][Ee][Ff].*)$",
    icase: false,
  },
  swift: {
    pattern:
      "^[ \t]*((@[A-Za-z_][A-Za-z0-9_]*(\\([^()]*\\))?[ \t]+)*([a-z]+[ \t]+)*(func|init|deinit|subscript|class|struct|enum|protocol|extension|actor)[ \t(?!<].*)$",
    icase: false,
  },
  tex: { pattern: "^(\\\\((sub)*section|chapter|part)\\*{0,1}\\{.*)$", icase: false },
};

/**
 * The funcname patterns of the builtin diff drivers of git 2.43 and 2.44, before `csharp`
 * changed (2.45), `bash` changed and `ini` came (2.50), `r` came (2.51), `scheme` changed
 * (2.55) and `swift` came (2.56); without a driver of their own, `ini`, `r` and `swift` get
 * the default function lines.
 */
export const BUILTIN_FUNCNAME_PATTERNS_2_43: Readonly<Record<string, FuncnamePattern>> = (() => {
  const { ini: _ini, r: _r, swift: _swift, ...kept } = BUILTIN_FUNCNAME_PATTERNS;
  return {
    ...kept,
    bash: {
      pattern:
        "^[ \t]*(([a-zA-Z_][a-zA-Z0-9_]*[ \t]*\\([ \t]*\\))|(function[ \t]+[a-zA-Z_][a-zA-Z0-9_]*(([ \t]*\\([ \t]*\\))|([ \t]+)))[ \t]*(\\{|\\(\\(?|\\[\\[))",
      icase: false,
    },
    csharp: {
      pattern:
        "!^[ \t]*(do|while|for|if|else|instanceof|new|return|switch|case|throw|catch|using)\n^[ \t]*(((static|public|internal|private|protected|new|virtual|sealed|override|unsafe|async)[ \t]+)*[][<>@.~_[:alnum:]]+[ \t]+[<>@._[:alnum:]]+[ \t]*\\(.*\\))[ \t]*$\n^[ \t]*(((static|public|internal|private|protected|new|virtual|sealed|override|unsafe)[ \t]+)*[][<>@.~_[:alnum:]]+[ \t]+[@._[:alnum:]]+)[ \t]*$\n^[ \t]*(((static|public|internal|private|protected|new|unsafe|sealed|abstract|partial)[ \t]+)*(class|enum|interface|struct|record)[ \t]+.*)$\n^[ \t]*(namespace[ \t]+.*)$",
      icase: false,
    },
    scheme: {
      pattern:
        "^[\t ]*(\\(((define|def(struct|syntax|class|method|rules|record|proto|alias)?)[-*/ \t]|(library|module|struct|class)[*+ \t]).*)$",
      icase: false,
    },
  };
})();

/**
 * The function line finder of a funcname pattern (`xdiff_set_find_func` and `ff_regexp` of
 * git). Throws, as git dies, when an expression does not compile ("Invalid regexp to look
 * for hunk header") or the last one is negated.
 */
export function funcnameFindFunction(pattern: FuncnamePattern): FindFunction {
  const lines = pattern.pattern.split("\n");
  const compiled = lines.map((line, k) => {
    const negate = line.startsWith("!");
    if (negate && k === lines.length - 1) {
      throw new Error(`Last expression must not be negated: ${line}`);
    }
    const expression = negate ? line.slice(1) : line;
    try {
      const re = compilePosixRegex(expression, {
        extended: !pattern.basic,
        icase: pattern.icase ?? false,
      });
      return { re, negate };
    } catch (e) {
      if (e instanceof PosixRegexError) {
        throw new Error(`Invalid regexp to look for hunk header: ${expression}`);
      }
      throw e;
    }
  });
  return (line) => {
    for (const { re, negate } of compiled) {
      // negated expressions only need to know whether they match
      const m = re.exec(line, line.length, negate ? 1 : 2);
      if (!m) continue;
      if (negate) return undefined;
      const group = m.groups[0];
      if (group) return [group[0], group[1]];
      return [m.start, m.end];
    }
    return undefined;
  };
}

/** Compiled builtin patterns, shared by every lookup */
const compiledBuiltins = new WeakMap<FuncnamePattern, FindFunction>();

/**
 * The function line finder of a diff driver: `diff.<name>.xfuncname` or `diff.<name>.funcname`
 * from `config` when set, else the builtin driver's pattern (from `builtins`, default git
 * 2.56's {@link BUILTIN_FUNCNAME_PATTERNS}); undefined when neither exists (the default then
 * applies: lines starting with a letter, `_` or `$`).
 */
export function userdiffFindFunction(
  name: string,
  config?: (key: string) => string | undefined,
  builtins: Readonly<Record<string, FuncnamePattern>> = BUILTIN_FUNCNAME_PATTERNS,
): FindFunction | undefined {
  const xfuncname = config?.(`diff.${name}.xfuncname`);
  if (xfuncname !== undefined) return funcnameFindFunction({ pattern: xfuncname });
  const funcname = config?.(`diff.${name}.funcname`);
  if (funcname !== undefined) return funcnameFindFunction({ pattern: funcname, basic: true });
  const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
  if (!builtin) return undefined;
  let found = compiledBuiltins.get(builtin);
  if (!found) {
    found = funcnameFindFunction(builtin);
    compiledBuiltins.set(builtin, found);
  }
  return found;
}
