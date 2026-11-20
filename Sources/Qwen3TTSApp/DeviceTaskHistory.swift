import Foundation
import TTSCore
import WebKit

struct DeviceSynthesisTask: Sendable {
    let id = UUID()
    let label: String

    init(text: String, voice: String) {
        let title = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") + " · " + voice
        label = String(String.UnicodeScalarView(title.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(80)))
    }
}

enum DeviceSynthesisResult: Sendable {
    case completed(samples: [Float], rate: Double)
    case failed
    case cancelled

    var status: String {
        switch self { case .completed: "completed"; case .failed: "failed"; case .cancelled: "cancelled" }
    }
}

typealias DeviceHistoryWriter = @Sendable (DeviceSynthesisTask, DeviceSynthesisResult) async throws -> Void

/// 捕获进入设备工作台时的独立会话，历史提交不会改用另一个登录账号的凭据。
struct DeviceTaskHistory: Sendable {
    private let origin: URL
    private let owner: String
    private let proof: String
    private let cookie: String
    private let upload: @Sendable (URLRequest, URL?) async throws -> (Data, URLResponse)
    private static let transport: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0]
        return URLSession(configuration: config, delegate: NoHistoryRedirects(), delegateQueue: nil)
    }()

    init?(origin: URL, owner: String, proof: String, cookies: [HTTPCookie],
          upload: @escaping @Sendable (URLRequest, URL?) async throws -> (Data, URLResponse) = { request, file in
              if let file { return try await transport.upload(for: request, fromFile: file) }
              return try await transport.data(for: request)
          }) {
        guard let port = origin.port, (1...65535).contains(port), origin.absoluteString == "http://127.0.0.1:\(port)",
              UUID(uuidString: owner) != nil, Self.token(proof, length: 21) else { return nil }
        let name = "voice_studio_session_\(port)"
        let matches = cookies.filter { $0.name == name && $0.domain == "127.0.0.1" && $0.path == "/api" && $0.isHTTPOnly }
        guard matches.count == 1, let value = matches.first?.value, Self.token(value, length: 22) else { return nil }
        self.origin = origin
        self.owner = owner
        self.proof = proof
        self.cookie = name + "=" + value
        self.upload = upload
    }

    private static func token(_ text: String, length: Int) -> Bool {
        text.utf8.count == length && text.utf8.allSatisfy { byte in
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 45 || byte == 95
        }
    }

    @MainActor static func bind(to browser: WKWebView, origin: URL, owner: String) async -> DeviceTaskHistory? {
        guard LocalWorkspaceService.sameOrigin(browser.url, as: origin) else { return nil }
        let js = "return location.origin === expected ? localStorage.getItem('voice-studio.session-proof') : null"
        guard let proof = try? await browser.callAsyncJavaScript(js, arguments: ["expected": origin.absoluteString], in: nil,
                                                                 contentWorld: .defaultClient) as? String else { return nil }
        let cookies = await browser.configuration.websiteDataStore.httpCookieStore.allCookies()
        guard LocalWorkspaceService.sameOrigin(browser.url, as: origin) else { return nil }
        return DeviceTaskHistory(origin: origin, owner: owner, proof: proof, cookies: cookies)
    }

    func save(_ task: DeviceSynthesisTask, result: DeviceSynthesisResult) async throws {
        var request = URLRequest(url: origin.appendingPathComponent("api/history/native/\(task.id.uuidString.lowercased())"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.httpShouldHandleCookies = false
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue(owner, forHTTPHeaderField: "X-Voice-Actor")
        request.setValue(proof, forHTTPHeaderField: "X-Voice-Proof")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        request.setValue(task.label.addingPercentEncoding(withAllowedCharacters: safe), forHTTPHeaderField: "X-Voice-Label")
        request.setValue(result.status, forHTTPHeaderField: "X-Voice-Status")
        var file: URL?
        var temporary: URL?
        defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
        if case let .completed(samples, rate) = result {
            guard !samples.isEmpty, samples.count <= (512 * 1024 * 1024 - 44) / 4,
                  rate.isFinite, rate >= 1, rate <= 384_000 else { throw DeviceHistoryError.invalidAudio }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-task-\(UUID())", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            temporary = directory
            let wav = directory.appendingPathComponent("result.wav")
            try WavFile.write(samples: samples, sampleRate: rate, to: wav)
            file = wav
            request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        }
        for attempt in 1...2 {
            do {
                let (data, response) = try await upload(request, file)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if attempt == 1, (500..<600).contains(status) { continue }
                guard status == 200, response.url == request.url else { throw DeviceHistoryError.service(status) }
                struct Receipt: Decodable { let id: UUID }
                guard try JSONDecoder().decode(Receipt.self, from: data).id == task.id else { throw DeviceHistoryError.service(0) }
                return
            } catch let error as URLError where attempt == 1 && error.code != .cancelled {
                continue
            }
        }
    }
}

private enum DeviceHistoryError: LocalizedError {
    case invalidAudio, service(Int)
    var errorDescription: String? {
        switch self {
        case .invalidAudio: "音频为空或超过单个任务的 512 MiB 上限。"
        case .service(401), .service(403): "会话已失效或没有保存该任务的权限。"
        case .service(409): "该任务与当前账号或已保存的文件不符。"
        default: "本机任务服务未确认保存。"
        }
    }
}

private final class NoHistoryRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
