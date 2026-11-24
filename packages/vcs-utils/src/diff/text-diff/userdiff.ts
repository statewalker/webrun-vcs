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
 * The word regexes of the builtin diff drivers (git 2.56), as userdiff.c's `PATTERNS` give
 * them before appending `|[^[:space:]]|[\xc0-\xff][\x80-\xbf]+` (see
 * {@link userdiffWordRegex}): what `--word-diff` and `--color-words` take for a word in a
 * file of that driver.
 */
export const BUILTIN_WORD_REGEXES: Readonly<Record<string, string>> = {
  ada: "[a-zA-Z][a-zA-Z0-9_]*|[-+]?[0-9][0-9#_.aAbBcCdDeEfF]*([eE][+-]?[0-9_]+)?|=>|\\.\\.|\\*\\*|:=|/=|>=|<=|<<|>>|<>",
  bash: "[a-zA-Z_][a-zA-Z0-9_]*|\\$[a-zA-Z0-9_]+|\\$\\{|\\|\\||&&|<<|>>|==|!=|<=|>=|[-+*/%&|^]=|:=|:-|:\\+|:\\?|##|%%|\\^\\^|,,|[-a-zA-Z0-9_]+|\\(|\\)|\\{|\\}|\\[|\\]",
  bibtex: '[={}"]|[^={}" \t]+',
  cpp: "[a-zA-Z_][a-zA-Z0-9_]*|[0-9][0-9.]*([Ee][-+]?[0-9]+)?[fFlLuU]*|0[xXbB][0-9a-fA-F]+[lLuU]*|\\.[0-9][0-9]*([Ee][-+]?[0-9]+)?[fFlL]?|[-+*/<>%&^|=!]=|--|\\+\\+|<<=?|>>=?|&&|\\|\\||::|->\\*?|\\.\\*|<=>",
  csharp:
    "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+[fFlL]?|0[xXbB]?[0-9a-fA-F]+[lL]?|[-+*/<>%&^|=!]=|--|\\+\\+|<<=?|>>=?|&&|\\|\\||::|->",
  css: "-?[_a-zA-Z][-_a-zA-Z0-9]*|-?[0-9]+|\\#[0-9a-fA-F]+",
  dts: "[a-zA-Z0-9,._+?#-]+|[-+*/%&^|!~]|>>|<<|&&|\\|\\|",
  elixir:
    "[@:]?[a-zA-Z0-9@_?!]+|[-+]?0[xob][0-9a-fA-F]+|[-+]?[0-9][0-9_.]*([eE][-+]?[0-9_]+)?|:?(\\+\\+|--|\\.\\.|~~~|<>|\\^\\^\\^|<?\\|>|<<<?|>?>>|<<?~|~>?>|<~>|<=|>=|===?|!==?|=~|&&&?|\\|\\|\\|?|=>|<-|\\\\\\\\|->)|:?%[A-Za-z0-9_.]\\{\\}?",
  fortran:
    "[a-zA-Z][a-zA-Z0-9_]*|\\.([Ee][Qq]|[Nn][Ee]|[Gg][TtEe]|[Ll][TtEe]|[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee]|[Aa][Nn][Dd]|[Oo][Rr]|[Nn]?[Ee][Qq][Vv]|[Nn][Oo][Tt])\\.|[-+]?[0-9.]+([AaIiDdEeFfLlTtXx][Ss]?[-+]?[0-9.]*)?(_[a-zA-Z0-9][a-zA-Z0-9_]*)?|//|\\*\\*|::|[/<>=]=",
  fountain: "[^ \t-]+",
  golang:
    "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.eE]+i?|0[xX]?[0-9a-fA-F]+i?|[-+*/<>%&^|=!:]=|--|\\+\\+|<<=?|>>=?|&\\^=?|&&|\\|\\||<-|\\.{3}",
  html: "[^<>= \t]+",
  ini: "[^ \t]+",
  java: "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+[fFlL]?|0[xXbB]?[0-9a-fA-F]+[lL]?|[-+*/<>%&^|=!]=|--|\\+\\+|<<=?|>>>?=?|&&|\\|\\|",
  kotlin:
    "[a-zA-Z_][a-zA-Z0-9_]*|0[xXbB][0-9a-fA-F_]+[lLuU]*|[0-9][0-9_]*([.][0-9_]*)?([Ee][-+]?[0-9]+)?[fFlLuU]*|[.][0-9][0-9_]*([Ee][-+]?[0-9]+)?[fFlLuU]?|[-+*/<>%&^|=!]==?|--|\\+\\+|<<=|>>=|&&|\\|\\||->|\\.\\*|!!|[?:.][.:]",
  markdown: "[^<>= \t]+",
  matlab: "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+|[=~<>]=|\\.[*/\\^']|\\|\\||&&",
  objc: "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+[fFlL]?|0[xXbB]?[0-9a-fA-F]+[lL]?|[-+*/<>%&^|=!]=|--|\\+\\+|<<=?|>>=?|&&|\\|\\||::|->",
  pascal: "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+|0[xXbB]?[0-9a-fA-F]+|<>|<=|>=|:=|\\.\\.",
  perl: "[[:alpha:]_'][[:alnum:]_']*|0[xb]?[0-9a-fA-F_]*|[0-9a-fA-F_]+(\\.[0-9a-fA-F_]+)?([eE][-+]?[0-9_]+)?|=>|-[rwxoRWXOezsfdlpSugkbctTBMAC>]|~~|::|&&=|\\|\\|=|//=|\\*\\*=|&&|\\|\\||//|\\+\\+|--|\\*\\*|\\.\\.\\.?|[-+*/%.^&<>=!|]=|=~|!~|<<|<>|<=>|>>",
  php: "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+|0[xXbB]?[0-9a-fA-F]+|[-+*/<>%&^|=!.]=|--|\\+\\+|<<=?|>>=?|===|&&|\\|\\||::|->",
  python:
    "[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+[jJlL]?|0[xX]?[0-9a-fA-F]+[lL]?|[-+*/<>%&^|=!]=|//=?|<<=?|>>=?|\\*\\*=?",
  r: "[^ \t]+",
  ruby: "(@|@@|\\$)?[a-zA-Z_][a-zA-Z0-9_]*|[-+0-9.e]+|0[xXbB]?[0-9a-fA-F]+|\\?(\\\\C-)?(\\\\M-)?.|//=?|[-+*/<>%&^|=!]=|<<=?|>>=?|===|\\.{1,3}|::|[!=]~",
  rust: "[a-zA-Z_][a-zA-Z0-9_]*|[0-9][0-9_a-fA-Fiosuxz]*(\\.([0-9]*[eE][+-]?)?[0-9_fF]*)?|[-+*\\/<>%&^|=!:]=|<<=?|>>=?|&&|\\|\\||->|=>|\\.{2}=|\\.{3}|::",
  scheme: "\\|([^|\\\\]|\\\\.)*\\||([^][)(}{ \t])+",
  swift:
    "[a-zA-Z_][a-zA-Z0-9_]*|0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*([.][0-9_]+)?([eE][-+]?[0-9]+)?|[-+*/%<>=!&|^~?]=|&&|\\|\\||<<=?|>>=?|\\?\\?|\\.\\.[.<]|->",
  tex: "\\\\[a-zA-Z@]+|\\\\.|([a-zA-Z0-9]|[^\u0001-\u007f])+",
};

/**
 * The word regexes of the builtin diff drivers of git 2.43 and 2.44: `bash` split on spaces
 * and tabs only (2.50 gave it a regex of its own), `scheme` took no escapes between vertical
 * bars (2.55), and `ini`, `r` and `swift` were no drivers yet.
 */
export const BUILTIN_WORD_REGEXES_2_43: Readonly<Record<string, string>> = (() => {
  const { ini: _ini, r: _r, swift: _swift, ...kept } = BUILTIN_WORD_REGEXES;
  return {
    ...kept,
    bash: "[^ \t]+",
    scheme: "\\|([^\\\\]*)\\||([^][)(}{[ \t])+",
  };
})();

/**
 * What every builtin word regex ends with (`PATTERNS`): any other non-space byte is a word,
 * and so is a UTF-8 sequence (git in the C locale, whose regexec reads bytes)
 */
const WORD_REGEX_SUFFIX = Uint8Array.from([
  ...new TextEncoder().encode("|[^[:space:]]|["),
  0xc0,
  0x2d,
  0xff,
  0x5d,
  0x5b,
  0x80,
  0x2d,
  0xbf,
  0x5d,
  0x2b,
]);

/**
 * The word regex of a diff driver (userdiff.c's `word_regex`), as bytes of an extended
 * POSIX expression: `diff.<name>.wordRegex` from `config` when set, else the builtin
 * driver's (from `builtins`, default git 2.56's {@link BUILTIN_WORD_REGEXES}) with the suffix
 * every builtin gets; undefined when neither exists (words are then runs of non-spaces).
 */
export function userdiffWordRegex(
  name: string,
  config?: (key: string) => string | undefined,
  builtins: Readonly<Record<string, string>> = BUILTIN_WORD_REGEXES,
): Uint8Array | undefined {
  const configured = config?.(`diff.${name}.wordRegex`);
  if (configured !== undefined) return new TextEncoder().encode(configured);
  const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
  if (builtin === undefined) return undefined;
  const head = new TextEncoder().encode(builtin);
  const out = new Uint8Array(head.length + WORD_REGEX_SUFFIX.length);
  out.set(head);
  out.set(WORD_REGEX_SUFFIX, head.length);
  return out;
}

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
