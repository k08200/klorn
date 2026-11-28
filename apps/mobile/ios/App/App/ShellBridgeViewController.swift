import Capacitor
import Foundation

/// The app's root view controller (Main.storyboard): Capacitor's own, with a
/// router that serves the bundle the way Cloudflare serves app.klorn.ai
/// (ShellRouteResolver) instead of index.html for every extension-less path.
class ShellBridgeViewController: CAPBridgeViewController {
    override func router() -> Router {
        ShellRouter()
    }
}

/// Capacitor sets `basePath` (the bundle's public/ folder) once the asset
/// handler exists, so the route table is read lazily from there.
final class ShellRouter: Router {
    var basePath: String = "" {
        didSet { rules = nil }
    }

    private var rules: ShellRouteResolver.Rules?
    private let lock = NSLock()

    func route(for path: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        if rules == nil {
            let file = URL(fileURLWithPath: basePath).appendingPathComponent("shell-routes.json")
            // The single-page bundle ships no table: Capacitor's default behaviour.
            rules = ShellRouteResolver.parse(try? Data(contentsOf: file))
        }
        let base = basePath
        let resolved = ShellRouteResolver.resolve(path, rules: rules ?? .empty) { candidate in
            FileManager.default.fileExists(atPath: base + candidate)
        }
        return base + resolved
    }
}
