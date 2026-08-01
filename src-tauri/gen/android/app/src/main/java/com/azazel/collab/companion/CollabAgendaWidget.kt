package com.azazel.collab.companion

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.system.Os
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
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

object CollabWidgetBridge {
  private val publisher = Executors.newSingleThreadExecutor()

  init {
    System.loadLibrary("collab_lib")
  }

  @JvmStatic external fun nativeBuildAgendaPreview(
    context: Context,
    dateLabel: String,
  ): String

  fun requestPhase0Rebuild(context: Context) {
    val appContext = context.applicationContext
    publisher.execute {
      runCatching { rebuildPhase0(appContext) }
    }
  }

  fun rebuildPhase0(context: Context) {
    val appContext = context.applicationContext
    val snapshot = nativeBuildAgendaPreview(appContext, LocalDate.now().toString())
    CollabAgendaWidgetSnapshotStore.publish(appContext, snapshot)
    requestAgendaUpdate(appContext)
  }

  private fun requestAgendaUpdate(context: Context) {
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
    val snapshot = CollabAgendaWidgetSnapshotStore.read(context)
    val openToday = CollabAppDestination.intent(context, "calendar-today")
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
}
