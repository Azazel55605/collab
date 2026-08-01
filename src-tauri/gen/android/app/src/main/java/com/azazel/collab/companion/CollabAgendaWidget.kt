package com.azazel.collab.companion

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.system.Os
import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.AppWidgetId
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.glance.action.clickable
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.LocalDate
import java.time.Instant
import java.util.concurrent.Executors

internal data class AgendaWidgetItem(val title: String, val detail: String)
internal data class AgendaWidgetSnapshot(
  val dateLabel: String,
  val stateLabel: String,
  val items: List<AgendaWidgetItem>,
)

internal object CollabAgendaWidgetSnapshotStore {
  private const val MAX_ITEMS = 6
  private const val MAX_TEXT = 80

  fun read(context: Context): AgendaWidgetSnapshot {
    val file = snapshotFile(context)
    if (!file.isFile) writeBootstrap(context)
    return runCatching { parse(file.readText()) }.getOrElse {
      AgendaWidgetSnapshot("Today", "Open Collab to refresh", emptyList())
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
          ),
        )
      }
    }
    return AgendaWidgetSnapshot(
      json.optString("dateLabel", "Today").take(MAX_TEXT),
      json.optString("stateLabel", "Preview data").take(MAX_TEXT),
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

  fun save(context: Context, appWidgetId: Int, binding: WidgetBinding) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString("$appWidgetId.profile", binding.profileId)
      .putString("$appWidgetId.configuration", binding.configurationId)
      .apply()
  }

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
  private const val MAX_PROFILE_RUNTIME_MS = 1_500L

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
    val deadline = SystemClock.elapsedRealtime() + MAX_PROFILE_RUNTIME_MS
    val configurations = JSONArray(nativeListConfigurations(context, profileId))
    if (configurations.length() == 0) return false
    var changed = false
    for (index in 0 until configurations.length()) {
      if (SystemClock.elapsedRealtime() >= deadline) break
      val configuration = configurations.optJSONObject(index) ?: continue
      val request = JSONObject()
        .put("configuration", configuration)
        .put("generatedAt", Instant.now().toString())
        .put("dateLabel", LocalDate.now().toString())
        .put("freshness", JSONArray())
        .put("items", JSONArray())
      val outcome = JSONObject(nativeBuildAndPublish(context, profileId, request.toString()))
      changed = outcome.optBoolean("changed", false) || changed
    }
    if (changed) requestAgendaUpdate(context)
    return true
  }

  internal fun readBoundSnapshot(context: Context, binding: WidgetBinding): AgendaWidgetSnapshot? =
    runCatching {
      val raw = nativeReadSnapshot(context, binding.profileId, binding.configurationId)
      if (raw == "null") null else CollabAgendaWidgetSnapshotStore.parse(raw)
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
    val manager = AppWidgetManager.getInstance(context)
    val component = ComponentName(context, CollabAgendaWidgetReceiver::class.java)
    val ids = manager.getAppWidgetIds(component)
    if (ids.isEmpty()) return
    context.sendBroadcast(
      Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
        .setComponent(component)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
    )
  }
}

class CollabAgendaWidget : GlanceAppWidget() {
  override val sizeMode: SizeMode = SizeMode.Responsive(
    setOf(DpSize(110.dp, 56.dp), DpSize(250.dp, 110.dp), DpSize(250.dp, 220.dp)),
  )

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = (id as? AppWidgetId)?.appWidgetId
    val binding = appWidgetId?.let { CollabWidgetBindings.read(context, it) }
    val snapshot = binding?.let { CollabWidgetBridge.readBoundSnapshot(context, it) }
      ?: CollabAgendaWidgetSnapshotStore.read(context)
    val openToday = binding?.let { CollabWidgetBridge.prepareOpenIntent(context, it) }
      ?: CollabAppDestination.intent(context, "calendar-today")
    provideContent { AgendaWidgetContent(snapshot, openToday) }
  }
}

@Composable
private fun AgendaWidgetContent(snapshot: AgendaWidgetSnapshot, openToday: android.content.Intent) {
  val size = LocalSize.current
  val openAction = actionStartActivity(openToday)
  val visibleItems = when {
    size.height < 90.dp -> 1
    size.height < 180.dp -> 2
    else -> 5
  }
  Column(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(ColorProvider(Color(0xFF17141F)))
      .clickable(openAction)
      .padding(14.dp),
  ) {
    Row(modifier = GlanceModifier.fillMaxWidth().clickable(openAction)) {
      Text(
        text = snapshot.dateLabel,
        modifier = GlanceModifier.clickable(openAction),
        style = TextStyle(color = ColorProvider(Color(0xFFF7F3FF)), fontWeight = FontWeight.Bold),
      )
    }
    Spacer(GlanceModifier.height(6.dp))
    if (snapshot.items.isEmpty()) {
      Text(snapshot.stateLabel, modifier = GlanceModifier.clickable(openAction), style = mutedTextStyle())
    } else {
      snapshot.items.take(visibleItems).forEach { item ->
        Column(modifier = GlanceModifier.fillMaxWidth().clickable(openAction)) {
          Text(
            item.title,
            modifier = GlanceModifier.clickable(openAction),
            style = TextStyle(color = ColorProvider(Color(0xFFF7F3FF)), fontWeight = FontWeight.Medium),
          )
          if (size.height >= 90.dp) {
            Text(item.detail, modifier = GlanceModifier.clickable(openAction), style = mutedTextStyle())
          }
          Spacer(GlanceModifier.height(5.dp))
        }
      }
      if (size.height >= 180.dp) {
        Text(snapshot.stateLabel, modifier = GlanceModifier.clickable(openAction), style = mutedTextStyle())
      }
    }
  }
}

private fun mutedTextStyle() = TextStyle(color = ColorProvider(Color(0xFFB8AFC7)))

class CollabAgendaWidgetReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = CollabAgendaWidget()

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    CollabWidgetBridge.requestPhase0Rebuild(context)
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
    super.onDeleted(context, appWidgetIds)
  }
}

class CollabWidgetLifecycleReceiver : android.content.BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CollabWidgetBridge.requestPhase0Rebuild(context.applicationContext)
  }
}
