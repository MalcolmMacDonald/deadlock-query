/** Saves `blob` through a temporary link. The shell and the standalone page both allow this; no popup needed. */
export const downloadBlob = (doc: Document, filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob)
  const a = doc.createElement("a")
  a.href = url
  a.download = filename
  a.style.display = "none"
  doc.body.append(a)
  a.click()
  a.remove()
  // Revoke after the click has been handled; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
