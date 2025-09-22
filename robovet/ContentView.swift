
import SwiftUI
import WebKit
import SafariServices

private let START_URL = URL(string: "https://robovet.aristocles24.workers.dev/")!
// Fallback (if Workers is down):
private let SECONDARY_URL = URL(string: "https://dascient.com/robovet/")!

struct ContentView: View {
    @State private var currentURL: URL = START_URL
    @State private var canGoBack: Bool = false
    @State private var canGoForward: Bool = false
    @State private var isLoading: Bool = true
    @State private var showShareSheet: Bool = false
    @State private var safariURL: URL? = nil

    var body: some View {
        ZStack {
            WebView(url: currentURL, canGoBack: $canGoBack, canGoForward: $canGoForward, isLoading: $isLoading, externalURLHandler: { url in
                safariURL = url
            })
            .edgesIgnoringSafeArea(.all)
            .refreshable {
                NotificationCenter.default.post(name: .webViewReload, object: nil)
            }

            if isLoading {
                ProgressView().progressViewStyle(CircularProgressViewStyle())
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button(action: { NotificationCenter.default.post(name: .webViewBack, object: nil) }) {
                    Image(systemName: "chevron.backward")
                }.disabled(!canGoBack)

                Button(action: { NotificationCenter.default.post(name: .webViewForward, object: nil) }) {
                    Image(systemName: "chevron.forward")
                }.disabled(!canGoForward)

                Spacer()

                Button(action: { showShareSheet = true }) {
                    Image(systemName: "square.and.arrow.up")
                }

                Button(action: { NotificationCenter.default.post(name: .webViewReload, object: nil) }) {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        .sheet(isPresented: Binding<Bool>(
            get: { safariURL != nil },
            set: { if !$0 { safariURL = nil } }
        )) {
            if let url = safariURL {
                SafariView(url: url)
            }
        }
        .sheet(isPresented: $showShareSheet) {
            let items: [Any] = [currentURL]
            ActivityView(activityItems: items)
        }
        .onReceive(NotificationCenter.default.publisher(for: .webViewURLDidChange)) { note in
            if let url = note.object as? URL {
                currentURL = url
            }
        }
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

extension Notification.Name {
    static let webViewBack = Notification.Name("webViewBack")
    static let webViewForward = Notification.Name("webViewForward")
    static let webViewReload = Notification.Name("webViewReload")
    static let webViewURLDidChange = Notification.Name("webViewURLDidChange")
}
