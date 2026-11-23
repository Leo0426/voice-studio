import SwiftUI

enum SpeechProvider { case local, openAI }

struct WorkspaceView: View {
    let service: LocalWorkspaceService
    let account: DesktopAccount

    var body: some View {
        workspace
            .frame(minWidth: 740, minHeight: 510)
            .toolbar { workspaceToolbar }
            .alert("设备工作台", isPresented: showingDeviceNotice) {
                Button("好") { account.deviceNotice = nil }
            } message: { Text(account.deviceNotice ?? "") }
            .onChange(of: service.origin) { if service.origin == nil { account.reset() } }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                Task { await account.refresh() }
            }
    }

    @ViewBuilder private var workspace: some View {
        Group {
            if let origin = service.origin {
                ZStack {
                    AccountWebView(origin: origin, account: account)
                        .id(origin)
                        .opacity(account.model == nil ? 1 : 0)
                        .allowsHitTesting(account.model == nil)
                        .accessibilityHidden(account.model != nil)
                    if let model = account.model {
                        DeviceWorkspace(model: model, openHistory: account.navigateToHistory).id(ObjectIdentifier(model))
                    }
                }
            } else {
                VStack(spacing: 14) {
                    if let error = service.error {
                        Text(error)
                        Button("重新启动本机服务") { service.start() }
                    } else { ProgressView("正在启动本机工作台…") }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ToolbarContentBuilder private var workspaceToolbar: some ToolbarContent {
        if account.model != nil {
            ToolbarItem { Button("返回工作台", systemImage: "chevron.backward") { account.leaveDevice() } }
        } else if account.session?.mayUseDevice == true {
            ToolbarItem { Button("设备工作台") { Task { await account.enterDevice() } } }
        } else if account.session?.needsSetup == true {
            ToolbarItem {
                Button(account.copiedCode ? "已复制首次设置码" : "复制首次设置码") {
                    Task { await account.copySetupCode() }
                }
            }
        }
    }

    private var showingDeviceNotice: Binding<Bool> {
        Binding(get: { account.deviceNotice != nil }, set: { if !$0 { account.deviceNotice = nil } })
    }
}

enum DeviceSheet: String, Identifiable { case downloads, settings; var id: String { rawValue } }

private struct DeviceWorkspace: View {
    @Bindable var model: AppModel
    let openHistory: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Qwen 设备工作台", systemImage: "waveform")
                    .font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("任务历史", systemImage: "clock.arrow.circlepath", action: openHistory)
                    .disabled(model.isSynthesizing || model.savingHistory)
                Button("模型下载", systemImage: "arrow.down.circle") { model.present(.downloads) }
                Button("设备设置", systemImage: "gearshape") { model.present(.settings) }
            }.padding(.horizontal, 20).padding(.top, 16)
            MainView(model: model)
        }
        .background(Studio.ink)
        .sheet(item: $model.sheet) { sheet in
            VStack(alignment: .trailing) {
                if sheet == .downloads {
                    ModelDownloadView(model: model, settings: model.settings)
                } else {
                    SettingsView(model: model, settings: model.settings)
                }
                Button("完成") { model.sheet = nil }.keyboardShortcut(.cancelAction).padding([.bottom, .trailing])
            }.studioWindow()
        }
        .onChange(of: model.settings.modelRepo) { model.applyModelSelection() }
        .onChange(of: model.settings.downloadSource) { model.applyDownloadSource() }
        .onChange(of: model.settings.customEndpoint) { model.applyDownloadSource() }
        .onChange(of: model.settings.speakShortcutID) { model.applySpeakShortcut() }
    }
}
