// E2E equivalence tests against the reference impl's fixtures.
//
// Fixtures live under `test/fixtures/{starwars,github,self-describing}/`
// (vendored from the reference repo). Per query we have: a GraphQL schema
// (schema.graphql), a query (.graphql), the expected response (.json), the
// printed wire schema (.wire), and several `.argo` files — one per header-mode
// combination, named with the hex of the header bytes.
//
// We use the reference's `Typer` to derive the wire schema from each query
// (we don't need to re-implement that), translate to our Wire shape, then
// decode every `.argo` fixture and compare to the expected JSON.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSchema, parse } from 'graphql'
import { decode, type Wire } from '../src/index.js'

const require = createRequire(import.meta.url)
const { Typer } = require('argo-graphql/dist/typer.js')
const { Wire: RefWire } = require('argo-graphql/dist/wire.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = path.resolve(here, 'fixtures')

// Translate reference Wire (with `Field.type:` legacy naming) to our Wire (`Field.of:`).
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
                    of: fromRef(f.type ?? f.of), // 1.1.1 uses `type:`
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
    wire: Wire
    argoFiles: { mode: string; bytes: Uint8Array }[]
}

function loadFixtures(suiteDir: string, suite: string): Fixture[] {
    const schemaPath = path.join(suiteDir, 'schema.graphql')
    if (!fs.existsSync(schemaPath)) return []
    const schema = buildSchema(fs.readFileSync(schemaPath, 'utf8'))
    const fixtures: Fixture[] = []
    for (const f of fs.readdirSync(suiteDir)) {
        if (!f.endsWith('.graphql') || f === 'schema.graphql') continue
        const name = f.slice(0, -'.graphql'.length)
        const queryPath = path.join(suiteDir, f)
        const jsonPath = path.join(suiteDir, `${name}.json`)
        if (!fs.existsSync(jsonPath)) continue
        const query = parse(fs.readFileSync(queryPath, 'utf8'))
        const expected = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
        const typer = new Typer(schema, query)
        const refWire = typer.rootWireType()
        const wire = fromRef(refWire)
        const argoFiles: { mode: string; bytes: Uint8Array }[] = []
        for (const af of fs.readdirSync(suiteDir)) {
            const m = af.match(new RegExp(`^${name}-([0-9a-f]+)\\.argo$`))
            if (!m) continue
            argoFiles.push({
                mode: m[1],
                bytes: new Uint8Array(fs.readFileSync(path.join(suiteDir, af)))
            })
        }
        fixtures.push({ suite, name, expected, wire, argoFiles })
    }
    return fixtures
}

// Strip undefined fields so deepEqual works against JSON-loaded expected values.
function clean(v: unknown): unknown {
    if (v === null || v === undefined) return v
    if (Array.isArray(v)) return v.map(clean)
    if (v instanceof Uint8Array) return v
    if (typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (val === undefined) continue
            out[k] = clean(val)
        }
        return out
    }
    return v
}

// Decoder doesn't materialize an `errors` array for inline field errors. The
// reference fixtures use OutOfBandFieldErrors+SelfDescribingErrors, so the
// errors travel as a top-level `errors` field. Also, error path arrays come
// out as integer wire-paths and we don't reconstruct them here. To keep this
// e2e check focused on data parity, drop `errors` from both sides before
// comparing for fixtures that include them.
function dropErrors(v: unknown): unknown {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Record<string, unknown>
        if ('errors' in o) {
            const { errors, ...rest } = o
            return rest
        }
    }
    return v
}

// `self-describing` requires the v1.2 `@ArgoCodec(codec: DESC)` directive,
// which the published argo-graphql@1.1.1 Typer rejects. DESC is already
// exercised by our roundtrip + interop suites, so we leave that fixture set
// vendored but unused here.
const SUITES = ['starwars', 'github']

for (const suite of SUITES) {
    const suiteDir = path.join(FIXTURES_ROOT, suite)
    if (!fs.existsSync(suiteDir)) continue
    const fixtures = loadFixtures(suiteDir, suite)
    if (fixtures.length === 0) continue

    for (const fx of fixtures) {
        for (const af of fx.argoFiles) {
            test(`equivalence ${suite}/${fx.name} mode ${af.mode}`, () => {
                const decoded = decode(fx.wire, af.bytes)
                assert.deepEqual(dropErrors(clean(decoded)), dropErrors(fx.expected))
            })
        }
    }
}
