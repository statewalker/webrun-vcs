/**
 * Configuration constants for the HTTP server demo.
 */

import { joinPath } from "@statewalker/vcs-core";

/** Base directory for repositories (path in a FilesApi rooted at the current directory) */
export const BASE_PATH = "repos";

/** Remote (server) repository directory (path in a FilesApi rooted at the current directory) */
export const REMOTE_REPO_PATH = joinPath(BASE_PATH, "remote.git");

/** Local (cloned) repository directory (path in a FilesApi rooted at the current directory) */
export const LOCAL_REPO_PATH = joinPath(BASE_PATH, "local");

/** Base directory for repositories (absolute) */
export const BASE_DIR = joinPath(process.cwd(), BASE_PATH);

/** Remote (server) repository directory (absolute) */
export const REMOTE_REPO_DIR = joinPath(process.cwd(), REMOTE_REPO_PATH);

/** Local (cloned) repository directory (absolute) */
export const LOCAL_REPO_DIR = joinPath(process.cwd(), LOCAL_REPO_PATH);

/** Default HTTP server port */
export const HTTP_PORT = 8080;

/** Remote URL for the HTTP server */
export const REMOTE_URL = `http://localhost:${HTTP_PORT}/remote.git`;

/** Branch name to create and push */
export const TEST_BRANCH = "feature-branch";

/** Default branch name */
export const DEFAULT_BRANCH = "main";
