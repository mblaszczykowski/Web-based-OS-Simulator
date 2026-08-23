const BITS_PER_WORD = 32
const FULL_WORD = 0xffffffff

/**
 * Free-space management as a bit vector: one bit per block, packed into
 * 32-bit words so a fully-allocated word is skipped with a single
 * comparison instead of 32 tests.
 */
export class FreeSpaceBitmap {
  private words: Uint32Array
  private usedCount = 0

  constructor(private blockCount: number) {
    this.words = new Uint32Array(Math.ceil(blockCount / BITS_PER_WORD))
  }

  private static wordIndex(block: number): number {
    return Math.floor(block / BITS_PER_WORD)
  }

  private static mask(block: number): number {
    return 1 << block % BITS_PER_WORD
  }

  isFree(block: number): boolean {
    if (block < 0 || block >= this.blockCount) return false
    return (this.words[FreeSpaceBitmap.wordIndex(block)]! & FreeSpaceBitmap.mask(block)) === 0
  }

  claim(block: number): boolean {
    if (!this.isFree(block)) return false
    this.words[FreeSpaceBitmap.wordIndex(block)]! |= FreeSpaceBitmap.mask(block)
    this.usedCount++
    return true
  }

  release(block: number): boolean {
    if (block < 0 || block >= this.blockCount || this.isFree(block)) return false
    this.words[FreeSpaceBitmap.wordIndex(block)]! &= ~FreeSpaceBitmap.mask(block)
    this.usedCount--
    return true
  }

  /** First free block at or after `from`, or -1. Skips whole allocated words. */
  findFirstFree(from = 0): number {
    for (let block = Math.max(0, from); block < this.blockCount; ) {
      const wordIndex = FreeSpaceBitmap.wordIndex(block)
      if (this.words[wordIndex] === FULL_WORD) {
        block = (wordIndex + 1) * BITS_PER_WORD
        continue
      }
      if (this.isFree(block)) return block
      block++
    }
    return -1
  }

  get freeCount(): number {
    return this.blockCount - this.usedCount
  }

  get used(): number {
    return this.usedCount
  }

  get size(): number {
    return this.blockCount
  }

  toArray(): boolean[] {
    return Array.from({ length: this.blockCount }, (_, i) => !this.isFree(i))
  }

  rebuild(isAllocated: (block: number) => boolean): void {
    this.words = new Uint32Array(Math.ceil(this.blockCount / BITS_PER_WORD))
    this.usedCount = 0
    for (let block = 0; block < this.blockCount; block++) {
      if (isAllocated(block)) this.claim(block)
    }
  }
}
