import Foundation
import Testing
@testable import Qwen3TTSApp

@MainActor struct DeviceAccessTests {
    @Test func eachOperationNeedsItsOwnCurrentGrant() {
        var checks: [(Bool) -> Void] = []
        var actions: [Int] = []
        let access = DeviceAccess { checks.append($0) }
        access.perform { actions.append(1) }
        access.perform { actions.append(2) }
        #expect(actions.isEmpty)
        #expect(checks.count == 1)
        checks.removeFirst()(true)
        #expect(actions == [1])
        #expect(checks.count == 1)
        checks.removeFirst()(false)
        access.perform { actions.append(3) }
        #expect(actions == [1])
        #expect(checks.isEmpty)
        #expect(!access.active)
    }

    @Test func signingOutDuringAnOperationCheckDiscardsItsReplyAndQueue() {
        var reply: ((Bool) -> Void)?
        var touched = false
        let access = DeviceAccess { reply = $0 }
        access.perform { touched = true }
        access.perform { touched = true }
        access.invalidate()
        reply?(true)
        #expect(!touched)
    }

    @Test func partialRolesAndGuestsCannotUseDevice() {
        let user = DesktopIdentity.User(id: "test")
        for permissions in [Set(["tts.local"]), Set(["desktop.manage"]), Set(["users.manage", "keys.manage"])] {
            #expect(!DesktopIdentity(needsSetup: false, user: user, permissions: permissions).mayUseDevice)
        }
        let required: Set<String> = ["desktop.manage", "tts.local"]
        #expect(DesktopIdentity(needsSetup: false, user: user, permissions: required).mayUseDevice)
        #expect(!DesktopIdentity(needsSetup: false, user: nil, permissions: required).mayUseDevice)
    }

    @Test func onlyMatchingDatabaseBootstrapCodeIsRead() {
        let dir = URL(fileURLWithPath: "/tmp/voice-studio-test", isDirectory: true)
        #expect(DesktopAccount.setupCodeURL(database: dir.appendingPathComponent("access.sqlite")) == dir.appendingPathComponent("bootstrap-code"))
        #expect(DesktopAccount.setupCodeURL(database: dir.appendingPathComponent("separate.db")) == dir.appendingPathComponent("separate.db.bootstrap-code"))
    }

    @Test func originMustBeTheExactAnnouncedLocalListener() throws {
        let origin = try #require(LocalWorkspaceService.announcedOrigin("Voice Studio   http://127.0.0.1:37123"))
        #expect(LocalWorkspaceService.sameOrigin(origin.appendingPathComponent("account.html"), as: origin))
        for text in ["http://localhost:37123", "http://127.0.0.1:37124", "https://127.0.0.1:37123",
                     "http://127.0.0.1:37123@example.org/", "http://spoof@127.0.0.1:37123", "file:///tmp/index.html"] {
            #expect(!LocalWorkspaceService.sameOrigin(URL(string: text), as: origin))
        }
        for suffix in ["0", "99999", "37123/path", "1@host", "01", "42?secret"] {
            #expect(LocalWorkspaceService.announcedOrigin("Voice Studio   http://127.0.0.1:" + suffix) == nil)
        }
    }
}
