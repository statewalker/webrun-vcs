# Notes

Documentation and analysis for the WebRun VCS project.

## Instructions

* For each issue found during the execution, create a corresponding Beads bug / task / issue with a detailed description of what needs to be done.
* Before going to the next Beads epic, implement the current one, test it, typecheck, lint, format, commit and push (`bd sync`).
* After each completed Beads epic analyse all open issues and bugs non-attached to any epics, and check if they can be groupped in epics - existing or new once. If yes, attach them and update their description if needed.


* After each completed Beads epic, update this document with references to the corresponding epics and tasks, and add any relevant notes about the implementation process, any challenges faced, and how they were overcome.


### Implementation Instructions

* Implement open epics with all associated tasks
* Test all new features thoroughly
* Use separate branches/worktrees for parallel work by multiple agents
* After completing work in a branch/worktree: lint, format, commit, merge to main, and delete the branch
* Create Beads issues for any problems found during execution
* Complete, test, typecheck, lint, format, commit, and push each epic before starting the next (`bd sync`)
* After each epic: review open unattached issues and group them into new or existing epics
* Maintain a separate note document tracking implementation progress
* Update this document after each epic with: epic/task references, implementation notes, challenges, and solutions

## Completed Epics

### Epic: Replace SimpleStaging with GitStaging everywhere (webrun-vcs-1gv1n)

**Branch:** `feat/replace-simple-staging` (merged to main, commit `5f9cf88`)

**Tasks completed:**
- `webrun-vcs-sos26` - Added `createMemoryGitStaging()` factory to `git-staging.ts`
- `webrun-vcs-69h3w` - Replaced SimpleStaging in webrtc-p2p-sync production code
- `webrun-vcs-bp397` - Migrated 8 test files from SimpleStaging to GitStaging+MemFilesApi
- `webrun-vcs-mvcz7` - Replaced SimpleStaging in example apps (02, 04, 05, 07)
- `webrun-vcs-ws77u` - Replaced SimpleStaging in versioned-documents demo
- `webrun-vcs-cx5fb` - Deleted `simple-staging.ts` and removed barrel export
- `webrun-vcs-r2skw` - Quality gates: all tests pass, typecheck clean (except pre-existing `vcs-webrtc-sync` failures)

**Implementation notes:**
- `createMemoryGitStaging()` creates a `GitStaging` backed by `createInMemoryFilesApi()` with a virtual `"index"` path
- Drop-in replacement: `GitStaging.read()` gracefully handles missing index file (returns empty entries), so no test logic changes were needed
- 19 files changed, 70 insertions, 639 deletions (net -569 lines)

**Issues found during execution:**
- `webrun-vcs-cpxdn` (P3 bug) - Pre-existing typecheck failures in `vcs-webrtc-sync` demo (stale code referencing removed `WorkingCopy.staging` property)

## Remaining Open Issues

### Non-backlog ready work:
- `webrun-vcs-cpxdn` (P3, bug) - Fix typecheck failures in vcs-webrtc-sync demo
- `webrun-vcs-mppz1` (P2, feature) - Create packages/vcs-store-files package (blocks 3 dependent tasks)
- `webrun-vcs-s7fz2` (P3, task) - Evaluate alternative API design with lifecycle callbacks
- `webrun-vcs-gvjs` (P3, task) - Deploy to production and monitor (requires human action)

### Backlog (P4, skipped):
- `webrun-vcs-pvj17` - Implement P2P sync demo using LiveKit
