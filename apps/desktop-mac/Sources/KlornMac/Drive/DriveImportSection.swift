import SwiftUI

/// Settings › Accounts › Klorn Drive (step D7). One button opens the file picker;
/// what the user picks there is uploaded once, and nothing else is. Shows the
/// progress with a Cancel button while an import runs, and afterwards what was
/// uploaded and what was not, with the reason. Drawn only while the server has
/// the Klorn drive (its dark 404 hides the section).
struct DriveImportSection: View {
    let importer: DriveImporter

    /// Rows of the not-uploaded list shown before "and N more".
    static let maxListedItems = 8

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            Text(L("driveImport.detail"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let limits = importer.limits {
                limitsLine(limits)
            }
            HStack(spacing: Theme.s2) {
                Button(L("driveImport.button")) { Task { await importer.chooseAndImport() } }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(!importer.canImport)
                if importer.isRunning {
                    Button(L("driveImport.cancel")) { importer.cancel() }
                        .buttonStyle(.borderless).controlSize(.small)
                }
            }
            if importer.isRunning {
                progressView
            } else if let report = importer.report {
                reportView(report)
            }
        }
    }

    @ViewBuilder
    private func limitsLine(_ limits: DriveLimitsWire) -> some View {
        if let quota = limits.quotaBytes {
            Text(L("driveImport.usage", Self.bytes(limits.usedBytes), Self.bytes(quota)))
                .font(.caption).foregroundStyle(Theme.textDim)
        } else {
            Text(L("driveImport.error.notConfigured"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var progressView: some View {
        let progress = importer.progress
        return VStack(alignment: .leading, spacing: Theme.s1) {
            ProgressView(value: importer.phase == .uploading ? progress.fraction : 0)
                .progressViewStyle(.linear).tint(Theme.accent)
            Text(importer.phase == .uploading
                 ? L("driveImport.progress", progress.doneFiles, progress.totalFiles)
                 : L("driveImport.preparing"))
                .font(.caption).foregroundStyle(Theme.textDim).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }

    private func reportView(_ report: DriveImportReport) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            ForEach(Self.summaryLines(report, maxFileBytes: importer.maxFileBytes), id: \.self) { line in
                Text(line).font(.caption).foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(report.notUploaded.prefix(Self.maxListedItems).enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                    Text(item.name).lineLimit(1).truncationMode(.middle).foregroundStyle(Theme.text)
                    Spacer(minLength: Theme.s2)
                    Text(DriveImportRules.message(item.reason, maxFileBytes: importer.maxFileBytes))
                        .foregroundStyle(Theme.textDim).multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .accessibilityElement(children: .combine)
            }
            if report.notUploaded.count > Self.maxListedItems {
                Text(L("driveImport.more", report.notUploaded.count - Self.maxListedItems))
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            Button(L("driveImport.clear")) { importer.clearReport() }
                .buttonStyle(.borderless).controlSize(.small)
        }
    }

    /// The report's headline lines, in order: the count, why it stopped, the caps. Pure for the harness.
    static func summaryLines(_ report: DriveImportReport, maxFileBytes: Int64) -> [String] {
        var lines: [String] = []
        let missed = report.notUploaded.count
        lines.append(missed == 0
            ? L("driveImport.summary.all", report.uploaded)
            : L("driveImport.summary", report.uploaded, missed))
        if report.cancelled { lines.append(L("driveImport.cancelled")) }
        if let stop = report.stoppedBy { lines.append(DriveImportRules.message(stop, maxFileBytes: maxFileBytes)) }
        for cap in DriveImportCap.allCases where report.caps.contains(cap) {
            lines.append(capLine(cap))
        }
        return lines
    }

    static func capLine(_ cap: DriveImportCap) -> String {
        switch cap {
        case .files: L("driveImport.cap.files", DriveImportLimits.maxFiles)
        case .folders: L("driveImport.cap.folders", DriveImportLimits.maxFolders)
        case .depth: L("driveImport.cap.depth", DriveImportLimits.maxFolderDepth)
        case .bytes: L("driveImport.cap.bytes", Int(DriveImportLimits.maxTotalBytes / (1024 * 1024 * 1024)))
        }
    }

    static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
    }
}
