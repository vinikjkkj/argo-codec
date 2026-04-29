// Growable byte buffer + varint/zig-zag label codec.
// Hot path is meant to be inlined as much as possible: field access, no closures.

export class Buf {
    arr: Uint8Array
    view: DataView
    pos = 0

    constructor(cap = 256) {
        this.arr = new Uint8Array(cap)
        this.view = new DataView(this.arr.buffer)
    }

    private grow(min: number) {
        let cap = this.arr.length << 1
        while (cap < min) cap <<= 1
        const next = new Uint8Array(cap)
        next.set(this.arr.subarray(0, this.pos))
        this.arr = next
        this.view = new DataView(this.arr.buffer)
    }

    ensure(n: number) {
        if (this.pos + n > this.arr.length) this.grow(this.pos + n)
    }

    byte(b: number) {
        if (this.pos >= this.arr.length) this.grow(this.pos + 1)
        this.arr[this.pos++] = b
    }

    bytes(b: Uint8Array) {
        this.ensure(b.length)
        this.arr.set(b, this.pos)
        this.pos += b.length
    }

    // 8 bytes IEEE 754 little-endian.
    f64(n: number) {
        this.ensure(8)
        this.view.setFloat64(this.pos, n, true)
        this.pos += 8
    }

    // Unsigned varint (protobuf style: 7 data bits per byte, MSB = continuation).
    uvarint(n: number) {
        while (n >= 0x80) {
            if (this.pos >= this.arr.length) this.grow(this.pos + 1)
            this.arr[this.pos++] = (n & 0x7f) | 0x80
            n = Math.floor(n / 128)
        }
        if (this.pos >= this.arr.length) this.grow(this.pos + 1)
        this.arr[this.pos++] = n & 0x7f
    }

    // Signed Label using variable-length zig-zag coding.
    label(n: number) {
        // ZigZag: n >= 0 ? n*2 : (-n-1)*2 + 1   (matches `n<<1` / `(n<<1)^~0` from spec, in 53-bit safe form)
        const z = n >= 0 ? n * 2 : -n * 2 - 1
        this.uvarint(z)
    }

    // Big varint (for full 64-bit values via bigint). Used only when number cannot represent.
    uvarintBig(n: bigint) {
        while (n >= 0x80n) {
            if (this.pos >= this.arr.length) this.grow(this.pos + 1)
            this.arr[this.pos++] = Number(n & 0x7fn) | 0x80
            n >>= 7n
        }
        if (this.pos >= this.arr.length) this.grow(this.pos + 1)
        this.arr[this.pos++] = Number(n) & 0x7f
    }

    labelBig(n: bigint) {
        const z = n >= 0n ? n << 1n : (n << 1n) ^ ~0n
        this.uvarintBig(z)
    }

    // The data written so far as a subarray view (zero-copy).
    view0(): Uint8Array {
        return this.arr.subarray(0, this.pos)
    }
}

// Reader holds a single backing Uint8Array and advances `pos`.
// All multi-byte reads return subarrays that alias the source buffer (zero-copy).
export class Reader {
    arr: Uint8Array
    view: DataView
    pos: number
    end: number

    constructor(arr: Uint8Array, pos = 0, end = arr.length) {
        this.arr = arr
        this.view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength)
        this.pos = pos
        this.end = end
    }

    byte(): number {
        if (this.pos >= this.end) throw new RangeError('Reader: out of bounds')
        return this.arr[this.pos++]
    }

    bytes(n: number): Uint8Array {
        if (this.pos + n > this.end) throw new RangeError('Reader: out of bounds')
        const r = this.arr.subarray(this.pos, this.pos + n)
        this.pos += n
        return r
    }

    f64(): number {
        if (this.pos + 8 > this.end) throw new RangeError('Reader: out of bounds')
        const r = this.view.getFloat64(this.pos, true)
        this.pos += 8
        return r
    }

    uvarint(): number {
        let n = 0
        let shift = 1
        let b: number
        do {
            if (this.pos >= this.end) throw new RangeError('Reader: out of bounds')
            b = this.arr[this.pos++]
            n += (b & 0x7f) * shift
            shift *= 128
        } while (b & 0x80)
        return n
    }

    label(): number {
        const z = this.uvarint()
        return z % 2 === 0 ? z / 2 : -((z + 1) / 2)
    }

    uvarintBig(): bigint {
        let n = 0n
        let shift = 0n
        let b: number
        do {
            if (this.pos >= this.end) throw new RangeError('Reader: out of bounds')
            b = this.arr[this.pos++]
            n |= BigInt(b & 0x7f) << shift
            shift += 7n
        } while (b & 0x80)
        return n
    }

    labelBig(): bigint {
        const z = this.uvarintBig()
        return z & 1n ? (z >> 1n) ^ ~0n : z >> 1n
    }
}
