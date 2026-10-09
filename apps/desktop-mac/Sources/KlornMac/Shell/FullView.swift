import SwiftUI

// MARK: - Full ("real app" window)

/// The largest state: a tier sidebar + a big scrollable list of the selected
/// tier — a real desktop-app view of the whole firewall.
/// What the full view's list column shows: a firewall tier, commitments, or
/// the assistant chat.
/// The full view's sidebar is one of two levels (mail-first shell
/// 2026-08-26): the root feature nav, or the mail client's own sidebar.
enum SidebarLevel: Equatable { case root, mail }

/// Modes whose selected row is a LIVE Gmail message (not in the local
/// mirror) — the reading pane must take the folder path for them.
extension ListMode {
    var showsLiveMessages: Bool {
        if case .mailbox = self { return true }
        return self == .waitingOn
    }
}

enum ListMode: Equatable, Hashable {
    /// The whole inbox as one chronological list — the default view. Lanes
    /// ride on the rows as chips and remain reachable behind the 레인 group.
    case inbox
    /// The inbox narrowed to one label category (what the mail IS — the
    /// sidebar's 카테고리 since 2026-08-27).
    case label(LabelFilter)
    case tier(Tier)
    /// A standard mail folder — Sent / Drafts / Archived (shell restructure
    /// 2026-08-26: every client in the reference set has these; a triage app
    /// without them doesn't read as "my mail, organized").
    case mailbox(MailboxKind)
    /// Mail I sent that nobody answered (2026-09-18) — the other half of
    /// the reply axis. Rows open through the live folder path.
    case waitingOn
    case commitments
    /// Actions Klorn wants approved. Approving these used to require the web
    /// app, which is what kept the agent receipt linking out of Klorn.
    case proposals
    /// The week as a first-class screen. The sidebar's TODAY/UPCOMING crumbs
    /// stay, but "what does my week look like" deserves the list column
    /// (founder, 2026-08-13: the calendar existed, it just wasn't visible).
    case calendar
    /// Team mode's dedicated screen (founder 2026-08-20: a paid mode must
    /// not live in a settings corner) — teams, whole-team availability, and
    /// booking. Rendered only while the server grants team mode.
    case teams

    /// Whether the destination lives on the sidebar's mail level (folders,
    /// lanes, categories) rather than the root feature nav.
    var isMailFamily: Bool {
        switch self {
        case .inbox, .label, .tier, .mailbox, .waitingOn: true
        case .commitments, .proposals, .calendar, .teams: false
        }
    }

    /// The list column modes that carry the whole-mailbox search field
    /// (FullList.tierList) — where Find (⌘F) can land.
    var hasSearchField: Bool {
        switch self {
        case .inbox, .tier, .label: true
        default: false
        }
    }
}

struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// Which pane this window's list keys address (M3). Per FullView, so
    /// the bar's panel and the main window never reset each other.
    @State private var keyZone: MailKeyZone = .list

    var body: some View {
        // The list mode lives on the model, not in @State: opening the full
        // view from somewhere else — a tier count in the compact panel, an
        // urgent-mail card — has to be able to say which tier to land on.
        @Bindable var model = model

        // .top: if the content's minimum ever exceeds the window again, the
        // overflow must clip at the BOTTOM — a centered ZStack ate the header
        // first (clipping screenshots, 2026-08-20).
        ZStack(alignment: .top) {
            // Sky stays BEHIND the surface only as depth for the 10%
            // translucency — it must never show as a margin. The old "card
            // lifted off the sky" inset read as a thick bright frame around
            // the dark panel (founder, 2026-08-22: "테두리 그대로 있는데?")
            // — content now runs edge-to-edge like every serious mail client.
            AmbientBackdrop()
            VStack(spacing: 0) {
                header
                Rectangle().fill(Theme.line).frame(height: 1)
                // Loaded mail whose refresh is failing says so, with a retry
                // (M6); it used to say nothing at all.
                if let notice = model.connectionNotice { ConnectionBanner(notice: notice) }
                HStack(spacing: 0) {
                    FullSidebar(selected: $model.listMode, actions: actions).frame(width: 220)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    if SurfaceStateRules.isBlocking(model.surfaceState) {
                        // Signed out, signing in, offline or failed (M6): its
                        // own view. The list's "sorting" skeleton is for
                        // loading only.
                        SurfaceStateView(state: model.surfaceState)
                    } else {
                        FullList(mode: model.listMode, actions: actions, keyZone: $keyZone)
                            .frame(width: 420)
                        Rectangle().fill(Theme.line).frame(width: 1)
                        ReadingPane(actions: actions, keyZone: keyZone).frame(maxWidth: .infinity)
                    }
                }
                // Any new selection (click, key, card) starts in the list.
                .onChange(of: model.selectedItemId) { _, _ in keyZone = .list }
            }
            // ONE surface, header included — any band around the header reads
            // as chrome-on-chrome.
            .background(Theme.panelGradient(opacity: 0.90))
            // Modal overlays block POINTER input with the scrim, but Tab/
            // VoiceOver traversal follows the view tree — disable the
            // background so keyboard focus can't wander behind the modal.
            .disabled(model.showCompose || model.showTierGuide)
            .onAppear {
                model.presentTierGuideIfFirstRun()
                model.presentPurposePromptIfNeeded()
            }
            // The dock rides above the columns but BELOW the modal overlays:
            // a modal is something the user just asked for.
            if model.phase == .signedIn && !model.showCompose && !model.showTierGuide {
                AssistantDock()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
            FullViewModals()
        }
        // Fill whatever frame the controller fitted to the screen (and the
        // user's drag-resize); the old fixed 1400×860 clipped on smaller
        // displays instead of compressing.
        .frame(
            minWidth: TopBarMetrics.fullMin.width, maxWidth: .infinity,
            minHeight: TopBarMetrics.fullMin.height, maxHeight: .infinity)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Button(action: actions.onRestore) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.right.and.arrow.up.left").font(.callout).accessibilityHidden(true)
                    Text(L("bar.smaller")).font(.callout)
                }
            }
            .buttonStyle(.plain).hoverDim()
            .help(L("bar.smaller.help"))
            // The old "—" (collapse-to-rest) duplicated the header ✕ — gone.

            Spacer()
            HStack(spacing: 8) {
                LogoRing(size: 20)
                Text("Klorn").font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)
            }
            Spacer()

            // Sign-out lives in the sidebar's account area, not here — one
            // way out per surface, and never beside the ✕. Log In stays: it is
            // the whole point of the header when signed out.
            if model.phase == .signedOut {
                Button(L("auth.logIn"), action: actions.onSignIn)
                    .buttonStyle(PrimaryButtonStyle())
            }

            AppearanceToggle()

            // One click OUT from anywhere (dogfood 2026-07-20).
            Button(action: actions.onClose) {
                Image(systemName: "xmark").font(.callout.weight(.semibold)).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .padding(.leading, 6)
            .help(L("bar.close"))
            .accessibilityLabel(L("bar.close.a11y"))
        }
        // A plain row of the ONE window surface — no capsule, no stroke, no
        // shadow. The old floating-pill header was chrome-on-chrome once the
        // content went edge-to-edge (its ground is now the same panelGradient,
        // so the slate-500 contrast argument holds unchanged).
        .padding(.horizontal, 18)
        .frame(height: 48)
    }
}

/// The full view's modal layer: compose, the connect-time question, the
/// event editor and the lane guide, each over its own scrim. Shared by the
/// bar's full view and the main window so a modal behaves the same in both.
struct FullViewModals: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.showCompose {
            Theme.text.opacity(0.45)
                .onTapGesture { if !model.composeSending { model.showCompose = false } }
                .accessibilityHidden(true)
            ComposePanel()
        }
        // Preferences moved to the Settings window (M0, 2026-10-02).
        // The connect-time purpose question — below the guide in
        // priority (the user must read that first).
        if model.showPurposePrompt && !model.showTierGuide
            && !model.showCompose
        {
            Theme.text.opacity(0.45)
                .onTapGesture { model.dismissPurposePrompt() }
                .accessibilityHidden(true)
            PurposePrompt()
        }
        // Event editor (2026-09-11) — a user action opened it, so it sits
        // above the connect-time question.
        if model.showEventEditor {
            Theme.text.opacity(0.45)
                .onTapGesture { model.dismissEventEditor() }
                .accessibilityHidden(true)
            CalendarEventEditor()
        }
        if model.showTierGuide {
            Theme.text.opacity(0.45)
                .onTapGesture { model.dismissTierGuide() }
                .accessibilityHidden(true)
            TierGuide { model.dismissTierGuide() }
        }
    }
}
