
import SwiftUI
import WebKit
import AVFoundation

struct WebView: UIViewRepresentable {
    let url: URL
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var isLoading: Bool
    var externalURLHandler: (URL) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(self, externalURLHandler: externalURLHandler)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.keyboardDismissMode = .onDrag

        // Enable WebRTC camera/mic in WKWebView (Info.plist must include usage descriptions)
        AVCaptureDevice.requestAccess(for: .video) { _ in }
        AVCaptureDevice.requestAccess(for: .audio) { _ in }

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // no-op
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebView
        var externalURLHandler: (URL) -> Void

        init(_ parent: WebView, externalURLHandler: @escaping (URL) -> Void) {
            self.parent = parent
            self.externalURLHandler = externalURLHandler
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            parent.canGoBack = webView.canGoBack
            parent.canGoForward = webView.canGoForward

            if let url = navigationAction.request.url {
                // Only allow your domains inside the webview; open others in Safari
                let allowedHosts = ["robovet.aristocles24.workers.dev", "dascient.com"]
                if let host = url.host, !allowedHosts.contains(where: { host.hasSuffix($0) }) {
                    decisionHandler(.cancel)
                    DispatchQueue.main.async { self.externalURLHandler(url) }
                    return
                }
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.isLoading = true
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
            NotificationCenter.default.post(name: .webViewURLDidChange, object: webView.url)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
        }

        // Handle target="_blank" and JS alerts, confirms, file inputs
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                DispatchQueue.main.async { self.externalURLHandler(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            completionHandler()
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // Allow camera/mic after user has granted iOS permission (Info.plist keys mandatory)
            decisionHandler(.grant)
        }
    }
}
