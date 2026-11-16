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
 * `diff.<driver>.xfuncname`, basic for `diff.<driver>.funcname`); they are translated to
 * JavaScript and run on the bytes of a line (each byte one character, as in the C locale).
 * A pattern holds one regular expression per line; a line starting with `!` rejects the
 * lines it matches. The first matching expression gives the function text: its first group
 * if it has one, else the whole match.
 *
 * @module
 */

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

const CLASSES: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
};

/** A character inside a JavaScript character class */
function classChar(ch: string): string {
  return /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
}

/** A literal character outside a class */
function literal(ch: string): string {
  return /[\\^$.|?*+()[\]{}/]/.test(ch) ? `\\${ch}` : ch;
}

/** A POSIX bracket expression starting at `re[i]` (the `[`): its JavaScript class and end */
function bracket(re: string, i: number): [string, number] {
  let j = i + 1;
  let out = "[";
  if (re[j] === "^") {
    out += "^";
    j++;
  }
  let first = true;
  while (j < re.length) {
    const ch = re[j];
    if (ch === "]" && !first) return [`${out}]`, j + 1];
    first = false;
    if (ch === "[" && (re[j + 1] === ":" || re[j + 1] === "." || re[j + 1] === "=")) {
      const kind = re[j + 1];
      const end = re.indexOf(`${kind}]`, j + 2);
      if (end < 0) throw new Error(`unterminated [${kind} in ${re}`);
      const name = re.slice(j + 2, end);
      if (kind === ":") {
        const cls = CLASSES[name];
        if (cls === undefined) throw new Error(`unknown character class ${name}`);
        out += cls;
      } else {
        out += classChar(name);
      }
      j = end + 2;
      continue;
    }
    // a range: "-" between two characters
    if (ch === "-" && re[j + 1] !== "]" && out !== "[" && out !== "[^") {
      out += "-";
      j++;
      continue;
    }
    out += classChar(ch);
    j++;
  }
  throw new Error(`unterminated bracket expression in ${re}`);
}

/**
 * A POSIX regular expression (extended, or basic with GNU extensions) as a JavaScript one,
 * to run with the `s` flag on a latin1 view of bytes.
 */
export function posixToJsRegExp(re: string, basic = false): string {
  let out = "";
  let i = 0;
  // whether a "*" here is literal (start of a basic expression or group)
  let atStart = true;
  while (i < re.length) {
    const ch = re[i];
    if (ch === "[") {
      const [cls, end] = bracket(re, i);
      out += cls;
      i = end;
      atStart = false;
      continue;
    }
    if (ch === "\\" && i + 1 < re.length) {
      const c = re[i + 1];
      i += 2;
      if (basic && "(){}|+?".includes(c)) {
        out += c;
        atStart = c === "(" || c === "|";
        continue;
      }
      if ("wWsSbB".includes(c)) out += `\\${c}`;
      else if (c === "<") out += "\\b(?=\\w)";
      else if (c === ">") out += "\\b(?<=\\w)";
      else if (c === "`") out += "^";
      else if (c === "'") out += "$";
      else out += literal(c);
      atStart = false;
      continue;
    }
    if (basic) {
      if ("(){}|+?".includes(ch)) out += literal(ch);
      else if (ch === "*" && atStart) out += "\\*";
      else out += ch === "/" ? "\\/" : ch;
      atStart = ch === "^" && atStart;
      i++;
      continue;
    }
    out += ch === "/" ? "\\/" : ch;
    atStart = ch === "(" || ch === "|";
    i++;
  }
  return out;
}

interface CompiledFuncname {
  re: RegExp;
  negate: boolean;
}

/** Bytes as a string of one character per byte */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
}

/**
 * The function line finder of a funcname pattern (`xdiff_set_find_func` and `ff_regexp` of
 * git).
 */
export function funcnameFindFunction(pattern: FuncnamePattern): FindFunction {
  const lines = pattern.pattern.split("\n");
  const compiled: CompiledFuncname[] = lines.map((line, k) => {
    const negate = line.startsWith("!");
    if (negate && k === lines.length - 1) {
      throw new Error(`Last expression must not be negated: ${line}`);
    }
    const source = posixToJsRegExp(negate ? line.slice(1) : line, pattern.basic);
    return { re: new RegExp(source, pattern.icase ? "dsi" : "ds"), negate };
  });
  return (line) => {
    const text = latin1(line);
    for (const { re, negate } of compiled) {
      const m = re.exec(text);
      if (!m) continue;
      if (negate) return undefined;
      const group = m.indices?.[1];
      if (group) return [group[0], group[1]];
      return [m.index, m.index + m[0].length];
    }
    return undefined;
  };
}

/**
 * The function line finder of a diff driver: `diff.<name>.xfuncname` or `diff.<name>.funcname`
 * from `config` when set, else the builtin driver's pattern; undefined when neither exists
 * (the default then applies: lines starting with a letter, `_` or `$`).
 */
export function userdiffFindFunction(
  name: string,
  config?: (key: string) => string | undefined,
): FindFunction | undefined {
  const xfuncname = config?.(`diff.${name}.xfuncname`);
  if (xfuncname !== undefined) return funcnameFindFunction({ pattern: xfuncname });
  const funcname = config?.(`diff.${name}.funcname`);
  if (funcname !== undefined) return funcnameFindFunction({ pattern: funcname, basic: true });
  const builtin = BUILTIN_FUNCNAME_PATTERNS[name];
  return builtin ? funcnameFindFunction(builtin) : undefined;
}
