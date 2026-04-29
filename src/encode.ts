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
    blocks = new Map<string, BlockState>()
    blockOrder: string[] = []
    core = new Buf(1024)
    flags = 0
    inline = false
    nullTerminated = false
    outOfBand = false
    selfDescribingErrors = false
    selfDescribing = false

    constructor(wire: Wire, opts: EncodeOptions) {
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
        walkBlocks(wire, this)
    }
}

// Pre-walk wire schema and register blocks in deterministic order.
function walkBlocks(t: Wire, enc: Encoder, seenKeys: Set<string> = new Set()): void {
    switch (t.type) {
        case 'BLOCK':
            registerBlock(enc, t.key, t.dedupe, seenKeys)
            walkBlocks(t.of, enc, seenKeys)
            return
        case 'NULLABLE':
        case 'ARRAY':
            walkBlocks(t.of, enc, seenKeys)
            return
        case 'RECORD':
            for (const f of t.fields) walkBlocks(f.of, enc, seenKeys)
            return
        case 'DESC':
            // DESC may use any of the four implicit blocks.
            registerBlock(enc, 'String', true, seenKeys)
            registerBlock(enc, 'Bytes', true, seenKeys)
            registerBlock(enc, 'Int', false, seenKeys)
            registerBlock(enc, 'Float', false, seenKeys)
            return
        case 'PATH':
            // PATH uses inline VARINTs (no block) per its definition (ARRAY of VARINT).
            return
        default:
            return
    }
}

function registerBlock(enc: Encoder, key: string, dedupe: boolean, seen: Set<string>) {
    if (seen.has(key) || enc.blocks.has(key)) return
    seen.add(key)
    const buf = enc.inline ? enc.core : new Buf(256)
    enc.blocks.set(key, { buf, dedupe, seen: new Map(), nextId: BACKREF_BASE })
    enc.blockOrder.push(key)
}

function bytesKey(b: Uint8Array): string {
    // Latin1 round-trip: each byte becomes one UTF-16 code unit. Cheap and unique.
    let s = ''
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
    return s
}

// ---- Value encoding ----

function writeValue(enc: Encoder, t: Wire, v: unknown, block: BlockState | null): void {
    switch (t.type) {
        case 'BLOCK':
            writeValue(enc, t.of, v, enc.blocks.get(t.key)!)
            return

        case 'NULLABLE': {
            if (v === null || v === undefined) {
                enc.core.label(LABEL_NULL)
                return
            }
            if (v instanceof FieldErrorSentinel) {
                if (enc.outOfBand) {
                    // OutOfBandFieldErrors: write Null (not propagating extra error data here).
                    enc.core.label(LABEL_NULL)
                    return
                }
                enc.core.label(LABEL_ERROR)
                // Write ARRAY of Error values inline.
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
            // Values can collide with backref space if dedupe is enabled, so we never
            // dedupe VARINTs for safety (matches the spec's default of dedupe=false).
            if (typeof v === 'bigint') enc.core.labelBig(v)
            else enc.core.label(v as number)
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
        writeStringInBlock(enc, v, 'String')
        return
    }
    if (v instanceof Uint8Array) {
        enc.core.label(DESC_BYTES)
        writeBytesInBlock(enc, v, 'Bytes')
        return
    }
    if (typeof v === 'bigint') {
        enc.core.label(DESC_INT)
        enc.core.labelBig(v)
        return
    }
    if (typeof v === 'number') {
        if (Number.isInteger(v)) {
            enc.core.label(DESC_INT)
            enc.core.label(v)
        } else {
            enc.core.label(DESC_FLOAT)
            enc.blocks.get('Float')!.buf.f64(v)
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
        for (const k of keys) {
            // Field name: STRING (uses "String" block) with NO type marker.
            writeStringInBlock(enc, k, 'String')
            writeDesc(enc, obj[k])
        }
        return
    }
    throw new Error(`DESC: unsupported value of type ${typeof v}`)
}

function writeStringInBlock(enc: Encoder, s: string, key: string) {
    const block = enc.blocks.get(key)!
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

function writeBytesInBlock(enc: Encoder, b: Uint8Array, key: string) {
    const block = enc.blocks.get(key)!
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
    // Write as ERROR_WIRE record. Path needs to be transformed to wire path
    // relative to the propagation point. Here we pass the path as-is — caller
    // is responsible for making it relative.
    const obj: Record<string, unknown> = {
        message: e.message,
        location: e.location ?? null,
        path: e.path ?? null,
        extensions: e.extensions
    }
    // If path is provided as strings/numbers, the user must have already converted
    // to wire-path form (numbers only). Otherwise we leave as-is and trust the user.
    writeValue(enc, ERROR_WIRE, obj, null)
}

function errorToObject(e: ArgoError): Record<string, unknown> {
    const o: Record<string, unknown> = { message: e.message }
    if (e.location) o.location = e.location
    if (e.path) o.path = e.path
    if (e.extensions !== undefined) o.extensions = e.extensions
    return o
}

// ---- Public API ----

export function encode(wire: Wire, value: unknown, opts: EncodeOptions = {}): Uint8Array {
    const enc = new Encoder(wire, opts)
    if (enc.selfDescribing) writeDesc(enc, value)
    else writeValue(enc, wire, value, null)

    // Assemble: header + (each block: label(len) + data)* + (label(coreLen) + core)
    const out = new Buf(64 + enc.core.pos)
    out.uvarint(enc.flags)
    if (!enc.inline) {
        for (const key of enc.blockOrder) {
            const b = enc.blocks.get(key)!
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
