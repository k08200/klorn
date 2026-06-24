import SwiftUI

/// Auth gate: sign-in until we hold a token, the decision queue after.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .signedOut, .signingIn:
                SignInView()
            case .signedIn:
                DecisionQueueView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: model.phase) {
            if model.phase == .signedIn, model.queue == nil {
                await model.loadQueue()
            }
        }
    }
}
