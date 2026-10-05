/**
 * Person identity (author, committer, tagger)
 *
 * Following JGit's PersonIdent format:
 * "Name <email> timestamp timezone"
 * Example: "John Doe <john@example.com> 1234567890 +0100"
 */
export interface PersonIdent {
  /** Display name */
  name: string;
  /** Email address */
  email: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Timezone offset string: "+HHMM" or "-HHMM" */
  tzOffset: string;
}
