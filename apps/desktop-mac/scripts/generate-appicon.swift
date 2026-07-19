// Generates Resources/AppIcon.png (1024×1024) — the Klorn identity as a
// macOS Big-Sur-style icon: warm-graphite rounded square (the panel surface),
// the amber ring (the wordmark), a top-light catching the glass, and a soft
// ring glow. Deterministic: same input → same pixels, so the PNG is committed
// and CI never needs to draw.
//
//   swift scripts/generate-appicon.swift Resources/AppIcon.png

import AppKit

let size: CGFloat = 1024
// Big Sur template: 824pt icon body centered on a 1024 canvas.
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let cornerRadius: CGFloat = 185

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    guard let ctx = NSGraphicsContext.current?.cgContext else { return false }

    let shape = NSBezierPath(roundedRect: body, xRadius: cornerRadius, yRadius: cornerRadius)

    // Drop shadow behind the body (reads as depth at Finder sizes).
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 44,
                  color: NSColor.black.withAlphaComponent(0.5).cgColor)
    NSColor(red: 0.07, green: 0.062, blue: 0.055, alpha: 1).setFill()
    shape.fill()
    ctx.restoreGState()

    // Warm-graphite vertical gradient — the panel surface.
    ctx.saveGState()
    shape.addClip()
    let surface = NSGradient(
        starting: NSColor(red: 0.135, green: 0.112, blue: 0.088, alpha: 1),
        ending: NSColor(red: 0.055, green: 0.050, blue: 0.055, alpha: 1))
    surface?.draw(in: body, angle: -90)

    // Top-light: light catching the glass.
    let topLight = NSGradient(
        starting: NSColor.white.withAlphaComponent(0.12),
        ending: NSColor.white.withAlphaComponent(0))
    topLight?.draw(
        in: NSRect(x: body.minX, y: body.maxY - 170, width: body.width, height: 170), angle: -90)
    ctx.restoreGState()

    // Hairline border.
    NSColor.white.withAlphaComponent(0.10).setStroke()
    let border = NSBezierPath(
        roundedRect: body.insetBy(dx: 1.5, dy: 1.5),
        xRadius: cornerRadius - 1.5, yRadius: cornerRadius - 1.5)
    border.lineWidth = 3
    border.stroke()

    // The amber ring — Klorn's wordmark — with a soft glow.
    let amber = NSColor(red: 1.0, green: 0.56, blue: 0.18, alpha: 1)
    let ringRadius: CGFloat = 196
    let ringWidth: CGFloat = 58
    let ringRect = NSRect(
        x: size / 2 - ringRadius, y: size / 2 - ringRadius,
        width: ringRadius * 2, height: ringRadius * 2)

    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 70, color: amber.withAlphaComponent(0.55).cgColor)
    amber.setStroke()
    let ring = NSBezierPath(ovalIn: ringRect)
    ring.lineWidth = ringWidth
    ring.stroke()
    ctx.restoreGState()

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
