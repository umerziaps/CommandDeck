import SwiftUI

struct CategoryManagerView: View {

    @Environment(DeckRepository.self) private var repo
    @Environment(\.dismiss) private var dismiss

    @State private var newName = ""
    @State private var pendingDelete: ItemCategory?
    @State private var duplicateWarning = false
    @State private var renameDrafts: [String: String] = [:]
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("New category", text: $newName)
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .onSubmit(add)
                        Button("Add", action: add)
                            .buttonStyle(.borderless)
                            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } footer: {
                    if duplicateWarning {
                        Text("A category with that name already exists.")
                            .foregroundStyle(DeckTheme.signal)
                    }
                }

                if repo.categories.isEmpty {
                    Section {
                        Text("No categories yet. Add your first above — items you file under one get its colour on the board.")
                            .font(.footnote)
                            .foregroundStyle(DeckTheme.inkTertiary)
                    }
                } else {
                    ForEach(repo.categories) { category in
                        Section {
                            categoryEditor(category)
                        }
                    }
                }
            }
            .navigationTitle("Categories")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete category?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let category = pendingDelete { repo.deleteCategory(category) }
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: {
                if let category = pendingDelete {
                    let count = repo.items.filter { $0.catId == category.id }.count
                    Text(count > 0
                         ? "\(count) item\(count == 1 ? "" : "s") will become uncategorized. Nothing is deleted."
                         : "This category isn't used by any item.")
                }
            }
        }
    }

    // MARK: - Editor

    @ViewBuilder
    private func categoryEditor(_ category: ItemCategory) -> some View {
        let count = repo.items.filter { $0.catId == category.id }.count

        HStack {
            Circle().fill(category.color).frame(width: 12, height: 12)

            TextField("Name", text: Binding(
                get: { renameDrafts[category.id] ?? category.name },
                set: { renameDrafts[category.id] = $0 }
            ))
            .font(.system(size: 15, weight: .semibold))
            .onSubmit { commitRename(category) }

            Text("\(count)")
                .font(.deckMono(11))
                .foregroundStyle(DeckTheme.inkTertiary)

            Button {
                pendingDelete = category
            } label: {
                Image(systemName: "trash").foregroundStyle(DeckTheme.signal)
            }
            .buttonStyle(.borderless)
        }

        swatchRow(for: category)
    }

    private func swatchRow(for category: ItemCategory) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 10), spacing: 8) {
            ForEach(DeckTheme.categoryPalette, id: \.self) { hex in
                Button {
                    repo.recolorCategory(category, to: hex)
                } label: {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(hex: hex) ?? .gray)
                        .frame(height: 22)
                        .overlay {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(category.colorHex == hex ? DeckTheme.ink : .clear, lineWidth: 2)
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Actions

    private func commitRename(_ category: ItemCategory) {
        guard let draft = renameDrafts[category.id] else { return }
        repo.renameCategory(category, to: draft)
        renameDrafts[category.id] = nil
    }

    private func add() {
        let trimmed = newName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        if repo.addCategory(named: trimmed) == nil {
            duplicateWarning = true
            return
        }
        duplicateWarning = false
        newName = ""
        nameFocused = true
    }
}
