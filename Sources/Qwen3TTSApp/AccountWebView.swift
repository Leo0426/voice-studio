import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct AccountWebView: NSViewRepresentable {
    let origin: URL
    let account: DesktopAccount

    func makeCoordinator() -> Coordinator { Coordinator(origin: origin, account: account) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "voiceStudioSession")
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        account.attach(view, origin: origin)
        view.load(URLRequest(url: origin))
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        if coordinator.account.browser === view { coordinator.account.reset() }
        view.configuration.userContentController.removeScriptMessageHandler(forName: "voiceStudioSession")
        view.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
        let origin: URL
        let account: DesktopAccount
        init(origin: URL, account: DesktopAccount) { self.origin = origin; self.account = account }

        private func trusted(_ securityOrigin: WKSecurityOrigin) -> Bool {
            securityOrigin.protocol == "http" && securityOrigin.host == "127.0.0.1" && securityOrigin.port == origin.port
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            let url = action.request.url
            if action.shouldPerformDownload, action.sourceFrame.isMainFrame, trusted(action.sourceFrame.securityOrigin),
               let url, url.scheme == "blob", url.absoluteString.hasPrefix("blob:\(origin.absoluteString)/") { return .download }
            guard action.targetFrame?.isMainFrame == true, LocalWorkspaceService.sameOrigin(url, as: origin) else { return .cancel }
            return .allow
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            response.isForMainFrame && LocalWorkspaceService.sameOrigin(response.response.url, as: origin) ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { account.sessionChanged() }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { Task { await account.refresh() } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { account.sessionChanged(); webView.reload() }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, trusted(message.frameInfo.securityOrigin),
                  message.name == "voiceStudioSession", message.body as? String == "refresh" else { return }
            account.sessionChanged()
            Task { await account.refresh() }
        }

        func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                     initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
            guard frame.isMainFrame, trusted(origin), type == .microphone else { return .deny }
            await account.refresh()
            guard let session = account.session, !session.permissions.isDisjoint(with: ["stt.local", "stt.openai"]) else { return .deny }
            return .prompt
        }

        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping ([URL]?) -> Void) {
            guard frame.isMainFrame, trusted(frame.securityOrigin), let window = webView.window else { completionHandler(nil); return }
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            guard let view = account.browser, let window = view.window, LocalWorkspaceService.sameOrigin(view.url, as: origin) else { return nil }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let choice = await panel.beginSheetModal(for: window)
            guard choice == .OK else { return nil }
            return panel.url
        }
    }
}
