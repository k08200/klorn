import AppKit
import Foundation

// Self-check for the design detail pass (2026-10-16, audit M1–M5, X1/X2),
// run by `KlornMac --self-check`. Pure rules and string tables; the chip
// spec constants are pinned in SelfCheckTokens.

/// Every detail-pass check, as (name, passed).
@MainActor
func detailPassSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    print("Design detail pass (M1–M5, X1/X2):")
    var results: [(String, Bool)] = []
    func text(_ relativePath: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(relativePath), encoding: .utf8))
            ?? ""
    }
    func table(_ lang: String) -> [String: String] {
        let url = sourceDir.appendingPathComponent("Resources/\(lang).lproj/Localizable.strings")
        return (NSDictionary(contentsOf: url) as? [String: String]) ?? [:]
    }
    let langs = ["en", "ko", "ja", "zh", "es", "fr", "de"]
    let tables = Dictionary(uniqueKeysWithValues: langs.map { ($0, table($0)) })

    // M1: the move menu never names the lane the mail is in.
    results.append((
        "the move menu label never names the current lane",
        Tier.allCases.allSatisfy { tier in
            !ReaderActionRules.moveLabel(current: tier).localizedCaseInsensitiveContains(tier.label)
        }))
    results.append((
        "the move menu says 'Move to lane' / '레인 옮기기' in every language",
        tables["en"]?["mail.moveToLane"] == "Move to lane"
            && tables["ko"]?["mail.moveToLane"] == "레인 옮기기"
            && langs.allSatisfy { tables[$0]?["mail.moveToLane"]?.isEmpty == false }
            && langs.allSatisfy { tables[$0]?["mail.moveTo"] == nil }))
    let reader = text("Mail/ReadingPane.swift")
    results.append((
        "the reader has one button system: .borderedProminent primary, .bordered rest",
        reader.contains(".buttonStyle(.borderedProminent).tint(Theme.accentSolid)")
            && reader.contains("Text(title).fontWeight(.semibold).foregroundStyle(Theme.onAccentSolid)")
            && !reader.contains("SolidButtonStyle(compact: true)")
            && !reader.contains("caption2Semibold).foregroundStyle(Theme.textDim)\n                            }\n                            .menuStyle")))

    // M2: subject 2 lines, summary 3, both allowed to wrap.
    results.append((
        "reader subject wraps to 2 lines and the summary to 3",
        ReaderActionRules.subjectLines == 2 && ReaderActionRules.summaryLines == 3
            && reader.contains(".lineLimit(ReaderActionRules.subjectLines)")
            && reader.contains(".lineLimit(ReaderActionRules.summaryLines)")))

    // M3: tool names in the UI language, never the identifier.
    let koTools = ToolLabels.known.map { tables["ko"]?["tool.label.\($0)"] ?? "" }
    results.append((
        "every known tool has a label in all 7 languages",
        ToolLabels.known.union(["unknown"]).allSatisfy { tool in
            langs.allSatisfy { tables[$0]?["tool.label.\(tool)"]?.isEmpty == false }
        }))
    results.append((
        "Korean tool labels carry no Latin letters",
        koTools.allSatisfy { label in !label.isEmpty && !label.contains(where: { $0.isASCII && $0.isLetter }) }))
    results.append((
        "server spellings resolve to the same label",
        ToolLabels.key(for: "create_calendar_event") == "tool.label.create_event"
            && ToolLabels.key(for: "send_email") == "tool.label.send_email"
            && ToolLabels.key(for: "frobnicate") == nil
            && ToolLabels.title(for: "frobnicate_widget") == "Frobnicate Widget"))
    results.append((
        "sign-in failures and a timeout are localized, not URLSession's sentence",
        ["auth.failed.nonce", "auth.failed.invalidNonce", "auth.failed.expired",
         "auth.failed.timeout", "auth.failed.cancelled", "error.timeout"].allSatisfy { key in
            langs.allSatisfy { tables[$0]?[key]?.isEmpty == false }
                && tables["ko"]?[key]?.contains(where: \.isHangul) == true
        }
            && AppModel.describe(APIError.transport("The request timed out.", code: URLError.Code.timedOut.rawValue))
                == L("error.timeout")
            && !text("AppModel.swift").contains("\"Sign-in was cancelled.\"")))

    // M4: approve is primary, reject secondary, the consequence in 12pt.
    let send = PendingActionsResponse.Action(
        id: "a", toolName: "send_email", targetLabel: nil, reasoning: nil, createdAt: nil)
    let event = PendingActionsResponse.Action(
        id: "b", toolName: "create_event", targetLabel: nil, reasoning: nil, createdAt: nil)
    let proposals = text("ProposalsList.swift")
    results.append((
        "approval: approve prominent in accentSolid, reject bordered, 12pt consequence",
        proposals.contains(".buttonStyle(.borderedProminent).tint(Theme.accentSolid)")
            && proposals.contains(".foregroundStyle(Theme.onAccentSolid)")
            && proposals.contains("Button(L(\"proposals.decline\"), action: onDecline)\n                    .buttonStyle(.bordered)")
            && ProposalRules.captionSize == 12
            && ProposalRules.consequence(send) == L("proposals.sendsNow")
            && ProposalRules.consequence(event) == L("proposals.runsNow")
            && ProposalRules.approveTitle(send) == L("proposals.approveSend")))

    // M5: provider buttons and Files.
    results.append((
        "Google is white with the four-colour G; Apple is black with apple.logo",
        ProviderButtonSpec.googleFillLight == Theme.hex(0xFFFFFF)
            && GoogleGMark.brandColors == [0x4285F4, 0x34A853, 0xFBBC05, 0xEA4335]
            && ProviderButtonSpec.appleFillLight == Theme.hex(0x000000)
            && ProviderButtonSpec.appleSymbol == "apple.logo"
            && text("Shared/SurfaceState.swift").contains("GoogleProviderButtonStyle")
            && text("Shared/SurfaceState.swift").contains("AppleProviderButtonStyle")))
    func file(_ name: String, mime: String? = nil, folder: Bool = false) -> DriveFileWire {
        DriveFileWire(
            id: name, provider: "KLORN", externalId: name, name: name, mimeType: mime,
            isFolder: folder, sizeBytes: nil, modifiedAt: "2026-10-16T00:00:00Z", webUrl: nil)
    }
    results.append((
        "files: a glyph per kind (pdf, sheet, image, folder, other)",
        FilesRules.icon(for: file("a.pdf")) == "doc.richtext"
            && FilesRules.icon(for: file("b.xlsx")) == "tablecells"
            && FilesRules.icon(for: file("c", mime: "application/vnd.google-apps.spreadsheet")) == "tablecells"
            && FilesRules.icon(for: file("d.HEIC")) == "photo"
            && FilesRules.icon(for: file("e", mime: "image/png")) == "photo"
            && FilesRules.icon(for: file("Projects", folder: true)) == "folder"
            && FilesRules.icon(for: file("notes.txt")) == "doc"))
    results.append((
        "files: K / G / O source badges, never @ for a known drive",
        sourceMonogram(provider: "KLORN") == "K" && sourceMonogram(provider: "GOOGLE") == "G"
            && sourceMonogram(provider: "ONEDRIVE") == "O" && sourceName(provider: "ONEDRIVE") == "OneDrive"))
    results.append((
        "files: a 20pt trailing inset on the list",
        FilesRules.trailingInset == 20
            && text("Files/FilesSection.swift").contains(".padding(.trailing, FilesRules.trailingInset)")))

    // X2: one blue for text, links, selection and the floating button.
    let sky: Theme.RGBA = Theme.hex(0x0EA5E9)
    func same(_ a: Theme.RGBA, _ b: Theme.RGBA) -> Bool {
        abs(a.r - b.r) < 0.01 && abs(a.g - b.g) < 0.01 && abs(a.b - b.b) < 0.01
    }
    results.append((
        "accent is #0369A1 / #38BDF8; #0EA5E9 is gone from text, links and selection",
        same(Theme.accentSolidLight, Theme.hex(0x0369A1)) && same(Theme.accentSolidDark, Theme.hex(0x38BDF8))
            && same(Theme.accentComponents, Theme.accentSolidLight) && !same(Theme.accentComponents, sky)
            && !text("Theme.swift").contains("0.055, green: 0.647")
            && text("Assistant/AssistantDock.swift").contains(".background(Theme.accentSolid, in: Circle())")))

    // States: one anchor, a skeleton shaped like the day, the rail kept on error.
    let today = text("Today/TodayScreen.swift")
    results.append((
        "Today states anchor at top + 96, the skeleton has lanes and a rail, the error keeps the rail",
        TodayLayout.stateAnchorTop == 96
            && TodayLayout.skeletonLanes.map(\.tier) == [.push, .meeting, .queue]
            && today.contains("columns { TodaySkeleton() }")
            && today.contains("TodayRailSkeleton()")
            && today.contains("case .offline, .failed:\n                // The error replaces the lanes")
            && text("Shared/SurfaceState.swift").contains(".padding(.top, anchorInset)")))
    return results
}
