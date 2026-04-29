// Encode + decode benchmark: ours vs argo-graphql reference impl.
// Uses the same fixtures as test/equivalence.test.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { buildSchema, parse } from 'graphql'
import { encode as ourEncode, decode as ourDecode, type Wire } from '../src/index.js'

const require = createRequire(import.meta.url)
const { Typer } = require('argo-graphql/dist/typer.js')
const { Wire: RefWire } = require('argo-graphql/dist/wire.js')
const { ArgoEncoder } = require('argo-graphql/dist/encoder.js')
const { ArgoDecoder } = require('argo-graphql/dist/decoder.js')
const { Buf: RefBuf } = require('argo-graphql/dist/buf.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = path.resolve(here, '../test/fixtures')

function fromRef(t: any): Wire {
    switch (t.type) {
        case RefWire.TypeKey.STRING:
            return { type: 'STRING' }
        case RefWire.TypeKey.BOOLEAN:
            return { type: 'BOOLEAN' }
        case RefWire.TypeKey.VARINT:
            return { type: 'VARINT' }
        case RefWire.TypeKey.FLOAT64:
            return { type: 'FLOAT64' }
        case RefWire.TypeKey.BYTES:
            return { type: 'BYTES' }
        case RefWire.TypeKey.PATH:
            return { type: 'PATH' }
        case RefWire.TypeKey.DESC:
            return { type: 'DESC' }
        case RefWire.TypeKey.FIXED:
            return { type: 'FIXED', length: t.length }
        case RefWire.TypeKey.NULLABLE:
            return { type: 'NULLABLE', of: fromRef(t.of) }
        case RefWire.TypeKey.ARRAY:
            return { type: 'ARRAY', of: fromRef(t.of) }
        case RefWire.TypeKey.BLOCK:
            return { type: 'BLOCK', of: fromRef(t.of), key: t.key, dedupe: t.dedupe }
        case RefWire.TypeKey.RECORD:
            return {
                type: 'RECORD',
                fields: t.fields.map((f: any) => ({
                    name: f.name,
                    of: fromRef(f.type ?? f.of),
                    omittable: f.omittable
                }))
            }
        default:
            throw new Error(`fromRef: unknown wire type ${JSON.stringify(t)}`)
    }
}

interface Fixture {
    suite: string
    name: string
    expected: unknown
    ourWire: Wire
    refWire: any
    refArgo: Uint8Array // canonical reference-encoded bytes (default mode)
}

function loadFixtures(suite: string): Fixture[] {
    const dir = path.join(FIXTURES_ROOT, suite)
    if (!fs.existsSync(dir)) return []
    const schema = buildSchema(fs.readFileSync(path.join(dir, 'schema.graphql'), 'utf8'))
    const out: Fixture[] = []
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.graphql') || f === 'schema.graphql') continue
        const name = f.slice(0, -'.graphql'.length)
        const jsonPath = path.join(dir, `${name}.json`)
        if (!fs.existsSync(jsonPath)) continue
        const query = parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const expected = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
        const refWire = new Typer(schema, query).rootWireType()
        const ourWire = fromRef(refWire)

        // Canonical bytes via reference (default mode = OutOfBand + SelfDescribingErrors).
        const enc = new ArgoEncoder()
        enc.header.outOfBandFieldErrors = true
        enc.header.selfDescribingErrors = true
        enc.jsToArgoWithType(expected, refWire)
        const buf = enc.getResult()
        const refArgo = new Uint8Array(buf.uint8array.subarray(0, buf.length))
        out.push({ suite, name, expected, ourWire, refWire, refArgo })
    }
    return out
}

function refEncode(refWire: any, expected: unknown): Uint8Array {
    const enc = new ArgoEncoder()
    enc.header.outOfBandFieldErrors = true
    enc.header.selfDescribingErrors = true
    enc.jsToArgoWithType(expected, refWire)
    const buf = enc.getResult()
    return buf.uint8array.subarray(0, buf.length)
}

function refDecode(refWire: any, bytes: Uint8Array): unknown {
    const buf = new RefBuf()
    buf.write(bytes)
    buf.resetPosition(0)
    return new ArgoDecoder(buf).argoToJsWithType(refWire)
}

interface BenchResult {
    iters: number
    ms: number
    opsPerSec: number
    nsPerOp: number
}

function bench(fn: () => void, targetMs = 400, warmupMs = 50): BenchResult {
    // Warmup
    let start = performance.now()
    while (performance.now() - start < warmupMs) fn()
    // Measure: time a fixed batch, scaled until total >= targetMs
    let iters = 1
    let ms = 0
    while (true) {
        start = performance.now()
        for (let i = 0; i < iters; i++) fn()
        ms = performance.now() - start
        if (ms >= targetMs || iters > 1e8) break
        const factor = Math.max(2, Math.ceil((targetMs / Math.max(ms, 1)) * 1.2))
        iters *= factor
    }
    return { iters, ms, opsPerSec: (iters / ms) * 1000, nsPerOp: (ms * 1e6) / iters }
}

function fmt(n: number, w = 10): string {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return n.toFixed(0)
}

function pad(s: string, w: number, right = false): string {
    if (s.length >= w) return s
    const fill = ' '.repeat(w - s.length)
    return right ? fill + s : s + fill
}

function ratio(ours: number, ref: number): string {
    const r = ours / ref
    if (r >= 1) return `${r.toFixed(2)}x`
    return `${r.toFixed(2)}x`
}

const fixtures = [...loadFixtures('starwars'), ...loadFixtures('github')]

console.log(`Argo encode/decode benchmark`)
console.log(`Node ${process.version} | ${process.platform} | ${fixtures.length} fixtures`)
console.log()

// ENCODE
{
    const cols = [
        'fixture',
        'bytes',
        'ours ops/s',
        'ref  ops/s',
        'speedup',
        'ours MB/s',
        'ref  MB/s'
    ]
    const widths = [38, 8, 12, 12, 9, 11, 11]
    console.log('=== encode ===')
    console.log(cols.map((c, i) => pad(c, widths[i])).join(' '))
    let totalOursOps = 0
    let totalRefOps = 0
    for (const fx of fixtures) {
        const tag = `${fx.suite}/${fx.name}`
        const bytes = fx.refArgo.length
        const ours = bench(() => {
            ourEncode(fx.ourWire, fx.expected, {
                outOfBandFieldErrors: true,
                selfDescribingErrors: true
            })
        })
        const ref = bench(() => {
            refEncode(fx.refWire, fx.expected)
        })
        totalOursOps += ours.opsPerSec
        totalRefOps += ref.opsPerSec
        const oursMBs = (ours.opsPerSec * bytes) / 1e6
        const refMBs = (ref.opsPerSec * bytes) / 1e6
        console.log(
            [
                pad(tag, widths[0]),
                pad(String(bytes), widths[1], true),
                pad(fmt(ours.opsPerSec), widths[2], true),
                pad(fmt(ref.opsPerSec), widths[3], true),
                pad(ratio(ours.opsPerSec, ref.opsPerSec), widths[4], true),
                pad(oursMBs.toFixed(1), widths[5], true),
                pad(refMBs.toFixed(1), widths[6], true)
            ].join(' ')
        )
    }
    console.log(
        `\n  geo-mean speedup (encode): ${(totalOursOps / totalRefOps).toFixed(2)}x (sum-of-ops ratio)`
    )
}

console.log()

// DECODE
{
    const cols = [
        'fixture',
        'bytes',
        'ours ops/s',
        'ref  ops/s',
        'speedup',
        'ours MB/s',
        'ref  MB/s'
    ]
    const widths = [38, 8, 12, 12, 9, 11, 11]
    console.log('=== decode ===')
    console.log(cols.map((c, i) => pad(c, widths[i])).join(' '))
    let totalOursOps = 0
    let totalRefOps = 0
    for (const fx of fixtures) {
        const tag = `${fx.suite}/${fx.name}`
        const bytes = fx.refArgo.length
        const ours = bench(() => {
            ourDecode(fx.ourWire, fx.refArgo)
        })
        const ref = bench(() => {
            refDecode(fx.refWire, fx.refArgo)
        })
        totalOursOps += ours.opsPerSec
        totalRefOps += ref.opsPerSec
        const oursMBs = (ours.opsPerSec * bytes) / 1e6
        const refMBs = (ref.opsPerSec * bytes) / 1e6
        console.log(
            [
                pad(tag, widths[0]),
                pad(String(bytes), widths[1], true),
                pad(fmt(ours.opsPerSec), widths[2], true),
                pad(fmt(ref.opsPerSec), widths[3], true),
                pad(ratio(ours.opsPerSec, ref.opsPerSec), widths[4], true),
                pad(oursMBs.toFixed(1), widths[5], true),
                pad(refMBs.toFixed(1), widths[6], true)
            ].join(' ')
        )
    }
    console.log(
        `\n  geo-mean speedup (decode): ${(totalOursOps / totalRefOps).toFixed(2)}x (sum-of-ops ratio)`
    )
}
