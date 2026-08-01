package com.azazel.collab.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CollabWidgetAppearanceTest {
  @Test
  fun appliesSyncedLightThemeAccentAndFontScale() {
    WidgetSetupPalette.apply(
      """{"schemaVersion":1,"theme":"light","accent":"blue","fontScale":1.25}""",
    )

    assertTrue(WidgetSetupPalette.isLight)
    assertEquals(0xfff5f5f5.toInt(), WidgetSetupPalette.background)
    assertEquals(0xff009bf2.toInt(), WidgetSetupPalette.primary)
    assertEquals(0xffffffff.toInt(), WidgetSetupPalette.primaryForeground)
    assertEquals(1.25f, WidgetSetupPalette.fontScale)
  }

  @Test
  fun missingSnapshotFallsBackToCollabDarkAndViolet() {
    WidgetSetupPalette.apply(null)

    assertFalse(WidgetSetupPalette.isLight)
    assertEquals(0xff0c0f16.toInt(), WidgetSetupPalette.background)
    assertEquals(0xffa174ff.toInt(), WidgetSetupPalette.primary)
    assertEquals(1f, WidgetSetupPalette.fontScale)
  }
}
