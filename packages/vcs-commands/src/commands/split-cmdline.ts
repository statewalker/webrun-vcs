/**
 * alias.c's split_cmdline: words split on whitespace, quotes removed, a backslash escaping
 * the next character outside single quotes; split_cmdline_strerror's text on an error.
 */
export function splitCmdline(line: string): string[] | string {
  // one word to begin with; every whitespace run ends one and starts the next (a trailing
  // run leaves an empty last word, as git's)
  const args: string[] = [];
  let current = "";
  let quoted = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (!quoted && /[ \t\n\r]/.test(c)) {
      args.push(current);
      current = "";
      while (i + 1 < line.length && /[ \t\n\r]/.test(line[i + 1] as string)) i++;
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c;
    } else if (c === quoted) {
      quoted = "";
    } else {
      if (c === "\\" && quoted !== "'") {
        i++;
        if (i >= line.length) return "cmdline ends with \\";
      }
      current += line[i];
    }
  }
  if (quoted) return "unclosed quote";
  args.push(current);
  return args;
}
