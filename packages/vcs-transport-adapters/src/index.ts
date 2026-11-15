// Storage-seam repository facade (RepositoryFacade + RefStore over @statewalker/webrun-storage)
export {
  createStorageRepositoryFacade,
  type StorageRepositoryFacade,
  type StorageRepositoryFacadeDeps,
} from "./storage-repository-facade.js";
// VCS repository facade (RepositoryFacade using History facade)
export {
  createVcsRepositoryFacade,
  VcsRepositoryFacade,
  type VcsRepositoryFacadeConfig,
} from "./vcs-repository-facade.js";
