/**
 * Free-space management as an explicit bit vector — roadmap-v5.md §2.2,
 * Silberschatz ch. 11.5.
 *
 * The filesystem always knew which blocks were free, but only implicitly:
 * allocation scanned every `DiskBlock` looking for one whose `owner` was
 * null. That works, and for 64 blocks it is not even slow — but it left
 * the textbook's actual subject, *how a filesystem represents free space*,
 * completely unmodelled. A real one does not walk its block table; it
 * keeps a bit per block and finds the first free one by scanning words,
 * testing 32 blocks at a time and skipping a full word of allocated
 * blocks with a single comparison.
 *
 * This is the authority on which blocks are free. `DiskBlock.owner` still
 * records *which inode* holds a block (the grid needs it to colour cells),
 * but nothing consults it to decide availability — see FilesystemEngine's
 * claimBlock()/releaseBlock(), the only two places allowed to change
 * either, precisely so the two representations cannot drift apart.
 */

const BITS_PER_WORD = 32
/** A word with every bit set — "all 32 of these blocks are taken". */
const FULL_WORD = 0xffffffff

export class FreeSpaceBitmap {
  /** Bit `i` set = block `i` is allocated. */
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

  /** Marks one block allocated. Returns false if it already was — the caller has a bug, not a full disk. */
  claim(block: number): boolean {
    if (!this.isFree(block)) return false
    this.words[FreeSpaceBitmap.wordIndex(block)]! |= FreeSpaceBitmap.mask(block)
    this.usedCount++
    return true
  }

  /** Marks one block free again. Returns false if it already was. */
  release(block: number): boolean {
    if (block < 0 || block >= this.blockCount || this.isFree(block)) return false
    this.words[FreeSpaceBitmap.wordIndex(block)]! &= ~FreeSpaceBitmap.mask(block)
    this.usedCount--
    return true
  }

  /**
   * The first free block at or after `from`, or -1 if there is none. A
   * word that is entirely allocated is skipped with one comparison rather
   * than 32 — the whole reason a bit vector is the classic representation.
   */
  findFirstFree(from = 0): number {
    for (let block = Math.max(0, from); block < this.blockCount; ) {
      const wordIndex = FreeSpaceBitmap.wordIndex(block)
      if (this.words[wordIndex] === FULL_WORD) {
        // Jump to the start of the next word, not just the next block.
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

  /** One boolean per block, allocated = true — for the UI's bitmap strip. */
  toArray(): boolean[] {
    return Array.from({ length: this.blockCount }, (_, i) => !this.isFree(i))
  }

  /** Rebuilds from ground truth, used after a disk import or reset. */
  rebuild(isAllocated: (block: number) => boolean): void {
    this.words = new Uint32Array(Math.ceil(this.blockCount / BITS_PER_WORD))
    this.usedCount = 0
    for (let block = 0; block < this.blockCount; block++) {
      if (isAllocated(block)) this.claim(block)
    }
  }
}
