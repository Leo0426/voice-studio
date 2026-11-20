import SwiftUI

struct MenuBarContent: View {
    let account: DesktopAccount
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("打开 Voice Studio") {
            openWindow(id: "main")
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        if let model = account.model {
            Button(model.isSpeaking ? "停止朗读" : "朗读剪贴板") { model.toggleSpeakClipboard() }
        }
        Divider()
        Button("退出") { NSApplication.shared.terminate(nil) }
    }
}
