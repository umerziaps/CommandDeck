import SwiftUI

/// Edits one item.
///
/// The item is read live from the repository by id rather than captured
/// once, so a change made on the web while this screen is open shows up
/// here instead of being silently overwritten. Text fields keep a local
/// draft (typing into a value that a listener keeps replacing is
/// unusable) and commit on a short debounce.
struct ItemDetailView: View {

    let itemID: String

    @Environment(DeckRepository.self) private var repo
    @Environment(\.dismiss) private var dismiss

    @State private var titleDraft = ""
    @State private var waitingDraft = ""
    @State private var newSubtask = ""
    @State private var showDeleteConfirm = false
    @State private var didLoadDrafts = false
    @FocusState private var subtaskFocused: Bool

    private var item: Item? { repo.items.first { $0.id == itemID } }

    var body: some View {
        Group {
            if let item {
                form(item)
            } else {
                ContentUnavailableView(
                    "Item not found",
                    systemImage: "questionmark.folder",
                    description: Text("It may have been deleted on another device.")
                )
            }
        }
        .navigationTitle("Item")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard let item, !didLoadDrafts else { return }
            titleDraft = item.title
            waitingDraft = item.waitingOn
            didLoadDrafts = true
        }
        .onDisappear { commitDrafts() }
    }

    // MARK: - Form

    private func form(_ item: Item) -> some View {
        Form {
            titleSection(item)
            placementSection(item)
            categorySection(item)
            subtaskSection(item)
            dangerSection(item)
        }
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog(
            "Delete this item?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                repo.delete(item)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            let count = item.subs.count
            Text(count > 0
                 ? "Its \(count) sub-task\(count == 1 ? "" : "s") go too."
                 : "This can't be undone.")
        }
    }

    private func titleSection(_ item: Item) -> some View {
        Section {
            TextField("What needs doing?", text: $titleDraft, axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 16))
                .onChange(of: titleDraft) { _, new in
                    debounce(.title) { repo.setTitle(new, on: item) }
                }

            Toggle(isOn: Binding(
                get: { item.done },
                set: { _ in repo.toggleDone(item) }
            )) {
                Label("Done", systemImage: "checkmark.circle")
            }
            .tint(DeckTheme.accent)

            Toggle(isOn: Binding(
                get: { item.urgent },
                set: { _ in repo.toggleUrgent(item) }
            )) {
                Label("Urgent", systemImage: "exclamationmark.triangle.fill")
            }
            .tint(DeckTheme.signal)
        }
    }

    private func placementSection(_ item: Item) -> some View {
        Section("Placement") {
            Picker("Bucket", selection: Binding(
                get: { item.bucket },
                set: { repo.move(item, to: $0) }
            )) {
                ForEach(Bucket.allCases) { bucket in
                    Label(bucket.title, systemImage: bucket.symbol).tag(bucket)
                }
            }
            .pickerStyle(.segmented)

            if item.bucket == .waiting {
                TextField("Waiting on whom?", text: $waitingDraft)
                    .onChange(of: waitingDraft) { _, new in
                        debounce(.waiting) { repo.setWaitingOn(new, on: item) }
                    }
            }

            Toggle("Has a due date", isOn: Binding(
                get: { item.due != nil },
                set: { wants in
                    repo.setDue(wants ? Calendar.current.startOfDay(for: .now) : nil, on: item)
                }
            ))
            .tint(DeckTheme.accent)

            if let due = item.due {
                DatePicker(
                    "Due",
                    selection: Binding(get: { due }, set: { repo.setDue($0, on: item) }),
                    displayedComponents: .date
                )
            }
        }
    }

    private func categorySection(_ item: Item) -> some View {
        Section("Category") {
            if repo.categories.isEmpty {
                Text("No categories yet. Add some from the board's ⋯ menu.")
                    .font(.footnote)
                    .foregroundStyle(DeckTheme.inkTertiary)
            } else {
                Picker("Category", selection: Binding(
                    get: { item.catId },
                    set: { repo.setCategory($0, on: item) }
                )) {
                    Text("None").tag("")
                    ForEach(repo.categories) { category in
                        Label {
                            Text(category.name)
                        } icon: {
                            Image(systemName: "circle.fill").foregroundStyle(category.color)
                        }
                        .tag(category.id)
                    }
                }
            }
        }
    }

    private func subtaskSection(_ item: Item) -> some View {
        Section {
            ForEach(item.subs) { sub in
                HStack(spacing: 10) {
                    Button {
                        repo.toggleSubtask(sub, on: item)
                    } label: {
                        Image(systemName: sub.done ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(sub.done ? DeckTheme.accent : DeckTheme.inkTertiary)
                    }
                    .buttonStyle(.plain)

                    Text(sub.text)
                        .strikethrough(sub.done, color: DeckTheme.inkTertiary)
                        .foregroundStyle(sub.done ? DeckTheme.inkTertiary : DeckTheme.ink)
                }
                .swipeActions {
                    Button(role: .destructive) {
                        repo.deleteSubtask(sub, on: item)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }

            HStack {
                Image(systemName: "plus.circle").foregroundStyle(DeckTheme.accent)
                TextField("Add a sub-task", text: $newSubtask)
                    .focused($subtaskFocused)
                    .submitLabel(.done)
                    .onSubmit {
                        repo.addSubtask(newSubtask, to: item)
                        newSubtask = ""
                        subtaskFocused = true
                    }
            }
        } header: {
            HStack {
                Text("Sub-tasks")
                Spacer()
                if !item.subs.isEmpty {
                    Text("\(item.doneSubCount)/\(item.subs.count)").font(.deckMono(11))
                }
            }
        }
    }

    private func dangerSection(_ item: Item) -> some View {
        Section {
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete item", systemImage: "trash")
            }
        } footer: {
            Text("Captured \(item.createdAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption2)
        }
    }

    // MARK: - Debounced text commits

    private enum Field { case title, waiting }

    @State private var titleTask: Task<Void, Never>?
    @State private var waitingTask: Task<Void, Never>?

    private func debounce(_ field: Field, _ action: @escaping () -> Void) {
        let task = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            action()
        }
        switch field {
        case .title:
            titleTask?.cancel()
            titleTask = task
        case .waiting:
            waitingTask?.cancel()
            waitingTask = task
        }
    }

    /// Flush anything the debounce hasn't written yet.
    private func commitDrafts() {
        titleTask?.cancel()
        waitingTask?.cancel()
        guard let item else { return }
        repo.setTitle(titleDraft, on: item)
        if item.bucket == .waiting, waitingDraft != item.waitingOn {
            repo.setWaitingOn(waitingDraft, on: item)
        }
    }
}
