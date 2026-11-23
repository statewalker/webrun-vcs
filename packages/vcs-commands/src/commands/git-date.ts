// git's date parsing and formatting (date.c) lives in vcs-utils, so lower layers (gc's expiry
// settings in vcs-store-files) parse dates as git does too.
export {
  approxidateCareful,
  formatOffset,
  formatRfc2822Date,
  localTimezoneOffset,
  parseGitDate,
} from "@statewalker/vcs-utils";
