import AppKit
import SwiftUI

/// Where the floating panel sits: top right of the content area, below the
/// title bar (the container is the shell's safe area, which excludes it),
/// 420pt wide or the container minus its margins, whichever is smaller, so
/// it never clips at any window width. Pure, pinned by the self-check.
enum NotificationPanelGeometry {
    static let preferredWidth: CGFloat = 420
    static let maxHeight: CGFloat = 640
    static let top: CGFloat = Theme.s2
    static let margin: CGFloat = Theme.s3

    static func frame(in container: CGSize) -> CGRect {
        let width = max(0, min(preferredWidth, container.width - 2 * margin))
        let height = max(0, min(maxHeight, container.height - top - margin))
        return CGRect(x: max(0, container.width - margin - width), y: top, width: width, height: height)
    }
}

/// The footer's "Alerts reach you on" line, from the channel health read.
enum NotificationChannelRules {
    enum State: Equatable { case ok, attention, off }

    struct Channel: Equatable {
        let name: String
        let status: String
        let state: State
    }

    /// This Mac app first (it is running: it is drawing this), then the
    /// Windows app, the browser, the phone and Telegram as the server knows
    /// them. Without a health answer only this app is listed.
    static func channels(_ health: AlertChannelHealth?) -> [Channel] {
        var out = [Channel(name: L("nc.channel.macApp"), status: L("nc.channel.running"), state: .ok)]
        guard let health else { return out }
        if let windows = health.desktop.first(where: { $0.app == "windows" }) {
            out.append(Channel(
                name: L("nc.channel.windowsApp"),
                status: L(windows.running ? "nc.channel.running" : "nc.channel.notRunning"),
                state: windows.running ? .ok : .off))
        }
        switch health.webPushState {
        case "live": out.append(Channel(name: L("nc.channel.browser"), status: L("nc.channel.ok"), state: .ok))
        case "stale":
            out.append(Channel(name: L("nc.channel.browser"), status: L("nc.channel.stale"), state: .attention))
        case "needs_resubscribe":
            out.append(Channel(
                name: L("nc.channel.browser"), status: L("nc.channel.resubscribe"), state: .attention))
        default: break
        }
        out.append(Channel(
            name: L("nc.channel.phone"),
            status: L(health.mobileRegistered ? "nc.channel.connected" : "nc.channel.notConnected"),
            state: health.mobileRegistered ? .ok : .off))
        if health.telegramLinked {
            out.append(Channel(name: "Telegram", status: L("nc.channel.connected"), state: .ok))
        }
        return out
    }
}

/// The panel layer over the shell: a click-catcher that closes the panel on
/// any click outside it, and the panel at `NotificationPanelGeometry`. It
/// overlays whatever is beside it (the assistant panel included) without
/// taking part in the layout. Esc closes it too (`MainWindowController`).
struct NotificationPanelLayer: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions

    var body: some View {
        GeometryReader { proxy in
            let rect = NotificationPanelGeometry.frame(in: proxy.size)
            ZStack(alignment: .topLeading) {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { model.notificationCenter.panelOpen = false }
                    .accessibilityHidden(true)
                NotificationPanel(actions: actions)
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
            }
        }
    }
}

/// The floating notification panel (NC2-A): header, the five groups, the
/// "Alerts reach you on" strip.
struct NotificationPanel: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions
    /// Render seam: the fixture clock in offscreen shots.
    var now: Date = MailClock.now(renderingOffscreen: Theme.isRenderingOffscreen)

    private var store: NotificationCenterStore { model.notificationCenter }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline)
            // Overflow is cut at the bottom, never pushes the header out.
            // (Color.clear takes exactly the space left; the list sits in it.)
            Color.clear.overlay(alignment: .top) { content }.clipped()
            footer
        }
        .background(Theme.todayRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.contentCard))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.contentCard))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.contentCard).strokeBorder(Theme.todayLine))
        .shadow(color: Theme.todayCardShadow, radius: ShellChrome.shadowRadius, y: ShellChrome.shadowY)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("nc.title"))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            Text(L("nc.title")).font(Theme.Typo.head).foregroundStyle(Theme.todayInk1)
                .accessibilityAddTraits(.isHeader)
            Text(L("nc.unread", store.badgeCount)).font(Theme.Typo.meta).foregroundStyle(Theme.todayInk3)
                .lineLimit(1)
            // Only when the server sent a budget (v3 users with a daily limit).
            if let budget = store.budget {
                Text(L("nc.budget", budget.used, budget.limit)).font(Theme.Typo.meta)
                    .foregroundStyle(Theme.todayInk3).lineLimit(1)
            }
            Spacer(minLength: Theme.s2)
            Button { Task { await store.markAllRead() } } label: {
                Text(L("nc.markAllRead")).font(Theme.Typo.label)
                    .foregroundStyle(store.hasUnread ? Theme.accent : Theme.todayInk3)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!store.hasUnread)
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s3)
    }

    @ViewBuilder
    private var content: some View {
        let groups = NotificationFeedRules.grouped(store.rows)
        if groups.isEmpty {
            state(store.phase == .failed ? L("nc.failed") : store.phase == .loading ? L("nc.loading") : L("nc.empty"))
        } else {
            OffscreenFriendlyScroll {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(groups, id: \.group) { entry in
                        Text(L("nc.group.count", L(entry.group.titleKey), entry.rows.count))
                            .font(Theme.Typo.todayCaps).tracking(TodayTracking.kicker)
                            .foregroundStyle(Theme.todayInk3)
                            .padding(.horizontal, Theme.s4)
                            .padding(.top, Theme.s3).padding(.bottom, Theme.s1)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(entry.rows) { row in
                            Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline)
                            NotificationRow(row: row, group: entry.group, now: now, actions: actions)
                        }
                    }
                }
                .padding(.bottom, Theme.s2)
            }
        }
    }

    private func state(_ text: String) -> some View {
        VStack(spacing: Theme.s3) {
            Text(text).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
                .multilineTextAlignment(.center)
            if store.phase == .failed {
                Button { Task { await store.refresh() } } label: {
                    Text(L("nc.retry")).font(Theme.Typo.label).foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(Theme.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The channels never truncate: when the title and every channel do
    /// not fit one line, the title goes first, then the channels wrap to a
    /// second line.
    private var footer: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s3) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.s2) { footerTitle; channelList }
                HStack(spacing: Theme.s2) { channelList }
                VStack(alignment: .leading, spacing: Theme.s1) { channelList }
            }
            Spacer(minLength: Theme.s2)
            Button(action: openSettings) {
                Text(L("nc.channels.settings")).font(Theme.Typo.label).foregroundStyle(Theme.accent)
                    .lineLimit(1).fixedSize()
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s3)
        .background(Theme.todayChip)
        .overlay(alignment: .top) { Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline) }
    }

    private var footerTitle: some View {
        Text(L("nc.channels.title")).font(Theme.Typo.label).foregroundStyle(Theme.todayInk2)
            .lineLimit(1).fixedSize()
    }

    private var channelList: some View {
        ForEach(NotificationChannelRules.channels(store.channels), id: \.name) { channel in
            HStack(spacing: Theme.s1) {
                Circle().fill(color(channel.state)).frame(width: Theme.s2, height: Theme.s2)
                    .accessibilityHidden(true)
                Text(channel.name).foregroundStyle(Theme.todayInk2)
                Text(channel.status).foregroundStyle(Theme.todayInk3)
            }
            .font(Theme.Typo.meta).lineLimit(1).fixedSize()
            .accessibilityElement(children: .combine)
        }
    }

    private func color(_ state: NotificationChannelRules.State) -> Color {
        switch state {
        case .ok: Theme.success
        case .attention: Theme.warning
        case .off: Theme.todayInk3
        }
    }

    /// Settings ▸ Notifications.
    private func openSettings() {
        UserDefaults.standard.set(SettingsTab.notifications.rawValue, forKey: SettingsTab.storageKey)
        store.panelOpen = false
        actions.onOpenPreferences()
    }
}
