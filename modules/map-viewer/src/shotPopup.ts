import { describeShot } from "./screenshots.ts"
import type { ViewerController } from "./viewerService.ts"

/**
 * The street-view popup: shows the image of the selected screenshot (thumbnail first, full image when the thumbnail
 * is missing or on click) with its pose, a "look through" button that moves the camera to where it was taken, and a
 * close button. Follows `controller.selectedShot`, so any panel or service call can open it. Returns a disposer.
 */
export const mountShotPopup = (root: HTMLElement, controller: ViewerController): (() => void) => {
  const box = document.createElement("div")
  box.dataset.testid = "viewer-shot-popup"
  box.style.cssText = "display:none;position:absolute;left:8px;bottom:8px;width:min(360px,calc(100% - 16px));background:#1b1e24ee;color:#d8dbe0;border:1px solid #3a3f4a;border-radius:6px;font:12px sans-serif;padding:8px;flex-direction:column;gap:6px;box-sizing:border-box"
  root.appendChild(box)

  const render = () => {
    const shot = controller.selectedShot
    const source = controller.screenshots
    box.replaceChildren()
    box.style.display = shot && source ? "flex" : "none"
    if (!shot || !source) return
    const info = describeShot(shot)
    const head = document.createElement("div")
    head.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:center"
    const title = document.createElement("strong")
    title.textContent = info.title
    title.dataset.testid = "shot-title"
    const close = document.createElement("button")
    close.textContent = "Close"
    close.dataset.testid = "shot-close"
    close.onclick = () => controller.selectShot(undefined)
    head.append(title, close)

    const link = document.createElement("a")
    link.href = source.imageUrl(shot.file)
    link.target = "_blank"
    link.rel = "noopener"
    const img = document.createElement("img")
    img.dataset.testid = "shot-image"
    img.alt = `Screenshot ${shot.id}`
    img.src = source.imageUrl(shot.thumbnail ?? shot.file)
    img.style.cssText = "width:100%;height:auto;display:block;background:#0e1013;border-radius:4px"
    img.onerror = () => { if (shot.thumbnail && img.src !== link.href) img.src = link.href }
    link.appendChild(img)

    const meta = document.createElement("div")
    meta.dataset.testid = "shot-pose"
    meta.textContent = `${shot.width}×${shot.height}, ${info.pose}`
    meta.style.color = "#9aa0aa"
    box.append(head, link, meta)
    if (source.set.placeholder) {
      const note = document.createElement("div")
      note.textContent = "Placeholder: dry run, the image and pose are not real."
      note.style.color = "#e0a95a"
      box.appendChild(note)
    }
    if (info.drift) {
      const warn = document.createElement("div")
      warn.dataset.testid = "shot-drift"
      warn.textContent = info.drift
      warn.style.color = "#e0a95a"
      box.appendChild(warn)
    }
    const go = document.createElement("button")
    go.textContent = "Look through this shot"
    go.dataset.testid = "shot-look"
    go.onclick = () => controller.lookThroughShot(shot)
    box.appendChild(go)
  }
  const off = controller.onShotChange(render)
  render()
  return () => { off(); box.remove() }
}
