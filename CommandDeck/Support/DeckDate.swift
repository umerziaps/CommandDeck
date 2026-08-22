import Foundation

/// Human date labels, matching the web version's `fmtDate`:
/// today / tomorrow / yesterday / in 3d / 4d ago / 12 Sep.
enum DeckDate {

    static func label(for date: Date) -> String {
        let cal = Calendar.current
        let start = cal.startOfDay(for: .now)
        let target = cal.startOfDay(for: date)
        let days = cal.dateComponents([.day], from: start, to: target).day ?? 0

        switch days {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        case 2...7: return "in \(days)d"
        case ..<(-1): return "\(abs(days))d ago"
        default:
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
    }

    static func greeting(at date: Date = .now) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case ..<12: "Good morning"
        case ..<17: "Good afternoon"
        default: "Good evening"
        }
    }

    static func todayLine(_ date: Date = .now) -> String {
        date.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    // MARK: - Backup interchange

    /// "yyyy-MM-dd", the date format the web version wrote for due dates.
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func day(from string: String) -> Date? {
        guard !string.isEmpty else { return nil }
        return dayFormatter.date(from: string)
    }

    static func dayString(from date: Date?) -> String {
        guard let date else { return "" }
        return dayFormatter.string(from: date)
    }

    static func iso(from date: Date?) -> String? {
        guard let date else { return nil }
        return ISO8601DateFormatter().string(from: date)
    }

    static func date(fromISO string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
}
