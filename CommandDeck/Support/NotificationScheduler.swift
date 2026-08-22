import Foundation
import UserNotifications

/// Local reminders for anything with a due date.
///
/// One notification per item, keyed by the item's id, fired at a chosen
/// hour on the due day. Rescheduling is idempotent: the existing request
/// is always removed before a new one is added, so editing a date
/// repeatedly cannot pile up duplicates.
///
/// These are local notifications — they need no push entitlement and work
/// fine on a free Apple account.
final class NotificationScheduler: @unchecked Sendable {

    static let shared = NotificationScheduler()
    private init() {}

    private let center = UNUserNotificationCenter.current()

    var reminderHour: Int {
        get { UserDefaults.standard.object(forKey: "reminderHour") as? Int ?? 9 }
        set { UserDefaults.standard.set(newValue, forKey: "reminderHour") }
    }

    var remindersEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "remindersEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "remindersEnabled") }
    }

    // MARK: - Authorization

    @discardableResult
    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    // MARK: - Scheduling

    func cancel(uid: String) {
        center.removePendingNotificationRequests(withIdentifiers: [uid])
    }

    func cancel(for item: Item) {
        cancel(uid: item.id)
    }

    /// Cancels and, if the item still warrants one, re-adds its reminder.
    func refresh(for item: Item) {
        let id = item.id
        let title = item.title
        let due = item.due
        let done = item.done
        let urgent = item.urgent
        let thread = item.bucket.rawValue

        Task { [weak self] in
            guard let self else { return }
            self.cancel(uid: id)

            guard self.remindersEnabled,
                  !done,
                  let due,
                  await self.authorizationStatus() == .authorized
            else { return }

            var components = Calendar.current.dateComponents([.year, .month, .day], from: due)
            components.hour = self.reminderHour
            components.minute = 0

            guard let fireDate = Calendar.current.date(from: components), fireDate > .now else { return }

            let content = UNMutableNotificationContent()
            content.title = urgent ? "Urgent — due today" : "Due today"
            content.body = title
            content.sound = .default
            content.threadIdentifier = thread

            let request = UNNotificationRequest(
                identifier: id,
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            )
            try? await self.center.add(request)
        }
    }

    /// Rebuilds the whole schedule. Called whenever a Firestore snapshot
    /// lands, so reminders track edits made on the web too.
    func rescheduleAll(_ items: [Item]) {
        let due = items.filter { $0.due != nil && !$0.done }
        center.removeAllPendingNotificationRequests()
        for item in due { refresh(for: item) }
    }
}
