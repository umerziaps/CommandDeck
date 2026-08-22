import SwiftUI

/// The three lanes from the original Command Deck board.
///
/// Stored as a raw `String` on `Item` because CloudKit-backed SwiftData
/// cannot persist enums directly.
enum Bucket: String, CaseIterable, Identifiable, Codable {
    case now
    case waiting
    case later

    var id: String { rawValue }

    var title: String {
        switch self {
        case .now: "Now"
        case .waiting: "Waiting"
        case .later: "Later"
        }
    }

    var emptyMessage: String {
        switch self {
        case .now: "Nothing active. Pull something up from Later when you start it."
        case .waiting: "Not waiting on anyone."
        case .later: "Captured items land here. Your inbox is clear."
        }
    }

    var symbol: String {
        switch self {
        case .now: "bolt.fill"
        case .waiting: "hourglass"
        case .later: "tray.fill"
        }
    }

    var tint: Color {
        switch self {
        case .now: DeckTheme.now
        case .waiting: DeckTheme.waiting
        case .later: DeckTheme.later
        }
    }
}
