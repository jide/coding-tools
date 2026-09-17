/**
 * Bounded output collector. Keeps the head and the tail of a stream (the end
 * of a test run is usually the most useful part) and drops the middle.
 */
export class BoundedOutput {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const headLimit = Math.floor(this.maxBytes / 2);
    if (this.headBytes < headLimit) {
      const take = chunk.subarray(0, headLimit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    const tailLimit = this.maxBytes - headLimit;
    while (this.tailBytes > tailLimit) {
      const excess = this.tailBytes - tailLimit;
      const first = this.tail[0];
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (!this.truncated) return head + tail;
    return `${head}\n[... ${this.dropped} bytes truncated ...]\n${tail}`;
  }
}

export function truncateString(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s) <= maxBytes) return { text: s, truncated: false };
  const out = new BoundedOutput(maxBytes);
  out.push(Buffer.from(s));
  return { text: out.toString(), truncated: true };
}
