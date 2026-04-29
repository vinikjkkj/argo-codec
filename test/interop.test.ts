// Interop with the reference implementation `argo-graphql`.
// We translate our Wire schema to theirs, then test cross-impl roundtrip:
//   1) ours encodes -> theirs decodes
//   2) theirs encodes -> ours decodes

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encode, decode, type Wire } from '../src/index.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// argo-graphql@1.1.1 ships stale .d.ts (uses `type:` for Field; runtime uses `of:`),
// so we load via require + treat ref types as `any` to avoid typing drift.
const { ArgoEncoder } = require('argo-graphql/dist/encoder.js')
const { ArgoDecoder } = require('argo-graphql/dist/decoder.js')
const { Buf: RefBuf } = require('argo-graphql/dist/buf.js')
const { Wire: RefWire } = require('argo-graphql/dist/wire.js')

// Translate our Wire -> reference Wire.Type
function toRef(w: Wire): any {
    switch (w.type) {
        case 'STRING':
            return RefWire.STRING
        case 'BOOLEAN':
            return RefWire.BOOLEAN
        case 'VARINT':
            return RefWire.VARINT
        case 'FLOAT64':
            return RefWire.FLOAT64
        case 'BYTES':
            return RefWire.BYTES
        case 'FIXED':
            return { type: RefWire.TypeKey.FIXED, length: w.length }
        case 'DESC':
            return RefWire.DESC
        case 'PATH':
            return RefWire.PATH
        case 'NULLABLE':
            return RefWire.nullable(toRef(w.of))
        case 'ARRAY':
            return { type: RefWire.TypeKey.ARRAY, of: toRef(w.of) }
        case 'BLOCK':
            return RefWire.block(toRef(w.of), w.key, w.dedupe)
        case 'RECORD':
            // argo-graphql@1.1.1 predates the v1.1.4 rename of Field.type -> Field.of,
            // so its runtime still reads `type:`. Emit both keys for compatibility.
            return {
                type: RefWire.TypeKey.RECORD,
                fields: w.fields.map((f) => ({
                    name: f.name,
                    type: toRef(f.of),
                    of: toRef(f.of),
                    omittable: f.omittable
                }))
            }
    }
}

const STRING_BLOCK: Wire = { type: 'BLOCK', of: { type: 'STRING' }, key: 'String', dedupe: true }
const INT_BLOCK: Wire = { type: 'BLOCK', of: { type: 'VARINT' }, key: 'Int', dedupe: false }
const BYTES_BLOCK: Wire = { type: 'BLOCK', of: { type: 'BYTES' }, key: 'Bytes', dedupe: true }
const NS = (of: Wire): Wire => ({ type: 'NULLABLE', of })

function refEncode(w: Wire, v: unknown): Uint8Array {
    const enc = new ArgoEncoder()
    enc.jsToArgoWithType(v, toRef(w))
    const result = enc.getResult()
    return result.uint8array.subarray(0, result.length)
}

function refDecode(w: Wire, bytes: Uint8Array): unknown {
    const buf = new RefBuf()
    buf.write(bytes)
    buf.resetPosition(0)
    const dec = new ArgoDecoder(buf)
    return dec.argoToJsWithType(toRef(w))
}

// argo-graphql@1.1.1 (npm) ships a buggy FLOAT64 encoder
// (`new Uint8Array(new Float64Array([v]))` instead of `...buffer`),
// so we exclude FLOAT64 from interop and cover it via self-roundtrip only.

test('interop: ours -> theirs (primitive record)', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 's', of: STRING_BLOCK, omittable: false },
            { name: 'i', of: INT_BLOCK, omittable: false },
            { name: 'b', of: { type: 'BOOLEAN' }, omittable: false }
        ]
    }
    const v = { s: 'hello', i: 42, b: true }
    const ours = encode(wire, v)
    const theirs = refDecode(wire, ours)
    assert.deepEqual(theirs, v)
})

test('interop: theirs -> ours (primitive record)', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 's', of: STRING_BLOCK, omittable: false },
            { name: 'i', of: INT_BLOCK, omittable: false },
            { name: 'b', of: { type: 'BOOLEAN' }, omittable: false }
        ]
    }
    const v = { s: 'hello', i: 42, b: true }
    const theirs = refEncode(wire, v)
    const ours = decode(wire, theirs)
    assert.deepEqual(ours, v)
})

test('interop: byte-equal encoding (primitive record)', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 's', of: STRING_BLOCK, omittable: false },
            { name: 'i', of: INT_BLOCK, omittable: false },
            { name: 'b', of: { type: 'BOOLEAN' }, omittable: false }
        ]
    }
    const v = { s: 'hello', i: 42, b: true }
    const ours = encode(wire, v)
    const theirs = refEncode(wire, v)
    assert.deepEqual(Array.from(ours), Array.from(theirs))
})

test('interop: nullables and dedup strings', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 'a', of: NS(STRING_BLOCK), omittable: false },
            { name: 'b', of: NS(STRING_BLOCK), omittable: false },
            { name: 'c', of: NS(STRING_BLOCK), omittable: false }
        ]
    }
    const v = { a: 'x', b: null, c: 'x' }
    const ours = encode(wire, v)
    const theirs = refEncode(wire, v)
    assert.deepEqual(Array.from(ours), Array.from(theirs))
    assert.deepEqual(refDecode(wire, ours), v)
    assert.deepEqual(decode(wire, theirs), v)
})

test('interop: nested arrays of records', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            {
                name: 'users',
                of: {
                    type: 'ARRAY',
                    of: {
                        type: 'RECORD',
                        fields: [
                            { name: 'name', of: STRING_BLOCK, omittable: false },
                            { name: 'age', of: INT_BLOCK, omittable: false }
                        ]
                    }
                },
                omittable: false
            }
        ]
    }
    const v = {
        users: [
            { name: 'Ada', age: 36 },
            { name: 'Bob', age: 21 },
            { name: 'Ada', age: 36 }
        ]
    }
    const ours = encode(wire, v)
    const theirs = refEncode(wire, v)
    assert.deepEqual(Array.from(ours), Array.from(theirs))
    assert.deepEqual(refDecode(wire, ours), v)
    assert.deepEqual(decode(wire, theirs), v)
})

test('interop: bytes', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [{ name: 'data', of: BYTES_BLOCK, omittable: false }]
    }
    const v = { data: new Uint8Array([1, 2, 3, 4, 250]) }
    const ours = encode(wire, v)
    const theirs = refEncode(wire, v)
    assert.deepEqual(Array.from(ours), Array.from(theirs))
    const dec = refDecode(wire, ours) as { data: Uint8Array }
    assert.deepEqual(Array.from(dec.data), Array.from(v.data))
})

test('interop: omittable absent + present', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 'a', of: STRING_BLOCK, omittable: true },
            { name: 'b', of: INT_BLOCK, omittable: true },
            { name: 'c', of: STRING_BLOCK, omittable: false }
        ]
    }
    const v1 = { c: 'hi' }
    const v2 = { a: 'x', b: 7, c: 'hi' }
    for (const v of [v1, v2]) {
        const ours = encode(wire, v)
        const theirs = refEncode(wire, v)
        assert.deepEqual(Array.from(ours), Array.from(theirs))
    }
})

test('interop: inline everything mode', () => {
    const wire: Wire = {
        type: 'RECORD',
        fields: [
            { name: 's', of: STRING_BLOCK, omittable: false },
            { name: 'i', of: INT_BLOCK, omittable: false }
        ]
    }
    const v = { s: 'inline', i: 99 }
    const ours = encode(wire, v, { inlineEverything: true })
    // Reference's header API requires setting flag before encoding:
    const enc = new ArgoEncoder()
    enc.header.inlineEverything = true
    enc.jsToArgoWithType(v, toRef(wire))
    const refResult = enc.getResult()
    const theirs = refResult.uint8array.subarray(0, refResult.length)
    assert.deepEqual(Array.from(ours), Array.from(theirs))
    // Cross-decode
    assert.deepEqual(refDecode(wire, ours), v)
    assert.deepEqual(decode(wire, theirs), v)
})

test('interop: DESC self-describing values', () => {
    const wire: Wire = { type: 'DESC' }
    const cases: unknown[] = [null, true, false, 42, 'hello', [1, 'two', null], { a: 1, b: 'two' }]
    for (const v of cases) {
        const ours = encode(wire, v)
        const theirs = refEncode(wire, v)
        assert.deepEqual(Array.from(ours), Array.from(theirs), `mismatch for ${JSON.stringify(v)}`)
    }
})
