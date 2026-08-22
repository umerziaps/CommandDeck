import Foundation
import SwiftUI

/// A colour-coded label. Named `ItemCategory` rather than `Category` to
/// avoid colliding with the Foundation/ObjC meaning of that word; the UI
/// still calls them categories.
struct ItemCategory: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var name: String = ""
    /// Hex string, e.g. "#5EE6C5" — matches the web palette exactly.
    var colorHex: String = "#5EE6C5"
    var createdAt: Date = .now

    var color: Color { Color(hex: colorHex) ?? DeckTheme.accent }
}

// MARK: - Firestore mapping

extension ItemCategory {

    init(id: String, firestore d: [String: Any]) {
        self.id = id
        self.name = d["name"] as? String ?? ""
        self.colorHex = d["color"] as? String ?? "#5EE6C5"
        self.createdAt = DeckDate.date(fromISO: d["createdAt"] as? String) ?? .now
    }

    var firestoreData: [String: Any] {
        [
            "name": name,
            "color": colorHex,
            "createdAt": DeckDate.iso(from: createdAt) ?? ISO8601DateFormatter().string(from: .now)
        ]
    }
}
