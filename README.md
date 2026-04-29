# argo-codec

Fast, zero-copy TypeScript implementation of [Argo](https://msolomon.github.io/argo/versions/1.2/spec) — a compact and compressible binary serialization format for GraphQL.

- Implements the [Argo 1.2 specification](https://msolomon.github.io/argo/versions/1.2/spec).
- Zero-copy on decode for `BYTES` (returned as a `Uint8Array` view aliasing the source buffer).
- ~3.6× faster encode and ~9.7× faster decode than the reference `argo-graphql` package on real-world payloads (see [Benchmarks](#benchmarks)).
- Validated against the reference implementation: 144 e2e equivalence tests across all 7 header-mode combinations.
- No runtime dependencies. Single ESM package, ~5 source files, ~830 LOC.

## Install

```bash
npm install argo-codec
```

Requires Node `>=18` (uses `TextEncoder`/`TextDecoder` and `node:test` in tests). Browser-compatible — only uses standard `Uint8Array` / `DataView` / `TextEncoder` APIs.

## Quick start

```ts
import { encode, decode, type Wire } from 'argo-codec'

const wire: Wire = {
    type: 'RECORD',
    fields: [
        {
            name: 'data',
            of: {
                type: 'NULLABLE',
                of: {
                    type: 'RECORD',
                    fields: [
                        {
                            name: 'name',
                            of: {
                                type: 'BLOCK',
                                of: { type: 'STRING' },
                                key: 'String',
                                dedupe: true
                            },
                            omittable: false
                        }
                    ]
                }
            },
            omittable: false
        }
    ]
}

const bytes = encode(wire, { data: { name: 'R2-D2' } })
const value = decode(wire, bytes)
// => { data: { name: 'R2-D2' } }
```

## Wire schema

Argo separates work into two phases:

- **Registration time** — derive a wire schema from a GraphQL query+schema (typically once, at compile time / app start).
- **Execution time** — encode/decode many payloads against that schema.

`argo-codec` does the binary codec only. Generating wire schemas from GraphQL queries (the `Typer` step) is out of scope; you can use the reference `argo-graphql` package for that.

The `Wire` type is a tagged union:

```ts
type Wire =
    | { type: 'STRING' }
    | { type: 'BOOLEAN' }
    | { type: 'VARINT' }
    | { type: 'FLOAT64' }
    | { type: 'BYTES' }
    | { type: 'FIXED'; length: number }
    | { type: 'RECORD'; fields: { name: string; of: Wire; omittable: boolean }[] }
    | { type: 'ARRAY'; of: Wire }
    | { type: 'BLOCK'; of: Wire; key: string; dedupe: boolean }
    | { type: 'NULLABLE'; of: Wire }
    | { type: 'DESC' } // self-describing
    | { type: 'PATH' } // error path
```

## API

### `encode(wire, value, opts?): Uint8Array`

Serialize `value` against `wire`. Returns a `Uint8Array` containing the full Argo message.

```ts
encode(wire, value, {
    inlineEverything: false,        // omit blocks; embed scalars in core
    selfDescribing: false,          // encode core as DESC
    outOfBandFieldErrors: false,    // do not write field errors inline
    selfDescribingErrors: false,    // encode errors as DESC
    nullTerminatedStrings: false,   // append a 0x00 after each string
    noDeduplication: false          // hint that no backreferences are used
})
```

### `decode(wire, bytes): unknown`

Read flags from the message header and decode against `wire`. Returns the JavaScript value.

- `BYTES` decode as `Uint8Array` views aliasing `bytes` (zero-copy).
- `STRING` decode via `TextDecoder` (one allocation per first occurrence; subsequent dedup hits return the cached string).
- Inline field errors at a `NULLABLE` position become a `FieldErrorSentinel` instance carrying the error array.

### `FieldErrorSentinel`

```ts
import { FieldErrorSentinel, type ArgoError } from 'argo-codec'

// On encode: pass FieldErrorSentinel where a NULLABLE field has a propagated error.
encode(wire, { data: new FieldErrorSentinel([{ message: 'boom', extensions: { code: 'X' } }]) })

// On decode: the same sentinel comes back at NULLABLE positions that hit -3 (Error) inline.
const out = decode(wire, bytes) as { data: FieldErrorSentinel | null | unknown }
if (out.data instanceof FieldErrorSentinel) {
    console.error(out.data.errors)
}
```

### Path helpers

```ts
import { pathToWire, wireToPath } from 'argo-codec'

pathToWire(['users', 0, 'email'], wire) // [0, 0, 2]
wireToPath([0, 0, 2], wire)             // ['users', 0, 'email']
```

## Modes

| Flag                     | Bit | Effect                                                                |
| ------------------------ | --- | --------------------------------------------------------------------- |
| `inlineEverything`       | 0   | Skip block segments; scalars written inline in core. Smaller messages, less compressible. |
| `selfDescribing`         | 1   | Encode core as `DESC`. Useful for debugging.                          |
| `outOfBandFieldErrors`   | 2   | Field errors travel in the response `errors` array, not inline.       |
| `selfDescribingErrors`   | 3   | Errors encoded as `DESC` values.                                      |
| `nullTerminatedStrings`  | 4   | Append `0x00` after each string in its block.                         |
| `noDeduplication`        | 5   | Hint that no backreferences appear; decoder may skip dedup tracking.  |

## Benchmarks

Hot-loop encode + decode against `argo-graphql@1.1.1` (the reference), Node 25, Windows 11. Both run with `OutOfBandFieldErrors + SelfDescribingErrors` (the reference default).

```
=== encode ===                   bytes   ours ops/s   ref ops/s   speedup    ours MB/s
starwars/HeroNameQuery              12        391.9k       87.7k     4.47x         4.7
starwars/Overlap                   348         42.8k       10.6k     4.04x        14.9
github/Government               23 847          1.6k         787     2.00x        37.5
github/Rails                    41 897          1.9k         977     1.98x        81.0
github/Sponsors                  8 371          2.4k        1.2k     1.92x        19.9

  geo-mean encode speedup: 3.58x

=== decode ===                   bytes   ours ops/s   ref ops/s   speedup    ours MB/s
starwars/HeroNameQuery              12         1.23M       91.7k    13.43x        14.8
starwars/Overlap                   348         81.0k        9.4k     8.62x        28.2
github/Government               23 847          3.6k        1.0k     3.57x        86.7
github/Rails                    41 897          5.3k        1.0k     5.12x       220.6
github/Sponsors                  8 371          5.2k        1.3k     3.89x        43.5

  geo-mean decode speedup: 9.69x
```

Run locally with `npm run bench`.

Where the speedup comes from:

- Varint fast-path uses regular `number` arithmetic; the reference uses `bigint` everywhere.
- `Reader.bytes` returns subarray views (no copies) and reuses a cached `DataView`.
- No path tracking / DEBUG hooks per node.
- BYTES are returned as views aliasing the input buffer.

## Conformance

Three test suites:

- **roundtrip** (`test/roundtrip.test.ts`) — 14 self-roundtrip tests covering every wire type and mode combination.
- **interop** (`test/interop.test.ts`) — 9 byte-equal cross-impl tests against the reference encoder/decoder.
- **equivalence** (`test/equivalence.test.ts`) — 144 e2e tests decoding the reference's Star Wars + GitHub fixtures across all 8 header-mode permutations (`18`, `1a`, `1c`, `1e`, `38`, `58`, `98`, `9840`).

```bash
npm test
```

Total: 167 tests.

## Limitations

- `VARINT` deduplication is not supported (collides with the backreference space; see the spec note). The default for `VARINT` is `dedupe: false` per spec, so this only matters if you explicitly opted in.
- 64-bit integers via `bigint` are supported through the lower-level `Buf.labelBig` / `Reader.labelBig`. The default `VARINT` decoder returns a regular `number` (safe up to 2^53).
- Field errors at the root response level (request errors) follow the spec's `ERROR_WIRE` shape; you provide them as an `errors: ArgoError[]` field of your record.

## Differences from the reference impl

A handful of intentional differences vs the published `argo-graphql@1.1.1`:

- We follow the v1.2 spec for field error inline encoding (`Error` label + array of errors). The 1.1.1 reference still uses an older single-error-self-describing form.
- Inline field errors decode to a `FieldErrorSentinel` carrying the errors. The reference returns `null` and discards them.
- Header `BitSet` and varint encodings match the reference byte-for-byte.

## License

MIT — see [LICENSE](./LICENSE).
