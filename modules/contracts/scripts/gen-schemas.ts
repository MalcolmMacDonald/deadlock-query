import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { EntitiesFile, Manifest, QueryResult } from "../src/index.ts"

const out = join(import.meta.dir, "..", "schemas")
mkdirSync(out, { recursive: true })
for (const [name, schema] of Object.entries({ manifest: Manifest, entities: EntitiesFile, "query-result": QueryResult })) {
  writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(Schema.toJsonSchemaDocument(schema), null, 2) + "\n")
}
console.log(`wrote schemas to ${out}`)
