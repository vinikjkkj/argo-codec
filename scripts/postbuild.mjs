// Drop a tiny package.json in dist/cjs/ so Node treats its .js files as CommonJS
// regardless of the parent package's "type": "module".
import { writeFileSync } from 'node:fs'
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n')
