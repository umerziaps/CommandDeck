import Foundation

/// The one place to flip when your signing situation changes.
///
/// Free "Personal Team" Apple accounts cannot sign an app that declares
/// the iCloud or Push Notifications capabilities — Apple restricts both to
/// the paid Developer Program. So the app ships with sync **off** and a
/// purely local store, which a free account can build and run today.
///
/// To turn sync on later:
///   1. Join the Apple Developer Program.
///   2. Xcode → Signing & Capabilities → + Capability → iCloud → CloudKit.
///      (Xcode writes the entitlement keys for you; the exact set is in
///      `CommandDeck-iCloud.entitlements.reference` if you'd rather paste them.)
///   3. Set `iCloudSyncEnabled` below to `true`.
///   4. If you changed the bundle identifier, update `iCloudContainerID`
///      to match the container Xcode created.
///
/// Nothing else in the app needs to change — the model container reads
/// these two values and the Settings screen reports what actually happened.
enum AppConfig {

    /// Whether to attempt a CloudKit-backed store at launch.
    static let iCloudSyncEnabled = false

    /// Must match the container in the app's iCloud entitlement.
    static let iCloudContainerID = "iCloud.com.umerzia.CommandDeck"
}
