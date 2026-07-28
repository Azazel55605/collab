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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    CollabNotificationBridge.ensureChannels(this)
    captureNotificationIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureNotificationIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    activeActivity = WeakReference(this)
  }

  override fun onPause() {
    if (activeActivity?.get() === this) activeActivity = null
    super.onPause()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    dispatchPendingNotificationOpen()
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

  companion object {
    private var activeActivity: WeakReference<MainActivity>? = null

    fun currentActivity(): MainActivity? = activeActivity?.get()
  }
}
