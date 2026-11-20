import Foundation
import Testing
@testable import OpenAISpeech

struct VoiceEnrollmentTests {
    private func recording(seconds: Int = 6) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("personal-\(UUID()).wav")
        var wav = Data(base64Encoded: "UklGRioAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQYAAAAQIBAgECA=")!
        wav.removeSubrange(44...)
        let length = 24_000 * 2 * seconds
        withUnsafeBytes(of: UInt32(length + 36).littleEndian) { wav.replaceSubrange(4..<8, with: $0) }
        withUnsafeBytes(of: UInt32(length).littleEndian) { wav.replaceSubrange(40..<44, with: $0) }
        wav.append(Data(repeating: 0, count: length))
        try wav.write(to: url)
        return url
    }

    private func client(status: Int = 200, reply: @escaping @Sendable (URLRequest) throws -> Data) -> OpenAISpeechClient {
        OpenAISpeechClient(key: { "test-only" }) { request in
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (try reply(request), http)
        }
    }

    @Test func consentAndSampleYieldAVoiceUsableByTheSynthesisAPI() async throws {
        let file = try recording()
        defer { try? FileManager.default.removeItem(at: file) }
        let bytes = try Data(contentsOf: file)
        let client = client { request in
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
            let body = try #require(request.httpBody)
            let path = try #require(request.url?.path)
            if path == "/v1/chat/completions" {
                let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
                let audio = try #require(json["audio"] as? [String: Any])
                #expect(audio["voice"] as? [String: String] == ["id": "voice_123"])
                return try JSONSerialization.data(withJSONObject: ["choices": [
                    ["finish_reason": "stop", "message": ["audio": ["data": bytes.base64EncodedString()]]],
                ]])
            }
            let header = try #require(request.value(forHTTPHeaderField: "Content-Type"))
            #expect(header.hasPrefix("multipart/form-data; boundary="))
            let content = String(decoding: body, as: UTF8.self)
            let boundary = header.dropFirst("multipart/form-data; boundary=".count)
            #expect(content.hasSuffix("\r\n--\(boundary)--\r\n"))
            #expect(content.contains("name=\"name\"\r\n\r\n我的声音\r\n"))
            #expect(!content.contains(file.lastPathComponent))
            #expect(body.range(of: bytes) != nil)
            if path == "/v1/audio/voice_consents" {
                #expect(content.contains("name=\"language\"\r\n\r\nzh\r\n"))
                #expect(content.contains("name=\"recording\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav"))
                return Data(#"{"id":"cons_123","object":"audio.voice_consent"}"#.utf8)
            }
            #expect(path == "/v1/audio/voices")
            #expect(content.contains("name=\"consent\"\r\n\r\ncons_123\r\n"))
            #expect(content.contains("name=\"type\"\r\n\r\naudio_sample\r\n"))
            #expect(content.contains("name=\"audio_sample\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav"))
            return Data(#"{"id":"voice_123","object":"audio.voice","type":"audio_sample"}"#.utf8)
        }
        let consent = try await client.uploadVoiceConsent(name: " 我的声音 ", language: "zh", recordingURL: file)
        #expect(consent == "cons_123")
        let voice = try await client.createVoice(name: "我的声音", consentID: consent, sampleURL: file)
        #expect(voice == "voice_123")
        var options = OpenAISynthesisOptions()
        options.customVoiceID = voice
        let synthesized = try await client.synthesize(text: "你好", options: options)
        #expect(synthesized == bytes)
    }

    @Test func rejectsInvalidNamesConsentsAndRecordingsBeforeUpload() async throws {
        let client = client { _ in
            Issue.record("不应上传无效输入")
            return Data()
        }
        let file = try recording(seconds: 2)
        defer { try? FileManager.default.removeItem(at: file) }
        await #expect(throws: (any Error).self) { try await client.uploadVoiceConsent(name: "", language: "zh", recordingURL: file) }
        await #expect(throws: (any Error).self) { try await client.uploadVoiceConsent(name: "A", language: "xx", recordingURL: file) }
        await #expect(throws: (any Error).self) { try await client.createVoice(name: "A", consentID: "voice_wrong", sampleURL: file) }
        await #expect(throws: (any Error).self) { try await client.createVoice(name: "A", consentID: "cons_ok", sampleURL: file) }
        let tooLong = try recording(seconds: 61)
        defer { try? FileManager.default.removeItem(at: tooLong) }
        await #expect(throws: (any Error).self) { try await client.createVoice(name: "A", consentID: "cons_ok", sampleURL: tooLong) }

        try Data("不是音频内容".utf8).write(to: file)
        await #expect(throws: (any Error).self) { try await client.uploadVoiceConsent(name: "A", language: "en", recordingURL: file) }
        await #expect(throws: (any Error).self) {
            try await client.uploadVoiceConsent(name: "A", language: "en", recordingURL: file.appendingPathExtension("txt"))
        }
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(OpenAISpeechClient.maximumEnrollmentAudioBytes + 1))
        try handle.close()
        await #expect(throws: (any Error).self) { try await client.uploadVoiceConsent(name: "A", language: "en", recordingURL: file) }
    }

    @Test func malformedOrWrongResourceIDsDoNotEnableSynthesis() async throws {
        let file = try recording()
        defer { try? FileManager.default.removeItem(at: file) }
        let consent = client { _ in Data(#"{"id":"voice_wrong"}"#.utf8) }
        await #expect(throws: (any Error).self) { try await consent.uploadVoiceConsent(name: "A", language: "en", recordingURL: file) }
        for json in ["{}", #"{"id":"voice_x\n"}"#, #"{"id":"voice_x","type":"prompt"}"#, #"{"id":"cons_wrong"}"#] {
            let voice = client { _ in Data(json.utf8) }
            await #expect(throws: (any Error).self) { try await voice.createVoice(name: "A", consentID: "cons_ok", sampleURL: file) }
        }
    }

    @Test func entitlementFailureExplainsOrganizationAccessWithoutServerContent() async throws {
        let file = try recording()
        defer { try? FileManager.default.removeItem(at: file) }
        let denied = client(status: 403) { _ in Data("private-upstream-message".utf8) }
        do {
            _ = try await denied.uploadVoiceConsent(name: "A", language: "en", recordingURL: file)
            Issue.record("服务器拒绝却返回授权 ID")
        } catch {
            #expect(error.localizedDescription.contains("自定义音色权限"))
            #expect(!error.localizedDescription.contains("private-upstream-message"))
        }
    }
}
