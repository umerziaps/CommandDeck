import Foundation
import SwiftData

/// Every mutation the board performs, in one place.
///
/// These are free functions over a `ModelContext` rather than an
/// observable store: SwiftData's `@Query` already drives view updates, so
/// a second source of truth would only be something to keep in sync.
enum DeckStore {

    // MARK: - Items

    @discardableResult
    static func capture(_ title: String, in context: ModelContext, existing: [Item]) -> Item? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let item = Item(
            title: trimmed,
            bucket: .later,
            sortOrder: nextOrder(in: .later, among: existing)
        )
        context.insert(item)
        save(context)
        return item
    }

    static func move(_ item: Item, to bucket: Bucket, in context: ModelContext, among items: [Item]) {
        guard item.bucket != bucket else { return }
        item.bucket = bucket
        item.sortOrder = nextOrder(in: bucket, among: items)
        save(context)
        NotificationScheduler.shared.refresh(for: item)
    }

    static func toggleDone(_ item: Item, in context: ModelContext) {
        item.toggleDone()
        save(context)
        NotificationScheduler.shared.refresh(for: item)
    }

    /// Turning urgent on lifts the item to the top of its bucket once.
    /// Turning it off leaves the item where it is — no surprise jumps.
    static func toggleUrgent(_ item: Item, in context: ModelContext, among items: [Item]) {
        item.isUrgent.toggle()
        if item.isUrgent {
            let peers = items.filter {
                $0.bucket == item.bucket && !$0.isDone && $0.uid != item.uid
            }
            item.sortOrder = (peers.map(\.sortOrder).min() ?? 0) - 1
        }
        save(context)
    }

    static func setDue(_ date: Date?, on item: Item, in context: ModelContext) {
        item.due = date
        save(context)
        NotificationScheduler.shared.refresh(for: item)
    }

    static func delete(_ item: Item, in context: ModelContext) {
        NotificationScheduler.shared.cancel(for: item)
        context.delete(item)
        save(context)
    }

    /// Rewrites `sortOrder` so the on-screen order becomes the saved order.
    /// Mirrors the web version: urgent items still float to the top on render.
    static func applyOrder(_ ordered: [Item], in context: ModelContext) {
        for (index, item) in ordered.enumerated() where item.sortOrder != index {
            item.sortOrder = index
        }
        save(context)
    }

    static func nextOrder(in bucket: Bucket, among items: [Item]) -> Int {
        let peers = items.filter { $0.bucket == bucket && !$0.isDone }
        return (peers.map(\.sortOrder).max() ?? -1) + 1
    }

    // MARK: - Sub-tasks

    static func addSubtask(_ text: String, to item: Item, in context: ModelContext) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let sub = SubTask(text: trimmed)
        sub.item = item
        context.insert(sub)
        if item.subtasks == nil { item.subtasks = [] }
        item.subtasks?.append(sub)
        save(context)
    }

    static func delete(_ sub: SubTask, in context: ModelContext) {
        sub.item?.subtasks?.removeAll { $0.uid == sub.uid }
        context.delete(sub)
        save(context)
    }

    // MARK: - Categories

    @discardableResult
    static func addCategory(
        named name: String,
        in context: ModelContext,
        existing: [ItemCategory]
    ) -> ItemCategory? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !existing.contains(where: { $0.name.caseInsensitiveCompare(trimmed) == .orderedSame })
        else { return nil }

        let category = ItemCategory(
            name: trimmed,
            colorHex: DeckTheme.nextColor(excluding: existing.map(\.colorHex))
        )
        context.insert(category)
        save(context)
        return category
    }

    /// Items keep existing when their category goes — they just become uncategorized.
    static func delete(_ category: ItemCategory, in context: ModelContext) {
        for item in category.items ?? [] { item.category = nil }
        context.delete(category)
        save(context)
    }

    // MARK: - Vault

    @discardableResult
    static func addNote(label: String, value: String, in context: ModelContext) -> VaultNote? {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLabel.isEmpty else { return nil }

        let note = VaultNote(
            label: trimmedLabel,
            value: value.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        context.insert(note)
        save(context)
        return note
    }

    // MARK: - Persistence

    /// SwiftData autosaves, but an explicit save keeps CloudKit pushing
    /// promptly and surfaces validation errors while they are still debuggable.
    static func save(_ context: ModelContext) {
        guard context.hasChanges else { return }
        do {
            try context.save()
        } catch {
            assertionFailure("Command Deck failed to save: \(error)")
        }
    }
}
