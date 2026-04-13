import Cocoa
import WebKit

// ─────────────────────────────────────────────────────────────────────────────
// Combyne AI — Native macOS App with embedded WebView
// Starts the Node.js server and displays the UI in a native window.
// ─────────────────────────────────────────────────────────────────────────────

let APP_PORT = 3100
let APP_URL = "http://127.0.0.1:\(APP_PORT)"
let HEALTH_URL = "\(APP_URL)/api/health"

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var loadingView: NSView!
    var statusLabel: NSTextField!
    var retryTimer: Timer?
    var healthCheckCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create the main window
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let windowWidth: CGFloat = min(1440, screenFrame.width * 0.85)
        let windowHeight: CGFloat = min(900, screenFrame.height * 0.85)
        let windowX = screenFrame.origin.x + (screenFrame.width - windowWidth) / 2
        let windowY = screenFrame.origin.y + (screenFrame.height - windowHeight) / 2

        window = NSWindow(
            contentRect: NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Combyne AI"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.minSize = NSSize(width: 800, height: 500)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.059, alpha: 1.0) // #0B0B0F

        // WebView configuration
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Allow clipboard/paste access
        config.preferences.setValue(true, forKey: "javaScriptCanAccessClipboard")
        config.preferences.setValue(true, forKey: "DOMPasteAllowed")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true
        webView.setValue(false, forKey: "drawsBackground") // Transparent until loaded
        window.contentView?.addSubview(webView)

        // Loading screen
        setupLoadingView()

        // Create the Edit menu with Cut/Copy/Paste (Cmd+X/C/V)
        setupMenuBar()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Check if server is already running
        checkHealthAndStart()
    }

    func setupMenuBar() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Combyne AI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Combyne AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu (Cut/Copy/Paste/Select All)
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(NSMenuItem.separator())
        let fullScreenItem = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreenItem.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(fullScreenItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc func reloadPage() {
        webView.reload()
    }

    func setupLoadingView() {
        loadingView = NSView(frame: window.contentView!.bounds)
        loadingView.autoresizingMask = [.width, .height]
        loadingView.wantsLayer = true
        loadingView.layer?.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.059, alpha: 1.0).cgColor

        // Bee emoji
        let beeLabel = NSTextField(labelWithString: "🐝")
        beeLabel.font = NSFont.systemFont(ofSize: 64)
        beeLabel.alignment = .center
        beeLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(beeLabel)

        // Logo text
        let logoLabel = NSTextField(labelWithString: "COMBYNE.AI")
        logoLabel.font = NSFont.systemFont(ofSize: 32, weight: .heavy)
        logoLabel.textColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 1.0) // #F5A623
        logoLabel.alignment = .center
        logoLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(logoLabel)

        // Tagline
        let taglineLabel = NSTextField(labelWithString: "The Hive That Gets Things Done")
        taglineLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        taglineLabel.textColor = NSColor(red: 0.57, green: 0.25, blue: 0.05, alpha: 1.0) // #92400E
        taglineLabel.alignment = .center
        taglineLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(taglineLabel)

        // Status label
        statusLabel = NSTextField(labelWithString: "Starting server...")
        statusLabel.font = NSFont.systemFont(ofSize: 14, weight: .regular)
        statusLabel.textColor = NSColor(red: 0.61, green: 0.61, blue: 0.61, alpha: 1.0)
        statusLabel.alignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(statusLabel)

        // Spinner
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)
        loadingView.addSubview(spinner)

        // Layout
        NSLayoutConstraint.activate([
            beeLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            beeLabel.centerYAnchor.constraint(equalTo: loadingView.centerYAnchor, constant: -80),

            logoLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            logoLabel.topAnchor.constraint(equalTo: beeLabel.bottomAnchor, constant: 8),

            taglineLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            taglineLabel.topAnchor.constraint(equalTo: logoLabel.bottomAnchor, constant: 6),

            spinner.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            spinner.topAnchor.constraint(equalTo: taglineLabel.bottomAnchor, constant: 30),

            statusLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
        ])

        window.contentView?.addSubview(loadingView)
    }

    func checkHealthAndStart() {
        // First check if server is already running
        let url = URL(string: HEALTH_URL)!
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                // Server already running - just load the UI
                DispatchQueue.main.async {
                    self?.loadWebUI()
                }
            } else {
                // Start the server
                DispatchQueue.main.async {
                    self?.startServer()
                }
            }
        }
        task.resume()
    }

    func startServer() {
        // Find the repo
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(homeDir)/Documents/GitHub/Combyne.ai",
            "\(homeDir)/Documents/GitHub/Combyne-ai",
            "\(homeDir)/Documents/GitHub/combyne",
            "\(homeDir)/Documents/GitHub/Combyne_Main",
            "\(homeDir)/Desktop/Combyne.ai",
            "\(homeDir)/Desktop/Combyne-ai",
            "\(homeDir)/Desktop/combyne",
            "\(homeDir)/Desktop/Combyne_Main",
            "\(homeDir)/Combyne.ai",
            "\(homeDir)/Combyne_Main",
        ]

        var repoRoot: String?
        for candidate in candidates {
            let serverModules = "\(candidate)/server/node_modules"
            if FileManager.default.fileExists(atPath: serverModules) {
                repoRoot = candidate
                break
            }
        }

        guard let repo = repoRoot else {
            statusLabel.stringValue = "Combyne AI repo not found"
            showAlert("Combyne AI repo not found.\n\nClone the repo and run:\npnpm install && pnpm build")
            return
        }

        statusLabel.stringValue = "Starting server..."

        // Find node
        let nodePaths = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        var nodeBin: String?
        for np in nodePaths {
            if FileManager.default.fileExists(atPath: np) {
                nodeBin = np
                break
            }
        }
        // Also check PATH via shell
        if nodeBin == nil {
            let which = Process()
            which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
            which.arguments = ["node"]
            let pipe = Pipe()
            which.standardOutput = pipe
            try? which.run()
            which.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let p = path, !p.isEmpty, FileManager.default.fileExists(atPath: p) {
                nodeBin = p
            }
        }

        guard let node = nodeBin else {
            statusLabel.stringValue = "Node.js not found"
            showAlert("Node.js 20+ is required.\n\nInstall via: brew install node")
            return
        }

        // Set up environment
        let dataDir = "\(homeDir)/.combyne-ai"
        let configDir = "\(dataDir)/instances/default"
        let configFile = "\(configDir)/config.json"

        // Create directories
        try? FileManager.default.createDirectory(atPath: "\(configDir)/logs", withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(atPath: "\(configDir)/data", withIntermediateDirectories: true)

        // Create config if missing
        if !FileManager.default.fileExists(atPath: configFile) {
            let configJSON = """
            {"server":{"host":"127.0.0.1","port":3100,"deploymentMode":"local_trusted","exposure":"private"},"database":{"mode":"embedded-postgres","embeddedPostgresPort":54329},"logging":{"level":"info"},"storage":{"mode":"local"},"secrets":{"mode":"env"},"auth":{"baseUrlMode":"auto"}}
            """
            try? configJSON.write(toFile: configFile, atomically: true, encoding: .utf8)
        }

        // Kill any zombie node processes from previous launches first.
        // Stale processes holding port 54329 prevent embedded PostgreSQL from starting.
        let cleanup = Process()
        cleanup.executableURL = URL(fileURLWithPath: "/bin/bash")
        cleanup.arguments = ["-c", "pkill -9 -f 'tsx/dist/cli.mjs server/src/index' 2>/dev/null; lsof -ti:54329 2>/dev/null | xargs kill -9 2>/dev/null; sleep 1"]
        cleanup.standardOutput = FileHandle.nullDevice
        cleanup.standardError = FileHandle.nullDevice
        try? cleanup.run()
        cleanup.waitUntilExit()

        // Start node server
        let logDir = "\(homeDir)/Library/Logs/CombyneAI"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)

        // Start the esbuild-bundled server (no tsx needed — runs with plain node).
        // This avoids the macOS AppNap throttling issue that affects tsx's worker_threads.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["dist/server-bundle.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: "\(repo)/server")
        // Inherit the FULL user environment so child processes (like claude CLI)
        // can find auth configs, PATH entries, etc.
        var env = ProcessInfo.processInfo.environment
        env["COMBYNE_HOME"] = dataDir
        env["COMBYNE_CONFIG"] = configFile
        env["COMBYNE_DEPLOYMENT_MODE"] = "local_trusted"
        env["SERVE_UI"] = "true"
        env["HOST"] = "127.0.0.1"
        env["PORT"] = "\(APP_PORT)"
        env["PATH"] = "\(homeDir)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(env["PATH"] ?? "")"
        process.environment = env
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            serverProcess = process
            statusLabel.stringValue = "Server starting..."
            startHealthPolling()
        } catch {
            statusLabel.stringValue = "Failed to start"
            showAlert("Failed to start server: \(error.localizedDescription)")
        }
    }

    func startHealthPolling() {
        healthCheckCount = 0
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            self.healthCheckCount += 1

            // Check if server process died (only if we have a direct handle)
            if let proc = self.serverProcess, !proc.isRunning {
                // Don't give up immediately — the server might still be starting
                if self.healthCheckCount > 10 {
                    timer.invalidate()
                    DispatchQueue.main.async {
                        self.statusLabel.stringValue = "Server stopped unexpectedly"
                    }
                    return
                }
            }

            // Update status message
            DispatchQueue.main.async {
                if self.healthCheckCount < 5 {
                    self.statusLabel.stringValue = "Initializing database..."
                } else if self.healthCheckCount < 15 {
                    self.statusLabel.stringValue = "Starting services..."
                } else {
                    self.statusLabel.stringValue = "Almost ready..."
                }
            }

            // Health check
            let url = URL(string: HEALTH_URL)!
            let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    timer.invalidate()
                    DispatchQueue.main.async {
                        self?.statusLabel.stringValue = "Ready!"
                        self?.loadWebUI()
                    }
                }
            }
            task.resume()

            // Timeout after 2 minutes
            if self.healthCheckCount > 60 {
                timer.invalidate()
                DispatchQueue.main.async {
                    self.statusLabel.stringValue = "Server took too long to start"
                }
            }
        }
    }

    func loadWebUI() {
        let url = URL(string: APP_URL)!
        webView.load(URLRequest(url: url))

        // Fade transition from loading screen to web UI
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.5
            loadingView.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.loadingView.isHidden = true
            self?.webView.isHidden = false
            self?.webView.alphaValue = 0
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.3
                self?.webView.animator().alphaValue = 1
            })
        })
    }

    func showAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Combyne AI"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Stop the server process
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
        // Kill any server processes by pattern
        let killProc = Process()
        killProc.executableURL = URL(fileURLWithPath: "/bin/bash")
        killProc.arguments = ["-c", "pkill -f 'server-bundle.js' 2>/dev/null; pkill -f 'tsx/dist/cli.mjs server/src/index' 2>/dev/null; sleep 1; lsof -ti:54329 2>/dev/null | xargs kill 2>/dev/null"]
        killProc.standardOutput = FileHandle.nullDevice
        killProc.standardError = FileHandle.nullDevice
        try? killProc.run()
        killProc.waitUntilExit()
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // Shows in Dock
app.run()
