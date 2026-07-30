// CP Streak — a macOS menu bar readout of your practice streak.
//
// Deliberately a plain AppKit status-bar app rather than a SwiftBar/xbar
// plugin, so it needs no third-party host installed: build it once and it runs
// on its own. It polls the trainer's /api/streak endpoint and shows the day
// count next to a flame that goes hollow when today has not been logged yet —
// the whole point is to be a nag you can see without opening the app.
//
// Build: ./build.sh   (produces CPStreak.app)

import AppKit
import Foundation

// MARK: - Model

struct StreakPayload: Decodable {
    let handle: String?
    let current: Int
    let longest: Int
    let activeToday: Bool
    let lastActive: String?
    let nextMilestone: Int
    let days: [Day]

    struct Day: Decodable {
        let day: String
        let active: Bool
    }

    enum CodingKeys: String, CodingKey {
        case handle
        case current
        case longest
        case activeToday = "active_today"
        case lastActive = "last_active"
        case nextMilestone = "next_milestone"
        case days
    }
}

// MARK: - Config

enum Config {
    /// Candidate base URLs, in order. The trainer's dev server lands on 3000
    /// unless that port is taken, so 3001 is checked too; whichever answers
    /// first is remembered for later polls.
    static var candidates: [String] {
        if let custom = ProcessInfo.processInfo.environment["CP_TRAINER_URL"],
           !custom.isEmpty {
            return [custom]
        }
        if let stored = UserDefaults.standard.string(forKey: "baseURL"),
           !stored.isEmpty {
            return [stored, "http://localhost:3000", "http://localhost:3001"]
        }
        return ["http://localhost:3000", "http://localhost:3001"]
    }

    static func remember(_ base: String) {
        UserDefaults.standard.set(base, forKey: "baseURL")
    }

    /// Paired from Settings -> Menu bar app. The trainer requires a signed-in
    /// user now that an install can be shared, and this app has no browser and
    /// no cookie jar — so it carries a token of its own instead. Without one it
    /// gets a 401 and shows a dash, which is the honest answer.
    static var deviceToken: String? {
        if let env = ProcessInfo.processInfo.environment["CP_TRAINER_TOKEN"],
           !env.isEmpty {
            return env
        }
        let stored = UserDefaults.standard.string(forKey: "deviceToken")
        return (stored?.isEmpty == false) ? stored : nil
    }

    static let pollInterval: TimeInterval = 5 * 60
}

// MARK: - App

@MainActor
final class StreakController: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var payload: StreakPayload?
    private var reachableBase: String?
    private var lastError: String?
    /// The server answered, but this app has no valid token — a different
    /// problem from "can't reach it", and it needs a different instruction.
    private var needsPairing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageLeading
        render()

        // Rebuild the menu each time it opens so it is never stale.
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: Config.pollInterval,
                                     repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // MARK: Networking

    private func refresh() {
        let bases = reachableBase.map { [$0] } ?? Config.candidates
        Task { @MainActor in
            for base in bases {
                if let loaded = await fetch(base: base) {
                    payload = loaded
                    lastError = nil
                    reachableBase = base
                    Config.remember(base)
                    render()
                    return
                }
            }
            // Nothing answered: keep the last known numbers but mark them stale
            // instead of showing a confident zero.
            reachableBase = nil
            lastError = "Can't reach CP Trainer"
            render()
        }
    }

    private func fetch(base: String) async -> StreakPayload? {
        guard let url = URL(string: "\(base)/api/streak") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let token = Config.deviceToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode == 401 {
                needsPairing = true
                return nil
            }
            guard http.statusCode == 200 else { return nil }
            needsPairing = false
            return try JSONDecoder().decode(StreakPayload.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: Rendering

    private func render() {
        guard let button = statusItem.button else { return }

        let symbol: String
        let title: String

        if needsPairing {
            // Reachable but unauthorised: a key, not a dash, so the fix is
            // obvious from the menu bar alone.
            symbol = "key"
            title = ""
        } else if lastError != nil, payload == nil {
            symbol = "flame"
            title = "–"
        } else if let p = payload {
            if p.current == 0 {
                symbol = "flame"
                title = "0"
            } else if p.activeToday {
                symbol = "flame.fill"
                title = "\(p.current)"
            } else {
                // Alive but today is still open — the moment worth noticing.
                symbol = "flame"
                title = "\(p.current)!"
            }
        } else {
            symbol = "flame"
            title = "…"
        }

        button.image = NSImage(systemSymbolName: symbol,
                               accessibilityDescription: "Practice streak")
        button.image?.isTemplate = true
        button.title = " \(title)"
        button.toolTip = tooltip()
    }

    private func tooltip() -> String {
        if needsPairing {
            return "Not paired — open Settings → Menu bar app in CP Trainer."
        }
        if let error = lastError { return "\(error) — is the dev server running?" }
        guard let p = payload else { return "Loading…" }
        if p.current == 0 { return "No active streak. One solve starts one." }
        return p.activeToday
            ? "\(p.current)-day streak. Today's in."
            : "\(p.current)-day streak — not logged today."
    }

    // MARK: Actions

    @objc private func openApp() {
        let base = reachableBase ?? Config.candidates.first ?? "http://localhost:3000"
        if let url = URL(string: base) { NSWorkspace.shared.open(url) }
    }

    @objc private func openSolve() {
        let base = reachableBase ?? Config.candidates.first ?? "http://localhost:3000"
        if let url = URL(string: "\(base)/solve") { NSWorkspace.shared.open(url) }
    }

    @objc private func refreshNow() { refresh() }

    @objc private func openLoginItems() {
        let url = URL(
            string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() { NSApplication.shared.terminate(nil) }
}

// MARK: - Menu

extension StreakController: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        refresh()
        menu.removeAllItems()

        if let error = lastError, payload == nil {
            menu.addItem(disabled(error))
            menu.addItem(disabled("Start it with: pnpm dev"))
        } else if let p = payload {
            let headline: String
            if p.current == 0 {
                headline = "No active streak"
            } else if p.activeToday {
                headline = "\(p.current)-day streak · today's in"
            } else {
                headline = "\(p.current)-day streak · today still open"
            }
            menu.addItem(disabled(headline))

            if p.current > 0, !p.activeToday {
                menu.addItem(disabled("One solve keeps it alive"))
            }
            if p.current > 0, p.nextMilestone > p.current {
                let togo = p.nextMilestone - p.current
                menu.addItem(
                    disabled("\(togo) more to reach \(p.nextMilestone)"))
            }
            menu.addItem(disabled("Best: \(p.longest) days"))

            // Last 14 days as filled/empty squares, oldest first.
            if !p.days.isEmpty {
                let strip = p.days.map { $0.active ? "◆" : "◇" }.joined()
                let item = disabled(strip)
                item.attributedTitle = NSAttributedString(
                    string: strip,
                    attributes: [.font: NSFont.monospacedSystemFont(
                        ofSize: 13, weight: .regular)])
                menu.addItem(item)
            }
            if let stale = lastError {
                menu.addItem(disabled("\(stale) — showing last known"))
            }
        } else {
            menu.addItem(disabled("Loading…"))
        }

        menu.addItem(.separator())
        menu.addItem(action("Solve a problem", #selector(openSolve), key: "s"))
        menu.addItem(action("Open dashboard", #selector(openApp), key: "o"))
        menu.addItem(action("Refresh now", #selector(refreshNow), key: "r"))
        menu.addItem(.separator())
        menu.addItem(action("Open Login Items…", #selector(openLoginItems), key: ""))
        menu.addItem(action("Quit CP Streak", #selector(quit), key: "q"))
    }

    private func disabled(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector,
                        key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }
}

// MARK: - Entry point

/// Strong reference to the app delegate (NSApplication holds it weakly).
nonisolated(unsafe) var delegateBox: NSApplicationDelegate?

// Top-level code in main.swift runs on the main thread but is not statically
// main-actor isolated, so assert that isolation rather than loosening the
// controller's.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let controller = StreakController()
    // The delegate is only weakly held by NSApplication; keep it alive.
    delegateBox = controller
    app.delegate = controller
    // .accessory keeps it out of the Dock and the app switcher: menu bar only.
    app.setActivationPolicy(.accessory)
    app.run()
}
