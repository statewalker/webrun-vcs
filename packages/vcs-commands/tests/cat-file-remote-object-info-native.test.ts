/**
 * `git cat-file --batch-command`'s `remote-object-info` (git 2.56's t1017) through native git
 * (the git on PATH as client when it has the command, 2.56 and later) and ours, against native
 * and our servers: see `remote-object-info-native-support.ts`.
 */
import { defineRemoteObjectInfoTwins } from "./remote-object-info-native-support.js";

defineRemoteObjectInfoTwins("git");
