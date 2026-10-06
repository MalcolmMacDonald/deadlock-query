import ts from "typescript"
import { resolve } from "node:path"

export interface CatalogMember {
  readonly name: string
  readonly kind: "method" | "property" | "getter" | "constructor"
  readonly signature: string
  readonly summary: string
  readonly category?: string
  readonly examples: ReadonlyArray<string>
}

export interface CatalogEntry {
  readonly name: string
  readonly kind: "class" | "function" | "const" | "type" | "interface"
  readonly signature: string
  readonly summary: string
  readonly category?: string
  readonly examples: ReadonlyArray<string>
  readonly members: ReadonlyArray<CatalogMember>
}

const docOf = (node: ts.Node): { summary: string; category?: string; examples: string[] } => {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const doc = docs[docs.length - 1]
  const text = (c: ts.JSDoc["comment"]): string =>
    typeof c === "string" ? c : (c ?? []).map((p) => p.text).join("")
  const summary = doc ? text(doc.comment).trim() : ""
  let category: string | undefined
  const examples: string[] = []
  for (const tag of doc?.tags ?? []) {
    const name = tag.tagName.text
    if (name === "category") category = text(tag.comment).trim()
    if (name === "example") examples.push(text(tag.comment).trim())
  }
  return { summary, ...(category ? { category } : {}), examples }
}

const sig = (n: ts.Node, sf: ts.SourceFile): string =>
  n.getText(sf).replace(/\s*\{[\s\S]*$/, "").replace(/\s+/g, " ").trim()

/** Read TSDoc of everything exported from `src/index.ts` into a flat catalog. */
export const buildCatalog = (srcDir: string): CatalogEntry[] => {
  const entry = resolve(srcDir, "index.ts")
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true
  })
  const checker = program.getTypeChecker()
  const root = program.getSourceFile(entry)!
  const out: CatalogEntry[] = []
  for (const sym of checker.getExportsOfModule(checker.getSymbolAtLocation(root)!)) {
    const decl = (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym).declarations?.[0]
    if (!decl) continue
    const sf = decl.getSourceFile()
    const stmt = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl
    const base = { name: sym.name, ...docOf(stmt) }
    if (ts.isClassDeclaration(decl)) {
      const members: CatalogMember[] = []
      for (const m of decl.members) {
        const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []
        if (mods.some((x) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.OverrideKeyword].includes(x.kind))) continue
        if (m.name && ts.isComputedPropertyName(m.name)) continue
        if (ts.isMethodDeclaration(m)) members.push({ name: m.name.getText(sf), kind: "method", signature: sig(m, sf), ...docOf(m) })
        else if (ts.isGetAccessorDeclaration(m)) members.push({ name: m.name.getText(sf), kind: "getter", signature: sig(m, sf), ...docOf(m) })
        else if (ts.isPropertyDeclaration(m)) members.push({ name: m.name.getText(sf), kind: "property", signature: sig(m, sf), ...docOf(m) })
        else if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) if (p.modifiers?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword) && !p.modifiers.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword))
            members.push({ name: p.name.getText(sf), kind: "property", signature: sig(p, sf), ...docOfParam(p, m) })
        }
      }
      out.push({ ...base, kind: "class", signature: `class ${sym.name}`, members })
    } else if (ts.isFunctionDeclaration(decl)) out.push({ ...base, kind: "function", signature: sig(decl, sf), members: [] })
    else if (ts.isVariableDeclaration(decl)) out.push({ ...base, kind: "const", signature: sig(decl, sf), members: [] })
    else if (ts.isTypeAliasDeclaration(decl)) out.push({ ...base, kind: "type", signature: sig(decl, sf), members: [] })
    else if (ts.isInterfaceDeclaration(decl)) out.push({ ...base, kind: "interface", signature: `interface ${sym.name}`, members: [] })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Constructor parameter properties carry their TSDoc on the parameter itself. */
const docOfParam = (p: ts.ParameterDeclaration, _ctor: ts.ConstructorDeclaration) => docOf(p)

/** Problems that fail the docs gate: every export needs a summary + category; callables need an example. */
export const docProblems = (catalog: ReadonlyArray<CatalogEntry>): string[] => {
  const errors: string[] = []
  for (const e of catalog) {
    if (!e.summary) errors.push(`${e.name}: missing summary`)
    if (!e.category) errors.push(`${e.name}: missing @category`)
    if ((e.kind === "function" || e.kind === "class") && e.examples.length === 0) errors.push(`${e.name}: missing @example`)
    for (const m of e.members) {
      if (m.kind !== "property" && !m.summary) errors.push(`${e.name}.${m.name}: missing summary`)
      if (m.kind === "method" && m.examples.length === 0) errors.push(`${e.name}.${m.name}: missing @example`)
    }
  }
  return errors
}
