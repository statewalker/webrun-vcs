// Git-native repository access (direct passthrough to GitObjectStore)
export * from "./git-native-repository-access.js";
// Object graph walker
export * from "./object-graph-walker.js";
// Storage adapter (legacy)
export * from "./storage-adapter.js";
// Storage-seam repository facade (RepositoryFacade + RefStore over @statewalker/webrun-storage)
export {
  createStorageRepositoryFacade,
  type StorageRepositoryFacade,
  type StorageRepositoryFacadeDeps,
} from "./storage-repository-facade.js";
// VCS repository access (uses History facade)
export {
  createVcsRepositoryAccess,
  VcsRepositoryAccess,
  type VcsRepositoryAccessConfig,
} from "./vcs-repository-access.js";
// VCS repository facade (RepositoryFacade using History facade)
export {
  createVcsRepositoryFacade,
  VcsRepositoryFacade,
  type VcsRepositoryFacadeConfig,
} from "./vcs-repository-facade.js";
// Wire format utilities
export * from "./wire-format-utils.js";
