import { Buf } from './buf.js'
import {
    type Wire,
    type ArgoError,
    FieldErrorSentinel,
    isLabeled,
    pathToWire,
    ERROR_WIRE,
    LABEL_NULL,
    LABEL_ABSENT,
    LABEL_ERROR,
    LABEL_NON_NULL,
    BACKREF_BASE,
    FLAG_INLINE_EVERYTHING,
    FLAG_NULL_TERMINATED_STRINGS,
    FLAG_NO_DEDUPLICATION,
    FLAG_OUT_OF_BAND_FIELD_ERRORS,
    FLAG_SELF_DESCRIBING,
    FLAG_SELF_DESCRIBING_ERRORS,
    DESC_NULL,
    DESC_FALSE,
    DESC_TRUE,
    DESC_OBJECT,
    DESC_LIST,
    DESC_STRING,
    DESC_BYTES,
    DESC_INT,
    DESC_FLOAT
} from './wire.js'

export interface EncodeOptions {
    inlineEverything?: boolean
    selfDescribing?: boolean
    outOfBandFieldErrors?: boolean
    selfDescribingErrors?: boolean
    nullTerminatedStrings?: boolean
    noDeduplication?: boolean
}

interface BlockState {
    buf: Buf
    dedupe: boolean
    seen: Map<string, number> // value-key -> backref id (negative)
    nextId: number
}

const TEXT_ENC = new TextEncoder()

class Encoder {
    blocks = new Map<string, BlockState>() // insertion order = first-write order
    core = new Buf(1024)
    flags = 0
    inline = false
    nullTerminated = false
    outOfBand = false
    selfDescribingErrors = false
    selfDescribing = false

    constructor(opts: EncodeOptions) {
        if (opts.inlineEverything) {
            this.flags |= FLAG_INLINE_EVERYTHING
            this.inline = true
        }
        if (opts.selfDescribing) {
            this.flags |= FLAG_SELF_DESCRIBING
            this.selfDescribing = true
        }
        if (opts.outOfBandFieldErrors) {
            this.flags |= FLAG_OUT_OF_BAND_FIELD_ERRORS
            this.outOfBand = true
        }
        if (opts.selfDescribingErrors) {
            this.flags |= FLAG_SELF_DESCRIBING_ERRORS
            this.selfDescribingErrors = true
        }
        if (opts.nullTerminatedStrings) {
            this.flags |= FLAG_NULL_TERMINATED_STRINGS
            this.nullTerminated = true
        }
        if (opts.noDeduplication) this.flags |= FLAG_NO_DEDUPLICATION
    }

    block(key: string, dedupe: boolean): BlockState {
        let b = this.blocks.get(key)
        if (b) return b
        b = {
            buf: this.inline ? this.core : new Buf(256),
            dedupe,
            seen: new Map(),
            nextId: BACKREF_BASE
        }
        this.blocks.set(key, b)
        return b
    }
}

function bytesKey(b: Uint8Array): string {
    let s = ''
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
    return s
}

function writeValue(enc: Encoder, t: Wire, v: unknown, block: BlockState | null): void {
    switch (t.type) {
        case 'BLOCK':
            writeValue(enc, t.of, v, enc.block(t.key, t.dedupe))
            return

        case 'NULLABLE': {
            if (v === null || v === undefined) {
                enc.core.label(LABEL_NULL)
                return
            }
            if (v instanceof FieldErrorSentinel) {
                if (enc.outOfBand) {
                    enc.core.label(LABEL_NULL)
                    return
                }
                enc.core.label(LABEL_ERROR)
                enc.core.label(v.errors.length)
                for (const e of v.errors) writeErrorValue(enc, e)
                return
            }
            if (isLabeled(t.of)) {
                writeValue(enc, t.of, v, block)
            } else {
                enc.core.label(LABEL_NON_NULL)
                writeValue(enc, t.of, v, block)
            }
            return
        }

        case 'STRING': {
            const s = String(v)
            if (block && block.dedupe) {
                const id = block.seen.get(s)
                if (id !== undefined) {
                    enc.core.label(id)
                    return
                }
            }
            const utf8 = TEXT_ENC.encode(s)
            enc.core.label(utf8.length)
            block!.buf.bytes(utf8)
            if (enc.nullTerminated) block!.buf.byte(0)
            if (block && block.dedupe) block.seen.set(s, block.nextId--)
            return
        }

        case 'BYTES': {
            const b = v as Uint8Array
            let key: string | null = null
            if (block && block.dedupe) {
                key = bytesKey(b)
                const id = block.seen.get(key)
                if (id !== undefined) {
                    enc.core.label(id)
                    return
                }
            }
            enc.core.label(b.length)
            block!.buf.bytes(b)
            if (block && block.dedupe) block.seen.set(key!, block.nextId--)
            return
        }

        case 'VARINT': {
            // Reference-compatible: VARINT data lives in its block (zig-zag varint),
            // nothing in core. Dedup unsupported for VARINT (collides with backref space).
            if (typeof v === 'bigint') block!.buf.labelBig(v)
            else block!.buf.label(v as number)
            return
        }

        case 'BOOLEAN':
            enc.core.label(v ? 1 : 0)
            return

        case 'FLOAT64':
            block!.buf.f64(v as number)
            return

        case 'FIXED': {
            const b = v as Uint8Array
            if (b.length !== t.length)
                throw new Error(`FIXED: expected ${t.length} bytes, got ${b.length}`)
            block!.buf.bytes(b)
            return
        }

        case 'RECORD': {
            const obj = (v ?? {}) as Record<string, unknown>
            for (const f of t.fields) {
                const has =
                    Object.prototype.hasOwnProperty.call(obj, f.name) && obj[f.name] !== undefined
                if (f.omittable && !has) {
                    enc.core.label(LABEL_ABSENT)
                    continue
                }
                if (f.omittable && !isLabeled(f.of)) {
                    enc.core.label(LABEL_NON_NULL)
                }
                writeValue(enc, f.of, obj[f.name], block)
            }
            return
        }

        case 'ARRAY': {
            const arr = v as unknown[]
            enc.core.label(arr.length)
            for (let i = 0; i < arr.length; i++) writeValue(enc, t.of, arr[i], block)
            return
        }

        case 'DESC':
            writeDesc(enc, v)
            return

        case 'PATH': {
            const arr = v as number[]
            enc.core.label(arr.length)
            for (let i = 0; i < arr.length; i++) enc.core.label(arr[i])
            return
        }
    }
}

// DESC implicit blocks. Per ref: String/Bytes dedupe by default; Int/Float don't.
const DESC_STRING_BLOCK_DEDUPE = true
const DESC_BYTES_BLOCK_DEDUPE = true
const DESC_INT_BLOCK_DEDUPE = false
const DESC_FLOAT_BLOCK_DEDUPE = false

function writeDesc(enc: Encoder, v: unknown): void {
    if (v === null || v === undefined) {
        enc.core.label(DESC_NULL)
        return
    }
    if (v === false) {
        enc.core.label(DESC_FALSE)
        return
    }
    if (v === true) {
        enc.core.label(DESC_TRUE)
        return
    }
    if (typeof v === 'string') {
        enc.core.label(DESC_STRING)
        const block = enc.block('String', DESC_STRING_BLOCK_DEDUPE)
        writeStringInBlock(enc, v, block)
        return
    }
    if (v instanceof Uint8Array) {
        enc.core.label(DESC_BYTES)
        const block = enc.block('Bytes', DESC_BYTES_BLOCK_DEDUPE)
        writeBytesInBlock(enc, v, block)
        return
    }
    if (typeof v === 'bigint') {
        enc.core.label(DESC_INT)
        const block = enc.block('Int', DESC_INT_BLOCK_DEDUPE)
        block.buf.labelBig(v)
        return
    }
    if (typeof v === 'number') {
        if (Number.isInteger(v)) {
            enc.core.label(DESC_INT)
            const block = enc.block('Int', DESC_INT_BLOCK_DEDUPE)
            block.buf.label(v)
        } else {
            enc.core.label(DESC_FLOAT)
            const block = enc.block('Float', DESC_FLOAT_BLOCK_DEDUPE)
            block.buf.f64(v)
        }
        return
    }
    if (Array.isArray(v)) {
        enc.core.label(DESC_LIST)
        enc.core.label(v.length)
        for (let i = 0; i < v.length; i++) writeDesc(enc, v[i])
        return
    }
    if (typeof v === 'object') {
        const obj = v as Record<string, unknown>
        const keys = Object.keys(obj)
        enc.core.label(DESC_OBJECT)
        enc.core.label(keys.length)
        const stringBlock = enc.block('String', DESC_STRING_BLOCK_DEDUPE)
        for (const k of keys) {
            // Field name: STRING with NO type marker.
            writeStringInBlock(enc, k, stringBlock)
            writeDesc(enc, obj[k])
        }
        return
    }
    throw new Error(`DESC: unsupported value of type ${typeof v}`)
}

function writeStringInBlock(enc: Encoder, s: string, block: BlockState) {
    if (block.dedupe) {
        const id = block.seen.get(s)
        if (id !== undefined) {
            enc.core.label(id)
            return
        }
    }
    const utf8 = TEXT_ENC.encode(s)
    enc.core.label(utf8.length)
    block.buf.bytes(utf8)
    if (enc.nullTerminated) block.buf.byte(0)
    if (block.dedupe) block.seen.set(s, block.nextId--)
}

function writeBytesInBlock(enc: Encoder, b: Uint8Array, block: BlockState) {
    let kk: string | null = null
    if (block.dedupe) {
        kk = bytesKey(b)
        const id = block.seen.get(kk)
        if (id !== undefined) {
            enc.core.label(id)
            return
        }
    }
    enc.core.label(b.length)
    block.buf.bytes(b)
    if (block.dedupe) block.seen.set(kk!, block.nextId--)
}

function writeErrorValue(enc: Encoder, e: ArgoError): void {
    if (enc.selfDescribingErrors) {
        writeDesc(enc, errorToObject(e))
        return
    }
    const obj: Record<string, unknown> = {
        message: e.message,
        location: e.location ?? null,
        path: e.path ?? null,
        extensions: e.extensions
    }
    writeValue(enc, ERROR_WIRE, obj, null)
}

function errorToObject(e: ArgoError): Record<string, unknown> {
    const o: Record<string, unknown> = { message: e.message }
    if (e.location) o.location = e.location
    if (e.path) o.path = e.path
    if (e.extensions !== undefined) o.extensions = e.extensions
    return o
}

export function encode(wire: Wire, value: unknown, opts: EncodeOptions = {}): Uint8Array {
    const enc = new Encoder(opts)
    if (enc.selfDescribing) writeDesc(enc, value)
    else writeValue(enc, wire, value, null)

    // Header (BitSet) + each block (label(len) + data) + core (label(coreLen) + data).
    // In inline mode, all data already lives in core; only the header is emitted before it.
    const out = new Buf(64 + enc.core.pos)
    out.bitset(enc.flags)
    if (!enc.inline) {
        for (const b of enc.blocks.values()) {
            const data = b.buf.view0()
            out.label(data.length)
            out.bytes(data)
        }
        out.label(enc.core.pos)
    }
    out.bytes(enc.core.view0())
    return out.view0()
}

export { pathToWire }
