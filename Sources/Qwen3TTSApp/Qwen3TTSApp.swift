import AppKit
import SwiftUI

@main
struct Qwen3TTSApp: App {
    @State private var service = LocalWorkspaceService()
    @State private var account = DesktopAccount()
    @NSApplicationDelegateAdaptor(WorkspaceAppDelegate.self) private var delegate

    init() {
        NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        Window("Voice Studio", id: "main") {
            WorkspaceView(service: service, account: account)
                .studioWindow()
                .onAppear {
                    delegate.shutdown = { account.reset(); await service.stop()?.value }
                    service.start()
                }
        }
        .defaultSize(width: 1160, height: 760)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("账号管理…") { account.navigateToAccount() }
                    .keyboardShortcut(",")
                if let model = account.model {
                    Button("设备设置…") { model.present(.settings) }
                }
            }
        }
        MenuBarExtra("Voice Studio", systemImage: "waveform") { MenuBarContent(account: account) }
    }
}

@MainActor
final class WorkspaceAppDelegate: NSObject, NSApplicationDelegate {
    var shutdown: (() async -> Void)?
    private var terminating = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let shutdown else { return .terminateNow }
        if !terminating {
            terminating = true
            Task { await shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}
