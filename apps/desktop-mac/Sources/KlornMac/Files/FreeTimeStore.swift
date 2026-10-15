import Foundation
import Observation

/// Today's "When is everyone free?" (P12, team mode). Reads
/// GET /api/teams/:id/availability for the next seven days in 30-minute
/// slots and keeps the last answer on screen while "Check again" runs. It
/// creates no event: scheduling stays in the assistant's approval flow.
@MainActor
@Observable
final class FreeTimeStore {
    private let api: APIClient

    private(set) var result: TeamAvailabilityWire?
    private(set) var fetchedAt: Date?
    private(set) var pending = false
    private(set) var failed = false
    /// The team the user picked; nil follows the first saved team.
    var selectedTeamId: String?

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var request = 0

    init(api: APIClient) {
        self.api = api
    }

    /// The picked team when it is still saved, else the first one.
    func teamId(in teams: [TeamWire]) -> String? {
        if let selectedTeamId, teams.contains(where: { $0.id == selectedTeamId }) { return selectedTeamId }
        return teams.first?.id
    }

    /// A different team clears the last answer: it was another team's.
    func select(teamId: String) {
        guard teamId != selectedTeamId else { return }
        selectedTeamId = teamId
        request += 1
        result = nil
        fetchedAt = nil
        failed = false
        pending = false
    }

    func find(teamId: String, now: Date = Date()) async {
        request += 1
        let ticket = request
        let session = generation
        pending = true
        failed = false
        do {
            let answer = try await api.get(
                FreeTimeRules.availabilityPath(teamId: teamId, now: now), as: TeamAvailabilityWire.self)
            guard session == generation, ticket == request else { return }
            result = answer
            fetchedAt = Date()
        } catch {
            guard session == generation, ticket == request else { return }
            Log.app.debug("free time failed: \(String(describing: error), privacy: .private)")
            failed = true
        }
        pending = false
    }

    func reset() {
        generation += 1
        request += 1
        result = nil
        fetchedAt = nil
        pending = false
        failed = false
        selectedTeamId = nil
    }

    var isClean: Bool {
        result == nil && fetchedAt == nil && !pending && !failed && selectedTeamId == nil
    }

    /// Offscreen previews only.
    func seedForRender(result: TeamAvailabilityWire, fetchedAt: Date) {
        self.result = result
        self.fetchedAt = fetchedAt
    }
}
