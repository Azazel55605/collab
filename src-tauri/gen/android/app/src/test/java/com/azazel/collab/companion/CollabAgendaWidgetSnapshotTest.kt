package com.azazel.collab.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

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
}
