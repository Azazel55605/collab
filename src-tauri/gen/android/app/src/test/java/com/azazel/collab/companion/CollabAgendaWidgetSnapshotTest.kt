package com.azazel.collab.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant

class CollabAgendaWidgetSnapshotTest {
  @Test
  fun parsesBoundedVersionedSnapshot() {
    val items = (1..12).joinToString(",") { index ->
      "{\"title\":\"Item $index\",\"detail\":\"Detail $index\"}"
    }
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      "{\"schemaVersion\":1,\"dateLabel\":\"Today\",\"stateLabel\":\"Fresh\",\"theme\":\"light\",\"accent\":\"cyan\",\"fontScale\":1.2,\"items\":[$items]}",
    )
    assertEquals("Today", snapshot.dateLabel)
    assertEquals("light", snapshot.theme)
    assertEquals("cyan", snapshot.accent)
    assertEquals(1.2f, snapshot.fontScale)
    assertEquals(10, snapshot.items.size)
    assertEquals("Item 1", snapshot.items.first().title)
  }

  @Test
  fun rejectsUnknownSchema() {
    try {
      CollabAgendaWidgetSnapshotStore.parse("{\"schemaVersion\":2,\"items\":[]}")
      fail("Unknown schema should be rejected")
    } catch (_: IllegalArgumentException) {
      // Expected.
    }
  }

  @Test
  fun truncatesTextBeforeLauncherRendering() {
    val longTitle = "x".repeat(120)
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      "{\"schemaVersion\":1,\"dateLabel\":\"Today\",\"items\":[{\"title\":\"$longTitle\",\"detail\":\"Safe\"}]}",
    )
    assertEquals(80, snapshot.items.single().title.length)
    assertTrue(snapshot.items.single().title.all { it == 'x' })
  }

  @Test
  fun keepsOnlyValidatedItemDestinationsAndSections() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"dateLabel":"2026-08-01","items":[
        {"title":"Valid","detail":"10:30","section":"today","itemKind":"event","itemId":"event-1::2026-08-01T08:30:00.000Z","dayKey":"2026-08-01","sourceColor":"#a174ff"},
        {"title":"Invalid","detail":"","section":"elsewhere","itemId":"../event","dayKey":"tomorrow"}
      ]}""",
    )
    assertEquals("today", snapshot.items[0].section)
    assertEquals("event", snapshot.items[0].itemKind)
    assertEquals("event-1::2026-08-01T08:30:00.000Z", snapshot.items[0].itemId)
    assertEquals("2026-08-01", snapshot.items[0].dayKey)
    assertEquals("#a174ff", snapshot.items[0].sourceColor)
    assertEquals(null, snapshot.items[1].section)
    assertEquals(null, snapshot.items[1].itemId)
    assertEquals(null, snapshot.items[1].dayKey)
  }

  @Test
  fun defaultsInvalidAppearanceToDarkViolet() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"theme":"unknown","accent":"gold","fontScale":4,"items":[]}""",
    )
    assertEquals("dark", snapshot.theme)
    assertEquals("violet", snapshot.accent)
    assertEquals(1f, snapshot.fontScale)
  }

  @Test
  fun parsesBoundedMonthDensityWithoutTitles() {
    val days = (1..45).joinToString(",") { index ->
      val day = ((index - 1) % 28) + 1
      "{\"dayKey\":\"2026-08-${day.toString().padStart(2, '0')}\",\"count\":$index,\"colors\":[\"#a174ff\",\"invalid\"],\"items\":[{\"title\":\"Planning\",\"color\":\"#a174ff\"},{\"title\":\"Review\"},{\"title\":\"Workshop\"},{\"title\":\"Ignored\"}],\"inMonth\":true,\"isToday\":${index == 1}}"
    }
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      "{\"schemaVersion\":1,\"kind\":\"month\",\"monthLabel\":\"August 2026\",\"days\":[$days],\"items\":[]}",
    )
    assertEquals("month", snapshot.kind)
    assertEquals("August 2026", snapshot.monthLabel)
    assertEquals(42, snapshot.days.size)
    assertEquals(listOf("#a174ff"), snapshot.days.first().colors)
    // One bar per lane is kept; anything past the last lane has nowhere to draw.
    assertEquals(
      listOf("Planning", "Review", "Workshop"),
      snapshot.days.first().items.map { it.title },
    )
    assertEquals("#a174ff", snapshot.days.first().items.first().color)
    assertTrue(snapshot.days.first().isToday)
  }

  @Test
  fun parsesNearbyMonthPagesAndBoundsNavigation() {
    val days = (1..42).joinToString(",") { index ->
      val day = ((index - 1) % 28) + 1
      "{\"dayKey\":\"2026-09-${day.toString().padStart(2, '0')}\",\"count\":0,\"inMonth\":true,\"isToday\":false}"
    }
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      "{\"schemaVersion\":1,\"kind\":\"month\",\"items\":[],\"months\":[{\"offset\":1,\"monthLabel\":\"September 2026\",\"days\":[$days]}]}",
    )
    assertEquals("September 2026", snapshot.months.single().monthLabel)
    assertEquals(42, snapshot.months.single().days.size)
    assertEquals(1, nextMonthOffset(0, 1))
    assertEquals(6, nextMonthOffset(6, 1))
    assertEquals(-6, nextMonthOffset(-6, -1))
  }

  @Test
  fun upcomingTaskDetailIncludesItsDate() {
    val detail = agendaItemDetail(
      AgendaWidgetItem(
        title = "Ship release",
        detail = "Task",
        section = "upcoming",
        itemKind = "task",
        itemId = "task-1",
        dayKey = "2026-08-04",
        sourceColor = null,
      ),
    )
    val expectedDate = java.time.LocalDate.parse("2026-08-04")
      .format(java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d"))
    assertTrue(detail.startsWith("$expectedDate · "))
    assertTrue(detail.endsWith(" · Task"))
  }

  @Test
  fun missingGlanceStateDoesNotRenderThePhaseZeroPreview() {
    val snapshot = agendaWidgetSnapshotFromState(null)
    assertEquals("Open Collab to refresh", snapshot.stateLabel)
    assertTrue(snapshot.items.isEmpty())
  }

  @Test
  fun staleRefreshPolicyRejectsMissingOldAndFutureSnapshots() {
    val now = Instant.parse("2026-08-01T12:00:00Z")
    assertTrue(widgetSnapshotIsStale(null, now))
    assertTrue(widgetSnapshotIsStale("2026-08-01T11:29:59Z", now))
    assertTrue(widgetSnapshotIsStale("2026-08-01T12:06:00Z", now))
    assertTrue(!widgetSnapshotIsStale("2026-08-01T11:45:00Z", now))
  }

  @Test
  fun providerUpdatesNeverRedispatchTheProviderBroadcast() {
    assertTrue(!shouldNotifyAgendaWidgetProvider(AgendaWidgetUpdateOrigin.Provider))
    assertTrue(shouldNotifyAgendaWidgetProvider(AgendaWidgetUpdateOrigin.External))
  }

  @Test
  fun onlyAPublicationThatChangedSomethingIsRendered() {
    // The common case: a periodic or foreground refresh that found no change
    // must not re-compose every placed widget.
    assertTrue(!publicationRequiresRender("""{"configured":true,"changed":false}"""))
    assertTrue(publicationRequiresRender("""{"configured":true,"changed":true}"""))
    // Nothing is configured, so there is nothing to show either way.
    assertTrue(!publicationRequiresRender("""{"configured":false,"changed":true}"""))
    // A missed update is worse than a wasted one, so an outcome that cannot say
    // whether anything changed renders.
    assertTrue(publicationRequiresRender("""{"configured":true}"""))
    assertTrue(publicationRequiresRender("not json"))
  }

  @Test
  fun widgetStateOnlyReportsAChangeWhenTheSnapshotReallyMoved() {
    val snapshot = """{"schemaVersion":1,"dateLabel":"Today","items":[]}"""

    // A widget holding this exact snapshot is left alone.
    assertEquals(snapshot to false, widgetStateTransition(snapshot, snapshot, isMonth = false))
    // A newly placed widget has no state yet, so it always renders.
    assertEquals(snapshot to true, widgetStateTransition(null, snapshot, isMonth = false))
    // A snapshot that became unreadable clears the state and renders the
    // fallback rather than leaving stale content on the launcher.
    assertEquals(null to true, widgetStateTransition(snapshot, null, isMonth = false))
    assertEquals(null to false, widgetStateTransition(null, null, isMonth = false))
  }

  @Test
  fun monthWidgetsTrackTheirSnapshotThroughARevisionMarker() {
    val snapshot = """{"schemaVersion":1,"kind":"month","dateLabel":"Aug","items":[]}"""
    val edited = """{"schemaVersion":1,"kind":"month","dateLabel":"Sep","items":[]}"""

    // The month widget reads its snapshot natively, so state carries a digest
    // instead of the (much larger) snapshot itself.
    val (marker, changed) = widgetStateTransition(null, snapshot, isMonth = true)
    assertTrue(changed)
    assertTrue(marker != null && marker != snapshot)
    assertEquals(marker, widgetRevisionMarker(snapshot))
    // Same snapshot, same marker: no re-render.
    assertEquals(marker to false, widgetStateTransition(marker, snapshot, isMonth = true))
    // A different month has to reach the launcher.
    assertTrue(widgetStateTransition(marker, edited, isMonth = true).second)
    assertEquals(null, widgetRevisionMarker(null))
  }

  @Test
  fun everyProviderRendersItsOwnWidget() {
    // Change-gated rendering updates only the providers that moved, so a
    // provider missing from this mapping would silently re-render the agenda
    // widget and never itself.
    val expected = mapOf(
      CollabAgendaWidgetReceiver::class.java to CollabAgendaWidget::class.java,
      CollabMonthWidgetReceiver::class.java to CollabMonthWidget::class.java,
      CollabBirthdayWidgetReceiver::class.java to CollabBirthdayWidget::class.java,
      CollabCountdownWidgetReceiver::class.java to CollabCountdownWidget::class.java,
      CollabTasksWidgetReceiver::class.java to CollabTasksWidget::class.java,
      CollabCaptureWidgetReceiver::class.java to CollabCaptureWidget::class.java,
      CollabShortcutsWidgetReceiver::class.java to CollabShortcutsWidget::class.java,
      CollabSyncWidgetReceiver::class.java to CollabSyncWidget::class.java,
    )
    assertEquals(widgetProviderClasses().toSet(), expected.keys)
    expected.forEach { (provider, widget) ->
      assertEquals(widget, widgetForProvider(provider)::class.java)
    }
  }

  @Test
  fun parsesTaskProjectionAndKeepsOnlyValidatedKanbanReferences() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"tasks","dateLabel":"2026-08-01","items":[
        {"title":"Ship","detail":"Aug 1","itemId":"task-1","task":{"source":"calendar","due":"today","completion":"available","revision":4}},
        {"title":"Review","detail":"Aug 2","itemId":"task-2","task":{"source":"kanban","due":"upcoming","completion":"confirmInApp","revision":2,"vaultId":"vault-1","fileId":"file-1","cardId":"card-1"}},
        {"title":"Broken","detail":"","itemId":"task-3","task":{"source":"kanban","due":"today","completion":"confirmInApp","revision":1,"vaultId":"../escape","fileId":"file-1","cardId":"card-1"}},
        {"title":"Unknown","detail":"","itemId":"task-4","task":{"source":"elsewhere","due":"today","completion":"available","revision":1}}
      ]}""",
    )
    assertEquals("tasks", snapshot.kind)
    val calendarTask = snapshot.items[0].task!!
    assertEquals("calendar", calendarTask.source)
    assertEquals("today", calendarTask.due)
    assertEquals(4, calendarTask.revision)
    assertTrue(calendarTask.completableNatively)

    val kanbanTask = snapshot.items[1].task!!
    assertTrue(!kanbanTask.completableNatively)
    assertEquals("vault-1", kanbanTask.kanbanTarget?.vaultId)
    assertEquals("card-1", kanbanTask.kanbanTarget?.cardId)

    // An unusable reference degrades to "no Kanban destination", never to a
    // path that could escape the validated identifier shape.
    assertEquals(null, snapshot.items[2].task!!.kanbanTarget)
    // An unknown source is dropped rather than rendered as a completable task.
    assertEquals(null, snapshot.items[3].task)
  }

  @Test
  fun kanbanRowsCanNeverClaimNativeCompletion() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"tasks","items":[
        {"title":"Ship","detail":"","itemId":"task-1","task":{"source":"kanban","due":"today","completion":"available","revision":1}}
      ]}""",
    )
    val task = snapshot.items.single().task!!
    assertEquals("confirmInApp", task.completion)
    assertTrue(!task.completableNatively)
  }

  @Test
  fun parsesCaptureAndShortcutRowsAndDropsUnusableTargets() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"shortcuts","items":[
        {"title":"New note","detail":"Opens the note creator","shortcut":{"destination":"capture-note","pinned":false}},
        {"title":"Roadmap.md","detail":"Note","shortcut":{"destination":"vault-file","vaultId":"vault-1","fileId":"file-1","entryKind":"note","pinned":true}},
        {"title":"Designs","detail":"Folder","shortcut":{"destination":"vault-folder","vaultId":"vault-1","fileId":"folder-1","entryKind":"folder","pinned":false}},
        {"title":"Broken","detail":"","shortcut":{"destination":"vault-file","vaultId":"vault-1","entryKind":"note","pinned":false}},
        {"title":"Hostile","detail":"","shortcut":{"destination":"open-anything","pinned":false}}
      ]}""",
    )
    assertEquals("shortcuts", snapshot.kind)
    assertEquals("capture-note", snapshot.items[0].shortcut!!.destination)
    assertEquals(null, snapshot.items[0].shortcut!!.vaultId)

    val pinned = snapshot.items[1].shortcut!!
    assertEquals("vault-file", pinned.destination)
    assertEquals("file-1", pinned.fileId)
    assertTrue(pinned.pinned)
    assertEquals("vault-folder", snapshot.items[2].shortcut!!.destination)

    // A vault destination missing its file target, and an unknown destination,
    // are both dropped rather than rendered as dead rows.
    assertEquals(null, snapshot.items[3].shortcut)
    assertEquals(null, snapshot.items[4].shortcut)
  }

  @Test
  fun shortcutGlyphsCoverEverySupportedEntryKind() {
    assertEquals("📄", shortcutEntryGlyph("note"))
    assertEquals("🗂", shortcutEntryGlyph("board"))
    assertEquals("🎨", shortcutEntryGlyph("canvas"))
    assertEquals("▦", shortcutEntryGlyph("sheet"))
    assertEquals("📕", shortcutEntryGlyph("pdf"))
    assertEquals("📁", shortcutEntryGlyph("folder"))
    assertEquals("•", shortcutEntryGlyph(null))
  }

  @Test
  fun taskSectionsUseTheNativeDueState() {
    assertEquals("Overdue", taskSectionLabel("overdue"))
    assertEquals("Today", taskSectionLabel("today"))
    assertEquals("Upcoming", taskSectionLabel("upcoming"))
    assertEquals("No due date", taskSectionLabel("unscheduled"))
    assertEquals("Tasks", taskSectionLabel(null))
  }

  private fun weekOf(vararg items: List<MonthWidgetItem>): List<MonthWidgetDay> =
    items.mapIndexed { column, dayItems ->
      MonthWidgetDay(
        dayKey = "2026-08-%02d".format(column + 1),
        count = dayItems.size,
        colors = emptyList(),
        items = dayItems,
        inMonth = true,
        isToday = false,
      )
    }

  @Test
  fun multiDayBarsFillEveryColumnTheySpanAndLabelOnlyTheFirst() {
    val week = weekOf(
      listOf(MonthWidgetItem("Team offsite", "#a174ff", span = 3, lane = 0)),
      emptyList(),
      emptyList(),
      emptyList(),
      emptyList(),
      emptyList(),
      emptyList(),
    )
    val lane = monthBarLane(week, 0)

    assertEquals("Team offsite", lane[0]?.label)
    // The bar continues visually but must not repeat its title per day.
    assertEquals(null, lane[1]?.label)
    assertEquals(null, lane[2]?.label)
    assertEquals("#a174ff", lane[2]?.color)
    assertEquals(null, lane[3])
    // A bar wider than one column stays square so its pieces meet cleanly.
    assertEquals(false, lane[0]?.rounded)
  }

  @Test
  fun singleDayEntriesStayRoundedChips() {
    val week = weekOf(
      listOf(MonthWidgetItem("Standup", "#00c483")),
      emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
    )
    val cell = monthBarLane(week, 0)[0]
    assertEquals(true, cell?.rounded)
    assertEquals("Standup", cell?.label)
  }

  @Test
  fun clippedBarsMarkTheEdgeTheyRunPast() {
    val continuing = weekOf(
      emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
      listOf(MonthWidgetItem("Conference", "#a174ff", span = 2, continuesAfter = true)),
      emptyList(),
    )
    val lane = monthBarLane(continuing, 0)
    assertEquals("Conference", lane[5]?.label)
    assertEquals("\u203a", lane[6]?.label)
    assertEquals(true, lane[6]?.alignEnd)
    assertEquals(false, lane[5]?.rounded)

    val resumed = weekOf(
      listOf(MonthWidgetItem("Conference", "#a174ff", span = 2, continuesBefore = true)),
      emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
    )
    assertEquals("\u2039Conference", monthBarLane(resumed, 0)[0]?.label)
  }

  @Test
  fun lanesAreIndependentAndOverlapNeverErasesABar() {
    val week = weekOf(
      listOf(
        MonthWidgetItem("Long", "#a174ff", span = 3, lane = 0),
        MonthWidgetItem("Short", "#fa416b", span = 2, lane = 1),
      ),
      emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
    )
    assertEquals("Long", monthBarLane(week, 0)[0]?.label)
    assertEquals(null, monthBarLane(week, 0)[0]?.let { if (it.color == "#fa416b") it else null })
    assertEquals("Short", monthBarLane(week, 1)[0]?.label)
    assertEquals(null, monthBarLane(week, 1)[2])

    // A payload claiming an already-occupied column must not overwrite it.
    val conflicting = weekOf(
      listOf(
        MonthWidgetItem("First", "#a174ff", span = 3, lane = 0),
        MonthWidgetItem("Second", "#fa416b", span = 3, lane = 0),
      ),
      emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
    )
    assertEquals("First", monthBarLane(conflicting, 0)[0]?.label)
    assertEquals("#a174ff", monthBarLane(conflicting, 0)[1]?.color)
  }

  @Test
  fun parsedBarsCanNeverReachPastTheirWeekRow() {
    val days = JSONArray()
    for (index in 0 until 42) {
      val item = JSONObject()
        .put("title", "Spanning")
        .put("color", "#a174ff")
        .put("span", 99)
        .put("lane", 42)
      days.put(
        JSONObject()
          .put("dayKey", "2026-08-%02d".format((index % 28) + 1))
          .put("count", 1)
          .put("items", JSONArray().put(item)),
      )
    }
    val raw = JSONObject()
      .put("schemaVersion", 1)
      .put("kind", "month")
      .put("monthLabel", "August 2026")
      .put("days", days)
      .toString()
    val parsed = CollabAgendaWidgetSnapshotStore.parse(raw)

    parsed.days.forEachIndexed { index, day ->
      day.items.forEach { item ->
        assertEquals(true, index % 7 + item.span <= 7)
        assertEquals(true, item.lane < MAX_MONTH_LANES)
      }
    }
  }

  /**
   * RemoteViews only inflates views annotated `@RemoteView`. A widget preview
   * containing anything else — a bare `<View>` spacer being the easy mistake —
   * fails to inflate in the launcher and shows a broken picker entry, which no
   * amount of building or resource compilation reveals.
   */
  private val remoteViewsSafeTags = setOf(
    "AdapterViewFlipper", "AnalogClock", "Button", "Chronometer", "FrameLayout",
    "GridLayout", "GridView", "ImageButton", "ImageView", "LinearLayout",
    "ListView", "ProgressBar", "RelativeLayout", "StackView", "TextView",
    "ViewFlipper", "ViewStub",
  )

  private fun widgetPreviewLayouts(): List<java.io.File> {
    var directory: java.io.File? = java.io.File(System.getProperty("user.dir")!!)
    while (directory != null) {
      val layouts = java.io.File(directory, "src/main/res/layout")
      if (layouts.isDirectory) {
        return layouts.listFiles { file -> file.name.endsWith("_widget_preview.xml") }
          .orEmpty()
          .sortedBy { it.name }
      }
      directory = directory.parentFile
    }
    fail("Could not locate the widget preview layouts.")
    return emptyList()
  }

  @Test
  fun widgetPreviewsOnlyUseViewsRemoteViewsCanInflate() {
    val layouts = widgetPreviewLayouts()
    assertEquals(8, layouts.size)
    layouts.forEach { layout ->
      val body = layout.readText().replace(Regex("(?s)<!--.*?-->"), "")
      Regex("<([A-Za-z][A-Za-z0-9_.]*)").findAll(body).forEach { match ->
        val tag = match.groupValues[1]
        assertTrue(
          "${layout.name} uses <$tag>, which RemoteViews cannot inflate",
          tag in remoteViewsSafeTags,
        )
      }
    }
  }

  private fun hex(color: androidx.compose.ui.graphics.Color): String =
    "#%06X".format(color.value.toLong().ushr(32).and(0xFFFFFFL))

  /**
   * The widget is painted from the app's own theme tokens, resolved from OKLCH
   * to sRGB. Pinning them here keeps a launcher widget and the screen it opens
   * from drifting into lookalike-but-different colours.
   */
  @Test
  fun palettesResolveTheAppThemeTokens() {
    val dark = agendaWidgetPalette("dark", "violet")
    assertEquals("#0C0F16", hex(dark.background))
    assertEquals("#E4E8EF", hex(dark.foreground))
    assertEquals("#808693", hex(dark.muted))
    assertEquals("#13161D", hex(dark.card))
    assertEquals("#171B22", hex(dark.surface))
    assertEquals("#272930", hex(dark.grid))

    // A card must sit between the background and the control surface, or the
    // app's layering reads inverted on the launcher.
    listOf("dark", "midnight", "warm").forEach { theme ->
      val palette = agendaWidgetPalette(theme, "violet")
      val luminance = { color: androidx.compose.ui.graphics.Color ->
        val value = hex(color).removePrefix("#").toLong(16)
        (value shr 16) + (value shr 8 and 0xFF) + (value and 0xFF)
      }
      assertTrue(
        "$theme card must be lighter than its background",
        luminance(palette.card) > luminance(palette.background),
      )
      assertTrue(
        "$theme surface must be lighter than its card",
        luminance(palette.surface) > luminance(palette.card),
      )
    }

    // Every accent the app offers must resolve, and none may collide.
    val accents = listOf("violet", "blue", "emerald", "rose", "orange", "cyan")
      .map { hex(agendaWidgetPalette("dark", it).accent) }
    assertEquals(
      listOf("#A174FF", "#009BF2", "#00C483", "#FA416B", "#FA7C20", "#00C4CD"),
      accents,
    )
    assertEquals(accents.size, accents.toSet().size)

    // `--destructive` is shared across the dark family and overridden only by
    // the light theme, exactly as the stylesheet does it.
    assertEquals("#F9423D", hex(agendaWidgetPalette("dark", "violet").danger))
    assertEquals("#F9423D", hex(agendaWidgetPalette("midnight", "violet").danger))
    assertEquals("#E60016", hex(agendaWidgetPalette("light", "violet").danger))
  }

  @Test
  fun parsesTheSyncRollupAndRejectsAnUnknownState() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"sync","stateLabel":"2 changes waiting to sync","items":[],
        "sync":{"state":"pendingChanges","lastSuccessAt":"2026-08-01T07:40:00Z",
        "lastSuccessLabel":"Synced 20 min ago","pendingOperations":2,"failedOperations":0,
        "activeJobs":0,"attentionRequired":0,"accounts":1,"vaults":2,
        "progressCompleted":0,"canSyncNow":true}}""",
    )
    assertEquals("sync", snapshot.kind)
    val sync = snapshot.sync!!
    assertEquals("pendingChanges", sync.state)
    assertEquals(2, sync.pendingOperations)
    assertEquals("Synced 20 min ago", sync.lastSuccessLabel)
    assertTrue(sync.canSyncNow)
    assertTrue(!sync.needsAttention && !sync.running)
    // Without a total there is no proportion to draw.
    assertEquals(null, sync.progressTotal)
    assertEquals(null, sync.progressFraction)

    val unknown = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"sync","items":[],"sync":{"state":"exploding"}}""",
    )
    assertEquals(null, unknown.sync)
  }

  @Test
  fun syncProgressNeverExceedsItsOwnTotal() {
    val overrun = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"sync","items":[],"sync":{"state":"syncing",
        "pendingOperations":0,"failedOperations":0,"activeJobs":1,"attentionRequired":0,
        "accounts":1,"vaults":1,"progressCompleted":9,"progressTotal":4,"canSyncNow":true}}""",
    )
    // A total behind the work already done is dropped rather than drawn.
    assertEquals(null, overrun.sync!!.progressTotal)
    assertTrue(overrun.sync!!.running)

    val running = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"sync","items":[],"sync":{"state":"syncing",
        "pendingOperations":0,"failedOperations":0,"activeJobs":1,"attentionRequired":0,
        "accounts":1,"vaults":1,"progressCompleted":3,"progressTotal":4,"canSyncNow":true}}""",
    )
    assertEquals(0.75f, running.sync!!.progressFraction)
    assertEquals(7 to 3, syncProgressSegments(75))
    // A started run always shows at least one filled segment, and a finished
    // one never overflows the track.
    assertEquals(1 to 9, syncProgressSegments(0))
    assertEquals(SYNC_PROGRESS_SEGMENTS to 0, syncProgressSegments(100))
    assertEquals(SYNC_PROGRESS_SEGMENTS to 0, syncProgressSegments(400))
  }

  @Test
  fun syncRecoveryRowsOnlyCarrySettingsDestinations() {
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      """{"schemaVersion":1,"kind":"sync","items":[
        {"title":"Sign in again","detail":"Opens Collab settings","shortcut":{"destination":"settings-account"}},
        {"title":"Team vault","detail":"1 change needs attention","shortcut":{"destination":"settings-background"}},
        {"title":"Notes","detail":"Synced 5 min ago"},
        {"title":"Hostile","detail":"","shortcut":{"destination":"settings-everything"}}
      ],"sync":{"state":"actionRequired","pendingOperations":1,"failedOperations":1,
        "activeJobs":0,"attentionRequired":1,"accounts":1,"vaults":2,
        "progressCompleted":0,"canSyncNow":true}}""",
    )
    assertEquals("settings-account", snapshot.items[0].shortcut!!.destination)
    assertEquals("settings-background", snapshot.items[1].shortcut!!.destination)
    // A healthy row has no destination of its own and falls back to the header.
    assertEquals(null, snapshot.items[2].shortcut)
    // An unknown settings route is dropped rather than handed to the app.
    assertEquals(null, snapshot.items[3].shortcut)
    assertTrue(snapshot.sync!!.needsAttention)
  }

  @Test
  fun syncStateColorsReserveTheAccentAndSpeakDangerOnlyForRecovery() {
    val palette = agendaWidgetPalette("dark", "violet")
    assertEquals(palette.danger, syncStateColor("actionRequired", palette))
    assertEquals(palette.danger, syncStateColor("authenticationRequired", palette))
    assertEquals(palette.accent, syncStateColor("syncing", palette))
    // Everything else stays quiet: waiting is not a problem to be alarmed by.
    listOf("upToDate", "pendingChanges", "offline", "paused", null).forEach { state ->
      assertEquals(palette.muted, syncStateColor(state, palette))
    }
  }

  @Test
  fun syncDetailLineStatesScopeAndFreshnessOnly() {
    fun sync(vaults: Int, label: String?) = AgendaWidgetSync(
      state = "upToDate",
      lastSuccessLabel = label,
      pendingOperations = 0,
      failedOperations = 0,
      activeJobs = 0,
      attentionRequired = 0,
      accounts = 1,
      vaults = vaults,
      progressCompleted = 0,
      progressTotal = null,
      activityLabel = null,
      progressLabel = null,
      canSyncNow = true,
    )
    assertEquals("1 vault · Synced 5 min ago", syncDetailLine(sync(1, "Synced 5 min ago")))
    assertEquals("3 vaults", syncDetailLine(sync(3, null)))
    assertEquals("Not synced yet", syncDetailLine(sync(0, null)))
    assertEquals("Open Collab to refresh", syncDetailLine(null))
  }

  @Test
  fun aRunInFlightSaysWhatItIsOnInsteadOfHowFreshItIs() {
    fun sync(state: String, activity: String?, progress: String?) = AgendaWidgetSync(
      state = state,
      lastSuccessLabel = "Synced 5 min ago",
      pendingOperations = 0,
      failedOperations = 0,
      activeJobs = 1,
      attentionRequired = 0,
      accounts = 1,
      vaults = 2,
      progressCompleted = 9,
      progressTotal = 12,
      activityLabel = activity,
      progressLabel = progress,
      canSyncNow = true,
    )

    assertEquals("plan.md · 9 of 12", syncDetailLine(sync("syncing", "plan.md", "9 of 12")))
    // A run that cannot state a total still names what it is on.
    assertEquals("plan.md", syncDetailLine(sync("syncing", "plan.md", null)))
    // Nothing to say about the run falls back to scope and freshness rather
    // than rendering an empty line.
    assertEquals("2 vaults · Synced 5 min ago", syncDetailLine(sync("syncing", null, null)))
    // At rest the live phrasing is never shown, even if a stale one is present.
    assertEquals(
      "2 vaults · Synced 5 min ago",
      syncDetailLine(sync("upToDate", "plan.md", "9 of 12")),
    )
  }

  @Test
  fun theActivityLineRefusesAnythingThatWasNotPrivacyReduced() {
    fun parseActivity(detail: String): String? = CollabAgendaWidgetSnapshotStore.parse(
      syncSnapshotJson(detail),
    ).sync?.activityLabel

    // Rust reduces this, but the parser is the last thing standing between a
    // snapshot file and the launcher, so it does not take the writer's word.
    assertNull(parseActivity("Notes/Personal/plan.md"))
    assertNull(parseActivity("https://collab.example"))
    assertNull(parseActivity("user@host"))
    assertEquals("plan.md", parseActivity("plan.md"))
  }

  @Test
  fun repeatedReadsOfOneSnapshotParseItOnce() {
    // Every month-arrow tap re-reads the same snapshot text. Parsing thirteen
    // pages of day cells again on each tap is what made switching months lag,
    // so the identical string must come back as the identical object.
    val raw = syncSnapshotJson("plan.md")
    val first = CollabAgendaWidgetSnapshotCache.read(raw)
    val second = CollabAgendaWidgetSnapshotCache.read(raw)

    assertNotNull(first)
    assertSame(first, second)
    // A republished snapshot is a different string, so it can never be served
    // from the cache.
    assertNotSame(first, CollabAgendaWidgetSnapshotCache.read(syncSnapshotJson("other.md")))
  }

  @Test
  fun theTodayMarkerRepaintsEveryDaySoItLeavesNoTrail() {
    // A launcher reapplies RemoteViews onto views it already holds. When the
    // marker background was only applied in the `isToday` branch nothing ever
    // cleared yesterday's, so the pill smeared across the month as days passed.
    // Off days must resolve to the cell's own fill, never to "no colour".
    val palette = agendaWidgetPalette("dark", "violet")
    fun day(isToday: Boolean, inMonth: Boolean) =
      MonthWidgetDay("2026-08-11", 0, emptyList(), emptyList(), inMonth, isToday)

    assertEquals(palette.accent, monthDayMarkerColor(day(true, true), palette))
    assertEquals(
      monthDayCellColor(day(false, true), palette),
      monthDayMarkerColor(day(false, true), palette),
    )
    assertEquals(
      monthDayCellColor(day(false, false), palette),
      monthDayMarkerColor(day(false, false), palette),
    )
  }

  /** A minimal valid sync snapshot carrying one activity label. */
  private fun syncSnapshotJson(activity: String): String = JSONObject()
    .put("schemaVersion", 1)
    .put("kind", "sync")
    .put("generatedAt", "2026-08-11T10:00:00Z")
    .put("dateLabel", "2026-08-11")
    .put("stateLabel", "Syncing…")
    .put("theme", "dark")
    .put("accent", "violet")
    .put("fontScale", 1.0)
    .put("items", JSONArray())
    .put(
      "sync",
      JSONObject()
        .put("state", "syncing")
        .put("pendingOperations", 0)
        .put("failedOperations", 0)
        .put("activeJobs", 1)
        .put("attentionRequired", 0)
        .put("accounts", 1)
        .put("vaults", 1)
        .put("progressCompleted", 9)
        .put("progressTotal", 12)
        .put("activityLabel", activity)
        .put("progressLabel", "9 of 12")
        .put("canSyncNow", true),
    )
    .toString()

  @Test
  fun everyRegisteredWidgetProviderResolvesItsKind() {
    // A provider missing from either list renders as an agenda widget, which
    // would silently show the wrong content for its snapshot.
    assertEquals(8, widgetProviderClasses().size)
    assertEquals(
      widgetProviderClasses().size,
      widgetProviderClasses().toSet().size,
    )
  }
}
