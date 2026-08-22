import LocalAuthentication
import SwiftData
import SwiftUI
import UIKit

/// The "Notes & logins" panel — deliberately the one thing that does NOT
/// sync. It stays in local SwiftData on this device, and anything that
/// looks like a credential stays masked until Face ID (or the device
/// passcode) says otherwise. Nothing here ever reaches Firestore or the
/// web client.
struct VaultView: View {

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @Query(sort: \VaultNote.createdAt, order: .reverse) private var notes: [VaultNote]

    @State private var newLabel = ""
    @State private var newValue = ""
    @State private var revealed: Set<String> = []
    @State private var pendingDelete: VaultNote?
    @State private var copiedID: String?

    var body: some View {
        NavigationStack {
            Form {
                addSection
                listSection
            }
            .navigationTitle("Notes & Logins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete this entry?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let note = pendingDelete {
                        context.delete(note)
                        try? context.save()
                    }
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            }
        }
        .tint(DeckTheme.accent)
    }

    // MARK: - Sections

    private var addSection: some View {
        Section {
            TextField("Label (e.g. Staging login)", text: $newLabel)
                .autocorrectionDisabled()
            TextField("Value / note / URL", text: $newValue, axis: .vertical)
                .lineLimit(1...4)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            Button("Add entry", action: add)
                .disabled(newLabel.trimmingCharacters(in: .whitespaces).isEmpty)
        } footer: {
            Label(
                "Stored only on this device — never synced to Firestore or the web app. Good for staging logins and scratch notes, but not a password manager: keep production and client credentials in a real one.",
                systemImage: "exclamationmark.shield"
            )
            .font(.caption)
        }
    }

    @ViewBuilder
    private var listSection: some View {
        if notes.isEmpty {
            Section {
                Text("Nothing saved yet.")
                    .font(.footnote)
                    .foregroundStyle(DeckTheme.inkTertiary)
            }
        } else {
            Section("Saved") {
                ForEach(notes) { note in
                    noteRow(note)
                        .swipeActions {
                            Button(role: .destructive) {
                                pendingDelete = note
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
            }
        }
    }

    private func noteRow(_ note: VaultNote) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(note.label)
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                if note.isSecret {
                    Image(systemName: isRevealed(note) ? "lock.open" : "lock.fill")
                        .font(.caption)
                        .foregroundStyle(DeckTheme.inkTertiary)
                }
            }

            Text(displayValue(for: note))
                .font(.deckMono(12.5))
                .foregroundStyle(isMasked(note) ? DeckTheme.inkTertiary : DeckTheme.inkSecondary)
                .textSelection(.enabled)
                .lineLimit(4)

            HStack(spacing: 14) {
                if note.isSecret {
                    Button(isRevealed(note) ? "Hide" : "Reveal") {
                        toggleReveal(note)
                    }
                }
                Button(copiedID == note.uid ? "Copied" : "Copy") {
                    copy(note)
                }
                Spacer()
            }
            .font(.system(size: 12, weight: .semibold))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Reveal

    private func isRevealed(_ note: VaultNote) -> Bool {
        revealed.contains(note.uid)
    }

    private func isMasked(_ note: VaultNote) -> Bool {
        note.isSecret && !isRevealed(note)
    }

    private func displayValue(for note: VaultNote) -> String {
        isMasked(note) ? "••••••••" : (note.value.isEmpty ? "—" : note.value)
    }

    private func toggleReveal(_ note: VaultNote) {
        if isRevealed(note) {
            revealed.remove(note.uid)
            return
        }
        Task {
            if await authenticate(reason: "Reveal “\(note.label)”") {
                revealed.insert(note.uid)
            }
        }
    }

    private func copy(_ note: VaultNote) {
        Task {
            if note.isSecret, !isRevealed(note) {
                guard await authenticate(reason: "Copy “\(note.label)”") else { return }
            }
            UIPasteboard.general.string = note.value
            copiedID = note.uid
            try? await Task.sleep(for: .seconds(1.6))
            if copiedID == note.uid { copiedID = nil }
        }
    }

    /// Falls through when the device has no passcode set — there is no
    /// secure factor to check against, and blocking access would just
    /// make the data unreachable.
    private func authenticate(reason: String) async -> Bool {
        let laContext = LAContext()
        var error: NSError?
        guard laContext.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return true
        }
        return (try? await laContext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    // MARK: - Actions

    private func add() {
        let label = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }

        context.insert(VaultNote(
            label: label,
            value: newValue.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
        try? context.save()

        newLabel = ""
        newValue = ""
    }
}
