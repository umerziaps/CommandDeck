import Foundation
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Wire format
//
// Mirrors the web artifact's export payload byte for byte
// (`{ app, version, exportedAt, items, ref, cats, theme }`), so a backup
// from the browser restores here and one written here opens there.
// Do not rename the coding keys.

struct BackupPayload: Codable {
    var app: String = "command-deck"
    var version: Int = 3
    var exportedAt: String = ISO8601DateFormatter().string(from: .now)
    var items: [BackupItem] = []
    var ref: [BackupNote] = []
    var cats: [BackupCategory] = []
    var theme: String = "dark"

    enum CodingKeys: String, CodingKey {
        case app, version, exportedAt, items, ref, cats, theme
    }
}

struct BackupItem: Codable {
    var id: String
    var title: String
    var bucket: String
    var done: Bool
    var waitingOn: String
    /// "yyyy-MM-dd", or "" when unset.
    var due: String
    var subs: [BackupSub]
    var catId: String
    var urgent: Bool
    var order: Int?
    var createdAt: String?
    var doneAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, bucket, done, waitingOn, due, subs, catId, urgent, order, createdAt, doneAt
    }
}

struct BackupSub: Codable {
    var id: String
    var text: String
    var done: Bool
}

struct BackupCategory: Codable {
    var id: String
    var name: String
    var color: String
}

struct BackupNote: Codable {
    var id: String
    var label: String
    var value: String
}

// Tolerant decoding: older exports omitted fields later versions added, so
// a missing key falls back to a default rather than failing the restore.

extension BackupPayload {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try c.decodeIfPresent(String.self, forKey: .app) ?? ""
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        exportedAt = try c.decodeIfPresent(String.self, forKey: .exportedAt) ?? ""
        items = try c.decodeIfPresent([BackupItem].self, forKey: .items) ?? []
        ref = try c.decodeIfPresent([BackupNote].self, forKey: .ref) ?? []
        cats = try c.decodeIfPresent([BackupCategory].self, forKey: .cats) ?? []
        theme = try c.decodeIfPresent(String.self, forKey: .theme) ?? "dark"
    }
}

extension BackupItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        bucket = try c.decodeIfPresent(String.self, forKey: .bucket) ?? "later"
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        waitingOn = try c.decodeIfPresent(String.self, forKey: .waitingOn) ?? ""
        due = try c.decodeIfPresent(String.self, forKey: .due) ?? ""
        subs = try c.decodeIfPresent([BackupSub].self, forKey: .subs) ?? []
        catId = try c.decodeIfPresent(String.self, forKey: .catId) ?? ""
        urgent = try c.decodeIfPresent(Bool.self, forKey: .urgent) ?? false
        order = try c.decodeIfPresent(Int.self, forKey: .order)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        doneAt = try c.decodeIfPresent(String.self, forKey: .doneAt)
    }
}

// MARK: - Document

struct BackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }

    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        data = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// MARK: - Service

enum BackupService {

    enum BackupError: LocalizedError {
        case notACommandDeckBackup

        var errorDescription: String? {
            switch self {
            case .notACommandDeckBackup: "That doesn't look like a Command Deck backup."
            }
        }
    }

    static func suggestedFilename(_ date: Date = .now) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmm"
        return "command-deck-backup-\(f.string(from: date))"
    }

    // MARK: Export

    static func export(
        items: [Item],
        categories: [ItemCategory],
        notes: [VaultNote],
        theme: String
    ) throws -> Data {
        var payload = BackupPayload()
        payload.theme = theme
        payload.cats = categories.map { BackupCategory(id: $0.id, name: $0.name, color: $0.colorHex) }
        payload.ref = notes.map { BackupNote(id: $0.uid, label: $0.label, value: $0.value) }
        payload.items = items.map { item in
            BackupItem(
                id: item.id,
                title: item.title,
                bucket: item.bucket.rawValue,
                done: item.done,
                waitingOn: item.waitingOn,
                due: DeckDate.dayString(from: item.due),
                subs: item.subs.map { BackupSub(id: $0.id, text: $0.text, done: $0.done) },
                catId: item.catId,
                urgent: item.urgent,
                order: item.order,
                createdAt: DeckDate.iso(from: item.createdAt),
                doneAt: DeckDate.iso(from: item.doneAt)
            )
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(payload)
    }

    // MARK: Import

    static func decode(_ data: Data) throws -> BackupPayload {
        guard let payload = try? JSONDecoder().decode(BackupPayload.self, from: data),
              payload.app == "command-deck" || !payload.items.isEmpty
        else { throw BackupError.notACommandDeckBackup }
        return payload
    }

    /// Turns a decoded payload into the value types the repository writes.
    static func materialise(_ payload: BackupPayload) -> (items: [Item], categories: [ItemCategory]) {
        let categories = payload.cats.map {
            ItemCategory(id: $0.id, name: $0.name, colorHex: $0.color, createdAt: .now)
        }
        let items = payload.items.enumerated().map { index, raw in
            Item(
                id: raw.id,
                title: raw.title,
                bucket: Bucket(rawValue: raw.bucket) ?? .later,
                done: raw.done,
                doneAt: DeckDate.date(fromISO: raw.doneAt),
                waitingOn: raw.waitingOn,
                due: DeckDate.day(from: raw.due),
                subs: raw.subs.map { SubTask(id: $0.id, text: $0.text, done: $0.done) },
                catId: raw.catId,
                urgent: raw.urgent,
                order: raw.order ?? index,
                createdAt: DeckDate.date(fromISO: raw.createdAt) ?? .now
            )
        }
        return (items, categories)
    }
}
