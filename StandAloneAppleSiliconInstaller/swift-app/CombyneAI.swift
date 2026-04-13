import Cocoa
import WebKit
import CommonCrypto
import IOKit

// ─────────────────────────────────────────────────────────────────────────────
// Combyne AI — Native macOS App with embedded WebView
// Starts the Node.js server and displays the UI in a native window.
// Includes license activation flow with Supabase validation.
// Includes robust logging, error handling, and log download for diagnostics.
// ─────────────────────────────────────────────────────────────────────────────

let APP_PORT = 3100
let APP_URL = "http://127.0.0.1:\(APP_PORT)"
let HEALTH_URL = "\(APP_URL)/api/health"

let SUPABASE_URL = "https://cmkybsmznmhclytbjnwh.supabase.co"
let SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta3lic216bm1oY2x5dGJqbndoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODA4MDIsImV4cCI6MjA4OTI1NjgwMn0.XVe1tT0b43rXqKU5-hCZMUJ1smU2aEyI39xkEDj42_0"

let LICENSE_CACHE_PATH = FileManager.default.homeDirectoryForCurrentUser.path + "/.combyne-ai/license.json"
let GRACE_PERIOD_HOURS = 24.0

let LOG_DIR = FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Logs/CombyneAI"
let MAX_LOG_ROTATIONS = 3

// ── Logger ──────────────────────────────────────────────────────────────────

class AppLogger {
    static let shared = AppLogger()
    private let logPath: String
    private let fileHandle: FileHandle?
    private let dateFormatter: DateFormatter
    private let queue = DispatchQueue(label: "ai.combyne.logger", qos: .utility)

    private init() {
        dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"

        try? FileManager.default.createDirectory(atPath: LOG_DIR, withIntermediateDirectories: true)
        logPath = LOG_DIR + "/app.log"

        // Rotate existing logs
        AppLogger.rotateLogs(basePath: logPath)

        // Create fresh log file
        FileManager.default.createFile(atPath: logPath, contents: nil)
        fileHandle = FileHandle(forWritingAtPath: logPath)
        fileHandle?.seekToEndOfFile()
    }

    static func rotateLogs(basePath: String) {
        let fm = FileManager.default
        // Remove oldest
        let oldest = "\(basePath).\(MAX_LOG_ROTATIONS)"
        try? fm.removeItem(atPath: oldest)
        // Shift existing: .2 -> .3, .1 -> .2, base -> .1
        for i in stride(from: MAX_LOG_ROTATIONS - 1, through: 1, by: -1) {
            let src = "\(basePath).\(i)"
            let dst = "\(basePath).\(i + 1)"
            if fm.fileExists(atPath: src) {
                try? fm.moveItem(atPath: src, toPath: dst)
            }
        }
        if fm.fileExists(atPath: basePath) {
            try? fm.moveItem(atPath: basePath, toPath: "\(basePath).1")
        }
    }

    func log(_ level: String, _ message: String) {
        let timestamp = dateFormatter.string(from: Date())
        let line = "[\(timestamp)] [\(level)] \(message)\n"
        queue.async { [weak self] in
            if let data = line.data(using: .utf8) {
                self?.fileHandle?.write(data)
            }
        }
    }

    func info(_ message: String) { log("INFO", message) }
    func warn(_ message: String) { log("WARN", message) }
    func error(_ message: String) { log("ERROR", message) }
    func debug(_ message: String) { log("DEBUG", message) }

    func logSystemInfo() {
        let pInfo = ProcessInfo.processInfo
        let osVersion = pInfo.operatingSystemVersionString
        info("──────────────────────────────────────────────────")
        info("Combyne AI App Launch")
        info("App Version: 0.2.7")
        info("macOS: \(osVersion)")
        info("Architecture: \(machineArchitecture())")
        info("Physical Memory: \(pInfo.physicalMemory / (1024 * 1024)) MB")
        info("Processor Count: \(pInfo.processorCount)")
        info("Active Processor Count: \(pInfo.activeProcessorCount)")
        info("Hostname: \(pInfo.hostName)")

        // Disk space
        if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
           let freeSpace = attrs[.systemFreeSize] as? Int64 {
            info("Free Disk Space: \(freeSpace / (1024 * 1024 * 1024)) GB")
        }

        // Bundle info
        if let resourcePath = Bundle.main.resourcePath {
            info("Bundle Resource Path: \(resourcePath)")
            let node = resourcePath + "/node"
            let server = resourcePath + "/server-bundle.js"
            let modules = resourcePath + "/node_modules"
            let migrations = resourcePath + "/migrations"
            let skills = resourcePath + "/skills"
            info("  node binary exists: \(FileManager.default.fileExists(atPath: node))")
            info("  server-bundle.js exists: \(FileManager.default.fileExists(atPath: server))")
            info("  node_modules exists: \(FileManager.default.fileExists(atPath: modules))")
            info("  migrations exists: \(FileManager.default.fileExists(atPath: migrations))")
            info("  skills exists: \(FileManager.default.fileExists(atPath: skills))")

            // Check embedded postgres binary
            let pgBin = modules + "/@embedded-postgres/darwin-arm64/native/bin/postgres"
            info("  embedded-postgres binary exists: \(FileManager.default.fileExists(atPath: pgBin))")
        } else {
            error("Bundle.main.resourcePath is nil!")
        }
        info("Log Directory: \(LOG_DIR)")
        info("──────────────────────────────────────────────────")
    }

    private func machineArchitecture() -> String {
        var sysInfo = utsname()
        uname(&sysInfo)
        let machine = withUnsafePointer(to: &sysInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
                String(cString: $0)
            }
        }
        return machine
    }

    func flush() {
        queue.sync {
            fileHandle?.synchronizeFile()
        }
    }

    deinit {
        fileHandle?.closeFile()
    }
}

let log = AppLogger.shared

// ── Server Output Ring Buffer ───────────────────────────────────────────────

class OutputRingBuffer {
    private var lines: [String] = []
    private let maxLines: Int
    private let queue = DispatchQueue(label: "ai.combyne.ringbuffer")

    init(maxLines: Int = 100) {
        self.maxLines = maxLines
    }

    func append(_ text: String) {
        queue.sync {
            let newLines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
            lines.append(contentsOf: newLines)
            if lines.count > maxLines {
                lines.removeFirst(lines.count - maxLines)
            }
        }
    }

    func lastLines(_ count: Int) -> String {
        return queue.sync {
            let slice = lines.suffix(count)
            return slice.joined(separator: "\n")
        }
    }

    func all() -> String {
        return queue.sync {
            return lines.joined(separator: "\n")
        }
    }
}

// ── License Cache ────────────────────────────────────────────────────────────

struct LicenseCache: Codable {
    let licenseKey: String
    let machineFingerprint: String
    let lastValidated: String
    let validUntil: String
    let activationId: String
    let planTier: String
    let status: String
}

func getMachineFingerprint() -> String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { return "unknown" }
    defer { IOObjectRelease(service) }

    guard let uuidCF = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?
        .takeRetainedValue() as? String else { return "unknown" }

    let data = Data(uuidCF.utf8)
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash) }
    return hash.map { String(format: "%02x", $0) }.joined()
}

func readLicenseCache() -> LicenseCache? {
    guard FileManager.default.fileExists(atPath: LICENSE_CACHE_PATH),
          let data = FileManager.default.contents(atPath: LICENSE_CACHE_PATH) else { return nil }
    return try? JSONDecoder().decode(LicenseCache.self, from: data)
}

func writeLicenseCache(_ cache: LicenseCache) {
    let dir = (LICENSE_CACHE_PATH as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    if let data = try? JSONEncoder().encode(cache) {
        FileManager.default.createFile(atPath: LICENSE_CACHE_PATH, contents: data)
    }
}

func isLicenseCacheValid(_ cache: LicenseCache) -> Bool {
    if cache.status == "revoked" { return false }

    let dateFormatter = ISO8601DateFormatter()
    dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    guard let validUntil = dateFormatter.date(from: cache.validUntil) ?? ISO8601DateFormatter().date(from: cache.validUntil) else { return false }
    if validUntil < Date() { return false }

    guard let lastValidated = dateFormatter.date(from: cache.lastValidated) ?? ISO8601DateFormatter().date(from: cache.lastValidated) else { return false }
    let gracePeriodSeconds = GRACE_PERIOD_HOURS * 3600
    if Date().timeIntervalSince(lastValidated) > gracePeriodSeconds { return false }

    return true
}

// ── App Delegate ────────────────────────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var loadingView: NSView!
    var activationView: NSView!
    var errorView: NSView?
    var statusLabel: NSTextField!
    var retryTimer: Timer?
    var healthCheckCount = 0
    var machineFingerprint: String = ""

    // Server output capture
    var stderrBuffer = OutputRingBuffer(maxLines: 200)
    var stdoutBuffer = OutputRingBuffer(maxLines: 200)
    var serverExitCode: Int32?
    var serverStdoutLogPath: String = ""
    var serverStderrLogPath: String = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Initialize logging and log system info
        log.info("applicationDidFinishLaunching called")
        log.logSystemInfo()

        machineFingerprint = getMachineFingerprint()
        log.info("Machine fingerprint: \(machineFingerprint)")

        // Rotate server logs
        serverStdoutLogPath = LOG_DIR + "/server-stdout.log"
        serverStderrLogPath = LOG_DIR + "/server-stderr.log"
        AppLogger.rotateLogs(basePath: serverStdoutLogPath)
        AppLogger.rotateLogs(basePath: serverStderrLogPath)
        log.info("Server log files initialized")

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
        window.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.059, alpha: 1.0)

        // WebView configuration
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.preferences.setValue(true, forKey: "javaScriptCanAccessClipboard")
        config.preferences.setValue(true, forKey: "DOMPasteAllowed")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.uiDelegate = self
        window.contentView?.addSubview(webView)

        // Loading screen
        setupLoadingView()

        // Create the Edit menu with Cut/Copy/Paste (Cmd+X/C/V)
        setupMenuBar()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Check license before starting
        log.info("Starting license check flow")
        checkLicenseAndStart()
    }

    // ── License Check ────────────────────────────────────────────────────────

    func checkLicenseAndStart() {
        if let cache = readLicenseCache(), isLicenseCacheValid(cache) {
            log.info("Valid cached license found (tier: \(cache.planTier), key: \(cache.licenseKey.prefix(9))...)")
            checkHealthAndStart()
        } else {
            log.info("No valid cached license — showing activation screen")
            showActivationScreen()
        }
    }

    func showActivationScreen() {
        loadingView.isHidden = true

        activationView = NSView(frame: window.contentView!.bounds)
        activationView.autoresizingMask = [.width, .height]
        activationView.wantsLayer = true
        activationView.layer?.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.059, alpha: 1.0).cgColor

        let logoLabel = NSTextField(labelWithString: "COMBYNE.AI")
        logoLabel.font = NSFont.systemFont(ofSize: 32, weight: .heavy)
        logoLabel.textColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 1.0)
        logoLabel.alignment = .center
        logoLabel.translatesAutoresizingMaskIntoConstraints = false
        activationView.addSubview(logoLabel)

        let beeLabel = NSTextField(labelWithString: "🐝")
        beeLabel.font = NSFont.systemFont(ofSize: 48)
        beeLabel.alignment = .center
        beeLabel.translatesAutoresizingMaskIntoConstraints = false
        activationView.addSubview(beeLabel)

        let titleLabel = NSTextField(labelWithString: "Activate Your License")
        titleLabel.font = NSFont.systemFont(ofSize: 18, weight: .medium)
        titleLabel.textColor = NSColor.white
        titleLabel.alignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        activationView.addSubview(titleLabel)

        let keyField = NSTextField()
        keyField.placeholderString = "COMB-XXXX-XXXX-XXXX"
        keyField.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .medium)
        keyField.alignment = .center
        keyField.translatesAutoresizingMaskIntoConstraints = false
        keyField.wantsLayer = true
        keyField.layer?.cornerRadius = 8
        keyField.layer?.borderWidth = 1
        keyField.layer?.borderColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 0.5).cgColor
        keyField.backgroundColor = NSColor(red: 0.08, green: 0.08, blue: 0.1, alpha: 1.0)
        keyField.textColor = NSColor.white
        keyField.tag = 100
        activationView.addSubview(keyField)

        let activateButton = NSButton(title: "Activate", target: self, action: #selector(activateButtonClicked))
        activateButton.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        activateButton.translatesAutoresizingMaskIntoConstraints = false
        activateButton.wantsLayer = true
        activateButton.layer?.cornerRadius = 8
        activateButton.layer?.backgroundColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 1.0).cgColor
        activateButton.contentTintColor = NSColor.black
        activateButton.bezelStyle = .rounded
        activateButton.tag = 101
        activationView.addSubview(activateButton)

        let errorLabel = NSTextField(labelWithString: "")
        errorLabel.font = NSFont.systemFont(ofSize: 13)
        errorLabel.textColor = NSColor(red: 1.0, green: 0.4, blue: 0.4, alpha: 1.0)
        errorLabel.alignment = .center
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        errorLabel.isHidden = true
        errorLabel.tag = 102
        activationView.addSubview(errorLabel)

        NSLayoutConstraint.activate([
            beeLabel.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            beeLabel.centerYAnchor.constraint(equalTo: activationView.centerYAnchor, constant: -120),
            logoLabel.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            logoLabel.topAnchor.constraint(equalTo: beeLabel.bottomAnchor, constant: 4),
            titleLabel.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            titleLabel.topAnchor.constraint(equalTo: logoLabel.bottomAnchor, constant: 20),
            keyField.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            keyField.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 16),
            keyField.widthAnchor.constraint(equalToConstant: 320),
            keyField.heightAnchor.constraint(equalToConstant: 40),
            activateButton.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            activateButton.topAnchor.constraint(equalTo: keyField.bottomAnchor, constant: 16),
            activateButton.widthAnchor.constraint(equalToConstant: 200),
            activateButton.heightAnchor.constraint(equalToConstant: 36),
            errorLabel.centerXAnchor.constraint(equalTo: activationView.centerXAnchor),
            errorLabel.topAnchor.constraint(equalTo: activateButton.bottomAnchor, constant: 12),
            errorLabel.widthAnchor.constraint(equalToConstant: 400),
        ])

        window.contentView?.addSubview(activationView)
    }

    @objc func activateButtonClicked() {
        guard let keyField = activationView.viewWithTag(100) as? NSTextField,
              let errorLabel = activationView.viewWithTag(102) as? NSTextField,
              let activateButton = activationView.viewWithTag(101) as? NSButton else { return }

        let licenseKey = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if licenseKey.isEmpty {
            errorLabel.stringValue = "Please enter your license key"
            errorLabel.isHidden = false
            return
        }

        log.info("License activation attempt for key: \(licenseKey.prefix(9))...")
        activateButton.isEnabled = false
        activateButton.title = "Activating..."
        errorLabel.isHidden = true

        activateLicenseRemote(licenseKey: licenseKey) { [weak self] success, errorMessage, cache in
            DispatchQueue.main.async {
                activateButton.isEnabled = true
                activateButton.title = "Activate"

                if success, let cache = cache {
                    log.info("License activated successfully (tier: \(cache.planTier))")
                    log.info("Server will sync agent personas from Supabase on startup")
                    writeLicenseCache(cache)
                    self?.activationView.isHidden = true
                    self?.loadingView.isHidden = false
                    self?.loadingView.alphaValue = 1
                    self?.checkHealthAndStart()
                } else {
                    let msg = errorMessage ?? "Activation failed"
                    log.error("License activation failed: \(msg)")
                    errorLabel.stringValue = msg
                    errorLabel.isHidden = false
                }
            }
        }
    }

    func activateLicenseRemote(licenseKey: String, completion: @escaping (Bool, String?, LicenseCache?) -> Void) {
        let urlString = "\(SUPABASE_URL)/functions/v1/validate-license"
        guard let url = URL(string: urlString) else {
            completion(false, "Invalid Supabase URL", nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(SUPABASE_ANON_KEY)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let hostname = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let body: [String: String] = [
            "license_key": licenseKey,
            "machine_fingerprint": machineFingerprint,
            "action": "activate",
            "app_version": "0.2.7",
            "os_info": "macOS \(ProcessInfo.processInfo.operatingSystemVersionString) arm64",
            "machine_label": hostname,
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        log.debug("Sending license activation request to \(urlString)")

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                log.error("License activation network error: \(error.localizedDescription)")
                completion(false, "Network error: \(error.localizedDescription)", nil)
                return
            }

            if let httpResp = response as? HTTPURLResponse {
                log.debug("License server responded with status: \(httpResp.statusCode)")
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log.error("License activation: invalid response data")
                completion(false, "Invalid response from license server", nil)
                return
            }

            let valid = json["valid"] as? Bool ?? false
            if valid {
                let license = json["license"] as? [String: Any] ?? [:]
                let activation = json["activation"] as? [String: Any] ?? [:]
                let cache = LicenseCache(
                    licenseKey: licenseKey,
                    machineFingerprint: self.machineFingerprint,
                    lastValidated: ISO8601DateFormatter().string(from: Date()),
                    validUntil: license["valid_until"] as? String ?? "",
                    activationId: activation["id"] as? String ?? "",
                    planTier: license["plan_tier"] as? String ?? "starter",
                    status: "active"
                )
                completion(true, nil, cache)
            } else {
                let message = json["message"] as? String ?? "Activation failed"
                completion(false, message, nil)
            }
        }.resume()
    }

    func setupMenuBar() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Combyne AI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Combyne AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

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

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(NSMenuItem.separator())
        let fullScreenItem = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreenItem.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(fullScreenItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

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

        let beeLabel = NSTextField(labelWithString: "🐝")
        beeLabel.font = NSFont.systemFont(ofSize: 64)
        beeLabel.alignment = .center
        beeLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(beeLabel)

        let logoLabel = NSTextField(labelWithString: "COMBYNE.AI")
        logoLabel.font = NSFont.systemFont(ofSize: 32, weight: .heavy)
        logoLabel.textColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 1.0)
        logoLabel.alignment = .center
        logoLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(logoLabel)

        let taglineLabel = NSTextField(labelWithString: "The Hive That Gets Things Done")
        taglineLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        taglineLabel.textColor = NSColor(red: 0.57, green: 0.25, blue: 0.05, alpha: 1.0)
        taglineLabel.alignment = .center
        taglineLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(taglineLabel)

        statusLabel = NSTextField(labelWithString: "Starting server...")
        statusLabel.font = NSFont.systemFont(ofSize: 14, weight: .regular)
        statusLabel.textColor = NSColor(red: 0.61, green: 0.61, blue: 0.61, alpha: 1.0)
        statusLabel.alignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(statusLabel)

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)
        loadingView.addSubview(spinner)

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
        log.info("Checking if server is already running at \(HEALTH_URL)")
        let url = URL(string: HEALTH_URL)!
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                log.info("Server already running (health check OK) — loading UI")
                DispatchQueue.main.async {
                    self?.loadWebUI()
                }
            } else {
                if let error = error {
                    log.info("Health check failed (expected on cold start): \(error.localizedDescription)")
                } else {
                    log.info("Health check returned non-200 — starting server")
                }
                DispatchQueue.main.async {
                    self?.startServer()
                }
            }
        }
        task.resume()
    }

    // ── Server Start ────────────────────────────────────────────────────────

    func startServer() {
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        log.info("startServer() called")

        // ── Locate bundled resources ────────────────────────────────────
        guard let resourcePath = Bundle.main.resourcePath else {
            log.error("FATAL: Bundle.main.resourcePath is nil")
            showErrorScreen(title: "App Bundle Error", message: "Could not locate app Resources directory.\n\nThis indicates the app bundle is corrupted.", details: "Bundle.main.resourcePath returned nil")
            return
        }

        let bundledNode = resourcePath + "/node"
        let serverBundlePath = resourcePath + "/server-bundle.js"

        guard FileManager.default.fileExists(atPath: bundledNode) else {
            log.error("FATAL: Bundled Node.js binary not found at: \(bundledNode)")
            showErrorScreen(title: "Node.js Not Found", message: "The bundled Node.js binary is missing from the app.", details: "Expected path: \(bundledNode)\n\nThe app bundle may be corrupted. Try re-installing from the DMG.")
            return
        }

        guard FileManager.default.fileExists(atPath: serverBundlePath) else {
            log.error("FATAL: server-bundle.js not found at: \(serverBundlePath)")
            showErrorScreen(title: "Server Bundle Not Found", message: "server-bundle.js is missing from app Resources.", details: "Expected path: \(serverBundlePath)\n\nThe app bundle may be corrupted. Try re-installing from the DMG.")
            return
        }

        // Verify node binary is executable
        if !FileManager.default.isExecutableFile(atPath: bundledNode) {
            log.error("Node binary exists but is not executable: \(bundledNode)")
            showErrorScreen(title: "Node.js Permission Error", message: "The bundled Node.js binary is not executable.", details: "Path: \(bundledNode)\n\nTry running: chmod +x \"\(bundledNode)\"")
            return
        }

        log.info("Bundled resources verified:")
        log.info("  Node.js: \(bundledNode)")
        log.info("  Server bundle: \(serverBundlePath)")
        log.info("  Resource path: \(resourcePath)")

        statusLabel.stringValue = "Starting server..."

        // ── Set up data directory ───────────────────────────────────────
        let dataDir = "\(homeDir)/.combyne-ai"
        let configDir = "\(dataDir)/instances/default"
        let configFile = "\(configDir)/config.json"

        log.info("Data directory: \(dataDir)")

        do {
            try FileManager.default.createDirectory(atPath: "\(configDir)/logs", withIntermediateDirectories: true)
            try FileManager.default.createDirectory(atPath: "\(configDir)/data", withIntermediateDirectories: true)
            log.info("Data directories created/verified")
        } catch {
            log.error("Failed to create data directories: \(error.localizedDescription)")
        }

        if !FileManager.default.fileExists(atPath: configFile) {
            let configJSON = """
            {"server":{"host":"127.0.0.1","port":3100,"deploymentMode":"local_trusted","exposure":"private"},"database":{"mode":"embedded-postgres","embeddedPostgresPort":54329},"logging":{"level":"info"},"storage":{"mode":"local"},"secrets":{"mode":"env"},"auth":{"baseUrlMode":"auto"}}
            """
            try? configJSON.write(toFile: configFile, atomically: true, encoding: .utf8)
            log.info("Default config.json created at: \(configFile)")
        } else {
            log.info("Existing config.json found at: \(configFile)")
        }

        // Kill any zombie processes from previous launches.
        log.info("Cleaning up zombie processes...")
        let cleanup = Process()
        cleanup.executableURL = URL(fileURLWithPath: "/bin/bash")
        cleanup.arguments = ["-c", "pkill -9 -f 'server-bundle.js' 2>/dev/null; lsof -ti:54329 2>/dev/null | xargs kill -9 2>/dev/null; sleep 1"]
        cleanup.standardOutput = FileHandle.nullDevice
        cleanup.standardError = FileHandle.nullDevice
        try? cleanup.run()
        cleanup.waitUntilExit()
        log.info("Zombie cleanup complete")

        // ── Set up log file handles ─────────────────────────────────────
        try? FileManager.default.createDirectory(atPath: LOG_DIR, withIntermediateDirectories: true)

        FileManager.default.createFile(atPath: serverStdoutLogPath, contents: nil)
        FileManager.default.createFile(atPath: serverStderrLogPath, contents: nil)

        let stdoutFileHandle = FileHandle(forWritingAtPath: serverStdoutLogPath)
        let stderrFileHandle = FileHandle(forWritingAtPath: serverStderrLogPath)

        log.info("Server stdout log: \(serverStdoutLogPath)")
        log.info("Server stderr log: \(serverStderrLogPath)")

        // ── Set up pipes for capturing output ───────────────────────────
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        // Read stdout in background
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            // Write to log file
            stdoutFileHandle?.write(data)
            // Write to ring buffer
            if let text = String(data: data, encoding: .utf8) {
                self?.stdoutBuffer.append(text)
            }
        }

        // Read stderr in background
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            // Write to log file
            stderrFileHandle?.write(data)
            // Write to ring buffer
            if let text = String(data: data, encoding: .utf8) {
                self?.stderrBuffer.append(text)
            }
        }

        // ── Start the bundled server ────────────────────────────────────
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bundledNode)
        process.arguments = [serverBundlePath]
        process.currentDirectoryURL = URL(fileURLWithPath: resourcePath)
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["COMBYNE_HOME"] = dataDir
        env["COMBYNE_CONFIG"] = configFile
        env["COMBYNE_DEPLOYMENT_MODE"] = "local_trusted"
        env["COMBYNE_LICENSE_ENABLED"] = "true"
        env["COMBYNE_LICENSE_SUPABASE_URL"] = SUPABASE_URL
        env["COMBYNE_LICENSE_SUPABASE_ANON_KEY"] = SUPABASE_ANON_KEY
        env["COMBYNE_MACHINE_FINGERPRINT"] = machineFingerprint
        env["SERVE_UI"] = "true"
        env["HOST"] = "127.0.0.1"
        env["PORT"] = "\(APP_PORT)"
        env["NODE_PATH"] = resourcePath + "/node_modules"
        env["COMBYNE_SKILLS_DIR"] = resourcePath + "/skills"
        env["PATH"] = "\(resourcePath)/node_modules/@embedded-postgres/darwin-arm64/native/bin:\(homeDir)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(env["PATH"] ?? "")"
        process.environment = env

        log.info("Server environment configured:")
        log.info("  COMBYNE_HOME=\(dataDir)")
        log.info("  COMBYNE_CONFIG=\(configFile)")
        log.info("  NODE_PATH=\(resourcePath)/node_modules")
        log.info("  PORT=\(APP_PORT)")

        // Handle process termination
        process.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            let reason = proc.terminationReason
            self?.serverExitCode = code
            log.error("Server process terminated — exit code: \(code), reason: \(reason == .exit ? "exit" : "uncaughtSignal")")

            // Close pipe handlers
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            stdoutFileHandle?.closeFile()
            stderrFileHandle?.closeFile()

            // Log the last stderr output
            let lastStderr = self?.stderrBuffer.lastLines(30) ?? "(empty)"
            log.error("Last server stderr output:\n\(lastStderr)")
            log.flush()
        }

        do {
            try process.run()
            serverProcess = process
            log.info("Server process launched (PID: \(process.processIdentifier))")
            statusLabel.stringValue = "Server starting..."
            startHealthPolling()
        } catch {
            log.error("FATAL: Failed to launch server process: \(error.localizedDescription)")
            showErrorScreen(
                title: "Failed to Start Server",
                message: "The Node.js server process could not be launched.",
                details: "Error: \(error.localizedDescription)\n\nNode path: \(bundledNode)\nServer bundle: \(serverBundlePath)"
            )
        }
    }

    // ── Health Polling ───────────────────────────────────────────────────────

    func startHealthPolling() {
        healthCheckCount = 0
        log.info("Starting health polling (interval: 2s)")

        retryTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            self.healthCheckCount += 1

            // Check if server process died
            if let proc = self.serverProcess, !proc.isRunning {
                if self.healthCheckCount > 5 {
                    timer.invalidate()
                    let exitCode = self.serverExitCode ?? proc.terminationStatus
                    let reason = proc.terminationReason == .exit ? "exit" : "uncaughtSignal"
                    log.error("Server process is dead after \(self.healthCheckCount) health checks (exit code: \(exitCode), reason: \(reason))")

                    let lastStderr = self.stderrBuffer.lastLines(30)
                    let lastStdout = self.stdoutBuffer.lastLines(10)

                    var details = "Exit code: \(exitCode)\nTermination reason: \(reason)\n"
                    details += "Health checks attempted: \(self.healthCheckCount)\n\n"
                    if !lastStderr.isEmpty {
                        details += "── Last Server Error Output ──\n\(lastStderr)\n\n"
                    }
                    if !lastStdout.isEmpty {
                        details += "── Last Server Output ──\n\(lastStdout)"
                    }
                    if lastStderr.isEmpty && lastStdout.isEmpty {
                        details += "No server output was captured. The process may have crashed immediately."
                    }

                    DispatchQueue.main.async {
                        self.showErrorScreen(
                            title: "Server Stopped Unexpectedly",
                            message: "The Combyne AI server process exited with code \(exitCode).",
                            details: details
                        )
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
                } else if self.healthCheckCount < 30 {
                    self.statusLabel.stringValue = "Almost ready..."
                } else {
                    self.statusLabel.stringValue = "Still starting (check \(self.healthCheckCount)/60)..."
                }
            }

            if self.healthCheckCount % 10 == 0 {
                log.debug("Health check #\(self.healthCheckCount) — still waiting")
            }

            // Health check
            let url = URL(string: HEALTH_URL)!
            let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    timer.invalidate()
                    log.info("Health check passed after \(self?.healthCheckCount ?? 0) attempts — server is ready!")
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
                log.error("Server startup timed out after \(self.healthCheckCount * 2) seconds")
                let lastStderr = self.stderrBuffer.lastLines(30)
                let lastStdout = self.stdoutBuffer.lastLines(10)

                var details = "The server did not respond to health checks within 2 minutes.\n\n"
                if !lastStderr.isEmpty {
                    details += "── Last Server Error Output ──\n\(lastStderr)\n\n"
                }
                if !lastStdout.isEmpty {
                    details += "── Last Server Output ──\n\(lastStdout)"
                }

                DispatchQueue.main.async {
                    self.showErrorScreen(
                        title: "Server Startup Timeout",
                        message: "The server did not become ready within 2 minutes.",
                        details: details
                    )
                }
            }
        }
    }

    // ── Error Screen with Download Logs ──────────────────────────────────────

    func showErrorScreen(title: String, message: String, details: String) {
        log.error("Showing error screen: \(title) — \(message)")
        log.flush()

        // Remove existing views
        loadingView?.isHidden = true
        activationView?.isHidden = true
        webView?.isHidden = true
        errorView?.removeFromSuperview()

        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.059, alpha: 1.0).cgColor
        errorView = container

        // Error icon
        let iconLabel = NSTextField(labelWithString: "⚠️")
        iconLabel.font = NSFont.systemFont(ofSize: 48)
        iconLabel.alignment = .center
        iconLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(iconLabel)

        // Title
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = NSFont.systemFont(ofSize: 22, weight: .bold)
        titleLabel.textColor = NSColor(red: 1.0, green: 0.4, blue: 0.4, alpha: 1.0)
        titleLabel.alignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(titleLabel)

        // Message
        let messageLabel = NSTextField(labelWithString: message)
        messageLabel.font = NSFont.systemFont(ofSize: 14)
        messageLabel.textColor = NSColor(red: 0.8, green: 0.8, blue: 0.8, alpha: 1.0)
        messageLabel.alignment = .center
        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        messageLabel.maximumNumberOfLines = 3
        messageLabel.lineBreakMode = .byWordWrapping
        messageLabel.preferredMaxLayoutWidth = 500
        container.addSubview(messageLabel)

        // Scrollable details text view
        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        scrollView.wantsLayer = true
        scrollView.layer?.cornerRadius = 6

        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textColor = NSColor(red: 0.85, green: 0.85, blue: 0.85, alpha: 1.0)
        textView.backgroundColor = NSColor(red: 0.06, green: 0.06, blue: 0.08, alpha: 1.0)
        textView.string = details
        textView.textContainerInset = NSSize(width: 8, height: 8)
        scrollView.documentView = textView
        container.addSubview(scrollView)

        // Button row
        let buttonStack = NSStackView()
        buttonStack.orientation = .horizontal
        buttonStack.spacing = 12
        buttonStack.translatesAutoresizingMaskIntoConstraints = false

        let downloadButton = makeButton(title: "Download Logs", action: #selector(downloadLogsClicked), primary: true)
        let openFolderButton = makeButton(title: "Open Logs Folder", action: #selector(openLogsFolderClicked), primary: false)
        let retryButton = makeButton(title: "Retry", action: #selector(retryClicked), primary: false)
        let copyButton = makeButton(title: "Copy Error", action: #selector(copyErrorClicked), primary: false)
        copyButton.tag = 200

        buttonStack.addArrangedSubview(downloadButton)
        buttonStack.addArrangedSubview(openFolderButton)
        buttonStack.addArrangedSubview(retryButton)
        buttonStack.addArrangedSubview(copyButton)
        container.addSubview(buttonStack)

        // Store details for copy
        objc_setAssociatedObject(container, "errorDetails", "\(title)\n\(message)\n\n\(details)", .OBJC_ASSOCIATION_RETAIN)

        NSLayoutConstraint.activate([
            iconLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            iconLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: 40),

            titleLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            titleLabel.topAnchor.constraint(equalTo: iconLabel.bottomAnchor, constant: 8),

            messageLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            messageLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 8),
            messageLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 550),

            scrollView.topAnchor.constraint(equalTo: messageLabel.bottomAnchor, constant: 16),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 40),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -40),
            scrollView.bottomAnchor.constraint(equalTo: buttonStack.topAnchor, constant: -16),

            buttonStack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            buttonStack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -24),
        ])

        window.contentView?.addSubview(container)
    }

    func makeButton(title: String, action: Selector, primary: Bool) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.font = NSFont.systemFont(ofSize: 13, weight: primary ? .semibold : .regular)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 6
        if primary {
            button.layer?.backgroundColor = NSColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 1.0).cgColor
            button.contentTintColor = NSColor.black
        } else {
            button.layer?.backgroundColor = NSColor(red: 0.15, green: 0.15, blue: 0.18, alpha: 1.0).cgColor
            button.contentTintColor = NSColor.white
        }
        button.bezelStyle = .rounded
        button.heightAnchor.constraint(equalToConstant: 32).isActive = true
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        return button
    }

    @objc func downloadLogsClicked() {
        log.info("User clicked Download Logs")
        log.flush()

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd_HHmmss"
        let timestamp = dateFormatter.string(from: Date())
        let zipName = "CombyneAI-Logs-\(timestamp).zip"

        let savePanel = NSSavePanel()
        savePanel.nameFieldStringValue = zipName
        savePanel.allowedContentTypes = [.zip]
        savePanel.canCreateDirectories = true

        savePanel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = savePanel.url else { return }
            self?.createLogZip(at: url)
        }
    }

    func createLogZip(at destination: URL) {
        log.info("Creating log zip at: \(destination.path)")

        // Create a temporary directory with all logs
        let tempDir = NSTemporaryDirectory() + "combyne-logs-\(ProcessInfo.processInfo.processIdentifier)"
        try? FileManager.default.removeItem(atPath: tempDir)
        try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

        // Copy log files
        let logFiles = [
            "app.log", "app.log.1", "app.log.2", "app.log.3",
            "server-stdout.log", "server-stdout.log.1", "server-stdout.log.2", "server-stdout.log.3",
            "server-stderr.log", "server-stderr.log.1", "server-stderr.log.2", "server-stderr.log.3",
        ]
        for file in logFiles {
            let src = LOG_DIR + "/" + file
            if FileManager.default.fileExists(atPath: src) {
                try? FileManager.default.copyItem(atPath: src, toPath: tempDir + "/" + file)
            }
        }

        // Write system info
        let pInfo = ProcessInfo.processInfo
        var sysInfo = "Combyne AI Diagnostic Report\n"
        sysInfo += "Generated: \(ISO8601DateFormatter().string(from: Date()))\n"
        sysInfo += "App Version: 0.2.7\n"
        sysInfo += "macOS: \(pInfo.operatingSystemVersionString)\n"
        sysInfo += "Physical Memory: \(pInfo.physicalMemory / (1024 * 1024)) MB\n"
        sysInfo += "Processors: \(pInfo.processorCount) (\(pInfo.activeProcessorCount) active)\n"
        sysInfo += "Hostname: \(pInfo.hostName)\n"
        if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
           let freeSpace = attrs[.systemFreeSize] as? Int64 {
            sysInfo += "Free Disk Space: \(freeSpace / (1024 * 1024 * 1024)) GB\n"
        }
        if let resourcePath = Bundle.main.resourcePath {
            sysInfo += "Bundle Resource Path: \(resourcePath)\n"
        }
        sysInfo += "Server Exit Code: \(serverExitCode.map { String($0) } ?? "N/A")\n"
        sysInfo += "\n── In-Memory Stderr (last 50 lines) ──\n"
        sysInfo += stderrBuffer.lastLines(50)
        sysInfo += "\n\n── In-Memory Stdout (last 20 lines) ──\n"
        sysInfo += stdoutBuffer.lastLines(20)

        try? sysInfo.write(toFile: tempDir + "/system-info.txt", atomically: true, encoding: .utf8)

        // Zip it
        let zipProcess = Process()
        zipProcess.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        zipProcess.arguments = ["-r", "-j", destination.path, tempDir]
        zipProcess.standardOutput = FileHandle.nullDevice
        zipProcess.standardError = FileHandle.nullDevice
        try? zipProcess.run()
        zipProcess.waitUntilExit()

        // Cleanup temp
        try? FileManager.default.removeItem(atPath: tempDir)

        if zipProcess.terminationStatus == 0 {
            log.info("Log zip created successfully at: \(destination.path)")
            // Reveal in Finder
            NSWorkspace.shared.selectFile(destination.path, inFileViewerRootedAtPath: "")
        } else {
            log.error("Failed to create log zip (zip exit code: \(zipProcess.terminationStatus))")
            showAlert("Failed to create log zip. You can manually access logs at:\n\(LOG_DIR)")
        }
    }

    @objc func openLogsFolderClicked() {
        log.info("User clicked Open Logs Folder")
        NSWorkspace.shared.open(URL(fileURLWithPath: LOG_DIR))
    }

    @objc func retryClicked() {
        log.info("User clicked Retry")
        errorView?.removeFromSuperview()
        errorView = nil
        loadingView.isHidden = false
        loadingView.alphaValue = 1
        statusLabel.stringValue = "Retrying..."

        // Kill existing server if any
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }

        // Reset buffers
        stderrBuffer = OutputRingBuffer(maxLines: 200)
        stdoutBuffer = OutputRingBuffer(maxLines: 200)
        serverExitCode = nil

        // Small delay then restart
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.startServer()
        }
    }

    @objc func copyErrorClicked() {
        log.info("User clicked Copy Error")
        if let errorView = errorView,
           let details = objc_getAssociatedObject(errorView, "errorDetails") as? String {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(details, forType: .string)

            // Visual feedback — briefly change button title
            if let button = errorView.viewWithTag(200) as? NSButton {
                let original = button.title
                button.title = "Copied!"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    button.title = original
                }
            }
        }
    }

    // ── Web UI ──────────────────────────────────────────────────────────────

    func loadWebUI() {
        log.info("Loading web UI at \(APP_URL)")
        let url = URL(string: APP_URL)!
        webView.load(URLRequest(url: url))

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

    // ── WKUIDelegate: JavaScript alert(), confirm(), prompt() ──────────────

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Combyne AI"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Combyne AI"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Combyne AI"
        alert.informativeText = prompt
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
    }

    func showAlert(_ message: String) {
        log.warn("Alert shown: \(message)")
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
        log.info("applicationWillTerminate — shutting down")

        if let proc = serverProcess, proc.isRunning {
            log.info("Terminating server process (PID: \(proc.processIdentifier))")
            proc.terminate()
        }

        let killProc = Process()
        killProc.executableURL = URL(fileURLWithPath: "/bin/bash")
        killProc.arguments = ["-c", "pkill -f 'server-bundle.js' 2>/dev/null; sleep 1; lsof -ti:54329 2>/dev/null | xargs kill 2>/dev/null"]
        killProc.standardOutput = FileHandle.nullDevice
        killProc.standardError = FileHandle.nullDevice
        try? killProc.run()
        killProc.waitUntilExit()

        log.info("Shutdown complete")
        log.flush()
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
