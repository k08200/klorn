// Check that a Developer ID provisioning profile authorizes what Klorn.app
// claims, BEFORE the release ships it. A restricted entitlement (Time
// Sensitive notifications) claimed without a matching embedded profile stops
// the app from launching at all (Apple TN3125), so any mismatch fails here.
//
// usage: check-provision-profile <profile.plist> <entitlements.plist> <Info.plist> [signing-cert.der]
//
//   profile.plist       the DECODED profile (`security cms -D -i x.provisionprofile`)
//   entitlements.plist  what the signature claims: the entitlements file before
//                       signing, or `codesign -d --entitlements - --xml` after
//   Info.plist          the bundle's, for CFBundleIdentifier
//   signing-cert.der    optional: the leaf certificate the app is signed with
//                       (`codesign -d --extract-certificates`); it must be one
//                       of the profile's DeveloperCertificates
//
// Prints what it checked (App ID, team: public, they are in every signature)
// and never the profile itself. Exit 0 = authorized, 1 = mismatch, 2 = usage.
import Foundation

let timeSensitiveKey = "com.apple.developer.usernotifications.time-sensitive"
let appIDKey = "com.apple.application-identifier"
let teamKey = "com.apple.developer.team-identifier"
/// Hardened-runtime and sandbox entitlements: claimable without a profile
/// (TN3125 "Entitlements on macOS"), so not in the profile's allowlist.
let unrestrictedPrefix = "com.apple.security."

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("✗ \(message)\n".utf8))
    exit(1)
}

func plist(_ path: String, _ what: String) -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: path) else { fail("\(what) unreadable: \(path)") }
    guard let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        fail("\(what) is not a property-list dictionary: \(path)")
    }
    return dict
}

let args = CommandLine.arguments
guard args.count == 4 || args.count == 5 else {
    FileHandle.standardError.write(Data(
        "usage: check-provision-profile <profile.plist> <entitlements.plist> <Info.plist> [signing-cert.der]\n".utf8))
    exit(2)
}
let profile = plist(args[1], "profile")
let claimed = plist(args[2], "entitlements")
let info = plist(args[3], "Info.plist")

guard let allowed = profile["Entitlements"] as? [String: Any] else { fail("profile has no Entitlements") }
guard let bundleID = info["CFBundleIdentifier"] as? String, !bundleID.isEmpty else {
    fail("Info.plist has no CFBundleIdentifier")
}
guard let team = claimed[teamKey] as? String, !team.isEmpty else { fail("the signature claims no \(teamKey)") }
guard let appID = claimed[appIDKey] as? String else { fail("the signature claims no \(appIDKey)") }

// The App ID is the team plus this bundle's identifier.
guard appID == "\(team).\(bundleID)" else {
    fail("\(appIDKey) \(appID) is not \(team).\(bundleID) (team + CFBundleIdentifier)")
}
guard (profile["TeamIdentifier"] as? [String])?.contains(team) == true else {
    fail("the profile's TeamIdentifier does not include \(team)")
}
// A Developer ID profile applies to every Mac (TN3125). A development
// profile would launch only on its listed devices.
guard profile["ProvisionsAllDevices"] as? Bool == true else {
    fail("not a Developer ID profile (ProvisionsAllDevices is not true)")
}
guard let expires = profile["ExpirationDate"] as? Date, expires > Date() else {
    fail("the profile has expired, or has no ExpirationDate")
}
guard claimed[timeSensitiveKey] as? Bool == true else { fail("the signature does not claim \(timeSensitiveKey)") }

// Every restricted entitlement claimed must be in the profile's allowlist,
// with the same value (TN3125). The three above are among them.
for (key, value) in claimed.sorted(by: { $0.key < $1.key }) where !key.hasPrefix(unrestrictedPrefix) {
    guard let granted = allowed[key] else { fail("\(key) is claimed but not in the profile") }
    guard (granted as AnyObject).isEqual(value) else {
        fail("\(key) is claimed with a value the profile does not grant")
    }
}

if args.count == 5 {
    guard let cert = FileManager.default.contents(atPath: args[4]), !cert.isEmpty else {
        fail("signing certificate unreadable: \(args[4])")
    }
    guard (profile["DeveloperCertificates"] as? [Data])?.contains(cert) == true else {
        fail("the app is signed with a certificate the profile does not list (renewed certificate? regenerate the profile)")
    }
}

let expiry = ISO8601DateFormatter().string(from: expires)
print("✓ profile authorizes \(appID) (team \(team)), \(timeSensitiveKey), Developer ID (all devices), expires \(expiry)")
print(args.count == 5 ? "✓ signing certificate is listed in the profile" : "· signing certificate not checked (no cert given)")
