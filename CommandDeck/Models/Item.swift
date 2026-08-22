import Foundation

/// A card on the board.
///
/// This is a plain value type, not a SwiftData `@Model`. Firestore is the
/// source of truth now: snapshot listeners hand us fresh arrays and the UI
/// re-renders. Structs make that cheap and make "what exactly did I write"
/// obvious at the call site.
struct Item: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var title: String = ""
    var bucket: Bucket = .later
    var done: Bool = false
    var doneAt: Date?
    var waitingOn: String = ""
    var due: Date?
    var subs: [SubTask] = []
    var catId: String = ""
    var urgent: Bool = false
    /// Manual priority inside a bucket.
    var order: Int = 0
    var createdAt: Date = .now

    // MARK: - Derived

    var openSubCount: Int { subs.filter { !$0.done }.count }
    var doneSubCount: Int { subs.filter(\.done).count }

    var isOverdue: Bool {
        guard let due, !done else { return false }
        return Calendar.current.startOfDay(for: due) < Calendar.current.startOfDay(for: .now)
    }

    var isDueSoon: Bool {
        guard let due, !done else { return false }
        let days = Calendar.current.dateComponents(
            [.day],
            from: Calendar.current.startOfDay(for: .now),
            to: Calendar.current.startOfDay(for: due)
        ).day ?? 0
        return days <= 2
    }

    /// Manual order first, newest capture as the tie-break.
    /// Marking an item urgent lifts it to the top of its bucket once
    /// (see `DeckRepository.toggleUrgent`) rather than re-sorting forever,
    /// so drag-to-reorder stays honest. Mirrors the web client exactly.
    static func boardOrder(_ a: Item, _ b: Item) -> Bool {
        if a.order != b.order { return a.order < b.order }
        return a.createdAt > b.createdAt
    }
}

// MARK: - Firestore mapping
//
// Field names and value types here MUST match docs/app.js (see its SCHEMA
// comment). Dates are stored as strings — 'yyyy-MM-dd' for due dates,
// ISO 8601 for timestamps — so the two clients and the JSON backup format
// all agree without any timezone conversion in the middle.

extension Item {

    init(id: String, firestore d: [String: Any]) {
        self.id = id
        self.title = d["title"] as? String ?? ""
        self.bucket = Bucket(rawValue: d["bucket"] as? String ?? "") ?? .later
        self.done = d["done"] as? Bool ?? false
        self.doneAt = DeckDate.date(fromISO: d["doneAt"] as? String)
        self.waitingOn = d["waitingOn"] as? String ?? ""
        self.due = DeckDate.day(from: d["due"] as? String ?? "")
        self.catId = d["catId"] as? String ?? ""
        self.urgent = d["urgent"] as? Bool ?? false
        self.order = (d["order"] as? NSNumber)?.intValue ?? 0
        self.createdAt = DeckDate.date(fromISO: d["createdAt"] as? String) ?? .now

        let rawSubs = d["subs"] as? [[String: Any]] ?? []
        self.subs = rawSubs.map {
            SubTask(
                id: $0["id"] as? String ?? UUID().uuidString,
                text: $0["text"] as? String ?? "",
                done: $0["done"] as? Bool ?? false
            )
        }
    }

    var firestoreData: [String: Any] {
        // `doneAt` is nullable in the schema. Firestore rejects a Swift
        // Optional boxed as Any, so an absent value must become NSNull.
        let doneAtValue: Any = DeckDate.iso(from: doneAt) ?? NSNull()

        return [
            "title": title,
            "bucket": bucket.rawValue,
            "done": done,
            "doneAt": doneAtValue,
            "waitingOn": waitingOn,
            "due": DeckDate.dayString(from: due),
            "subs": subs.map { ["id": $0.id, "text": $0.text, "done": $0.done] },
            "catId": catId,
            "urgent": urgent,
            "order": order,
            "createdAt": DeckDate.iso(from: createdAt) ?? ISO8601DateFormatter().string(from: .now)
        ]
    }
}
