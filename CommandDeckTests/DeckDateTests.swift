import XCTest
@testable import CommandDeck

/// Covers date formatting and parsing — the shared wire format, and the
/// labels the board shows.
final class DeckDateTests: XCTestCase {

    private func day(_ string: String) -> Date {
        guard let date = DeckDate.day(from: string) else {
            XCTFail("could not parse \(string)")
            return .now
        }
        return date
    }

    func testDayStringsRoundTrip() {
        XCTAssertEqual(DeckDate.dayString(from: day("2026-09-14")), "2026-09-14")
    }

    func testNoDueDateIsAnEmptyString() {
        XCTAssertEqual(DeckDate.dayString(from: nil), "")
        XCTAssertNil(DeckDate.day(from: ""))
    }

    func testMalformedDatesReturnNilInsteadOfCrashing() {
        // One bad value in one document must not take down the whole board.
        XCTAssertNil(DeckDate.day(from: "not-a-date"))
        XCTAssertNil(DeckDate.day(from: "14/09/2026"))
        XCTAssertNil(DeckDate.date(fromISO: "nonsense"))
        XCTAssertNil(DeckDate.date(fromISO: nil))
    }

    func testISOTimestampsRoundTrip() {
        let instant = DeckDate.date(fromISO: "2026-08-22T14:30:00Z")
        XCTAssertNotNil(instant)
        XCTAssertEqual(DeckDate.iso(from: instant), "2026-08-22T14:30:00Z")
    }

    func testParsesISOTimestampsWithFractionalSeconds() {
        // The web client writes Date.toISOString(), which includes millis.
        // Without the fractional-seconds fallback this returns nil and every
        // item's created date resets.
        XCTAssertNotNil(DeckDate.date(fromISO: "2026-08-22T14:30:00.123Z"))
    }

    func testNamesTheDaysAroundToday() {
        let today = Calendar.current.startOfDay(for: .now)
        XCTAssertEqual(DeckDate.label(for: today), "today")
        XCTAssertEqual(
            DeckDate.label(for: Calendar.current.date(byAdding: .day, value: 1, to: today)!),
            "tomorrow"
        )
        XCTAssertEqual(
            DeckDate.label(for: Calendar.current.date(byAdding: .day, value: -1, to: today)!),
            "yesterday"
        )
    }

    func testCountsDownWithinTheWeek() {
        let today = Calendar.current.startOfDay(for: .now)
        let inThree = Calendar.current.date(byAdding: .day, value: 3, to: today)!
        XCTAssertEqual(DeckDate.label(for: inThree), "in 3d")
    }

    func testCountsUpIntoThePast() {
        let today = Calendar.current.startOfDay(for: .now)
        let fiveAgo = Calendar.current.date(byAdding: .day, value: -5, to: today)!
        XCTAssertEqual(DeckDate.label(for: fiveAgo), "5d ago")
    }

    func testFlagsOverdueAndImminentItems() {
        let today = Calendar.current.startOfDay(for: .now)
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: today)!
        let inTen = Calendar.current.date(byAdding: .day, value: 10, to: today)!

        XCTAssertTrue(Item(due: yesterday).isOverdue)
        XCTAssertTrue(Item(due: today).isDueSoon)
        XCTAssertFalse(Item(due: inTen).isDueSoon)
        XCTAssertFalse(Item(due: today).isOverdue)
    }

    func testACompletedItemIsNeverOverdue() {
        let longAgo = Calendar.current.date(byAdding: .day, value: -30, to: .now)!
        let item = Item(done: true, due: longAgo)

        XCTAssertFalse(item.isOverdue)
        XCTAssertFalse(item.isDueSoon)
    }

    func testCategoryPaletteMatchesTheOtherClients() {
        // A category created on Android has to render the same colour here.
        XCTAssertEqual(DeckTheme.categoryPalette.count, 10)
        XCTAssertEqual(DeckTheme.categoryPalette.first, "#5EE6C5")
        XCTAssertTrue(DeckTheme.categoryPalette.allSatisfy {
            $0.range(of: "^#[0-9A-F]{6}$", options: [.regularExpression, .caseInsensitive]) != nil
        })
    }

    func testHandsOutPaletteColoursInOrderThenWraps() {
        XCTAssertEqual(DeckTheme.nextColor(excluding: []), DeckTheme.categoryPalette[0])
        XCTAssertEqual(
            DeckTheme.nextColor(excluding: [DeckTheme.categoryPalette[0]]),
            DeckTheme.categoryPalette[1]
        )
        XCTAssertTrue(
            DeckTheme.categoryPalette.contains(
                DeckTheme.nextColor(excluding: DeckTheme.categoryPalette)
            )
        )
    }
}
