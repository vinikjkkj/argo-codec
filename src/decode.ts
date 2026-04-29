import { Reader } from './buf.js'
import {
    type Wire,
    type ArgoError,
    FieldErrorSentinel,
    isLabeled,
    ERROR_WIRE,
    LABEL_NULL,
    LABEL_ABSENT,
    LABEL_ERROR,
    BACKREF_BASE,
    FLAG_INLINE_EVERYTHING,
    FLAG_NULL_TERMINATED_STRINGS,
    FLAG_NO_DEDUPLICATION,
    FLAG_OUT_OF_BAND_FIELD_ERRORS,
    FLAG_SELF_DESCRIBING,
    FLAG_SELF_DESCRIBING_ERRORS,
    FLAG_HAS_USER_FLAGS,
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

const TEXT_DEC = new TextDecoder('utf-8', { fatal: false })

interface BlockReader {
    reader: Reader // for FLOAT64/FIXED in non-inline (or the same as core in inline)
    // In inline mode, STRING/BYTES data is read inline from core after the length label;
    // in non-inline, we cut subarrays from the block reader, which advances its pos.
    dedupe: boolean
    seen: unknown[]
    nullTerminated: boolean
    inline: boolean
}

class DecoderState {
    blocks = new Map<string, BlockReader>()
    blockOrder: string[] = []
    core!: Reader
    inline = false
    nullTerminated = false
    outOfBand = false
    selfDescribing = false
    selfDescribingErrors = false
    noDedup = false
}

function preWalk(t: Wire, st: DecoderState, seen: Set<string>): void {
    switch (t.type) {
        case 'BLOCK':
            if (!seen.has(t.key) && !st.blocks.has(t.key)) {
                seen.add(t.key)
                st.blockOrder.push(t.key)
                // placeholder, real reader installed later
                st.blocks.set(t.key, {
                    reader: null!,
                    dedupe: t.dedupe,
                    seen: [],
                    nullTerminated: st.nullTerminated,
                    inline: st.inline
                })
            }
            preWalk(t.of, st, seen)
            return
        case 'NULLABLE':
        case 'ARRAY':
            preWalk(t.of, st, seen)
            return
        case 'RECORD':
            for (const f of t.fields) preWalk(f.of, st, seen)
            return
        case 'DESC':
            for (const [k, d] of [
                ['String', true],
                ['Bytes', true],
                ['Int', false],
                ['Float', false]
            ] as const) {
                if (!seen.has(k) && !st.blocks.has(k)) {
                    seen.add(k)
                    st.blockOrder.push(k)
                    st.blocks.set(k, {
                        reader: null!,
                        dedupe: d,
                        seen: [],
                        nullTerminated: st.nullTerminated,
                        inline: st.inline
                    })
                }
            }
            return
        case 'PATH':
            return
        default:
            return
    }
}

function readValue(st: DecoderState, t: Wire, block: BlockReader | null): unknown {
    switch (t.type) {
        case 'BLOCK':
            return readValue(st, t.of, st.blocks.get(t.key)!)

        case 'NULLABLE': {
            const r = st.core
            const start = r.pos
            const lab = r.label()
            if (lab === LABEL_NULL) return null
            if (lab === LABEL_ERROR) {
                // Read ARRAY of error values inline.
                const len = r.label()
                const errs: ArgoError[] = []
                for (let i = 0; i < len; i++) errs.push(readErrorValue(st))
                return new FieldErrorSentinel(errs)
            }
            // Not null. Rewind label and decode underlying.
            if (isLabeled(t.of)) {
                r.pos = start // underlying will re-read the label as part of its decoding
                return readValue(st, t.of, block)
            }
            // Underlying Unlabeled: lab was the non-null marker (0); proceed to decode underlying.
            return readValue(st, t.of, block)
        }

        case 'STRING': {
            const r = st.core
            const lab = r.label()
            if (lab < BACKREF_BASE + 1) {
                // Backref (-4, -5, ...)
                const idx = -lab + BACKREF_BASE // -lab - 4
                return block!.seen[idx]
            }
            // First occurrence: lab is the byte length
            const data = block!.inline ? r.bytes(lab) : block!.reader.bytes(lab)
            if (block!.nullTerminated) {
                if (block!.inline) r.pos++
                else block!.reader.pos++
            }
            const s = TEXT_DEC.decode(data)
            if (block!.dedupe) block!.seen.push(s)
            return s
        }

        case 'BYTES': {
            const r = st.core
            const lab = r.label()
            if (lab < BACKREF_BASE + 1) {
                const idx = -lab + BACKREF_BASE
                return block!.seen[idx]
            }
            const data = block!.inline ? r.bytes(lab) : block!.reader.bytes(lab)
            if (block!.dedupe) block!.seen.push(data)
            return data
        }

        case 'VARINT':
            return st.core.label()

        case 'BOOLEAN': {
            const lab = st.core.label()
            return lab === 1
        }

        case 'FLOAT64':
            return block!.inline ? st.core.f64() : block!.reader.f64()

        case 'FIXED': {
            return block!.inline ? st.core.bytes(t.length) : block!.reader.bytes(t.length)
        }

        case 'RECORD': {
            const out: Record<string, unknown> = {}
            const r = st.core
            for (const f of t.fields) {
                if (f.omittable) {
                    const start = r.pos
                    const lab = r.label()
                    if (lab === LABEL_ABSENT) continue
                    if (!isLabeled(f.of)) {
                        // lab was the non-null marker (0); decode underlying
                    } else {
                        // The label belongs to the underlying value; rewind.
                        r.pos = start
                    }
                }
                out[f.name] = readValue(st, f.of, block)
            }
            return out
        }

        case 'ARRAY': {
            const len = st.core.label()
            const out = new Array(len)
            for (let i = 0; i < len; i++) out[i] = readValue(st, t.of, block)
            return out
        }

        case 'DESC':
            return readDesc(st)

        case 'PATH': {
            const len = st.core.label()
            const out = new Array<number>(len)
            for (let i = 0; i < len; i++) out[i] = st.core.label()
            return out
        }
    }
}

function readDesc(st: DecoderState): unknown {
    const r = st.core
    const m = r.label()
    switch (m) {
        case DESC_NULL:
            return null
        case DESC_FALSE:
            return false
        case DESC_TRUE:
            return true
        case DESC_STRING: {
            const block = st.blocks.get('String')!
            return readStringFromBlock(st, block)
        }
        case DESC_BYTES: {
            const block = st.blocks.get('Bytes')!
            return readBytesFromBlock(st, block)
        }
        case DESC_INT:
            return r.label()
        case DESC_FLOAT: {
            const block = st.blocks.get('Float')!
            return block.inline ? r.f64() : block.reader.f64()
        }
        case DESC_LIST: {
            const len = r.label()
            const out = new Array(len)
            for (let i = 0; i < len; i++) out[i] = readDesc(st)
            return out
        }
        case DESC_OBJECT: {
            const n = r.label()
            const block = st.blocks.get('String')!
            const out: Record<string, unknown> = {}
            for (let i = 0; i < n; i++) {
                const key = readStringFromBlock(st, block)
                out[key] = readDesc(st)
            }
            return out
        }
        default:
            throw new Error(`DESC: unknown type marker ${m}`)
    }
}

function readStringFromBlock(st: DecoderState, block: BlockReader): string {
    const r = st.core
    const lab = r.label()
    if (lab < BACKREF_BASE + 1) {
        const idx = -lab + BACKREF_BASE
        return block.seen[idx] as string
    }
    const data = block.inline ? r.bytes(lab) : block.reader.bytes(lab)
    if (block.nullTerminated) {
        if (block.inline) r.pos++
        else block.reader.pos++
    }
    const s = TEXT_DEC.decode(data)
    if (block.dedupe) block.seen.push(s)
    return s
}

function readBytesFromBlock(st: DecoderState, block: BlockReader): Uint8Array {
    const r = st.core
    const lab = r.label()
    if (lab < BACKREF_BASE + 1) {
        const idx = -lab + BACKREF_BASE
        return block.seen[idx] as Uint8Array
    }
    const data = block.inline ? r.bytes(lab) : block.reader.bytes(lab)
    if (block.dedupe) block.seen.push(data)
    return data
}

function readErrorValue(st: DecoderState): ArgoError {
    if (st.selfDescribingErrors) {
        return readDesc(st) as ArgoError
    }
    return readValue(st, ERROR_WIRE, null) as ArgoError
}

export function decode(wire: Wire, message: Uint8Array): unknown {
    const r = new Reader(message)
    const flags = r.uvarint()
    const st = new DecoderState()
    st.inline = (flags & FLAG_INLINE_EVERYTHING) !== 0
    st.selfDescribing = (flags & FLAG_SELF_DESCRIBING) !== 0
    st.outOfBand = (flags & FLAG_OUT_OF_BAND_FIELD_ERRORS) !== 0
    st.selfDescribingErrors = (flags & FLAG_SELF_DESCRIBING_ERRORS) !== 0
    st.nullTerminated = (flags & FLAG_NULL_TERMINATED_STRINGS) !== 0
    st.noDedup = (flags & FLAG_NO_DEDUPLICATION) !== 0
    if (flags & FLAG_HAS_USER_FLAGS) r.uvarint() // skip user flags

    preWalk(wire, st, new Set())

    if (!st.inline) {
        for (const key of st.blockOrder) {
            const len = r.label()
            const slice = r.bytes(len)
            const b = st.blocks.get(key)!
            b.reader = new Reader(slice)
            b.nullTerminated = st.nullTerminated
            b.inline = false
        }
        const coreLen = r.label()
        const coreSlice = r.bytes(coreLen)
        st.core = new Reader(coreSlice)
    } else {
        // In inline mode, all data lives in core; "block readers" point at the core too.
        st.core = r
        for (const key of st.blockOrder) {
            st.blocks.set(key, {
                reader: r,
                dedupe: st.blocks.get(key)!.dedupe,
                seen: [],
                nullTerminated: st.nullTerminated,
                inline: true
            })
        }
    }

    if (st.selfDescribing) return readDesc(st)
    return readValue(st, wire, null)
}
