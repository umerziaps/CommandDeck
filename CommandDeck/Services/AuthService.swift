import FirebaseAuth
import FirebaseCore
import GoogleSignIn
import Observation
import UIKit

/// Google sign-in, exchanged for a Firebase credential.
///
/// The Firebase UID this produces is the same one the web client gets for
/// the same Google account, which is what makes `users/{uid}/…` the shared
/// board rather than two separate ones.
@Observable
@MainActor
final class AuthService {

    private(set) var user: User?
    /// True until Firebase has restored (or failed to restore) a session.
    /// Without this the sign-in screen flashes on every cold launch.
    private(set) var isRestoring = true
    private(set) var isWorking = false
    var errorMessage: String?

    private var handle: AuthStateDidChangeListenerHandle?

    init() {
        // If GoogleService-Info.plist is missing, FirebaseApp was never
        // configured and touching Auth would trap. The app shows a setup
        // screen in that case, so just stay idle.
        guard FirebaseApp.app() != nil else {
            isRestoring = false
            return
        }
        handle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                self?.user = user
                self?.isRestoring = false
            }
        }
    }

    // No deinit removing the listener: `deinit` is nonisolated even inside
    // a @MainActor class, so it cannot touch `handle`. It also isn't
    // needed — AuthService is created once by the App and lives for the
    // whole process, so the listener is never orphaned.

    var displayName: String? { user?.displayName }
    var email: String? { user?.email }

    // MARK: - Sign in

    func signInWithGoogle() async {
        errorMessage = nil

        guard let clientID = FirebaseApp.app()?.options.clientID else {
            errorMessage = "No Google client ID. Add GoogleService-Info.plist to the app target and make sure Google sign-in is enabled in the Firebase console."
            return
        }
        guard let presenter = Self.topViewController() else {
            errorMessage = "Couldn't find a window to present sign-in from."
            return
        }

        isWorking = true
        defer { isWorking = false }

        do {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)

            guard let idToken = result.user.idToken?.tokenString else {
                errorMessage = "Google returned no ID token."
                return
            }
            let credential = GoogleAuthProvider.credential(
                withIDToken: idToken,
                accessToken: result.user.accessToken.tokenString
            )
            try await Auth.auth().signIn(with: credential)
        } catch {
            // The user backing out of the sheet isn't an error worth showing.
            if (error as NSError).code == GIDSignInError.canceled.rawValue { return }
            errorMessage = error.localizedDescription
        }
    }

    func signOut() {
        GIDSignIn.sharedInstance.signOut()
        try? Auth.auth().signOut()
    }

    // MARK: - Presentation

    /// GoogleSignIn needs a UIViewController to present from, which SwiftUI
    /// does not hand out. Walk the active scene's key window instead.
    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first

        guard var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}
