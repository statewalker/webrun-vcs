/**
 * JGit-style Rolling Hash Implementation
 *
 * Based on JGit's DeltaIndex hash algorithm. Uses 16-byte blocks
 * with lookup tables for efficient rolling updates.
 *
 * The rolling hash allows O(1) updates when sliding a window,
 * making delta computation efficient.
 *
 * @see https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/DeltaIndex.java
 */

/**
 * Block size for hash computation
 *
 * This is fixed at 16 bytes - the same as JGit.
 * Trade-offs:
 * - Small enough to find matches in similar files
 * - Large enough to keep index size manageable (~0.75x source)
 */
export const JGIT_BLOCK_SIZE = 16;

/**
 * Maximum chain length in hash table
 *
 * Limits collision chains to keep encoding time linear O(len_src + len_dst)
 * rather than quadratic O(len_src * len_dst).
 */
export const MAX_CHAIN_LENGTH = 64;

/**
 * T[] lookup table - used for hash mixing
 *
 * Applied when adding a new byte to the hash window.
 * Indexed by top bits of current hash (hash >>> 23).
 *
 * These values are from JGit's DeltaIndex.java
 */
const T: Uint32Array = new Uint32Array([
  0x00000000, 0xab59b4d1, 0x56b369a2, 0xfdeadd73, 0x063f6795, 0xad66d344, 0x508c0e37, 0xfbd5bae6,
  0x0c7ecf2a, 0xa7277bfb, 0x5acda688, 0xf1941259, 0x0a41a8bf, 0xa1181c6e, 0x5cf2c11d, 0xf7ab75cc,
  0x18fd9e54, 0xb3a42a85, 0x4e4ef7f6, 0xe5174327, 0x1ec2f9c1, 0xb59b4d10, 0x48719063, 0xe32824b2,
  0x1483517e, 0xbfdae5af, 0x423038dc, 0xe9698c0d, 0x12bc36eb, 0xb9e5823a, 0x440f5f49, 0xef56eb98,
  0x31fb3ca8, 0x9aa28879, 0x6748550a, 0xcc11e1db, 0x37c45b3d, 0x9c9defec, 0x6177329f, 0xca2e864e,
  0x3d85f382, 0x96dc4753, 0x6b369a20, 0xc06f2ef1, 0x3bba9417, 0x90e320c6, 0x6d09fdb5, 0xc6504964,
  0x2906a2fc, 0x825f162d, 0x7fb5cb5e, 0xd4ec7f8f, 0x2f39c569, 0x846071b8, 0x798aaccb, 0xd2d3181a,
  0x25786dd6, 0x8e21d907, 0x73cb0474, 0xd892b0a5, 0x23470a43, 0x881ebe92, 0x75f463e1, 0xdeadd730,
  0x63f67950, 0xc8afcd81, 0x354510f2, 0x9e1ca423, 0x65c91ec5, 0xce90aa14, 0x337a7767, 0x9823c3b6,
  0x6f88b67a, 0xc4d102ab, 0x393bdfd8, 0x92626b09, 0x69b7d1ef, 0xc2ee653e, 0x3f04b84d, 0x945d0c9c,
  0x7b0be704, 0xd05253d5, 0x2db88ea6, 0x86e13a77, 0x7d348091, 0xd66d3440, 0x2b87e933, 0x80de5de2,
  0x7775282e, 0xdc2c9cff, 0x21c6418c, 0x8a9ff55d, 0x714a4fbb, 0xda13fb6a, 0x27f92619, 0x8ca092c8,
  0x520d45f8, 0xf954f129, 0x04be2c5a, 0xafe7988b, 0x5432226d, 0xff6b96bc, 0x02814bcf, 0xa9d8ff1e,
  0x5e738ad2, 0xf52a3e03, 0x08c0e370, 0xa39957a1, 0x584ced47, 0xf3155996, 0x0eff84e5, 0xa5a63034,
  0x4af0dbac, 0xe1a96f7d, 0x1c43b20e, 0xb71a06df, 0x4ccfbc39, 0xe79608e8, 0x1a7cd59b, 0xb125614a,
  0x468e1486, 0xedd7a057, 0x103d7d24, 0xbb64c9f5, 0x40b17313, 0xebe8c7c2, 0x16021ab1, 0xbd5bae60,
  0xc7ecf2a0, 0x6cb54671, 0x915f9b02, 0x3a062fd3, 0xc1d39535, 0x6a8a21e4, 0x9760fc97, 0x3c394846,
  0xcb923d8a, 0x60cb895b, 0x9d215428, 0x3678e0f9, 0xcdad5a1f, 0x66f4eece, 0x9b1e33bd, 0x3047876c,
  0xdf116cf4, 0x7448d825, 0x89a20556, 0x22fbb187, 0xd92e0b61, 0x7277bfb0, 0x8f9d62c3, 0x24c4d612,
  0xd36fa3de, 0x7836170f, 0x85dcca7c, 0x2e857ead, 0xd550c44b, 0x7e09709a, 0x83e3ade9, 0x28ba1938,
  0xf617ce08, 0x5d4e7ad9, 0xa0a4a7aa, 0x0bfd137b, 0xf028a99d, 0x5b711d4c, 0xa69bc03f, 0x0dc274ee,
  0xfa690122, 0x5130b5f3, 0xacda6880, 0x0783dc51, 0xfc5666b7, 0x570fd266, 0xaae50f15, 0x01bcbbc4,
  0xeeea505c, 0x45b3e48d, 0xb85939fe, 0x13008d2f, 0xe8d537c9, 0x438c8318, 0xbe665e6b, 0x153feaba,
  0xe2949f76, 0x49cd2ba7, 0xb427f6d4, 0x1f7e4205, 0xe4abf8e3, 0x4ff24c32, 0xb2189141, 0x19412590,
  0xa41a8bf0, 0x0f433f21, 0xf2a9e252, 0x59f05683, 0xa225ec65, 0x097c58b4, 0xf49685c7, 0x5fcf3116,
  0xa86444da, 0x033df00b, 0xfe772d78, 0x552e99a9, 0xaefb234f, 0x05a2979e, 0xf8484aed, 0x5311fe3c,
  0xbc4715a4, 0x171ea175, 0xeaf47c06, 0x41adc8d7, 0xba787231, 0x1121c6e0, 0xeccb1b93, 0x4792af42,
  0xb039da8e, 0x1b606e5f, 0xe68ab32c, 0x4dd307fd, 0xb606bd1b, 0x1d5f09ca, 0xe0b5d4b9, 0x4bec6068,
  0x9541b758, 0x3e180389, 0xc3f2defa, 0x68ab6a2b, 0x937ed0cd, 0x3827641c, 0xc5cdb96f, 0x6e940dbe,
  0x993f7872, 0x3266cca3, 0xcf8c11d0, 0x64d5a501, 0x9f001fe7, 0x3459ab36, 0xc9b37645, 0x62eac294,
  0x8dbc290c, 0x26e59ddd, 0xdb0f40ae, 0x7056f47f, 0x8b834e99, 0x20dafa48, 0xdd30273b, 0x766993ea,
  0x81c2e626, 0x2a9b52f7, 0xd7718f84, 0x7c283b55, 0x87fd81b3, 0x2ca43562, 0xd14ee811, 0x7a175cc0,
]);

/**
 * U[] lookup table - used for removing outgoing byte in rolling hash
 *
 * Applied when sliding the window by one byte.
 * Indexed by the byte value being removed.
 *
 * These values are from JGit's DeltaIndex.java
 */
const U: Uint32Array = new Uint32Array([
  0x00000000, 0x7eb5200d, 0x5633f4da, 0x2886d4d7, 0x073e5d65, 0x798b7d68, 0x510da9bf, 0x2fb889b2,
  0x0e7cbaca, 0x70c99ac7, 0x584f4e10, 0x26fa6e1d, 0x0942e7af, 0x77f7c7a2, 0x5f711375, 0x21c43378,
  0x1cf9754e, 0x624c5543, 0x4aca8194, 0x347fa199, 0x1bc7282b, 0x65720826, 0x4df4dcf1, 0x3341fcfc,
  0x1285cf84, 0x6c30ef89, 0x44b63b5e, 0x3a031b53, 0x15bb92e1, 0x6b0eb2ec, 0x4388663b, 0x3d3d4636,
  0x39f2ea9c, 0x4747ca91, 0x6fc11e46, 0x11743e4b, 0x3eccb7f9, 0x407997f4, 0x68ff4323, 0x164a632e,
  0x378e5056, 0x493b705b, 0x61bda48c, 0x1f088481, 0x30b00d33, 0x4e052d3e, 0x6683f9e9, 0x1836d9e4,
  0x250b9fd2, 0x5bbebfdf, 0x73386b08, 0x0d8d4b05, 0x2235c2b7, 0x5c80e2ba, 0x7406366d, 0x0ab31660,
  0x2b772518, 0x55c20515, 0x7d44d1c2, 0x03f1f1cf, 0x2c49787d, 0x52fc5870, 0x7a7a8ca7, 0x04cfacaa,
  0x73e5d5e8, 0x0d50f5e5, 0x25d62132, 0x5b63013f, 0x74db888d, 0x0a6ea880, 0x22e87c57, 0x5c5d5c5a,
  0x7d996f22, 0x032c4f2f, 0x2baa9bf8, 0x551fbbf5, 0x7aa73247, 0x0412124a, 0x2c94c69d, 0x5221e690,
  0x6f1ca0a6, 0x11a980ab, 0x392f547c, 0x479a7471, 0x6822fdc3, 0x1697ddce, 0x3e110919, 0x40a42914,
  0x61601a6c, 0x1fd53a61, 0x3753eeb6, 0x49e6cebb, 0x665e4709, 0x18eb6704, 0x306db3d3, 0x4ed893de,
  0x4a173f74, 0x34a21f79, 0x1c24cbae, 0x6291eba3, 0x4d296211, 0x339c421c, 0x1b1a96cb, 0x65afb6c6,
  0x446b85be, 0x3adea5b3, 0x12587164, 0x6ced5169, 0x4355d8db, 0x3de0f8d6, 0x15662c01, 0x6bd30c0c,
  0x56ee4a3a, 0x285b6a37, 0x00ddbee0, 0x7e689eed, 0x51d0175f, 0x2f653752, 0x07e3e385, 0x7956c388,
  0x5892f0f0, 0x2627d0fd, 0x0ea1042a, 0x70142427, 0x5facad95, 0x21198d98, 0x099f594f, 0x772a7942,
  0xe7cbab20, 0x997e8b2d, 0xb1f85ffa, 0xcf4d7ff7, 0xe0f5f645, 0x9e40d648, 0xb6c6029f, 0xc8732292,
  0xe9b711ea, 0x970231e7, 0xbf84e530, 0xc131c53d, 0xee894c8f, 0x903c6c82, 0xb8bab855, 0xc60f9858,
  0xfb32de6e, 0x8587fe63, 0xad012ab4, 0xd3b40ab9, 0xfc0c830b, 0x82b9a306, 0xaa3f77d1, 0xd48a57dc,
  0xf54e64a4, 0x8bfb44a9, 0xa37d907e, 0xddceb073, 0xf27639c1, 0x8cc319cc, 0xa445cd1b, 0xdaf0ed16,
  0xde3f41bc, 0xa08a61b1, 0x880cb566, 0xf6b9956b, 0xd9011cd9, 0xa7b43cd4, 0x8f32e803, 0xf187c80e,
  0xd043fb76, 0xaef6db7b, 0x86700fac, 0xf8c52fa1, 0xd77da613, 0xa9c8861e, 0x814e52c9, 0xfffb72c4,
  0xc2c634f2, 0xbc7314ff, 0x94f5c028, 0xea40e025, 0xc5f86997, 0xbb4d499a, 0x93cb9d4d, 0xed7ebd40,
  0xccba8e38, 0xb20fae35, 0x9a897ae2, 0xe43c5aef, 0xcb84d35d, 0xb531f350, 0x9db72787, 0xe302078a,
  0x942e7ec8, 0xea9b5ec5, 0xc21d8a12, 0xbca8aa1f, 0x931023ad, 0xeda503a0, 0xc523d777, 0xbb96f77a,
  0x9a52c402, 0xe4e7e40f, 0xcc6130d8, 0xb2d410d5, 0x9d6c9967, 0xe3d9b96a, 0xcb5f6dbd, 0xb5ea4db0,
  0x88d70b86, 0xf6622b8b, 0xdee4ff5c, 0xa051df51, 0x8fe956e3, 0xf15c76ee, 0xd9daa239, 0xa76f8234,
  0x86abb14c, 0xf81e9141, 0xd0984596, 0xae2d659b, 0x8195ec29, 0xff20cc24, 0xd7a618f3, 0xa91338fe,
  0xaddc9454, 0xd369b459, 0xfbef608e, 0x855a4083, 0xaae2c931, 0xd457e93c, 0xfcd13deb, 0x82641de6,
  0xa3a02e9e, 0xdd150e93, 0xf593da44, 0x8b26fa49, 0xa49e73fb, 0xda2b53f6, 0xf2ad8721, 0x8c18a72c,
  0xb125e11a, 0xcf90c117, 0xe71615c0, 0x99a335cd, 0xb61bbc7f, 0xc8ae9c72, 0xe02848a5, 0x9e9d68a8,
  0xbf595bd0, 0xc1ec7bdd, 0xe96aaf0a, 0x97df8f07, 0xb86706b5, 0xc6d226b8, 0xee54f26f, 0x90e1d262,
]);

/**
 * Compute hash of a 16-byte block using JGit algorithm
 *
 * @param data Source data buffer
 * @param offset Start position in data
 * @returns 32-bit hash value
 */
export function jgitHashBlock(data: Uint8Array, offset: number): number {
  // First 4 bytes as big-endian 32-bit integer
  let hash =
    ((data[offset] & 0xff) << 24) |
    ((data[offset + 1] & 0xff) << 16) |
    ((data[offset + 2] & 0xff) << 8) |
    (data[offset + 3] & 0xff);

  // XOR with T using top bit (0 or 1)
  hash ^= T[hash >>> 31];

  // Process remaining 12 bytes with unrolled loop
  hash = ((hash << 8) | (data[offset + 4] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 5] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 6] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 7] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 8] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 9] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 10] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 11] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 12] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 13] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 14] & 0xff)) ^ T[hash >>> 23];
  hash = ((hash << 8) | (data[offset + 15] & 0xff)) ^ T[hash >>> 23];

  return hash >>> 0; // Ensure unsigned 32-bit
}

/**
 * Rolling hash step - update hash when sliding window by one byte
 *
 * O(1) update instead of recomputing the full 16-byte hash.
 * Formula from JGit: ((oldHash << 8) | in) ^ T[(oldHash >>> 23)] ^ U[out]
 *
 * @param hash Current hash value
 * @param toRemove Byte falling off the window (at position -16)
 * @param toAdd Byte entering the window (at current position)
 * @returns Updated hash value
 */
export function jgitHashStep(hash: number, toRemove: number, toAdd: number): number {
  // JGit formula: ((oldHash << 8) | in) ^ T[(oldHash >>> 23)] ^ U[out]
  return (((hash << 8) | (toAdd & 0xff)) ^ T[hash >>> 23] ^ U[toRemove & 0xff]) >>> 0;
}

/**
 * Estimate memory usage for delta index
 *
 * @param sourceLength Source buffer length in bytes
 * @returns Estimated memory usage in bytes (~1.75x source size)
 */
export function estimateJgitIndexSize(sourceLength: number): number {
  // Source buffer + ~0.75x for hash table and entries
  return sourceLength + Math.floor((sourceLength * 3) / 4);
}

/**
 * Calculate power-of-2 table size for block count
 *
 * @param blockCount Number of blocks to index
 * @returns Smallest power of 2 >= blockCount
 */
export function jgitTableSize(blockCount: number): number {
  if (blockCount <= 0) return 1;
  // Find next power of 2
  let size = 1;
  while (size < blockCount) {
    size <<= 1;
  }
  return size;
}

/**
 * JGit-style rolling hash class for object-oriented usage
 *
 * Provides same functionality as the functional API but
 * encapsulated in a class for stateful operations.
 */
export class JgitRollingHash {
  private hash = 0;
  private readonly window: Uint8Array;
  private windowPos = 0;
  private initialized = false;

  constructor(readonly blockSize = JGIT_BLOCK_SIZE) {
    this.window = new Uint8Array(blockSize);
  }

  /**
   * Initialize hash with first block
   */
  init(data: Uint8Array, offset: number): this {
    if (offset + this.blockSize > data.length) {
      throw new Error("Not enough data to initialize hash");
    }
    this.hash = jgitHashBlock(data, offset);
    this.window.set(data.subarray(offset, offset + this.blockSize));
    this.windowPos = 0;
    this.initialized = true;
    return this;
  }

  /**
   * Update hash by sliding window one byte
   */
  update(newByte: number): number {
    if (!this.initialized) {
      throw new Error("Hash not initialized");
    }
    const outByte = this.window[this.windowPos];
    this.window[this.windowPos] = newByte;
    this.windowPos = (this.windowPos + 1) % this.blockSize;
    this.hash = jgitHashStep(this.hash, outByte, newByte);
    return this.hash;
  }

  /**
   * Get current hash value
   */
  value(): number {
    return this.hash;
  }

  /**
   * Reset state
   */
  reset(): void {
    this.hash = 0;
    this.windowPos = 0;
    this.initialized = false;
    this.window.fill(0);
  }
}
