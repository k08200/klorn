import SwiftUI

extension Tier {
    /// The lane's meaning in a few words, for the first-launch explainer.
    /// What the lane is, never something it does: a lane only classifies.
    var onboardingLine: String {
        switch self {
        case .push: L("onboarding.lane.push")
        case .meeting: L("onboarding.lane.meeting")
        case .queue: L("onboarding.lane.queue")
        case .info: L("onboarding.lane.info")
        case .silent: L("onboarding.lane.silent")
        }
    }
}

/// First launch, no account (productization plan §3): what Klorn is in one
/// sentence, the sign-in choices, the five lanes, and what Klorn does with
/// the mail it reads. One calm column; no step-through.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: Theme.s3) {
                LogoRing(size: 40)
                Text("Klorn").font(Theme.Typo.display).foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                Text(L("onboarding.value", OnboardingRules.lanes.count))
                    .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, Theme.s6)

            signIn.padding(.top, Theme.s6)

            LaneExplainer().padding(.top, Theme.s6)

            Spacer(minLength: Theme.s4)

            Text(L("onboarding.privacy"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Theme.s6 + Theme.s2)
        .padding(.bottom, Theme.s6)
        .frame(width: OnboardingRules.size.width, height: OnboardingRules.size.height, alignment: .top)
        .background(Theme.bg)
    }

    @ViewBuilder
    private var signIn: some View {
        if model.phase == .signingIn {
            VStack(spacing: Theme.s2) {
                Text(L("today.signingIn.title")).font(Theme.Typo.head).foregroundStyle(Theme.text)
                Text(L("today.signingIn.detail"))
                    .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L("today.signIn.restart")) { Task { await model.signIn() } }
                    .buttonStyle(SolidButtonStyle(prominent: false))
                    .padding(.top, Theme.s1)
            }
            .frame(maxWidth: .infinity)
        } else {
            SignInButtons(fullWidth: true)
        }
    }
}

/// The five lanes, each with its colour and its meaning, and the one rule
/// people get wrong: a lane sorts mail, it never acts on it.
struct LaneExplainer: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(OnboardingRules.lanes) { tier in
                HStack(alignment: .firstTextBaseline, spacing: Theme.s3) {
                    Circle().fill(Theme.tint(tier)).frame(width: 8, height: 8)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                        .accessibilityHidden(true)
                    Text(tier.label).font(Theme.Typo.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 72, alignment: .leading)
                    Text(tier.onboardingLine).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                        .lineLimit(1).minimumScaleFactor(0.85)
                    Spacer(minLength: 0)
                }
                .frame(height: 32)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(tier.label). \(tier.onboardingLine)")
                if tier != OnboardingRules.lanes.last {
                    Rectangle().fill(Theme.line).frame(height: 1)
                }
            }
            Text(L("onboarding.lanes.note"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.s3)
        }
        .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s3)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}
