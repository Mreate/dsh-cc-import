import { defineConfig } from 'tsdown'

// The DSH client loader expects a factory-form bundle:
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
// so the client half is produced as CJS wrapped in that registration, not a plain ESM export.
const ID = 'ccimport'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  fixedExtension: false,
  clean: false,
  banner: `window.__ModuleLoader__.load({\n  id: "${ID}",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`,
  footer: `\n    return module.exports;\n  }\n});\n`,
})
