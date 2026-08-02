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
import androidx.glance.layout.Box
import androidx.glance.layout.Alignment
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
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
import androidx.glance.action.clickable
import androidx.glance.action.ActionParameters
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
private const val MIN_MONTH_OFFSET = -6
private const val MAX_MONTH_OFFSET = 6

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
)
internal data class MonthWidgetDay(
  val dayKey: String,
  val count: Int,
  val colors: List<String>,
  val items: List<MonthWidgetItem>,
  val inMonth: Boolean,
  val isToday: Boolean,
)
internal data class MonthWidgetItem(val title: String, val color: String?)
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

internal data class AgendaWidgetPalette(
  val background: Color,
  val foreground: Color,
  val muted: Color,
  val accent: Color,
  val surface: Color,
  val grid: Color,
)

internal fun agendaWidgetPalette(theme: String, accent: String): AgendaWidgetPalette {
  val (background, foreground, muted, surface, grid) = when (theme) {
    "midnight" -> listOf(Color(0xFF010101), Color(0xFFDEDEDE), Color(0xFF6F7278), Color(0xFF171717), Color(0xFF2A2A2A))
    "warm" -> listOf(Color(0xFF090301), Color(0xFFEFE2D8), Color(0xFF8E7C6F), Color(0xFF1C100A), Color(0xFF362A24))
    "light" -> listOf(Color(0xFFF5F5F5), Color(0xFF090909), Color(0xFF52555B), Color(0xFFFFFFFF), Color(0xFFDCDCDC))
    else -> listOf(Color(0xFF0C0F16), Color(0xFFE4E8EF), Color(0xFF808693), Color(0xFF171B22), Color(0xFF2D3037))
  }
  val accentColor = when (accent) {
    "blue" -> Color(0xFF009BF2)
    "emerald" -> Color(0xFF00C483)
    "rose" -> Color(0xFFFA416B)
    "orange" -> Color(0xFFFA7C20)
    "cyan" -> Color(0xFF00C4CD)
    else -> Color(0xFFA174FF)
  }
  return AgendaWidgetPalette(background, foreground, muted, accentColor, surface, grid)
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
      json.optString("kind", "agenda").takeIf { it in setOf("agenda", "month", "birthday", "countdown") } ?: "agenda",
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
        val items = buildList {
          for (itemIndex in 0 until minOf(itemsJson.length(), 2)) {
            val item = itemsJson.optJSONObject(itemIndex) ?: continue
            val title = item.optString("title").take(MAX_TEXT)
            if (title.isBlank()) continue
            add(
              MonthWidgetItem(
                title,
                item.optString("color").takeIf { it.matches(Regex("^#[0-9A-Fa-f]{6}$")) },
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
)

internal fun widgetKindForId(context: Context, appWidgetId: Int): String {
  val provider = AppWidgetManager.getInstance(context).getAppWidgetInfo(appWidgetId)?.provider?.className
  return when (provider) {
    CollabMonthWidgetReceiver::class.java.name -> "month"
    CollabBirthdayWidgetReceiver::class.java.name -> "birthday"
    CollabCountdownWidgetReceiver::class.java.name -> "countdown"
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
  Column(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(ColorProvider(palette.background))
      .clickable(openAction)
      .padding(14.dp),
  ) {
    Row(modifier = GlanceModifier.fillMaxWidth().clickable(openAction)) {
      Text(
        text = headerLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = TextStyle(
          color = ColorProvider(palette.foreground),
          fontWeight = FontWeight.Bold,
          fontSize = (14f * snapshot.fontScale).sp,
        ),
      )
      if (showCreate) {
        Spacer(GlanceModifier.defaultWeight())
        Text(
          text = "＋",
          modifier = GlanceModifier.padding(horizontal = 10.dp, vertical = 2.dp).clickable(createAction),
          style = TextStyle(
            color = ColorProvider(palette.accent),
            fontWeight = FontWeight.Bold,
            fontSize = (24f * snapshot.fontScale).sp,
          ),
        )
      }
    }
    Spacer(GlanceModifier.height(6.dp))
    if (snapshot.items.isEmpty()) {
      Text(
        snapshot.stateLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = mutedTextStyle(palette, 11f * snapshot.fontScale),
      )
    } else {
      Column(modifier = GlanceModifier.fillMaxWidth()) {
        visibleItems.forEachIndexed { visibleIndex, item ->
          val originalIndex = snapshot.items.indexOf(item)
          val itemAction = actionStartActivity(itemIntents.getOrElse(originalIndex) { openToday })
          Column(modifier = GlanceModifier.fillMaxWidth().clickable(itemAction)) {
            if (size.height >= 180.dp) {
              val priorSection = visibleItems.getOrNull(visibleIndex - 1)?.section
              if (item.section != null && item.section != priorSection) {
                Text(
                  item.section.replaceFirstChar { it.uppercase() },
                  modifier = GlanceModifier.clickable(openAction),
                  style = mutedTextStyle(palette, 11f * snapshot.fontScale),
                )
              }
            }
            Row(modifier = GlanceModifier.fillMaxWidth().clickable(itemAction)) {
              Text(
                "●",
                modifier = GlanceModifier.clickable(itemAction),
                style = TextStyle(
                  color = ColorProvider(widgetSourceColor(item.sourceColor, palette.accent)),
                  fontSize = (12f * snapshot.fontScale).sp,
                ),
              )
              Spacer(GlanceModifier.width(5.dp))
              Text(
                item.title,
                modifier = GlanceModifier.clickable(itemAction),
                style = TextStyle(
                  color = ColorProvider(palette.foreground),
                  fontWeight = FontWeight.Medium,
                  fontSize = (13f * snapshot.fontScale).sp,
                ),
              )
            }
            if (size.height >= 90.dp) {
              Text(
                agendaItemDetail(item),
                modifier = GlanceModifier.clickable(itemAction),
                style = mutedTextStyle(palette, 11f * snapshot.fontScale),
              )
            }
            Spacer(GlanceModifier.height(5.dp))
          }
        }
      }
      if (size.height >= 180.dp) {
        Text(
          snapshot.stateLabel,
          modifier = GlanceModifier.clickable(openAction),
          style = mutedTextStyle(palette, 11f * snapshot.fontScale),
        )
      }
    }
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
  Column(
    modifier = GlanceModifier.fillMaxSize().background(ColorProvider(palette.background)).padding(12.dp),
  ) {
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
          fontSize = (16f * snapshot.fontScale).sp,
        ),
      )
      Box(
        modifier = GlanceModifier.width(40.dp).height(40.dp).clickable(previousAction),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          "‹",
          style = TextStyle(color = ColorProvider(palette.foreground), fontSize = (24f * snapshot.fontScale).sp),
        )
      }
      Box(
        modifier = GlanceModifier.width(40.dp).height(40.dp).clickable(nextAction),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          "›",
          style = TextStyle(color = ColorProvider(palette.foreground), fontSize = (24f * snapshot.fontScale).sp),
        )
      }
      Spacer(GlanceModifier.width(4.dp))
      Box(
        modifier = GlanceModifier.width(48.dp).height(44.dp)
          .background(ColorProvider(palette.accent))
          .cornerRadius(14.dp)
          .clickable(createAction),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          "＋",
          style = TextStyle(
            color = ColorProvider(palette.background),
            fontWeight = FontWeight.Bold,
            fontSize = (21f * snapshot.fontScale).sp,
          ),
        )
      }
    }
    Spacer(GlanceModifier.height(4.dp))
    Row(modifier = GlanceModifier.fillMaxWidth()) {
      listOf("M", "T", "W", "T", "F", "S", "S").forEach { label ->
        Text(label, modifier = GlanceModifier.defaultWeight(), style = mutedTextStyle(palette, 10f * snapshot.fontScale))
      }
    }
    page.days.chunked(7).take(6).forEach { week ->
      Row(
        modifier = GlanceModifier.fillMaxWidth().defaultWeight()
          .background(ColorProvider(palette.grid)),
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
            Column(
              modifier = GlanceModifier.fillMaxSize()
                .background(ColorProvider(palette.surface))
                .cornerRadius(7.dp)
                .clickable(action)
                .padding(horizontal = 3.dp, vertical = 3.dp),
            ) {
              Text(
                number,
                modifier = if (day.isToday) {
                  GlanceModifier.background(ColorProvider(palette.accent))
                    .cornerRadius(12.dp)
                    .padding(horizontal = 5.dp, vertical = 1.dp)
                    .clickable(action)
                } else {
                  GlanceModifier.clickable(action)
                },
                style = TextStyle(
                  color = ColorProvider(
                    if (day.isToday) palette.background
                    else if (day.inMonth) palette.foreground else palette.muted,
                  ),
                  fontWeight = if (day.isToday) FontWeight.Bold else FontWeight.Normal,
                  fontSize = (11f * snapshot.fontScale).sp,
                ),
              )
              if (size.height >= 300.dp && day.items.isNotEmpty()) {
                day.items.take(if (size.height >= 420.dp) 2 else 1).forEach { item ->
                  Text(
                    item.title,
                    modifier = GlanceModifier.fillMaxWidth()
                      .background(ColorProvider(widgetSourceColor(item.color, palette.accent)))
                      .cornerRadius(4.dp)
                      .padding(horizontal = 3.dp, vertical = 1.dp)
                      .clickable(action),
                    style = TextStyle(
                      color = ColorProvider(palette.background),
                      fontWeight = FontWeight.Medium,
                      fontSize = (8f * snapshot.fontScale).sp,
                    ),
                  )
                }
              } else if (marker.isNotEmpty()) {
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

class CollabWidgetLifecycleReceiver : android.content.BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    CollabWidgetUpdateCoordinator.onLifecycle(context, intent) { pending.finish() }
  }
}
