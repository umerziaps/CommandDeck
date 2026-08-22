import SwiftUI

struct DeckView: View {

    @Environment(DeckRepository.self) private var repo
    @Environment(AuthService.self) private var auth

    @AppStorage("appearanceMode") private var appearanceRaw = AppearanceMode.system.rawValue
    @AppStorage("remindersEnabled") private var remindersEnabled = true
    @AppStorage("hasAskedForNotifications") private var hasAskedForNotifications = false

    @State private var captureText = ""
    @FocusState private var captureFocused: Bool

    @State private var filter: CategoryFilter = .all
    @State private var collapsedBuckets: Set<String> = []
    @State private var doneCollapsed = true

    @State private var showCategoryManager = false
    @State private var showVault = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            list
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(DeckTheme.background)
                .navigationTitle("Command Deck")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .navigationDestination(for: String.self) { id in
                    ItemDetailView(itemID: id)
                }
                .safeAreaInset(edge: .top, spacing: 0) { categoryBar }
                .safeAreaInset(edge: .bottom, spacing: 0) { captureBar }
                .sheet(isPresented: $showCategoryManager) { CategoryManagerView() }
                .sheet(isPresented: $showVault) { VaultView() }
                .sheet(isPresented: $showSettings) { SettingsView() }
                .overlay { if repo.isLoading { loadingOverlay } }
                .task { await primeReminders() }
        }
    }

    // MARK: - List

    private var list: some View {
        List {
            headerRow
            if let error = repo.errorMessage { errorRow(error) }

            ForEach(Bucket.allCases) { bucket in
                bucketSection(bucket)
            }

            doneSection
            footerRow
        }
    }

    private var loadingOverlay: some View {
        ZStack {
            DeckTheme.background.opacity(0.85).ignoresSafeArea()
            ProgressView("Loading your board…")
                .font(.footnote)
                .tint(DeckTheme.accent)
        }
    }

    private var headerRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(greeting)
                .font(.deckDisplay(22))
                .foregroundStyle(DeckTheme.ink)
            Text(DeckDate.todayLine())
                .font(.system(size: 12.5))
                .foregroundStyle(DeckTheme.inkTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 10, trailing: 16))
    }

    private var greeting: String {
        let first = (auth.displayName ?? "").split(separator: " ").first.map(String.init)
        return DeckDate.greeting() + (first.map { ", \($0)" } ?? "")
    }

    private func errorRow(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(DeckTheme.signal)
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DeckTheme.card, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(DeckTheme.signal.opacity(0.5), lineWidth: 1)
            }
            .deckRow()
    }

    @ViewBuilder
    private func bucketSection(_ bucket: Bucket) -> some View {
        let items = repo.items(in: bucket, filter: filter)
        let isCollapsed = collapsedBuckets.contains(bucket.rawValue)

        Section {
            if !isCollapsed {
                if items.isEmpty {
                    Text(bucket.emptyMessage)
                        .font(.system(size: 12.5))
                        .italic()
                        .foregroundStyle(DeckTheme.inkTertiary)
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay {
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .strokeBorder(DeckTheme.hairline, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        }
                        .deckRow()
                } else {
                    ForEach(Array(items.enumerated()), id: \.element.id) { offset, item in
                        ItemRow(
                            item: item,
                            category: item.catId.isEmpty ? nil : repo.category(id: item.catId),
                            index: offset + 1
                        ) {
                            repo.toggleDone(item)
                        }
                        .deckRow()
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            doneAction(item)
                            urgentAction(item)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            deleteAction(item)
                            ForEach(Bucket.allCases.filter { $0 != item.bucket }) { target in
                                moveAction(item, to: target)
                            }
                        }
                    }
                    .onMove { source, destination in
                        var list = items
                        list.move(fromOffsets: source, toOffset: destination)
                        repo.applyOrder(list)
                    }
                }
            }
        } header: {
            sectionHeader(
                title: bucket.title,
                count: items.count,
                tint: bucket.tint,
                isCollapsed: isCollapsed
            ) {
                withAnimation {
                    if isCollapsed { collapsedBuckets.remove(bucket.rawValue) }
                    else { collapsedBuckets.insert(bucket.rawValue) }
                }
            }
        }
    }

    @ViewBuilder
    private var doneSection: some View {
        let items = repo.doneItems(filter: filter)
        if !items.isEmpty {
            Section {
                if !doneCollapsed {
                    ForEach(Array(items.prefix(50).enumerated()), id: \.element.id) { offset, item in
                        ItemRow(
                            item: item,
                            category: item.catId.isEmpty ? nil : repo.category(id: item.catId),
                            index: offset + 1
                        ) {
                            repo.toggleDone(item)
                        }
                        .deckRow()
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            deleteAction(item)
                        }
                    }
                }
            } header: {
                sectionHeader(
                    title: "Done",
                    count: items.count,
                    tint: DeckTheme.inkTertiary,
                    isCollapsed: doneCollapsed
                ) {
                    withAnimation { doneCollapsed.toggle() }
                }
            }
        }
    }

    private var footerRow: some View {
        let open = repo.items.filter { !$0.done && filter.matches($0) }
        let nowCount = open.filter { $0.bucket == .now }.count
        let waitingCount = open.filter { $0.bucket == .waiting }.count

        return Text("\(open.count) open · \(nowCount) now · \(waitingCount) waiting")
            .font(.deckMono(11))
            .foregroundStyle(DeckTheme.inkTertiary)
            .frame(maxWidth: .infinity, alignment: .center)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .padding(.top, 8)
    }

    private func sectionHeader(
        title: String,
        count: Int,
        tint: Color,
        isCollapsed: Bool,
        toggle: @escaping () -> Void
    ) -> some View {
        Button(action: toggle) {
            HStack(spacing: 9) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(DeckTheme.inkTertiary)
                    .rotationEffect(.degrees(isCollapsed ? -90 : 0))

                Circle().fill(tint).frame(width: 9, height: 9)

                Text(title)
                    .font(.deckDisplay(15))
                    .foregroundStyle(DeckTheme.ink)

                Text("\(count)")
                    .font(.deckMono(11))
                    .foregroundStyle(DeckTheme.inkTertiary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(DeckTheme.cardRaised, in: Capsule())

                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 6, trailing: 16))
        .listRowBackground(Color.clear)
    }

    // MARK: - Swipe actions

    private func doneAction(_ item: Item) -> some View {
        Button {
            repo.toggleDone(item)
        } label: {
            Label(item.done ? "Reopen" : "Done",
                  systemImage: item.done ? "arrow.uturn.backward" : "checkmark")
        }
        .tint(DeckTheme.accent)
    }

    private func urgentAction(_ item: Item) -> some View {
        Button {
            repo.toggleUrgent(item)
        } label: {
            Label(item.urgent ? "Clear" : "Urgent",
                  systemImage: item.urgent ? "bell.slash" : "exclamationmark.triangle.fill")
        }
        .tint(DeckTheme.signal)
    }

    private func deleteAction(_ item: Item) -> some View {
        Button(role: .destructive) {
            repo.delete(item)
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private func moveAction(_ item: Item, to bucket: Bucket) -> some View {
        Button {
            repo.move(item, to: bucket)
        } label: {
            Label(bucket.title, systemImage: bucket.symbol)
        }
        .tint(bucket.tint)
    }

    // MARK: - Capture

    private var captureBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(DeckTheme.accent)

            TextField("Capture anything…", text: $captureText)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .focused($captureFocused)
                .submitLabel(.done)
                .onSubmit(capture)

            Button(action: capture) {
                Text("Add")
                    .font(.system(size: 14, weight: .bold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(DeckTheme.accent, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .foregroundStyle(DeckTheme.background)
            }
            .buttonStyle(.plain)
            .disabled(captureText.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(captureText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.45 : 1)
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(DeckTheme.card, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(captureFocused ? DeckTheme.accent : DeckTheme.hairline, lineWidth: 1.5)
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.bar)
    }

    private func capture() {
        let presetCategory: String = if case .category(let id) = filter { id } else { "" }
        repo.capture(captureText, catId: presetCategory)
        captureText = ""
        captureFocused = true
    }

    // MARK: - Category bar

    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                let active = repo.items.filter { !$0.done }

                chip(label: "All", count: active.count, color: DeckTheme.ink, isOn: filter == .all) {
                    filter = .all
                }

                ForEach(repo.categories) { category in
                    chip(
                        label: category.name,
                        count: active.filter { $0.catId == category.id }.count,
                        color: category.color,
                        isOn: filter == .category(category.id)
                    ) {
                        filter = filter == .category(category.id) ? .all : .category(category.id)
                    }
                }

                let uncategorized = active.filter { $0.catId.isEmpty }.count
                if uncategorized > 0 || filter == .uncategorized {
                    chip(
                        label: "Uncategorized",
                        count: uncategorized,
                        color: DeckTheme.inkTertiary,
                        isOn: filter == .uncategorized
                    ) {
                        filter = filter == .uncategorized ? .all : .uncategorized
                    }
                }

                Button {
                    showCategoryManager = true
                } label: {
                    Label("Edit", systemImage: "slider.horizontal.3")
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .foregroundStyle(DeckTheme.inkTertiary)
                        .overlay {
                            Capsule().strokeBorder(
                                DeckTheme.hairline,
                                style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                            )
                        }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func chip(
        label: String,
        count: Int,
        color: Color,
        isOn: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Circle()
                    .fill(isOn ? DeckTheme.background : color)
                    .frame(width: 7, height: 7)
                Text(label)
                    .font(.system(size: 12.5, weight: .semibold))
                Text("\(count)")
                    .font(.deckMono(10))
                    .opacity(0.75)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(isOn ? DeckTheme.background : color)
            .background(isOn ? color : Color.clear, in: Capsule())
            .overlay { Capsule().strokeBorder(color.opacity(isOn ? 0 : 0.55), lineWidth: 1.5) }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            syncIndicator
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { showVault = true } label: {
                    Label("Notes & Logins", systemImage: "lock.doc")
                }
                Button { showCategoryManager = true } label: {
                    Label("Categories", systemImage: "tag")
                }

                Divider()

                Picker("Appearance", selection: $appearanceRaw) {
                    ForEach(AppearanceMode.allCases) { mode in
                        Label(mode.label, systemImage: mode.symbol).tag(mode.rawValue)
                    }
                }

                Divider()

                Button { showSettings = true } label: {
                    Label("Settings & Backup", systemImage: "gearshape")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    @ViewBuilder
    private var syncIndicator: some View {
        if repo.hasPendingWrites {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(DeckTheme.later)
                .accessibilityLabel("Saving")
        } else if repo.isFromCache {
            Image(systemName: "wifi.slash")
                .foregroundStyle(DeckTheme.waiting)
                .accessibilityLabel("Offline — changes are queued")
        }
    }

    // MARK: - Reminders

    private func primeReminders() async {
        guard remindersEnabled else { return }
        if !hasAskedForNotifications {
            hasAskedForNotifications = true
            await NotificationScheduler.shared.requestAuthorization()
        }
    }
}

// MARK: - Row styling

extension View {
    /// Shared chrome for every card row: transparent list background,
    /// no separators, consistent insets.
    func deckRow() -> some View {
        self
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 14, bottom: 4, trailing: 14))
    }
}
