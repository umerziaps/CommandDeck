import FirebaseFirestore
import Foundation
import Observation

/// The board's live view of Firestore.
///
/// Two snapshot listeners keep `items` and `categories` current; every
/// mutation writes straight to Firestore and the listener echoes it back.
/// There is no second source of truth to keep in sync.
///
/// Firestore's local cache is enabled, so reads work offline and writes
/// queue up and flush on reconnect. That means none of the mutating
/// methods need to be awaited from the UI — the local cache applies them
/// immediately and the listener fires right away.
@Observable
@MainActor
final class DeckRepository {

    private(set) var items: [Item] = []
    private(set) var categories: [ItemCategory] = []
    private(set) var isLoading = true
    private(set) var hasPendingWrites = false
    private(set) var isFromCache = false
    var errorMessage: String?

    private var itemsListener: ListenerRegistration?
    private var catsListener: ListenerRegistration?
    private var uid: String?

    /// Computed rather than stored so that merely constructing the
    /// repository never touches Firebase. Nothing here runs before
    /// `start(uid:)`, which only happens after a successful sign-in —
    /// by which point `FirebaseApp.configure()` has definitely run.
    /// `Firestore.firestore()` returns the SDK's shared instance, so this
    /// is not allocating anything per call.
    private var db: Firestore { Firestore.firestore() }

    // MARK: - Collections

    private func itemsCollection(_ uid: String) -> CollectionReference {
        db.collection("users").document(uid).collection("items")
    }

    private func catsCollection(_ uid: String) -> CollectionReference {
        db.collection("users").document(uid).collection("categories")
    }

    private var itemsCol: CollectionReference? { uid.map(itemsCollection) }
    private var catsCol: CollectionReference? { uid.map(catsCollection) }

    // MARK: - Lifecycle

    func start(uid: String) {
        guard self.uid != uid else { return }
        stop()
        self.uid = uid
        isLoading = true

        itemsListener = itemsCollection(uid).addSnapshotListener { [weak self] snapshot, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.errorMessage = Self.describe(error)
                    self.isLoading = false
                    return
                }
                guard let snapshot else { return }
                self.items = snapshot.documents.map { Item(id: $0.documentID, firestore: $0.data()) }
                self.hasPendingWrites = snapshot.metadata.hasPendingWrites
                self.isFromCache = snapshot.metadata.isFromCache
                self.isLoading = false
                NotificationScheduler.shared.rescheduleAll(self.items)
            }
        }

        catsListener = catsCollection(uid).addSnapshotListener { [weak self] snapshot, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.errorMessage = Self.describe(error)
                    return
                }
                guard let snapshot else { return }
                self.categories = snapshot.documents
                    .map { ItemCategory(id: $0.documentID, firestore: $0.data()) }
                    .sorted { $0.createdAt < $1.createdAt }
            }
        }
    }

    func stop() {
        itemsListener?.remove(); itemsListener = nil
        catsListener?.remove(); catsListener = nil
        uid = nil
        items = []
        categories = []
        isLoading = false
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == FirestoreErrorDomain, ns.code == FirestoreErrorCode.permissionDenied.rawValue {
            return "Permission denied. Check the Firestore security rules in firestore.rules are published."
        }
        return error.localizedDescription
    }

    // MARK: - Reads

    func category(id: String) -> ItemCategory? {
        categories.first { $0.id == id }
    }

    func items(in bucket: Bucket, filter: CategoryFilter) -> [Item] {
        items
            .filter { !$0.done && $0.bucket == bucket && filter.matches($0) }
            .sorted(by: Item.boardOrder)
    }

    func doneItems(filter: CategoryFilter) -> [Item] {
        items
            .filter { $0.done && filter.matches($0) }
            .sorted { ($0.doneAt ?? .distantPast) > ($1.doneAt ?? .distantPast) }
    }

    private func nextOrder(in bucket: Bucket) -> Int {
        let peers = items.filter { $0.bucket == bucket && !$0.done }
        return (peers.map(\.order).max() ?? -1) + 1
    }

    // MARK: - Item writes

    @discardableResult
    func capture(_ title: String, catId: String = "") -> Item? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let col = itemsCol else { return nil }

        var item = Item()
        item.title = trimmed
        item.bucket = .later
        item.catId = catId
        item.order = nextOrder(in: .later)

        write(col.document(item.id), item.firestoreData)
        return item
    }

    func update(_ item: Item) {
        guard let col = itemsCol else { return }
        write(col.document(item.id), item.firestoreData)
    }

    private func patch(_ id: String, _ fields: [String: Any]) {
        guard let col = itemsCol else { return }
        col.document(id).updateData(fields) { [weak self] error in
            if let error { Task { @MainActor in self?.errorMessage = Self.describe(error) } }
        }
    }

    func toggleDone(_ item: Item) {
        let nowDone = !item.done
        patch(item.id, [
            "done": nowDone,
            "doneAt": nowDone ? (DeckDate.iso(from: .now) ?? "") : NSNull()
        ])
        var updated = item
        updated.done = nowDone
        updated.doneAt = nowDone ? .now : nil
        NotificationScheduler.shared.refresh(for: updated)
    }

    /// Turning urgent on lifts the item to the top of its bucket once.
    /// Turning it off leaves it where it is — no surprise jumps.
    func toggleUrgent(_ item: Item) {
        var fields: [String: Any] = ["urgent": !item.urgent]
        if !item.urgent {
            let peers = items.filter { $0.bucket == item.bucket && !$0.done && $0.id != item.id }
            fields["order"] = (peers.map(\.order).min() ?? 0) - 1
        }
        patch(item.id, fields)
    }

    func move(_ item: Item, to bucket: Bucket) {
        guard item.bucket != bucket else { return }
        patch(item.id, [
            "bucket": bucket.rawValue,
            "order": nextOrder(in: bucket),
            "waitingOn": bucket == .waiting ? item.waitingOn : ""
        ])
    }

    func setDue(_ date: Date?, on item: Item) {
        patch(item.id, ["due": DeckDate.dayString(from: date)])
        var updated = item
        updated.due = date
        NotificationScheduler.shared.refresh(for: updated)
    }

    func setCategory(_ catId: String, on item: Item) {
        patch(item.id, ["catId": catId])
    }

    func setTitle(_ title: String, on item: Item) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != item.title else { return }
        patch(item.id, ["title": trimmed])
    }

    func setWaitingOn(_ who: String, on item: Item) {
        patch(item.id, ["waitingOn": who])
    }

    func delete(_ item: Item) {
        NotificationScheduler.shared.cancel(uid: item.id)
        guard let col = itemsCol else { return }
        col.document(item.id).delete()
    }

    /// Rewrites `order` so the on-screen sequence becomes the saved one.
    func applyOrder(_ ordered: [Item]) {
        guard let col = itemsCol else { return }
        let batch = db.batch()
        var touched = false
        for (index, item) in ordered.enumerated() where item.order != index {
            batch.updateData(["order": index], forDocument: col.document(item.id))
            touched = true
        }
        guard touched else { return }
        batch.commit { [weak self] error in
            if let error { Task { @MainActor in self?.errorMessage = Self.describe(error) } }
        }
    }

    // MARK: - Sub-tasks

    func addSubtask(_ text: String, to item: Item) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var subs = item.subs
        subs.append(SubTask(text: trimmed))
        patch(item.id, ["subs": subs.map { ["id": $0.id, "text": $0.text, "done": $0.done] }])
    }

    func toggleSubtask(_ sub: SubTask, on item: Item) {
        let subs = item.subs.map { $0.id == sub.id ? SubTask(id: $0.id, text: $0.text, done: !$0.done) : $0 }
        patch(item.id, ["subs": subs.map { ["id": $0.id, "text": $0.text, "done": $0.done] }])
    }

    func deleteSubtask(_ sub: SubTask, on item: Item) {
        let subs = item.subs.filter { $0.id != sub.id }
        patch(item.id, ["subs": subs.map { ["id": $0.id, "text": $0.text, "done": $0.done] }])
    }

    // MARK: - Categories

    @discardableResult
    func addCategory(named name: String) -> ItemCategory? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let col = catsCol else { return nil }
        guard !categories.contains(where: { $0.name.caseInsensitiveCompare(trimmed) == .orderedSame })
        else { return nil }

        var category = ItemCategory()
        category.name = trimmed
        category.colorHex = DeckTheme.nextColor(excluding: categories.map(\.colorHex))

        write(col.document(category.id), category.firestoreData)
        return category
    }

    func renameCategory(_ category: ItemCategory, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != category.name, let col = catsCol else { return }
        guard !categories.contains(where: {
            $0.id != category.id && $0.name.caseInsensitiveCompare(trimmed) == .orderedSame
        }) else { return }
        col.document(category.id).updateData(["name": trimmed])
    }

    func recolorCategory(_ category: ItemCategory, to hex: String) {
        guard let col = catsCol else { return }
        col.document(category.id).updateData(["color": hex])
    }

    /// Items survive their category — they just become uncategorized.
    func deleteCategory(_ category: ItemCategory) {
        guard let items = itemsCol, let cats = catsCol else { return }
        let batch = db.batch()
        for item in self.items where item.catId == category.id {
            batch.updateData(["catId": ""], forDocument: items.document(item.id))
        }
        batch.deleteDocument(cats.document(category.id))
        batch.commit { [weak self] error in
            if let error { Task { @MainActor in self?.errorMessage = Self.describe(error) } }
        }
    }

    // MARK: - Backup

    /// Replaces everything on the account with the backup's contents.
    /// Chunked because Firestore caps a batch at 500 writes.
    func restore(items newItems: [Item], categories newCats: [ItemCategory]) async throws {
        guard let itemsCol, let catsCol else { return }

        let oldItems = try await itemsCol.getDocuments().documents
        let oldCats = try await catsCol.getDocuments().documents

        var operations: [(WriteBatch) -> Void] = []
        oldItems.forEach { d in operations.append { $0.deleteDocument(d.reference) } }
        oldCats.forEach { d in operations.append { $0.deleteDocument(d.reference) } }
        newCats.forEach { c in operations.append { $0.setData(c.firestoreData, forDocument: catsCol.document(c.id)) } }
        newItems.forEach { i in operations.append { $0.setData(i.firestoreData, forDocument: itemsCol.document(i.id)) } }

        for chunk in stride(from: 0, to: operations.count, by: 450) {
            let batch = db.batch()
            for op in operations[chunk..<min(chunk + 450, operations.count)] { op(batch) }
            try await batch.commit()
        }
    }

    // MARK: - Plumbing

    private func write(_ ref: DocumentReference, _ data: [String: Any]) {
        ref.setData(data) { [weak self] error in
            if let error { Task { @MainActor in self?.errorMessage = Self.describe(error) } }
        }
    }
}

// MARK: - Filtering

enum CategoryFilter: Hashable {
    case all
    case uncategorized
    case category(String)

    func matches(_ item: Item) -> Bool {
        switch self {
        case .all: true
        case .uncategorized: item.catId.isEmpty
        case .category(let id): item.catId == id
        }
    }
}
