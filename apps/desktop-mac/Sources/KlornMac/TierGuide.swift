import SwiftUI

// What the lanes mean, in the places someone would ask. The count comes from
// `Tier.coreOrder`, never a literal — see the note by `guide.pipeline` below.
//
// The tier names are the product's core idea and they were never explained
// anywhere in the app: the sidebar showed "Push 3 / Queue 12 / Silent 40 /
// Auto 8" and left the reader to guess. Worse, the guess is usually wrong —
// "Silent" reads as deleted and "Auto" reads as "Klorn replied for me", and
// neither is true.

extension Tier {
    /// One line: what this tier does to your attention.
    var blurb: String {
        switch self {
        case .push: L("tier.push.blurb")
        case .meeting: L("tier.meeting.blurb")
        case .queue: L("tier.queue.blurb")
        case .silent: L("tier.silent.blurb")
        case .info: L("tier.info.blurb")
        case .auto: L("tier.auto.blurb")
        }
    }

    /// What an empty tier means — which is different for each one, and is the
    /// moment someone is most likely to wonder what the tier was for.
    var emptyTitle: String {
        switch self {
        case .push: L("tier.push.empty")
        case .meeting: L("tier.meeting.empty")
        case .queue: L("tier.queue.empty")
        case .silent: L("tier.silent.empty")
        case .info: L("tier.info.empty")
        case .auto: L("tier.auto.empty")
        }
    }

    var emptyIcon: String {
        switch self {
        case .push: "checkmark.shield"
        case .meeting: "calendar"
        case .queue: "tray"
        case .silent: "moon"
        case .info: "archivebox"
        case .auto: "sparkles"
        }
    }
}

/// First-run explainer: what Klorn did to the mailbox, and what the four words
/// in the sidebar mean.
///
/// Shown once, then reachable forever from the sidebar — a one-shot tour that
/// can't be re-opened is a tour that was never really read. Nothing here is
/// dismissible-by-accident: it sits over the full view with an explicit Got it.
struct TierGuide: View {
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(L("guide.title"))
                    .font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Spacer()
                Button(L("guide.done"), action: onClose)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(PrimaryButtonStyle())
            }
            .padding(.bottom, Theme.s2)

            // What the "inbox" column even IS — the founder-reported confusion
            // (2026-08-15) was the name collision: our 수신함/INBOX is the
            // triage RESULT, not the raw Gmail inbox. Say that first.
            // The count comes from coreOrder, not the sentence: the copy said
            // "four tiers" above a list of five from the day MEETING and INFO
            // were added, in all seven languages at once.
            Text(L("guide.pipeline", Tier.coreOrder.count))
                .font(.callout).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Theme.s2)
            Text(L("guide.intro", Tier.coreOrder.count))
                .font(.callout).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Theme.s4)

            VStack(alignment: .leading, spacing: Theme.s3) {
                ForEach(Tier.coreOrder) { tier in
                    HStack(alignment: .top, spacing: Theme.s3) {
                        Circle().fill(Theme.tint(tier))
                            .frame(width: 8, height: 8).padding(.top, 6)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tier.label).font(.body.weight(.semibold))
                                .foregroundStyle(Theme.text)
                            Text(tier.blurb).font(.caption).foregroundStyle(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(tier.label). \(tier.blurb)")
                }
            }

            Divider().overlay(Theme.line).padding(.vertical, Theme.s4)

            Text(L("guide.correcting"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(22)
        .frame(width: 460)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow, radius: 24, y: 8)
    }
}

/// Whether the first-run guide has been shown. Persisted rather than derived:
/// "has this person seen the explanation" is not recoverable from any other
/// state, and showing it twice is as bad as never showing it.
enum GuideSeen {
    private static let key = "klorn.hasSeenTierGuide"

    static var value: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// The guide is for people who have mail to explain. Showing it over an
    /// empty signed-out shell teaches nothing and burns the one first run.
    nonisolated static func shouldPresent(seen: Bool, signedIn: Bool) -> Bool {
        !seen && signedIn
    }
}

/// The connect-time question (founder 2026-08-30): what is this mailbox FOR?
/// One question, three buttons — the answer feeds the analysis prompts, so
/// asking it early is what makes the labeling accurate from day one. "나중에"
/// dismisses permanently; the account section can always set it later.
struct PurposePrompt: View {
    @Environment(AppModel.self) private var model

    /// Step 1 asks what the mailbox is for; step 2 (work / mixed only, and
    /// only while no company domain is declared) asks which email domain is
    /// the company — the fact that turns colleagues into 회사 chips.
    private enum Step { case purpose, domains }
    @State private var step: Step = .purpose
    @State private var domainsText = ""

    private var targetEmail: String? {
        model.purposePromptTarget?.email
            ?? model.inboxes.first(where: { $0.kind == "primary" })?.email
    }

    private func choice(_ purpose: String, _ title: String) -> some View {
        Button(title) {
            let target = model.purposePromptTarget?.id
            Task { await model.setInboxPurpose(inboxId: target, purpose: purpose) }
            if (purpose == "work" || purpose == "mixed"), model.companyDomains.isEmpty {
                withAnimation(.easeOut(duration: 0.15)) { step = .domains }
            } else {
                model.dismissPurposePrompt()
            }
        }
        .buttonStyle(PrimaryButtonStyle())
    }

    /// Names the linked account when the question is about one — "this
    /// mailbox" is ambiguous the moment there are two.
    private var title: String {
        if step == .domains { return L("company.title") }
        if let email = model.purposePromptTarget?.email {
            return L("purpose.title.linked", email)
        }
        return L("purpose.title")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text(title)
                .font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            if step == .purpose {
                purposeStep
            } else {
                domainsStep
            }
        }
        .padding(22)
        .frame(width: 430)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow, radius: 24, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        .onAppear {
            if model.purposePromptStartsAtDomains { step = .domains }
            // The account's own domain is the likely answer — offered, not
            // assumed (a public provider offers nothing).
            domainsText = suggestedCompanyDomain(for: targetEmail) ?? ""
        }
    }

    private var purposeStep: some View {
        Group {
            Text(L("purpose.detail"))
                .font(.callout).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Theme.s2) {
                choice("work", L("purpose.work"))
                choice("personal", L("purpose.personal"))
                choice("mixed", L("purpose.mixed"))
            }
            .padding(.top, Theme.s1)
            Button(L("purpose.later")) { model.dismissPurposePrompt() }
                .buttonStyle(.plain).font(Theme.Typo.label)
                .foregroundStyle(Theme.textDim)
        }
    }

    private var domainsStep: some View {
        Group {
            Text(L("company.detail"))
                .font(.callout).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            TextField(L("company.placeholder"), text: $domainsText)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await save() } }
                .accessibilityLabel(L("company.title"))
            if let error = model.companyDomainsError {
                Text(error).font(.caption).foregroundStyle(Theme.tint(.push))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Theme.s2) {
                Button(L("company.save")) { Task { await save() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(parseCompanyDomainsInput(domainsText).isEmpty)
                Button(L("company.skip")) { model.dismissPurposePrompt() }
                    .buttonStyle(.plain).font(Theme.Typo.label)
                    .foregroundStyle(Theme.textDim)
            }
            .padding(.top, Theme.s1)
        }
    }

    private func save() async {
        let domains = parseCompanyDomainsInput(domainsText)
        guard !domains.isEmpty else { return }
        if await model.setCompanyDomains(domains) {
            model.dismissPurposePrompt()
        }
    }
}

/// The user-facing word for a purpose value (the wire vocabulary is fixed:
/// work | personal | mixed).
func purposeLabel(_ purpose: String) -> String {
    switch purpose {
    case "work": L("purpose.work")
    case "personal": L("purpose.personal")
    default: L("purpose.mixed")
    }
}

/// The pre-OAuth pick (founder 2026-09-01: "로그인 하면서 고르게"): a caption
/// and three capsules bound to `AppModel.pendingPurpose`, applied the moment
/// sign-in lands. Shared by the full sidebar and the expanded panel so the
/// two sign-in entrances ask the same question the same way.
struct PurposePickRow: View {
    @Environment(AppModel.self) private var model
    let horizontalPadding: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L("purpose.loginPick"))
                .font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
            HStack(spacing: 6) {
                ForEach(["work", "personal", "mixed"], id: \.self) { choice in
                    let selected = model.pendingPurpose == choice
                    Button {
                        model.pendingPurpose = selected ? nil : choice
                    } label: {
                        Text(purposeLabel(choice))
                            .font(Theme.Typo.label)
                            .foregroundStyle(selected ? Theme.text : Theme.textDim)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(
                                selected ? Theme.surfaceSelected : Theme.surfaceRaised,
                                in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(purposeLabel(choice))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, 4)
    }
}
