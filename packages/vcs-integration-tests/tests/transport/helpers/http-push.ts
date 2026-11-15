/**
 * The tests' smart-HTTP push: the transport's push client (`push`), reported as
 * success/error/refStatus. It replaced the transport's former `httpPush`, which these tests
 * were written against.
 */

import {
  isPushSuccess,
  type PushRefUpdate,
  push,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";

export interface HttpPushTestOptions {
  refspecs: string[];
  credentials?: { username: string; password: string };
  /** Called with the Request (and its headers as `init`) */
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface HttpPushTestResult {
  success: boolean;
  error?: string;
  refStatus?: Map<string, PushRefUpdate>;
}

export async function httpPush(
  url: string,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpPushTestOptions,
): Promise<HttpPushTestResult> {
  const { fetchFn } = options;
  try {
    const result = await push({
      url,
      repository,
      refStore,
      refspecs: options.refspecs,
      auth: options.credentials,
      fetchImpl: fetchFn ? (request) => fetchFn(request, { headers: request.headers }) : undefined,
    });
    const failed = result.updates.filter((u) => !isPushSuccess(u.status));
    return {
      success: result.ok,
      ...(result.ok ? {} : { error: failed.map((u) => `${u.remoteRef} ${u.summary}`).join(", ") }),
      refStatus: new Map(result.updates.map((u) => [u.remoteRef, u])),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
