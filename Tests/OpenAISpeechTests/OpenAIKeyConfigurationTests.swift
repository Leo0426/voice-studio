import Foundation
import Testing
@testable import OpenAISpeech

struct OpenAIKeyConfigurationTests {
    private func withConfiguration(_ body: (URL, OpenAIKeyConfiguration) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("Voice Studio/openai.env")
        try body(url, OpenAIKeyConfiguration(url: url, environment: [:]))
    }

    @Test func createsPrivateConfigurationAndOtherInstancesSeeChanges() throws {
        try withConfiguration { url, config in
            #expect(config.source == .unconfigured)
            try config.save("sample-test.one+/=-")
            #expect(config.source == .sharedFile)
            #expect(OpenAISpeechClient.configuredKey(environment: [:], configurationURL: url) == "sample-test.one+/=-")
            let info = try FileManager.default.attributesOfItem(atPath: url.path)
            #expect(info[.posixPermissions] as? Int == 0o600)
            let oldestHandle = try FileHandle(forReadingFrom: url)
            defer { try? oldestHandle.close() }
            try config.save("sample-test-two")
            #expect(config.key == "sample-test-two")
            let oldFile = try oldestHandle.readToEnd()
            #expect(oldFile == Data("OPENAI_API_KEY=sample-test.one+/=-\n".utf8))
            #expect(try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path) == ["openai.env"])
        }
    }

    @Test func replacementPreservesOtherFieldsAndComments() throws {
        try withConfiguration { url, config in
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let original = "# unrelated 👋\r\nexport OPENAI_API_KEY = 'old'  # older\r\nOTHER=\"one\r\nOPENAI_API_KEY=inside\r\ntwo\"\r\nOPENAI_API_KEY=second  # latest\r\n"
            try Data(original.utf8).write(to: url)
            #expect(config.key == "second")
            try config.save("replacement")
            let expected = original.replacingOccurrences(of: "'old'", with: "replacement")
                .replacingOccurrences(of: "=second", with: "=replacement")
            #expect(try String(contentsOf: url, encoding: .utf8) == expected)
            #expect(config.key == "replacement")
            #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int == 0o600)
        }
    }

    @Test func environmentTakesPrecedenceAndPreventsWriting() throws {
        try withConfiguration { url, file in
            try file.save("previous")
            let env = OpenAIKeyConfiguration(url: url, environment: ["OPENAI_API_KEY": "process-value"])
            #expect(env.source == .environment)
            #expect(env.key == "process-value")
            #expect(throws: (any Error).self) { try env.save("replacement") }
            #expect(file.key == "previous")
        }
    }

    @Test func rejectsAmbiguousKeysAndRetainsPriorConfiguration() throws {
        try withConfiguration { url, config in
            try config.save("previous")
            let data = try Data(contentsOf: url)
            let invalid = ["", " leading", "trailing ", "inner space", "tab\there", "newline\n",
                           "'quoted'", "\"quoted\"", "hash#x", "slash\\", "quote`", "a;b", "a$b",
                           "游客", "null\u{0}byte", "del\u{7f}", String(repeating: "a", count: 4097)]
            for input in invalid {
                #expect(throws: (any Error).self) { try config.save(input) }
            }
            #expect(try Data(contentsOf: url) == data)
        }
    }

    @Test func existingSymlinkIsNotFollowedOrOverwritten() throws {
        try withConfiguration { url, config in
            let manager = FileManager.default
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let target = url.deletingLastPathComponent().appendingPathComponent("unrelated.env")
            let original = Data("OPENAI_API_KEY=untouched\n".utf8)
            try original.write(to: target)
            try manager.createSymbolicLink(at: url, withDestinationURL: target)
            #expect(config.source == .unconfigured)
            #expect(throws: (any Error).self) { try config.save("new-key") }
            #expect(try Data(contentsOf: target) == original)
            #expect(try manager.destinationOfSymbolicLink(atPath: url.path) == target.path)
        }
    }
}
