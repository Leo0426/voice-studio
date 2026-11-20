import Foundation
import Testing
@testable import OpenAISpeech

struct OpenAISpeechTests {
    private static let wav = Data(base64Encoded: "UklGRioAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQYAAAAQIBAgECA=")!

    private func tempURL(_ ext: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
    }

    private func stub(status: Int = 200, _ handler: @escaping @Sendable (URLRequest) throws -> Data) -> OpenAISpeechClient {
        OpenAISpeechClient(key: { "fake-key" }) { request in
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (try handler(request), http)
        }
    }

    private static func completion(audio: Data, finish: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "choices": [["finish_reason": finish, "message": ["audio": ["data": audio.base64EncodedString()]]]],
        ])
    }

    @Test func configurationReadsOnlyNamedVariableAndPrefersProcessEnvironment() throws {
        let url = tempURL("env")
        defer { try? FileManager.default.removeItem(at: url) }
        func key(_ env: [String: String] = [:]) -> String? {
            OpenAISpeechClient.configuredKey(environment: env, configurationURL: url)
        }
        #expect(key() == nil)
        try "# OPENAI_API_KEY=ignored\nOTHER_KEY=not-used\nOPENAI_API_KEY=\n".write(to: url, atomically: true, encoding: .utf8)
        #expect(key() == nil)
        try "export OPENAI_API_KEY='file-key'  # comment\n".write(to: url, atomically: true, encoding: .utf8)
        #expect(key() == "file-key")
        #expect(key(["OPENAI_API_KEY": " process-key "]) == "process-key")
        #expect(key(["OPENAI_API_KEY": " \t "]) == "file-key")
        try "OPENAI_API_KEY=second-key # comment\n".write(to: url, atomically: true, encoding: .utf8)
        #expect(key() == "second-key")
        try "OPENAI_API_KEY=old\nOPENAI_API_KEY=\n".write(to: url, atomically: true, encoding: .utf8)
        #expect(key() == nil)
    }

    @Test func synthesisSendsVerbatimScriptAndReturnsWaveFromAudioChoice() async throws {
        let script = "问题：明天几点开门？\nDo not read this aloud."
        let client = stub { request in
            #expect(request.url?.absoluteString == "https://api.openai.com/v1/chat/completions")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fake-key")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            let json = try #require(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
            #expect(json["model"] as? String == "gpt-audio-1.5")
            #expect(json["store"] as? Bool == false)
            #expect(json["modalities"] as? [String] == ["text", "audio"])
            #expect(json["audio"] as? [String: String] == ["voice": "marin", "format": "wav"])
            let messages = try #require(json["messages"] as? [[String: String]])
            #expect(messages.map { $0["role"] } == ["system", "user"])
            #expect(messages.first?["content"]?.contains("verbatim") == true)
            #expect(messages.last?["content"] == script)
            return try Self.completion(audio: Self.wav, finish: "stop")
        }
        let wav = try await client.synthesize(text: script, voice: "marin")
        #expect(wav == Self.wav)
    }

    @Test func transcriptionSendsAudioBytesWithLanguageHintAndReadsText() async throws {
        let url = tempURL("M4A")
        let original = Data([0, 255, 13, 0, 10])
        try original.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let client = stub { request in
            #expect(request.url?.absoluteString == "https://api.openai.com/v1/audio/transcriptions")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fake-key")
            let contentType = try #require(request.value(forHTTPHeaderField: "Content-Type"))
            #expect(contentType.hasPrefix("multipart/form-data; boundary="))
            let boundary = String(contentType.dropFirst("multipart/form-data; boundary=".count))
            let body = try #require(request.httpBody)
            let content = String(decoding: body, as: UTF8.self)
            #expect(content.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"))
            #expect(content.contains("name=\"languages[]\"\r\n\r\nzh\r\n"))
            #expect(content.contains("name=\"file\"; filename=\"audio.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n"))
            #expect(body.range(of: original) != nil)
            #expect(!content.contains(url.lastPathComponent))
            #expect(content.hasSuffix("--\(boundary)--\r\n"))
            return Data(#"{"text":" 你好，世界。 ","languages":["zh"]}"#.utf8)
        }
        let text = try await client.transcribe(fileURL: url, language: "zh")
        #expect(text == "你好，世界。")
    }

    @Test func missingCredentialsAndInvalidInputPreventRequests() async throws {
        let missing = OpenAISpeechClient(key: { nil }, send: { _ in
            Issue.record("缺少凭据时发出了请求")
            throw CancellationError()
        })
        let client = stub { _ in
            Issue.record("无效输入发出了请求")
            return Data()
        }
        await #expect(throws: (any Error).self) { try await missing.synthesize(text: "test", voice: "marin") }
        await #expect(throws: (any Error).self) { try await client.synthesize(text: "\n", voice: "marin") }
        await #expect(throws: (any Error).self) { try await client.synthesize(text: "hello", voice: "unknown") }
        let long = String(repeating: "你", count: OpenAISpeechClient.maximumInputLength + 1)
        await #expect(throws: (any Error).self) { try await client.synthesize(text: long, voice: "cedar") }
        let url = tempURL("wav")
        try Data().write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        await #expect(throws: (any Error).self) { try await client.transcribe(fileURL: url, language: "en") }
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(OpenAISpeechClient.maximumAudioBytes + 1))
        try handle.close()
        await #expect(throws: (any Error).self) { try await client.transcribe(fileURL: url, language: "en") }
        await #expect(throws: (any Error).self) { try await client.transcribe(fileURL: tempURL("txt"), language: "zh") }
    }

    @Test func deliveryControlsStayOutOfSpokenTextAndUseCustomVoiceObject() async throws {
        let script = "请逐字朗读这段文字。"
        var options = OpenAISynthesisOptions()
        options.model = .audioMini
        options.customVoiceID = "voice_sample123"
        options.style = "新闻播报"
        options.emotion = "温暖"
        options.pace = "舒缓"
        options.accent = "标准普通话"
        options.instructions = "名字前稍作停顿。"
        let client = stub { request in
            let json = try #require(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
            #expect(json["model"] as? String == "gpt-audio-mini")
            #expect(json["speed"] == nil)
            let audio = try #require(json["audio"] as? [String: Any])
            #expect(audio["voice"] as? [String: String] == ["id": "voice_sample123"])
            let messages = try #require(json["messages"] as? [[String: String]])
            #expect(messages.last?["content"] == script)
            let system = try #require(messages.first?["content"])
            for value in ["verbatim", "新闻播报", "温暖", "舒缓", "标准普通话", "名字前稍作停顿。"] {
                #expect(system.contains(value))
            }
            return try Self.completion(audio: Self.wav, finish: "stop")
        }
        #expect(try await client.synthesize(text: script, options: options) == Self.wav)
    }

    // Real short silent MPEG Layer III and FLAC recordings, including valid container metadata.
    private static let mp3 = Data(base64Encoded: "//MYxAAAAANIAAAAAExBTUU0LjBVVVVVVVVVVVVVVVVVVVVV//MYxBcAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxC4AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxEUAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxFwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV")!
    private static let flac = Data(base64Encoded: "ZkxhQwAAACIEAAQAAAALAAANA+gA8AAABaC0oRkidX4QeiwQMGhn9SYBhAAALAwAAABMYXZmNjMuMS4xMDIBAAAAFAAAAGVuY29kZXI9TGF2ZjYzLjEuMTAy//ilCACqAAAAR3f/+HUIAQGfXQAAAAm7")!

    @Test func dedicatedSpeechAcceptsNumericSpeedAndReturnsEncodedAudio() async throws {
        for (format, fixture) in [(OpenAIAudioFormat.mp3, Self.mp3), (.flac, Self.flac), (.wav, Self.wav)] {
            var options = OpenAISynthesisOptions()
            options.model = .speech
            options.format = format
            options.voice = "verse"
            options.instructions = "Keep a warm tone."
            options.pace = "should be ignored for dedicated speech"
            options.speed = 1.35
            let client = stub { request in
                #expect(request.url?.path == "/v1/audio/speech")
                let json = try #require(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
                #expect(json["input"] as? String == "hello")
                #expect(json["response_format"] as? String == format.rawValue)
                #expect(json["speed"] as? Double == 1.35)
                #expect(json["instructions"] as? String == "Additional delivery directions: Keep a warm tone.")
                #expect(json["voice"] as? String == "verse")
                #expect(json["model"] as? String == "gpt-4o-mini-tts")
                #expect(json["messages"] == nil)
                return fixture
            }
            #expect(try await client.synthesize(text: "hello", options: options) == fixture)
            let wrongFormat = stub { _ in format == .wav ? Self.mp3 : Self.wav }
            await #expect(throws: (any Error).self) { try await wrongFormat.synthesize(text: "hello", options: options) }
            options.model = .audio
            let chat = stub { _ in try Self.completion(audio: fixture, finish: "stop") }
            #expect(try await chat.synthesize(text: "hello", options: options) == fixture)
        }
    }

    @Test func multilingualAndAutomaticTranscriptionUseExpectedFormFields() async throws {
        let file = tempURL("wav")
        try Self.wav.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        for languages in [[], ["zh", "en"]] {
            let options = OpenAITranscriptionOptions(languages: languages, prompt: "A bilingual call.", keywords: ["Voice Studio", "访谈"])
            let client = stub { request in
                let body = String(decoding: request.httpBody!, as: UTF8.self)
                #expect(body.components(separatedBy: "name=\"languages[]\"").count - 1 == languages.count)
                for language in languages { #expect(body.contains("name=\"languages[]\"\r\n\r\n" + language)) }
                #expect(!body.contains("name=\"language\""))
                #expect(body.contains("name=\"prompt\"\r\n\r\nA bilingual call."))
                #expect(body.contains("name=\"keywords[]\"\r\n\r\nVoice Studio"))
                #expect(body.contains("name=\"keywords[]\"\r\n\r\n访谈"))
                return Data(#"{"text":"hello"}"#.utf8)
            }
            #expect(try await client.transcribe(fileURL: file, options: options) == "hello")
        }
    }

    @Test func optionLimitsRejectInvalidSettingsBeforeTheRequest() async throws {
        var speech = OpenAISynthesisOptions()
        speech.customVoiceID = "voice_wrong id"
        #expect(speech.validationMessage != nil)
        speech.customVoiceID = nil
        speech.model = .speech
        speech.speed = 4.01
        #expect(speech.validationMessage != nil)
        speech.speed = 0.25
        #expect(speech.validationMessage == nil)
        speech.instructions = String(repeating: "a", count: 1001)
        #expect(speech.validationMessage != nil)
        #expect(OpenAITranscriptionOptions(languages: ["English"]).validationMessage != nil)
        #expect(OpenAITranscriptionOptions(languages: Array(repeating: "en", count: 17)).validationMessage != nil)
        #expect(OpenAITranscriptionOptions(prompt: String(repeating: "a", count: 1001)).validationMessage != nil)
        for bad in ["<>", "line\nline", "x\rx", String(repeating: "a", count: 81)] {
            #expect(OpenAITranscriptionOptions(keywords: [bad]).validationMessage != nil)
        }
        #expect(OpenAITranscriptionOptions(keywords: Array(repeating: "word", count: 65)).validationMessage != nil)
        #expect(OpenAISpeechClient.voices.count == 13)
    }

    @Test func incompleteOrInvalidResponsesAreRejected() async throws {
        for (audio, finish) in [(Self.wav, "length"), (Self.wav.dropLast(), "stop"), (Data("not audio".utf8), "stop")] {
            let client = stub { _ in try Self.completion(audio: audio, finish: finish) }
            await #expect(throws: (any Error).self) { try await client.synthesize(text: "hello", voice: "marin") }
        }
        let url = tempURL("wav")
        try Self.wav.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        for json in [#"{"text":"  "}"#, #"{"error":{}}"#, "{}!", ""] {
            let client = stub { _ in Data(json.utf8) }
            await #expect(throws: (any Error).self) { try await client.transcribe(fileURL: url, language: "en") }
        }
    }

    @Test(arguments: [401, 403, 413, 429, 503])
    func httpFailuresDoNotExposeTheRawResponse(status: Int) async {
        let client = stub(status: status) { _ in Data("private upstream details".utf8) }
        do {
            _ = try await client.synthesize(text: "hello", voice: "cedar")
            Issue.record("上游 HTTP \(status) 却返回了成功")
        } catch {
            #expect(!error.localizedDescription.contains("private upstream details"))
            #expect(!error.localizedDescription.contains("fake-key"))
        }
    }

    @Test func cancellationStopsAnInFlightRequest() async {
        let (started, signal) = AsyncStream.makeStream(of: Bool.self)
        let client = OpenAISpeechClient(key: { "fake-key" }) { _ in
            signal.yield(true)
            signal.finish()
            try await Task.sleep(for: .seconds(30))
            throw URLError(.timedOut)
        }
        let task = Task { try await client.synthesize(text: "hello", voice: "alloy") }
        for await _ in started { break }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
    }
}
