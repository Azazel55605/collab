package com.azazel.collab.companion

import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** A deliberately small allow-list shared by native entry points into the webview shell. */
object CollabAppDestination {
  const val ACTION_OPEN = "com.collab.companion.OPEN_DESTINATION"
  const val EXTRA_KIND = "collabDestinationKind"
  const val EXTRA_DATE = "collabDestinationDate"
  const val EXTRA_ITEM_ID = "collabDestinationItemId"
  private const val PREFS = "collab-app-destination"
  private const val PENDING_JSON = "pendingJson"
  private val allowedKinds = setOf("calendar-today", "calendar-date", "calendar-create", "calendar-item")
  private val datePattern = Regex("^\\d{4}-\\d{2}-\\d{2}$")
  private val itemIdPattern = Regex("^[A-Za-z0-9_.:-]{1,128}$")

  fun intent(context: Context, kind: String, date: String? = null, itemId: String? = null): Intent {
    require(kind in allowedKinds) { "Unsupported Collab destination." }
    require(date == null || datePattern.matches(date)) { "Invalid calendar destination date." }
    require(itemId == null || itemIdPattern.matches(itemId)) { "Invalid calendar item destination." }
    require(kind != "calendar-item" || itemId != null) { "Calendar item destination is incomplete." }
    return Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN)
      .putExtra(EXTRA_KIND, kind)
      .apply { if (date != null) putExtra(EXTRA_DATE, date) }
      .apply { if (itemId != null) putExtra(EXTRA_ITEM_ID, itemId) }
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }

  fun capture(context: Context, intent: Intent?): JSONObject? {
    if (intent?.action != ACTION_OPEN) return null
    val kind = intent.getStringExtra(EXTRA_KIND) ?: return null
    if (kind !in allowedKinds) return null
    val date = intent.getStringExtra(EXTRA_DATE)
    if (date != null && !datePattern.matches(date)) return null
    val itemId = intent.getStringExtra(EXTRA_ITEM_ID)
    if (itemId != null && !itemIdPattern.matches(itemId)) return null
    if (kind == "calendar-item" && itemId == null) return null
    val value = JSONObject().put("kind", kind)
    if (date != null) value.put("date", date)
    if (itemId != null) value.put("itemId", itemId)
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
