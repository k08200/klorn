import SwiftUI

/// The decision queue — open AttentionItems grouped by tier (GET
/// /api/inbox/firewall). Loud first (PUSH), quiet last (AUTO).
struct DecisionQueueView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line)
            content
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Decision Queue").font(.title2.weight(.semibold))
            Spacer()
            if let summary = model.queue?.summary {
                ForEach(Tier.displayOrder) { tier in
                    TierBadge(tier: tier, count: summary.count(for: tier))
                }
            }
            Button { Task { await model.loadQueue() } } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .disabled(model.isLoadingQueue)
            Button("Sign out") { model.signOut() }
                .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding()
    }

    @ViewBuilder private var content: some View {
        if model.isLoadingQueue && model.queue == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = model.loadError, model.queue == nil {
            VStack(spacing: 8) {
                Text("Couldn't load the queue").font(.headline)
                Text(err).font(.footnote).foregroundStyle(.secondary)
                Button("Retry") { Task { await model.loadQueue() } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if (model.queue?.summary.total ?? 0) == 0 {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(.green)
                Text("Inbox clear — nothing needs a decision.").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(Tier.displayOrder) { tier in
                    let items = model.queue?.items(for: tier) ?? []
                    if !items.isEmpty {
                        Section(tier.label.uppercased()) {
                            ForEach(items) { FirewallRow(item: $0) }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
        }
    }
}
