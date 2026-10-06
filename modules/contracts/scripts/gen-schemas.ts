import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { AnnotationDocument, EntitiesFile, Manifest, MetadataBundle, MetadataFile, QueryResult, ReviewDecision, ScreenshotSet, Submission } from "../src/index.ts"

const out = join(import.meta.dir, "..", "schemas")
mkdirSync(out, { recursive: true })
for (const [name, schema] of Object.entries({ manifest: Manifest, entities: EntitiesFile, "query-result": QueryResult, annotations: AnnotationDocument, "metadata-file": MetadataFile, "metadata-bundle": MetadataBundle, submission: Submission, "review-decision": ReviewDecision, "screenshot-set": ScreenshotSet })) {
  writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(Schema.toJsonSchemaDocument(schema), null, 2) + "\n")
}
console.log(`wrote schemas to ${out}`)
