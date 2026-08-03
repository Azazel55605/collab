package com.azazel.collab.companion

import org.junit.Assert.assertEquals
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
      "{\"dayKey\":\"2026-08-${day.toString().padStart(2, '0')}\",\"count\":$index,\"colors\":[\"#a174ff\",\"invalid\"],\"items\":[{\"title\":\"Planning\",\"color\":\"#a174ff\"},{\"title\":\"Review\"},{\"title\":\"Ignored\"}],\"inMonth\":true,\"isToday\":${index == 1}}"
    }
    val snapshot = CollabAgendaWidgetSnapshotStore.parse(
      "{\"schemaVersion\":1,\"kind\":\"month\",\"monthLabel\":\"August 2026\",\"days\":[$days],\"items\":[]}",
    )
    assertEquals("month", snapshot.kind)
    assertEquals("August 2026", snapshot.monthLabel)
    assertEquals(42, snapshot.days.size)
    assertEquals(listOf("#a174ff"), snapshot.days.first().colors)
    assertEquals(listOf("Planning", "Review"), snapshot.days.first().items.map { it.title })
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
}
