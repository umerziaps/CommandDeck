import Foundation

/// A checklist line inside an `Item`.
///
/// Stored inline on the item document rather than in a subcollection:
/// sub-tasks are always read and written together with their parent, so
/// embedding them keeps the whole item to a single read and a single
/// atomic write.
struct SubTask: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var text: String = ""
    var done: Bool = false
}
