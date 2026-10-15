import Foundation

/// App language: follow macOS, or override.
///
/// "System" is the default and the correct behaviour for a Mac app — it reads
/// the user's Preferred Languages list. The override exists because Klorn's
/// users routinely run an English macOS while writing Korean mail, so the OS
/// language is not always the language they want the app in.
enum AppLanguage: String, CaseIterable, Sendable {
    case system
    case english = "en"
    case korean = "ko"
    case japanese = "ja"
    case chinese = "zh"
    case spanish = "es"
    case french = "fr"
    case german = "de"

    /// Shown in its own language — a language picker the user can't read is
    /// useless. "System" is the exception: it names a behaviour, not a language.
    var label: String {
        switch self {
        case .system: return L10n.t("lang.system")
        case .english: return "English"
        case .korean: return "한국어"
        case .japanese: return "日本語"
        case .chinese: return "中文（简体）"
        case .spanish: return "Español"
        case .french: return "Français"
        case .german: return "Deutsch"
        }
    }
}

/// Localized string lookup, honouring the in-app language override.
///
/// SwiftUI's automatic `Text("literal")` localization always resolves against
/// the main bundle's language, which cannot be overridden without a relaunch.
/// Routing every string through `L10n.t` instead lets the override take effect
/// on the next render, and makes the untranslated-string audit a grep.
enum L10n {
    private static let storageKey = "klorn.appLanguage"

    /// Cached so a lookup isn't a bundle search per string per frame.
    private nonisolated(unsafe) static var cachedBundle: Bundle?
    private nonisolated(unsafe) static var cachedCode: String?

    /// The language actually in effect: the override, or the best match between
    /// the user's Preferred Languages and what Klorn ships. Falls back to
    /// English — an unshipped language must degrade to a real translation, not
    /// to raw keys on screen.
    static func resolvedCode(
        override: AppLanguage,
        preferred: [String] = Locale.preferredLanguages,
        available: [String] = L10n.shipped
    ) -> String {
        if override != .system { return override.rawValue }
        for tag in preferred {
            // "ko-KR" / "ko-Hang-KR" → "ko"
            guard let base = tag.split(separator: "-").first.map(String.init) else { continue }
            if available.contains(base) { return base }
        }
        return "en"
    }

    /// Persisted override. Read from UserDefaults rather than AppSettings so a
    /// lookup on a background render path doesn't need the main actor.
    static var override: AppLanguage {
        get {
            AppLanguage(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .system
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: storageKey)
            cachedBundle = nil
            cachedCode = nil
        }
    }

    /// A Locale for the language the UI is actually showing. Date/number
    /// formatting must follow the APP language, not the system locale — the
    /// English UI was stamping Korean month names on every mail row because
    /// mailTimeLabel defaulted to `.current` (render audit 2026-08-26).
    static var activeLocale: Locale {
        Locale(identifier: resolvedCode(override: override))
    }

    private static func bundle() -> Bundle {
        let code = resolvedCode(override: override)
        if let cached = cachedBundle, cachedCode == code { return cached }
        // Bundle.module under SwiftPM, the .app under Xcode — both resolve the
        // same .lproj folders.
        let root = Bundle.module
        let resolved = root.path(forResource: code, ofType: "lproj")
            .flatMap(Bundle.init(path:)) ?? root
        cachedBundle = resolved
        cachedCode = code
        return resolved
    }

    /// Look up `key`. A missing key returns the key itself, which is visible in
    /// the UI on purpose: a silent fallback to English would hide the gap until
    /// a user found it.
    static func t(_ key: String) -> String {
        NSLocalizedString(key, tableName: "Localizable", bundle: bundle(), value: key, comment: "")
    }

    /// Formatted lookup, e.g. "Get v%@".
    static func t(_ key: String, _ args: CVarArg...) -> String {
        String(format: t(key), arguments: args)
    }
}

extension L10n {
    /// Every key defined for a language, for the drift check. Reads the raw
    /// .strings file rather than NSLocalizedString, which cannot enumerate.
    static func keys(forLanguage code: String) -> Set<String> {
        guard let path = Bundle.module.path(forResource: code, ofType: "lproj"),
              let url = Bundle(path: path)?.url(forResource: "Localizable", withExtension: "strings"),
              let dict = NSDictionary(contentsOf: url) as? [String: String]
        else { return [] }
        return Set(dict.keys)
    }

    /// Languages Klorn ships. The picker and the drift check read this, so
    /// adding a translation is one .lproj folder plus one case.
    static let shipped = ["en", "ko", "ja", "zh", "es", "fr", "de"]
}

/// Shorthand so a view reads `L("prefs.done")` rather than `L10n.t("prefs.done")`.
func L(_ key: String) -> String { L10n.t(key) }

func L(_ key: String, _ args: CVarArg...) -> String {
    String(format: L10n.t(key), arguments: args)
}

// MARK: - Korean particles (조사)

/// Korean postpositions agree with the final consonant (받침) of the word they
/// follow, so a fixed string can't be correct for both. The shipped copy used
/// the "%@(으)로" escape hatch, which is a workaround rather than Korean.
///
/// The word in front is user- or server-supplied (a tier name, a search query),
/// so the particle has to be chosen at runtime.
extension L10n {
    /// The 로/으로 particle when the UI is Korean, "" otherwise — so one call
    /// site serves both languages and the English string simply has nothing to
    /// interpolate.
    nonisolated static func josaRoIfKorean(after word: String) -> String {
        resolvedCode(override: override, preferred: Locale.preferredLanguages,
                     available: shipped) == "ko" ? josaRo(after: word) : ""
    }

    /// The 와/과 particle when the UI is Korean, "" otherwise.
    nonisolated static func josaWaIfKorean(after word: String) -> String {
        resolvedCode(override: override, preferred: Locale.preferredLanguages,
                     available: shipped) == "ko" ? josaWa(after: word) : ""
    }

    /// 로 / 으로. A final ㄹ takes 로 (서울로, not 서울으로).
    nonisolated static func josaRo(after word: String) -> String {
        switch finalConsonant(of: word) {
        case .none, .rieul: "로"
        case .some: "으로"
        }
    }

    /// 와 / 과.
    nonisolated static func josaWa(after word: String) -> String {
        finalConsonant(of: word) == .none ? "와" : "과"
    }

    private enum FinalConsonant { case none, rieul, some }

    /// Whether the last character ends in a consonant, judged the way the word
    /// is *spoken*: Hangul decomposes arithmetically, Latin letters and digits
    /// fall back to how their Korean reading ends (3 → 삼, so 으로; 2 → 이, so 로).
    private nonisolated static func finalConsonant(of word: String) -> FinalConsonant {
        guard let last = word.last else { return .none }

        if let scalar = last.unicodeScalars.first,
           (0xAC00...0xD7A3).contains(scalar.value) {
            // (code - 0xAC00) % 28 == 0 means no 받침; 8 is ㄹ.
            let index = (scalar.value - 0xAC00) % 28
            if index == 0 { return .none }
            return index == 8 ? .rieul : .some
        }

        if last.isNumber {
            // Read the digit aloud: 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 end in a
            // consonant; 2 이, 4 사, 5 오, 9 구 do not. 1/7/8 end in ㄹ.
            switch last {
            case "1", "7", "8": return .rieul
            case "0", "3", "6": return .some
            default: return .none
            }
        }

        // Latin: judged by the letter's Korean reading. L/M/N/R end in a
        // consonant sound (엘/엠/엔/알), and L/R end in ㄹ.
        let lower = Character(last.lowercased())
        switch lower {
        case "l", "r": return .rieul
        case "m", "n": return .some
        case "b", "c", "d", "e", "g", "k", "p", "t", "v", "z": return .none
        case "f", "h", "j", "q", "s", "w", "x", "y": return .some
        case "a", "i", "o", "u": return .none
        default: return .none
        }
    }
}
