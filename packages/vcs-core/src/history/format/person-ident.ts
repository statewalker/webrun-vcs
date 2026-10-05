/**
 * Person identity formatting and parsing
 *
 * Git uses a specific format for author/committer/tagger identity:
 * "Name <email> timestamp timezone"
 *
 * Example: "John Doe <john@example.com> 1234567890 +0100"
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/PersonIdent.java
 */

import type { PersonIdent } from "../../common/person/person-ident.js";

/**
 * Format a PersonIdent to Git format string
 *
 * Format: "Name <email> timestamp timezone"
 *
 * @param ident Person identity
 * @returns Formatted string
 */
export function formatPersonIdent(ident: PersonIdent): string {
  // Git timestamps are always integers (seconds since epoch).
  // Floor to prevent float timestamps from causing hash mismatches
  // during pack import round-trips (parseInt in parsePersonIdent truncates).
  const ts = Math.floor(ident.timestamp);
  return `${ident.name} <${ident.email}> ${ts} ${ident.tzOffset}`;
}

/**
 * Parse a Git person identity string
 *
 * @param str String in format "Name <email> timestamp timezone"
 * @returns Parsed PersonIdent
 * @throws Error if format is invalid
 */
export function parsePersonIdent(str: string): PersonIdent {
  // Find the email brackets
  const emailStart = str.lastIndexOf("<");
  const emailEnd = str.indexOf(">", emailStart);

  if (emailStart === -1 || emailEnd === -1) {
    throw new Error(`Invalid person ident format (no email): ${str}`);
  }

  // Name is everything before the email, trimmed
  const name = str.substring(0, emailStart).trim();

  // Email is between < and >
  const email = str.substring(emailStart + 1, emailEnd);

  // After > comes " timestamp timezone"
  const rest = str.substring(emailEnd + 1).trim();
  const parts = rest.split(" ");

  if (parts.length < 2) {
    throw new Error(`Invalid person ident format (missing timestamp/timezone): ${str}`);
  }

  const timestamp = parseInt(parts[0], 10);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp in person ident: ${parts[0]}`);
  }

  const tzOffset = parts[1];
  if (!isValidTimezone(tzOffset)) {
    throw new Error(`Invalid timezone in person ident: ${tzOffset}`);
  }

  return { name, email, timestamp, tzOffset };
}

/**
 * Validate timezone offset format
 *
 * Valid formats: +HHMM, -HHMM, +0000
 */
function isValidTimezone(tz: string): boolean {
  if (tz.length !== 5) return false;
  if (tz[0] !== "+" && tz[0] !== "-") return false;
  for (let i = 1; i < 5; i++) {
    if (tz[i] < "0" || tz[i] > "9") return false;
  }
  return true;
}

/**
 * Create a PersonIdent for the current time
 *
 * @param name Person name
 * @param email Person email
 * @returns PersonIdent with current timestamp
 */
export function createPersonIdent(name: string, email: string): PersonIdent {
  const now = Math.floor(Date.now() / 1000);
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const tzSign = tzOffsetMinutes <= 0 ? "+" : "-";
  const tzAbsMinutes = Math.abs(tzOffsetMinutes);
  const tzHours = Math.floor(tzAbsMinutes / 60);
  const tzMins = tzAbsMinutes % 60;
  const tzOffset = `${tzSign}${tzHours.toString().padStart(2, "0")}${tzMins.toString().padStart(2, "0")}`;

  return { name, email, timestamp: now, tzOffset };
}
