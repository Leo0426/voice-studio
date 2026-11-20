import Foundation
import Testing
import TTSCore
@testable import Qwen3TTSApp

struct DeviceTaskHistoryTests {
    private let origin = URL(string: "http://127.0.0.1:33009")!
    private let owner = UUID().uuidString.lowercased()
    private let proof = String(repeating: "a", count: 21)
    private var cookie: HTTPCookie {
        HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "voice_studio_session_33009=" + String(repeating: "b", count: 22) + "; Path=/api; HttpOnly; SameSite=Strict"], for: origin)[0]
    }

    private actor Attempts {
        var paths: [URL] = []
        func add(_ url: URL) -> Int { paths.append(url); return paths.count }
    }

    @Test func retriesTheSameAccountTaskAndOriginalWaveThenRemovesTemporaryCopy() async throws {
        let event = DeviceSynthesisTask(text: "同一\n段文字。", voice: "中文")
        let attempts = Attempts()
        let samples: [Float] = [0, 0.25, -0.5, 0.75]
        let client = try #require(DeviceTaskHistory(origin: origin, owner: owner, proof: proof, cookies: [cookie]) { request, file in
            #expect(request.url?.absoluteString == origin.absoluteString + "/api/history/native/" + event.id.uuidString.lowercased())
            #expect(request.value(forHTTPHeaderField: "X-Voice-Actor") == owner)
            #expect(request.value(forHTTPHeaderField: "X-Voice-Proof") == proof)
            #expect(request.value(forHTTPHeaderField: "Cookie") == cookie.name + "=" + cookie.value)
            #expect(request.value(forHTTPHeaderField: "Origin") == origin.absoluteString)
            #expect(request.value(forHTTPHeaderField: "X-Voice-Label")?.removingPercentEncoding == "同一 段文字。 · 中文")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "audio/wav")
            guard let url = file else { throw CocoaError(.fileNoSuchFile) }
            let decoded = try WavFile.read(from: url)
            #expect(decoded.samples == samples)
            #expect(decoded.sampleRate == 22_050)
            let count = await attempts.add(url)
            let status = count == 1 ? 503 : 200
            let body = try JSONSerialization.data(withJSONObject: ["id": event.id.uuidString])
            return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
        try await client.save(event, result: .completed(samples: samples, rate: 22_050))
        let paths = await attempts.paths
        #expect(paths.count == 2 && paths[0] == paths[1])
        #expect(!FileManager.default.fileExists(atPath: paths[0].deletingLastPathComponent().path))
    }

    @Test func incompleteTasksSendNoFileAndRejectedIdentityIsNotRetried() async throws {
        let event = DeviceSynthesisTask(text: "待生成", voice: "Vivian")
        for result in [DeviceSynthesisResult.cancelled, .failed] {
            let client = try #require(DeviceTaskHistory(origin: origin, owner: owner, proof: proof, cookies: [cookie]) { request, file in
                #expect(request.value(forHTTPHeaderField: "X-Voice-Status") == result.status)
                #expect(file == nil && request.httpBody == nil)
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!)
            })
            await #expect(throws: (any Error).self) { try await client.save(event, result: result) }
        }
    }

    @Test func unrelatedOriginsCookiesAndInvalidProofCannotReceiveCredentials() {
        for url in [URL(string: "http://localhost:33009")!, URL(string: "http://127.0.0.1:33010")!,
                    URL(string: "http://127.0.0.1:33009/untrusted")!, URL(string: "https://127.0.0.1:33009")!] {
            #expect(DeviceTaskHistory(origin: url, owner: owner, proof: proof, cookies: [cookie]) == nil)
        }
        #expect(DeviceTaskHistory(origin: origin, owner: owner, proof: "invalid", cookies: [cookie]) == nil)
        #expect(DeviceTaskHistory(origin: origin, owner: owner, proof: proof, cookies: []) == nil)
        #expect(DeviceTaskHistory(origin: origin, owner: owner, proof: proof, cookies: [cookie, cookie]) == nil)
    }
}
