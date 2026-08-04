package com.azazel.collab.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/** A deliberately small allow-list shared by native entry points into the webview shell. */
object CollabAppDestination {
  const val ACTION_OPEN = "com.collab.companion.OPEN_DESTINATION"
  const val EXTRA_KIND = "collabDestinationKind"
  const val EXTRA_DATE = "collabDestinationDate"
  const val EXTRA_ITEM_ID = "collabDestinationItemId"
  const val EXTRA_VAULT_ID = "collabDestinationVaultId"
  const val EXTRA_FILE_ID = "collabDestinationFileId"
  const val EXTRA_CARD_ID = "collabDestinationCardId"
  private const val PREFS = "collab-app-destination"
  private const val PENDING_JSON = "pendingJson"
  private val allowedKinds = setOf(
    "calendar-today",
    "calendar-date",
    "calendar-create",
    "calendar-item",
    "kanban-card",
    // Quick capture opens an existing mobile flow; the widget never captures
    // content itself and requests no permission of its own.
    "capture-note",
    "capture-task",
    "capture-files",
    // Vault shortcuts resolve by stable opaque identity, never by path or URL.
    "vault-file",
    "vault-folder",
    "vault-list",
    // Sync recovery. These carry no target of their own: they open the settings
    // category where the state is explained and can actually be fixed.
    "settings-background",
    "settings-account",
  )
  private val vaultTargetKinds = setOf("vault-file", "vault-folder")
  private val datePattern = Regex("^\\d{4}-\\d{2}-\\d{2}$")
  private val itemIdPattern = Regex("^[A-Za-z0-9_.:-]{1,128}$")

  /** An opaque vault target. It deliberately carries no server URL or path: the
   * app resolves the owning server from the vault it is already signed in to.
   * `cardId` is set only for a Kanban card. */
  data class VaultTarget(
    val vaultId: String,
    val fileId: String,
    val cardId: String? = null,
  )

  fun intent(
    context: Context,
    kind: String,
    date: String? = null,
    itemId: String? = null,
    vault: VaultTarget? = null,
  ): Intent {
    require(kind in allowedKinds) { "Unsupported Collab destination." }
    require(date == null || datePattern.matches(date)) { "Invalid calendar destination date." }
    require(itemId == null || itemIdPattern.matches(itemId)) { "Invalid calendar item destination." }
    require(kind != "calendar-item" || itemId != null) { "Calendar item destination is incomplete." }
    require(kind !in vaultTargetKinds || vault != null) { "Vault destination is incomplete." }
    require(kind != "kanban-card" || vault?.cardId != null) { "Kanban destination is incomplete." }
    require(
      vault == null ||
        (
          itemIdPattern.matches(vault.vaultId) &&
            itemIdPattern.matches(vault.fileId) &&
            (vault.cardId == null || itemIdPattern.matches(vault.cardId))
          ),
    ) { "Invalid vault destination." }
    return Intent(context, MainActivity::class.java)
      .setAction(ACTION_OPEN)
      // PendingIntent identity deliberately ignores extras. Give every
      // destination a stable, distinct data URI so day taps cannot collapse
      // into the add action or another date when Glance builds RemoteViews.
      .setData(
        Uri.Builder()
          .scheme("collab")
          .authority("destination")
          .appendPath(kind)
          .apply { if (date != null) appendQueryParameter("date", date) }
          .apply { if (itemId != null) appendQueryParameter("item", itemId) }
          .apply {
            if (vault != null) {
              appendQueryParameter("vault", vault.vaultId)
              appendQueryParameter("file", vault.fileId)
              if (vault.cardId != null) appendQueryParameter("card", vault.cardId)
            }
          }
          .build(),
      )
      .putExtra(EXTRA_KIND, kind)
      .apply { if (date != null) putExtra(EXTRA_DATE, date) }
      .apply { if (itemId != null) putExtra(EXTRA_ITEM_ID, itemId) }
      .apply {
        if (vault != null) {
          putExtra(EXTRA_VAULT_ID, vault.vaultId)
          putExtra(EXTRA_FILE_ID, vault.fileId)
          if (vault.cardId != null) putExtra(EXTRA_CARD_ID, vault.cardId)
        }
      }
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
    val vaultId = intent.getStringExtra(EXTRA_VAULT_ID)
    val fileId = intent.getStringExtra(EXTRA_FILE_ID)
    val cardId = intent.getStringExtra(EXTRA_CARD_ID)
    if (listOf(vaultId, fileId, cardId).any { it != null && !itemIdPattern.matches(it) }) return null
    if (kind == "kanban-card" && (vaultId == null || fileId == null || cardId == null)) return null
    if (kind in vaultTargetKinds && (vaultId == null || fileId == null)) return null
    val value = JSONObject().put("kind", kind)
    if (date != null) value.put("date", date)
    if (itemId != null) value.put("itemId", itemId)
    if (vaultId != null) value.put("vaultId", vaultId)
    if (fileId != null) value.put("fileId", fileId)
    if (cardId != null) value.put("cardId", cardId)
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

  @JvmStatic
  fun takePendingJson(context: Context): String? = takePending(context)?.toString()
}
