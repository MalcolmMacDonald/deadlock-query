/**
 * A lazy, re-iterable sequence with LINQ-style helpers. Pipelines do not materialise
 * intermediate results, so `pairs()` over large sets stays cheap until consumed.
 * @example new Seq([3, 1, 2]).where(n => n > 1).orderBy(n => n).toArray() // [2, 3]
 * @category Sequences
 */
export class Seq<T> implements Iterable<T> {
  constructor(protected readonly source: Iterable<T>) {}

  [Symbol.iterator](): Iterator<T> {
    return this.source[Symbol.iterator]()
  }

  /** Rebuild a sequence of the same concrete type; subclasses override. */
  protected make(source: Iterable<T>): Seq<T> {
    return new Seq(source)
  }

  /**
   * Keep elements matching the predicate.
   * @example new Seq([1, 2, 3]).where(n => n > 1)
   * @category Sequences
   */
  where(predicate: (item: T, index: number) => boolean): Seq<T> {
    const src = this.source
    return this.make({ *[Symbol.iterator]() { let i = 0; for (const x of src) if (predicate(x, i++)) yield x } })
  }

  /**
   * Map each element.
   * @example map.guardians.select(g => g.position)
   * @category Sequences
   */
  select<U>(f: (item: T, index: number) => U): Seq<U> {
    const src = this.source
    return new Seq({ *[Symbol.iterator]() { let i = 0; for (const x of src) yield f(x, i++) } })
  }

  /**
   * Map each element to an iterable and flatten.
   * @example map.guardians.selectMany(g => map.healingOrbs.select(o => [g, o]))
   * @category Sequences
   */
  selectMany<U>(f: (item: T, index: number) => Iterable<U>): Seq<U> {
    const src = this.source
    return new Seq({ *[Symbol.iterator]() { let i = 0; for (const x of src) yield* f(x, i++) } })
  }

  /**
   * Group by key (materialises). Groups keep first-seen order.
   * @example map.creepCamps.groupBy(c => c.properties.subclass_name)
   * @category Sequences
   */
  groupBy<K>(key: (item: T) => K): Seq<{ readonly key: K; readonly items: T[] }> {
    const src = this.source
    return new Seq({
      *[Symbol.iterator]() {
        const groups = new Map<K, T[]>()
        for (const x of src) {
          const k = key(x)
          const g = groups.get(k)
          if (g) g.push(x)
          else groups.set(k, [x])
        }
        for (const [k, items] of groups) yield { key: k, items }
      }
    })
  }

  /**
   * Sort ascending by a numeric or string key (stable, materialises).
   * @example map.healingOrbs.orderBy(o => o.position.z)
   * @category Sequences
   */
  orderBy(key: (item: T) => number | string): OrderedSeq<T> {
    return new OrderedSeq(this.source, [{ key, desc: false }])
  }

  /**
   * Sort descending by a numeric or string key (stable, materialises).
   * @example map.healingOrbs.orderByDescending(o => o.position.z)
   * @category Sequences
   */
  orderByDescending(key: (item: T) => number | string): OrderedSeq<T> {
    return new OrderedSeq(this.source, [{ key, desc: true }])
  }

  /**
   * Remove duplicates, by identity or by a key.
   * @example new Seq([1, 1, 2]).distinct()
   * @category Sequences
   */
  distinct(key: (item: T) => unknown = (x) => x): Seq<T> {
    const src = this.source
    return this.make({ *[Symbol.iterator]() { const seen = new Set<unknown>(); for (const x of src) { const k = key(x); if (!seen.has(k)) { seen.add(k); yield x } } } })
  }

  /**
   * First `n` elements.
   * @example map.healingOrbs.take(2)
   * @category Sequences
   */
  take(n: number): Seq<T> {
    const src = this.source
    return this.make({ *[Symbol.iterator]() { if (n <= 0) return; let i = 0; for (const x of src) { yield x; if (++i >= n) return } } })
  }

  /**
   * Skip the first `n` elements.
   * @example map.healingOrbs.skip(1)
   * @category Sequences
   */
  skip(n: number): Seq<T> {
    const src = this.source
    return this.make({ *[Symbol.iterator]() { let i = 0; for (const x of src) if (i++ >= n) yield x } })
  }

  /**
   * First element (matching the predicate, if given) or `undefined`.
   * @example map.guardians.first()
   * @category Sequences
   */
  first(predicate?: (item: T) => boolean): T | undefined {
    for (const x of this.source) if (!predicate || predicate(x)) return x
    return undefined
  }

  /**
   * True if any element matches (or the sequence is non-empty without a predicate).
   * @example map.walkers.any(w => w.team === 2)
   * @category Sequences
   */
  any(predicate?: (item: T) => boolean): boolean {
    for (const x of this.source) if (!predicate || predicate(x)) return true
    return false
  }

  /**
   * True if every element matches.
   * @example map.guardians.all(g => g.position.z < 100)
   * @category Sequences
   */
  all(predicate: (item: T) => boolean): boolean {
    for (const x of this.source) if (!predicate(x)) return false
    return true
  }

  /**
   * Number of elements (matching the predicate, if given). O(n).
   * @example map.guardians.count()
   * @category Sequences
   */
  count(predicate?: (item: T) => boolean): number {
    let n = 0
    for (const x of this.source) if (!predicate || predicate(x)) n++
    return n
  }

  /**
   * Sum of a numeric projection.
   * @example map.healingOrbs.sum(o => o.position.z)
   * @category Sequences
   */
  sum(f: (item: T) => number): number {
    let s = 0
    for (const x of this.source) s += f(x)
    return s
  }

  /**
   * Element with the smallest projected value, or `undefined` when empty.
   * @example map.healingOrbs.min(o => o.position.z)
   * @category Sequences
   */
  min(f: (item: T) => number): T | undefined {
    let best: T | undefined
    let bestV = Infinity
    for (const x of this.source) { const v = f(x); if (v < bestV) { bestV = v; best = x } }
    return best
  }

  /**
   * Element with the largest projected value, or `undefined` when empty.
   * @example map.healingOrbs.max(o => o.position.z)
   * @category Sequences
   */
  max(f: (item: T) => number): T | undefined {
    let best: T | undefined
    let bestV = -Infinity
    for (const x of this.source) { const v = f(x); if (v > bestV) { bestV = v; best = x } }
    return best
  }

  /**
   * Pair elements with another iterable, stopping at the shorter one.
   * @example map.guardians.zip(map.walkers)
   * @category Sequences
   */
  zip<U>(other: Iterable<U>): Seq<readonly [T, U]> {
    const src = this.source
    return new Seq({
      *[Symbol.iterator]() {
        const it = other[Symbol.iterator]()
        for (const a of src) { const b = it.next(); if (b.done) return; yield [a, b.value] as const }
      }
    })
  }

  /**
   * All unordered pairs `(a, b)` with `a` before `b`. Lazy generator, but O(n²) when consumed:
   * sample first (`take`, `chunk`) on large sets.
   * @example map.guardians.pairs().where(([a, b]) => a.team !== b.team)
   * @category Sequences
   */
  pairs(): Seq<readonly [T, T]> {
    const src = this.source
    return new Seq({
      *[Symbol.iterator]() {
        const items = [...src]
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) yield [items[i] as T, items[j] as T] as const
      }
    })
  }

  /**
   * Split into arrays of at most `size` elements.
   * @example map.healingOrbs.chunk(2)
   * @category Sequences
   */
  chunk(size: number): Seq<T[]> {
    const src = this.source
    return new Seq({
      *[Symbol.iterator]() {
        let buf: T[] = []
        for (const x of src) { buf.push(x); if (buf.length >= size) { yield buf; buf = [] } }
        if (buf.length) yield buf
      }
    })
  }

  /**
   * Materialise into an array.
   * @example map.guardians.where(g => g.team === 2).toArray()
   * @category Sequences
   */
  toArray(): T[] {
    return [...this.source]
  }
}

/**
 * A sequence with a sort order; add tie-breakers with {@link OrderedSeq.thenBy}.
 * @example map.healingOrbs.orderBy(o => o.team ?? 0).thenBy(o => o.position.z)
 * @category Sequences
 */
export class OrderedSeq<T> extends Seq<T> {
  constructor(
    private readonly raw: Iterable<T>,
    private readonly keys: ReadonlyArray<{ key: (item: T) => number | string; desc: boolean }>
  ) {
    super({
      *[Symbol.iterator]() {
        const items = [...raw]
        const keyed = items.map((item, i) => ({ item, i, ks: keys.map((k) => k.key(item)) }))
        keyed.sort((a, b) => {
          for (let n = 0; n < keys.length; n++) {
            const x = a.ks[n]!, y = b.ks[n]!
            if (x === y) continue
            return (x < y ? -1 : 1) * (keys[n]!.desc ? -1 : 1)
          }
          return a.i - b.i
        })
        for (const k of keyed) yield k.item
      }
    })
  }

  /**
   * Tie-breaker ascending.
   * @example map.healingOrbs.orderBy(o => o.team ?? 0).thenBy(o => o.position.z)
   * @category Sequences
   */
  thenBy(key: (item: T) => number | string): OrderedSeq<T> {
    return new OrderedSeq(this.raw, [...this.keys, { key, desc: false }])
  }

  /**
   * Tie-breaker descending.
   * @example map.healingOrbs.orderBy(o => o.team ?? 0).thenByDescending(o => o.position.z)
   * @category Sequences
   */
  thenByDescending(key: (item: T) => number | string): OrderedSeq<T> {
    return new OrderedSeq(this.raw, [...this.keys, { key, desc: true }])
  }
}
