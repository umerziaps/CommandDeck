import SwiftUI

struct SignInView: View {

    @Environment(AuthService.self) private var auth

    var body: some View {
        ZStack {
            DeckTheme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                Image("AppIconArt")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 78, height: 78)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(DeckTheme.hairline, lineWidth: 1)
                    }
                    .padding(.bottom, 20)

                Text("Command Deck")
                    .font(.deckDisplay(27))
                    .foregroundStyle(DeckTheme.ink)

                Text("Your board, synced across your phone and the web.")
                    .font(.system(size: 14))
                    .foregroundStyle(DeckTheme.inkSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
                    .padding(.horizontal, 40)

                Button {
                    Task { await auth.signInWithGoogle() }
                } label: {
                    HStack(spacing: 10) {
                        if auth.isWorking {
                            ProgressView().tint(DeckTheme.background)
                        } else {
                            Image(systemName: "person.crop.circle")
                        }
                        Text(auth.isWorking ? "Signing in…" : "Continue with Google")
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(DeckTheme.ink, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .foregroundStyle(DeckTheme.background)
                }
                .buttonStyle(.plain)
                .disabled(auth.isWorking)
                .padding(.horizontal, 34)
                .padding(.top, 34)

                if let error = auth.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(DeckTheme.signal)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 34)
                        .padding(.top, 16)
                }

                Spacer()

                Text("Only your own account can read this board.")
                    .font(.caption2)
                    .foregroundStyle(DeckTheme.inkTertiary)
                    .padding(.bottom, 24)
            }
        }
    }
}
