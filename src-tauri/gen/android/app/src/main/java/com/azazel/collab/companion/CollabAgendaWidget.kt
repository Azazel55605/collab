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
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.currentState
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.AppWidgetId
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Column
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
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

private val AgendaWidgetSnapshotStateKey = stringPreferencesKey("agenda-widget-snapshot-v1")

internal data class AgendaWidgetItem(
  val title: String,
  val detail: String,
  val section: String?,
  val itemKind: String?,
  val itemId: String?,
  val dayKey: String?,
  val sourceColor: String?,
)
internal data class AgendaWidgetSnapshot(
  val dateLabel: String,
  val stateLabel: String,
  val theme: String,
  val accent: String,
  val fontScale: Float,
  val items: List<AgendaWidgetItem>,
)

internal fun agendaWidgetSnapshotFromState(raw: String?): AgendaWidgetSnapshot {
  if (raw != null) {
    runCatching { CollabAgendaWidgetSnapshotStore.parse(raw) }.getOrNull()?.let { return it }
  }
  return AgendaWidgetSnapshot(
    dateLabel = LocalDate.now().toString(),
    stateLabel = "Open Collab to refresh",
    theme = "dark",
    accent = "violet",
    fontScale = 1f,
    items = emptyList(),
  )
}

internal data class AgendaWidgetPalette(
  val background: Color,
  val foreground: Color,
  val muted: Color,
  val accent: Color,
)

internal fun agendaWidgetPalette(theme: String, accent: String): AgendaWidgetPalette {
  val (background, foreground, muted) = when (theme) {
    "midnight" -> Triple(Color(0xFF010101), Color(0xFFDEDEDE), Color(0xFF6F7278))
    "warm" -> Triple(Color(0xFF090301), Color(0xFFEFE2D8), Color(0xFF8E7C6F))
    "light" -> Triple(Color(0xFFF5F5F5), Color(0xFF090909), Color(0xFF52555B))
    else -> Triple(Color(0xFF0C0F16), Color(0xFFE4E8EF), Color(0xFF808693))
  }
  val accentColor = when (accent) {
    "blue" -> Color(0xFF009BF2)
    "emerald" -> Color(0xFF00C483)
    "rose" -> Color(0xFFFA416B)
    "orange" -> Color(0xFFFA7C20)
    "cyan" -> Color(0xFF00C4CD)
    else -> Color(0xFFA174FF)
  }
  return AgendaWidgetPalette(background, foreground, muted, accentColor)
}

internal object CollabAgendaWidgetSnapshotStore {
  private const val MAX_ITEMS = 10
  private const val MAX_TEXT = 80

  fun read(context: Context): AgendaWidgetSnapshot {
    val file = snapshotFile(context)
    if (!file.isFile) writeBootstrap(context)
    return runCatching { parse(file.readText()) }.getOrElse {
      AgendaWidgetSnapshot("Today", "Open Collab to refresh", "dark", "violet", 1f, emptyList())
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
    require(raw.toByteArray().size <= 16_384) { "Agenda widget snapshot is too large." }
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
    return AgendaWidgetSnapshot(
      json.optString("dateLabel", "Today").take(MAX_TEXT),
      json.optString("stateLabel", "Preview data").take(MAX_TEXT),
      json.optString("theme", "dark").takeIf { it in setOf("dark", "midnight", "warm", "light") } ?: "dark",
      json.optString("accent", "violet").takeIf { it in setOf("violet", "blue", "emerald", "rose", "orange", "cyan") } ?: "violet",
      json.optDouble("fontScale", 1.0).toFloat().takeIf { it in 0.85f..1.3f } ?: 1f,
      items,
    )
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
}

object CollabWidgetBridge {
  private val publisher = Executors.newSingleThreadExecutor()
  private val publishLock = Any()
  private val requestedProfiles = linkedSetOf<String>()
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
    enqueue(appContext, profileId ?: BOOTSTRAP_PROFILE)
  }

  @JvmStatic fun requestProfileRebuild(context: Context, profileId: String) {
    enqueue(context.applicationContext, profileId)
  }

  @JvmStatic fun updateWidgets(context: Context) {
    requestAgendaUpdate(context.applicationContext)
  }

  fun publishConfiguration(
    context: Context,
    profileId: String,
    completed: (String?) -> Unit,
  ) {
    val appContext = context.applicationContext
    publisher.execute {
      val failure = runCatching {
        val outcome = JSONObject(nativePublishAgendaProfile(appContext, profileId))
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
    val manager = AppWidgetManager.getInstance(context)
    val component = ComponentName(context, CollabAgendaWidgetReceiver::class.java)
    val ids = manager.getAppWidgetIds(component)
    val configurationIds = ids.map { appWidgetId ->
      CollabWidgetBindings.read(context, appWidgetId)
        ?.takeIf { it.profileId == profileId }
        ?.configurationId
    }.filterNotNull().distinct()
    return JSONArray(configurationIds).toString()
  }

  private fun enqueue(context: Context, profileId: String) {
    synchronized(publishLock) {
      requestedProfiles.add(profileId)
      if (draining) return
      draining = true
    }
    publisher.execute { drain(context) }
  }

  private fun drain(context: Context) {
    val deadline = SystemClock.elapsedRealtime() + MAX_DRAIN_RUNTIME_MS
    while (SystemClock.elapsedRealtime() < deadline) {
      val profileId = synchronized(publishLock) {
        requestedProfiles.firstOrNull()?.also { requestedProfiles.remove(it) }
      } ?: break
      runCatching {
        if (profileId == BOOTSTRAP_PROFILE || !rebuildProfile(context, profileId)) {
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

  fun rebuildProfile(context: Context, profileId: String): Boolean {
    val outcome = JSONObject(nativePublishAgendaProfile(context, profileId))
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

  internal fun prepareOpenIntent(context: Context, binding: WidgetBinding): Intent? =
    runCatching {
      val request = JSONObject()
        .put("configurationId", binding.configurationId)
        .put("action", "openAgenda")
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

  internal fun requestAgendaUpdate(context: Context) {
    val appContext = context.applicationContext
    val manager = AppWidgetManager.getInstance(appContext)
    val component = ComponentName(appContext, CollabAgendaWidgetReceiver::class.java)
    val ids = manager.getAppWidgetIds(component)
    if (ids.isEmpty()) return
    runBlocking {
      ids.forEach { appWidgetId ->
        val binding = CollabWidgetBindings.read(appContext, appWidgetId)
        val raw = binding?.let { readBoundSnapshotRaw(appContext, it) }
        updateAppWidgetState(appContext, AppWidgetId(appWidgetId)) { preferences ->
          if (raw == null) {
            preferences.remove(AgendaWidgetSnapshotStateKey)
          } else {
            preferences[AgendaWidgetSnapshotStateKey] = raw
          }
        }
      }
      CollabAgendaWidget().updateAll(appContext)
    }
    appContext.sendBroadcast(
      Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
        .setComponent(component)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
    )
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
      val openToday = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it) }
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

@Composable
private fun AgendaWidgetContent(
  snapshot: AgendaWidgetSnapshot,
  openToday: android.content.Intent,
  createToday: android.content.Intent,
  itemIntents: List<android.content.Intent>,
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
  val headerLabel = if (size.height < 180.dp && freshnessLabel != null) {
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

class CollabAgendaWidgetReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabAgendaWidget()

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
    super.onDeleted(context, appWidgetIds)
  }
}

class CollabWidgetLifecycleReceiver : android.content.BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CollabWidgetBridge.requestPhase0Rebuild(context.applicationContext)
  }
}
