package com.azazel.collab.companion

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var pendingNotificationOpen: Pair<String, String>? = null
  private var pendingAppDestination: JSONObject? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    CollabNotificationBridge.ensureChannels(this)
    CollabWidgetBridge.requestPhase0Rebuild(applicationContext)
    captureNotificationIntent(intent)
    captureAppDestination(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureNotificationIntent(intent)
    captureAppDestination(intent)
  }

  override fun onResume() {
    super.onResume()
    activeActivity = WeakReference(this)
    CollabNotificationBridge.refreshPushRegistration(applicationContext)
  }

  override fun onPause() {
    if (activeActivity?.get() === this) activeActivity = null
    super.onPause()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    dispatchPendingNotificationOpen()
    dispatchPendingAppDestination()
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          webView.evaluateJavascript(
            "window.dispatchEvent(new Event('collab-android-back'))",
            null,
          )
        }
      },
    )
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != CollabNotificationBridge.PERMISSION_REQUEST_CODE) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      CollabNotificationScheduler.reconcileAll(applicationContext)
    }
    appWebView?.evaluateJavascript(
      "window.dispatchEvent(new Event('collab-notification-permission-changed'))",
      null,
    )
  }

  private fun captureNotificationIntent(intent: Intent?) {
    if (intent?.action != CollabNotificationBridge.ACTION_OPEN) return
    val profileId = intent.getStringExtra(CollabNotificationBridge.EXTRA_PROFILE_ID) ?: return
    val notificationId =
      intent.getStringExtra(CollabNotificationBridge.EXTRA_NOTIFICATION_ID) ?: return
    CollabNotificationBridge.persistPendingOpen(this, profileId, notificationId)
    pendingNotificationOpen = profileId to notificationId
    dispatchPendingNotificationOpen()
  }

  private fun dispatchPendingNotificationOpen() {
    val webView = appWebView ?: return
    val (profileId, notificationId) = pendingNotificationOpen ?: return
    pendingNotificationOpen = null
    val detail = JSONObject()
      .put("profileId", profileId)
      .put("notificationId", notificationId)
      .toString()
    webView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('collab-notification-open',{detail:$detail}))",
      null,
    )
  }

  private fun captureAppDestination(intent: Intent?) {
    pendingAppDestination = CollabAppDestination.capture(this, intent) ?: pendingAppDestination
    dispatchPendingAppDestination()
  }

  private fun dispatchPendingAppDestination() {
    val webView = appWebView ?: return
    val destination = pendingAppDestination ?: CollabAppDestination.takePending(this) ?: return
    pendingAppDestination = null
    // Clear the durable copy only after the webview exists so cold starts cannot lose the tap.
    CollabAppDestination.takePending(this)
    webView.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('collab-app-destination',{detail:$destination}))",
      null,
    )
  }

  companion object {
    private var activeActivity: WeakReference<MainActivity>? = null

    fun currentActivity(): MainActivity? = activeActivity?.get()
  }
}
