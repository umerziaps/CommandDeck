import XCTest
@testable import CommandDeck

/// Covers the Firestore wire format.
///
/// This is the highest-value test in the iOS app. Three clients — iOS,
/// Android and web — write the same documents, and a mismatched field name
/// doesn't throw: it reads back as a default. A task would quietly lose its
/// due date on one platform and nowhere else. These turn that class of bug
/// into a red X in CI.
final class ItemMappingTests: XCTestCase {

    func testRoundTripsThroughTheWireFormat() {
        let original = Item(
            id: "i_abc",
            title: "Cut over the EMQX broker",
            bucket: .now,
            done: false,
            doneAt: nil,
            waitingOn: "",
            due: DeckDate.day(from: "2026-09-14"),
            subs: [
                SubTask(id: "s_1", text: "Snapshot retained topics", done: true),
                SubTask(id: "s_2", text: "Dry run on staging", done: false)
            ],
            catId: "c_ocufii",
            urgent: true,
            order: 3,
            createdAt: DeckDate.date(fromISO: "2026-08-10T09:30:00Z") ?? .now
        )

        let restored = Item(id: "i_abc", firestore: original.firestoreData)

        XCTAssertEqual(restored.title, original.title)
        XCTAssertEqual(restored.bucket, original.bucket)
        XCTAssertEqual(restored.done, original.done)
        XCTAssertEqual(restored.waitingOn, original.waitingOn)
        XCTAssertEqual(restored.due, original.due)
        XCTAssertEqual(restored.catId, original.catId)
        XCTAssertEqual(restored.urgent, original.urgent)
        XCTAssertEqual(restored.order, original.order)
        XCTAssertEqual(restored.subs, original.subs)
        XCTAssertEqual(
            restored.createdAt.timeIntervalSince1970,
            original.createdAt.timeIntervalSince1970,
            accuracy: 1
        )
    }

    func testUsesTheExactFieldNamesTheOtherClientsRead() {
        // If you rename any of these, rename them in docs/lib.js and
        // android/.../model/Item.kt in the same commit.
        let expected: Set<String> = [
            "title", "bucket", "done", "doneAt", "waitingOn",
            "due", "subs", "catId", "urgent", "order", "createdAt"
        ]
        XCTAssertEqual(Set(Item().firestoreData.keys), expected)
    }

    func testAnEmptyDocumentLoadsAsASaneLaterItem() {
        let item = Item(id: "i_empty", firestore: [:])

        XCTAssertEqual(item.title, "")
        XCTAssertEqual(item.bucket, .later)
        XCTAssertFalse(item.done)
        XCTAssertNil(item.due)
        XCTAssertNil(item.doneAt)
        XCTAssertTrue(item.subs.isEmpty)
        XCTAssertEqual(item.order, 0)
    }

    func testReadsOrderBackAsIntEvenThoughFirestoreReturnsNSNumber() {
        // Firestore hands numbers back as NSNumber/Int64. Casting straight
        // to Int returns nil for some of them, silently resetting position.
        XCTAssertEqual(Item(id: "i_1", firestore: ["order": NSNumber(value: 7)]).order, 7)
        XCTAssertEqual(Item(id: "i_1", firestore: ["order": Int64(9)]).order, 9)
    }

    func testAnUnknownBucketFallsBackToLater() {
        let item = Item(id: "i_1", firestore: ["bucket": "someday-maybe"])
        XCTAssertEqual(item.bucket, .later)
    }

    func testAnUnsetDueDateIsWrittenAsEmptyStringNotNull() {
        // The web client's date input reads "" for no date; null would make
        // it render "Invalid Date".
        XCTAssertEqual(Item(due: nil).firestoreData["due"] as? String, "")
        XCTAssertEqual(
            Item(due: DeckDate.day(from: "2026-09-14")).firestoreData["due"] as? String,
            "2026-09-14"
        )
    }

    func testDoneAtIsNSNullWhenAbsentSoFirestoreAcceptsIt() {
        // Firestore rejects a Swift Optional boxed as Any; it has to be
        // NSNull for the field to be cleared rather than the write failing.
        XCTAssertTrue(Item(done: false).firestoreData["doneAt"] is NSNull)
        XCTAssertTrue(Item(done: true, doneAt: .now).firestoreData["doneAt"] is String)
    }

    func testSubTasksSurviveTheTrip() {
        let item = Item(subs: [SubTask(id: "s_1", text: "Check the logs", done: true)])

        let encoded = item.firestoreData["subs"] as? [[String: Any]]
        XCTAssertEqual(encoded?.count, 1)
        XCTAssertEqual(encoded?.first?["text"] as? String, "Check the logs")
        XCTAssertEqual(encoded?.first?["done"] as? Bool, true)

        let restored = Item(id: "i_1", firestore: item.firestoreData)
        XCTAssertEqual(restored.subs, item.subs)
    }

    func testCountsOpenAndDoneSubTasks() {
        let item = Item(subs: [
            SubTask(text: "a", done: true),
            SubTask(text: "b", done: false),
            SubTask(text: "c", done: false)
        ])
        XCTAssertEqual(item.openSubCount, 2)
        XCTAssertEqual(item.doneSubCount, 1)
    }
}
