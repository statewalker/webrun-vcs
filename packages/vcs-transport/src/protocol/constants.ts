/**
 * Git protocol constants based on JGit's GitProtocolConstants.java
 *
 * These constants define the protocol framing markers, capability strings,
 * and command names used in git's wire protocol.
 */

// Pkt-line special markers (length field values)
export const PKT_FLUSH = "0000"; // End of message section
export const PKT_DELIM = "0001"; // Delimiter for protocol v2
export const PKT_END = "0002"; // End of response (v2)

// Maximum packet size (65520 bytes - leaves room for TCP headers)
export const MAX_PACKET_SIZE = 65520;

// Minimum valid data packet length (4 bytes header + at least 0 bytes data)
export const MIN_PACKET_LENGTH = 4;

// Sideband channel identifiers
export const SIDEBAND_DATA = 1; // Pack file data
export const SIDEBAND_PROGRESS = 2; // Progress messages
export const SIDEBAND_ERROR = 3; // Error messages

// Sideband buffer sizes (from JGit SideBandOutputStream)
export const SIDEBAND_HDR_SIZE = 5; // 4 bytes length + 1 byte channel
export const SIDEBAND_MAX_BUF = 65520;
export const SIDEBAND_SMALL_BUF = 1000;

// Protocol version headers
export const VERSION_1 = "version 1";
export const VERSION_2 = "version 2";
export const VERSION_2_REQUEST = "version=2";

// Protocol v2 commands
export const COMMAND_LS_REFS = "ls-refs";
export const COMMAND_FETCH = "fetch";
export const COMMAND_OBJECT_INFO = "object-info";

// Packet line prefixes (protocol commands)
export const PACKET_WANT = "want ";
export const PACKET_HAVE = "have ";
export const PACKET_DONE = "done";
export const PACKET_SHALLOW = "shallow ";
export const PACKET_DEEPEN = "deepen ";
export const PACKET_DEEPEN_SINCE = "deepen-since ";
export const PACKET_DEEPEN_NOT = "deepen-not ";
export const PACKET_UNSHALLOW = "unshallow ";
export const PACKET_ACK = "ACK ";
export const PACKET_NAK = "NAK";
export const PACKET_ERR = "ERR ";

// Protocol v2 section markers
export const SECTION_ACKNOWLEDGMENTS = "acknowledgments";
export const SECTION_PACKFILE = "packfile";
export const SECTION_SHALLOW_INFO = "shallow-info";
export const SECTION_WANTED_REFS = "wanted-refs";

// Capabilities (can be offered and/or requested)
export const CAPABILITY_MULTI_ACK = "multi_ack";
export const CAPABILITY_MULTI_ACK_DETAILED = "multi_ack_detailed";
export const CAPABILITY_THIN_PACK = "thin-pack";
export const CAPABILITY_SIDE_BAND = "side-band";
export const CAPABILITY_SIDE_BAND_64K = "side-band-64k";
export const CAPABILITY_OFS_DELTA = "ofs-delta";
export const CAPABILITY_SHALLOW = "shallow";
export const CAPABILITY_DEEPEN_SINCE = "deepen-since";
export const CAPABILITY_DEEPEN_NOT = "deepen-not";
export const CAPABILITY_DEEPEN_RELATIVE = "deepen-relative";
export const CAPABILITY_NO_PROGRESS = "no-progress";
export const CAPABILITY_INCLUDE_TAG = "include-tag";
export const CAPABILITY_REPORT_STATUS = "report-status";
export const CAPABILITY_REPORT_STATUS_V2 = "report-status-v2";
export const CAPABILITY_DELETE_REFS = "delete-refs";
export const CAPABILITY_QUIET = "quiet";
export const CAPABILITY_ATOMIC = "atomic";
export const CAPABILITY_PUSH_OPTIONS = "push-options";
export const CAPABILITY_ALLOW_TIP_SHA1_IN_WANT = "allow-tip-sha1-in-want";
export const CAPABILITY_ALLOW_REACHABLE_SHA1_IN_WANT = "allow-reachable-sha1-in-want";
export const CAPABILITY_PUSH_CERT = "push-cert=";
export const CAPABILITY_FILTER = "filter";
export const CAPABILITY_SYMREF = "symref=";
export const CAPABILITY_AGENT = "agent=";
export const CAPABILITY_OBJECT_FORMAT = "object-format=";
export const CAPABILITY_SERVER_OPTION = "server-option";

// Protocol v2 specific capabilities
export const CAPABILITY_REF_IN_WANT = "ref-in-want";
export const CAPABILITY_SIDEBAND_ALL = "sideband-all";
export const CAPABILITY_WAIT_FOR_DONE = "wait-for-done";
export const CAPABILITY_PACKFILE_URIS = "packfile-uris";

// Protocol v2 fetch options
export const OPTION_WANT_REF = "want-ref ";
export const OPTION_HAVE = "have ";
export const OPTION_DONE = "done";
export const OPTION_THIN_PACK = "thin-pack";
export const OPTION_NO_PROGRESS = "no-progress";
export const OPTION_INCLUDE_TAG = "include-tag";
export const OPTION_OFS_DELTA = "ofs-delta";
export const OPTION_SHALLOW = "shallow ";
export const OPTION_DEEPEN = "deepen ";
export const OPTION_DEEPEN_RELATIVE = "deepen-relative";
export const OPTION_DEEPEN_SINCE = "deepen-since ";
export const OPTION_DEEPEN_NOT = "deepen-not ";
export const OPTION_FILTER = "filter ";
export const OPTION_WANT_OBJECT = "want ";
export const OPTION_SIDEBAND_ALL = "sideband-all";
export const OPTION_PACKFILE_URIS = "packfile-uris ";
export const OPTION_WAIT_FOR_DONE = "wait-for-done";

// Reference prefixes
export const R_REFS = "refs/";
export const R_HEADS = "refs/heads/";
export const R_TAGS = "refs/tags/";
export const R_REMOTES = "refs/remotes/";
export const R_NOTES = "refs/notes/";

// Special references
export const HEAD = "HEAD";
export const FETCH_HEAD = "FETCH_HEAD";
export const ORIG_HEAD = "ORIG_HEAD";
export const MERGE_HEAD = "MERGE_HEAD";
export const CHERRY_PICK_HEAD = "CHERRY_PICK_HEAD";

// Object ID constants
export const OBJECT_ID_LENGTH = 20; // SHA-1 bytes
export const OBJECT_ID_STRING_LENGTH = 40; // SHA-1 hex chars
export const ZERO_ID = "0000000000000000000000000000000000000000000000000000000000000000".slice(
  0,
  OBJECT_ID_STRING_LENGTH,
);
/** Alias for ZERO_ID, commonly used in git terminology for null OIDs */
export const ZERO_OID = ZERO_ID;

// Git protocol default ports
export const GIT_PROTOCOL_PORT = 9418;
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;

// HTTP Content-Type headers
export const CONTENT_TYPE_UPLOAD_PACK_REQUEST = "application/x-git-upload-pack-request";
export const CONTENT_TYPE_UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
export const CONTENT_TYPE_UPLOAD_PACK_ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
export const CONTENT_TYPE_RECEIVE_PACK_REQUEST = "application/x-git-receive-pack-request";
export const CONTENT_TYPE_RECEIVE_PACK_RESULT = "application/x-git-receive-pack-result";
export const CONTENT_TYPE_RECEIVE_PACK_ADVERTISEMENT =
  "application/x-git-receive-pack-advertisement";

// Service names
export const SERVICE_UPLOAD_PACK = "git-upload-pack";
export const SERVICE_RECEIVE_PACK = "git-receive-pack";
