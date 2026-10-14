import SwiftUI

/// The reading pane: the selected email's content, loaded from GET /api/email/:id.
/// Clicking a row (a plain mouse click, delivered even to the non-focus-stealing
/// panel) loads it here — no need to leave the app for the browser.
/// Internal rather than private so --render-previews can shoot it on its own.
/// The full window is 1400pt wide; on the landing page's 1180px container that
/// scales the app's 13pt body text down to under 7px, which is unreadable. The
/// reading pane alone fits at over 100%.
struct ReadingPane: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// The owning FullView's key zone; `.reader` draws the focus ring.
    var keyZone: MailKeyZone = .list
    /// `.window` in the main window: the type roles, the reader meta line
    /// and the flat primary button. The default is the bar's pane, unchanged.
    var style: ShellStyle = .bar
    private var m: ReadingPaneMetrics { style == .window ? .window : .bar }
    @State private var replying = false
    @State private var replyText = ""
    /// The composer was opened with the ahead-of-time draft (says so above
    /// the editor until the user asks for a fresh one).
    @State private var showingPreparedDraft = false
    @State private var sending = false
    @State private var quickReplies: AppModel.ReplyOptionsFetch?
    @State private var loadingQuickReplies = false

    private var item: FirewallItem? {
        guard let id = model.selectedItemId else { return nil }
        return model.queue?.item(id: id)
    }

    var body: some View {
        Group {
            // Folder rows (Sent/Drafts/Archived) read through the live path —
            // they are not in the local mirror, so the firewall branches below
            // can never serve them. Checked first: selecting a folder row is
            // the more recent intent when both selections exist.
            if model.listMode.showsLiveMessages, let picked = model.selectedMailboxItem {
                if model.mailboxDetailLoading {
                    centered { ProgressView().controlSize(.small) }
                } else if let detail = model.mailboxDetail {
                    mailboxContent(picked, detail)
                } else {
                    centered { EmptyState(icon: "doc.text", title: L("reading.noPreview"), style: style) }
                }
            } else if model.isLoadingEmail {
                centered { ProgressView().controlSize(.small) }
            } else if let err = model.emailError {
                centered { Text(err).font(m.callout).foregroundStyle(Theme.textDim) }
            } else if let email = model.openedEmail {
                content(email)
            } else if model.selectedItemId != nil {
                centered {
                    EmptyState(icon: "doc.text", title: L("reading.noPreview"), style: style)
                }
            } else {
                centered {
                    VStack(spacing: Theme.s4) {
                        // The K mark, quiet — the ring identity is retired
                        // (K monogram everywhere since 0.4.80005).
                        LogoRing(size: 44).opacity(0.45)
                        Text(L("reading.empty.title")).font(m.title3).foregroundStyle(Theme.textDim)
                        Text(L("reading.empty.detail"))
                            .font(m.caption).foregroundStyle(Theme.textDim)
                            .multilineTextAlignment(.center)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Return/o put the keyboard here (M3): show it, like the row's ring.
        .overlay {
            if keyZone == .reader {
                Rectangle().strokeBorder(Theme.accent, lineWidth: 2).allowsHitTesting(false)
            }
        }
        .onChange(of: model.selectedItemId) { _, _ in
            replying = false
            replyText = ""
            showingPreparedDraft = false
            quickReplies = nil
            loadingQuickReplies = false
        }
        // Message ▸ Reply (⌘R) runs the same path as the Reply-with-AI button.
        // Never while composing: a fresh draft would overwrite the user's text.
        .onChange(of: model.replyRequest) { _, request in
            guard let item, MenuRules.shouldStartReply(
                request, selectedItemId: item.id, replying: replying,
                emailLoaded: model.openedEmail != nil)
            else { return }
            startReply(item)
        }
        // Mirror the inline composer so the menu can disable Reply while it is open.
        .onChange(of: replying, initial: true) { _, now in model.readerReplying = now }
        .onDisappear { model.readerReplying = false }
    }

    /// A folder message: subject / counterparty / time, then the body as the
    /// sender designed it. No firewall band — these rows were never
    /// classified, and painting tier chrome on them would claim they were.
    private func mailboxContent(_ item: MailboxItem, _ detail: LiveEmailDetail.Payload)
        -> some View
    {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(detail.subject.isEmpty
                    ? L("mailbox.noSubject") : detail.subject))
                    .font(Theme.Typo.display)
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    let from = senderDisplayName(decodeHTMLEntities(detail.from))
                    let to = senderDisplayName(decodeHTMLEntities(detail.to))
                    Text(L("mailbox.fromTo", from.isEmpty ? detail.from : from,
                           to.isEmpty ? detail.to : to))
                        .font(m.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(detail.receivedAt))
                        .font(m.caption).foregroundStyle(Theme.textDim)
                }
            }
            .padding(m.inset)
            Divider().overlay(Theme.line)
            if let renderHtml = detail.renderHtml, !renderHtml.isEmpty {
                EmailHtmlView(
                    html: renderHtml,
                    // Live folder messages resolve cid: images through the
                    // live route, on the account the row came from.
                    inlineImage: { [gmailId = detail.gmailId, inbox = model.selectedMailboxItem?.inbox] cid in
                        await model.liveInlineImage(gmailId: gmailId, inbox: inbox, cid: cid)
                    },
                    blockRemote: !model.settings.loadRemoteImages)
                    .id(detail.gmailId)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    Text(detail.body.isEmpty ? L("reading.noContent") : detail.body)
                        .font(m.callout)
                        .foregroundStyle(Theme.text)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .frame(maxWidth: 640, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(m.inset)
                }
            }
        }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(email.subject ?? L("mail.noSubjectParen")))
                    .font(Theme.Typo.display)
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    Text(senderDisplayName(email.from.map(decodeHTMLEntities)))
                        .font(m.sender).foregroundStyle(m.senderInk).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(email.date)).font(m.caption).foregroundStyle(Theme.textDim)
                }
                // The facts the row no longer carries (one-badge rule): the
                // lane, then category / relationship / reply state as words.
                if style == .window, let item {
                    ReaderMetaLine(item: item)
                }
                if let item {
                    HStack(spacing: 10) {
                        primaryButton(
                            email.preparedDraft == nil ? L("reading.replyWithAI") : L("reading.openDraft")
                        ) { startReply(item) }
                        // menuIndicator(.hidden) kills the system-blue pull-down
                        // segment (the one off-palette element on this row —
                        // design audit 2026-07-20); a dim chevron in the label
                        // keeps the "this opens a menu" affordance.
                        // Chevron lives INSIDE one Text (concatenation) — a
                        // separate Image in the label gets reordered to the
                        // leading edge by the menu button's label styling
                        // (screen-verified 0.4.80007: "∨ Snooze").
                        if Theme.isRenderingOffscreen {
                            OffscreenMenuLabel(title: L("mail.snoozePrefix"))
                            OffscreenMenuLabel(
                                    title: L("mail.moveTo", item.tier.label,
                                             L10n.josaRoIfKorean(after: item.tier.label)))
                        } else {
                            SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                                Text(L("mail.snoozePrefix"))
                                    + Text(Image(systemName: "chevron.down"))
                                    .font(m.caption2Semibold).foregroundStyle(Theme.textDim)
                            }
                            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                            .menuIndicator(.hidden).fixedSize()
                            TierMenu(
                            item: item, onSetTier: actions.onSetTier,
                            onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
                        ) {
                                Text(L("mail.moveTo", item.tier.label,
                                       L10n.josaRoIfKorean(after: item.tier.label)))
                                    + Text(Image(systemName: "chevron.down"))
                                    .font(m.caption2Semibold).foregroundStyle(Theme.textDim)
                            }
                            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                            .menuIndicator(.hidden).fixedSize()
                        }
                        Button(L("mail.dismiss")) { actions.onDismiss(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(m.inset)
            Divider().overlay(Theme.line)
            klornBand(email)
            if let item, !replying {
                quickReplyStrip(item)
            }
            if let renderHtml = email.renderHtml, !renderHtml.isEmpty {
                // Designed (HTML) mail renders as the sender built it — the
                // webview scrolls itself. Plain mail keeps the text path below.
                // .id ties the webview's lifetime to ONE message: a fresh
                // ephemeral cookie store per email, so tracker cookies set by
                // sender A's pixel never ride along to sender B's mail.
                EmailHtmlView(
                    html: renderHtml,
                    inlineImage: { [emailId = email.id] cid in
                        await model.inlineImage(emailId: emailId, cid: cid)
                    },
                    blockRemote: !model.settings.loadRemoteImages)
                    .id(email.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    // Reading typography: measured line length (~640pt) and open
                    // line spacing — a mail body should read like a document, not
                    // a log dump stretched across the pane.
                    Text(email.text.isEmpty ? L("reading.noContent") : email.text)
                        .font(m.callout)
                        .lineSpacing(4)
                        .foregroundStyle(Theme.text.opacity(0.92))
                        .textSelection(.enabled)
                        .frame(maxWidth: 640, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.s6)
                }
            }
            if replying, let item {
                Divider().overlay(Theme.line)
                replyComposer(item)
            }
        }
    }

    private func replyComposer(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(L("reading.replyTo", senderDisplayName(item.email?.from.map(decodeHTMLEntities))))
                    .font(m.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer()
                if model.isDrafting {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L("reading.drafting")).font(m.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Button {
                        showingPreparedDraft = false
                        Task { if let d = await model.draftReply(item) { replyText = d } }
                    } label: {
                        Label(L("reading.regenerate"), systemImage: "sparkles").font(m.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.accent)
                    .help(L("reading.regenerate.help"))
                }
            }
            if showingPreparedDraft {
                Text(L("reading.preparedDraft"))
                    .font(m.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextEditor(text: $replyText)
                .font(m.callout).foregroundStyle(Theme.text)
                .scrollContentBackground(.hidden)
                .frame(height: 110)
                .padding(Theme.s2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: m.editorRadius))
                .overlay(RoundedRectangle(cornerRadius: m.editorRadius).strokeBorder(Theme.field))
            if let err = model.replyError {
                Text(err).font(m.caption).foregroundStyle(m.warning)
            }
            HStack {
                Spacer()
                Button(L("reading.cancel")) {
                    replying = false
                    replyText = ""
                    showingPreparedDraft = false
                }
                .buttonStyle(.bordered).controlSize(.small)
                primaryButton(sending ? L("reading.sending") : L("reading.send")) { send(item) }
                    .disabled(sending || model.isDrafting || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
    }

    /// Klorn's per-email intelligence: why it landed in this tier, the AI summary
    /// with its key points and action items, and whether it needs a reply.
    /// Always rendered for an opened email — the "AI 정리" button must stay
    /// reachable even before any summary exists (founder, 2026-08-20).
    @ViewBuilder
    private func klornBand(_ email: EmailDetail) -> some View {
        let reason = item?.tierReason
        // COLLAPSED by default (founder 2026-09-01): the analysis was eating
        // the pane and the mail itself was barely visible. The one-line WHY
        // stays always; everything deeper sits behind the chevron, and the
        // choice persists (a reader who wants the full analysis keeps it).
        let expanded = model.settings.readingBandExpanded
        VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) {
                            model.settings.readingBandExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if let item, let reason, !reason.isEmpty {
                                Circle().fill(Theme.tint(item.tier)).frame(width: 7, height: 7)
                                Text(L("mail.whyTier", item.tier.label, reason))
                                    .font(m.caption).foregroundStyle(Theme.textDim)
                                    .lineLimit(expanded ? 2 : 1)
                            } else {
                                Text(L("reading.analysis"))
                                    .font(m.caption).foregroundStyle(Theme.textDim)
                            }
                            Image(systemName: "chevron.down").font(m.caption2)
                                .foregroundStyle(Theme.textDim)
                                .rotationEffect(expanded ? .zero : .degrees(-90))
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(expanded ? L("reading.analysis.collapse") : L("reading.analysis.expand"))
                    .accessibilityLabel(L("reading.analysis"))
                    .accessibilityValue(expanded ? L("a11y.expanded") : L("a11y.collapsed"))
                    Spacer(minLength: 12)
                    // Deep re-read of THIS mail: longer summary, up to 6 key
                    // points, deadlines kept — in the UI language.
                    Button(model.isSummarizing ? L("mail.summarizing") : L("mail.summarize")) {
                        Task { await model.summarizeOpenedEmail() }
                    }
                    .buttonStyle(.plain)
                    .font(m.captionMedium)
                    .foregroundStyle(model.isSummarizing ? Theme.textDim : Theme.accent)
                    .disabled(model.isSummarizing)
                }
                if expanded {
                if model.summarizeFailed {
                    Text(L("mail.summarizeFailed"))
                        .font(m.caption).foregroundStyle(Theme.textDim)
                }
                if let summary = email.summary, !summary.isEmpty {
                    Text(summary).font(m.callout).foregroundStyle(Theme.text.opacity(0.9))
                }
                if let points = email.keyPoints, !points.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        // Position keys: LLM bullets can repeat verbatim, and
                        // duplicate \.self identities break SwiftUI diffing.
                        ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("•").font(m.caption).foregroundStyle(Theme.textDim)
                                    .accessibilityHidden(true)
                                Text(point).font(m.caption).foregroundStyle(Theme.text.opacity(0.85))
                            }
                        }
                    }
                }
                if let actions = email.actionItems, !actions.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Image(systemName: "checkmark.circle").font(m.caption2)
                                    .foregroundStyle(Theme.accent).accessibilityHidden(true)
                                Text(action).font(m.caption).foregroundStyle(Theme.text.opacity(0.85))
                            }
                        }
                    }
                    .accessibilityLabel(L("mail.actionItems"))
                }
                // Signal lines carry their hue on the ICON (and meter) only; the
                // text itself stays dim. Stacked colored text lines (accent blue +
                // engage pink under a red tier dot) made this one band the loudest
                // surface in the app — the hue is the signal, the sentence is not.
                if email.needsReply == true {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.left").font(m.caption2)
                            .foregroundStyle(Theme.accent).accessibilityHidden(true)
                        Text((email.needsReplyReason?.isEmpty == false) ? email.needsReplyReason! : L("reading.needsReply"))
                            .font(m.caption).foregroundStyle(Theme.textDim)
                    }
                }
                // Why this arrived NOW — read from the whole thread, both
                // directions. Sits ABOVE the relationship dossier: the
                // trigger is what the user needs before deciding anything.
                if let brief = model.threadBrief, !brief.whyNow.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "arrow.triangle.branch").font(m.caption2)
                                .foregroundStyle(Theme.accent).accessibilityHidden(true)
                            Text(brief.whyNow).font(m.caption).foregroundStyle(Theme.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let owe = brief.weOwe, !owe.isEmpty {
                            Text(L("thread.weOwe", owe))
                                .font(m.caption2).foregroundStyle(m.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(brief.asks.prefix(2), id: \.self) { ask in
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Text("·").font(m.caption2).foregroundStyle(Theme.textDim)
                                Text(ask).font(m.caption2).foregroundStyle(Theme.textDim)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: m.cardRadius))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(L("thread.brief.a11y", brief.whyNow))
                }
                if let dossier = model.senderDossier, !dossier.summary.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "person.crop.circle").font(m.caption2)
                                .foregroundStyle(Theme.accent).accessibilityHidden(true)
                            Text(dossier.summary).font(m.caption)
                                .foregroundStyle(Theme.textDim).lineLimit(2)
                        }
                        if !dossier.openThreads.isEmpty {
                            Text(L("dossier.inFlight", dossier.openThreads.joined(separator: " · ")))
                                .font(m.caption2).foregroundStyle(Theme.textDim)
                                .padding(.leading, 13).lineLimit(2)
                        }
                        if let promise = dossier.lastPromise, !promise.isEmpty {
                            Text(L("dossier.promise", promise))
                                .font(m.caption2).foregroundStyle(Theme.textDim)
                                .padding(.leading, 13).lineLimit(2)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(L("dossier.a11y"))
                }
                if let context = model.meetingContext, let proposed = context.proposed {
                    meetingContextRows(context, proposed)
                }
                if let engagement = email.engagement, engagement.outboundCount > 0 {
                    // Warm tint mirrors the web graph's "you engage" pink — the
                    // signal Klorn learned from the user's own replies. Pink lives
                    // on the icon and the meter; see the signal-line rule above.
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.turn.up.left").font(m.caption2)
                                .foregroundStyle(Theme.engage)
                            Text(engagement.replyCountLabel).font(m.caption)
                                .foregroundStyle(Theme.textDim)
                        }
                        if engagement.showsImportance {
                            importanceRow(engagement)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(engagement.accessibilityLabel)
                }
                }
            }
        // Same measure as the mail body below: intelligence about a document
        // should not run wider than the document itself.
        .frame(maxWidth: 640, alignment: .leading)
        .padding(.horizontal, m.inset).padding(.vertical, m.bandVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised)
        Divider().overlay(Theme.line)
    }

    /// The meeting ↔ calendar cross-reference: the slot this email proposes,
    /// whether it clashes with the user's real calendar, and what else sits
    /// near it that day. Hue rides the dot only (signal-line rule above); the
    /// verdict word carries the state so it is never color-alone.
    @ViewBuilder
    private func meetingContextRows(
        _ context: MeetingContextWire, _ proposed: MeetingContextWire.Proposed
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "calendar.badge.clock").font(m.caption2)
                    .foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text(L("meeting.proposedSlot", meetingSlotLabel(proposed.startTime, proposed.endTime)))
                    .font(m.caption).foregroundStyle(Theme.textDim)
            }
            HStack(spacing: 6) {
                Circle().fill(meetingVerdictColor(context.conflict))
                    .frame(width: 7, height: 7).accessibilityHidden(true)
                Text(meetingVerdictLabel(context.conflict))
                    .font(m.captionMedium)
                    .foregroundStyle(context.conflict?.hasConflicts == true ? Theme.text : Theme.textDim)
            }
            if let alts = context.alternatives, !alts.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "calendar.badge.checkmark").font(m.caption2)
                        .foregroundStyle(Theme.accent).accessibilityHidden(true)
                    Text(L("meeting.alternatives",
                           alts.prefix(3).map { meetingSlotLabel($0.startTime, $0.endTime) }
                               .joined(separator: " · ")))
                        .font(m.caption).foregroundStyle(Theme.textDim)
                }
            }
            ForEach(context.nearby.prefix(3)) { event in
                Text("\(meetingSlotLabel(event.startTime, event.endTime))  \(event.title)")
                    .font(m.caption2).foregroundStyle(Theme.textDim)
                    .padding(.leading, 13)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func meetingVerdictLabel(_ conflict: MeetingContextWire.Conflict?) -> String {
        guard let conflict else { return L("meeting.slotUnknown") }
        return conflict.hasConflicts ? L("meeting.slotBusy") : L("meeting.slotFree")
    }

    private func meetingVerdictColor(_ conflict: MeetingContextWire.Conflict?) -> Color {
        guard let conflict else { return Theme.textDim }
        return conflict.hasConflicts ? m.danger : m.success
    }

    /// "Wed Aug 13 · 16:00–17:00" in the user's locale/zone, from the wire's
    /// ISO strings. Malformed input degrades to the raw string, never crashes.
    private func meetingSlotLabel(_ startIso: String, _ endIso: String) -> String {
        let iso = ISO8601DateFormatter()
        guard let start = iso.date(from: startIso), let end = iso.date(from: endIso) else {
            return startIso
        }
        let day = DateFormatter()
        day.setLocalizedDateFormatFromTemplate("EdMMM")
        let time = DateFormatter()
        time.setLocalizedDateFormatFromTemplate("HHmm")
        return "\(day.string(from: start)) · \(time.string(from: start))–\(time.string(from: end))"
    }

    /// Slim strength meter for the 0…1 learned importance, with its qualitative
    /// label. Fixed-width capsule (no GeometryReader); a11y is handled by the
    /// parent's combined label so this stays a decorative child.
    @ViewBuilder
    private func importanceRow(_ engagement: EmailDetail.Engagement) -> some View {
        let trackWidth: CGFloat = 64
        HStack(spacing: 7) {
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.engage.opacity(0.22)).frame(width: trackWidth, height: 5)
                Capsule().fill(Theme.engage)
                    .frame(width: max(4, trackWidth * engagement.importanceFill), height: 5)
            }
            Text(engagement.importanceLabel).font(m.caption2).foregroundStyle(Theme.textDim)
        }
        .accessibilityHidden(true)
    }

    /// The three tone-differentiated drafts (accept / decline / info), the same
    /// set the urgent-mail card offers — the reading pane is where mail is
    /// actually read, so it is where answering should be one click, not a
    /// button that starts a wait for a blank composer.
    ///
    /// Choosing one loads it into the composer rather than sending it. On the
    /// card a keystroke sends because the user is triaging one message they are
    /// staring at; here they are reading, and a click that silently sent mail
    /// would be a trapdoor. Approval before action, same as everywhere else.
    @ViewBuilder
    private func quickReplyStrip(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            switch quickReplies {
            case .ready(let options) where !options.options.isEmpty:
                HStack(spacing: Theme.s2) {
                    ForEach(Array(options.options.enumerated()), id: \.offset) { index, option in
                        Button {
                            replying = true
                            replyText = option.body
                        } label: {
                            Text(option.toneLabel).frame(minHeight: 24)
                        }
                        .buttonStyle(.bordered).controlSize(.regular)
                        // The card binds 1/2/3 positionally; mirroring that here
                        // keeps one muscle memory across both surfaces.
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [])
                        .help(option.body)
                        .accessibilityLabel(L("reading.quickReply.a11y", option.toneLabel, option.body))
                    }
                    Spacer()
                }
            case .ready:
                EmptyView()
            case .needsPro:
                Text(L("push.proRequired")).font(m.caption).foregroundStyle(Theme.textDim)
            case .failed(let message):
                HStack(spacing: Theme.s2) {
                    Text(message).font(m.caption).foregroundStyle(m.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L("push.tryAgain")) { loadQuickReplies(item) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            case nil:
                if loadingQuickReplies {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L("push.draftingReplies")).font(m.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    // Not fetched on selection: every load is three LLM
                    // completions, and most mail is read without being answered.
                    Button(L("reading.suggestReplies")) { loadQuickReplies(item) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
        .padding(.horizontal, m.inset).padding(.vertical, m.stripVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
        Divider().overlay(Theme.line)
    }

    private func loadQuickReplies(_ item: FirewallItem) {
        guard !loadingQuickReplies else { return }
        loadingQuickReplies = true
        quickReplies = nil
        Task {
            let result = await model.fetchReplyOptions(item)
            // The user may have moved on while three completions ran; a late
            // result must not paint another email's drafts.
            guard model.selectedItemId == item.id else { return }
            quickReplies = result
            loadingQuickReplies = false
        }
    }

    /// Open the composer and let Klorn's AI draft the reply into it. The user
    /// reviews/edits before Send (approval before action).
    private func startReply(_ item: FirewallItem) {
        replying = true
        // A draft Klorn wrote ahead of time opens at once — no LLM call, no
        // wait. The composer's regenerate button still asks for a fresh one.
        if let opened = model.openedEmail, opened.id == item.email?.emailDbId,
           let prepared = opened.preparedDraft
        {
            replyText = prepared
            showingPreparedDraft = true
            return
        }
        showingPreparedDraft = false
        replyText = ""
        Task {
            if let draft = await model.draftReply(item) { replyText = draft }
        }
    }

    private func send(_ item: FirewallItem) {
        sending = true
        Task {
            let ok = await model.reply(item, body: replyText)
            sending = false
            if ok { replying = false; replyText = ""; showingPreparedDraft = false }
        }
    }

    /// The pane's one primary action: the bar's glow capsule, or the main
    /// window's flat fill (plan §2: no shadow, no lift).
    @ViewBuilder
    private func primaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        if style == .window {
            Button(title, action: action).buttonStyle(SolidButtonStyle(compact: true))
        } else {
            Button(title, action: action).buttonStyle(PrimaryButtonStyle())
        }
    }

    private func centered<Content: View>(@ViewBuilder _ c: () -> Content) -> some View {
        VStack { Spacer(); c(); Spacer() }.frame(maxWidth: .infinity)
    }

    private static func formatDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let iso1 = ISO8601DateFormatter(); iso1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter(); iso2.formatOptions = [.withInternetDateTime]
        guard let date = iso1.date(from: iso) ?? iso2.date(from: iso) else { return "" }
        let out = DateFormatter()
        // Without this the formatter follows the SYSTEM locale, so a user who set
        // the app to English on a Korean Mac still read "7월 29 · 5:12 오후".
        // Follow the app's own resolved language instead.
        out.locale = Locale(identifier: L10n.resolvedCode(override: L10n.override))
        out.dateFormat = "MMM d · h:mm a"
        return out.string(from: date)
    }
}
