package com.azazel.collab.companion

import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** A deliberately small allow-list shared by native entry points into the webview shell. */
object CollabAppDestination {
  const val ACTION_OPEN = "com.collab.companion.OPEN_DESTINATION"
  const val EXTRA_KIND = "collabDestinationKind"
  const val EXTRA_DATE = "collabDestinationDate"
  private const val PREFS = "collab-app-destination"
  private const val PENDING_JSON = "pendingJson"
  private val allowedKinds = setOf("calendar-today", "calendar-date", "calendar-create")
  private val datePattern = Regex("^\\d{4}-\\d{2}-\\d{2}$")

  fun intent(context: Context, kind: String, date: String? = null): Intent {
    require(kind in allowedKinds) { "Unsupported Collab destination." }
    require(date == null || datePattern.matches(date)) { "Invalid calendar destination date." }
    return Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN)
      .putExtra(EXTRA_KIND, kind)
      .apply { if (date != null) putExtra(EXTRA_DATE, date) }
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }

  fun capture(context: Context, intent: Intent?): JSONObject? {
    if (intent?.action != ACTION_OPEN) return null
    val kind = intent.getStringExtra(EXTRA_KIND) ?: return null
    if (kind !in allowedKinds) return null
    val date = intent.getStringExtra(EXTRA_DATE)
    if (date != null && !datePattern.matches(date)) return null
    val value = JSONObject().put("kind", kind)
    if (date != null) value.put("date", date)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PENDING_JSON, value.toString())
      .apply()
    return value
  }

  fun takePending(context: Context): JSONObject? {
    val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val raw = preferences.getString(PENDING_JSON, null) ?: return null
    preferences.edit().remove(PENDING_JSON).apply()
    return runCatching { JSONObject(raw) }.getOrNull()
  }
}
