// Generates Resources/AppIcon.png (1024×1024) — the ORIGINAL Klorn brand mark:
// the 3D black K on white (apps/mobile/assets/icon-only.png, same asset the web
// and mobile apps ship), clipped to the Big Sur squircle. Founder direction
// 2026-07-20: use the existing white/black brand icon, not an amber remix.
//
//   swift scripts/generate-appicon.swift Resources/AppIcon.png
//
// Reads the K artwork from ../mobile/assets/icon-only.png relative to
// apps/desktop-mac (run from that directory, as make-app.sh does).

import AppKit

let size: CGFloat = 1024
// Big Sur template: 824pt icon body centered on a 1024 canvas.
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let cornerRadius: CGFloat = 185

let sourcePath = "../mobile/assets/icon-only.png"
guard let artwork = NSImage(contentsOfFile: sourcePath) else {
    fputs("cannot read \(sourcePath) — run from apps/desktop-mac\n", stderr)
    exit(1)
}

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    guard let ctx = NSGraphicsContext.current?.cgContext else { return false }

    let shape = NSBezierPath(roundedRect: body, xRadius: cornerRadius, yRadius: cornerRadius)

    // Drop shadow behind the body (reads as depth at Finder sizes).
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 44,
                  color: NSColor.black.withAlphaComponent(0.35).cgColor)
    NSColor.white.setFill()
    shape.fill()
    ctx.restoreGState()

    // The brand artwork is a full-bleed white square with the 3D K centered —
    // draw it clipped to the squircle so its white field IS the icon field.
    ctx.saveGState()
    shape.addClip()
    artwork.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    ctx.restoreGState()

    // Hairline so the white body keeps an edge on light backgrounds.
    NSColor.black.withAlphaComponent(0.08).setStroke()
    let border = NSBezierPath(
        roundedRect: body.insetBy(dx: 1.5, dy: 1.5),
        xRadius: cornerRadius - 1.5, yRadius: cornerRadius - 1.5)
    border.lineWidth = 3
    border.stroke()

    return true
}

guard let out = CommandLine.arguments.dropFirst().first else {
    fputs("usage: swift generate-appicon.swift <out.png>\n", stderr)
    exit(1)
}
guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:])
else {
    fputs("failed to rasterize\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
