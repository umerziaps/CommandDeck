import Foundation
import SwiftData

/// The "Notes & logins" section from the web version.
///
/// On iOS this is meaningfully safer than it was on a shared link: the
/// store lives in the app's own container, the device encrypts it at rest,
/// iCloud encrypts it in transit, and revealing a secret is gated behind
/// Face ID. It is still not a password manager — no key derivation, no
/// secure enclave — so keep production credentials out of it.
@Model
final class VaultNote {
    var uid: String = UUID().uuidString
    var label: String = ""
    var value: String = ""
    /// When true the value stays masked until the user authenticates.
    var isSecret: Bool = false
    var createdAt: Date = Date.now

    init(
        uid: String = UUID().uuidString,
        label: String = "",
        value: String = "",
        isSecret: Bool? = nil,
        createdAt: Date = .now
    ) {
        self.uid = uid
        self.label = label
        self.value = value
        self.isSecret = isSecret ?? VaultNote.looksSecret(label)
        self.createdAt = createdAt
    }

    /// Same heuristic the web version used to decide what to mask.
    static func looksSecret(_ label: String) -> Bool {
        let needles = ["pass", "pwd", "secret", "token", "key", "login", "cred"]
        let haystack = label.lowercased()
        return needles.contains { haystack.contains($0) }
    }
}
