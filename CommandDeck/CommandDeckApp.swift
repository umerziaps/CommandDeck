import FirebaseCore
import FirebaseFirestore
import GoogleSignIn
import SwiftData
import SwiftUI

@main
struct CommandDeckApp: App {

    @AppStorage("appearanceMode") private var appearanceRaw = AppearanceMode.system.rawValue

    @State private var auth: AuthService
    @State private var repository: DeckRepository

    /// False when GoogleService-Info.plist is missing from the bundle.
    /// Rather than let `FirebaseApp.configure()` trap on launch, the app
    /// shows a screen that says exactly what to add.
    private let firebaseReady: Bool

    /// SwiftData now holds one thing only: the Notes & Logins vault, which
    /// deliberately never leaves the device. Tasks and categories live in
    /// Firestore.
    private let vaultContainer: ModelContainer

    init() {
        firebaseReady = Bundle.main.url(forResource: "GoogleService-Info", withExtension: "plist") != nil

        if firebaseReady {
            FirebaseApp.configure()

            // Offline cache: the board opens and accepts edits with no
            // network, and queued writes flush on reconnect.
            let settings = FirestoreSettings()
            settings.cacheSettings = PersistentCacheSettings()
            Firestore.firestore().settings = settings
        }

        _auth = State(initialValue: AuthService())
        _repository = State(initialValue: DeckRepository())

        let schema = Schema([VaultNote.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        vaultContainer = (try? ModelContainer(for: schema, configurations: [config]))
            ?? {
                // Falling back to memory keeps the app usable rather than
                // crashing at launch if the vault store can't be opened.
                let memory = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
                return try! ModelContainer(for: schema, configurations: [memory])
            }()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if firebaseReady {
                    RootView()
                } else {
                    SetupNeededView()
                }
            }
            .environment(auth)
            .environment(repository)
            .preferredColorScheme(AppearanceMode(rawValue: appearanceRaw)?.colorScheme)
            .tint(DeckTheme.accent)
            .onOpenURL { GIDSignIn.sharedInstance.handle($0) }
        }
        .modelContainer(vaultContainer)
    }
}

// MARK: - Root

/// Decides between the sign-in screen and the board, and keeps the
/// repository's listeners attached to whoever is signed in.
struct RootView: View {

    @Environment(AuthService.self) private var auth
    @Environment(DeckRepository.self) private var repository

    var body: some View {
        Group {
            if auth.isRestoring {
                LaunchView()
            } else if auth.user == nil {
                SignInView()
            } else {
                DeckView()
            }
        }
        .animation(.default, value: auth.user?.uid)
        .task(id: auth.user?.uid) {
            if let uid = auth.user?.uid {
                repository.start(uid: uid)
            } else {
                repository.stop()
            }
        }
    }
}

struct LaunchView: View {
    var body: some View {
        ZStack {
            DeckTheme.background.ignoresSafeArea()
            ProgressView()
        }
    }
}

/// Shown when the Firebase config file hasn't been added yet.
struct SetupNeededView: View {
    var body: some View {
        ZStack {
            DeckTheme.background.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 14) {
                Label("Firebase isn't set up yet", systemImage: "gearshape.2")
                    .font(.deckDisplay(20))
                    .foregroundStyle(DeckTheme.ink)

                Text("The app needs two things before it can sign in:")
                    .font(.subheadline)
                    .foregroundStyle(DeckTheme.inkSecondary)

                VStack(alignment: .leading, spacing: 10) {
                    step(1, "Add **GoogleService-Info.plist** from the Firebase console to the app target.")
                    step(2, "Paste that file's **REVERSED_CLIENT_ID** into the URL scheme in Info.plist.")
                }

                Text("FIREBASE-SETUP.md in the repo walks through both.")
                    .font(.caption)
                    .foregroundStyle(DeckTheme.inkTertiary)
                    .padding(.top, 4)
            }
            .padding(28)
        }
    }

    private func step(_ number: Int, _ markdown: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.deckMono(12, weight: .bold))
                .foregroundStyle(DeckTheme.background)
                .frame(width: 20, height: 20)
                .background(DeckTheme.accent, in: Circle())

            Text(.init(markdown))
                .font(.footnote)
                .foregroundStyle(DeckTheme.inkSecondary)
        }
    }
}
