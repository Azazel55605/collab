package com.azazel.collab.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CollabBackgroundSchedulerTest {
  @Test
  fun intervalsRespectWorkManagerMinimumAndManualMode() {
    assertEquals(15L, CollabBackgroundScheduler.intervalMinutes("system_managed"))
    assertEquals(15L, CollabBackgroundScheduler.intervalMinutes("fifteen_minutes"))
    assertEquals(30L, CollabBackgroundScheduler.intervalMinutes("thirty_minutes"))
    assertEquals(60L, CollabBackgroundScheduler.intervalMinutes("hourly"))
    assertNull(CollabBackgroundScheduler.intervalMinutes("manual"))
  }

  @Test
  fun profileWorkNamesAreStableAndProfileScoped() {
    assertEquals(
      CollabBackgroundScheduler.profileWorkSuffix("profile-a"),
      CollabBackgroundScheduler.profileWorkSuffix("profile-a"),
    )
    assert(
      CollabBackgroundScheduler.profileWorkSuffix("profile-a") !=
        CollabBackgroundScheduler.profileWorkSuffix("profile-b"),
    )
    // "Aa" and "BB" collide under String.hashCode(), which must not merge
    // two distinct profiles into one unique WorkManager chain.
    assert(
      CollabBackgroundScheduler.profileWorkSuffix("Aa") !=
        CollabBackgroundScheduler.profileWorkSuffix("BB"),
    )
  }
}
