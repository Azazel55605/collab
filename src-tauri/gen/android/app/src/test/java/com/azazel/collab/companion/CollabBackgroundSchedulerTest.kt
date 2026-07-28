package com.azazel.collab.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.work.NetworkType

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

  @Test
  fun networkPolicyPrefersUnmeteredThenNonRoaming() {
    assertEquals(
      NetworkType.UNMETERED,
      CollabBackgroundScheduler.requiredNetworkType(true, false),
    )
    assertEquals(
      NetworkType.NOT_ROAMING,
      CollabBackgroundScheduler.requiredNetworkType(false, false),
    )
    assertEquals(
      NetworkType.CONNECTED,
      CollabBackgroundScheduler.requiredNetworkType(false, true),
    )
  }

  @Test
  fun routineBackgroundWorkWaitsForStorageAndBatteryPolicy() {
    val constraints = CollabBackgroundScheduler.constraints(
      onlyUnmetered = false,
      requireCharging = true,
      pauseOnLowBattery = true,
      allowRoaming = true,
    )

    assertTrue(constraints.requiresCharging())
    assertTrue(constraints.requiresBatteryNotLow())
    assertTrue(constraints.requiresStorageNotLow())
  }

  @Test
  fun workerErrorsAreBoundedAndSensitiveValuesAreRedacted() {
    assertEquals(
      "Native background work failed with a redacted sensitive response.",
      CollabBackgroundWorker.sanitizeWorkerError("request used Bearer secret"),
    )
    assertEquals(
      "network unavailable",
      CollabBackgroundWorker.sanitizeWorkerError("network unavailable"),
    )
  }
}
