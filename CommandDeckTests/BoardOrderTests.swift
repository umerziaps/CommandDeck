import XCTest
@testable import CommandDeck

/// Covers how the board decides what sits where — the rules a user notices
/// immediately when they're wrong.
final class BoardOrderTests: XCTestCase {

    private func item(
        _ id: String,
        order: Int,
        bucket: Bucket = .now,
        done: Bool = false,
        createdAt: String = "2026-08-01T00:00:00Z"
    ) -> Item {
        Item(
            id: id,
            title: id,
            bucket: bucket,
            done: done,
            order: order,
            createdAt: DeckDate.date(fromISO: createdAt) ?? .now
        )
    }

    func testSortsByManualOrderFirst() {
        let sorted = [item("c", order: 2), item("a", order: 0), item("b", order: 1)]
            .sorted(by: Item.boardOrder)

        XCTAssertEqual(sorted.map(\.id), ["a", "b", "c"])
    }

    func testBreaksTiesWithTheNewestCaptureFirst() {
        let older = item("older", order: 0, createdAt: "2026-08-01T00:00:00Z")
        let newer = item("newer", order: 0, createdAt: "2026-08-20T00:00:00Z")

        XCTAssertEqual([older, newer].sorted(by: Item.boardOrder).map(\.id), ["newer", "older"])
    }

    func testDoesNotFloatUrgentItemsToTheTopOnEveryRead() {
        // The original web version re-sorted urgent items to the top on each
        // render, which fights drag-to-reorder: an item dragged above an
        // urgent one visibly snaps back. Urgency is a one-time lift now.
        var urgent = item("urgent", order: 5)
        urgent.urgent = true
        let calm = item("calm", order: 0)

        XCTAssertEqual([urgent, calm].sorted(by: Item.boardOrder).map(\.id), ["calm", "urgent"])
    }

    func testTheSortIsAStrictWeakOrdering() {
        // Swift's sort can trap at runtime on an inconsistent comparator.
        // Equal elements must compare false in both directions.
        let a = item("a", order: 1, createdAt: "2026-08-01T00:00:00Z")
        let b = item("b", order: 1, createdAt: "2026-08-01T00:00:00Z")

        XCTAssertFalse(Item.boardOrder(a, b))
        XCTAssertFalse(Item.boardOrder(b, a))
        XCTAssertFalse(Item.boardOrder(a, a))
    }

    func testSortingIsStableAcrossALargerBoard() {
        let items = (0..<50).map { item("i\($0)", order: $0 % 7) }
        let sorted = items.sorted(by: Item.boardOrder)

        XCTAssertEqual(sorted.count, 50)
        XCTAssertEqual(sorted.map(\.order), sorted.map(\.order).sorted())
    }
}
