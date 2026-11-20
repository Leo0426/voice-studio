import AppKit
import Foundation
import Observation
import WebKit

struct DesktopIdentity: Decodable, Equatable {
    struct User: Decodable, Equatable { let id: String }
    let needsSetup: Bool
    let user: User?
    let permissions: Set<String>
    var mayUseDevice: Bool { user != nil && permissions.isSuperset(of: ["desktop.manage", "tts.local"]) }
}

@MainActor @Observable
final class DesktopAccount {
    private(set) var session: DesktopIdentity?
    private(set) var model: AppModel?
    private(set) var copiedCode = false
    var deviceNotice: String?
    @ObservationIgnored weak var browser: WKWebView?
    @ObservationIgnored private var origin: URL?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var refreshNumber = 0
    @ObservationIgnored private var poll: Task<Void, Never>?

    func attach(_ browser: WKWebView, origin: URL) {
        reset()
        self.browser = browser
        self.origin = origin
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.model == nil ? 6 : 1))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func leaveDevice() {
        model?.lockDevice()
        model = nil
    }

    func sessionChanged() {
        revision += 1
        leaveDevice()
        session = nil
        copiedCode = false
        deviceNotice = nil
    }

    func reset() {
        poll?.cancel()
        browser = nil
        origin = nil
        sessionChanged()
    }

    private func fetch(authorize: Bool, entering: Bool = false) async -> DesktopIdentity? {
        guard let browser, let origin, LocalWorkspaceService.sameOrigin(browser.url, as: origin) else { return nil }
        let js = """
            if (location.origin !== expectedOrigin) return null;
            const headers = {};
            const proof = localStorage.getItem('voice-studio.session-proof');
            if (proof) headers['X-Voice-Proof'] = proof;
            const options = { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(4000), headers };
            if (authorize) { headers['Content-Type'] = 'application/json'; options.method = 'POST'; options.body = JSON.stringify({enter: entering}); }
            const res = await fetch(authorize ? '/api/auth/desktop-authorize' : '/api/auth/session', options);
            return res.ok ? JSON.stringify(await res.json()) : null;
            """
        // 在原生独立脚本世界中同源 fetch。HttpOnly cookie 始终由 WebKit 管理。
        let value = try? await browser.callAsyncJavaScript(js, arguments: ["expectedOrigin": origin.absoluteString,
            "authorize": authorize, "entering": entering], in: nil, contentWorld: .defaultClient)
        guard let text = value as? String, text.utf8.count < 32_768 else { return nil }
        return try? JSONDecoder().decode(DesktopIdentity.self, from: Data(text.utf8))
    }

    func refresh() async {
        let generation = revision
        refreshNumber += 1
        let request = refreshNumber
        let updated = await fetch(authorize: false)
        guard generation == revision, request == refreshNumber else { return }
        if updated?.user?.id != session?.user?.id || updated?.mayUseDevice != true { leaveDevice() }
        session = updated
        if updated?.needsSetup != true { copiedCode = false }
    }

    func enterDevice() async {
        guard model == nil, let id = session?.user?.id, session?.mayUseDevice == true else { return }
        let generation = revision
        guard await authorize(userID: id, generation: generation, entering: true), model == nil else { return }
        let access = DeviceAccess { [weak self] complete in
            Task { @MainActor in
                guard let self else { complete(false); return }
                complete(await self.authorize(userID: id, generation: generation))
            }
        }
        guard let browser, let origin, let history = await DeviceTaskHistory.bind(to: browser, origin: origin, owner: id),
              generation == revision, session?.user?.id == id, model == nil else {
            if generation == revision && model == nil { deviceNotice = "无法连接你的任务历史，请重新登录。" }
            return
        }
        model = AppModel(deviceAccess: access, writeHistory: { try await history.save($0, result: $1) })
    }

    private func authorize(userID: String, generation: Int, entering: Bool = false) async -> Bool {
        guard generation == revision, session?.user?.id == userID else { return false }
        let result = await fetch(authorize: true, entering: entering)
        guard generation == revision, session?.user?.id == userID else { return false }
        guard result?.user?.id == userID, result?.mayUseDevice == true else {
            sessionChanged()
            await refresh()
            return false
        }
        return true
    }

    func copySetupCode() async {
        await refresh()
        guard session?.needsSetup == true, session?.user == nil else { return }
        let database = ProcessInfo.processInfo.environment["VOICE_STUDIO_AUTH_DB"].map(URL.init(fileURLWithPath:)) ??
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Voice Studio/access.sqlite")
        guard let text = try? String(contentsOf: Self.setupCodeURL(database: database), encoding: .utf8) else { return }
        let code = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, code.utf8.count <= 256 else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(code, forType: .string)
        pasteboard.setData(Data(), forType: .init("org.nspasteboard.ConcealedType"))
        copiedCode = true
    }

    static func setupCodeURL(database: URL) -> URL {
        let name = database.lastPathComponent == "access.sqlite" ? "bootstrap-code" : database.lastPathComponent + ".bootstrap-code"
        return database.deletingLastPathComponent().appendingPathComponent(name)
    }

    func navigateToHistory() { navigate(to: "history.html") }

    func navigateToAccount() { navigate(to: "account.html") }

    private func navigate(to page: String) {
        leaveDevice()
        guard let origin, let browser else { return }
        browser.load(URLRequest(url: origin.appendingPathComponent(page)))
    }
}
