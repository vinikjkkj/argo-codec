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
    reader: Reader
    dedupe: boolean
    seen: unknown[]
    nullTerminated: boolean
    inline: boolean
}

class DecoderState {
    blocks = new Map<string, BlockReader>()
    blockSlices: Reader[] = []
    nextBlockIdx = 0
    core!: Reader
    inline = false
    nullTerminated = false
    outOfBand = false
    selfDescribing = false
    selfDescribingErrors = false
    noDedup = false

    block(key: string, dedupe: boolean): BlockReader {
        let b = this.blocks.get(key)
        if (b) return b
        // First use of this block. In inline mode all blocks share the core reader;
        // otherwise pull the next slice in encoder-emit order.
        const r = this.inline ? this.core : this.blockSlices[this.nextBlockIdx++]
        b = {
            reader: r,
            dedupe,
            seen: [],
            nullTerminated: this.nullTerminated,
            inline: this.inline
        }
        this.blocks.set(key, b)
        return b
    }
}

function readValue(st: DecoderState, t: Wire, block: BlockReader | null): unknown {
    switch (t.type) {
        case 'BLOCK':
            return readValue(st, t.of, st.block(t.key, t.dedupe))

        case 'NULLABLE': {
            const r = st.core
            const start = r.pos
            const lab = r.label()
            if (lab === LABEL_NULL) return null
            if (lab === LABEL_ERROR) {
                const len = r.label()
                const errs: ArgoError[] = []
                for (let i = 0; i < len; i++) errs.push(readErrorValue(st))
                return new FieldErrorSentinel(errs)
            }
            if (isLabeled(t.of)) {
                r.pos = start
                return readValue(st, t.of, block)
            }
            // Underlying Unlabeled: lab was the non-null marker (0).
            return readValue(st, t.of, block)
        }

        case 'STRING': {
            const r = st.core
            const lab = r.label()
            if (lab < BACKREF_BASE + 1) {
                const idx = -lab + BACKREF_BASE
                return block!.seen[idx]
            }
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
            // Reference-compatible: data lives in the block, no label in core.
            return block!.reader.label()

        case 'BOOLEAN': {
            const lab = st.core.label()
            return lab === 1
        }

        case 'FLOAT64':
            return block!.reader.f64()

        case 'FIXED':
            return block!.reader.bytes(t.length)

        case 'RECORD': {
            const out: Record<string, unknown> = {}
            const r = st.core
            for (const f of t.fields) {
                if (f.omittable) {
                    const start = r.pos
                    const lab = r.label()
                    if (lab === LABEL_ABSENT) continue
                    if (isLabeled(f.of)) {
                        r.pos = start // leave label for the value to consume
                    }
                    // else: lab was the non-null marker (0), already consumed
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
            const block = st.block('String', true)
            return readStringFromBlock(st, block)
        }
        case DESC_BYTES: {
            const block = st.block('Bytes', true)
            return readBytesFromBlock(st, block)
        }
        case DESC_INT: {
            const block = st.block('Int', false)
            return block.reader.label()
        }
        case DESC_FLOAT: {
            const block = st.block('Float', false)
            return block.reader.f64()
        }
        case DESC_LIST: {
            const len = r.label()
            const out = new Array(len)
            for (let i = 0; i < len; i++) out[i] = readDesc(st)
            return out
        }
        case DESC_OBJECT: {
            const n = r.label()
            const block = st.block('String', true)
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
    const flags = r.bitset()
    const st = new DecoderState()
    st.inline = (flags & FLAG_INLINE_EVERYTHING) !== 0
    st.selfDescribing = (flags & FLAG_SELF_DESCRIBING) !== 0
    st.outOfBand = (flags & FLAG_OUT_OF_BAND_FIELD_ERRORS) !== 0
    st.selfDescribingErrors = (flags & FLAG_SELF_DESCRIBING_ERRORS) !== 0
    st.nullTerminated = (flags & FLAG_NULL_TERMINATED_STRINGS) !== 0
    st.noDedup = (flags & FLAG_NO_DEDUPLICATION) !== 0
    if (flags & FLAG_HAS_USER_FLAGS) r.bitset() // skip user flags

    if (!st.inline) {
        // Read sequence of length-prefixed segments until EOF. The last is the core.
        const slices: Reader[] = []
        while (r.pos < r.end) {
            const len = r.label()
            const slice = r.bytes(len)
            slices.push(new Reader(slice))
        }
        if (slices.length === 0) throw new Error('decode: missing core segment')
        st.core = slices[slices.length - 1]
        st.blockSlices = slices.slice(0, -1)
    } else {
        // Inline mode: everything after the header is the core, and any "block" lookup
        // resolves to the same reader.
        st.core = r
    }

    if (st.selfDescribing) return readDesc(st)
    return readValue(st, wire, null)
}
