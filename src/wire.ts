// Argo 1.2 wire types. The wire schema is a tree of these.

export type Wire =
    | { type: 'STRING' }
    | { type: 'BOOLEAN' }
    | { type: 'VARINT' }
    | { type: 'FLOAT64' }
    | { type: 'BYTES' }
    | { type: 'FIXED'; length: number }
    | { type: 'RECORD'; fields: WireField[] }
    | { type: 'ARRAY'; of: Wire }
    | { type: 'BLOCK'; of: Wire; key: string; dedupe: boolean }
    | { type: 'NULLABLE'; of: Wire }
    | { type: 'DESC' }
    | { type: 'PATH' }

export interface WireField {
    name: string
    of: Wire
    omittable: boolean
}

// Reserved labels.
export const LABEL_NULL = -1
export const LABEL_ABSENT = -2
export const LABEL_ERROR = -3
export const LABEL_NON_NULL = 0
export const BACKREF_BASE = -4 // first backref id

// Header flag bit positions.
export const FLAG_INLINE_EVERYTHING = 1 << 0
export const FLAG_SELF_DESCRIBING = 1 << 1
export const FLAG_OUT_OF_BAND_FIELD_ERRORS = 1 << 2
export const FLAG_SELF_DESCRIBING_ERRORS = 1 << 3
export const FLAG_NULL_TERMINATED_STRINGS = 1 << 4
export const FLAG_NO_DEDUPLICATION = 1 << 5
export const FLAG_HAS_USER_FLAGS = 1 << 6

// Self-describing type markers.
export const DESC_NULL = -1
export const DESC_FALSE = 0
export const DESC_TRUE = 1
export const DESC_OBJECT = 2
export const DESC_LIST = 3
export const DESC_STRING = 4
export const DESC_BYTES = 5
export const DESC_INT = 6
export const DESC_FLOAT = 7

// A type is "Labeled" iff its core encoding starts with (or is) a Label.
// STRING, BYTES, ARRAY, BOOLEAN, VARINT, NULLABLE, DESC, PATH are Labeled.
// FLOAT64, FIXED, RECORD are Unlabeled.
export function isLabeled(t: Wire): boolean {
    switch (t.type) {
        case 'STRING':
        case 'BYTES':
        case 'ARRAY':
        case 'BOOLEAN':
        case 'VARINT':
        case 'NULLABLE':
        case 'DESC':
        case 'PATH':
            return true
        case 'BLOCK':
            return isLabeled(t.of)
        default:
            return false
    }
}

// Strip BLOCK/NULLABLE wrappers to reach the underlying type.
export function unwrap(t: Wire): Wire {
    while (t.type === 'BLOCK' || t.type === 'NULLABLE') t = t.of
    return t
}

// Sentinel returned for nullable positions where a field error stopped propagation.
export class FieldErrorSentinel {
    constructor(public readonly errors: ArgoError[]) {}
}

export interface ArgoLocation {
    line: number
    column: number
}

export interface ArgoError {
    message: string
    location?: ArgoLocation[] | null
    path?: (string | number)[] | null
    extensions?: unknown
}

// Convert a GraphQL path to a wire path (list of integers).
export function pathToWire(path: (string | number)[], wire: Wire): number[] {
    const out: number[] = []
    let t: Wire = wire
    let i = 0
    while (i < path.length) {
        while (t.type === 'BLOCK' || t.type === 'NULLABLE') t = t.of
        if (t.type === 'RECORD') {
            const name = path[i++] as string
            const idx = t.fields.findIndex((f) => f.name === name)
            if (idx < 0) throw new Error(`pathToWire: unknown field ${name}`)
            out.push(idx)
            t = t.fields[idx].of
        } else if (t.type === 'ARRAY') {
            const n = path[i++] as number
            out.push(n)
            t = t.of
        } else {
            throw new Error(`pathToWire: cannot descend into ${t.type}`)
        }
    }
    return out
}

export function wireToPath(wirePath: number[], wire: Wire): (string | number)[] {
    const out: (string | number)[] = []
    let t: Wire = wire
    for (const seg of wirePath) {
        while (t.type === 'BLOCK' || t.type === 'NULLABLE') t = t.of
        if (t.type === 'RECORD') {
            const f = t.fields[seg]
            if (!f) throw new Error(`wireToPath: bad index ${seg}`)
            out.push(f.name)
            t = f.of
        } else if (t.type === 'ARRAY') {
            out.push(seg)
            t = t.of
        } else {
            throw new Error(`wireToPath: cannot descend into ${t.type}`)
        }
    }
    return out
}

// Wire schema for an individual error value, used for inline field errors and request errors.
export const ERROR_WIRE: Wire = {
    type: 'RECORD',
    fields: [
        {
            name: 'message',
            of: { type: 'BLOCK', of: { type: 'STRING' }, key: 'String', dedupe: true },
            omittable: false
        },
        {
            name: 'location',
            of: {
                type: 'NULLABLE',
                of: {
                    type: 'ARRAY',
                    of: {
                        type: 'RECORD',
                        fields: [
                            {
                                name: 'line',
                                of: {
                                    type: 'BLOCK',
                                    of: { type: 'VARINT' },
                                    key: 'Int',
                                    dedupe: false
                                },
                                omittable: false
                            },
                            {
                                name: 'column',
                                of: {
                                    type: 'BLOCK',
                                    of: { type: 'VARINT' },
                                    key: 'Int',
                                    dedupe: false
                                },
                                omittable: false
                            }
                        ]
                    }
                }
            },
            omittable: true
        },
        { name: 'path', of: { type: 'NULLABLE', of: { type: 'PATH' } }, omittable: true },
        { name: 'extensions', of: { type: 'DESC' }, omittable: true }
    ]
}
