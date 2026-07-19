// Generates Resources/AppIcon.png (1024×1024) — the Klorn "K" monogram:
// a heavy rounded K in an amber→coral gradient, glowing softly on the
// warm-graphite squircle. A letterform reads as *Klorn* at every size in a
// way an abstract ring never did (dogfood 2026-07-20).
//
//   swift scripts/generate-appicon.swift Resources/AppIcon.png

import AppKit
import CoreText

let size: CGFloat = 1024
// Big Sur template: 824pt icon body centered on a 1024 canvas.
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let cornerRadius: CGFloat = 185

func roundedHeavyFont(pointSize: CGFloat) -> NSFont {
    let base = NSFont.systemFont(ofSize: pointSize, weight: .heavy)
    guard let descriptor = base.fontDescriptor.withDesign(.rounded),
          let rounded = NSFont(descriptor: descriptor, size: pointSize)
    else { return base }
    return rounded
}

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

    // ── The K ────────────────────────────────────────────────────────────
    let font = roundedHeavyFont(pointSize: 600)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
    let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: "K", attributes: attributes))
    let bounds = CTLineGetImageBounds(line, ctx)
    let origin = CGPoint(x: size / 2 - bounds.midX, y: size / 2 - bounds.midY)

    let amber = NSColor(red: 1.0, green: 0.63, blue: 0.20, alpha: 1)
    let coral = NSColor(red: 1.0, green: 0.42, blue: 0.29, alpha: 1)

    // Soft glow pass: the K in amber with a wide shadow, under the real fill.
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 64, color: amber.withAlphaComponent(0.55).cgColor)
    ctx.textPosition = origin
    ctx.setFillColor(amber.cgColor)
    CTLineDraw(line, ctx)
    ctx.restoreGState()

    // Gradient fill pass: clip to the glyph, pour amber→coral top→bottom.
    ctx.saveGState()
    ctx.textPosition = origin
    ctx.setTextDrawingMode(.clip)
    CTLineDraw(line, ctx)
    let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [amber.cgColor, coral.cgColor] as CFArray,
        locations: [0.0, 1.0])!
    ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: size / 2, y: origin.y + bounds.maxY),
        end: CGPoint(x: size / 2, y: origin.y + bounds.minY),
        options: [])
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
