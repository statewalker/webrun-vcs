/**
 * Calculate a 32-bit checksum of a byte array
 * Reference implementation for testing FossilChecksum
 */

export function checksum(arr: Uint8Array): number {
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  let z = 0;
  let N = arr.length;

  while (N >= 16) {
    sum0 = (sum0 + arr[z + 0]) | 0;
    sum1 = (sum1 + arr[z + 1]) | 0;
    sum2 = (sum2 + arr[z + 2]) | 0;
    sum3 = (sum3 + arr[z + 3]) | 0;
    sum0 = (sum0 + arr[z + 4]) | 0;
    sum1 = (sum1 + arr[z + 5]) | 0;
    sum2 = (sum2 + arr[z + 6]) | 0;
    sum3 = (sum3 + arr[z + 7]) | 0;
    sum0 = (sum0 + arr[z + 8]) | 0;
    sum1 = (sum1 + arr[z + 9]) | 0;
    sum2 = (sum2 + arr[z + 10]) | 0;
    sum3 = (sum3 + arr[z + 11]) | 0;
    sum0 = (sum0 + arr[z + 12]) | 0;
    sum1 = (sum1 + arr[z + 13]) | 0;
    sum2 = (sum2 + arr[z + 14]) | 0;
    sum3 = (sum3 + arr[z + 15]) | 0;
    z += 16;
    N -= 16;
  }

  while (N >= 4) {
    sum0 = (sum0 + arr[z + 0]) | 0;
    sum1 = (sum1 + arr[z + 1]) | 0;
    sum2 = (sum2 + arr[z + 2]) | 0;
    sum3 = (sum3 + arr[z + 3]) | 0;
    z += 4;
    N -= 4;
  }

  sum3 = (((((sum3 + (sum2 << 8)) | 0) + (sum1 << 16)) | 0) + (sum0 << 24)) | 0;

  if (N === 3) {
    sum3 = (sum3 + (arr[z + 2] << 8)) | 0;
    sum3 = (sum3 + (arr[z + 1] << 16)) | 0;
    sum3 = (sum3 + (arr[z + 0] << 24)) | 0;
  } else if (N === 2) {
    sum3 = (sum3 + (arr[z + 1] << 16)) | 0;
    sum3 = (sum3 + (arr[z + 0] << 24)) | 0;
  } else if (N === 1) {
    sum3 = (sum3 + (arr[z + 0] << 24)) | 0;
  }

  return sum3 >>> 0;
}
