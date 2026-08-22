import SwiftData
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {

    @Environment(DeckRepository.self) private var repo
    @Environment(AuthService.self) private var auth
    @Environment(\.modelContext) private var vaultContext
    @Environment(\.dismiss) private var dismiss

    /// Vault notes are the one thing still stored locally in SwiftData.
    @Query(sort: \VaultNote.createdAt) private var notes: [VaultNote]

    @AppStorage("appearanceMode") private var appearanceRaw = AppearanceMode.system.rawValue
    @AppStorage("remindersEnabled") private var remindersEnabled = true
    @AppStorage("reminderHour") private var reminderHour = 9

    @State private var exportDocument: BackupDocument?
    @State private var showExporter = false
    @State private var showImporter = false
    @State private var pendingImport: Data?
    @State private var isRestoring = false
    @State private var message: DeckMessage?

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                appearanceSection
                remindersSection
                backupSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .disabled(isRestoring)
            .overlay {
                if isRestoring {
                    ZStack {
                        Color.black.opacity(0.35).ignoresSafeArea()
                        ProgressView("Restoring…").tint(DeckTheme.accent)
                    }
                }
            }
            .fileExporter(
                isPresented: $showExporter,
                document: exportDocument,
                contentType: .json,
                defaultFilename: BackupService.suggestedFilename()
            ) { result in
                switch result {
                case .success: message = DeckMessage(title: "Backup saved", body: nil)
                case .failure(let error): message = DeckMessage(title: "Export failed", body: error.localizedDescription)
                }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
                handleImportSelection(result)
            }
            .confirmationDialog(
                "Restore backup?",
                isPresented: Binding(
                    get: { pendingImport != nil },
                    set: { if !$0 { pendingImport = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Replace everything", role: .destructive) {
                    Task { await performRestore() }
                }
                Button("Cancel", role: .cancel) { pendingImport = nil }
            } message: {
                Text("This replaces every item and category on your account — on this phone and on the web — plus the notes stored on this device.")
            }
            .alert(
                message?.title ?? "",
                isPresented: Binding(
                    get: { message != nil },
                    set: { if !$0 { message = nil } }
                ),
                presenting: message
            ) { _ in
                Button("OK", role: .cancel) {}
            } message: { msg in
                if let body = msg.body { Text(body) }
            }
        }
    }

    // MARK: - Sections

    private var accountSection: some View {
        Section {
            LabeledContent("Signed in as") {
                Text(auth.email ?? auth.displayName ?? "—")
                    .font(.footnote)
                    .foregroundStyle(DeckTheme.inkSecondary)
            }

            HStack {
                syncLabel
                Spacer()
            }

            Button(role: .destructive) {
                auth.signOut()
                dismiss()
            } label: {
                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } header: {
            Text("Account")
        } footer: {
            Text("Your board syncs through Firestore under your Google account. The same account on the web shows the same board.")
        }
    }

    @ViewBuilder
    private var syncLabel: some View {
        if repo.hasPendingWrites {
            Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(DeckTheme.later)
        } else if repo.isFromCache {
            Label("Offline — changes queued", systemImage: "wifi.slash")
                .foregroundStyle(DeckTheme.waiting)
        } else {
            Label("Synced", systemImage: "checkmark.circle")
                .foregroundStyle(DeckTheme.accent)
        }
    }

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Theme", selection: $appearanceRaw) {
                ForEach(AppearanceMode.allCases) { mode in
                    Text(mode.label).tag(mode.rawValue)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var remindersSection: some View {
        Section {
            Toggle("Remind me about due items", isOn: $remindersEnabled)
                .tint(DeckTheme.accent)
                .onChange(of: remindersEnabled) { _, enabled in
                    Task {
                        if enabled { await NotificationScheduler.shared.requestAuthorization() }
                        NotificationScheduler.shared.rescheduleAll(repo.items)
                    }
                }

            if remindersEnabled {
                Picker("Remind at", selection: $reminderHour) {
                    ForEach(0..<24, id: \.self) { hour in
                        Text(hourLabel(hour)).tag(hour)
                    }
                }
                .onChange(of: reminderHour) { _, _ in
                    NotificationScheduler.shared.rescheduleAll(repo.items)
                }
            }
        } header: {
            Text("Reminders")
        } footer: {
            Text("Local notifications on the morning an item is due — no push service, no paid membership needed.")
        }
    }

    private var backupSection: some View {
        Section {
            Button {
                prepareExport()
            } label: {
                Label("Export backup", systemImage: "square.and.arrow.up")
            }

            Button {
                showImporter = true
            } label: {
                Label("Restore from backup", systemImage: "square.and.arrow.down")
            }
        } header: {
            Text("Backup")
        } footer: {
            Text("Same JSON the web app reads and writes. \(repo.items.count) items · \(repo.categories.count) categories · \(notes.count) notes.")
        }
    }

    // MARK: - Actions

    private func hourLabel(_ hour: Int) -> String {
        var components = DateComponents()
        components.hour = hour
        components.minute = 0
        let date = Calendar.current.date(from: components) ?? .now
        return date.formatted(date: .omitted, time: .shortened)
    }

    private func prepareExport() {
        do {
            let data = try BackupService.export(
                items: repo.items,
                categories: repo.categories,
                notes: notes,
                theme: appearanceRaw == AppearanceMode.light.rawValue ? "light" : "dark"
            )
            exportDocument = BackupDocument(data: data)
            showExporter = true
        } catch {
            message = DeckMessage(title: "Export failed", body: error.localizedDescription)
        }
    }

    private func handleImportSelection(_ result: Result<URL, Error>) {
        switch result {
        case .failure(let error):
            message = DeckMessage(title: "Could not open that file", body: error.localizedDescription)

        case .success(let url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                pendingImport = try Data(contentsOf: url)
            } catch {
                message = DeckMessage(title: "Could not read that file", body: error.localizedDescription)
            }
        }
    }

    private func performRestore() async {
        guard let data = pendingImport else { return }
        pendingImport = nil
        isRestoring = true
        defer { isRestoring = false }

        do {
            let payload = try BackupService.decode(data)
            let (items, categories) = BackupService.materialise(payload)
            try await repo.restore(items: items, categories: categories)

            // Vault notes are device-local, so they're replaced here rather
            // than through the repository.
            try? vaultContext.delete(model: VaultNote.self)
            for note in payload.ref {
                vaultContext.insert(VaultNote(uid: note.id, label: note.label, value: note.value))
            }
            try? vaultContext.save()

            appearanceRaw = payload.theme == "light"
                ? AppearanceMode.light.rawValue
                : AppearanceMode.dark.rawValue

            message = DeckMessage(
                title: "Backup restored",
                body: "\(payload.items.count) items, \(payload.cats.count) categories, \(payload.ref.count) notes."
            )
        } catch {
            message = DeckMessage(title: "Restore failed", body: error.localizedDescription)
        }
    }
}

// MARK: - Alert payload

struct DeckMessage: Identifiable {
    let id = UUID()
    let title: String
    let body: String?
}
