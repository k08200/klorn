import AppKit
import SwiftUI

// Offscreen shots of P12 (Files and Teams free-time), part of
// `--render-previews`. Demo data only; the views are the shipping ones
// (`MainShell`) on in-memory models. No network.

extension PreviewRender {
    private static let filesJSON = """
    [{"id":"f1","provider":"KLORN","externalId":"k-1","name":"Projects","mimeType":null,"isFolder":true,
      "sizeBytes":null,"modifiedAt":"2026-07-29T07:10:00.000Z","webUrl":null},
     {"id":"f2","provider":"GOOGLE","externalId":"g-2","name":"Q3 board deck","mimeType":"application/vnd.google-apps.presentation",
      "isFolder":false,"sizeBytes":null,"modifiedAt":"2026-07-29T06:40:00.000Z","webUrl":"https://docs.google.com/presentation/d/demo"},
     {"id":"f3","provider":"KLORN","externalId":"k-3","name":"Signed contract - Northwind.pdf","mimeType":"application/pdf",
      "isFolder":false,"sizeBytes":1572864,"modifiedAt":"2026-07-28T16:05:00.000Z","webUrl":null},
     {"id":"f4","provider":"ONEDRIVE","externalId":"o-4","name":"Renewal quote 2027.xlsx","mimeType":null,
      "isFolder":false,"sizeBytes":48230,"modifiedAt":"2026-07-27T11:30:00.000Z","webUrl":"https://onedrive.example/v/demo"},
     {"id":"f5","provider":"GOOGLE","externalId":"g-5","name":"Onboarding design review notes","mimeType":null,
      "isFolder":false,"sizeBytes":18200,"modifiedAt":"2026-07-26T09:00:00.000Z","webUrl":"https://docs.google.com/document/d/demo"},
     {"id":"f6","provider":"KLORN","externalId":"k-6","name":"Offsite travel receipts.zip","mimeType":"application/zip",
      "isFolder":false,"sizeBytes":20971520,"modifiedAt":"2026-07-24T18:20:00.000Z","webUrl":null}]
    """

    private static let freeTimeTeamJSON = """
    {"slots":[
      {"startTime":"2026-07-29T09:00:00.000Z","endTime":"2026-07-29T09:30:00.000Z"},
      {"startTime":"2026-07-29T12:30:00.000Z","endTime":"2026-07-29T13:00:00.000Z"},
      {"startTime":"2026-07-30T01:00:00.000Z","endTime":"2026-07-30T01:30:00.000Z"},
      {"startTime":"2026-07-30T05:30:00.000Z","endTime":"2026-07-30T06:00:00.000Z"},
      {"startTime":"2026-07-31T02:00:00.000Z","endTime":"2026-07-31T02:30:00.000Z"}],
     "checkedMembers":["alex@team.co","jamie@team.co"],
     "unknownMembers":["priya@northwind.io"],
     "timeZone":"Asia/Seoul"}
    """

    private static let freeTimeSelfOnlyJSON = """
    {"slots":[
      {"startTime":"2026-07-29T12:30:00.000Z","endTime":"2026-07-29T13:00:00.000Z"},
      {"startTime":"2026-07-30T01:00:00.000Z","endTime":"2026-07-30T01:30:00.000Z"}],
     "checkedMembers":[],
     "unknownMembers":["alex@team.co","priya@northwind.io"],
     "timeZone":"Asia/Seoul"}
    """

    private static let demoTeams = [
        TeamWire(id: "t1", name: "Core team", members: ["alex@team.co", "jamie@team.co", "priya@northwind.io"]),
    ]

    private static func p12Model(_ base: AppModel, teamMode: Bool) -> AppModel {
        base.seedP12ForRender(flags: ClientFlags(files: true, teamMode: teamMode), teams: demoTeams)
        return base
    }

    static func renderFiles(
        dir: URL, dark: Bool, base: () -> AppModel, actions: ShellActions
    ) -> Bool {
        let size = CGSize(width: 1280, height: 800)
        let date = ISO8601DateFormatter().date(from: "2026-07-29T08:30:00Z") ?? Date()
        let files = (try? JSONDecoder().decode([DriveFileWire].self, from: Data(filesJSON.utf8))) ?? []
        func availability(_ json: String) -> TeamAvailabilityWire? {
            try? JSONDecoder().decode(TeamAvailabilityWire.self, from: Data(json.utf8))
        }
        var ok = !files.isEmpty
        // Built once here, in the function's own (main-actor) scope: a closure
        // created inside the nested `shot` would capture the non-Sendable
        // `actions` from the outer scope, which Swift 6.3's region analysis
        // rejects in release builds (#SendingRisksDataRace).
        let shell = { MainShell(actions: actions, renderDate: date) }
        func shot(_ name: String, teamMode: Bool = true, _ prepare: (AppModel) -> Void) {
            let model = p12Model(base(), teamMode: teamMode)
            prepare(model)
            ok = writeShot(
                name, size: size, align: .top, model: model, dir: dir, dark: dark, shell) && ok
        }

        shot("files") {
            $0.files.seedForRender(files: files, nextCursor: "more")
            $0.navigate(to: .files)
        }
        shot("files-folder") {
            $0.files.seedForRender(
                files: Array(files.suffix(2)),
                trail: [FolderCrumb(id: "f1", externalId: "k-1", name: "Projects"),
                        FolderCrumb(id: "f9", externalId: "k-9", name: "2026")],
                downloadError: (.gone, "Signed contract - Northwind.pdf"))
            $0.navigate(to: .files)
        }
        shot("files-search-empty") {
            $0.files.seedForRender(files: [], query: "invoice 4821")
            $0.navigate(to: .files)
        }
        shot("files-empty") {
            $0.files.seedForRender(files: [])
            $0.navigate(to: .files)
        }
        shot("files-loading") {
            $0.files.seedForRender(files: [], phase: .loading)
            $0.navigate(to: .files)
        }
        shot("files-error") {
            $0.files.seedForRender(files: [], phase: .failed)
            $0.navigate(to: .files)
        }
        // Today with both P12 blocks: recent files and the team's free time.
        shot("today-p12") {
            $0.files.seedForRender(files: files, recent: Array(files.prefix(5)))
            if let result = availability(freeTimeTeamJSON) {
                $0.freeTime.seedForRender(result: result, fetchedAt: date, teamId: "t1")
            }
            $0.navigate(to: .today)
        }
        // No member's calendar visible: the copy says the slots are the user's own.
        shot("today-free-time-self-only", teamMode: true) {
            if let result = availability(freeTimeSelfOnlyJSON) {
                // Fetched 20 minutes before the shot: "Check again" is offered.
                $0.freeTime.seedForRender(
                    result: result, fetchedAt: date.addingTimeInterval(-20 * 60), teamId: "t1")
            }
            $0.files.seedForRender(files: [], recent: [])
            $0.navigate(to: .today)
        }
        return ok
    }
}
