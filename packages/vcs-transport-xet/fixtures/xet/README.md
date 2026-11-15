# Reference files

From the Hugging Face dataset `xet-team/xet-spec-reference-files` (Apache-2.0), the reference
data of the Xet protocol specification (https://huggingface.co/docs/xet):

- `Electric_Vehicle_Population_Data_20250917.csv.chunks`: the 796 chunks of the reference CSV
  (63,527,244 bytes), one `<chunk hash> <length>` line each;
- `….csv.xet-file-hash`, `….csv.xet-xorb-hash`: its file hash and its xorb's hash;
- `eea25d6e….xorb.range-hash`: the verification hash of the range of all 796 chunks;
- `….csv.shard`, `….csv.shard.verification`, `….csv.shard.verification-no-footer`,
  `….csv.shard.dedupe`: the reference shards, unchanged;
- `….csv.sha256`: the CSV's SHA-256 (its LFS oid in the Hub's `paths-info`), which the shards'
  metadata extension holds;
- `recon.recorded.json`: the reconstruction answer of `cas-server.xethub.hf.co` for the CSV's file
  hash (anonymous read token, 2026-11-12), with each signed URL replaced by `xorb://<hash>`.

The xorb itself (14.7 MB) is not committed. The tests read it from `XET_REFERENCE_CACHE`
(default `<tmp>/xet-reference`, file `eea25d6e….xorb`) and, with `XET_LIVE=1`, download it there
from the dataset (revision `c4aa3a3f15b1395fff5ce934784bf6c8f2d62de8`, SHA-256 checked); the
tests that need it are skipped otherwise. The CSV the reference files describe is Washington
State's "Electric Vehicle Population Data" (data.wa.gov, 2025-09-17); only hashes and lengths
derived from it are committed here.
