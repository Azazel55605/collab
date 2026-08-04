package com.azazel.collab.companion

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.system.Os
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.currentState
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.AppWidgetId
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Box
import androidx.glance.layout.Alignment
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.width
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

private val AgendaWidgetSnapshotStateKey = stringPreferencesKey("agenda-widget-snapshot-v1")
private val MonthOffsetStateKey = intPreferencesKey("month-widget-offset-v1")
/** The task a launcher tap asked to complete, awaiting in-place confirmation. */
private val TaskPendingCompleteStateKey = stringPreferencesKey("tasks-widget-pending-complete-v1")
private val TaskActionMessageStateKey = stringPreferencesKey("tasks-widget-action-message-v1")
private val TaskItemIdParameter = ActionParameters.Key<String>("collabTaskItemId")
private const val MIN_MONTH_OFFSET = -6
private const val MAX_MONTH_OFFSET = 6
/** Stacked bar lanes per week row. Mirrors `MAX_MONTH_LANES` in widgets.rs. */
internal const val MAX_MONTH_LANES = 3

internal enum class AgendaWidgetUpdateOrigin { External, Provider }

internal fun shouldNotifyAgendaWidgetProvider(origin: AgendaWidgetUpdateOrigin): Boolean =
  origin == AgendaWidgetUpdateOrigin.External

internal data class AgendaWidgetItem(
  val title: String,
  val detail: String,
  val section: String?,
  val itemKind: String?,
  val itemId: String?,
  val dayKey: String?,
  val sourceColor: String?,
  val task: AgendaWidgetTask? = null,
  val shortcut: AgendaWidgetShortcut? = null,
)

/** A capture tile or vault shortcut target. Every field is an opaque validated
 * identifier; the launcher never sees a path, URL, or server origin. */
internal data class AgendaWidgetShortcut(
  val destination: String,
  val vaultId: String?,
  val fileId: String?,
  val entryKind: String?,
  val pinned: Boolean,
)

/** The privacy-independent task projection Rust attached to a task row. Kotlin
 * only renders it; due state and completion capability are never re-derived. */
internal data class AgendaWidgetTask(
  val source: String,
  val due: String,
  val completion: String,
  val revision: Int,
  val vaultId: String?,
  val fileId: String?,
  val cardId: String?,
) {
  /** True only for rows Rust decided may be completed natively after an
   * explicit launcher confirmation. */
  val completableNatively: Boolean
    get() = completion == "available" && source == "calendar"

  val kanbanTarget: CollabAppDestination.VaultTarget?
    get() = if (vaultId != null && fileId != null && cardId != null) {
      CollabAppDestination.VaultTarget(vaultId, fileId, cardId)
    } else {
      null
    }
}
internal data class MonthWidgetDay(
  val dayKey: String,
  val count: Int,
  val colors: List<String>,
  val items: List<MonthWidgetItem>,
  val inMonth: Boolean,
  val isToday: Boolean,
)
/**
 * One bar segment inside a week row, published on the day it starts. Rust owns
 * the span, the lane, and whether the underlying entry runs past this row, so
 * Kotlin only paints what it is told.
 */
internal data class MonthWidgetItem(
  val title: String,
  val color: String?,
  val span: Int = 1,
  val lane: Int = 0,
  val continuesBefore: Boolean = false,
  val continuesAfter: Boolean = false,
)

/** What one column of one lane paints. */
internal data class MonthBarCell(
  val color: String?,
  /** Drawn only where the bar can carry it: its first column, or a lone
   * continuation marker at a clipped trailing edge. */
  val label: String?,
  val alignEnd: Boolean,
  /** Only a bar confined to a single column is rounded; rounding the pieces of
   * a longer bar would pinch it at every column seam. */
  val rounded: Boolean,
)

/**
 * Resolves one lane of one week row into its seven columns, so a multi-day
 * entry paints as a continuous run instead of repeating per day.
 */
internal fun monthBarLane(week: List<MonthWidgetDay>, lane: Int): List<MonthBarCell?> {
  val cells = arrayOfNulls<MonthBarCell>(7)
  week.take(7).forEachIndexed { column, day ->
    day.items.filter { it.lane == lane }.forEach { item ->
      val end = (column + item.span - 1).coerceIn(column, 6)
      // Rust already packs lanes without overlap; a payload that disagrees
      // must not let one bar erase another.
      if ((column..end).any { cells[it] != null }) return@forEach
      for (index in column..end) {
        val isStart = index == column
        val isEnd = index == end
        cells[index] = MonthBarCell(
          color = item.color,
          label = when {
            isStart && item.continuesBefore -> "‹${item.title}"
            isStart -> item.title
            isEnd && item.continuesAfter -> "›"
            else -> null
          },
          alignEnd = !isStart && isEnd,
          rounded = isStart && isEnd && !item.continuesBefore && !item.continuesAfter,
        )
      }
    }
  }
  return cells.toList()
}
internal data class MonthWidgetPage(
  val offset: Int,
  val monthLabel: String,
  val days: List<MonthWidgetDay>,
)
internal data class AgendaWidgetSnapshot(
  val kind: String,
  val generatedAt: String?,
  val dateLabel: String,
  val stateLabel: String,
  val theme: String,
  val accent: String,
  val fontScale: Float,
  val items: List<AgendaWidgetItem>,
  val monthLabel: String?,
  val selectedDayKey: String?,
  val days: List<MonthWidgetDay>,
  val months: List<MonthWidgetPage>,
)

internal fun agendaWidgetSnapshotFromState(raw: String?): AgendaWidgetSnapshot {
  if (raw != null) {
    CollabAgendaWidgetSnapshotCache.read(raw)?.let { return it }
  }
  return AgendaWidgetSnapshot(
    kind = "agenda",
    generatedAt = null,
    dateLabel = LocalDate.now().toString(),
    stateLabel = "Open Collab to refresh",
    theme = "dark",
    accent = "violet",
    fontScale = 1f,
    items = emptyList(),
    monthLabel = null,
    selectedDayKey = null,
    days = emptyList(),
    months = emptyList(),
  )
}

private object CollabAgendaWidgetSnapshotCache {
  private var raw: String? = null
  private var snapshot: AgendaWidgetSnapshot? = null

  @Synchronized
  fun read(value: String): AgendaWidgetSnapshot? {
    if (value == raw) return snapshot
    return runCatching { CollabAgendaWidgetSnapshotStore.parse(value) }
      .getOrNull()
      .also {
        raw = value
        snapshot = it
      }
  }
}

/**
 * The app's theme tokens resolved to sRGB. `card`, `surface`, and `grid` keep
 * the same split the stylesheet uses — `--card` behind content, `--surface`
 * behind controls, `--border` for separators — so a widget and the screen it
 * opens are painted from the same values rather than lookalike ones.
 */
internal data class AgendaWidgetPalette(
  val background: Color,
  val foreground: Color,
  val muted: Color,
  val accent: Color,
  val card: Color,
  val surface: Color,
  val grid: Color,
)

internal fun agendaWidgetPalette(theme: String, accent: String): AgendaWidgetPalette {
  val (background, foreground, muted) = when (theme) {
    "midnight" -> listOf(Color(0xFF010101), Color(0xFFDEDEDE), Color(0xFF6F7278))
    "warm" -> listOf(Color(0xFF090301), Color(0xFFEFE2D8), Color(0xFF8E7C6F))
    "light" -> listOf(Color(0xFFF5F5F5), Color(0xFF090909), Color(0xFF52555B))
    else -> listOf(Color(0xFF0C0F16), Color(0xFFE4E8EF), Color(0xFF808693))
  }
  val (card, surface, grid) = when (theme) {
    "midnight" -> listOf(Color(0xFF030303), Color(0xFF050607), Color(0xFF151515))
    "warm" -> listOf(Color(0xFF0F0703), Color(0xFF140B05), Color(0xFF1F1A18))
    "light" -> listOf(Color(0xFFFFFFFF), Color(0xFFFCFCFC), Color(0xFFDCDCDC))
    else -> listOf(Color(0xFF13161D), Color(0xFF171B22), Color(0xFF272930))
  }
  val accentColor = when (accent) {
    "blue" -> Color(0xFF009BF2)
    "emerald" -> Color(0xFF00C483)
    "rose" -> Color(0xFFFA416B)
    "orange" -> Color(0xFFFA7C20)
    "cyan" -> Color(0xFF00C4CD)
    else -> Color(0xFFA174FF)
  }
  return AgendaWidgetPalette(background, foreground, muted, accentColor, card, surface, grid)
}

internal object CollabAgendaWidgetSnapshotStore {
  private const val MAX_ITEMS = 10
  private const val MAX_TEXT = 80

  fun read(context: Context): AgendaWidgetSnapshot {
    val file = snapshotFile(context)
    if (!file.isFile) writeBootstrap(context)
    return runCatching { parse(file.readText()) }.getOrElse {
      AgendaWidgetSnapshot("agenda", null, "Today", "Open Collab to refresh", "dark", "violet", 1f, emptyList(), null, null, emptyList(), emptyList())
    }
  }

  fun publish(context: Context, raw: String) {
    // Validate and bound the payload before it reaches launcher-readable state.
    parse(raw)
    val file = snapshotFile(context)
    file.parentFile?.mkdirs()
    val temporary = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temporary).bufferedWriter().use { writer ->
      writer.write(raw)
      writer.flush()
    }
    FileOutputStream(temporary, true).use { stream -> stream.fd.sync() }
    Os.rename(temporary.absolutePath, file.absolutePath)
  }

  internal fun parse(raw: String): AgendaWidgetSnapshot {
    require(raw.toByteArray().size <= 262_144) { "Agenda widget snapshot is too large." }
    val json = JSONObject(raw)
    require(json.optInt("schemaVersion") == 1) { "Unsupported agenda widget snapshot." }
    val itemsJson = json.optJSONArray("items") ?: JSONArray()
    val items = buildList {
      for (index in 0 until minOf(itemsJson.length(), MAX_ITEMS)) {
        val item = itemsJson.optJSONObject(index) ?: continue
        add(
          AgendaWidgetItem(
            item.optString("title", "Calendar item").take(MAX_TEXT),
            item.optString("detail", "").take(MAX_TEXT),
            item.optString("section").takeIf { it in setOf("overdue", "today", "upcoming") },
            item.optString("itemKind").takeIf { it in setOf("event", "task", "birthday") },
            item.optString("itemId").takeIf { it.matches(Regex("^[A-Za-z0-9_.:-]{1,128}$")) },
            item.optString("dayKey").takeIf { it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) },
            item.optString("sourceColor").takeIf { it.matches(Regex("^#[0-9A-Fa-f]{6}$")) },
            parseTask(item.optJSONObject("task")),
            parseShortcut(item.optJSONObject("shortcut")),
          ),
        )
      }
    }
    val days = parseMonthDays(json.optJSONArray("days") ?: JSONArray())
    val monthsJson = json.optJSONArray("months") ?: JSONArray()
    val months = buildList {
      val seenOffsets = mutableSetOf<Int>()
      for (index in 0 until minOf(monthsJson.length(), 13)) {
        val month = monthsJson.optJSONObject(index) ?: continue
        val offset = month.optInt("offset", Int.MIN_VALUE)
        val label = month.optString("monthLabel").take(MAX_TEXT)
        val monthDays = parseMonthDays(month.optJSONArray("days") ?: JSONArray())
        if (offset !in MIN_MONTH_OFFSET..MAX_MONTH_OFFSET || !seenOffsets.add(offset) || label.isBlank() || monthDays.size != 42) continue
        add(MonthWidgetPage(offset, label, monthDays))
      }
    }
    return AgendaWidgetSnapshot(
      json.optString("kind", "agenda")
        .takeIf {
          it in setOf("agenda", "month", "birthday", "countdown", "tasks", "capture", "shortcuts")
        } ?: "agenda",
      json.optString("generatedAt").takeIf { it.isNotBlank() },
      json.optString("dateLabel", "Today").take(MAX_TEXT),
      json.optString("stateLabel", "Preview data").take(MAX_TEXT),
      json.optString("theme", "dark").takeIf { it in setOf("dark", "midnight", "warm", "light") } ?: "dark",
      json.optString("accent", "violet").takeIf { it in setOf("violet", "blue", "emerald", "rose", "orange", "cyan") } ?: "violet",
      json.optDouble("fontScale", 1.0).toFloat().takeIf { it in 0.85f..1.3f } ?: 1f,
      items,
      json.optString("monthLabel").takeIf { it.isNotBlank() }?.take(MAX_TEXT),
      json.optString("selectedDayKey").takeIf { it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) },
      days,
      months,
    )
  }

  private fun parseTask(task: JSONObject?): AgendaWidgetTask? {
    if (task == null) return null
    val identifier = Regex("^[A-Za-z0-9_.:-]{1,128}$")
    val source = task.optString("source").takeIf { it in setOf("calendar", "kanban") } ?: return null
    val due = task.optString("due")
      .takeIf { it in setOf("overdue", "today", "upcoming", "unscheduled") } ?: return null
    val completion = task.optString("completion")
      .takeIf { it in setOf("available", "confirmInApp", "unavailable") } ?: return null
    val revision = task.optInt("revision", -1)
    if (revision < 0) return null
    return AgendaWidgetTask(
      // A Kanban row can never be completed from the launcher, whatever the
      // stored payload claims.
      source = source,
      due = due,
      completion = if (source == "kanban" && completion == "available") "confirmInApp" else completion,
      revision = revision,
      vaultId = task.optString("vaultId").takeIf(identifier::matches),
      fileId = task.optString("fileId").takeIf(identifier::matches),
      cardId = task.optString("cardId").takeIf(identifier::matches),
    )
  }

  private fun parseShortcut(shortcut: JSONObject?): AgendaWidgetShortcut? {
    if (shortcut == null) return null
    val identifier = Regex("^[A-Za-z0-9_.:-]{1,128}$")
    val destination = shortcut.optString("destination").takeIf {
      it in setOf(
        "capture-note",
        "capture-task",
        "calendar-create",
        "capture-files",
        "vault-file",
        "vault-folder",
      )
    } ?: return null
    val vaultId = shortcut.optString("vaultId").takeIf(identifier::matches)
    val fileId = shortcut.optString("fileId").takeIf(identifier::matches)
    // A vault destination without a usable target would open nothing, so it is
    // dropped rather than rendered as a dead row.
    if (destination in setOf("vault-file", "vault-folder") && (vaultId == null || fileId == null)) {
      return null
    }
    return AgendaWidgetShortcut(
      destination = destination,
      vaultId = vaultId,
      fileId = fileId,
      entryKind = shortcut.optString("entryKind").takeIf {
        it in setOf("note", "board", "canvas", "sheet", "pdf", "folder", "file")
      },
      pinned = shortcut.optBoolean("pinned"),
    )
  }

  private fun parseMonthDays(daysJson: JSONArray): List<MonthWidgetDay> = buildList {
      for (index in 0 until minOf(daysJson.length(), 42)) {
        val day = daysJson.optJSONObject(index) ?: continue
        val dayKey = day.optString("dayKey")
        if (!dayKey.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))) continue
        val colorsJson = day.optJSONArray("colors") ?: JSONArray()
        val colors = buildList {
          for (colorIndex in 0 until minOf(colorsJson.length(), 3)) {
            colorsJson.optString(colorIndex)
              .takeIf { it.matches(Regex("^#[0-9A-Fa-f]{6}$")) }
              ?.let(::add)
          }
        }
        val itemsJson = day.optJSONArray("items") ?: JSONArray()
        // A day's column decides how far a bar starting on it may reach, so a
        // payload can never claim space past the end of its week row.
        val columnsLeft = 7 - (size % 7)
        val items = buildList {
          for (itemIndex in 0 until minOf(itemsJson.length(), MAX_MONTH_LANES)) {
            val item = itemsJson.optJSONObject(itemIndex) ?: continue
            val title = item.optString("title").take(MAX_TEXT)
            if (title.isBlank()) continue
            add(
              MonthWidgetItem(
                title,
                item.optString("color").takeIf { it.matches(Regex("^#[0-9A-Fa-f]{6}$")) },
                span = item.optInt("span", 1).coerceIn(1, columnsLeft),
                lane = item.optInt("lane", 0).coerceIn(0, MAX_MONTH_LANES - 1),
                continuesBefore = item.optBoolean("continuesBefore"),
                continuesAfter = item.optBoolean("continuesAfter"),
              ),
            )
          }
        }
        add(MonthWidgetDay(dayKey, day.optInt("count").coerceIn(0, 65_535), colors, items, day.optBoolean("inMonth"), day.optBoolean("isToday")))
      }
    }

  private fun snapshotFile(context: Context): File =
    File(context.filesDir, "widgets/agenda-phase0.json")

  private fun writeBootstrap(context: Context) {
    val today = LocalDate.now()
    val value = JSONObject()
      .put("schemaVersion", 1)
      .put("dateLabel", today.toString())
      .put("stateLabel", "Phase 0 preview data")
      .put(
        "items",
        JSONArray()
          .put(JSONObject().put("title", "Design review").put("detail", "09:30 · Event"))
          .put(JSONObject().put("title", "Project follow-up").put("detail", "Today · Task"))
          .put(JSONObject().put("title", "Team planning").put("detail", "Tomorrow · Event")),
      )
    publish(context, value.toString())
  }
}

internal data class WidgetBinding(val profileId: String, val configurationId: String)

internal object CollabWidgetBindings {
  private const val PREFERENCES = "collab-widget-bindings-v1"

  fun read(context: Context, appWidgetId: Int): WidgetBinding? {
    val prefs = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val profileId = prefs.getString("$appWidgetId.profile", null) ?: return null
    val configurationId = prefs.getString("$appWidgetId.configuration", null) ?: return null
    return WidgetBinding(profileId, configurationId)
  }

  fun save(context: Context, appWidgetId: Int, binding: WidgetBinding): Boolean =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString("$appWidgetId.profile", binding.profileId)
      .putString("$appWidgetId.configuration", binding.configurationId)
      .commit()

  fun remove(context: Context, appWidgetId: Int): WidgetBinding? {
    val existing = read(context, appWidgetId)
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .remove("$appWidgetId.profile")
      .remove("$appWidgetId.configuration")
      .apply()
    return existing
  }

  fun active(context: Context): Map<Int, WidgetBinding> {
    val manager = AppWidgetManager.getInstance(context)
    return widgetProviderClasses().flatMap { provider ->
      manager.getAppWidgetIds(ComponentName(context, provider)).asIterable()
    }.mapNotNull { appWidgetId ->
      read(context, appWidgetId)?.let { appWidgetId to it }
    }.toMap()
  }
}

internal fun widgetProviderClasses(): List<Class<out android.content.BroadcastReceiver>> = listOf(
  CollabAgendaWidgetReceiver::class.java,
  CollabMonthWidgetReceiver::class.java,
  CollabBirthdayWidgetReceiver::class.java,
  CollabCountdownWidgetReceiver::class.java,
  CollabTasksWidgetReceiver::class.java,
  CollabCaptureWidgetReceiver::class.java,
  CollabShortcutsWidgetReceiver::class.java,
)

internal fun widgetKindForId(context: Context, appWidgetId: Int): String {
  val provider = AppWidgetManager.getInstance(context).getAppWidgetInfo(appWidgetId)?.provider?.className
  return when (provider) {
    CollabMonthWidgetReceiver::class.java.name -> "month"
    CollabBirthdayWidgetReceiver::class.java.name -> "birthday"
    CollabCountdownWidgetReceiver::class.java.name -> "countdown"
    CollabTasksWidgetReceiver::class.java.name -> "tasks"
    CollabCaptureWidgetReceiver::class.java.name -> "capture"
    CollabShortcutsWidgetReceiver::class.java.name -> "shortcuts"
    else -> "agenda"
  }
}

object CollabWidgetBridge {
  private val publisher = Executors.newSingleThreadExecutor()
  private val publishLock = Any()
  private val requestedProfiles = linkedMapOf<String, String>()
  private var draining = false
  private const val BOOTSTRAP_PROFILE = "__phase0_bootstrap__"
  private const val MAX_DRAIN_RUNTIME_MS = 2_000L

  init {
    System.loadLibrary("collab_lib")
  }

  @JvmStatic external fun nativeBuildAgendaPreview(
    context: Context,
    dateLabel: String,
  ): String

  @JvmStatic external fun nativeActiveProfile(context: Context): String?
  @JvmStatic external fun nativeReadAppearance(context: Context): String
  @JvmStatic external fun nativeListConfigurations(context: Context, profileId: String): String
  @JvmStatic external fun nativeSaveConfiguration(
    context: Context,
    profileId: String,
    configurationJson: String,
  ): String
  @JvmStatic external fun nativeDeleteConfiguration(
    context: Context,
    profileId: String,
    configurationId: String,
  ): Boolean
  @JvmStatic external fun nativeBuildAndPublish(
    context: Context,
    profileId: String,
    requestJson: String,
  ): String
  @JvmStatic external fun nativePublishAgendaProfile(
    context: Context,
    profileId: String,
    updateCause: String,
  ): String
  @JvmStatic external fun nativeReadSnapshot(
    context: Context,
    profileId: String,
    configurationId: String,
  ): String
  @JvmStatic external fun nativePrepareAction(
    context: Context,
    profileId: String,
    requestJson: String,
  ): String
  @JvmStatic external fun nativeCompleteTask(
    context: Context,
    profileId: String,
    requestJson: String,
  ): String

  fun requestPhase0Rebuild(context: Context) {
    val appContext = context.applicationContext
    val profileId = runCatching { nativeActiveProfile(appContext) }.getOrNull()
    enqueue(appContext, profileId ?: BOOTSTRAP_PROFILE, "foreground")
  }

  @JvmStatic fun requestProfileRebuild(context: Context, profileId: String) {
    enqueue(context.applicationContext, profileId, "foreground")
  }

  fun requestProfileRebuild(context: Context, profileId: String, cause: String) {
    enqueue(context.applicationContext, profileId, cause)
  }

  @JvmStatic fun updateWidgets(context: Context) {
    requestAgendaUpdate(context.applicationContext)
  }

  @JvmStatic fun cancelProfile(context: Context, profileId: String) {
    CollabWidgetRefreshScheduler.cancelProfile(context.applicationContext, profileId)
  }

  fun publishConfiguration(
    context: Context,
    profileId: String,
    completed: (String?) -> Unit,
  ) {
    val appContext = context.applicationContext
    publisher.execute {
      val failure = runCatching {
        val outcome = JSONObject(nativePublishAgendaProfile(appContext, profileId, "configuration"))
        check(outcome.optBoolean("configured", false)) {
          "The widget configuration was not found."
        }
        requestAgendaUpdate(appContext)
      }.exceptionOrNull()
      if (failure == null) {
        Handler(Looper.getMainLooper()).post { completed(null) }
        return@execute
      }
      val error = failure.message ?: "The calendar snapshot could not be published."
      Handler(Looper.getMainLooper()).post { completed(error) }
    }
  }

  @JvmStatic fun boundConfigurationIds(context: Context, profileId: String): String {
    val configurationIds = CollabWidgetBindings.active(context).mapNotNull { (_, binding) ->
      binding.takeIf { it.profileId == profileId }?.configurationId
    }.filterNotNull().distinct()
    return JSONArray(configurationIds).toString()
  }

  private fun enqueue(context: Context, profileId: String, cause: String) {
    synchronized(publishLock) {
      requestedProfiles[profileId] = cause
      if (draining) return
      draining = true
    }
    publisher.execute { drain(context) }
  }

  private fun drain(context: Context) {
    val deadline = SystemClock.elapsedRealtime() + MAX_DRAIN_RUNTIME_MS
    while (SystemClock.elapsedRealtime() < deadline) {
      val request = synchronized(publishLock) {
        requestedProfiles.entries.firstOrNull()?.let { entry ->
          requestedProfiles.remove(entry.key)
          entry.key to entry.value
        }
      } ?: break
      val (profileId, cause) = request
      runCatching {
        if (profileId == BOOTSTRAP_PROFILE || !rebuildProfile(context, profileId, cause)) {
          rebuildPhase0(context)
        }
      }
    }
    val continueDraining = synchronized(publishLock) {
      draining = false
      if (requestedProfiles.isNotEmpty()) {
        draining = true
        true
      } else {
        false
      }
    }
    if (continueDraining) publisher.execute { drain(context) }
  }

  fun rebuildProfile(context: Context, profileId: String, cause: String = "foreground"): Boolean {
    val outcome = JSONObject(nativePublishAgendaProfile(context, profileId, cause))
    val configured = outcome.optBoolean("configured", false)
    if (configured) requestAgendaUpdate(context)
    return configured
  }

  internal fun readBoundSnapshotRaw(context: Context, binding: WidgetBinding): String? =
    runCatching {
      val raw = nativeReadSnapshot(context, binding.profileId, binding.configurationId)
      if (raw == "null") return@runCatching null
      CollabAgendaWidgetSnapshotStore.parse(raw)
      raw
    }.getOrNull()

  internal fun prepareOpenIntent(context: Context, binding: WidgetBinding, kind: String = "agenda"): Intent? =
    runCatching {
      val action = when (kind) {
        "month" -> "openMonth"
        "birthday" -> "openBirthdays"
        "countdown" -> "openCountdowns"
        "tasks" -> "openTasks"
        "capture" -> "openCapture"
        "shortcuts" -> "openShortcuts"
        else -> "openAgenda"
      }
      val request = JSONObject()
        .put("configurationId", binding.configurationId)
        .put("action", action)
      val prepared = JSONObject(
        nativePrepareAction(context, binding.profileId, request.toString()),
      )
      CollabAppDestination.intent(context, prepared.getString("destinationKind"))
    }.getOrNull()

  /**
   * Applies a confirmed completion in Rust. Returns the user-facing result;
   * `applied` is false whenever the native queue did not accept the change, so
   * the caller must not optimistically mark the row done.
   */
  internal fun completeTask(
    context: Context,
    binding: WidgetBinding,
    itemId: String,
    revision: Int,
  ): Pair<Boolean, String> {
    val request = JSONObject()
      .put("configurationId", binding.configurationId)
      .put("itemId", itemId)
      .put("expectedRevision", revision)
      .put("confirmed", true)
    return runCatching {
      val outcome = JSONObject(nativeCompleteTask(context, binding.profileId, request.toString()))
      outcome.optBoolean("applied", false) to
        outcome.optString("message", "Task updated.").take(80)
    }.getOrElse { failure ->
      false to (failure.message ?: "The task could not be completed.").take(80)
    }
  }

  fun rebuildPhase0(context: Context) {
    val appContext = context.applicationContext
    val snapshot = nativeBuildAgendaPreview(appContext, LocalDate.now().toString())
    CollabAgendaWidgetSnapshotStore.publish(appContext, snapshot)
    requestAgendaUpdate(appContext)
  }

  internal fun requestAgendaUpdate(
    context: Context,
    origin: AgendaWidgetUpdateOrigin = AgendaWidgetUpdateOrigin.External,
  ) {
    val appContext = context.applicationContext
    val manager = AppWidgetManager.getInstance(appContext)
    val ids = widgetProviderClasses().flatMap { provider ->
      manager.getAppWidgetIds(ComponentName(appContext, provider)).asIterable()
    }.distinct().toIntArray()
    if (ids.isEmpty()) return
    val monthIds = manager
      .getAppWidgetIds(ComponentName(appContext, CollabMonthWidgetReceiver::class.java))
      .toSet()
    runBlocking {
      ids.forEach { appWidgetId ->
        val binding = CollabWidgetBindings.read(appContext, appWidgetId)
        val raw = binding?.let { readBoundSnapshotRaw(appContext, it) }
        updateAppWidgetState(appContext, AppWidgetId(appWidgetId)) { preferences ->
          if (appWidgetId in monthIds || raw == null) {
            preferences.remove(AgendaWidgetSnapshotStateKey)
          } else {
            preferences[AgendaWidgetSnapshotStateKey] = raw
          }
        }
      }
      CollabAgendaWidget().updateAll(appContext)
      CollabMonthWidget().updateAll(appContext)
      CollabBirthdayWidget().updateAll(appContext)
      CollabCountdownWidget().updateAll(appContext)
      CollabTasksWidget().updateAll(appContext)
      CollabCaptureWidget().updateAll(appContext)
      CollabShortcutsWidget().updateAll(appContext)
    }
    if (shouldNotifyAgendaWidgetProvider(origin)) {
      widgetProviderClasses().forEach { provider ->
        val component = ComponentName(appContext, provider)
        val providerIds = manager.getAppWidgetIds(component)
        if (providerIds.isNotEmpty()) {
          appContext.sendBroadcast(
            Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
              .setComponent(component)
              .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, providerIds),
          )
        }
      }
    }
  }
}

class CollabAgendaWidget : GlanceAppWidget() {
  override val stateDefinition = PreferencesGlanceStateDefinition

  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(
      DpSize(110.dp, 56.dp),
      DpSize(250.dp, 110.dp),
      DpSize(250.dp, 220.dp),
      DpSize(250.dp, 400.dp),
    ),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    provideContent {
      val snapshot = agendaWidgetSnapshotFromState(currentState(AgendaWidgetSnapshotStateKey))
      val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
      val openToday = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it, snapshot.kind) }
        ?: CollabAppDestination.intent(context, "calendar-today")
      val createToday = CollabAppDestination.intent(context, "calendar-create", snapshot.dateLabel)
      val itemIntents = snapshot.items.map { item ->
        if (item.itemId != null) {
          CollabAppDestination.intent(context, "calendar-item", item.dayKey, item.itemId)
        } else {
          openToday
        }
      }
      AgendaWidgetContent(snapshot, openToday, createToday, itemIntents)
    }
  }
}

class CollabMonthWidget : GlanceAppWidget() {
  override val stateDefinition = PreferencesGlanceStateDefinition
  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(DpSize(250.dp, 180.dp), DpSize(250.dp, 260.dp), DpSize(320.dp, 360.dp)),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
    val boundSnapshot = binding?.let { CollabWidgetBridge.readBoundSnapshotRaw(context, it) }
    provideContent {
      val snapshot = agendaWidgetSnapshotFromState(
        boundSnapshot ?: currentState(AgendaWidgetSnapshotStateKey),
      )
      val monthOffset = (currentState(MonthOffsetStateKey) ?: 0)
        .coerceIn(MIN_MONTH_OFFSET, MAX_MONTH_OFFSET)
      val page = snapshot.months.firstOrNull { it.offset == monthOffset }
        ?: MonthWidgetPage(0, snapshot.monthLabel ?: "Calendar", snapshot.days)
      val openMonth = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it, "month") }
        ?: CollabAppDestination.intent(context, "calendar-today")
      val dayIntents = page.days.map { day ->
        CollabAppDestination.intent(context, "calendar-date", day.dayKey)
      }
      val monthDate = page.days.firstOrNull { it.inMonth }?.dayKey ?: snapshot.dateLabel
      MonthWidgetContent(
        snapshot,
        page,
        openMonth,
        CollabAppDestination.intent(context, "calendar-create", monthDate),
        dayIntents,
      )
    }
  }
}

internal fun nextMonthOffset(current: Int, delta: Int): Int =
  (current + delta).coerceIn(MIN_MONTH_OFFSET, MAX_MONTH_OFFSET)

private suspend fun changeDisplayedMonth(context: Context, glanceId: GlanceId, delta: Int) {
  updateAppWidgetState(context, glanceId) { preferences ->
    // Month snapshots live in the bounded private file. Keep Glance state tiny
    // so an arrow tap never serializes the full 13-page snapshot.
    preferences.remove(AgendaWidgetSnapshotStateKey)
    preferences[MonthOffsetStateKey] = nextMonthOffset(
      preferences[MonthOffsetStateKey] ?: 0,
      delta,
    )
  }
  CollabMonthWidget().update(context, glanceId)
}

class CollabPreviousMonthAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    changeDisplayedMonth(context, glanceId, -1)
  }
}

class CollabNextMonthAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    changeDisplayedMonth(context, glanceId, 1)
  }
}

abstract class CollabUpcomingDateWidget(private val widgetKind: String) : GlanceAppWidget() {
  override val stateDefinition = PreferencesGlanceStateDefinition
  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(DpSize(110.dp, 56.dp), DpSize(250.dp, 110.dp), DpSize(250.dp, 220.dp)),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    provideContent {
      val snapshot = agendaWidgetSnapshotFromState(currentState(AgendaWidgetSnapshotStateKey))
      val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
      val open = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it, widgetKind) }
        ?: CollabAppDestination.intent(context, "calendar-today")
      val itemIntents = snapshot.items.map { item ->
        if (item.itemId != null) {
          CollabAppDestination.intent(context, "calendar-item", item.dayKey, item.itemId)
        } else open
      }
      AgendaWidgetContent(
        snapshot,
        open,
        CollabAppDestination.intent(context, "calendar-create", snapshot.dateLabel),
        itemIntents,
        title = if (widgetKind == "birthday") "Birthdays" else "Countdowns",
        showCreate = false,
      )
    }
  }
}

class CollabBirthdayWidget : CollabUpcomingDateWidget("birthday")
class CollabCountdownWidget : CollabUpcomingDateWidget("countdown")

class CollabTasksWidget : GlanceAppWidget() {
  override val stateDefinition = PreferencesGlanceStateDefinition
  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(
      DpSize(110.dp, 56.dp),
      DpSize(250.dp, 110.dp),
      DpSize(250.dp, 220.dp),
      DpSize(250.dp, 400.dp),
    ),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    provideContent {
      val snapshot = agendaWidgetSnapshotFromState(currentState(AgendaWidgetSnapshotStateKey))
      val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
      val openTasks = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it, "tasks") }
        ?: CollabAppDestination.intent(context, "calendar-today")
      val itemIntents = snapshot.items.map { item -> taskDestination(context, item, openTasks) }
      TasksWidgetContent(
        snapshot = snapshot,
        openTasks = openTasks,
        itemIntents = itemIntents,
        pendingCompleteId = currentState(TaskPendingCompleteStateKey),
        actionMessage = currentState(TaskActionMessageStateKey),
      )
    }
  }
}

/**
 * Quick capture and vault shortcuts. Both are pure deep-link surfaces: they
 * render bounded native rows and start an existing mobile flow. Neither writes
 * draft content, requests a permission, or performs any launcher-process work
 * beyond composing the rows.
 */
abstract class CollabShortcutWidget(private val widgetKind: String) : GlanceAppWidget() {
  override val stateDefinition = PreferencesGlanceStateDefinition
  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(
      DpSize(110.dp, 56.dp),
      DpSize(250.dp, 110.dp),
      DpSize(250.dp, 220.dp),
      DpSize(250.dp, 400.dp),
    ),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    provideContent {
      val snapshot = agendaWidgetSnapshotFromState(currentState(AgendaWidgetSnapshotStateKey))
      val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
      val open = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it, widgetKind) }
        ?: CollabAppDestination.intent(context, "calendar-today")
      val intents = snapshot.items.map { item -> shortcutDestination(context, item, open) }
      ShortcutWidgetContent(
        snapshot = snapshot,
        title = if (widgetKind == "capture") "Quick capture" else "Shortcuts",
        openHeader = open,
        itemIntents = intents,
        showIcons = widgetKind == "shortcuts",
      )
    }
  }
}

class CollabCaptureWidget : CollabShortcutWidget("capture")
class CollabShortcutsWidget : CollabShortcutWidget("shortcuts")

/**
 * Resolves a capture tile or shortcut row to its validated destination. A row
 * whose target no longer resolves falls back to the widget's header
 * destination, which is a safe recovery surface rather than a dead tap.
 */
internal fun shortcutDestination(
  context: Context,
  item: AgendaWidgetItem,
  fallback: Intent,
): Intent = runCatching {
  val shortcut = item.shortcut ?: return@runCatching fallback
  val vaultId = shortcut.vaultId
  val fileId = shortcut.fileId
  if (shortcut.destination == "vault-file" || shortcut.destination == "vault-folder") {
    if (vaultId == null || fileId == null) return@runCatching fallback
    return@runCatching CollabAppDestination.intent(
      context,
      shortcut.destination,
      vault = CollabAppDestination.VaultTarget(vaultId, fileId),
    )
  }
  CollabAppDestination.intent(context, shortcut.destination)
}.getOrDefault(fallback)

/** The glyph shown for a shortcut row's entry kind. */
internal fun shortcutEntryGlyph(entryKind: String?): String = when (entryKind) {
  "note" -> "📄"
  "board" -> "🗂"
  "canvas" -> "🎨"
  "sheet" -> "▦"
  "pdf" -> "📕"
  "folder" -> "📁"
  else -> "•"
}

/** Matches `--radius` in the app's stylesheet, so widget cards and in-app
 * cards share one corner language. */
private val WidgetCardRadius = 14.dp
/** Matches `.mobile-calendar-task-color`: the source colour is carried by a
 * slim rail down the card rather than by a bullet glyph. */
private val WidgetRailWidth = 3.dp

/**
 * Rounds the widget shell with the launcher's own widget background radius so a
 * Collab widget sits in the grid like a system one. Below API 31 the platform
 * has no widget corner treatment to match and the modifier is skipped.
 */
private fun GlanceModifier.appWidgetBackgroundRadius(): GlanceModifier =
  if (android.os.Build.VERSION.SDK_INT >= 31) {
    cornerRadius(android.R.dimen.system_app_widget_background_radius)
  } else {
    this
  }

/** The raised card surface shared by every widget list row. */
private fun GlanceModifier.widgetCard(palette: AgendaWidgetPalette): GlanceModifier =
  this.fillMaxWidth()
    .background(ColorProvider(palette.card))
    .cornerRadius(WidgetCardRadius)

/**
 * Draws the app's 1px card border. Glance has no border modifier, so the
 * hairline is a border-coloured layer the card sits 1dp inside of. The app
 * pairs a subtle card fill with this outline, and without it the fill alone is
 * too quiet to read as a card.
 */
@Composable
private fun WidgetCardFrame(
  palette: AgendaWidgetPalette,
  content: @Composable () -> Unit,
) {
  Box(
    modifier = GlanceModifier
      .fillMaxWidth()
      .background(ColorProvider(palette.grid))
      .cornerRadius(WidgetCardRadius)
      .padding(1.dp),
    contentAlignment = Alignment.Center,
  ) {
    content()
  }
}

/**
 * The shell every Collab widget paints: one rounded surface on the theme
 * background. Keeping it shared is what makes the family read as a single
 * product on the launcher, and keeps the rendered widget honest about the
 * preview shown in the picker.
 */
@Composable
private fun WidgetSurface(
  palette: AgendaWidgetPalette,
  modifier: GlanceModifier = GlanceModifier,
  padding: Dp = 12.dp,
  content: @Composable ColumnScope.() -> Unit,
) {
  Column(
    modifier = modifier
      .fillMaxSize()
      .background(ColorProvider(palette.background))
      .appWidgetBackgroundRadius()
      .padding(padding),
    content = content,
  )
}

/**
 * Title plus at most one filled accent control. The accent stays a signal for
 * the widget's single primary action instead of decorating the surface.
 */
@Composable
private fun WidgetHeader(
  palette: AgendaWidgetPalette,
  fontScale: Float,
  title: String,
  titleAction: Action,
  accentAction: Action? = null,
  accentGlyph: String = "＋",
) {
  Row(
    modifier = GlanceModifier.fillMaxWidth(),
    verticalAlignment = Alignment.Vertical.CenterVertically,
  ) {
    Text(
      text = title,
      modifier = GlanceModifier.defaultWeight().clickable(titleAction),
      style = TextStyle(
        color = ColorProvider(palette.foreground),
        fontWeight = FontWeight.Bold,
        fontSize = (15f * fontScale).sp,
      ),
    )
    if (accentAction != null) {
      WidgetAccentButton(palette, fontScale, accentGlyph, accentAction)
    }
  }
}

@Composable
private fun WidgetAccentButton(
  palette: AgendaWidgetPalette,
  fontScale: Float,
  glyph: String,
  action: Action,
) {
  Box(
    modifier = GlanceModifier
      .width(40.dp)
      .height(34.dp)
      .background(ColorProvider(palette.accent))
      .cornerRadius(12.dp)
      .clickable(action),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      glyph,
      style = TextStyle(
        color = ColorProvider(palette.background),
        fontWeight = FontWeight.Bold,
        fontSize = (19f * fontScale).sp,
      ),
    )
  }
}

/** A secondary control: grouped and tappable, but never competing with the
 * one accent action for attention. */
@Composable
private fun WidgetQuietButton(
  palette: AgendaWidgetPalette,
  fontScale: Float,
  glyph: String,
  action: Action,
) {
  Box(
    modifier = GlanceModifier
      .width(34.dp)
      .height(34.dp)
      .background(ColorProvider(palette.surface))
      .cornerRadius(12.dp)
      .clickable(action),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      glyph,
      style = TextStyle(
        color = ColorProvider(palette.foreground),
        fontSize = (18f * fontScale).sp,
      ),
    )
  }
}

@Composable
private fun WidgetSectionLabel(
  palette: AgendaWidgetPalette,
  fontScale: Float,
  text: String,
  action: Action,
) {
  Text(
    text,
    modifier = GlanceModifier.padding(start = 2.dp).clickable(action),
    style = TextStyle(
      color = ColorProvider(palette.muted),
      fontWeight = FontWeight.Medium,
      fontSize = (10f * fontScale).sp,
    ),
  )
  Spacer(GlanceModifier.height(4.dp))
}

/**
 * A list row in the app's card language: a raised surface whose source colour
 * is carried by a left rail, mirroring the agenda cards in the mobile app.
 */
@Composable
private fun WidgetRowCard(
  palette: AgendaWidgetPalette,
  railColor: Color,
  action: Action,
  compact: Boolean,
  content: @Composable ColumnScope.() -> Unit,
) {
  WidgetCardFrame(palette) {
    Row(
      modifier = GlanceModifier
        .widgetCard(palette)
        .clickable(action)
        .padding(horizontal = 9.dp, vertical = if (compact) 6.dp else 8.dp),
      verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
      Box(
        modifier = GlanceModifier
          .width(WidgetRailWidth)
          .fillMaxHeight()
          .background(ColorProvider(railColor))
          .cornerRadius(WidgetRailWidth),
        contentAlignment = Alignment.Center,
      ) {}
      Spacer(GlanceModifier.width(9.dp))
      Column(modifier = GlanceModifier.defaultWeight(), content = content)
    }
  }
}

@Composable
private fun ShortcutWidgetContent(
  snapshot: AgendaWidgetSnapshot,
  title: String,
  openHeader: Intent,
  itemIntents: List<Intent>,
  showIcons: Boolean,
) {
  val size = LocalSize.current
  val palette = agendaWidgetPalette(snapshot.theme, snapshot.accent)
  val openAction = actionStartActivity(openHeader)
  val itemLimit = when {
    size.height < 90.dp -> 2
    size.height < 180.dp -> 4
    size.height < 260.dp -> 6
    else -> 10
  }
  val visibleItems = snapshot.items.take(itemLimit)
  val compact = size.height < 90.dp
  WidgetSurface(palette, padding = if (compact) 10.dp else 12.dp) {
    if (!compact) {
      WidgetHeader(palette, snapshot.fontScale, title, openAction)
      Spacer(GlanceModifier.height(9.dp))
    }
    if (visibleItems.isEmpty()) {
      Text(
        snapshot.stateLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = mutedTextStyle(palette, 11f * snapshot.fontScale),
      )
    } else {
      visibleItems.forEachIndexed { visibleIndex, item ->
        val originalIndex = snapshot.items.indexOf(item)
        val action = actionStartActivity(itemIntents.getOrElse(originalIndex) { openHeader })
        WidgetCardFrame(palette) {
          Row(
            modifier = GlanceModifier
              .widgetCard(palette)
              .clickable(action)
              .padding(horizontal = 9.dp, vertical = if (compact) 6.dp else 8.dp),
            verticalAlignment = Alignment.Vertical.CenterVertically,
          ) {
            Text(
              if (showIcons) shortcutEntryGlyph(item.shortcut?.entryKind) else "＋",
              modifier = GlanceModifier.clickable(action),
              style = TextStyle(
                color = ColorProvider(palette.accent),
                fontSize = (13f * snapshot.fontScale).sp,
              ),
            )
            Spacer(GlanceModifier.width(9.dp))
            Column(modifier = GlanceModifier.defaultWeight()) {
              Text(
                item.title,
                modifier = GlanceModifier.clickable(action),
                style = TextStyle(
                  color = ColorProvider(palette.foreground),
                  fontWeight = FontWeight.Medium,
                  fontSize = (13f * snapshot.fontScale).sp,
                ),
              )
              if (size.height >= 180.dp && item.detail.isNotBlank()) {
                Text(
                  item.detail,
                  modifier = GlanceModifier.clickable(action),
                  style = mutedTextStyle(palette, 11f * snapshot.fontScale),
                )
              }
            }
            if (item.shortcut?.pinned == true && size.height >= 180.dp) {
              Text(
                "★",
                modifier = GlanceModifier.clickable(action),
                style = mutedTextStyle(palette, 11f * snapshot.fontScale),
              )
            }
        }
        }
        if (visibleIndex < visibleItems.lastIndex) Spacer(GlanceModifier.height(6.dp))
      }
    }
  }
}

/**
 * A task row opens the surface it actually lives on: its Kanban card when the
 * snapshot carries a complete opaque board reference, otherwise its calendar
 * item. Rows without any validated destination fall back to the task list.
 */
internal fun taskDestination(
  context: Context,
  item: AgendaWidgetItem,
  fallback: Intent,
): Intent = runCatching {
  val kanban = item.task?.takeIf { it.source == "kanban" }?.kanbanTarget
  when {
    kanban != null -> CollabAppDestination.intent(context, "kanban-card", vault = kanban)
    item.itemId != null ->
      CollabAppDestination.intent(context, "calendar-item", item.dayKey, item.itemId)
    else -> fallback
  }
}.getOrDefault(fallback)

private suspend fun updateTaskState(
  context: Context,
  glanceId: GlanceId,
  pendingItemId: String?,
  message: String?,
) {
  updateAppWidgetState(context, glanceId) { preferences ->
    if (pendingItemId == null) {
      preferences.remove(TaskPendingCompleteStateKey)
    } else {
      preferences[TaskPendingCompleteStateKey] = pendingItemId
    }
    if (message == null) {
      preferences.remove(TaskActionMessageStateKey)
    } else {
      preferences[TaskActionMessageStateKey] = message
    }
  }
  CollabTasksWidget().update(context, glanceId)
}

/** The first tap only arms the row. Nothing is written until the user confirms. */
class CollabTaskRequestCompleteAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    val itemId = parameters[TaskItemIdParameter] ?: return
    updateTaskState(context, glanceId, itemId, null)
  }
}

class CollabTaskCancelCompleteAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    updateTaskState(context, glanceId, null, null)
  }
}

/**
 * The confirming tap. Rust re-validates authorization, read-only state, the
 * item revision, and source availability before queueing anything, and the
 * widget is only refreshed from the republished snapshot afterwards.
 */
class CollabTaskConfirmCompleteAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    val appContext = context.applicationContext
    val appWidgetId = (glanceId as? AppWidgetId)?.appWidgetId
    val binding = appWidgetId?.let { CollabWidgetBindings.read(appContext, it) }
    val itemId = parameters[TaskItemIdParameter]
    if (binding == null || itemId == null) {
      updateTaskState(context, glanceId, null, "This widget is no longer set up.")
      return
    }
    val snapshot = CollabWidgetBridge.readBoundSnapshotRaw(appContext, binding)
      ?.let { runCatching { CollabAgendaWidgetSnapshotStore.parse(it) }.getOrNull() }
    // The durable snapshot, not the rendered state, decides which revision the
    // confirmation targets.
    val task = snapshot?.items?.firstOrNull { it.itemId == itemId }?.task
    if (task == null || !task.completableNatively) {
      updateTaskState(context, glanceId, null, "Open Collab to complete this task.")
      return
    }
    val (applied, message) =
      CollabWidgetBridge.completeTask(appContext, binding, itemId, task.revision)
    updateTaskState(context, glanceId, null, message)
    if (applied) CollabWidgetBridge.requestAgendaUpdate(appContext)
  }
}

@Composable
private fun AgendaWidgetContent(
  snapshot: AgendaWidgetSnapshot,
  openToday: android.content.Intent,
  createToday: android.content.Intent,
  itemIntents: List<android.content.Intent>,
  title: String? = null,
  showCreate: Boolean = true,
) {
  val size = LocalSize.current
  val openAction = actionStartActivity(openToday)
  val createAction = actionStartActivity(createToday)
  val palette = agendaWidgetPalette(snapshot.theme, snapshot.accent)
  val itemLimit = when {
    size.height < 90.dp -> 1
    size.height < 180.dp -> 3
    size.height < 260.dp -> 5
    else -> 10
  }
  val preferredItems = if (size.height < 180.dp) {
    snapshot.items.filter { it.section != "upcoming" }.ifEmpty { snapshot.items }
  } else {
    snapshot.items
  }
  val visibleItems = preferredItems.take(itemLimit)
  val dateLabel = runCatching {
    LocalDate.parse(snapshot.dateLabel).format(DateTimeFormatter.ofPattern("EEE, MMM d"))
  }.getOrDefault(snapshot.dateLabel)
  val freshnessLabel = when {
    snapshot.stateLabel.contains("unavailable", ignoreCase = true) -> "offline"
    snapshot.stateLabel.contains("stale", ignoreCase = true) -> "stale"
    snapshot.stateLabel == "Up to date" -> "current"
    else -> null
  }
  val headerLabel = title ?: if (size.height < 180.dp && freshnessLabel != null) {
    "$dateLabel · $freshnessLabel"
  } else {
    dateLabel
  }
  val compact = size.height < 90.dp
  WidgetSurface(
    palette = palette,
    modifier = GlanceModifier.clickable(openAction),
    padding = if (compact) 10.dp else 12.dp,
  ) {
    WidgetHeader(
      palette = palette,
      fontScale = snapshot.fontScale,
      title = headerLabel,
      titleAction = openAction,
      accentAction = if (showCreate) createAction else null,
    )
    Spacer(GlanceModifier.height(if (compact) 6.dp else 9.dp))
    if (snapshot.items.isEmpty()) {
      Text(
        snapshot.stateLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = mutedTextStyle(palette, 11f * snapshot.fontScale),
      )
    } else {
      visibleItems.forEachIndexed { visibleIndex, item ->
        val originalIndex = snapshot.items.indexOf(item)
        val itemAction = actionStartActivity(itemIntents.getOrElse(originalIndex) { openToday })
        if (size.height >= 180.dp) {
          val priorSection = visibleItems.getOrNull(visibleIndex - 1)?.section
          if (item.section != null && item.section != priorSection) {
            WidgetSectionLabel(
              palette,
              snapshot.fontScale,
              item.section.replaceFirstChar { it.uppercase() },
              openAction,
            )
          }
        }
        WidgetRowCard(
          palette = palette,
          railColor = widgetSourceColor(item.sourceColor, palette.accent),
          action = itemAction,
          compact = compact,
        ) {
          Text(
            item.title,
            modifier = GlanceModifier.clickable(itemAction),
            style = TextStyle(
              color = ColorProvider(palette.foreground),
              fontWeight = FontWeight.Medium,
              fontSize = (13f * snapshot.fontScale).sp,
            ),
          )
          if (!compact) {
            Text(
              agendaItemDetail(item),
              modifier = GlanceModifier.clickable(itemAction),
              style = mutedTextStyle(palette, 11f * snapshot.fontScale),
            )
          }
        }
        if (visibleIndex < visibleItems.lastIndex) Spacer(GlanceModifier.height(6.dp))
      }
      if (size.height >= 180.dp) {
        Spacer(GlanceModifier.height(8.dp))
        Text(
          snapshot.stateLabel,
          modifier = GlanceModifier.clickable(openAction),
          style = mutedTextStyle(palette, 10f * snapshot.fontScale),
        )
      }
    }
  }
}

internal fun taskSectionLabel(due: String?): String = when (due) {
  "overdue" -> "Overdue"
  "today" -> "Today"
  "upcoming" -> "Upcoming"
  "unscheduled" -> "No due date"
  else -> "Tasks"
}

@Composable
private fun TasksWidgetContent(
  snapshot: AgendaWidgetSnapshot,
  openTasks: Intent,
  itemIntents: List<Intent>,
  pendingCompleteId: String?,
  actionMessage: String?,
) {
  val size = LocalSize.current
  val palette = agendaWidgetPalette(snapshot.theme, snapshot.accent)
  val openAction = actionStartActivity(openTasks)
  val itemLimit = when {
    size.height < 90.dp -> 1
    size.height < 180.dp -> 3
    size.height < 260.dp -> 5
    else -> 10
  }
  val visibleItems = snapshot.items.take(itemLimit)
  val compact = size.height < 90.dp
  WidgetSurface(
    palette = palette,
    modifier = GlanceModifier.clickable(openAction),
    padding = if (compact) 10.dp else 12.dp,
  ) {
    WidgetHeader(palette, snapshot.fontScale, "Tasks", openAction)
    Spacer(GlanceModifier.height(if (compact) 6.dp else 9.dp))
    if (actionMessage != null) {
      Text(
        actionMessage,
        modifier = GlanceModifier.clickable(openAction),
        style = mutedTextStyle(palette, 11f * snapshot.fontScale),
      )
      Spacer(GlanceModifier.height(4.dp))
    }
    if (visibleItems.isEmpty()) {
      Text(
        snapshot.stateLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = mutedTextStyle(palette, 11f * snapshot.fontScale),
      )
    } else {
      visibleItems.forEachIndexed { visibleIndex, item ->
        val originalIndex = snapshot.items.indexOf(item)
        val itemAction = actionStartActivity(itemIntents.getOrElse(originalIndex) { openTasks })
        val awaitingConfirmation = item.itemId != null && item.itemId == pendingCompleteId
        if (size.height >= 180.dp) {
          val priorDue = visibleItems.getOrNull(visibleIndex - 1)?.task?.due
          if (item.task != null && item.task.due != priorDue) {
            WidgetSectionLabel(
              palette,
              snapshot.fontScale,
              taskSectionLabel(item.task.due),
              openAction,
            )
          }
        }
        WidgetCardFrame(palette) {
          Row(
            modifier = GlanceModifier
              .fillMaxWidth()
              // An armed row steps up one surface level so the pending
              // confirmation is unmistakable without borrowing the accent, which
              // already marks the confirming control itself.
              .background(ColorProvider(if (awaitingConfirmation) palette.surface else palette.card))
              .cornerRadius(WidgetCardRadius)
              .padding(horizontal = 6.dp, vertical = if (compact) 2.dp else 4.dp),
            verticalAlignment = Alignment.Vertical.CenterVertically,
          ) {
            TaskCompleteControl(snapshot, palette, item, awaitingConfirmation)
            Spacer(GlanceModifier.width(7.dp))
            Column(modifier = GlanceModifier.defaultWeight().clickable(itemAction)) {
              Text(
                item.title,
                modifier = GlanceModifier.clickable(itemAction),
                style = TextStyle(
                  color = ColorProvider(palette.foreground),
                  fontWeight = FontWeight.Medium,
                  fontSize = (13f * snapshot.fontScale).sp,
                ),
              )
              if (!compact) {
                Text(
                  if (awaitingConfirmation) "Tap ✓ to confirm" else item.detail,
                  modifier = GlanceModifier.clickable(itemAction),
                  style = mutedTextStyle(palette, 11f * snapshot.fontScale),
                )
              }
            }
            if (awaitingConfirmation) {
              Spacer(GlanceModifier.width(4.dp))
              Box(
                modifier = GlanceModifier.width(34.dp).height(34.dp)
                  .clickable(actionRunCallback<CollabTaskCancelCompleteAction>()),
                contentAlignment = Alignment.Center,
              ) {
                Text(
                  "✕",
                  style = mutedTextStyle(palette, 15f * snapshot.fontScale),
                )
              }
            }
        }
        }
        if (visibleIndex < visibleItems.lastIndex) Spacer(GlanceModifier.height(6.dp))
      }
      if (size.height >= 180.dp) {
        Spacer(GlanceModifier.height(8.dp))
        Text(
          snapshot.stateLabel,
          modifier = GlanceModifier.clickable(openAction),
          style = mutedTextStyle(palette, 10f * snapshot.fontScale),
        )
      }
    }
  }
}

/**
 * The completion affordance. Only rows Rust marked natively completable get an
 * arming tap; everything else stays inert so a launcher tap can never mutate
 * shared data on its own.
 */
@Composable
private fun TaskCompleteControl(
  snapshot: AgendaWidgetSnapshot,
  palette: AgendaWidgetPalette,
  item: AgendaWidgetItem,
  awaitingConfirmation: Boolean,
) {
  val itemId = item.itemId
  val completable = item.task?.completableNatively == true && itemId != null
  val modifier = GlanceModifier.width(34.dp).height(34.dp).cornerRadius(17.dp)
  Box(
    modifier = when {
      !completable -> modifier
      awaitingConfirmation -> modifier
        .background(ColorProvider(palette.accent))
        .clickable(
          actionRunCallback<CollabTaskConfirmCompleteAction>(
            actionParametersOf(TaskItemIdParameter to itemId!!),
          ),
        )
      else -> modifier.clickable(
        actionRunCallback<CollabTaskRequestCompleteAction>(
          actionParametersOf(TaskItemIdParameter to itemId!!),
        ),
      )
    },
    contentAlignment = Alignment.Center,
  ) {
    Text(
      if (awaitingConfirmation) "✓" else if (completable) "○" else "•",
      style = TextStyle(
        color = ColorProvider(
          when {
            awaitingConfirmation -> palette.background
            completable -> widgetSourceColor(item.sourceColor, palette.accent)
            else -> palette.muted
          },
        ),
        fontWeight = if (awaitingConfirmation) FontWeight.Bold else FontWeight.Normal,
        fontSize = ((if (awaitingConfirmation) 15f else 14f) * snapshot.fontScale).sp,
      ),
    )
  }
}

@Composable
private fun MonthWidgetContent(
  snapshot: AgendaWidgetSnapshot,
  page: MonthWidgetPage,
  openMonth: android.content.Intent,
  createToday: android.content.Intent,
  dayIntents: List<android.content.Intent>,
) {
  val palette = agendaWidgetPalette(snapshot.theme, snapshot.accent)
  val openAction = actionStartActivity(openMonth)
  val previousAction = actionRunCallback<CollabPreviousMonthAction>()
  val nextAction = actionRunCallback<CollabNextMonthAction>()
  val createAction = actionStartActivity(createToday)
  val size = LocalSize.current
  WidgetSurface(palette) {
    Row(
      modifier = GlanceModifier.fillMaxWidth(),
      verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
      Text(
        page.monthLabel,
        modifier = GlanceModifier.defaultWeight().clickable(openAction),
        style = TextStyle(
          color = ColorProvider(palette.foreground),
          fontWeight = FontWeight.Bold,
          fontSize = (15f * snapshot.fontScale).sp,
        ),
      )
      WidgetQuietButton(palette, snapshot.fontScale, "‹", previousAction)
      Spacer(GlanceModifier.width(4.dp))
      WidgetQuietButton(palette, snapshot.fontScale, "›", nextAction)
      Spacer(GlanceModifier.width(6.dp))
      WidgetAccentButton(palette, snapshot.fontScale, "＋", createAction)
    }
    Spacer(GlanceModifier.height(7.dp))
    Row(modifier = GlanceModifier.fillMaxWidth()) {
      listOf("M", "T", "W", "T", "F", "S", "S").forEach { label ->
        Text(label, modifier = GlanceModifier.defaultWeight(), style = mutedTextStyle(palette, 10f * snapshot.fontScale))
      }
    }
    Spacer(GlanceModifier.height(4.dp))
    val laneCount = when {
      size.height >= 420.dp -> MAX_MONTH_LANES
      size.height >= 300.dp -> 2
      else -> 0
    }
    page.days.chunked(7).take(6).forEach { week ->
      // The day cells and the bar lanes are separate layers: a bar has to run
      // across column boundaries, which it could never do from inside a cell.
      Box(modifier = GlanceModifier.fillMaxWidth().defaultWeight()) {
        Row(
          modifier = GlanceModifier.fillMaxSize().background(ColorProvider(palette.grid)),
        ) {
          week.forEach { day ->
            val index = page.days.indexOf(day)
            val action = actionStartActivity(dayIntents.getOrElse(index) { openMonth })
            val number = runCatching { LocalDate.parse(day.dayKey).dayOfMonth.toString() }.getOrDefault("·")
            val marker = when {
              day.count == 0 -> ""
              size.height < 240.dp -> "•"
              day.count > 9 -> "9+"
              else -> day.count.toString()
            }
            Column(
              modifier = GlanceModifier.defaultWeight().padding(1.dp),
            ) {
              // Square cells on the theme background, separated by the row's
              // border colour showing through the 1dp gutter — the same grid
              // the app's month view draws.
              Column(
                modifier = GlanceModifier.fillMaxSize()
                  .background(
                    ColorProvider(if (day.inMonth) palette.background else palette.card),
                  )
                  .clickable(action)
                  .padding(horizontal = 3.dp, vertical = 3.dp),
                horizontalAlignment = Alignment.Horizontal.End,
              ) {
                val numberSize = (18f * snapshot.fontScale).dp
                Box(
                  modifier = if (day.isToday) {
                    GlanceModifier.width(numberSize).height(numberSize)
                      .background(ColorProvider(palette.accent))
                      .cornerRadius(numberSize / 2)
                      .clickable(action)
                  } else {
                    GlanceModifier.width(numberSize).height(numberSize).clickable(action)
                  },
                  contentAlignment = Alignment.Center,
                ) {
                  Text(
                    number,
                    style = TextStyle(
                      color = ColorProvider(
                        if (day.isToday) palette.background
                        else if (day.inMonth) palette.foreground else palette.muted,
                      ),
                      fontWeight = if (day.isToday) FontWeight.Bold else FontWeight.Normal,
                      fontSize = (11f * snapshot.fontScale).sp,
                    ),
                  )
                }
                // Without room for bars the day still reports its density.
                if (laneCount == 0 && marker.isNotEmpty()) {
                  Text(
                    marker,
                    modifier = GlanceModifier.clickable(action),
                    style = TextStyle(
                      color = ColorProvider(widgetSourceColor(day.colors.firstOrNull(), palette.accent)),
                      fontSize = (8f * snapshot.fontScale).sp,
                    ),
                  )
                }
              }
            }
          }
        }
        if (laneCount > 0) {
          MonthBarLanes(snapshot, palette, week, laneCount, openMonth, dayIntents, page)
        }
      }
    }
  }
}

/**
 * Paints the bar lanes over a week row. Each lane is seven equal columns so it
 * stays aligned with the day cells beneath, and a bar simply fills every column
 * it covers — adjacent pieces meet with no gap, so the run reads as one bar.
 */
@Composable
private fun MonthBarLanes(
  snapshot: AgendaWidgetSnapshot,
  palette: AgendaWidgetPalette,
  week: List<MonthWidgetDay>,
  laneCount: Int,
  openMonth: Intent,
  dayIntents: List<Intent>,
  page: MonthWidgetPage,
) {
  val barHeight = (11f * snapshot.fontScale).dp
  Column(modifier = GlanceModifier.fillMaxWidth()) {
    // Clears the day number the cells draw above the lanes.
    Spacer(GlanceModifier.height((20f * snapshot.fontScale).dp))
    repeat(laneCount) { lane ->
      Row(modifier = GlanceModifier.fillMaxWidth()) {
        monthBarLane(week, lane).forEachIndexed { column, cell ->
          if (cell == null) {
            Spacer(GlanceModifier.defaultWeight().height(barHeight))
            return@forEachIndexed
          }
          val day = week.getOrNull(column)
          val action = actionStartActivity(
            dayIntents.getOrElse(page.days.indexOf(day)) { openMonth },
          )
          Box(
            modifier = GlanceModifier
              .defaultWeight()
              .height(barHeight)
              .background(ColorProvider(widgetSourceColor(cell.color, palette.accent)))
              .let { if (cell.rounded) it.cornerRadius(4.dp) else it }
              .clickable(action),
            contentAlignment = if (cell.alignEnd) Alignment.CenterEnd else Alignment.CenterStart,
          ) {
            if (cell.label != null) {
              Text(
                cell.label,
                modifier = GlanceModifier.padding(horizontal = 2.dp),
                style = TextStyle(
                  color = ColorProvider(palette.background),
                  fontWeight = FontWeight.Medium,
                  fontSize = (8f * snapshot.fontScale).sp,
                ),
              )
            }
          }
        }
      }
      Spacer(GlanceModifier.height(1.dp))
    }
  }
}

internal fun agendaItemDetail(item: AgendaWidgetItem): String {
  if (item.section != "upcoming" || item.itemKind != "task" || item.dayKey == null) return item.detail
  val date = runCatching {
    LocalDate.parse(item.dayKey).format(DateTimeFormatter.ofPattern("EEE, MMM d"))
  }.getOrDefault(item.dayKey)
  return if (item.detail.isBlank()) date else "$date · ${item.detail}"
}

private fun mutedTextStyle(palette: AgendaWidgetPalette, fontSize: Float) =
  TextStyle(
    color = ColorProvider(palette.muted),
    fontSize = fontSize.sp,
  )

private fun widgetSourceColor(value: String?, fallback: Color): Color {
  val rgb = value?.removePrefix("#")?.toLongOrNull(16) ?: return fallback
  return Color(0xFF000000L or rgb)
}

abstract class CollabCalendarWidgetReceiver : GlanceAppWidgetReceiver() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    // GlanceAppWidgetReceiver owns the broadcast PendingResult internally.
    // Calling goAsync() again after super can return null and crash the process
    // when an executor later attempts to finish that second result.
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    CollabWidgetUpdateCoordinator.onUpdate(context, appWidgetIds)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    appWidgetIds.forEach { appWidgetId ->
      val binding = CollabWidgetBindings.remove(context, appWidgetId) ?: return@forEach
      runCatching {
        CollabWidgetBridge.nativeDeleteConfiguration(
          context.applicationContext,
          binding.profileId,
          binding.configurationId,
        )
      }
    }
    runCatching { CollabWidgetRefreshScheduler.reconcile(context) }
    super.onDeleted(context, appWidgetIds)
  }
}

class CollabAgendaWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabAgendaWidget()
}

class CollabMonthWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabMonthWidget()
}

class CollabBirthdayWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabBirthdayWidget()
}

class CollabCountdownWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabCountdownWidget()
}

class CollabTasksWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabTasksWidget()
}

class CollabCaptureWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabCaptureWidget()
}

class CollabShortcutsWidgetReceiver : CollabCalendarWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabShortcutsWidget()
}

class CollabWidgetLifecycleReceiver : android.content.BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    CollabWidgetUpdateCoordinator.onLifecycle(context, intent) { pending.finish() }
  }
}
