import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib"

/**
 * Minimal zip writer (deflate, zip32) so publishing works where no `zip` binary exists (Windows).
 * Each file is read whole, so single files must be < 2 GB; the archive must stay < 4 GB.
 */
export const writeZip = (zipPath: string, root: string, files: string[]): void => {
  const fd = openSync(zipPath, "w")
  try {
    let offset = 0
    const out = (b: Buffer) => { writeSync(fd, b); offset += b.length }
    const central: Buffer[] = []
    for (const rel of files) {
      const data = readFileSync(join(root, rel))
      const packed = deflateRawSync(data)
      const useDeflate = packed.length < data.length
      const body = useDeflate ? packed : data
      const name = Buffer.from(rel, "utf8")
      const crc = crc32(data)
      if (offset + body.length > 0xffffffff) throw new Error("zip: archive exceeds 4 GB")
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // UTF-8 names
      local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt32LE(0x00210000, 10) // fixed 1980-01-01 time/date
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8)
      cd.writeUInt16LE(useDeflate ? 8 : 0, 10); cd.writeUInt32LE(0x00210000, 12)
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28)
      cd.writeUInt32LE(offset, 42)
      central.push(Buffer.concat([cd, name]))
      out(local); out(name); out(body)
    }
    const cdStart = offset
    for (const c of central) out(c)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16)
    out(end)
  } finally {
    closeSync(fd)
  }
}

/** Minimal zip reader matching `writeZip` (stored/deflate, zip32); extracts into `dest`, rejecting paths that escape it. */
export const extractZip = (bytes: Uint8Array, dest: string): void => {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found")
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const root = resolve(dest)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry")
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    const target = resolve(root, name)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip: unsafe path ${name}`)
    if (name.endsWith("/")) { mkdirSync(target, { recursive: true }); continue }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const body = buf.subarray(start, start + size)
    let data: Buffer
    if (method === 0) data = body
    else if (method === 8) data = inflateRawSync(body)
    else throw new Error(`zip: unsupported method ${method} for ${name}`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}
